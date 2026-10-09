// Isolamento de tenant e postura de segurança do banco, contra Postgres REAL.
// Pula (com mensagem) se Docker/pg não estiverem disponíveis.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { detectEnv, startPostgres, adminTx, containerExists } from './_harness.mjs';
import { cmp, toSql } from '../../shared/permissions/index.js';
import { ENTITIES } from '../../shared/permissions/catalog.js';

const require = createRequire(import.meta.url);
const { withTenant } = require('../../src/db-tenant.js');

const env = await detectEnv();

let n = 0;
const nu = () => '00000000-0000-4000-a000-' + String(++n).padStart(12, '0');
const A = nu();
const B = nu();

/** Código SQLSTATE do erro esperado. */
async function sqlstate(promise) {
  try {
    await promise;
  } catch (e) {
    return e.code ?? e.message;
  }
  return 'NO_ERROR';
}

describe('isolamento de tenant (Postgres real)', { skip: env.skip || false }, () => {
  let h;
  let app;
  const d = { A: {}, B: {} }; // ids por tenant
  const ctxOf = (tenantId, over = {}) => ({ tenantId, userId: d[tenantId === A ? 'A' : 'B'].u1, teamIds: [], readScopes: 'tenant', ...over });
  const asTenant = (tenantId, fn, over) => withTenant(app, ctxOf(tenantId, over), fn);

  before(async () => {
    h = await startPostgres(env.pg, 'iso', { migrate: false });
    // (a) aplica do zero e DE NOVO: idempotência.
    await h.applyMigration();
    await h.applyMigration();
    await h.admin.query(`ALTER ROLE app_user PASSWORD 'ttf-app-pw'`);
    app = h.app;

    for (const [key, tid] of [['A', A], ['B', B]]) {
      const x = d[key];
      x.tid = tid;
      Object.assign(x, { u1: nu(), u2: nu(), t1: nu(), t2: nu(), p1: nu(), s1: nu(), i1: nu(), deal1: nu(), deal2: nu(), c1: nu(), conv1: nu(), role1: nu() });
      await h.admin.query('INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)', [tid, `Tenant ${key}`, `tenant-${key.toLowerCase()}`]);
      await adminTx(h.admin, tid, async (c) => {
        await c.query(
          `INSERT INTO users (id, tenant_id, email, name, status) VALUES ($1,$3,$4,'U1','active'), ($2,$3,$5,'U2','active')`,
          [x.u1, x.u2, tid, `u1@${key}.com`, `u2@${key}.com`]
        );
        await c.query(`INSERT INTO teams (id, tenant_id, name) VALUES ($1,$2,'raiz')`, [x.t1, tid]);
        await c.query(`INSERT INTO teams (id, tenant_id, name, parent_id) VALUES ($1,$3,'filha',$2)`, [x.t2, x.t1, tid]);
        await c.query(`INSERT INTO pipelines (id, tenant_id, name) VALUES ($1,$2,'funil')`, [x.p1, tid]);
        await c.query(`INSERT INTO pipeline_stages (id, tenant_id, pipeline_id, name) VALUES ($1,$2,$3,'novo')`, [x.s1, tid, x.p1]);
        await c.query(`INSERT INTO instances (id, tenant_id, name) VALUES ($1,$2,'wpp')`, [x.i1, tid]);
        await c.query(
          `INSERT INTO deals (id, tenant_id, owner_id, team_id, title, pipeline_id, stage_id, value) VALUES ($1,$3,$4,$6,'D1',$7,$8,100), ($2,$3,$5,NULL,'D2',$7,$8,NULL)`,
          [x.deal1, x.deal2, tid, x.u1, x.u2, x.t1, x.p1, x.s1]
        );
        await c.query(`INSERT INTO contacts (id, tenant_id, owner_id, name) VALUES ($1,$2,$3,'Fulano')`, [x.c1, tid, x.u1]);
        await c.query(`INSERT INTO conversations (id, tenant_id, assignee_id, instance_id) VALUES ($1,$2,$3,$4)`, [x.conv1, tid, x.u1, x.i1]);
        await c.query(`INSERT INTO roles (id, tenant_id, name, definition) VALUES ($1,$2,'custom','{"grants":[],"denies":[]}')`, [x.role1, tid]);
        await c.query(`INSERT INTO audit_log (tenant_id, actor_id, action) VALUES ($1,$2,'seed.test')`, [tid, x.u1]);
        await c.query(
          `INSERT INTO resource_shares (tenant_id, entity, resource_id, subject_type, subject_id, level) VALUES ($1,'deal',$2,'user',$3,'read')`,
          [tid, x.deal1, x.u2]
        );
      });
    }
  });

  after(async () => {
    if (h) await h.dispose();
  });

  // ---------------------------------------------------------------- postura
  test('papéis: app_user/app_owner sem SUPERUSER/BYPASSRLS; app_user fora de app_owner; app_owner NOLOGIN', async () => {
    const { rows } = await h.admin.query(`SELECT rolname, rolsuper, rolbypassrls, rolcanlogin, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname IN ('app_user','app_owner') ORDER BY 1`);
    assert.equal(rows.length, 2);
    for (const r of rows) assert.ok(!r.rolsuper && !r.rolbypassrls && !r.rolcreaterole && !r.rolcreatedb, JSON.stringify(r));
    assert.equal(rows.find((r) => r.rolname === 'app_owner').rolcanlogin, false);
    const { rows: m } = await h.admin.query(`SELECT pg_has_role('app_user','app_owner','MEMBER') AS m`);
    assert.equal(m[0].m, false);
  });

  test('toda tabela com tenant_id (e tenants) tem RLS ENABLE + FORCE + política restritiva tenant_isolation', async () => {
    const { rows } = await h.admin.query(`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
             c.relowner = (SELECT oid FROM pg_roles WHERE rolname='app_owner') AS owned,
             EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='tenant_isolation' AND NOT p.polpermissive) AS restrictive
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname='public'
       WHERE c.relkind='r' AND (c.relname='tenants' OR EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='tenant_id'))`);
    assert.ok(rows.length >= 20, 'esperava ≥20 tabelas, achei ' + rows.length);
    for (const r of rows) assert.ok(r.relrowsecurity && r.relforcerowsecurity && r.restrictive && r.owned, JSON.stringify(r));
  });

  test('toda tabela de entidade do catálogo que existe no banco tem as colunas que o motor referencia', async () => {
    const snake = (a) => a.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
    for (const [name, def] of Object.entries(ENTITIES)) {
      const { rows } = await h.admin.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`, [def.table]);
      if (!rows.length) continue; // entidades de configuração ainda sem tabela (products, automations…)
      const cols = new Set(rows.map((r) => r.column_name));
      for (const attr of Object.keys(def.attrs)) assert.ok(cols.has(snake(attr)), `${def.table}.${snake(attr)} ausente (entidade ${name})`);
      for (const f of def.fields) assert.ok(cols.has(snake(f)) || f === 'items', `${def.table}.${snake(f)} (campo restringível) ausente`);
    }
  });

  test('índices exigidos existem', async () => {
    const { rows } = await h.admin.query(`SELECT tablename, indexdef FROM pg_indexes WHERE schemaname='public'`);
    const has = (table, re) => rows.some((r) => r.tablename === table && re.test(r.indexdef));
    assert.ok(has('deals', /\(tenant_id, owner_id\)/));
    assert.ok(has('deals', /\(tenant_id, team_id\)/));
    assert.ok(has('deals', /\(tenant_id, pipeline_id/));
    assert.ok(has('resource_shares', /\(tenant_id, entity, resource_id\)/));
    assert.ok(has('resource_shares', /\(tenant_id, subject_type, subject_id\)/));
  });

  // ---------------------------------------------------------------- RLS: isolamento
  const TABLES = ['tenants', 'users', 'teams', 'team_members', 'team_closure', 'roles', 'user_roles', 'pipelines', 'pipeline_stages', 'instances', 'contacts', 'companies', 'deals', 'conversations', 'proposals', 'tasks', 'calls', 'resource_shares', 'approvals', 'audit_log'];

  test('SEM set_config nada é visível (variável ausente = NULL = nenhuma linha) — em TODAS as tabelas', async () => {
    for (const t of TABLES) {
      const { rows } = await app.query(`SELECT count(*)::int AS n FROM ${t}`);
      assert.equal(rows[0].n, 0, `${t} visível sem contexto`);
    }
    // e o admin (sem RLS) confirma que há dados — o teste não é vácuo
    const { rows } = await h.admin.query('SELECT count(*)::int AS n FROM deals');
    assert.equal(rows[0].n, 4);
  });

  test("variável vazia ('') e NULL também não mostram nada, sem erro", async () => {
    const c = await app.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.tenant_id', '', true)");
      assert.equal((await c.query('SELECT count(*)::int n FROM deals')).rows[0].n, 0);
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  });

  test('conexão REUSADA do pool não herda o tenant da transação anterior (set_config local)', async () => {
    const pool1 = h.appPool({ max: 1 });
    const before = await withTenant(pool1, ctxOf(A), (c) => c.query('SELECT count(*)::int n FROM deals'));
    assert.equal(before.rows[0].n, 2);
    // mesma conexão física (max:1): depois do COMMIT a variável vira '' — nada visível
    const after = await pool1.query('SELECT count(*)::int n FROM deals');
    assert.equal(after.rows[0].n, 0);
    const cur = await pool1.query("SELECT current_setting('app.tenant_id', true) AS v");
    assert.ok(cur.rows[0].v === '' || cur.rows[0].v === null);
    // e depois de ROLLBACK por erro no callback também
    await assert.rejects(withTenant(pool1, ctxOf(A), async () => { throw new Error('boom'); }), /boom/);
    assert.equal((await pool1.query('SELECT count(*)::int n FROM deals')).rows[0].n, 0);
  });

  test('com tenant A só A; com tenant B só B (todas as tabelas com dados)', async () => {
    for (const [tid, key] of [[A, 'A'], [B, 'B']]) {
      await asTenant(tid, async (c) => {
        for (const t of ['users', 'teams', 'pipelines', 'pipeline_stages', 'instances', 'deals', 'contacts', 'conversations', 'roles', 'audit_log', 'resource_shares', 'team_closure']) {
          const { rows } = await c.query(`SELECT DISTINCT tenant_id FROM ${t}`);
          assert.deepEqual(rows.map((r) => r.tenant_id), [tid], `${t} (${key})`);
        }
        const { rows } = await c.query('SELECT id FROM tenants');
        assert.deepEqual(rows.map((r) => r.id), [tid]);
      });
    }
  });

  test('tenant A não enxerga NEM filtrando explicitamente por ids do tenant B', async () => {
    await asTenant(A, async (c) => {
      assert.equal((await c.query('SELECT 1 FROM deals WHERE id = $1', [d.B.deal1])).rowCount, 0);
      assert.equal((await c.query('SELECT 1 FROM deals WHERE tenant_id = $1', [B])).rowCount, 0);
      assert.equal((await c.query('SELECT 1 FROM users u JOIN deals d ON d.owner_id = u.id WHERE d.tenant_id = $1', [B])).rowCount, 0);
      assert.equal((await c.query('SELECT 1 FROM deals d WHERE EXISTS (SELECT 1 FROM tenants t WHERE t.id = $1)', [B])).rowCount, 0);
    });
  });

  test('UPDATE/DELETE em linha do outro tenant afetam 0 linhas', async () => {
    await asTenant(A, async (c) => {
      assert.equal((await c.query(`UPDATE deals SET title='hack' WHERE id = $1`, [d.B.deal1])).rowCount, 0);
      assert.equal((await c.query(`DELETE FROM deals WHERE id = $1`, [d.B.deal1])).rowCount, 0);
    });
    const { rows } = await h.admin.query('SELECT title FROM deals WHERE id = $1', [d.B.deal1]);
    assert.equal(rows[0].title, 'D1');
  });

  test('INSERT com tenant_id do OUTRO tenant é rejeitado (RLS WITH CHECK) — todas as tabelas de negócio', async () => {
    await asTenant(A, async (c) => {
      for (const [sql, params] of [
        [`INSERT INTO contacts (tenant_id, name) VALUES ($1, 'x')`, [B]],
        [`INSERT INTO deals (tenant_id, title) VALUES ($1, 'x')`, [B]],
        [`INSERT INTO conversations (tenant_id) VALUES ($1)`, [B]],
        [`INSERT INTO tasks (tenant_id) VALUES ($1)`, [B]],
        [`INSERT INTO audit_log (tenant_id, action) VALUES ($1, 'x')`, [B]],
        [`INSERT INTO teams (tenant_id, name) VALUES ($1, 'x')`, [B]],
      ]) {
        await c.query('SAVEPOINT s');
        assert.equal(await sqlstate(c.query(sql, params)), '42501', sql);
        await c.query('ROLLBACK TO s');
      }
    });
  });

  test('INSERT com tenant_id NULL é rejeitado; INSERT no próprio tenant funciona', async () => {
    await asTenant(A, async (c) => {
      await c.query('SAVEPOINT s');
      assert.ok(['23502', '42501'].includes(await sqlstate(c.query(`INSERT INTO contacts (tenant_id, name) VALUES (NULL, 'x')`))));
      await c.query('ROLLBACK TO s');
      const r = await c.query(`INSERT INTO contacts (tenant_id, name, owner_id) VALUES ($1, 'ok', $2) RETURNING id`, [A, d.A.u1]);
      assert.equal(r.rowCount, 1);
    });
  });

  test('UPDATE que TROCA tenant_id é rejeitado (RLS + trigger) e o dono sob FORCE também', async () => {
    await asTenant(A, async (c) => {
      await c.query('SAVEPOINT s');
      assert.ok(['42501', '23000'].includes(await sqlstate(c.query(`UPDATE deals SET tenant_id = $1 WHERE id = $2`, [B, d.A.deal1]))));
      await c.query('ROLLBACK TO s');
    });
    // o trigger vale mesmo para quem não passa por RLS (superusuário em manutenção)
    assert.equal(await sqlstate(h.admin.query(`UPDATE deals SET tenant_id = $1 WHERE id = $2`, [B, d.A.deal1])), '23000');
    const { rows } = await h.admin.query('SELECT tenant_id FROM deals WHERE id = $1', [d.A.deal1]);
    assert.equal(rows[0].tenant_id, A);
  });

  test('FK composta: referência cruzada entre tenants é impossível (owner, team, pipeline, stage, role, share…)', async () => {
    await asTenant(A, async (c) => {
      const attempts = [
        [`INSERT INTO deals (tenant_id, title, owner_id) VALUES ($1,'x',$2)`, [A, d.B.u1]],
        [`INSERT INTO deals (tenant_id, title, team_id) VALUES ($1,'x',$2)`, [A, d.B.t1]],
        [`INSERT INTO deals (tenant_id, title, pipeline_id) VALUES ($1,'x',$2)`, [A, d.B.p1]],
        [`INSERT INTO deals (tenant_id, title, pipeline_id, stage_id) VALUES ($1,'x',$2,$3)`, [A, d.A.p1, d.B.s1]],
        [`INSERT INTO deals (tenant_id, title, stage_id) VALUES ($1,'x',$2)`, [A, d.A.s1]], // etapa sem pipeline (CHECK)
        [`INSERT INTO conversations (tenant_id, assignee_id) VALUES ($1,$2)`, [A, d.B.u1]],
        [`INSERT INTO conversations (tenant_id, instance_id) VALUES ($1,$2)`, [A, d.B.i1]],
        [`INSERT INTO teams (tenant_id, name, parent_id) VALUES ($1,'x',$2)`, [A, d.B.t1]],
        [`INSERT INTO user_roles (tenant_id, user_id, role_id) VALUES ($1,$2,$3)`, [A, d.A.u1, d.B.role1]],
        [`INSERT INTO user_roles (tenant_id, user_id, role_id) VALUES ($1,$2,$3)`, [A, d.B.u1, d.A.role1]],
        [`INSERT INTO resource_shares (tenant_id, entity, resource_id, subject_type, subject_id, level) VALUES ($1,'deal',$2,'user',$3,'read')`, [A, d.B.deal1, d.A.u1]],
        [`INSERT INTO resource_shares (tenant_id, entity, resource_id, subject_type, subject_id, level) VALUES ($1,'deal',$2,'user',$3,'read')`, [A, d.A.deal1, d.B.u1]],
        [`INSERT INTO resource_shares (tenant_id, entity, resource_id, subject_type, subject_id, level) VALUES ($1,'deal',$2,'team',$3,'edit')`, [A, d.A.deal1, d.B.t1]],
        [`UPDATE deals SET owner_id = $2 WHERE id = $1`, [d.A.deal1, d.B.u1]],
        [`INSERT INTO team_members (tenant_id, team_id, user_id) VALUES ($1,$2,$3)`, [A, d.A.t1, d.B.u1]],
      ];
      for (const [sql, params] of attempts) {
        await c.query('SAVEPOINT s');
        const code = await sqlstate(c.query(sql, params));
        assert.ok(code === '23503' || code === '23514', `${sql} -> ${code}`);
        await c.query('ROLLBACK TO s');
      }
      // O erro é o MESMO para id inexistente e para id de outro tenant: sem oráculo de existência.
      await c.query('SAVEPOINT s');
      const e1 = await c.query(`INSERT INTO deals (tenant_id, title, owner_id) VALUES ($1,'x',$2)`, [A, d.B.u1]).catch((e) => e);
      await c.query('ROLLBACK TO s');
      const e2 = await c.query(`INSERT INTO deals (tenant_id, title, owner_id) VALUES ($1,'x',$2)`, [A, nu()]).catch((e) => e);
      assert.equal(e1.code, e2.code);
      assert.equal(e1.constraint, e2.constraint);
    });
  });

  test('tenants: app_user só vê o próprio, não insere nem altera slug/status', async () => {
    await asTenant(A, async (c) => {
      assert.equal((await c.query('SELECT count(*)::int n FROM tenants')).rows[0].n, 1);
      await c.query('SAVEPOINT s');
      assert.equal(await sqlstate(c.query(`INSERT INTO tenants (name, slug) VALUES ('x','novo-tenant')`)), '42501');
      await c.query('ROLLBACK TO s');
      await c.query('SAVEPOINT s');
      assert.equal(await sqlstate(c.query(`UPDATE tenants SET slug = 'hackeado' WHERE id = $1`, [A])), '42501');
      await c.query('ROLLBACK TO s');
      assert.equal((await c.query(`UPDATE tenants SET name = 'Novo Nome' WHERE id = $1`, [A])).rowCount, 1);
      assert.equal((await c.query(`UPDATE tenants SET name = 'hack' WHERE id = $1`, [B])).rowCount, 0);
    });
  });

  // ---------------------------------------------------------------- audit_log append-only
  test('audit_log: app_user insere/lê, mas UPDATE/DELETE/TRUNCATE são negados (grant) — e o trigger barra até o dono', async () => {
    await asTenant(A, async (c) => {
      assert.equal((await c.query(`INSERT INTO audit_log (tenant_id, actor_id, action, entity) VALUES ($1,$2,'deal.update','deal')`, [A, d.A.u1])).rowCount, 1);
      for (const sql of [`UPDATE audit_log SET action='x'`, `DELETE FROM audit_log`, `TRUNCATE audit_log`]) {
        await c.query('SAVEPOINT s');
        assert.equal(await sqlstate(c.query(sql)), '42501', sql);
        await c.query('ROLLBACK TO s');
      }
    });
    // dono sob FORCE (SET ROLE na sessão do admin): o GRANT existe para ele, mas o trigger recusa
    const c = await h.admin.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_owner');
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [A]);
      for (const sql of [`UPDATE audit_log SET action='x'`, `DELETE FROM audit_log`, `TRUNCATE audit_log`]) {
        await c.query('SAVEPOINT s');
        assert.equal(await sqlstate(c.query(sql)), '42501', sql);
        await c.query('ROLLBACK TO s');
      }
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  });

  // ---------------------------------------------------------------- adversarial
  test('SQL injection via parâmetros não afeta (parametrização) e payload é gravado como texto', async () => {
    const payload = `x'); DROP TABLE deals; --`;
    await asTenant(A, async (c) => {
      assert.equal((await c.query(`SELECT 1 FROM contacts WHERE name = $1`, [`x' OR '1'='1`])).rowCount, 0);
      await c.query(`INSERT INTO contacts (tenant_id, name) VALUES ($1, $2)`, [A, payload]);
      const { rows } = await c.query(`SELECT name FROM contacts WHERE name = $1`, [payload]);
      assert.equal(rows[0].name, payload);
      // via filtro compilado pelo motor (toSql): o valor malicioso vira parâmetro, nunca texto SQL
      const { sql, params } = toSql(cmp('status', 'eq', `x' OR '1'='1`), ENTITIES.contact, { alias: 't' });
      assert.ok(!sql.includes("OR '1'='1"));
      assert.equal((await c.query(`SELECT 1 FROM contacts t WHERE ${sql}`, params)).rowCount, 0);
    });
    assert.equal((await h.admin.query(`SELECT to_regclass('public.deals') IS NOT NULL AS ok`)).rows[0].ok, true);
  });

  test('withTenant rejeita tenantId/userId/teamIds malformados ANTES de tocar o banco', async () => {
    let connects = 0;
    const fake = { connect: async () => { connects++; throw new Error('não deveria conectar'); } };
    const bad = [
      { tenantId: `${A}'; DROP TABLE deals;--` }, { tenantId: 'abc' }, { tenantId: undefined }, { tenantId: 123 },
      { tenantId: A, userId: 'x' }, { tenantId: A, userId: `${A} ` }, { tenantId: A, teamIds: ['nope'] }, { tenantId: A, teamIds: 'x' },
      { tenantId: A, teamTreeIds: [A, 5] }, { tenantId: A, readScopes: { deals: 'root' } }, { tenantId: A, readScopes: { 'deals; drop': 'own' } },
    ];
    for (const ctx of bad) await assert.rejects(withTenant(fake, ctx, async () => {}), TypeError, JSON.stringify(ctx));
    assert.equal(connects, 0);
  });

  test('set_config com payload malicioso/lixo: falha fechado (erro de cast), nunca vaza linhas', async () => {
    const c = await app.connect();
    try {
      for (const evil of [`${A}' OR tenant_id IS NOT NULL --`, 'abc', `${A},${B}`, '*', '%']) {
        await c.query('BEGIN');
        await c.query("SELECT set_config('app.tenant_id', $1, true)", [evil]);
        assert.equal(await sqlstate(c.query('SELECT * FROM deals')), '22P02', evil);
        await c.query('ROLLBACK');
      }
    } finally {
      c.release();
    }
  });

  test('escapar do papel: SET ROLE / SET SESSION AUTHORIZATION / row_security=off / DDL são negados; RESET ROLE não ajuda', async () => {
    const c = await app.connect();
    try {
      for (const sql of ['SET ROLE app_owner', 'SET ROLE postgres', 'SET SESSION AUTHORIZATION postgres', 'SET SESSION AUTHORIZATION app_owner']) {
        const code = await sqlstate(c.query(sql));
        assert.ok(['42501', '22023'].includes(code), `${sql} -> ${code}`);
      }
      await c.query('RESET ROLE'); // inofensivo: volta ao próprio app_user
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [A]);
      // row_security=off NÃO desliga para quem não é BYPASSRLS: a consulta falha em vez de vazar
      await c.query('SET LOCAL row_security = off');
      assert.equal(await sqlstate(c.query('SELECT * FROM deals')), '42501');
      await c.query('ROLLBACK');
      for (const sql of [
        'ALTER TABLE deals DISABLE ROW LEVEL SECURITY', 'ALTER TABLE deals NO FORCE ROW LEVEL SECURITY', 'DROP POLICY tenant_isolation ON deals',
        'CREATE POLICY evil ON deals USING (true)', 'ALTER ROLE app_user BYPASSRLS', 'ALTER ROLE app_user SUPERUSER', 'GRANT app_owner TO app_user',
        'CREATE TABLE public.evil (x int)', 'CREATE FUNCTION public.evil() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$', 'CREATE TEMP TABLE evil (x int)',
        'DROP TABLE deals', 'ALTER TABLE deals DISABLE TRIGGER ALL', 'CREATE SCHEMA evil', 'TRUNCATE deals', 'TRUNCATE contacts CASCADE',
        'INSERT INTO team_closure (tenant_id, ancestor_id, descendant_id, depth) VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 0)',
        "INSERT INTO system_roles (id, name) VALUES ('role_evil', 'x')", 'DELETE FROM users', 'ALTER FUNCTION app_tenant_id() SECURITY DEFINER',
        'CREATE OR REPLACE FUNCTION app_tenant_id() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$',
      ]) {
        const code = await sqlstate(c.query(sql));
        assert.ok(['42501', '42P01', '42809'].includes(code), `${sql} -> ${code}`);
      }
    } finally {
      c.release();
    }
  });

  test('LIMITAÇÃO CONHECIDA (documentada): SQL arbitrário como app_user PODE trocar app.tenant_id — a barreira assume que a app nunca executa SQL de terceiros', async () => {
    // Esta é a fronteira do desenho "GUC por transação": quem consegue executar
    // SQL arbitrário NA conexão do app já é "a aplicação". Mitigações: parametrização
    // obrigatória, nenhum SQL vindo do cliente, (futuro) contexto assinado por HMAC.
    await asTenant(A, async (c) => {
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [B]);
      const { rows } = await c.query('SELECT DISTINCT tenant_id FROM deals');
      assert.deepEqual(rows.map((r) => r.tenant_id), [B]);
    });
  });

  test('MUTAÇÃO: sem FORCE o dono enxerga tudo (prova que o FORCE é o que protege); com FORCE o dono fica preso', async () => {
    const asOwner = async (fn) => {
      const c = await h.admin.connect();
      try {
        await c.query('BEGIN');
        await c.query('SET LOCAL ROLE app_owner');
        const r = await fn(c);
        await c.query('ROLLBACK');
        return r;
      } finally {
        c.release();
      }
    };
    assert.equal(await asOwner(async (c) => (await c.query('SELECT count(*)::int n FROM deals')).rows[0].n), 0); // FORCE: sem contexto, nada
    await h.admin.query('ALTER TABLE deals NO FORCE ROW LEVEL SECURITY');
    try {
      assert.equal(await asOwner(async (c) => (await c.query('SELECT count(*)::int n FROM deals')).rows[0].n), 4); // sem FORCE: vê tudo
    } finally {
      await h.admin.query('ALTER TABLE deals FORCE ROW LEVEL SECURITY');
    }
    assert.equal(await asOwner(async (c) => (await c.query('SELECT count(*)::int n FROM deals')).rows[0].n), 0);
  });

  test('MUTAÇÃO: uma política PERMISSIVA "USING (true)" adicionada por engano NÃO abre o tenant (restritiva vence)', async () => {
    await h.admin.query('CREATE POLICY evil_open ON deals AS PERMISSIVE FOR ALL USING (true) WITH CHECK (true)');
    try {
      assert.equal((await app.query('SELECT count(*)::int n FROM deals')).rows[0].n, 0);
      await asTenant(A, async (c) => {
        assert.deepEqual((await c.query('SELECT DISTINCT tenant_id FROM deals')).rows.map((r) => r.tenant_id), [A]);
        await c.query('SAVEPOINT s');
        assert.equal(await sqlstate(c.query(`INSERT INTO deals (tenant_id, title) VALUES ($1,'x')`, [B])), '42501');
        await c.query('ROLLBACK TO s');
      });
    } finally {
      await h.admin.query('DROP POLICY evil_open ON deals');
    }
  });

  test('migração é idempotente: reaplicar não altera políticas/privilégios (mesmo após drift) e a autoverificação segura regressões', async () => {
    await h.admin.query('ALTER TABLE deals DISABLE ROW LEVEL SECURITY'); // drift
    await h.admin.query('ALTER ROLE app_user BYPASSRLS'); // drift grave
    await h.applyMigration(); // reafirma
    const { rows } = await h.admin.query(`SELECT c.relrowsecurity, c.relforcerowsecurity, (SELECT rolbypassrls FROM pg_roles WHERE rolname='app_user') AS byp FROM pg_class c WHERE relname='deals'`);
    assert.deepEqual(rows[0], { relrowsecurity: true, relforcerowsecurity: true, byp: false });
    // autoverificação: uma tabela nova com tenant_id e sem RLS derruba a migração
    await h.admin.query('CREATE TABLE zz_esquecida (id uuid, tenant_id uuid)');
    try {
      assert.equal(await sqlstate(h.applyMigration()), 'P0001');
    } finally {
      await h.admin.query('DROP TABLE zz_esquecida');
    }
  });

  test('higiene: o contêiner existe durante os testes (a remoção é conferida no fim)', () => {
    assert.ok(containerExists(h.name));
  });
});
