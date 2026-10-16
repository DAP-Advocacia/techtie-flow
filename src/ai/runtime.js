'use strict';
// Execução do Agente de IA nas conversas reais: chega mensagem do cliente → (se o número tem a IA ligada e
// ninguém assumiu) consulta a base, chama a OpenAI, responde pelo WhatsApp e registra tudo.
// Segurança e custo:
//  - só responde conversa SEM atendente, não pausada, com a IA ligada naquele número;
//  - um humano que responde (ou digita no celular) pausa a IA nessa conversa; a IA que transfere também pausa;
//  - limite de respostas por conversa (config) e teto diário de tokens (AI_DAILY_TOKEN_CAP);
//  - nunca fala quando falta sessão de WhatsApp viva ou chave da OpenAI; erro da OpenAI = silêncio (a conversa fica na fila).
const { withTenant } = require('../db-tenant');
const { retrieve, buildMessages, parseReply, canAutoReply } = require('./agent');

const HANDOFF_FALLBACK = 'Vou chamar alguém da nossa equipe para te ajudar. Só um instante.';

function createAiRuntime({ pool, getChannel, notify, openai, config = {}, debounceMs = 2500, typingMs = (text) => Math.min(4000, 700 + text.length * 25), log = console }) {
  const timers = new Map(); // conversationId -> timeout (junta mensagens seguidas do cliente numa resposta só)
  const busy = new Set();
  const dailyCap = Number(config.aiDailyTokenCap) || 300_000;

  /** Chamado a cada mensagem NOVA do cliente (nunca histórico). */
  function onInbound({ tenantId, conversationId }) {
    if (!openai?.configured) return;
    clearTimeout(timers.get(conversationId));
    timers.set(
      conversationId,
      setTimeout(() => {
        timers.delete(conversationId);
        handle({ tenantId, conversationId }).catch((e) => log.error('[ia] falha ao responder:', e?.message || e));
      }, debounceMs)
    );
  }

  /** Decide e (se puder) responde. Devolve { skipped: motivo } | { replied: true, handoff } — usado direto nos testes. */
  async function handle({ tenantId, conversationId }) {
    if (busy.has(conversationId)) return { skipped: 'já respondendo' };
    busy.add(conversationId);
    try {
      return await run(tenantId, conversationId);
    } finally {
      busy.delete(conversationId);
    }
  }

  async function run(tenantId, conversationId) {
    const ctx = await withTenant(pool, { tenantId, readScopes: 'tenant', readOnly: true }, async (c) => {
      const conv = (
        await c.query(
          `SELECT c.id, c.instance_id, c.phone, c.assignee_id, c.status, c.ai_paused, c.ai_replies, c.contact_id, i.ai_active, ct.name AS contact_name
             FROM conversations c JOIN instances i ON i.id = c.instance_id LEFT JOIN contacts ct ON ct.id = c.contact_id WHERE c.id = $1`,
          [conversationId]
        )
      ).rows[0];
      if (!conv) return null;
      const agent = (await c.query('SELECT prompt, handoff_rules, max_replies FROM ai_agents')).rows[0] || { prompt: '', handoff_rules: [], max_replies: 8 };
      const docs = (await c.query('SELECT name, content FROM ai_knowledge_docs')).rows;
      const tokensToday = Number((await c.query("SELECT COALESCE(sum(prompt_tokens + completion_tokens), 0) AS n FROM ai_usage WHERE created_at > now() - interval '24 hours'")).rows[0].n);
      const msgs = (await c.query("SELECT direction, body, by_ai, created_at FROM messages WHERE conversation_id = $1 AND kind = 'text' AND body IS NOT NULL ORDER BY created_at DESC LIMIT 14", [conversationId])).rows.reverse();
      return { conv, agent, docs, tokensToday, msgs };
    });
    if (!ctx) return { skipped: 'conversa não existe' };
    const { conv, agent, docs, tokensToday, msgs } = ctx;
    const last = msgs[msgs.length - 1];
    if (!last || last.direction !== 'in') return { skipped: 'a última mensagem não é do cliente' };
    const gate = canAutoReply({
      configured: openai?.configured,
      instanceActive: conv.ai_active,
      assigneeId: conv.assignee_id,
      aiPaused: conv.ai_paused,
      resolved: conv.status === 'resolved',
      replies: conv.ai_replies,
      maxReplies: agent.max_replies,
      tokensToday,
      dailyCap,
      hasPhone: !!conv.phone,
    });
    if (!gate.ok) return { skipped: gate.why };

    const channel = getChannel?.();
    const who = { id: conv.instance_id, tenantId };
    if (!channel || (channel.has && !channel.has(who))) return { skipped: 'WhatsApp deste número desconectado' };

    const history = msgs.map((m) => ({ from: m.direction === 'in' ? 'lead' : m.by_ai ? 'ai' : 'human', text: m.body }));
    const recentLead = history.filter((h) => h.from === 'lead').slice(-3).map((h) => h.text).join(' ');
    const chunks = retrieve(docs, recentLead);
    const messages = buildMessages({ prompt: agent.prompt, rules: agent.handoff_rules, chunks, history, contactName: conv.contact_name });
    const ai = await openai.chat({ messages, json: true, temperature: 0.3, maxTokens: 350 });
    const parsed = parseReply(ai.text);
    const handoff = parsed.handoff || !parsed.reply;
    const text = parsed.reply || HANDOFF_FALLBACK;

    // pausa "humana" antes de responder (e para o cliente ver que alguém digitou)
    await new Promise((r) => setTimeout(r, typingMs(text)));
    // revalida: durante a espera um humano pode ter assumido
    const still = await withTenant(pool, { tenantId, readScopes: 'tenant', readOnly: true }, async (c) => (await c.query('SELECT assignee_id, ai_paused, status FROM conversations WHERE id = $1', [conversationId])).rows[0]);
    if (!still || still.assignee_id || still.ai_paused) return { skipped: 'um humano assumiu enquanto a IA preparava a resposta' };

    const sent = await channel.sendText(who, conv.phone, text);
    const out = await withTenant(pool, { tenantId, readScopes: 'tenant' }, async (c) => {
      const msg = (
        await c.query(
          "INSERT INTO messages (tenant_id, conversation_id, wa_message_id, direction, kind, body, by_ai, status) VALUES ($1, $2, $3, 'out', 'text', $4, true, 'sent') RETURNING id, created_at",
          [tenantId, conversationId, sent?.id || null, text]
        )
      ).rows[0];
      if (handoff) {
        await c.query("INSERT INTO messages (tenant_id, conversation_id, direction, kind, body, by_ai, status) VALUES ($1, $2, 'out', 'system', $3, true, 'sent')", [
          tenantId,
          conversationId,
          `Agente de IA passou para atendimento humano${parsed.reason ? `: ${parsed.reason}` : ''}`,
        ]);
      }
      await c.query('INSERT INTO ai_usage (tenant_id, conversation_id, kind, model, prompt_tokens, completion_tokens) VALUES ($1, $2, $3, $4, $5, $6)', [tenantId, conversationId, 'reply', ai.model, ai.usage.prompt, ai.usage.completion]);
      const conversation = (
        await c.query(
          `UPDATE conversations SET last_message_at = now(), last_message = left($2, 300), ai_replies = ai_replies + 1,
                  ai_paused = $3, status = CASE WHEN $3 THEN 'queue' ELSE status END, unread_count = CASE WHEN $3 THEN unread_count ELSE 0 END
            WHERE id = $1 RETURNING id, instance_id, contact_id, assignee_id, team_id, status, phone, unread_count, last_message, last_message_at`,
          [conversationId, text, handoff]
        )
      ).rows[0];
      return { conversation, message: { id: msg.id, conversationId, kind: 'text', direction: 'out', body: text, mediaUrl: null, at: msg.created_at.getTime(), waId: sent?.id || null, byAi: true } };
    });
    notify?.('message', { tenantId, ...out });
    return { replied: true, handoff, text, reason: parsed.reason };
  }

  return { onInbound, handle };
}

module.exports = { createAiRuntime, HANDOFF_FALLBACK };
