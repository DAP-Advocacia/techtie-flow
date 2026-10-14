// API de ponta a ponta (HTTP + WebSocket) contra Postgres REAL em Docker, com canal de WhatsApp FALSO.
// Foco: o que importa para operar — login, convite, isolamento entre usuários e entre tenants,
// envio de mensagem, negócios e tempo real entregue só a quem pode ver.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { detectEnv, startPostgres, repoRoot } from '../permissions-sql/_harness.mjs';

const require = createRequire(import.meta.url);
const { createApp } = require('../../src/api/app.js');
const { createHub } = require('../../src/api/ws.js');
const { ingestMessage, setInstanceStatus } = require('../../src/channels/ingest.js');
const { WebSocket } = require('ws');

const env = await detectEnv();
const skip = env.skip || false;
const config = { authSecret: 'segredo-de-teste-'.repeat(4), tokenTtlSeconds: 3600, corsOrigins: [], appUrl: 'http://app.test' };
const PASSWORD = 'senha-de-teste-bem-longa';
let h, server, base, hub, tenantA, tenantB, instanceId;
const sent = [];
const channel = { async sendText(inst, phone, text) { sent.push({ inst, phone, text }); return { id: `WA-${sent.length}` }; }, async connect() {}, async disconnect() {}, state: () => ({ status: 'connected', qr: null }) };

async function call(pathname, { method = 'GET', token, body } = {}) {
  const res = await fetch(base + pathname, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ...json };
}
const login = async (email, password = PASSWORD) => (await call('/api/auth/login', { method: 'POST', body: { email, password } })).token;
const seed = (slug, email) => {
  const direct = `postgres://postgres:${h.admin.options.password}@127.0.0.1:${h.port}/postgres`;
  const r = spawnSync(process.execPath, [path.join(repoRoot, 'db', 'seed.mjs')], { env: { ...process.env, DIRECT_URL: direct, SEED_TENANT_NAME: slug, SEED_TENANT_SLUG: slug, SEED_ADMIN_NAME: 'Admin ' + slug, SEED_ADMIN_EMAIL: email, SEED_ADMIN_PASSWORD: PASSWORD }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
};
const wsOpen = (ticket) => new Promise((resolve, reject) => {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?ticket=${ticket}`);
  ws.events = [];
  ws.on('message', (d) => ws.events.push(JSON.parse(d)));
  ws.on('open', () => resolve(ws));
  ws.on('error', reject);
});
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  if (skip) return;
  h = await startPostgres(env.pg, 'api');
  const c = await h.admin.connect();
  try { await c.query(fs.readFileSync(path.join(repoRoot, 'db', 'migrations', '0002_pilot.sql'), 'utf8')); } finally { c.release(); }
  seed('empresa-a', 'admin@a.com.br');
  seed('empresa-b', 'admin@b.com.br');
  tenantA = (await h.admin.query("SELECT id FROM tenants WHERE slug='empresa-a'")).rows[0].id;
  tenantB = (await h.admin.query("SELECT id FROM tenants WHERE slug='empresa-b'")).rows[0].id;
  hub = createHub({ pool: h.app, config });
  const app = createApp({ pool: h.app, config, hub, channel });
  server = http.createServer(async (req, res) => { if (!(await app.handle(req, res))) { res.writeHead(404); res.end(); } });
  hub.attach(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  hub?.close();
  await new Promise((r) => (server ? server.close(r) : r()));
  if (h) await h.dispose();
});

test('login: senha errada, bloqueio após 5 erros, token adulterado e rota sem token', { skip }, async () => {
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { email: 'nao@existe.com', password: 'x'.repeat(12) } })).status, 401);
  for (let i = 0; i < 5; i++) assert.equal((await call('/api/auth/login', { method: 'POST', body: { email: 'admin@a.com.br', password: 'errada-errada-1' } })).status, 401);
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { email: 'admin@a.com.br', password: PASSWORD } })).status, 429, 'conta travada mesmo com a senha certa');
  await h.admin.query("UPDATE auth_identities SET failed_attempts = 0, locked_until = NULL"); // destrava para os próximos testes
  const ok = await call('/api/auth/login', { method: 'POST', body: { email: 'ADMIN@a.com.br', password: PASSWORD } });
  assert.equal(ok.status, 200);
  assert.equal((await call('/api/me', { token: ok.token + 'x' })).status, 401);
  assert.equal((await call('/api/me')).status, 401);
  assert.equal((await call('/api/bootstrap', { token: ok.token })).pipelines.length, 2);
});

test('convite: admin convida Atendente, convidado define a senha e entra; perfil acima do poder é recusado', { skip }, async () => {
  const admin = await login('admin@a.com.br');
  const inv = await call('/api/users/invite', { method: 'POST', token: admin, body: { email: 'ana@a.com.br', name: 'Ana', roleId: 'role_agent' } });
  assert.equal(inv.status, 200);
  assert.match(inv.inviteUrl, /^http:\/\/app\.test\/#\/accept\?token=/);
  assert.equal((await login('ana@a.com.br')), undefined, 'sem senha ainda: não entra');
  const token = new URL(inv.inviteUrl.replace('/#/', '/')).searchParams.get('token');
  assert.equal((await call('/api/auth/accept-invite', { method: 'POST', body: { token, password: 'curta' } })).status, 400);
  assert.equal((await call('/api/auth/accept-invite', { method: 'POST', body: { token, password: PASSWORD } })).status, 200);
  assert.equal((await call('/api/auth/accept-invite', { method: 'POST', body: { token, password: PASSWORD } })).status, 400, 'convite é de uso único');
  assert.ok(await login('ana@a.com.br'));
  assert.equal((await call('/api/users/invite', { method: 'POST', token: admin, body: { email: 'ana@a.com.br', roleId: 'role_agent' } })).status, 409, 'e-mail repetido');
  // Atendente não convida ninguém
  const ana = await login('ana@a.com.br');
  assert.equal((await call('/api/users/invite', { method: 'POST', token: ana, body: { email: 'x@a.com.br', roleId: 'role_agent' } })).status, 403);
});

test('mensagens: chega do WhatsApp, aparece só para quem pode, resposta atribui e envia pelo canal', { skip }, async () => {
  instanceId = (await call('/api/instances', { method: 'POST', token: await login('admin@a.com.br'), body: { name: 'Comercial' } })).instance.id;
  await setInstanceStatus({ pool: h.app }, { tenantId: tenantA, instanceId, status: 'connected', phone: '5511900000001' });
  const admin = await login('admin@a.com.br');
  const ana = await login('ana@a.com.br');

  // 1ª mensagem do cliente: cai na FILA; dedupe: a mesma mensagem 2x vale uma
  const inbound = (id, text, phone = '5511988880001') => ingestMessage({ pool: h.app, notify: hub.notify }, { tenantId: tenantA, instanceId, phone, pushName: 'Cliente 1', message: { id, type: 'text', text, direction: 'in', createdAt: new Date().toISOString() } });
  await inbound('M1', 'Olá!');
  assert.equal((await inbound('M1', 'Olá!')).duplicate, true);
  const convs = (await call('/api/bootstrap', { token: ana })).conversations;
  assert.equal(convs.length, 1, 'Atendente vê a fila');
  const convId = convs[0].id;
  assert.equal(convs[0].unread, 1);

  // Atendente responde: vai pelo canal, a conversa passa a ser dela
  const sentMsg = await call(`/api/conversations/${convId}/messages`, { method: 'POST', token: ana, body: { text: 'Oi, tudo bem?' } });
  assert.equal(sentMsg.status, 200);
  assert.equal(sent.at(-1).text, 'Oi, tudo bem?');
  assert.equal(sent.at(-1).phone, '5511988880001');
  assert.equal(sentMsg.conversation.assigneeId !== null, true);
  const list = await call(`/api/conversations/${convId}/messages`, { token: ana });
  assert.deepEqual(list.messages.map((m) => m.type), ['in', 'out']);

  // Admin (Admin vê tudo) também vê; uma 2ª Atendente NÃO vê a conversa de Ana
  const inv = await call('/api/users/invite', { method: 'POST', token: admin, body: { email: 'bia@a.com.br', roleId: 'role_agent' } });
  await call('/api/auth/accept-invite', { method: 'POST', body: { token: new URL(inv.inviteUrl.replace('/#/', '/')).searchParams.get('token'), password: PASSWORD } });
  const bia = await login('bia@a.com.br');
  assert.equal((await call('/api/bootstrap', { token: bia })).conversations.length, 0, 'conversa de outra pessoa não aparece');
  assert.equal((await call(`/api/conversations/${convId}/messages`, { token: bia })).status, 404);
  assert.equal((await call(`/api/conversations/${convId}/messages`, { method: 'POST', token: bia, body: { text: 'intrometida' } })).status, 404);
  assert.equal((await call(`/api/conversations/${convId}`, { method: 'PATCH', token: bia, body: { status: 'resolved' } })).status, 404);
});

test('isolamento entre tenants: o admin de outra empresa não enxerga nem altera nada', { skip }, async () => {
  const b = await login('admin@b.com.br');
  const boot = await call('/api/bootstrap', { token: b });
  assert.equal(boot.conversations.length, 0);
  assert.equal(boot.contacts.length, 0);
  const convId = (await h.admin.query('SELECT id FROM conversations LIMIT 1')).rows[0].id;
  assert.equal((await call(`/api/conversations/${convId}/messages`, { token: b })).status, 404);
  assert.equal((await call(`/api/conversations/${convId}`, { method: 'PATCH', token: b, body: { status: 'resolved' } })).status, 404);
  assert.equal((await call(`/api/instances/${instanceId}/connect`, { method: 'POST', token: b })).status, 404);
});

test('negócios: Atendente cria e move o próprio; não vê o dos outros nem consegue trocar o dono', { skip }, async () => {
  const admin = await login('admin@a.com.br');
  const ana = await login('ana@a.com.br');
  const boot = await call('/api/bootstrap', { token: admin });
  const funil = boot.pipelines.find((p) => p.name === 'Comercial');
  const [proposta, negociacao, fechamento] = funil.stages;
  const adminDeal = (await call('/api/deals', { method: 'POST', token: admin, body: { title: 'Negócio do admin', pipelineId: funil.id, stageId: proposta.id, value: 1000 } })).deal;
  const anaDeal = (await call('/api/deals', { method: 'POST', token: ana, body: { title: 'Negócio da Ana', pipelineId: funil.id, stageId: proposta.id, value: 500 } })).deal;
  assert.equal((await call('/api/bootstrap', { token: ana })).deals.map((d) => d.title).join(), 'Negócio da Ana');
  assert.equal((await call(`/api/deals/${anaDeal.id}`, { method: 'PATCH', token: ana, body: { stageId: negociacao.id } })).deal.stageId, negociacao.id);
  assert.equal((await call(`/api/deals/${adminDeal.id}`, { method: 'PATCH', token: ana, body: { stageId: negociacao.id } })).status, 404, 'negócio alheio some');
  assert.equal((await call(`/api/deals/${anaDeal.id}`, { method: 'PATCH', token: ana, body: { ownerId: (await call('/api/bootstrap', { token: admin })).users.find((u) => u.name === 'Bia' || u.email === 'bia@a.com.br')?.id } })).status, 403, 'sem transfer não troca o dono');
  assert.equal((await call(`/api/deals/${anaDeal.id}`, { method: 'PATCH', token: ana, body: { tenantId: tenantB, status: 'won' } })).status, 400, 'campos fora da lista permitida são ignorados');
  // etapa de outro funil é recusada
  const outro = boot.pipelines.find((p) => p.name !== 'Comercial').stages[0];
  assert.equal((await call(`/api/deals/${anaDeal.id}`, { method: 'PATCH', token: ana, body: { stageId: outro.id } })).status, 400);
  void fechamento;
});

test('tempo real: o evento chega só a quem pode ler a conversa', { skip }, async () => {
  const admin = await login('admin@a.com.br');
  const bia = await login('bia@a.com.br');
  const wsAdmin = await wsOpen((await call('/api/ws-ticket', { method: 'POST', token: admin })).ticket);
  const wsBia = await wsOpen((await call('/api/ws-ticket', { method: 'POST', token: bia })).ticket);
  // cliente 2 chega: vai para a fila (assigneeId nulo) ⇒ Bia e Admin veem
  await ingestMessage({ pool: h.app, notify: hub.notify }, { tenantId: tenantA, instanceId, phone: '5511988880002', pushName: 'Cliente 2', message: { id: 'M9', type: 'text', text: 'Fila!', direction: 'in' } });
  await settle();
  assert.equal(wsAdmin.events.some((e) => e.type === 'message'), true);
  assert.equal(wsBia.events.some((e) => e.type === 'message'), true, 'fila é de todos os atendentes');
  // nova mensagem na conversa que JÁ é da Ana: Bia NÃO recebe
  wsBia.events.length = 0;
  await ingestMessage({ pool: h.app, notify: hub.notify }, { tenantId: tenantA, instanceId, phone: '5511988880001', pushName: 'Cliente 1', message: { id: 'M10', type: 'text', text: 'Resposta', direction: 'in' } });
  await settle();
  assert.equal(wsBia.events.some((e) => e.type === 'message'), false, 'conversa de outra pessoa não vaza pelo WebSocket');
  // ticket inválido é recusado
  await assert.rejects(() => wsOpen('invalido'));
  wsAdmin.close();
  wsBia.close();
});

test('histórico não lota a fila: conversa nascida de histórico é "resolvida" e reabre quando o cliente escreve', { skip }, async () => {
  const deps = { pool: h.app, notify() {} };
  const phone = '5511977770001';
  const msg = (id, text, at) => ({ id, type: 'text', text, direction: 'in', createdAt: at });
  await ingestMessage(deps, { tenantId: tenantA, instanceId, phone, pushName: 'Antigo', isHistory: true, message: msg('H1', 'conversa antiga', '2024-01-01T10:00:00Z') });
  const row = async () => (await h.admin.query('SELECT status, unread_count FROM conversations WHERE phone = $1', [phone])).rows[0];
  assert.deepEqual(await row(), { status: 'resolved', unread_count: 0 }, 'histórico: fora da fila e sem não lida');
  await ingestMessage(deps, { tenantId: tenantA, instanceId, phone, pushName: 'Antigo', isHistory: true, message: msg('H0', 'mais antiga ainda', '2023-12-01T10:00:00Z') });
  assert.deepEqual(await row(), { status: 'resolved', unread_count: 0 }, 'mais histórico não reabre');
  await ingestMessage(deps, { tenantId: tenantA, instanceId, phone, pushName: 'Antigo', isHistory: false, message: msg('H2', 'oi, voltei', new Date().toISOString()) });
  assert.deepEqual(await row(), { status: 'queue', unread_count: 1 }, 'cliente escreveu de novo: volta para a fila');
});
