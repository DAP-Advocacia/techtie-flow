'use strict';
// Rotas do Agente de IA: configuração (personalidade e regras de transbordo), base de conhecimento
// (PDF/DOCX/TXT viram texto aqui no servidor) e chat de teste. Permissões: `ai_agent` (ler/atualizar).
// A chave da OpenAI mora só no ambiente do servidor; o navegador nunca a vê.
const { chunkText, retrieve, buildMessages, parseReply } = require('../ai/agent');
const { AiError } = require('../ai/openai');
const { makeLimiter } = require('../auth');

const MAX_PROMPT = 2000;
const MAX_RULE = 140;
const MAX_RULES = 30;
const MAX_DOCS = 40;
const MAX_FILE_BYTES = 6 * 1024 * 1024;
const TEXT_EXT = /\.(txt|md|csv|json|log)$/i;

/** Texto de um arquivo enviado (base64). Lança Error com mensagem para o usuário se não der. */
async function extractText(name, buffer) {
  if (TEXT_EXT.test(name)) return buffer.toString('utf8');
  if (/\.pdf$/i.test(name)) {
    const pdf = require('pdf-parse/lib/pdf-parse.js');
    const out = await pdf(buffer).catch(() => {
      throw new Error('Não consegui ler este PDF (pode estar protegido ou ser só imagem escaneada).');
    });
    return out.text;
  }
  if (/\.docx$/i.test(name)) {
    const mammoth = require('mammoth');
    const out = await mammoth.extractRawText({ buffer }).catch(() => {
      throw new Error('Não consegui ler este DOCX.');
    });
    return out.value;
  }
  throw new Error('Formato não suportado. Use PDF, DOCX, TXT, MD ou CSV.');
}

module.exports = function registerAiRoutes(H) {
  const { route, must, bad, notFound, HttpError, uuidOr400, tx, audit, openai } = H;
  const testLimiter = makeLimiter(20, 60_000);

  const apiDoc = (r) => ({ id: r.id, name: r.name, chunks: r.chunks, chars: r.chars ?? undefined, status: 'ready', createdAt: r.created_at ? new Date(r.created_at).getTime() : null });
  const loadAgent = async (c) => {
    const a = (await c.query('SELECT prompt, handoff_rules, max_replies FROM ai_agents')).rows[0];
    const docs = (await c.query('SELECT id, name, chunks, char_length(content) AS chars, created_at FROM ai_knowledge_docs ORDER BY created_at')).rows;
    const used = Number((await c.query("SELECT COALESCE(sum(prompt_tokens + completion_tokens), 0) AS n FROM ai_usage WHERE created_at > now() - interval '24 hours'")).rows[0].n);
    return {
      prompt: a?.prompt || '',
      handoffRules: a?.handoff_rules || [],
      maxReplies: a?.max_replies ?? 8,
      knowledgeDocs: docs.map(apiDoc),
      configured: !!openai?.configured,
      model: openai?.model || null,
      tokensToday: used,
    };
  };
  H.loadAgent = loadAgent;

  route('GET', '/api/ai-agent', async ({ access }) => {
    must(access, 'ai_agent', 'read', { tenantId: access.tenantId });
    return { agent: await tx(H.pool, access, loadAgent, { readOnly: true }) };
  });

  route('PUT', '/api/ai-agent', async ({ req, access, body }) => {
    must(access, 'ai_agent', 'update', { tenantId: access.tenantId });
    const prompt = String(body.prompt ?? '').trim();
    if (prompt.length > MAX_PROMPT) throw bad(`A personalidade pode ter até ${MAX_PROMPT} caracteres.`);
    const rules = Array.isArray(body.handoffRules) ? body.handoffRules.map((r) => String(r).trim()).filter(Boolean) : [];
    if (rules.length > MAX_RULES) throw bad(`No máximo ${MAX_RULES} regras de transbordo.`);
    if (rules.some((r) => r.length > MAX_RULE)) throw bad(`Cada regra pode ter até ${MAX_RULE} caracteres.`);
    const maxReplies = body.maxReplies === undefined ? undefined : Math.floor(Number(body.maxReplies));
    if (maxReplies !== undefined && !(maxReplies >= 1 && maxReplies <= 50)) throw bad('Limite de respostas da IA por conversa: de 1 a 50.');
    return tx(H.pool, access, async (c) => {
      await c.query(
        `INSERT INTO ai_agents (tenant_id, prompt, handoff_rules, max_replies, updated_by, updated_at) VALUES ($1, $2, $3::jsonb, COALESCE($4, 8), $5, now())
         ON CONFLICT (tenant_id) DO UPDATE SET prompt = EXCLUDED.prompt, handoff_rules = EXCLUDED.handoff_rules, max_replies = COALESCE($4, ai_agents.max_replies), updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [access.tenantId, prompt, JSON.stringify(rules), maxReplies ?? null, access.userId]
      );
      await audit(c, access, req, 'ai_agent.update', 'ai_agent', null, { rules: rules.length, promptChars: prompt.length });
      return { agent: await loadAgent(c) };
    });
  });

  // Documento: { name, base64 } (PDF/DOCX/TXT…) ou { name, text }. O corpo pode ser grande: limite próprio.
  route(
    'POST',
    '/api/ai-agent/docs',
    async ({ req, access, body }) => {
      must(access, 'ai_agent', 'update', { tenantId: access.tenantId });
      const name = String(body.name || '').trim().slice(0, 200);
      if (!name) throw bad('Informe o nome do documento.');
      let text;
      if (typeof body.text === 'string') text = body.text;
      else if (typeof body.base64 === 'string') {
        const buf = Buffer.from(body.base64, 'base64');
        if (!buf.length) throw bad('Arquivo vazio.');
        if (buf.length > MAX_FILE_BYTES) throw bad('Arquivo grande demais (máximo 6 MB).');
        try {
          text = await extractText(name, buf);
        } catch (e) {
          throw bad(e.message);
        }
      } else throw bad('Envie o arquivo ou o texto do documento.');
      text = text.replace(/\u0000/g, '').trim();
      if (text.length < 20) throw bad('Não encontrei texto neste documento.');
      text = text.slice(0, 400_000);
      const chunks = chunkText(text).length;
      return tx(H.pool, access, async (c) => {
        const n = (await c.query('SELECT count(*)::int n FROM ai_knowledge_docs')).rows[0].n;
        if (n >= MAX_DOCS) throw bad(`A base já tem ${MAX_DOCS} documentos. Remova algum antes de enviar outro.`);
        if ((await c.query('SELECT 1 FROM ai_knowledge_docs WHERE lower(name) = lower($1)', [name])).rowCount) throw new HttpError(409, `"${name}" já está na base.`);
        const r = (await c.query('INSERT INTO ai_knowledge_docs (tenant_id, name, content, chunks, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, chunks, char_length(content) AS chars, created_at', [access.tenantId, name, text, chunks, access.userId])).rows[0];
        await audit(c, access, req, 'ai_agent.doc.add', 'ai_agent', r.id, { name, chunks });
        return { doc: apiDoc(r) };
      });
    },
    { limit: 9 * 1024 * 1024 }
  );

  route('DELETE', '/api/ai-agent/docs/:id', async ({ req, access, params }) => {
    must(access, 'ai_agent', 'update', { tenantId: access.tenantId });
    const id = uuidOr400(params.id, 'Documento');
    await tx(H.pool, access, async (c) => {
      const r = await c.query('DELETE FROM ai_knowledge_docs WHERE id = $1 RETURNING name', [id]);
      if (!r.rowCount) throw notFound('Documento não encontrado.');
      await audit(c, access, req, 'ai_agent.doc.remove', 'ai_agent', id, { name: r.rows[0].name });
    });
    return { ok: true };
  });

  // Chat de teste: usa a configuração e a base SALVAS, chama a OpenAI de verdade, mas NÃO manda nada para o WhatsApp.
  route('POST', '/api/ai-agent/test', async ({ access, body }) => {
    must(access, 'ai_agent', 'read', { tenantId: access.tenantId });
    if (!openai?.configured) throw new HttpError(503, 'A chave da OpenAI ainda não foi configurada no servidor (OPENAI_API_KEY).');
    if (!testLimiter(`${access.tenantId}:${access.userId}`)) throw new HttpError(429, 'Muitos testes seguidos. Aguarde um minuto.');
    const turns = Array.isArray(body.messages) ? body.messages.slice(-12) : [];
    const history = turns.filter((t) => t && ['lead', 'ai'].includes(t.from) && typeof t.text === 'string' && t.text.trim()).map((t) => ({ from: t.from, text: t.text.trim().slice(0, 1000) }));
    if (!history.length || history[history.length - 1].from !== 'lead') throw bad('Escreva uma mensagem de cliente para testar.');
    const ctx = await tx(
      H.pool,
      access,
      async (c) => ({
        agent: (await c.query('SELECT prompt, handoff_rules FROM ai_agents')).rows[0] || { prompt: '', handoff_rules: [] },
        docs: (await c.query('SELECT name, content FROM ai_knowledge_docs')).rows,
      }),
      { readOnly: true }
    );
    const recent = history.filter((h) => h.from === 'lead').slice(-3).map((h) => h.text).join(' ');
    const chunks = retrieve(ctx.docs, recent);
    let ai;
    try {
      ai = await openai.chat({ messages: buildMessages({ prompt: ctx.agent.prompt, rules: ctx.agent.handoff_rules, chunks, history }), json: true, temperature: 0.3, maxTokens: 350 });
    } catch (e) {
      if (e instanceof AiError) throw new HttpError(e.status === 503 ? 503 : 502, e.message);
      throw e;
    }
    await tx(H.pool, access, (c) => c.query("INSERT INTO ai_usage (tenant_id, kind, model, prompt_tokens, completion_tokens) VALUES ($1, 'test', $2, $3, $4)", [access.tenantId, ai.model, ai.usage.prompt, ai.usage.completion]));
    const p = parseReply(ai.text);
    const source = chunks[0]?.doc || null;
    if (p.handoff || !p.reply) {
      const rule = ctx.agent.handoff_rules.find((r) => p.reason && p.reason.toLowerCase().includes(String(r).toLowerCase().slice(0, 12))) || null;
      return { kind: 'handoff', text: p.reply || 'Passando para um atendente humano', reason: p.reason, rule };
    }
    return { kind: 'ai', text: p.reply, source };
  });
};
