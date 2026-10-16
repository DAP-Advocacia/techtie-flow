// Núcleo puro do Agente de IA e o cliente da OpenAI (com fetch falso): sem banco, sem internet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chunkText, retrieve, buildMessages, parseReply, canAutoReply } = require('../../src/ai/agent.js');
const { createOpenAI } = require('../../src/ai/openai.js');

test('chunkText: respeita parágrafos, limita o tamanho e não perde texto', () => {
  const text = ['Primeiro parágrafo sobre planos.', 'Segundo parágrafo sobre entrega.', 'x'.repeat(2000)].join('\n\n');
  const chunks = chunkText(text, 300);
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every((c) => c.length <= 300));
  assert.equal(chunks.join('').replace(/\s/g, '').length, text.replace(/\s/g, '').length);
  assert.deepEqual(chunkText('   \n\n  '), []);
});

test('retrieve: acha o trecho certo (sem acento/caixa), ignora o irrelevante e respeita o limite', () => {
  const docs = [
    { name: 'precos.txt', content: 'O Plano Pro custa R$ 250,50 por mês e inclui suporte.\n\nO Plano Basico custa R$ 99.' },
    { name: 'entrega.txt', content: 'Entregamos em todo o Brasil em ate 5 dias uteis.' },
  ];
  const r = retrieve(docs, 'Quanto custa o plano PRO?');
  assert.ok(r.length >= 1);
  assert.equal(r[0].doc, 'precos.txt');
  assert.match(r[0].text, /250,50/);
  assert.deepEqual(retrieve(docs, 'astronomia de buracos negros'), []);
  assert.deepEqual(retrieve(docs, 'a o de'), [], 'só palavras vazias não recupera nada');
  assert.deepEqual(retrieve([], 'plano'), []);
  const many = Array.from({ length: 20 }, (_, i) => ({ name: `d${i}`, content: `plano pro numero ${i} ` + 'texto '.repeat(150) }));
  assert.ok(retrieve(many, 'plano pro', { topK: 3 }).length <= 3);
  assert.ok(retrieve(many, 'plano pro', { maxChars: 1000 }).reduce((n, c) => n + c.text.length, 0) <= 1000);
});

test('buildMessages: personalidade, regras e base no prompt; histórico com os papéis certos', () => {
  const msgs = buildMessages({
    prompt: 'Você é a Duda.',
    rules: ['reclamação'],
    chunks: [{ doc: 'precos.txt', text: 'Plano Pro custa 250' }],
    history: [{ from: 'lead', text: 'oi' }, { from: 'ai', text: 'olá!' }, { from: 'human', text: 'aqui é o João' }, { from: 'lead', text: 'quanto custa?' }, { from: 'lead', text: '' }],
    contactName: 'Maria Souza',
  });
  const sys = msgs[0].content;
  assert.match(sys, /Você é a Duda\./);
  assert.match(sys, /"reclamação"/);
  assert.match(sys, /\[1\] \(precos\.txt\) Plano Pro custa 250/);
  assert.match(sys, /Maria/);
  assert.match(sys, /NÃO invente/);
  assert.deepEqual(msgs.slice(1).map((m) => m.role), ['user', 'assistant', 'assistant', 'user'], 'mensagem vazia fica de fora; humano e IA são "assistant"');
  assert.match(buildMessages({ prompt: '', history: [] })[0].content, /BASE DE CONHECIMENTO: \(vazia/);
});

test('parseReply: JSON válido, cerca de código, lixo e campos errados nunca viram resposta ao cliente', () => {
  assert.deepEqual(parseReply('{"reply":"Olá!","handoff":false,"reason":""}'), { reply: 'Olá!', handoff: false, reason: '' });
  assert.equal(parseReply('```json\n{"reply":"Oi","handoff":false}\n```').reply, 'Oi');
  assert.equal(parseReply('{"reply":"Vou chamar","handoff":true,"reason":"pediu pessoa"}').handoff, true);
  assert.equal(parseReply('{"reply":"x","handoff":"sim"}').handoff, false, 'só true literal transfere');
  const junk = parseReply('claro! posso ajudar com isso');
  assert.equal(junk.handoff, true, 'fora do formato: passa para humano');
  assert.equal(junk.reply, '');
  assert.equal(parseReply('{"reply":"a".repeat').handoff, true);
  assert.equal(parseReply(null).handoff, true);
  assert.ok(parseReply(JSON.stringify({ reply: 'x'.repeat(5000), handoff: false })).reply.length <= 1500);
});

test('canAutoReply: cada trava barra a IA, na ordem certa', () => {
  const ok = { configured: true, instanceActive: true, assigneeId: null, aiPaused: false, resolved: false, replies: 0, maxReplies: 8, tokensToday: 0, dailyCap: 1000, hasPhone: true };
  assert.deepEqual(canAutoReply(ok), { ok: true });
  const why = (patch) => canAutoReply({ ...ok, ...patch }).why;
  assert.equal(why({ configured: false }), 'sem chave da OpenAI');
  assert.equal(why({ instanceActive: false }), 'IA desligada neste número');
  assert.equal(why({ hasPhone: false }), 'conversa sem telefone');
  assert.equal(why({ assigneeId: 'u1' }), 'já tem atendente');
  assert.equal(why({ aiPaused: true }), 'um humano assumiu ou a IA já transferiu');
  assert.equal(why({ resolved: true }), 'conversa resolvida');
  assert.equal(why({ replies: 8 }), 'limite de respostas da IA nesta conversa');
  assert.equal(why({ tokensToday: 1000 }), 'teto diário de uso da IA atingido');
});

test('cliente OpenAI: envia o pedido certo, lê a resposta e NUNCA vaza a chave em erros', async () => {
  let seen;
  const okFetch = async (url, init) => {
    seen = { url, init, body: JSON.parse(init.body) };
    return { ok: true, status: 200, json: async () => ({ model: 'gpt-x', choices: [{ message: { content: '{"reply":"oi"}' } }], usage: { prompt_tokens: 12, completion_tokens: 3 } }) };
  };
  const ai = createOpenAI({ apiKey: 'sk-segredo-123', model: 'gpt-4o-mini', fetchImpl: okFetch });
  assert.equal(ai.configured, true);
  const out = await ai.chat({ messages: [{ role: 'user', content: 'oi' }], json: true, maxTokens: 50 });
  assert.equal(out.text, '{"reply":"oi"}');
  assert.deepEqual(out.usage, { prompt: 12, completion: 3 });
  assert.equal(seen.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(seen.init.headers.Authorization, 'Bearer sk-segredo-123');
  assert.deepEqual(seen.body.response_format, { type: 'json_object' });
  assert.equal(seen.body.max_tokens, 50);

  const failing = (status, msg) => async () => ({ ok: false, status, json: async () => ({ error: { message: msg } }) });
  for (const [status, msg] of [[401, 'Incorrect API key provided: sk-segredo-123'], [429, 'Rate limit'], [500, 'boom']]) {
    const bad = createOpenAI({ apiKey: 'sk-segredo-123', fetchImpl: failing(status, msg) });
    await assert.rejects(bad.chat({ messages: [] }), (e) => {
      assert.ok(e.status >= 400);
      assert.ok(e.message.length > 0);
      return true;
    });
  }
  const netDown = createOpenAI({ apiKey: 'k', fetchImpl: async () => { throw new Error('ECONNRESET com sk-segredo-123'); } });
  await assert.rejects(netDown.chat({ messages: [] }), (e) => !e.message.includes('sk-segredo-123') && e.status === 504);
  const none = createOpenAI({ apiKey: '' });
  assert.equal(none.configured, false);
  await assert.rejects(none.chat({ messages: [] }), (e) => e.status === 503);
  const noText = createOpenAI({ apiKey: 'k', fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ choices: [] }) }) });
  await assert.rejects(noText.chat({ messages: [] }), /sem texto/);
});
