'use strict';
// Núcleo PURO do Agente de IA (sem banco, sem rede): quebra a base de conhecimento em trechos, escolhe os
// trechos relevantes para a pergunta, monta a conversa para o modelo e interpreta a resposta.
// Testado em Node (test/api/ai-agent.test.mjs).

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

const STOP = new Set('a o os as um uma uns umas de do da dos das em no na nos nas por para com sem e ou que se ao aos e eh ja nao sim mais menos muito pouco como qual quais quando onde quem eu voce vc tu ele ela nos eles elas me te lhe meu minha seu sua isso isto esse essa este esta aquele aquela ter tem tenho temos quero queria gostaria bom boa dia tarde noite oi ola favor pode poderia'.split(' '));
const tokens = (s) => norm(s).split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !STOP.has(t));

/** Quebra um texto em trechos de ~`size` caracteres, respeitando parágrafos. */
function chunkText(text, size = 900) {
  const paras = String(text || '')
    .replace(/\r/g, '')
    .split(/\n{2,}/)
    .map((p) => p.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean);
  const chunks = [];
  let cur = '';
  const push = () => {
    if (cur.trim()) chunks.push(cur.trim());
    cur = '';
  };
  for (const p of paras) {
    if (p.length > size) {
      push();
      for (let i = 0; i < p.length; i += size) chunks.push(p.slice(i, i + size));
    } else if ((cur + '\n\n' + p).length > size) {
      push();
      cur = p;
    } else {
      cur = cur ? `${cur}\n\n${p}` : p;
    }
  }
  push();
  return chunks;
}

/**
 * Trechos mais relevantes para a pergunta (pontuação por termos em comum, ponderada por raridade).
 * @param docs [{ name, content }]
 * @returns [{ doc, text, score }]  (já limitado por `topK` e `maxChars`)
 */
function retrieve(docs, query, { topK = 4, maxChars = 3600 } = {}) {
  const q = tokens(query);
  if (!q.length) return [];
  const all = [];
  for (const d of docs || []) for (const text of chunkText(d.content)) all.push({ doc: d.name, text, set: new Set(tokens(text)) });
  if (!all.length) return [];
  const df = new Map();
  for (const t of new Set(q)) df.set(t, all.filter((c) => c.set.has(t)).length);
  const scored = all
    .map((c) => ({ doc: c.doc, text: c.text, score: [...new Set(q)].reduce((n, t) => n + (c.set.has(t) ? 1 + Math.log(1 + all.length / (1 + df.get(t))) : 0), 0) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);
  const out = [];
  let used = 0;
  for (const c of scored) {
    if (out.length >= topK || used + c.text.length > maxChars) continue;
    out.push(c);
    used += c.text.length;
  }
  return out;
}

const RULES_JSON =
  'Responda SEMPRE com um JSON: {"reply": string, "handoff": boolean, "reason": string}. ' +
  '"reply" é a mensagem para o cliente (curta, natural, em português do Brasil, estilo WhatsApp, sem markdown). ' +
  '"handoff" = true quando um humano deve assumir; "reason" explica em poucas palavras (vazio se handoff = false).';

/** Mensagens para o modelo. `history`: [{ from: 'lead'|'ai'|'human', text }] em ordem cronológica. */
function buildMessages({ prompt, rules = [], chunks = [], history = [], contactName = '' }) {
  const sys = [
    String(prompt || 'Você é um atendente simpático e objetivo.').trim(),
    '',
    'REGRAS INEGOCIÁVEIS:',
    '- Use apenas as informações da BASE DE CONHECIMENTO abaixo e do que o cliente disse. Se a resposta não estiver lá, NÃO invente: diga que vai confirmar com a equipe e transfira (handoff = true).',
    '- Nunca invente preços, prazos, descontos, políticas ou dados da empresa.',
    '- Se o cliente pedir para falar com uma pessoa, estiver irritado, ou a conversa fugir do que você pode resolver, transfira (handoff = true).',
    ...(rules.length ? ['- Transfira também quando: ' + rules.map((r) => `"${r}"`).join('; ') + '.'] : []),
    contactName ? `- O cliente se chama ${String(contactName).split(/\s+/)[0]}.` : '',
    '',
    chunks.length ? 'BASE DE CONHECIMENTO:\n' + chunks.map((c, i) => `[${i + 1}] (${c.doc}) ${c.text}`).join('\n\n') : 'BASE DE CONHECIMENTO: (vazia — só responda o que for saudação ou triagem; o resto, transfira).',
    '',
    RULES_JSON,
  ]
    .filter((l) => l !== '')
    .join('\n');
  const msgs = [{ role: 'system', content: sys }];
  for (const m of history) {
    if (!m.text) continue;
    msgs.push({ role: m.from === 'lead' ? 'user' : 'assistant', content: String(m.text).slice(0, 1500) });
  }
  return msgs;
}

/** Interpreta a resposta do modelo (JSON; tolera texto solto). Nunca lança. */
function parseReply(raw) {
  const text = String(raw || '').trim();
  try {
    const j = JSON.parse(text.replace(/^```(?:json)?|```$/g, '').trim());
    const reply = typeof j.reply === 'string' ? j.reply.trim() : '';
    return { reply: reply.slice(0, 1500), handoff: j.handoff === true, reason: typeof j.reason === 'string' ? j.reason.trim().slice(0, 200) : '' };
  } catch {
    // resposta fora do formato: melhor passar para um humano do que mandar lixo ao cliente
    return { reply: '', handoff: true, reason: 'resposta do agente fora do formato esperado' };
  }
}

/**
 * Pode o agente responder agora? (decisão pura; o runtime fornece os fatos)
 * @returns { ok: true } | { ok: false, why }
 */
function canAutoReply({ configured, instanceActive, assigneeId, aiPaused, resolved, replies, maxReplies, tokensToday, dailyCap, hasPhone }) {
  if (!configured) return { ok: false, why: 'sem chave da OpenAI' };
  if (!instanceActive) return { ok: false, why: 'IA desligada neste número' };
  if (!hasPhone) return { ok: false, why: 'conversa sem telefone' };
  if (assigneeId) return { ok: false, why: 'já tem atendente' };
  if (aiPaused) return { ok: false, why: 'um humano assumiu ou a IA já transferiu' };
  if (resolved) return { ok: false, why: 'conversa resolvida' };
  if (replies >= maxReplies) return { ok: false, why: 'limite de respostas da IA nesta conversa' };
  if (tokensToday >= dailyCap) return { ok: false, why: 'teto diário de uso da IA atingido' };
  return { ok: true };
}

module.exports = { chunkText, retrieve, buildMessages, parseReply, canAutoReply, tokens };
