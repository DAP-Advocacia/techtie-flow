// Camada de banco do piloto (migração 0002 + seed + login), contra Postgres REAL em Docker.
// Pula sozinho quando não há Docker/pg (mesma regra de test/permissions-sql).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { detectEnv, startPostgres, repoRoot, APP_PW } from '../permissions-sql/_harness.mjs';

const require = createRequire(import.meta.url);
const { withTenant } = require('../../src/db-tenant.js');

const env = await detectEnv();
const skip = env.skip || false;
let h;
let tenantA;
let adminA;

const EMAIL = 'admin@escritorio-a.com.br';
const PASSWORD = 'uma-senha-bem-longa-123';

before(async () => {
  if (skip) return;
  h = await startPostgres(env.pg, 'pilot');
  const c = await h.admin.connect();
  try {
    await c.query(fs.readFileSync(path.join(repoRoot, 'db', 'migrations', '0002_pilot.sql'), 'utf8')); await c.query(fs.readFileSync(path.join(repoRoot, 'db', 'migrations', '0003_personal_instances.sql'), 'utf8')); await c.query(fs.readFileSync(path.join(repoRoot, 'db', 'migrations', '0004_crm_ai.sql'), 'utf8')); await c.query(fs.readFileSync(path.join(repoRoot, 'db', 'migrations', '0005_tasks.sql'), 'utf8')); await c.query(fs.readFileSync(path.join(repoRoot, 'db', 'migrations', '0006_deal_expected_close.sql'), 'utf8'));
  } finally {
    c.release();
  }
  const direct = `postgres://postgres:${h.admin.options.password}@127.0.0.1:${h.port}/postgres`;
  const seed = (extra) =>
    spawnSync(process.execPath, [path.join(repoRoot, 'db', 'seed.mjs')], {
      env: { ...process.env, DIRECT_URL: direct, SEED_TENANT_NAME: 'Escritório A', SEED_TENANT_SLUG: extra.slug, SEED_ADMIN_NAME: 'Admin A', SEED_ADMIN_EMAIL: extra.email, SEED_ADMIN_PASSWORD: PASSWORD },
      encoding: 'utf8',
    });
  const r = seed({ slug: 'escritorio-a', email: EMAIL });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const r2 = seed({ slug: 'escritorio-b', email: 'admin@escritorio-b.com.br' });
  assert.equal(r2.status, 0, r2.stderr + r2.stdout);
  const t = await h.admin.query("SELECT id FROM tenants WHERE slug = 'escritorio-a'");
  tenantA = t.rows[0]?.id;
});
after(async () => {
  if (h) await h.dispose();
});

test('seed: tenant, admin ativo, funis e etapas criados; e-mail repetido é recusado', { skip }, async () => {
  assert.ok(tenantA, 'tenant A existe');
  const { rows } = await withTenant(h.app, { tenantId: tenantA, readScopes: 'tenant' }, (c) => c.query('SELECT (SELECT count(*) FROM pipelines)::int p, (SELECT count(*) FROM pipeline_stages)::int s, (SELECT status FROM users LIMIT 1) st'));
  assert.deepEqual(rows[0], { p: 2, s: 8, st: 'active' });
  const direct = `postgres://postgres:${h.admin.options.password}@127.0.0.1:${h.port}/postgres`;
  const again = spawnSync(process.execPath, [path.join(repoRoot, 'db', 'seed.mjs')], { env: { ...process.env, DIRECT_URL: direct, SEED_TENANT_NAME: 'X', SEED_TENANT_SLUG: 'x-y', SEED_ADMIN_NAME: 'X', SEED_ADMIN_EMAIL: EMAIL, SEED_ADMIN_PASSWORD: PASSWORD }, encoding: 'utf8' });
  assert.notEqual(again.status, 0);
});

test('login: app_user NÃO lê auth_identities direto, mas auth_lookup devolve só a linha do e-mail exato', { skip }, async () => {
  await assert.rejects(() => h.app.query('SELECT * FROM auth_identities'), /permission denied/);
  const { rows } = await h.app.query('SELECT * FROM auth_lookup($1)', [EMAIL.toUpperCase()]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tenant_id, tenantA);
  assert.match(rows[0].password_hash, /^scrypt\$/);
  assert.equal((await h.app.query('SELECT * FROM auth_lookup($1)', ['nao-existe@x.com'])).rowCount, 0);
  assert.equal((await h.app.query("SELECT * FROM auth_lookup('%')")).rowCount, 0, 'sem curinga');
});

test('login: 5 erros seguidos travam a conta; sucesso zera o contador', { skip }, async () => {
  const { rows } = await h.app.query('SELECT user_id FROM auth_lookup($1)', [EMAIL]);
  const id = rows[0].user_id;
  for (let i = 0; i < 4; i++) await h.app.query('SELECT auth_login_result($1, false)', [id]);
  assert.equal((await h.app.query('SELECT locked_until FROM auth_lookup($1)', [EMAIL])).rows[0].locked_until, null);
  await h.app.query('SELECT auth_login_result($1, false)', [id]);
  assert.ok((await h.app.query('SELECT locked_until FROM auth_lookup($1)', [EMAIL])).rows[0].locked_until, 'travou no 5º erro');
  await h.app.query('SELECT auth_login_result($1, true)', [id]);
  assert.equal((await h.app.query('SELECT locked_until FROM auth_lookup($1)', [EMAIL])).rows[0].locked_until, null);
});

test('convite: registrar só vale para usuário do tenant do chamador; aceitar define senha e ativa', { skip }, async () => {
  const { randomUUID } = await import('node:crypto');
  const uid = randomUUID();
  const tokenHash = 'a'.repeat(64);
  await withTenant(h.app, { tenantId: tenantA, readScopes: 'tenant' }, async (c) => {
    await c.query("INSERT INTO users (id, tenant_id, email, name, status) VALUES ($1, $2, 'novo@escritorio-a.com.br', 'Novo', 'invited')", [uid, tenantA]);
    await c.query('SELECT auth_register($1, $2, $3)', [uid, 'novo@escritorio-a.com.br', tokenHash]);
  });
  // outro tenant tentando registrar identidade de usuário que não é dele: recusado
  const tenantB = (await h.admin.query("SELECT id FROM tenants WHERE slug = 'escritorio-b'")).rows[0].id;
  await assert.rejects(() => withTenant(h.app, { tenantId: tenantB, readScopes: 'tenant' }, (c) => c.query('SELECT auth_register($1, $2, $3)', [uid, 'roubo@x.com', 'b'.repeat(64)])), /inexistente neste tenant/);
  // token errado não ativa nada; token certo ativa e consome
  assert.equal((await h.app.query('SELECT auth_accept_invite($1, $2) ok', ['c'.repeat(64), 'h'])).rows[0].ok, false);
  assert.equal((await h.app.query('SELECT auth_accept_invite($1, $2) ok', [tokenHash, 'scrypt$x'])).rows[0].ok, true);
  assert.equal((await h.app.query('SELECT auth_accept_invite($1, $2) ok', [tokenHash, 'scrypt$y'])).rows[0].ok, false, 'token é de uso único');
  const st = await withTenant(h.app, { tenantId: tenantA, readScopes: 'tenant' }, (c) => c.query('SELECT status FROM users WHERE id = $1', [uid]));
  assert.equal(st.rows[0].status, 'active');
});

test('mensagens: dedupe por id do WhatsApp, isolamento de tenant e sem DELETE para o app', { skip }, async () => {
  const { randomUUID } = await import('node:crypto');
  const conv = await withTenant(h.app, { tenantId: tenantA, readScopes: 'tenant' }, async (c) => {
    const inst = (await c.query("INSERT INTO instances (tenant_id, name) VALUES ($1, 'Comercial') RETURNING id", [tenantA])).rows[0].id;
    const ct = (await c.query("INSERT INTO contacts (tenant_id, name, phone) VALUES ($1, 'Cliente', '5511999990000') RETURNING id", [tenantA])).rows[0].id;
    return (await c.query("INSERT INTO conversations (tenant_id, instance_id, contact_id, phone, status) VALUES ($1, $2, $3, '5511999990000', 'queue') RETURNING id", [tenantA, inst, ct])).rows[0].id;
  });
  const ins = (c) => c.query("INSERT INTO messages (tenant_id, conversation_id, wa_message_id, direction, body) VALUES ($1, $2, 'WA1', 'in', 'oi') ON CONFLICT DO NOTHING", [tenantA, conv]);
  await withTenant(h.app, { tenantId: tenantA, readScopes: 'tenant' }, ins);
  await withTenant(h.app, { tenantId: tenantA, readScopes: 'tenant' }, ins);
  assert.equal((await h.admin.query('SELECT count(*)::int n FROM messages')).rows[0].n, 1, 'mesma mensagem 2x = 1 linha');
  const tenantB = (await h.admin.query("SELECT id FROM tenants WHERE slug = 'escritorio-b'")).rows[0].id;
  const seenByB = await withTenant(h.app, { tenantId: tenantB, readScopes: 'tenant' }, (c) => c.query('SELECT count(*)::int n FROM messages'));
  assert.equal(seenByB.rows[0].n, 0, 'tenant B não vê mensagens do A');
  await assert.rejects(() => withTenant(h.app, { tenantId: tenantA, readScopes: 'tenant' }, (c) => c.query("DELETE FROM messages WHERE wa_message_id = 'WA1'")), /permission denied/);
  void randomUUID;
  void APP_PW;
});
