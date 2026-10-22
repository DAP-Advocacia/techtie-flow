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
const config = { authSecret: 'segredo-de-teste-'.repeat(4), tokenTtlSeconds: 3600, corsOrigins: [], appUrl: 'http://app.test', dashboardCacheMs: 0 };
const PASSWORD = 'senha-de-teste-bem-longa';
let h, server, base, hub, tenantA, tenantB, instanceId;
const sent = [];
// OpenAI SIMULADA: registra as chamadas e devolve o que o teste mandar (`next`). Nenhum teste chama a internet.
const fakeAi = {
  configured: true,
  model: 'fake-model',
  calls: [],
  next: null,
  async chat(req) {
    this.calls.push(req);
    return this.next ? this.next(req) : { text: JSON.stringify({ reply: 'Resposta de teste', handoff: false, reason: '' }), usage: { prompt: 100, completion: 20 }, model: 'fake-model' };
  },
};
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
  try { await c.query(fs.readFileSync(path.join(repoRoot, 'db', 'migrations', '0002_pilot.sql'), 'utf8')); await c.query(fs.readFileSync(path.join(repoRoot, 'db', 'migrations', '0003_personal_instances.sql'), 'utf8')); await c.query(fs.readFileSync(path.join(repoRoot, 'db', 'migrations', '0004_crm_ai.sql'), 'utf8')); await c.query(fs.readFileSync(path.join(repoRoot, 'db', 'migrations', '0005_tasks.sql'), 'utf8')); await c.query(fs.readFileSync(path.join(repoRoot, 'db', 'migrations', '0006_deal_expected_close.sql'), 'utf8')); await c.query(fs.readFileSync(path.join(repoRoot, 'db', 'migrations', '0007_pipeline_config.sql'), 'utf8')); await c.query(fs.readFileSync(path.join(repoRoot, 'db', 'migrations', '0008_pipeline_probability_backfill.sql'), 'utf8')); await c.query(fs.readFileSync(path.join(repoRoot, 'db', 'migrations', '0009_chat_profile.sql'), 'utf8')); } finally { c.release(); }
  seed('empresa-a', 'admin@a.com.br');
  seed('empresa-b', 'admin@b.com.br');
  tenantA = (await h.admin.query("SELECT id FROM tenants WHERE slug='empresa-a'")).rows[0].id;
  tenantB = (await h.admin.query("SELECT id FROM tenants WHERE slug='empresa-b'")).rows[0].id;
  hub = createHub({ pool: h.app, config });
  const app = createApp({ pool: h.app, config, hub, channel, openai: fakeAi });
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
  instanceId = (await call('/api/instances', { method: 'POST', token: await login('admin@a.com.br'), body: { name: 'Comercial', companyNumber: true } })).instance.id;
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

test('fila: conversa resolvida sem responsável (histórico) não vaza para Atendente nem Gestor', { skip }, async () => {
  const deps = { pool: h.app, notify() {} };
  const admin = await login('admin@a.com.br');
  const ana = await login('ana@a.com.br');
  await ingestMessage(deps, { tenantId: tenantA, instanceId, phone: '5511966660001', pushName: 'Historico X', isHistory: true, message: { id: 'FILA-H1', type: 'text', text: 'antigo', direction: 'in', createdAt: '2024-02-01T10:00:00Z' } });
  await ingestMessage(deps, { tenantId: tenantA, instanceId, phone: '5511966660002', pushName: 'Na fila', isHistory: false, message: { id: 'FILA-L1', type: 'text', text: 'novo', direction: 'in' } });
  const phones = async (token) => (await call('/api/bootstrap', { token })).contacts.map((c) => c.phone);
  assert.ok((await phones(admin)).includes('+5511966660001'), 'Admin vê o histórico');
  assert.equal((await phones(ana)).includes('+5511966660001'), false, 'Atendente NÃO vê conversa resolvida sem responsável');
  assert.ok((await phones(ana)).includes('+5511966660002'), 'mas vê o que está de fato na fila');
  // o Gestor (mesma regra da fila) também não: promove a Ana e confere
  const anaId = (await call('/api/bootstrap', { token: admin })).users.find((u) => u.email === 'ana@a.com.br').id;
  assert.equal((await call(`/api/users/${anaId}/roles`, { method: 'POST', token: admin, body: { roleIds: ['role_manager'] } })).status, 200);
  await settle(5500); // cache de permissões (5 s) — a troca vale no próximo carregamento
  const anaMgr = await login('ana@a.com.br');
  assert.equal((await phones(anaMgr)).includes('+5511966660001'), false, 'Gestor sem equipe também não vê o histórico');
});

test('perfis e equipes: troca com travas (autoridade, si mesmo, perfil inexistente, equipe inexistente)', { skip }, async () => {
  const admin = await login('admin@a.com.br');
  const ana = await login('ana@a.com.br'); // agora Gestor (teste anterior)
  const boot = await call('/api/bootstrap', { token: admin });
  const anaId = boot.users.find((u) => u.email === 'ana@a.com.br').id;
  const adminId = boot.users.find((u) => u.email === 'admin@a.com.br').id;
  assert.deepEqual(boot.users.find((u) => u.id === anaId).roleIds, ['role_manager'], 'perfil gravado no servidor');
  const me = await call('/api/me', { token: ana });
  assert.equal(me.permissions.report.read.scope, 'tenant', 'Gestor lê relatórios');
  // Gestor não tem role.assign nem user.update
  assert.equal((await call(`/api/users/${anaId}/roles`, { method: 'POST', token: ana, body: { roleIds: ['role_admin'] } })).status, 403, 'não se promove');
  assert.equal((await call(`/api/users/${anaId}/teams`, { method: 'POST', token: ana, body: { teamIds: [] } })).status, 403);
  // Admin: não altera o próprio perfil, perfil inexistente, lista vazia
  assert.equal((await call(`/api/users/${adminId}/roles`, { method: 'POST', token: admin, body: { roleIds: ['role_agent'] } })).status, 400);
  assert.equal((await call(`/api/users/${anaId}/roles`, { method: 'POST', token: admin, body: { roleIds: ['role_inexistente'] } })).status, 400);
  assert.equal((await call(`/api/users/${anaId}/roles`, { method: 'POST', token: admin, body: { roleIds: [] } })).status, 400);
  // volta a Ana para Atendente; equipe: com equipe válida, inexistente e a própria
  assert.equal((await call(`/api/users/${anaId}/roles`, { method: 'POST', token: admin, body: { roleIds: ['role_agent'] } })).status, 200);
  const teamId = boot.teams[0].id;
  assert.equal((await call(`/api/users/${anaId}/teams`, { method: 'POST', token: admin, body: { teamIds: [teamId] } })).status, 200);
  assert.equal((await call(`/api/users/${anaId}/teams`, { method: 'POST', token: admin, body: { teamIds: ['00000000-0000-4000-8000-000000000009'] } })).status, 400);
  assert.equal((await call(`/api/users/${adminId}/teams`, { method: 'POST', token: admin, body: { teamIds: [] } })).status, 400, 'não altera a própria equipe');
  const after = await call('/api/bootstrap', { token: admin });
  assert.deepEqual(after.users.find((u) => u.id === anaId).teamIds, [teamId]);
  assert.deepEqual(after.users.find((u) => u.id === anaId).roleIds, ['role_agent']);
  // regressão: quem NÃO lê a lista de usuários precisa receber o PRÓPRIO perfil (o front calcula menu/telas com ele)
  const selfBoot = await call('/api/bootstrap', { token: await login('ana@a.com.br') });
  const self = selfBoot.users.find((u) => u.email === 'ana@a.com.br');
  assert.deepEqual(self.roleIds, ['role_agent'], 'o próprio perfil vem no bootstrap');
  assert.deepEqual(self.teamIds, [teamId]);
  assert.equal(selfBoot.users.filter((u) => u.roleIds.length).length, 1, 'os perfis dos OUTROS não vazam para quem não lê usuários');
  const trail = (await h.admin.query("SELECT action FROM audit_log WHERE action IN ('role.assign','user.teams') ORDER BY seq")).rows.map((r) => r.action);
  assert.ok(trail.includes('role.assign') && trail.includes('user.teams'), 'mudanças auditadas');
});

test('perfis do tenant + recorte por número: o perfil recortado só enxerga (e conecta) o número liberado', { skip }, async () => {
  const admin = await login('admin@a.com.br');
  const boot = await call('/api/bootstrap', { token: admin });
  const biaId = boot.users.find((u) => u.email === 'bia@a.com.br').id;
  const segundo = (await call('/api/instances', { method: 'POST', token: admin, body: { name: 'Segundo', companyNumber: true } })).instance.id;
  const agentDef = boot.roles.find((r) => r.id === 'role_agent');
  // o Atendente de fábrica só enxerga números PESSOAIS; para testar o recorte por número dá a ele leitura/conexão de todos
  const def = (partitions) => ({ grants: [...agentDef.grants.filter((g) => g.entity !== 'instance'), { entity: 'instance', actions: ['read', 'connect'], scope: 'tenant' }], denies: agentDef.denies, partitions, fields: agentDef.fields });

  // validação e autoridade
  assert.equal((await call('/api/roles', { method: 'POST', token: admin, body: { name: 'Ruim', definition: { grants: [{ entity: 'inexistente', actions: ['read'], scope: 'tenant' }], denies: [], partitions: {}, fields: [] } } })).status, 400, 'o motor valida o perfil');
  assert.equal((await call('/api/roles', { method: 'POST', token: admin, body: { name: '', definition: def({}) } })).status, 400);
  assert.equal((await call('/api/roles', { method: 'POST', token: await login('bia@a.com.br'), body: { name: 'Sorrateiro', definition: def({}) } })).status, 403, 'Atendente não cria perfil');

  // cria o perfil recortado e atribui à Bia
  const created = await call('/api/roles', { method: 'POST', token: admin, body: { name: 'Atendente · só Comercial', clonedFrom: 'role_agent', definition: def({ instanceId: [instanceId] }) } });
  assert.equal(created.status, 200);
  const roleId = created.role.id;
  assert.equal((await call(`/api/users/${biaId}/roles`, { method: 'POST', token: admin, body: { roleIds: [roleId] } })).status, 200);
  await settle(5500); // cache de permissões (5 s)
  const bia = await login('bia@a.com.br');
  const biaBoot = await call('/api/bootstrap', { token: bia });
  const seen = biaBoot.instances.map((i) => i.id);
  assert.deepEqual(seen, [instanceId], 'a lista de números respeita o recorte');
  // regressão: quem tem perfil PERSONALIZADO (e não lê perfis) precisa receber a definição do PRÓPRIO perfil,
  // senão o front o trata como "Sem perfil". Os perfis dos outros não vazam.
  const mine = biaBoot.roles.filter((r) => !r.system);
  assert.deepEqual(mine.map((r) => r.id), [roleId], 'só o próprio perfil personalizado');
  assert.ok(mine[0].grants.length > 0, 'com a definição completa');
  assert.deepEqual(biaBoot.users.find((u) => u.email === 'bia@a.com.br').roleIds, [roleId]);
  assert.equal((await call('/api/bootstrap', { token: admin })).instances.length >= 2, true, 'o Admin continua vendo todos');
  assert.equal((await call(`/api/instances/${segundo}/qr`, { token: bia })).status, 403, 'e não conecta o número que não é dela');

  // editar, não excluir em uso, excluir depois de liberar
  assert.equal((await call(`/api/roles/${roleId}`, { method: 'PATCH', token: admin, body: { name: 'Atendente · só Comercial (v2)' } })).status, 200);
  assert.equal((await call(`/api/roles/${roleId}`, { method: 'DELETE', token: admin })).status, 409, 'perfil em uso não se exclui');
  assert.equal((await call(`/api/users/${biaId}/roles`, { method: 'POST', token: admin, body: { roleIds: ['role_agent'] } })).status, 200);
  assert.equal((await call(`/api/roles/${roleId}`, { method: 'DELETE', token: admin })).status, 200);
  assert.equal((await call(`/api/roles/${roleId}`, { method: 'DELETE', token: admin })).status, 404);
  assert.equal((await call('/api/roles/role_admin', { method: 'PATCH', token: admin, body: { name: 'x' } })).status, 400, 'perfil de fábrica não é editável');
});

test('números pessoais: o atendente cria e vê só o dele; as conversas do número dele vão direto para ele', { skip }, async () => {
  const admin = await login('admin@a.com.br');
  const ana = await login('ana@a.com.br');
  const bia = await login('bia@a.com.br');
  const anaId = (await call('/api/bootstrap', { token: ana })).users.find((u) => u.email === 'ana@a.com.br').id;

  // Ana cria o número dela (mesmo pedindo "da empresa", só o admin consegue: o dela nasce pessoal)
  const mine = await call('/api/instances', { method: 'POST', token: ana, body: { name: 'Ana · pessoal', companyNumber: true } });
  assert.equal(mine.status, 200);
  assert.equal(mine.instance.ownerId, anaId, 'quem cria é o responsável');
  const company = await call('/api/instances', { method: 'POST', token: admin, body: { name: 'Empresa', companyNumber: true } });
  assert.equal(company.instance.ownerId, null, 'o admin cria número da empresa (sem responsável)');
  const adminPersonal = await call('/api/instances', { method: 'POST', token: admin, body: { name: 'Admin · pessoal' } });
  assert.notEqual(adminPersonal.instance.ownerId, null, 'sem pedir, o admin também cria o dele');

  // nas configurações cada um vê só o que é dele (admin vê tudo)
  const anaSees = (await call('/api/bootstrap', { token: ana })).instances.map((i) => i.id);
  assert.deepEqual(anaSees, [mine.instance.id], 'Ana vê só o número dela');
  assert.ok(!(await call('/api/bootstrap', { token: bia })).instances.some((i) => i.id === mine.instance.id), 'Bia não vê o número da Ana');
  const adminSees = (await call('/api/bootstrap', { token: admin })).instances.map((i) => i.id);
  for (const i of [mine.instance.id, company.instance.id, adminPersonal.instance.id]) assert.ok(adminSees.includes(i), 'o admin vê todos');

  // conectar: o próprio sim, o dos outros não
  assert.notEqual((await call(`/api/instances/${mine.instance.id}/qr`, { token: ana })).status, 403, 'Ana conecta o próprio número');
  assert.equal((await call(`/api/instances/${mine.instance.id}/qr`, { token: bia })).status, 403, 'Bia não conecta o número da Ana');
  assert.equal((await call(`/api/instances/${company.instance.id}/qr`, { token: ana })).status, 403, 'Ana não mexe no número da empresa');

  // conversa do número pessoal: já nasce da Ana (não cai na fila de todos)
  const inbound = (instId, id, phone) => ingestMessage({ pool: h.app, notify: hub.notify }, { tenantId: tenantA, instanceId: instId, phone, pushName: 'Cliente', message: { id, type: 'text', text: 'Oi', direction: 'in', createdAt: Date.now() } });
  await inbound(mine.instance.id, 'P1', '5511977770001');
  const anaConv = (await call('/api/bootstrap', { token: ana })).conversations.find((c) => c.phone?.endsWith('77770001') || c.instanceId === mine.instance.id);
  assert.ok(anaConv, 'Ana recebe a conversa do número dela');
  assert.equal(anaConv.assigneeId, anaId);
  assert.notEqual(anaConv.status, 'queue');
  assert.ok(!(await call('/api/bootstrap', { token: bia })).conversations.some((c) => c.instanceId === mine.instance.id), 'Bia não vê a conversa do número pessoal da Ana');
  assert.ok((await call('/api/bootstrap', { token: admin })).conversations.some((c) => c.instanceId === mine.instance.id), 'o admin vê');

  // número da empresa continua indo para a fila
  await inbound(company.instance.id, 'P2', '5511977770002');
  assert.ok((await call('/api/bootstrap', { token: bia })).conversations.some((c) => c.instanceId === company.instance.id && c.status === 'queue'), 'número da empresa: fila de todos');
});

test('remover número: o dono remove o dele; conversas só com confirmação; ninguém remove o de outro', { skip }, async () => {
  const admin = await login('admin@a.com.br');
  const ana = await login('ana@a.com.br');
  const bia = await login('bia@a.com.br');
  const mk = async (token, name) => (await call('/api/instances', { method: 'POST', token, body: { name } })).instance.id;
  const exists = async (id) => (await call('/api/bootstrap', { token: admin })).instances.some((i) => i.id === id);

  // o Atendente remove o PRÓPRIO número (vazio); o de outra pessoa não
  const anaVazio = await mk(ana, 'Ana · vazio');
  assert.equal((await call(`/api/instances/${anaVazio}`, { method: 'DELETE', token: bia })).status, 403, 'Bia não remove o número da Ana');
  assert.equal((await call(`/api/instances/${anaVazio}`, { method: 'DELETE', token: ana })).ok, true);
  assert.equal(await exists(anaVazio), false);
  const anaInst = await mk(ana, 'Ana · remover');

  // Admin: sem conversas remove direto; com conversas exige confirmar e leva as conversas junto
  const vazio = await mk(admin, 'Vazio');
  assert.equal((await call(`/api/instances/${vazio}`, { method: 'DELETE', token: admin })).ok, true);
  assert.equal(await exists(vazio), false);

  await ingestMessage({ pool: h.app, notify: hub.notify }, { tenantId: tenantA, instanceId: anaInst, phone: '5511966660001', pushName: 'Cliente', message: { id: 'D1', type: 'text', text: 'Oi', direction: 'in', createdAt: Date.now() } });
  const sem = await call(`/api/instances/${anaInst}`, { method: 'DELETE', token: admin });
  assert.equal(sem.status, 409, 'com conversas: pede confirmação');
  assert.match(sem.error, /conversa/);
  assert.equal(await exists(anaInst), true);
  assert.equal((await call(`/api/instances/${anaInst}?withConversations=1`, { method: 'DELETE', token: ana })).status, 403, 'Ana não pode apagar as conversas, então não remove um número que tem conversas');
  assert.equal((await call(`/api/instances/${anaInst}?withConversations=1`, { method: 'DELETE', token: admin })).ok, true);
  assert.equal(await exists(anaInst), false);
  assert.equal((await h.admin.query('SELECT count(*)::int n FROM conversations WHERE instance_id = $1', [anaInst])).rows[0].n, 0, 'conversas saíram junto');
  assert.ok((await h.admin.query("SELECT 1 FROM audit_log WHERE action = 'instance.delete'")).rowCount >= 2, 'auditado');
});

test('CRM de verdade: contatos, produtos, proposta, compartilhar, excluir negócio e ajustes de número', { skip }, async () => {
  const admin = await login('admin@a.com.br');
  const ana = await login('ana@a.com.br');
  const bia = await login('bia@a.com.br');
  const boot = await call('/api/bootstrap', { token: admin });
  const pipe = boot.pipelines[0];
  const stage = pipe.stages[0].id;
  const anaId = (await call('/api/bootstrap', { token: ana })).users.find((u) => u.email === 'ana@a.com.br').id;
  const biaId = (await call('/api/bootstrap', { token: bia })).users.find((u) => u.email === 'bia@a.com.br').id;

  // ---- produtos: Admin cria; Atendente só lê
  assert.equal((await call('/api/products', { method: 'POST', token: ana, body: { name: 'Plano X', unit: 'mês', price: 100 } })).status, 403);
  const p1 = (await call('/api/products', { method: 'POST', token: admin, body: { name: 'Plano Pro', unit: 'mês', price: 250.5 } })).product;
  const p2 = (await call('/api/products', { method: 'POST', token: admin, body: { name: 'Setup', unit: 'un', price: 1000 } })).product;
  assert.equal((await call('/api/products', { method: 'POST', token: admin, body: { name: '', price: 1 } })).status, 400);
  assert.equal((await call('/api/products', { method: 'POST', token: admin, body: { name: 'Neg', price: -1 } })).status, 400);
  assert.ok((await call('/api/bootstrap', { token: ana })).products.some((p) => p.id === p1.id), 'o Atendente vê o catálogo');

  // ---- contato: criar com empresa, editar, telefone duplicado
  const ct = (await call('/api/contacts', { method: 'POST', token: ana, body: { name: 'Carla Souza', phone: '+55 11 95555-0001', company: 'Souza Ltda' } })).contact;
  assert.equal(ct.company, 'Souza Ltda');
  const ct2 = (await call('/api/contacts', { method: 'POST', token: ana, body: { name: 'Outro', phone: '5511955550002' } })).contact;
  const upd = await call(`/api/contacts/${ct.id}`, { method: 'PATCH', token: ana, body: { name: 'Carla S. Souza', email: 'CARLA@souza.com.br', company: 'Souza & Cia' } });
  assert.equal(upd.contact.name, 'Carla S. Souza');
  assert.equal(upd.contact.email, 'carla@souza.com.br');
  assert.equal(upd.contact.company, 'Souza & Cia');
  assert.equal((await call(`/api/contacts/${ct.id}`, { method: 'PATCH', token: ana, body: { phone: '5511955550002' } })).status, 409, 'telefone já existe');
  assert.equal((await call(`/api/contacts/${ct.id}`, { method: 'PATCH', token: ana, body: { email: 'inválido' } })).status, 400);
  assert.equal((await call(`/api/contacts/${ct.id}`, { method: 'PATCH', token: bia, body: { name: 'Invasor' } })).status, 404, 'contato de outra pessoa nem aparece');

  // ---- negócio: criar, proposta com itens (preço vem do CATÁLOGO), valor acompanha
  const deal = (await call('/api/deals', { method: 'POST', token: ana, body: { title: 'Proposta Carla', contactId: ct.id, pipelineId: pipe.id, stageId: stage, value: 10 } })).deal;
  const withItems = await call(`/api/deals/${deal.id}`, { method: 'PATCH', token: ana, body: { items: [{ productId: p1.id, qty: 2 }, { productId: p2.id, qty: 1 }] } });
  assert.equal(withItems.deal.value, 1501, '2 × 250,50 + 1.000 = 1.501 (calculado no servidor)');
  assert.equal(withItems.deal.items.length, 2);
  assert.equal(withItems.deal.items[0].unitPrice, 250.5);
  assert.equal((await call(`/api/deals/${deal.id}`, { method: 'PATCH', token: ana, body: { items: [{ productId: p1.id, qty: 0 }] } })).status, 400, 'quantidade inválida');
  assert.equal((await call(`/api/deals/${deal.id}`, { method: 'PATCH', token: ana, body: { items: [{ productId: '00000000-0000-4000-8000-000000000000', qty: 1 }] } })).status, 400, 'produto inexistente');
  const retitled = await call(`/api/deals/${deal.id}`, { method: 'PATCH', token: ana, body: { title: 'Proposta Carla v2', value: 2000 } });
  assert.equal(retitled.deal.title, 'Proposta Carla v2');
  assert.equal(retitled.deal.value, 2000);
  assert.equal((await call(`/api/deals/${deal.id}`, { method: 'PATCH', token: bia, body: { title: 'x' } })).status, 404, 'negócio de outra pessoa não aparece');

  // ---- enviar proposta: sem conversa registra e avisa; sem itens é recusado
  const sent = await call(`/api/deals/${deal.id}/proposal/send`, { method: 'POST', token: ana });
  assert.equal(sent.result, 'no-chat');
  assert.ok(sent.deal.proposalSentAt, 'envio registrado');
  const empty = (await call('/api/deals', { method: 'POST', token: ana, body: { title: 'Sem itens', contactId: ct2.id, pipelineId: pipe.id, stageId: stage } })).deal;
  assert.equal((await call(`/api/deals/${empty.id}/proposal/send`, { method: 'POST', token: ana })).status, 400);

  // ---- compartilhar: dono compartilha com a Bia; ela passa a ver; remover tira
  assert.equal((await call(`/api/deals/${deal.id}/shares`, { method: 'POST', token: bia, body: { type: 'user', id: anaId, level: 'read' } })).status, 404);
  const shared = await call(`/api/deals/${deal.id}/shares`, { method: 'POST', token: ana, body: { type: 'user', id: biaId, level: 'read' } });
  assert.deepEqual(shared.sharedWith, [{ type: 'user', id: biaId, level: 'read' }]);
  assert.ok((await call('/api/bootstrap', { token: bia })).deals.some((d) => d.id === deal.id), 'a Bia vê o negócio compartilhado');
  assert.deepEqual((await call('/api/bootstrap', { token: ana })).deals.find((d) => d.id === deal.id).sharedWith, [{ type: 'user', id: biaId, level: 'read' }]);
  assert.equal((await call(`/api/deals/${deal.id}/shares/user/${biaId}`, { method: 'DELETE', token: ana })).sharedWith.length, 0);
  assert.ok(!(await call('/api/bootstrap', { token: bia })).deals.some((d) => d.id === deal.id), 'descompartilhado: some');

  // ---- excluir: Atendente não exclui negócio (nem contato); Admin exclui; contato com negócio não
  assert.equal((await call(`/api/deals/${empty.id}`, { method: 'DELETE', token: ana })).status, 403);
  assert.equal((await call(`/api/contacts/${ct2.id}`, { method: 'DELETE', token: ana })).status, 403);
  assert.equal((await call(`/api/contacts/${ct2.id}`, { method: 'DELETE', token: admin })).status, 409, 'ainda tem negócio');
  assert.equal((await call(`/api/deals/${empty.id}`, { method: 'DELETE', token: admin })).ok, true);
  assert.equal((await call(`/api/contacts/${ct2.id}`, { method: 'DELETE', token: admin })).ok, true);

  // ---- número: renomear, trocar responsável (só quem pode), ligar a IA
  const mine = (await call('/api/instances', { method: 'POST', token: ana, body: { name: 'Ana · vendas' } })).instance;
  const ren = await call(`/api/instances/${mine.id}`, { method: 'PATCH', token: ana, body: { name: 'Ana · renomeado' } });
  assert.equal(ren.instance.name, 'Ana · renomeado');
  assert.equal((await call(`/api/instances/${mine.id}`, { method: 'PATCH', token: bia, body: { name: 'sequestro' } })).status, 403, 'Bia não renomeia o número da Ana');
  assert.equal((await call(`/api/instances/${mine.id}`, { method: 'PATCH', token: ana, body: { ownerId: biaId } })).status, 403, 'Atendente não passa o número para outra pessoa');
  const given = await call(`/api/instances/${mine.id}`, { method: 'PATCH', token: admin, body: { ownerId: biaId } });
  assert.equal(given.instance.ownerId, biaId);
  assert.equal(given.instance.ownerName.length > 0, true);
  assert.equal((await call(`/api/instances/${mine.id}`, { method: 'PATCH', token: ana, body: { aiActive: true } })).status, 403, 'ligar a IA exige permissão do Agente de IA');
  assert.equal((await call(`/api/instances/${mine.id}`, { method: 'PATCH', token: admin, body: { aiActive: true } })).instance.aiActive, true);
  assert.equal((await call(`/api/instances/${mine.id}`, { method: 'PATCH', token: admin, body: { ownerId: null } })).instance.ownerId, null, 'vira número da empresa');
});

test('dashboard real: números do banco por período, com as permissões de quem pede', { skip }, async () => {
  const admin = await login('admin@a.com.br');
  const ana = await login('ana@a.com.br');
  assert.equal((await call('/api/dashboard', { token: ana })).status, 403, 'Atendente não tem report.read');
  assert.equal((await call('/api/dashboard')).status, 401);

  const d = await call('/api/dashboard', { token: admin });
  assert.deepEqual(Object.keys(d.periods), ['today', 'week', 'month']);
  for (const [key, p] of Object.entries(d.periods)) {
    assert.equal(p.key, key);
    for (const k of ['leads', 'active', 'conversion', 'revenue']) assert.equal(typeof p.kpis[k], 'number', `${key}.${k}`);
    for (const k of ['leads', 'active', 'conversion', 'revenue']) assert.equal(typeof p.deltas[k], 'number', `delta ${key}.${k}`);
    assert.ok(p.kpis.conversion >= 0 && p.kpis.conversion <= 100);
    assert.ok(Array.isArray(p.funnel) && Array.isArray(p.team));
    for (const b of p.bars.items) assert.ok(Number.isInteger(b.value) && b.value >= 0 && b.label && b.full);
  }
  assert.equal(d.periods.today.bars.items.length, 12);
  assert.equal(d.periods.week.bars.items.length, 7);
  assert.equal(d.periods.month.bars.items.length, 10);
  assert.ok(d.periods.month.kpis.leads >= 1, 'os testes anteriores receberam mensagens de clientes (conversas novas)');
  assert.ok(d.periods.month.kpis.active >= 1, 'há conversas não resolvidas');
  assert.ok(d.periods.month.team.every((r) => r.name && typeof r.conversations === 'number' && typeof r.won === 'number'));
  // o funil nunca cresce da esquerda para a direita
  for (const p of Object.values(d.periods)) for (let i = 1; i < p.funnel.length; i++) assert.ok(p.funnel[i].n <= p.funnel[i - 1].n);
  // receita ganha: um negócio ganho agora entra nos três períodos
  const boot = await call('/api/bootstrap', { token: admin });
  const pipe = boot.pipelines[0];
  const won = pipe.stages.find((s) => s.kind === 'won');
  if (won) {
    const before = d.periods.today.kpis.revenue;
    const deal = (await call('/api/deals', { method: 'POST', token: admin, body: { title: 'Ganho para o dashboard', pipelineId: pipe.id, stageId: pipe.stages[0].id, value: 777 } })).deal;
    const mv = await call(`/api/deals/${deal.id}`, { method: 'PATCH', token: admin, body: { stageId: won.id } });
    assert.ok(mv.deal, JSON.stringify(mv));
    const after = (await call('/api/dashboard', { token: admin })).periods;
    assert.equal(after.today.kpis.revenue, before + 777);
    assert.ok(after.week.kpis.revenue >= 777 && after.month.kpis.revenue >= 777);
  }
});

test('Agente de IA: configuração, base de conhecimento, teste e resposta real (OpenAI simulada)', { skip }, async () => {
  const { createAiRuntime } = require('../../src/ai/runtime.js');
  const admin = await login('admin@a.com.br');
  const ana = await login('ana@a.com.br');
  const reply = (o) => () => ({ text: JSON.stringify({ reply: 'Resposta de teste', handoff: false, reason: '', ...o }), usage: { prompt: 100, completion: 20 }, model: 'fake-model' });
  fakeAi.next = reply();
  fakeAi.calls.length = 0;

  // ---- permissões e validação da configuração
  assert.equal((await call('/api/ai-agent', { token: ana })).status, 403, 'Atendente não lê a configuração do agente');
  assert.equal((await call('/api/ai-agent', { method: 'PUT', token: ana, body: { prompt: 'x' } })).status, 403);
  assert.equal((await call('/api/ai-agent', { method: 'PUT', token: admin, body: { prompt: 'ok', handoffRules: ['x'.repeat(141)] } })).status, 400);
  assert.equal((await call('/api/ai-agent', { method: 'PUT', token: admin, body: { prompt: 'x'.repeat(2001) } })).status, 400);
  const saved = await call('/api/ai-agent', { method: 'PUT', token: admin, body: { prompt: 'Você é a Duda, atendente da Empresa A. Seja breve.', handoffRules: ['cliente pede para falar com uma pessoa', 'reclamação'], maxReplies: 5 } });
  assert.equal(saved.agent.prompt.startsWith('Você é a Duda'), true);
  assert.deepEqual(saved.agent.handoffRules, ['cliente pede para falar com uma pessoa', 'reclamação']);
  assert.equal(saved.agent.maxReplies, 5);
  assert.equal(saved.agent.configured, true);
  assert.equal((await call('/api/bootstrap', { token: admin })).agent.prompt.startsWith('Você é a Duda'), true, 'o bootstrap traz a configuração salva');
  assert.equal((await call('/api/bootstrap', { token: ana })).agent, undefined, 'quem não lê o agente não recebe a configuração');

  // ---- base de conhecimento: texto, arquivo (base64), PDF, duplicado, inválidos
  const doc = await call('/api/ai-agent/docs', { method: 'POST', token: admin, body: { name: 'precos.txt', text: 'O Plano Pro custa R$ 250,50 por mês e inclui suporte por WhatsApp e treinamento da equipe.' } });
  assert.equal(doc.doc.name, 'precos.txt');
  assert.equal((await call('/api/ai-agent/docs', { method: 'POST', token: admin, body: { name: 'PRECOS.txt', text: 'Texto longo o bastante para ser aceito pelo servidor.' } })).status, 409, 'nome repetido');
  assert.equal((await call('/api/ai-agent/docs', { method: 'POST', token: admin, body: { name: 'curto.txt', text: 'oi' } })).status, 400);
  assert.equal((await call('/api/ai-agent/docs', { method: 'POST', token: admin, body: { name: 'virus.exe', base64: Buffer.from('MZ....conteudo qualquer aqui').toString('base64') } })).status, 400);
  assert.equal((await call('/api/ai-agent/docs', { method: 'POST', token: ana, body: { name: 'x.txt', text: 'Texto longo o bastante para ser aceito pelo servidor.' } })).status, 403);
  const faq = await call('/api/ai-agent/docs', { method: 'POST', token: admin, body: { name: 'faq.md', base64: Buffer.from('# Entrega\n\nEntregamos em todo o Brasil em até 5 dias úteis.\n\n# Troca\n\nA troca pode ser feita em 7 dias corridos.').toString('base64') } });
  assert.equal(faq.doc.chunks >= 1, true);
  const pdfSrc = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 400 144]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 78>>stream\nBT /F1 14 Tf 20 100 Td (Garantia de trinta dias para qualquer produto) Tj ET\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF';
  const pdf = await call('/api/ai-agent/docs', { method: 'POST', token: admin, body: { name: 'garantia.pdf', base64: Buffer.from(pdfSrc).toString('base64') } });
  assert.ok(pdf.doc || pdf.status === 400, 'PDF lido ou recusado com mensagem (nunca erro interno)');
  assert.equal((await call('/api/ai-agent/docs', { method: 'POST', token: admin, body: { name: 'quebrado.pdf', base64: Buffer.from('isto não é um pdf de verdade').toString('base64') } })).status, 400);
  const listed = (await call('/api/ai-agent', { token: admin })).agent.knowledgeDocs.map((d) => d.name);
  assert.ok(listed.includes('precos.txt') && listed.includes('faq.md'));

  // ---- chat de teste: usa a configuração e a base de verdade (a OpenAI aqui é simulada)
  const t1 = await call('/api/ai-agent/test', { method: 'POST', token: admin, body: { messages: [{ from: 'lead', text: 'Quanto custa o Plano Pro?' }] } });
  assert.equal(t1.kind, 'ai');
  assert.equal(t1.text, 'Resposta de teste');
  const sys = fakeAi.calls.at(-1).messages[0].content;
  assert.match(sys, /Você é a Duda/, 'a personalidade vai no prompt');
  assert.match(sys, /Plano Pro custa R\$ 250,50/, 'o trecho certo da base foi recuperado');
  assert.match(sys, /cliente pede para falar com uma pessoa/, 'as regras de transbordo vão no prompt');
  assert.ok(!/Entregamos em todo o Brasil/.test(sys), 'trecho irrelevante não entra');
  fakeAi.next = reply({ handoff: true, reply: 'Vou chamar alguém.', reason: 'reclamação' });
  assert.equal((await call('/api/ai-agent/test', { method: 'POST', token: admin, body: { messages: [{ from: 'lead', text: 'Estou muito insatisfeito' }] } })).kind, 'handoff');
  fakeAi.next = reply();
  assert.equal((await call('/api/ai-agent/test', { method: 'POST', token: admin, body: { messages: [{ from: 'lead', text: 'oi' }, { from: 'ai', text: 'olá' }] } })).status, 400, 'a última fala precisa ser do cliente');
  assert.equal((await call('/api/ai-agent/test', { method: 'POST', token: ana, body: { messages: [{ from: 'lead', text: 'oi' }] } })).status, 403);

  // ---- resposta real a um cliente (WhatsApp falso): só em número com a IA ligada e conversa sem atendente
  const company = (await call('/api/instances', { method: 'POST', token: admin, body: { name: 'IA Comercial', companyNumber: true } })).instance;
  await setInstanceStatus({ pool: h.app }, { tenantId: tenantA, instanceId: company.id, status: 'connected', phone: '5511900000009' });
  const notified = [];
  const rt = createAiRuntime({ pool: h.app, getChannel: () => channel, notify: (t, p) => notified.push([t, p]), openai: fakeAi, config: {}, debounceMs: 0, typingMs: () => 0, log: { error() {} } });
  const inbound = async (instId, phone, text, id) => (await ingestMessage({ pool: h.app, notify: hub.notify }, { tenantId: tenantA, instanceId: instId, phone, pushName: 'Cliente IA', message: { id, type: 'text', text, direction: 'in', createdAt: Date.now() } })).conversation.id;
  const convOf = async (id) => (await h.admin.query('SELECT status, assignee_id, ai_paused, ai_replies, unread_count FROM conversations WHERE id = $1', [id])).rows[0];

  const off = await inbound(company.id, '5511933330001', 'Quanto custa o plano Pro?', 'IA-1');
  assert.deepEqual(await rt.handle({ tenantId: tenantA, conversationId: off }), { skipped: 'IA desligada neste número' });
  assert.equal((await call(`/api/instances/${company.id}`, { method: 'PATCH', token: admin, body: { aiActive: true } })).instance.aiActive, true);

  const before = sent.length;
  const c1 = await inbound(company.id, '5511933330002', 'Quanto custa o plano Pro?', 'IA-2');
  const r1 = await rt.handle({ tenantId: tenantA, conversationId: c1 });
  assert.equal(r1.replied, true);
  assert.equal(r1.handoff, false);
  assert.equal(sent.length, before + 1, 'a resposta saiu pelo WhatsApp');
  assert.equal(sent.at(-1).phone, '5511933330002');
  assert.equal(sent.at(-1).text, 'Resposta de teste');
  const saved1 = (await h.admin.query("SELECT body, by_ai, direction FROM messages WHERE conversation_id = $1 AND direction = 'out'", [c1])).rows;
  assert.deepEqual(saved1, [{ body: 'Resposta de teste', by_ai: true, direction: 'out' }]);
  assert.deepEqual(await convOf(c1), { status: 'queue', assignee_id: null, ai_paused: false, ai_replies: 1, unread_count: 0 });
  assert.equal(notified.at(-1)[1].message.byAi, true, 'o tempo real avisa que foi a IA');
  assert.equal((await h.admin.query('SELECT count(*)::int n FROM ai_usage WHERE conversation_id = $1', [c1])).rows[0].n, 1, 'uso registrado (controle de custo)');

  // a história vai para o modelo (cliente = user, IA = assistant)
  await inbound(company.id, '5511933330002', 'E tem desconto à vista?', 'IA-3');
  await rt.handle({ tenantId: tenantA, conversationId: c1 });
  const roles = fakeAi.calls.at(-1).messages.slice(1).map((m) => m.role);
  assert.deepEqual(roles, ['user', 'assistant', 'user']);

  // a IA transfere: manda a despedida, pausa, volta para a fila com a mensagem sem ler e deixa nota de sistema
  fakeAi.next = reply({ handoff: true, reply: 'Vou chamar alguém da equipe.', reason: 'cliente pediu uma pessoa' });
  const c2 = await inbound(company.id, '5511933330003', 'Quero falar com uma pessoa', 'IA-4');
  const r2 = await rt.handle({ tenantId: tenantA, conversationId: c2 });
  assert.equal(r2.handoff, true);
  const st2 = await convOf(c2);
  assert.equal(st2.ai_paused, true);
  assert.equal(st2.status, 'queue');
  assert.equal(st2.unread_count, 1, 'transferida: continua não lida para a equipe');
  assert.ok((await h.admin.query("SELECT 1 FROM messages WHERE conversation_id = $1 AND kind = 'system' AND body LIKE '%passou para atendimento humano: cliente pediu uma pessoa%'", [c2])).rowCount, 'nota de sistema com o motivo');
  fakeAi.next = reply();
  await inbound(company.id, '5511933330003', 'Alô?', 'IA-5');
  assert.deepEqual(await rt.handle({ tenantId: tenantA, conversationId: c2 }), { skipped: 'um humano assumiu ou a IA já transferiu' }, 'pausada: não responde mais');

  // um humano responde pela caixa de entrada → a IA para nessa conversa
  const c3 = await inbound(company.id, '5511933330004', 'Boa tarde', 'IA-6');
  assert.equal((await call(`/api/conversations/${c3}/messages`, { method: 'POST', token: admin, body: { text: 'Oi, aqui é o João!' } })).message.type, 'out');
  assert.equal((await convOf(c3)).ai_paused, true);
  await inbound(company.id, '5511933330004', 'Preciso de ajuda', 'IA-7');
  assert.equal((await rt.handle({ tenantId: tenantA, conversationId: c3 })).skipped !== undefined, true);

  // limites: respostas por conversa e teto diário de tokens
  await call('/api/ai-agent', { method: 'PUT', token: admin, body: { prompt: 'Você é a Duda.', handoffRules: [], maxReplies: 1 } });
  assert.deepEqual(await rt.handle({ tenantId: tenantA, conversationId: c1 }), { skipped: 'a última mensagem não é do cliente' });
  await inbound(company.id, '5511933330002', 'Mais uma dúvida', 'IA-8');
  assert.deepEqual(await rt.handle({ tenantId: tenantA, conversationId: c1 }), { skipped: 'limite de respostas da IA nesta conversa' });
  const rtCap = createAiRuntime({ pool: h.app, getChannel: () => channel, notify() {}, openai: fakeAi, config: { aiDailyTokenCap: 1 }, debounceMs: 0, typingMs: () => 0, log: { error() {} } });
  await call('/api/ai-agent', { method: 'PUT', token: admin, body: { prompt: 'Você é a Duda.', handoffRules: [], maxReplies: 50 } });
  const c5 = await inbound(company.id, '5511933330005', 'Olá', 'IA-9');
  assert.deepEqual(await rtCap.handle({ tenantId: tenantA, conversationId: c5 }), { skipped: 'teto diário de uso da IA atingido' });

  // sem chave da OpenAI: nada acontece (e o teste do painel avisa)
  const rtNoKey = createAiRuntime({ pool: h.app, getChannel: () => channel, notify() {}, openai: { configured: false }, config: {}, debounceMs: 0, typingMs: () => 0, log: { error() {} } });
  assert.deepEqual(await rtNoKey.handle({ tenantId: tenantA, conversationId: c5 }), { skipped: 'sem chave da OpenAI' });

  // o painel passa a mostrar a IA na tabela de desempenho
  const dash = await call('/api/dashboard', { token: admin });
  assert.ok(dash.periods.month.team.some((r) => r.name === 'Agente de IA' && r.isBot && r.conversations >= 1), 'linha do Agente de IA no dashboard');

  // remover documento
  assert.equal((await call(`/api/ai-agent/docs/${doc.doc.id}`, { method: 'DELETE', token: admin })).ok, true);
  assert.equal((await call(`/api/ai-agent/docs/${doc.doc.id}`, { method: 'DELETE', token: admin })).status, 404);
});

test('convite: o link usa o endereço do próprio site (APP_URL velho não quebra) e ignora origem estranha', { skip }, async () => {
  const admin = await login('admin@a.com.br');
  const invite = async (email, origin) => {
    const res = await fetch(`${base}/api/users/invite`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${admin}`, ...(origin ? { origin } : {}) }, body: JSON.stringify({ email, name: 'Teste Link', roleId: 'role_agent' }) });
    return (await res.json()).inviteUrl;
  };
  assert.match(await invite('link1@a.com.br'), /^http:\/\/app\.test\/#\/accept\?token=/, 'sem Origin: vale o APP_URL');
  assert.match(await invite('link2@a.com.br', base), new RegExp(`^${base.replace(/[.]/g, '\\.')}/#/accept\\?token=`), 'Origin do próprio site: vale o endereço em uso');
  assert.match(await invite('link3@a.com.br', 'https://site-malicioso.example'), /^http:\/\/app\.test\/#\/accept\?token=/, 'Origin estranha é ignorada');
});

test('tarefas: criar, vincular, concluir, delegar, compartilhar, comentar e excluir (cada um só vê o que pode)', { skip }, async () => {
  const admin = await login('admin@a.com.br');
  const ana = await login('ana@a.com.br');
  const bia = await login('bia@a.com.br');
  const biaId = (await call('/api/bootstrap', { token: bia })).users.find((u) => u.email === 'bia@a.com.br').id;
  const anaId = (await call('/api/bootstrap', { token: ana })).users.find((u) => u.email === 'ana@a.com.br').id;
  const tasksOf = async (token) => (await call('/api/bootstrap', { token })).tasks;
  const boot = await call('/api/bootstrap', { token: admin });
  const pipe = boot.pipelines[0];
  const anaPost = (body) => call('/api/tasks', { method: 'POST', token: ana, body });

  // ---- validação
  assert.equal((await anaPost({ title: '  ' })).status, 400);
  assert.equal((await anaPost({ title: 'x', priority: 'altíssima' })).status, 400);
  assert.equal((await anaPost({ title: 'x', status: 'quase' })).status, 400);
  assert.equal((await anaPost({ title: 'x', dueAt: 'ontem à noite' })).status, 400);
  assert.equal((await anaPost({ title: 'x', checklist: [{ text: '' }] })).status, 400);
  assert.equal((await call('/api/tasks', { method: 'POST', body: { title: 'x' } })).status, 401);

  // ---- avulsa: só a dona vê; defaults
  const due = Date.now() + 3 * 86400000;
  const solta = (await anaPost({ title: 'Ligar para o fornecedor', description: 'Pedir prazo', priority: 'high', dueAt: due, dueHasTime: true, checklist: [{ text: 'Levantar CNPJ' }, { text: 'Anotar proposta', done: true }] })).task;
  assert.equal(solta.status, 'todo');
  assert.equal(solta.ownerId, anaId);
  assert.equal(solta.createdBy, anaId);
  assert.equal(solta.priority, 'high');
  assert.equal(solta.dueHasTime, true);
  assert.equal(Math.abs(solta.dueAt - due) < 1000, true);
  assert.deepEqual(solta.checklist.map((i) => [i.text, i.done]), [['Levantar CNPJ', false], ['Anotar proposta', true]]);
  assert.ok((await tasksOf(ana)).some((t) => t.id === solta.id));
  assert.ok(!(await tasksOf(bia)).some((t) => t.id === solta.id), 'a tarefa de outra pessoa não aparece');
  assert.ok((await tasksOf(admin)).some((t) => t.id === solta.id), 'o admin vê todas');

  // ---- vínculo com negócio (só se puder ler) e o contato vem junto
  const ct = (await call('/api/contacts', { method: 'POST', token: ana, body: { name: 'Cliente da tarefa', phone: '5511955560001' } })).contact;
  const deal = (await call('/api/deals', { method: 'POST', token: ana, body: { title: 'Negócio da tarefa', contactId: ct.id, pipelineId: pipe.id, stageId: pipe.stages[0].id } })).deal;
  const ligada = (await anaPost({ title: 'Enviar contrato', dealId: deal.id })).task;
  assert.equal(ligada.dealId, deal.id);
  assert.equal(ligada.contactId, ct.id, 'o contato do negócio vem junto');
  const biaDeal = (await call('/api/deals', { method: 'POST', token: bia, body: { title: 'Negócio da Bia', pipelineId: pipe.id, stageId: pipe.stages[0].id } })).deal;
  assert.equal((await anaPost({ title: 'Invasão', dealId: biaDeal.id })).status, 400, 'não vincula a negócio que não pode ler');
  assert.equal((await call(`/api/tasks/${solta.id}`, { method: 'PATCH', token: ana, body: { dealId: biaDeal.id } })).status, 400);
  const unlinked = await call(`/api/tasks/${ligada.id}`, { method: 'PATCH', token: ana, body: { dealId: null } });
  assert.equal(unlinked.task.dealId, null);

  // ---- editar e concluir (completedAt) e reabrir
  assert.equal((await call(`/api/tasks/${solta.id}`, { method: 'PATCH', token: bia, body: { title: 'sequestro' } })).status, 404);
  assert.equal((await call(`/api/tasks/${solta.id}`, { method: 'PATCH', token: ana, body: {} })).status, 400);
  const edited = await call(`/api/tasks/${solta.id}`, { method: 'PATCH', token: ana, body: { title: 'Ligar para o fornecedor X', status: 'waiting', priority: 'urgent' } });
  assert.equal(edited.task.title, 'Ligar para o fornecedor X');
  assert.equal(edited.task.status, 'waiting');
  assert.equal(edited.task.completedAt, null);
  const done = await call(`/api/tasks/${solta.id}`, { method: 'PATCH', token: ana, body: { status: 'done' } });
  assert.ok(done.task.completedAt, 'concluída: data de conclusão');
  assert.equal((await call(`/api/tasks/${solta.id}`, { method: 'PATCH', token: ana, body: { status: 'doing' } })).task.completedAt, null, 'reaberta: sem data de conclusão');
  const nodue = await call(`/api/tasks/${solta.id}`, { method: 'PATCH', token: ana, body: { dueAt: null } });
  assert.equal(nodue.task.dueAt, null);

  // ---- delegar: quem recebe passa a ver; quem delegou continua vendo (só leitura) e não delega de novo
  const delegated = await call(`/api/tasks/${ligada.id}/delegate`, { method: 'POST', token: ana, body: { ownerId: biaId } });
  assert.equal(delegated.task.ownerId, biaId);
  assert.equal(delegated.task.createdBy, anaId);
  assert.ok((await tasksOf(bia)).some((t) => t.id === ligada.id), 'a Bia recebeu a tarefa');
  assert.ok((await tasksOf(ana)).some((t) => t.id === ligada.id), 'a Ana continua vendo o que delegou');
  assert.equal((await call(`/api/tasks/${ligada.id}`, { method: 'PATCH', token: ana, body: { title: 'não é mais minha' } })).status, 403, 'só leitura para quem delegou');
  assert.equal((await call(`/api/tasks/${ligada.id}/delegate`, { method: 'POST', token: ana, body: { ownerId: anaId } })).status, 403, 'quem só enxerga não retoma sozinho');
  assert.equal((await call(`/api/tasks/${ligada.id}/delegate`, { method: 'POST', token: bia, body: { ownerId: biaId } })).status, 400, 'já é dela');
  assert.equal((await call(`/api/tasks/${ligada.id}/delegate`, { method: 'POST', token: bia, body: { ownerId: '00000000-0000-4000-8000-000000000000' } })).status, 400, 'responsável inexistente');
  assert.equal((await call(`/api/tasks/${ligada.id}`, { method: 'PATCH', token: bia, body: { status: 'doing' } })).task.status, 'doing', 'a nova responsável edita');

  // ---- criar já delegando
  const forBia = (await anaPost({ title: 'Conferir estoque', ownerId: biaId })).task;
  assert.equal(forBia.ownerId, biaId);
  assert.equal(forBia.createdBy, anaId);
  assert.ok((await tasksOf(bia)).some((t) => t.id === forBia.id));

  // ---- comentários e histórico (quem enxerga, comenta; quem não enxerga, não)
  const posted = await call(`/api/tasks/${ligada.id}/comments`, { method: 'POST', token: bia, body: { text: 'Contrato enviado, aguardando assinatura' } });
  assert.equal(posted.comment.kind, 'comment');
  assert.equal(posted.comment.authorId, biaId);
  assert.equal((await call(`/api/tasks/${ligada.id}/comments`, { method: 'POST', token: bia, body: { text: ' ' } })).status, 400);
  const thread = (await call(`/api/tasks/${ligada.id}/comments`, { token: ana })).comments;
  assert.ok(thread.some((c) => c.kind === 'event' && /delegou a tarefa para/.test(c.text)), 'o histórico registra a delegação');
  assert.ok(thread.some((c) => c.kind === 'comment' && /aguardando assinatura/.test(c.text)));
  assert.equal((await call(`/api/tasks/${solta.id}/comments`, { token: bia })).status, 404, 'não lê a conversa de tarefa que não vê');
  assert.ok((await call(`/api/tasks/${solta.id}/comments`, { token: ana })).comments.some((c) => c.kind === 'event' && /marcou como feita/.test(c.text)));

  // ---- compartilhar: leitura não edita; edição edita; remover tira
  const sharedWith = await call(`/api/tasks/${solta.id}/shares`, { method: 'POST', token: ana, body: { type: 'user', id: biaId, level: 'read' } });
  assert.deepEqual(sharedWith.sharedWith, [{ type: 'user', id: biaId, level: 'read' }]);
  assert.ok((await tasksOf(bia)).some((t) => t.id === solta.id), 'a Bia vê a tarefa compartilhada');
  assert.equal((await call(`/api/tasks/${solta.id}`, { method: 'PATCH', token: bia, body: { title: 'x' } })).status, 403, 'leitura não edita');
  assert.equal((await call(`/api/tasks/${solta.id}/shares`, { method: 'POST', token: bia, body: { type: 'user', id: anaId, level: 'edit' } })).status, 403, 'quem só lê não compartilha');
  await call(`/api/tasks/${solta.id}/shares`, { method: 'POST', token: ana, body: { type: 'user', id: biaId, level: 'edit' } });
  assert.equal((await call(`/api/tasks/${solta.id}`, { method: 'PATCH', token: bia, body: { priority: 'normal' } })).task.priority, 'normal', 'edição edita');
  assert.deepEqual((await call(`/api/tasks/${solta.id}/shares/user/${biaId}`, { method: 'DELETE', token: ana })).sharedWith, []);
  assert.ok(!(await tasksOf(bia)).some((t) => t.id === solta.id), 'descompartilhada: some');
  assert.equal((await call(`/api/tasks/${solta.id}/shares`, { method: 'POST', token: ana, body: { type: 'team', id: '00000000-0000-4000-8000-000000000000', level: 'read' } })).status, 400);

  // ---- tempo real: quem recebe uma tarefa é avisado
  const ws = await wsOpen((await call('/api/ws-ticket', { method: 'POST', token: bia })).ticket);
  const another = (await anaPost({ title: 'Aviso em tempo real', ownerId: biaId })).task;
  await settle(500);
  assert.ok(ws.events.some((e) => e.type === 'tasks' && e.taskId === another.id), 'a Bia recebeu o aviso de tarefa nova');
  ws.close();

  // ---- excluir: dona exclui a dela; outra pessoa nem enxerga; admin exclui qualquer
  assert.equal((await call(`/api/tasks/${solta.id}`, { method: 'DELETE', token: bia })).status, 404);
  assert.equal((await call(`/api/tasks/${solta.id}`, { method: 'DELETE', token: ana })).ok, true);
  assert.ok(!(await tasksOf(ana)).some((t) => t.id === solta.id));
  assert.equal((await call(`/api/tasks/${ligada.id}`, { method: 'DELETE', token: ana })).status, 403, 'quem só enxerga não exclui');
  assert.equal((await call(`/api/tasks/${ligada.id}`, { method: 'DELETE', token: admin })).ok, true);
  // apagar o negócio não apaga a tarefa (só desfaz o vínculo)
  const keep = (await anaPost({ title: 'Sobrevive ao negócio', dealId: deal.id })).task;
  assert.equal((await call(`/api/deals/${deal.id}`, { method: 'DELETE', token: admin })).ok, true);
  assert.equal((await tasksOf(ana)).find((t) => t.id === keep.id).dealId, null);
});

test('negócio: previsão de fechamento e atividade real (criar, alterar, mover, passar, compartilhar, proposta, tarefas)', { skip }, async () => {
  const admin = await login('admin@a.com.br');
  const ana = await login('ana@a.com.br');
  const bia = await login('bia@a.com.br');
  const biaId = (await call('/api/bootstrap', { token: bia })).users.find((u) => u.email === 'bia@a.com.br').id;
  const pipe = (await call('/api/bootstrap', { token: admin })).pipelines[0];
  const [s0, s1] = pipe.stages.filter((s) => s.kind === 'open');
  const prod = (await call('/api/products', { method: 'POST', token: admin, body: { name: 'Plano atividade', unit: 'mês', price: 100 } })).product;

  // ---- previsão de fechamento: só data válida
  assert.equal((await call('/api/deals', { method: 'POST', token: ana, body: { title: 'x', pipelineId: pipe.id, stageId: s0.id, expectedClose: '2026-02-31' } })).status, 400);
  assert.equal((await call('/api/deals', { method: 'POST', token: ana, body: { title: 'x', pipelineId: pipe.id, stageId: s0.id, expectedClose: '15/12/2026' } })).status, 400);
  const deal = (await call('/api/deals', { method: 'POST', token: ana, body: { title: 'Negócio com atividade', pipelineId: pipe.id, stageId: s0.id, expectedClose: '2026-12-15' } })).deal;
  assert.equal(deal.expectedClose, '2026-12-15');
  assert.equal((await call(`/api/deals/${deal.id}`, { method: 'PATCH', token: ana, body: { expectedClose: '2027-01-10' } })).deal.expectedClose, '2027-01-10');
  assert.equal((await call(`/api/deals/${deal.id}`, { method: 'PATCH', token: ana, body: { expectedClose: 'amanhã' } })).status, 400);
  assert.equal((await call(`/api/deals/${deal.id}`, { method: 'PATCH', token: ana, body: { expectedClose: null } })).deal.expectedClose, null);
  assert.equal((await call(`/api/deals/${deal.id}`, { method: 'PATCH', token: ana, body: { expectedClose: '2026-12-31' } })).deal.expectedClose, '2026-12-31');
  assert.equal((await call('/api/bootstrap', { token: ana })).deals.find((d) => d.id === deal.id).expectedClose, '2026-12-31', 'o bootstrap traz a data');

  // ---- gera atividade de vários tipos
  await call(`/api/deals/${deal.id}`, { method: 'PATCH', token: ana, body: { title: 'Negócio com atividade (v2)' } });
  await call(`/api/deals/${deal.id}`, { method: 'PATCH', token: ana, body: { items: [{ productId: prod.id, qty: 2 }] } });
  await call(`/api/deals/${deal.id}`, { method: 'PATCH', token: ana, body: { stageId: s1.id } });
  assert.equal((await call(`/api/deals/${deal.id}/activity`, { token: bia })).status, 404, 'quem não vê o negócio não vê a atividade');
  await call(`/api/deals/${deal.id}/shares`, { method: 'POST', token: ana, body: { type: 'user', id: biaId, level: 'read' } });
  const sentP = await call(`/api/deals/${deal.id}/proposal/send`, { method: 'POST', token: ana });
  assert.equal(sentP.result, 'no-chat', JSON.stringify(sentP));
  const taskRes = await call('/api/tasks', { method: 'POST', token: ana, body: { title: 'Ligar para fechar', dealId: deal.id } });
  assert.ok(taskRes.task, JSON.stringify(taskRes));
  const task = taskRes.task;
  await call(`/api/tasks/${task.id}`, { method: 'PATCH', token: ana, body: { status: 'done' } });
  // a dona vê tudo, inclusive as tarefas dela
  const feed = (await call(`/api/deals/${deal.id}/activity`, { token: ana })).activity;
  const texts = feed.map((a) => a.text);
  const has = (re, list = texts) => assert.ok(list.some((t) => re.test(t)), `faltou na atividade: ${re} — ${list.join(' | ')}`);
  has(/criou o negócio/);
  has(/alterou o título/);
  has(/alterou a proposta/);
  has(/alterou a previsão de fechamento/);
  has(new RegExp(`moveu de ${s0.name} para ${s1.name}`));
  has(/compartilhou com .* \(leitura\)/);
  has(/registrou o envio da proposta/);
  has(/criou a tarefa “Ligar para fechar”/);
  has(/concluiu a tarefa “Ligar para fechar”/);
  assert.deepEqual(feed.map((a) => a.at), [...feed.map((a) => a.at)].sort((a, b) => b - a), 'mais recente primeiro');
  // a Bia (compartilhada) vê os eventos do negócio, mas NÃO as tarefas da Ana (que ela não pode ler)
  const biaTexts = (await call(`/api/deals/${deal.id}/activity`, { token: bia })).activity.map((a) => a.text);
  has(/moveu de/, biaTexts);
  assert.ok(!biaTexts.some((t) => /tarefa/.test(t)), 'tarefa que a pessoa não lê não vaza pela atividade');
  // passar o negócio para a Bia: aparece no feed dela
  assert.equal((await call(`/api/deals/${deal.id}`, { method: 'PATCH', token: admin, body: { ownerId: biaId } })).deal.ownerId, biaId);
  has(/passou o negócio para/, (await call(`/api/deals/${deal.id}/activity`, { token: bia })).activity.map((a) => a.text));
  assert.ok(feed.every((a) => a.id && a.kind && a.at), 'itens completos');
});

test('meta do mês: só quem altera configurações grava; chega no bootstrap na hora; valida o valor e não vaza entre empresas', { skip }, async () => {
  const admin = await login('admin@a.com.br');
  const ana = await login('ana@a.com.br');
  const adminB = await login('admin@b.com.br');
  assert.deepEqual((await call('/api/bootstrap', { token: admin })).tenant.goals, {}, 'sem meta no começo');
  const put = (token, body) => call('/api/tenant/goals', { method: 'PATCH', token, body });
  // quem não altera configurações é recusado e nada muda
  assert.equal((await put(ana, { monthlyRevenue: 5 })).status, 403);
  assert.deepEqual((await call('/api/bootstrap', { token: admin })).tenant.goals, {});
  // admin grava (arredonda em centavos) e todos da empresa leem a meta nova no bootstrap seguinte
  const r = await put(admin, { monthlyRevenue: 120000.456 });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.goals.monthlyRevenue, 120000.46);
  assert.equal((await call('/api/bootstrap', { token: admin })).tenant.goals.monthlyRevenue, 120000.46);
  assert.equal((await call('/api/bootstrap', { token: ana })).tenant.goals.monthlyRevenue, 120000.46, 'o atendente vê a meta da empresa (só não altera)');
  // a política de segurança que já existia em settings continua intacta
  const settings = (await h.admin.query('SELECT settings FROM tenants WHERE id = $1', [tenantA])).rows[0].settings;
  assert.equal(settings.goals.monthlyRevenue, 120000.46);
  // valores inválidos
  for (const bad of [-1, 'abc', 1e11, {}]) assert.equal((await put(admin, { monthlyRevenue: bad })).status, 400, `inválido: ${JSON.stringify(bad)}`);
  assert.equal((await call('/api/bootstrap', { token: admin })).tenant.goals.monthlyRevenue, 120000.46, 'inválido não altera');
  // outra empresa não herda nem enxerga
  assert.deepEqual((await call('/api/bootstrap', { token: adminB })).tenant.goals, {});
  // zero ou vazio remove a meta
  assert.equal((await put(admin, { monthlyRevenue: 0 })).goals.monthlyRevenue, null);
  assert.equal((await call('/api/bootstrap', { token: admin })).tenant.goals.monthlyRevenue, null);
  assert.equal((await put(admin, { monthlyRevenue: '' })).goals.monthlyRevenue, null);
  // fica na auditoria
  const audited = (await h.admin.query("SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND action = 'tenant.goals'", [tenantA])).rows[0].n;
  assert.ok(audited >= 3, `auditoria da meta: ${audited}`);
});

test('funis configuráveis: criar, renomear, editar etapas (probabilidade, ordem), travas com negócios e motivos de perda', { skip }, async () => {
  const admin = await login('admin@a.com.br');
  const ana = await login('ana@a.com.br');
  const adminB = await login('admin@b.com.br');
  const boot = () => call('/api/bootstrap', { token: admin });
  const post = (path, token, body, method = 'POST') => call(path, { method, token, body });

  // o que já existia ganhou probabilidade (ganho 100, perdido 0, abertas espalhadas)
  const comercial = (await boot()).pipelines.find((p) => p.name === 'Comercial');
  assert.deepEqual(comercial.stages.map((st) => [st.kind, st.probability]), [['open', 33], ['open', 67], ['won', 100], ['lost', 0]]);

  // quem não tem a permissão é recusado em tudo
  assert.equal((await post('/api/pipelines', ana, { name: 'Do atendente' })).status, 403);
  assert.equal((await post(`/api/pipelines/${comercial.id}`, ana, { name: 'X' }, 'PATCH')).status, 403);
  assert.equal((await post(`/api/pipelines/${comercial.id}/stages`, ana, { stages: [] }, 'PUT')).status, 403);
  assert.equal((await post(`/api/pipelines/${comercial.id}`, ana, null, 'DELETE')).status, 403);
  assert.equal((await post('/api/loss-reasons', ana, { reasons: ['A'] }, 'PUT')).status, 403);

  // criar com etapas padrão
  const created = await post('/api/pipelines', admin, { name: 'Pós-venda' });
  assert.equal(created.status, 200, JSON.stringify(created));
  const pv = created.pipeline;
  assert.deepEqual(pv.stages.map((st) => [st.name, st.kind, st.probability]), [['Novo', 'open', 25], ['Qualificação', 'open', 50], ['Proposta', 'open', 75], ['Ganho', 'won', 100], ['Perdido', 'lost', 0]]);
  assert.ok((await boot()).pipelines.some((p) => p.id === pv.id && p.stages.length === 5));
  assert.equal((await post('/api/pipelines', admin, { name: '  pós-venda ' })).status, 409, 'nome repetido (sem diferenciar caixa)');
  assert.equal((await post('/api/pipelines', admin, { name: '   ' })).status, 400);

  // renomear
  assert.equal((await post(`/api/pipelines/${pv.id}`, admin, { name: 'Sucesso do cliente' }, 'PATCH')).pipeline.name, 'Sucesso do cliente');
  assert.equal((await post(`/api/pipelines/${comercial.id}`, admin, { name: 'sucesso do cliente' }, 'PATCH')).status, 409);

  // etapas: renomear, reordenar, acrescentar, mudar probabilidade; ganho/perdido são forçados a 100/0
  const [n, q, pr, w, l] = pv.stages;
  const edited = await post(`/api/pipelines/${pv.id}/stages`, admin, { stages: [{ id: q.id, name: 'Em análise', kind: 'open', probability: 40 }, { id: n.id, name: 'Novo contato', kind: 'open', probability: 10 }, { name: 'Reunião', kind: 'open', probability: 60.4 }, { id: pr.id, name: 'Proposta enviada', kind: 'open', probability: 80 }, { id: w.id, name: 'Fechado', kind: 'won', probability: 50 }, { id: l.id, name: 'Perdido', kind: 'lost', probability: 30 }] }, 'PUT');
  assert.equal(edited.status, 200, JSON.stringify(edited));
  assert.deepEqual(edited.pipeline.stages.map((st) => [st.name, st.kind, st.probability]), [['Em análise', 'open', 40], ['Novo contato', 'open', 10], ['Reunião', 'open', 60], ['Proposta enviada', 'open', 80], ['Fechado', 'won', 100], ['Perdido', 'lost', 0]]);
  assert.equal(edited.pipeline.stages[0].id, q.id, 'a etapa mantém o id (negócios continuam ligados)');
  const stageIds = edited.pipeline.stages.map((st) => st.id);

  // validações
  const put = (stages) => post(`/api/pipelines/${pv.id}/stages`, admin, { stages }, 'PUT');
  const ok = (extra = {}) => ({ id: stageIds[0], name: 'A', kind: 'open', probability: 10, ...extra });
  assert.equal((await put([ok(), { name: 'B', kind: 'won' }])).status, 400, 'menos de 3 etapas');
  assert.equal((await put([ok(), { id: stageIds[1], name: 'B', kind: 'open', probability: 5 }, { id: stageIds[4], name: 'C', kind: 'won' }])).status, 400, 'sem etapa perdida');
  assert.equal((await put([ok(), { id: stageIds[4], name: 'C', kind: 'won' }, { id: stageIds[5], name: 'D', kind: 'lost' }, { name: 'E', kind: 'open', probability: 101 }])).status, 400, 'probabilidade acima de 100');
  assert.equal((await put([ok(), ok(), { id: stageIds[4], name: 'C', kind: 'won' }, { id: stageIds[5], name: 'D', kind: 'lost' }])).status, 400, 'etapa repetida');
  assert.equal((await put([ok({ id: comercial.stages[0].id }), { id: stageIds[4], name: 'C', kind: 'won' }, { id: stageIds[5], name: 'D', kind: 'lost' }])).status, 400, 'etapa de outro funil');
  assert.equal((await put([ok({ kind: 'nada' }), { id: stageIds[4], name: 'C', kind: 'won' }, { id: stageIds[5], name: 'D', kind: 'lost' }])).status, 400, 'tipo inválido');

  // com negócio na etapa: não remove nem muda o tipo; depois de mover, pode
  const deal = (await post('/api/deals', admin, { title: 'Negócio no funil novo', pipelineId: pv.id, stageId: stageIds[1], value: 100 })).deal;
  const keepAll = (over) => edited.pipeline.stages.map((st, i) => ({ id: st.id, name: st.name, kind: st.kind, probability: st.probability, ...(over[i] || {}) }));
  const noStage1 = keepAll({}).filter((st) => st.id !== stageIds[1]);
  const r409 = await put(noStage1);
  assert.equal(r409.status, 409);
  assert.match(r409.error || r409.message || '', /“Novo contato” tem 1 negócio/);
  assert.equal((await put(keepAll({ 1: { kind: 'won' } }))).status, 409, 'tipo não muda com negócio na etapa');
  assert.equal((await put(keepAll({ 1: { name: 'Contato inicial', probability: 20 } }))).status, 200, 'nome e probabilidade mudam à vontade');
  assert.equal((await call(`/api/deals/${deal.id}`, { method: 'PATCH', token: admin, body: { stageId: stageIds[0] } })).deal.stageId, stageIds[0]);
  assert.equal((await put(noStage1.map((st) => (st.id === stageIds[1] ? st : st)))).status, 200, 'sem negócio, a etapa sai');

  // motivos de perda
  const reasons = (list) => post('/api/loss-reasons', admin, { reasons: list }, 'PUT');
  assert.equal((await reasons(['Preço', 'preço'])).status, 400, 'repetido');
  assert.equal((await reasons(['x'.repeat(81)])).status, 400);
  const saved = await reasons(['Preço', 'Escolheu concorrente', 'Sem resposta']);
  assert.deepEqual(saved.lossReasons.map((x) => x.name), ['Preço', 'Escolheu concorrente', 'Sem resposta']);
  assert.deepEqual((await boot()).lossReasons.map((x) => x.name), ['Preço', 'Escolheu concorrente', 'Sem resposta']);
  assert.deepEqual((await call('/api/bootstrap', { token: ana })).lossReasons.map((x) => x.name), ['Preço', 'Escolheu concorrente', 'Sem resposta'], 'quem lê negócios recebe a lista');
  assert.deepEqual((await call('/api/bootstrap', { token: adminB })).lossReasons, [], 'outra empresa não herda');
  const lostId = (await boot()).pipelines.find((p) => p.id === pv.id).stages.find((st) => st.kind === 'lost').id;
  const lose = (body) => call(`/api/deals/${deal.id}`, { method: 'PATCH', token: admin, body: { stageId: lostId, ...body } });
  assert.equal((await lose({})).status, 400, 'perder exige o motivo');
  assert.equal((await lose({ lostReason: 'Porque sim' })).status, 400, 'motivo fora da lista');
  const lost = await lose({ lostReason: 'Preço' });
  assert.equal(lost.status, 200, JSON.stringify(lost));
  assert.equal(lost.deal.lostReason, 'Preço');
  assert.equal(lost.deal.status, 'lost');
  assert.ok((await call(`/api/deals/${deal.id}/activity`, { token: admin })).activity.some((a) => /moveu de .* para Perdido \(motivo: Preço\)/.test(a.text)), 'o motivo aparece na atividade');
  const reopened = await call(`/api/deals/${deal.id}`, { method: 'PATCH', token: admin, body: { stageId: stageIds[0] } });
  assert.equal(reopened.deal.lostReason, null, 'reabrir limpa o motivo');
  assert.equal((await reasons([])).lossReasons.length, 0);
  assert.equal((await lose({})).status, 200, 'sem lista configurada o motivo é opcional');
  assert.equal((await call(`/api/deals/${deal.id}`, { method: 'PATCH', token: admin, body: { stageId: stageIds[0] } })).status, 200);

  // isolamento: a outra empresa não enxerga nem altera o funil
  assert.equal((await post(`/api/pipelines/${pv.id}`, adminB, { name: 'Invasão' }, 'PATCH')).status, 404);
  assert.equal((await post(`/api/pipelines/${pv.id}/stages`, adminB, { stages: edited.pipeline.stages }, 'PUT')).status, 404);
  assert.equal((await post(`/api/pipelines/${pv.id}`, adminB, null, 'DELETE')).status, 404);

  // excluir: com negócio não; sem negócio sim
  const del409 = await post(`/api/pipelines/${pv.id}`, admin, null, 'DELETE');
  assert.equal(del409.status, 409);
  assert.match(del409.error || del409.message || '', /tem 1 negócio/);
  assert.equal((await call(`/api/deals/${deal.id}`, { method: 'DELETE', token: admin })).status, 200);
  assert.equal((await post(`/api/pipelines/${pv.id}`, admin, null, 'DELETE')).status, 200);
  assert.ok(!(await boot()).pipelines.some((p) => p.id === pv.id));

  // a empresa não fica sem funil nenhum
  let left = (await call('/api/bootstrap', { token: adminB })).pipelines;
  assert.ok(left.length >= 1);
  while (left.length > 1) {
    assert.equal((await post(`/api/pipelines/${left[0].id}`, adminB, null, 'DELETE')).status, 200);
    left = left.slice(1);
  }
  const last = await post(`/api/pipelines/${left[0].id}`, adminB, null, 'DELETE');
  assert.equal(last.status, 409);
  assert.match(last.error || last.message || '', /pelo menos um funil/);
  const audited = (await h.admin.query("SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND action LIKE 'pipeline.%'", [tenantA])).rows[0].n;
  assert.ok(audited >= 6, `auditoria dos funis: ${audited}`);
});

test('chat interno: conversa direta única, grupos, só participantes leem, não lidas, tempo real só para quem participa', { skip }, async () => {
  const admin = await login('admin@a.com.br');
  const ana = await login('ana@a.com.br');
  const bia = await login('bia@a.com.br');
  const adminB = await login('admin@b.com.br');
  const users = (await call('/api/bootstrap', { token: admin })).users;
  const id = (email) => users.find((u) => u.email === email)?.id;
  const [adminId, anaId, biaId] = [id('admin@a.com.br'), id('ana@a.com.br'), id('bia@a.com.br')];
  assert.ok(adminId && anaId && biaId);
  const post = (path, token, body, method = 'POST') => call(path, { method, token, body });

  const wsAdmin = await wsOpen((await call('/api/ws-ticket', { method: 'POST', token: admin })).ticket);
  const wsAna = await wsOpen((await call('/api/ws-ticket', { method: 'POST', token: ana })).ticket);
  const wsBia = await wsOpen((await call('/api/ws-ticket', { method: 'POST', token: bia })).ticket);

  // conversa direta: uma sala por par (idempotente, qualquer um dos dois lados abre a mesma)
  const dm = await post('/api/chat/rooms', admin, { userId: anaId });
  assert.equal(dm.status, 200, JSON.stringify(dm));
  assert.equal(dm.room.kind, 'dm');
  assert.deepEqual([...dm.room.members].sort(), [adminId, anaId].sort());
  assert.equal((await post('/api/chat/rooms', admin, { userId: anaId })).room.id, dm.room.id, 'mesma sala');
  assert.equal((await post('/api/chat/rooms', ana, { userId: adminId })).room.id, dm.room.id, 'do outro lado também');
  assert.equal((await post('/api/chat/rooms', admin, { userId: adminId })).status, 400, 'não conversa consigo mesmo');
  assert.equal((await post('/api/chat/rooms', admin, { userId: '00000000-0000-4000-8000-000000000000' })).status, 400, 'pessoa que não existe');
  assert.equal((await post('/api/chat/rooms', admin, { userId: id('ana@a.com.br').replace(/.$/, 'x') })).status, 400, 'id malformado');

  // mensagens: validação, ordem e tempo real SÓ para os dois
  const send = (token, room, body) => post(`/api/chat/rooms/${room}/messages`, token, { body });
  assert.equal((await send(admin, dm.room.id, '   ')).status, 400);
  assert.equal((await send(admin, dm.room.id, 'x'.repeat(4001))).status, 400);
  wsAdmin.events.length = 0;
  wsAna.events.length = 0;
  wsBia.events.length = 0;
  const m1 = await send(admin, dm.room.id, 'Oi, Ana! Tudo certo com o cliente?');
  assert.equal(m1.status, 200, JSON.stringify(m1));
  assert.equal(m1.message.authorId, adminId);
  await settle();
  assert.equal(wsAna.events.some((e) => e.type === 'chat' && e.kind === 'message' && e.message.body.startsWith('Oi, Ana')), true, 'a Ana recebe na hora');
  assert.equal(wsBia.events.some((e) => e.type === 'chat'), false, 'a Bia não participa: nada chega');
  await send(ana, dm.room.id, 'Tudo! Mando a proposta hoje.');
  const msgs = (await call(`/api/chat/rooms/${dm.room.id}/messages`, { token: admin })).messages;
  assert.deepEqual(msgs.map((m) => m.authorId), [adminId, anaId]);

  // não lidas: quem escreveu não tem; quem recebeu, sim, até abrir (marcar como lida)
  const roomOf = async (token, rid) => (await call('/api/chat/rooms', { token })).rooms.find((r) => r.id === rid);
  assert.equal((await roomOf(admin, dm.room.id)).unread, 1, 'o admin tem a resposta da Ana não lida');
  assert.equal((await roomOf(ana, dm.room.id)).unread, 0, 'a Ana já leu o que escreveu');
  assert.equal((await roomOf(admin, dm.room.id)).lastBody, 'Tudo! Mando a proposta hoje.');
  assert.equal((await post(`/api/chat/rooms/${dm.room.id}/read`, admin)).ok, true);
  assert.equal((await roomOf(admin, dm.room.id)).unread, 0);

  // quem não participa não lê, não escreve, não marca e nem sabe que existe (nem o Admin de outra empresa)
  assert.equal((await call(`/api/chat/rooms/${dm.room.id}/messages`, { token: bia })).status, 404);
  assert.equal((await send(bia, dm.room.id, 'intrometida')).status, 404);
  assert.equal((await post(`/api/chat/rooms/${dm.room.id}/read`, bia)).status, 404);
  assert.equal((await post(`/api/chat/rooms/${dm.room.id}/members`, bia, { userIds: [biaId] })).status, 404);
  assert.equal((await call('/api/chat/rooms', { token: bia })).rooms.some((r) => r.id === dm.room.id), false);
  assert.equal((await call(`/api/chat/rooms/${dm.room.id}/messages`, { token: adminB })).status, 404);
  assert.equal((await post('/api/chat/rooms', adminB, { userId: anaId })).status, 400, 'pessoa de outra empresa não existe para mim');

  // grupo
  assert.equal((await post('/api/chat/rooms', admin, { name: '', userIds: [anaId] })).status, 400, 'sem nome');
  assert.equal((await post('/api/chat/rooms', admin, { name: 'Sozinho', userIds: [] })).status, 400, 'sem ninguém');
  const g = await post('/api/chat/rooms', admin, { name: '  Comercial   time ', userIds: [anaId, anaId] });
  assert.equal(g.status, 200, JSON.stringify(g));
  assert.equal(g.room.name, 'Comercial time');
  assert.deepEqual([...g.room.members].sort(), [adminId, anaId].sort());
  wsAna.events.length = 0;
  wsBia.events.length = 0;
  assert.equal((await send(ana, g.room.id, 'Bom dia, time!')).status, 200);
  await settle();
  assert.equal(wsBia.events.some((e) => e.type === 'chat'), false, 'Bia ainda não está no grupo');
  // a Ana convida a Bia: a sala aparece para ela e ela passa a ler e escrever
  const added = await post(`/api/chat/rooms/${g.room.id}/members`, ana, { userIds: [biaId] });
  assert.equal(added.status, 200, JSON.stringify(added));
  await settle();
  assert.equal(wsBia.events.some((e) => e.type === 'chat' && e.kind === 'room'), true, 'a sala aparece na hora para quem entrou');
  assert.equal((await call(`/api/chat/rooms/${g.room.id}/messages`, { token: bia })).messages.length, 1, 'quem entra lê o histórico do grupo');
  assert.equal((await send(bia, g.room.id, 'Cheguei!')).status, 200);
  assert.equal((await post(`/api/chat/rooms/${dm.room.id}/members`, admin, { userIds: [biaId] })).status, 409, 'conversa direta não aceita mais gente');
  assert.equal((await post(`/api/chat/rooms/${g.room.id}/members`, admin, { userIds: [adminB && '00000000-0000-4000-8000-000000000000'] })).status, 400);

  // histórico em páginas
  const old = (await call(`/api/chat/rooms/${g.room.id}/messages?before=1`, { token: admin })).messages;
  assert.equal(old.length, 0, 'antes de 1970 não há nada');
  wsAdmin.close();
  wsAna.close();
  wsBia.close();
  const audited = (await h.admin.query("SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND action LIKE 'chat.%'", [tenantA])).rows[0].n;
  assert.ok(audited >= 2, `auditoria do chat: ${audited}`);
});

test('perfil: cada pessoa edita o PRÓPRIO nome, cargo, telefone e sobre; valida; os outros veem o nome novo', { skip }, async () => {
  const ana = await login('ana@a.com.br');
  const admin = await login('admin@a.com.br');
  const patch = (token, body) => call('/api/me', { method: 'PATCH', token, body });
  assert.equal((await patch(ana, {})).status, 400, 'nada para alterar');
  assert.equal((await patch(ana, { name: '   ' })).status, 400);
  assert.equal((await patch(ana, { name: 'x'.repeat(201) })).status, 400);
  assert.equal((await patch(ana, { phone: 'abc' })).status, 400);
  assert.equal((await patch(ana, { bio: 'x'.repeat(301) })).status, 400);
  assert.equal((await patch(ana, { jobTitle: 'x'.repeat(81) })).status, 400);
  const r = await patch(ana, { name: '  Ana   Paula Souza ', jobTitle: 'Executiva de contas', phone: '+55 (11) 98888-7777', bio: 'Atendo clientes do Sudeste.' });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.deepEqual(r.me, { id: r.me.id, name: 'Ana Paula Souza', jobTitle: 'Executiva de contas', phone: '+55 (11) 98888-7777', bio: 'Atendo clientes do Sudeste.' });
  // não consegue mexer em e-mail, perfil de acesso, status nem em outra pessoa (campos fora da lista são ignorados)
  const before = (await call('/api/bootstrap', { token: admin })).users.find((u) => u.id === r.me.id);
  assert.equal((await patch(ana, { email: 'novo@a.com.br', status: 'suspended', roleIds: ['role_admin'], id: before.id.replace(/.$/, '0') })).status, 400, 'só campos desconhecidos = nada para alterar');
  const adminView = (await call('/api/bootstrap', { token: admin })).users.find((u) => u.id === r.me.id);
  assert.equal(adminView.name, 'Ana Paula Souza');
  assert.equal(adminView.jobTitle, 'Executiva de contas');
  assert.equal(adminView.email, 'ana@a.com.br');
  assert.equal(adminView.status, 'active');
  assert.deepEqual(adminView.roleIds, before.roleIds);
  // o telefone é privado: quem não lê usuários nem é a própria pessoa não recebe
  const bia = await login('bia@a.com.br');
  assert.equal((await call('/api/bootstrap', { token: bia })).users.find((u) => u.id === r.me.id).phone, '');
  assert.equal((await call('/api/bootstrap', { token: ana })).users.find((u) => u.id === r.me.id).phone, '+55 (11) 98888-7777');
  assert.equal(adminView.phone, '+55 (11) 98888-7777', 'admin lê usuários');
  // campo vazio limpa
  const cleared = await patch(ana, { jobTitle: '', bio: '' });
  assert.equal(cleared.me.jobTitle, '');
  assert.equal(cleared.me.bio, '');
  assert.equal((await call('/api/me', { method: 'PATCH', body: { name: 'x' } })).status, 401, 'sem login não edita');
});
