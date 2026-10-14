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
  try { await c.query(fs.readFileSync(path.join(repoRoot, 'db', 'migrations', '0002_pilot.sql'), 'utf8')); await c.query(fs.readFileSync(path.join(repoRoot, 'db', 'migrations', '0003_personal_instances.sql'), 'utf8')); } finally { c.release(); }
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
