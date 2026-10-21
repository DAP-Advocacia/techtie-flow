// Fumaça do servidor REAL (src/server.js) em modo operação: sobe o processo com banco, WebSocket e
// o canal Baileys carregado (sem conectar nenhum número) e exercita o caminho login → bootstrap.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { detectEnv, startPostgres, repoRoot, APP_PW } from '../permissions-sql/_harness.mjs';

const env = await detectEnv();
const skip = env.skip || false;
let h, proc, base, tmp;
const logs = [];

const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const until = async (fn, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = await fn(); if (v) return v; } catch { /* tenta de novo */ } await new Promise((r) => setTimeout(r, 250)); } throw new Error('timeout\n' + logs.join('')); };

before(async () => {
  if (skip) return;
  h = await startPostgres(env.pg, 'srv');
  const c = await h.admin.connect();
  try { await c.query(fs.readFileSync(path.join(repoRoot, 'db', 'migrations', '0002_pilot.sql'), 'utf8')); await c.query(fs.readFileSync(path.join(repoRoot, 'db', 'migrations', '0003_personal_instances.sql'), 'utf8')); await c.query(fs.readFileSync(path.join(repoRoot, 'db', 'migrations', '0004_crm_ai.sql'), 'utf8')); await c.query(fs.readFileSync(path.join(repoRoot, 'db', 'migrations', '0005_tasks.sql'), 'utf8')); } finally { c.release(); }
  const direct = `postgres://postgres:${h.admin.options.password}@127.0.0.1:${h.port}/postgres`;
  const r = spawnSync(process.execPath, [path.join(repoRoot, 'db', 'seed.mjs')], { env: { ...process.env, DIRECT_URL: direct, SEED_TENANT_NAME: 'Smoke', SEED_TENANT_SLUG: 'smoke', SEED_ADMIN_NAME: 'Admin', SEED_ADMIN_EMAIL: 'admin@smoke.com.br', SEED_ADMIN_PASSWORD: 'senha-de-teste-longa' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ttf-smoke-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, [path.join(repoRoot, 'src', 'server.js')], {
    cwd: tmp, // sem .env do projeto: só o ambiente abaixo vale
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PORT: String(port), DATABASE_URL: `postgres://app_user:${APP_PW}@127.0.0.1:${h.port}/postgres`, AUTH_TOKEN_SECRET: 'x'.repeat(48), AUTH_FOLDER: path.join(tmp, 'auth'), MEDIA_FOLDER: path.join(tmp, 'media'), WHATSAPP_ENABLED: 'true' },
  });
  proc.stdout.on('data', (d) => logs.push(String(d)));
  proc.stderr.on('data', (d) => logs.push(String(d)));
  await until(async () => (await fetch(`${base}/api/health`)).ok);
});
after(async () => {
  if (proc) { proc.kill(); await new Promise((r) => proc.on('exit', r)); }
  if (h) await h.dispose();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

test('servidor em modo operação: config do front, estáticos, login e bootstrap', { skip }, async () => {
  assert.match(logs.join(''), /operação \(API \+ WebSocket \+ WhatsApp\)/);
  assert.match(await (await fetch(`${base}/config.js`)).text(), /live: true/);
  assert.equal((await fetch(`${base}/`)).status, 200); // o front continua sendo servido
  assert.equal((await fetch(`${base}/shared/permissions/index.js`)).status, 200);
  assert.equal((await fetch(`${base}/api/me`)).status, 401);
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@smoke.com.br', password: 'senha-de-teste-longa' }) });
  assert.equal(login.status, 200);
  const { token } = await login.json();
  const boot = await (await fetch(`${base}/api/bootstrap`, { headers: { authorization: `Bearer ${token}` } })).json();
  assert.equal(boot.tenant.name, 'Smoke');
  assert.equal(boot.pipelines.length, 2);
  assert.equal(boot.users[0].roleIds[0], 'role_admin');
  assert.doesNotMatch(logs.join(''), /Error|erro interno/i);
});

test('servidor SEM banco continua sendo só o protótipo (config demo, sem /api)', { skip }, async () => {
  const port = await freePort();
  const p = spawn(process.execPath, [path.join(repoRoot, 'src', 'server.js')], { cwd: tmp, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PORT: String(port) } });
  try {
    await until(async () => (await fetch(`http://127.0.0.1:${port}/healthz`)).ok);
    assert.match(await (await fetch(`http://127.0.0.1:${port}/config.js`)).text(), /live: false/);
    const noApi = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.match(noApi.headers.get('content-type'), /text\/html/, 'sem API: /api/* cai no fallback do SPA, nunca devolve JSON de API');
  } finally {
    p.kill();
    await new Promise((r) => p.on('exit', r));
  }
});
