// Esquema: closure de equipes, perfis JSONB, atribuições, compartilhamento,
// aprovações, CHECKs de formato, camada 2 de RLS (casos dirigidos) e o helper
// withTenant — contra Postgres REAL. Pula se Docker/pg não estiverem disponíveis.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { detectEnv, startPostgres, adminTx, mulberry32 } from './_harness.mjs';
import { SYSTEM_ROLES, validateRole, expandTeams } from '../../shared/permissions/index.js';

const require = createRequire(import.meta.url);
const { withTenant } = require('../../src/db-tenant.js');
const env = await detectEnv();

let n = 0;
const nu = () => '00000000-0000-4000-b000-' + String(++n).padStart(12, '0');
const A = nu();
const B = nu();
const sqlstate = async (p) => {
  try {
    await p;
  } catch (e) {
    return e.code ?? e.message;
  }
  return 'NO_ERROR';
};

describe('esquema, closure, camada 2 e withTenant (Postgres real)', { skip: env.skip || false }, () => {
  let h;
  let app;
  const U = { a1: nu(), a2: nu(), a3: nu(), b1: nu() };
  const T = { R: nu(), C1: nu(), C2: nu(), G1: nu(), G2: nu(), GG1: nu(), B1: nu() };
  const ctx = (tenantId, over = {}) => ({ tenantId, userId: U.a1, readScopes: 'tenant', ...over });
  const asA = (fn, over) => withTenant(app, ctx(A, over), fn);

  before(async () => {
    h = await startPostgres(env.pg, 'schema');
    app = h.app;
    for (const [tid, key] of [[A, 'a'], [B, 'b']]) await h.admin.query('INSERT INTO tenants (id, name, slug) VALUES ($1,$2,$3)', [tid, key, `t-${key}`]);
    await adminTx(h.admin, A, async (c) => {
      await c.query(`INSERT INTO users (id, tenant_id, email, name, status) VALUES ($1,$4,'a1@x.com','A1','active'), ($2,$4,'a2@x.com','A2','active'), ($3,$4,'a3@x.com','A3','active')`, [U.a1, U.a2, U.a3, A]);
      // árvore de 4 níveis: R > C1 > G1 > GG1 ; R > C2 ; C1 > G2
      const ins = (id, parent) => c.query(`INSERT INTO teams (id, tenant_id, name, parent_id) VALUES ($1,$2,$4,$3)`, [id, A, parent, id.slice(-6)]);
      await ins(T.R, null);
      await ins(T.C1, T.R);
      await ins(T.C2, T.R);
      await ins(T.G1, T.C1);
      await ins(T.G2, T.C1);
      await ins(T.GG1, T.G1);
    });
    await adminTx(h.admin, B, async (c) => {
      await c.query(`INSERT INTO users (id, tenant_id, email, name, status) VALUES ($1,$2,'b1@x.com','B1','active')`, [U.b1, B]);
      await c.query(`INSERT INTO teams (id, tenant_id, name) VALUES ($1,$2,'b')`, [T.B1, B]);
    });
  });
  after(async () => {
    if (h) await h.dispose();
  });

  // ------------------------------------------------------------------ closure
  const closureFromCte = async (c, tid) =>
    (
      await c.query(
        `WITH RECURSIVE r(anc, des, depth) AS (
           SELECT id, id, 0 FROM teams WHERE tenant_id = $1
           UNION ALL
           SELECT r.anc, t.id, r.depth + 1 FROM r JOIN teams t ON t.parent_id = r.des AND t.tenant_id = $1)
         SELECT anc, des, depth FROM r ORDER BY 1, 2`,
        [tid]
      )
    ).rows.map((x) => `${x.anc}>${x.des}:${x.depth}`);
  const closureStored = async (c, tid) =>
    (await c.query('SELECT ancestor_id anc, descendant_id des, depth FROM team_closure WHERE tenant_id = $1 ORDER BY 1, 2', [tid])).rows.map((x) => `${x.anc}>${x.des}:${x.depth}`);

  test('closure: criação em 4 níveis bate com a recursão (CTE) e com expandTeams do motor', async () => {
    await asA(async (c) => {
      assert.deepEqual(await closureStored(c, A), await closureFromCte(c, A));
      const { rows } = await c.query('SELECT id, parent_id FROM teams');
      const org = { teams: rows.map((r) => ({ id: r.id, parentId: r.parent_id })) };
      for (const t of Object.values(T).filter((x) => x !== T.B1)) {
        const viaDb = (await c.query('SELECT descendant_id FROM team_closure WHERE tenant_id=$1 AND ancestor_id = ANY($2::uuid[])', [A, [t]])).rows.map((r) => r.descendant_id).sort();
        assert.deepEqual(viaDb, expandTeams(org, [t]).sort(), `subárvore de ${t}`);
      }
      assert.equal((await c.query('SELECT max(depth)::int d FROM team_closure')).rows[0].d, 3);
    });
  });

  test('closure: mover subárvore, virar raiz, ciclo e auto-pai (estresse com PRNG fixo) — sempre igual à CTE', async () => {
    const rng = mulberry32(42);
    await asA(async (c) => {
      // ciclo e auto-pai rejeitados
      await c.query('SAVEPOINT s');
      assert.equal(await sqlstate(c.query('UPDATE teams SET parent_id = $2 WHERE id = $1', [T.R, T.GG1])), '23514');
      await c.query('ROLLBACK TO s');
      await c.query('SAVEPOINT s');
      assert.equal(await sqlstate(c.query('UPDATE teams SET parent_id = id WHERE id = $1', [T.C1])), '23514');
      await c.query('ROLLBACK TO s');
      // 60 movimentos aleatórios válidos (ignora os que formariam ciclo)
      const ids = [T.R, T.C1, T.C2, T.G1, T.G2, T.GG1];
      let moved = 0;
      for (let i = 0; i < 60; i++) {
        const t = ids[Math.floor(rng() * ids.length)];
        const parent = rng() < 0.2 ? null : ids[Math.floor(rng() * ids.length)];
        await c.query('SAVEPOINT s');
        const code = await sqlstate(c.query('UPDATE teams SET parent_id = $2 WHERE id = $1', [t, parent]));
        if (code === 'NO_ERROR') {
          moved++;
          await c.query('RELEASE SAVEPOINT s');
        } else {
          assert.equal(code, '23514');
          await c.query('ROLLBACK TO s');
        }
        if (i % 10 === 9) assert.deepEqual(await closureStored(c, A), await closureFromCte(c, A), `após ${i + 1} movimentos`);
      }
      assert.ok(moved > 10, 'movimentos válidos demais poucos: ' + moved);
      assert.deepEqual(await closureStored(c, A), await closureFromCte(c, A));
      // restaura a forma original para os demais testes
      for (const [t, p] of [[T.R, null], [T.C1, T.R], [T.C2, T.R], [T.G1, T.C1], [T.G2, T.C1], [T.GG1, T.G1]]) {
        await c.query('UPDATE teams SET parent_id = NULL WHERE id = $1', [t]); // evita ciclo transitório
      }
      for (const [t, p] of [[T.C1, T.R], [T.C2, T.R], [T.G1, T.C1], [T.G2, T.C1], [T.GG1, T.G1]]) await c.query('UPDATE teams SET parent_id = $2 WHERE id = $1', [t, p]);
      assert.deepEqual(await closureStored(c, A), await closureFromCte(c, A));
      assert.equal((await c.query('SELECT max(depth)::int d FROM team_closure')).rows[0].d, 3);
    });
  });

  test('closure: app_user não escreve em team_closure, mas criar equipe pela app a mantém; pai de outro tenant é impossível', async () => {
    await asA(async (c) => {
      await c.query('SAVEPOINT s');
      assert.equal(await sqlstate(c.query(`DELETE FROM team_closure WHERE tenant_id = $1`, [A])), '42501');
      await c.query('ROLLBACK TO s');
      const id = nu();
      await c.query('INSERT INTO teams (id, tenant_id, name, parent_id) VALUES ($1,$2,$3,$4)', [id, A, 'nova', T.GG1]);
      const { rows } = await c.query('SELECT ancestor_id FROM team_closure WHERE descendant_id = $1 ORDER BY depth', [id]);
      assert.deepEqual(rows.map((r) => r.ancestor_id), [id, T.GG1, T.G1, T.C1, T.R]);
      await c.query('SAVEPOINT s');
      assert.equal(await sqlstate(c.query('UPDATE teams SET parent_id = $2 WHERE id = $1', [id, T.B1])), '23503');
      await c.query('ROLLBACK TO s');
      await c.query('DELETE FROM teams WHERE id = $1', [id]);
      assert.equal((await c.query('SELECT 1 FROM team_closure WHERE descendant_id = $1 OR ancestor_id = $1', [id])).rowCount, 0);
      await c.query('SAVEPOINT s');
      assert.equal(await sqlstate(c.query('DELETE FROM teams WHERE id = $1', [T.C1])), '23503'); // tem filhas
      await c.query('ROLLBACK TO s');
    });
  });

  // ------------------------------------------------------------------ perfis
  test('system_roles no banco == perfis de sistema do código (detecta drift entre roles.js e a migração)', async () => {
    const { rows } = await h.admin.query('SELECT id FROM system_roles ORDER BY 1');
    assert.deepEqual(rows.map((r) => r.id), SYSTEM_ROLES.map((r) => r.id).sort());
  });

  test('roles JSONB: aceita todos os perfis de sistema clonados (ida e volta idêntica) e rejeita formato inválido', async () => {
    await asA(async (c) => {
      for (const r of SYSTEM_ROLES) {
        assert.deepEqual(validateRole(r), []);
        const def = { grants: r.grants, denies: r.denies, partitions: r.partitions, fields: r.fields };
        const { rows } = await c.query(`INSERT INTO roles (tenant_id, name, cloned_from, definition) VALUES ($1,$2,$3,$4) RETURNING definition, version`, [A, 'clone ' + r.name, r.id, JSON.stringify(def)]);
        assert.deepEqual(rows[0].definition, def);
        assert.equal(rows[0].version, 1);
      }
      const bad = [
        ['não-objeto', '[]'], ['sem grants', '{"denies":[]}'], ['grants não-array', '{"grants":{},"denies":[]}'], ['partitions inválido', '{"grants":[],"denies":[],"partitions":[]}'],
        ['tenantId no JSON', '{"grants":[],"denies":[],"tenantId":"x"}'], ['system no JSON', '{"grants":[],"denies":[],"system":true}'], ['id no JSON', '{"grants":[],"denies":[],"id":"role_admin"}'],
        ['gigante', JSON.stringify({ grants: [], denies: [], blob: 'x'.repeat(300000) })],
      ];
      for (const [why, def] of bad) {
        await c.query('SAVEPOINT s');
        assert.equal(await sqlstate(c.query(`INSERT INTO roles (tenant_id, name, definition) VALUES ($1,$2,$3)`, [A, 'ruim ' + why, def])), '23514', why);
        await c.query('ROLLBACK TO s');
      }
      await c.query('SAVEPOINT s');
      assert.equal(await sqlstate(c.query(`INSERT INTO roles (tenant_id, name, definition) VALUES ($1,'CLONE GESTOR','{"grants":[],"denies":[]}')`, [A])), '23505'); // nome único sem caixa
      await c.query('ROLLBACK TO s');
    });
  });

  test('roles: version só sobe quando a definição muda (o banco decide, não a app)', async () => {
    await asA(async (c) => {
      const { rows } = await c.query(`INSERT INTO roles (tenant_id, name, definition) VALUES ($1,'v','{"grants":[],"denies":[]}') RETURNING id`, [A]);
      const id = rows[0].id;
      await c.query(`UPDATE roles SET name = 'v2' WHERE id = $1`, [id]);
      assert.equal((await c.query('SELECT version FROM roles WHERE id=$1', [id])).rows[0].version, 1);
      await c.query(`UPDATE roles SET definition = '{"grants":[],"denies":[],"partitions":{}}', version = 99 WHERE id = $1`, [id]);
      assert.equal((await c.query('SELECT version FROM roles WHERE id=$1', [id])).rows[0].version, 2);
    });
  });

  test('user_roles: exatamente um alvo (sistema OU perfil do tenant), sem duplicata, FK de sistema', async () => {
    await asA(async (c) => {
      const role = (await c.query(`INSERT INTO roles (tenant_id, name, definition) VALUES ($1,'ur','{"grants":[],"denies":[]}') RETURNING id`, [A])).rows[0].id;
      await c.query(`INSERT INTO user_roles (tenant_id, user_id, system_role_id) VALUES ($1,$2,'role_agent')`, [A, U.a1]);
      await c.query(`INSERT INTO user_roles (tenant_id, user_id, role_id) VALUES ($1,$2,$3)`, [A, U.a1, role]);
      for (const [sql, params, code] of [
        [`INSERT INTO user_roles (tenant_id, user_id, system_role_id) VALUES ($1,$2,'role_agent')`, [A, U.a1], '23505'],
        [`INSERT INTO user_roles (tenant_id, user_id, role_id) VALUES ($1,$2,$3)`, [A, U.a1, role], '23505'],
        [`INSERT INTO user_roles (tenant_id, user_id) VALUES ($1,$2)`, [A, U.a2], '23514'],
        [`INSERT INTO user_roles (tenant_id, user_id, system_role_id, role_id) VALUES ($1,$2,'role_agent',$3)`, [A, U.a2, role], '23514'],
        [`INSERT INTO user_roles (tenant_id, user_id, system_role_id) VALUES ($1,$2,'role_inexistente')`, [A, U.a2], '23503'],
      ]) {
        await c.query('SAVEPOINT s');
        assert.equal(await sqlstate(c.query(sql, params)), code, sql);
        await c.query('ROLLBACK TO s');
      }
    });
  });

  // ------------------------------------------------------------------ shares, approvals, CHECKs
  test('resource_shares: CASCADE com o recurso e com o usuário; unicidade; enums', async () => {
    await asA(async (c) => {
      const deal = (await c.query(`INSERT INTO deals (tenant_id, title) VALUES ($1,'comp') RETURNING id`, [A])).rows[0].id;
      const share = (subj, type, level = 'read') =>
        c.query(`INSERT INTO resource_shares (tenant_id, entity, resource_id, subject_type, subject_id, level, created_by) VALUES ($1,'deal',$2,$3,$4,$5,$6)`, [A, deal, type, subj, level, U.a1]);
      await share(U.a2, 'user');
      await share(T.G1, 'team', 'edit');
      for (const [sql, params, code] of [
        [`INSERT INTO resource_shares (tenant_id, entity, resource_id, subject_type, subject_id, level) VALUES ($1,'deal',$2,'user',$3,'read')`, [A, deal, U.a2], '23505'],
        [`INSERT INTO resource_shares (tenant_id, entity, resource_id, subject_type, subject_id, level) VALUES ($1,'deal',$2,'user',$3,'owner')`, [A, deal, U.a3], '23514'],
        [`INSERT INTO resource_shares (tenant_id, entity, resource_id, subject_type, subject_id, level) VALUES ($1,'task',$2,'user',$3,'read')`, [A, deal, U.a3], '23514'],
        [`INSERT INTO resource_shares (tenant_id, entity, resource_id, subject_type, subject_id, level) VALUES ($1,'deal',$2,'group',$3,'read')`, [A, deal, U.a3], '23514'],
        [`INSERT INTO resource_shares (tenant_id, entity, resource_id, subject_type, subject_id, level) VALUES ($1,'deal',$2,'user',$3,'read')`, [A, nu(), U.a3], '23503'], // recurso inexistente
        [`INSERT INTO resource_shares (tenant_id, entity, resource_id, subject_type, subject_id, level) VALUES ($1,'deal',$2,'team',$3,'read')`, [A, deal, U.a3], '23503'], // user_id usado como team
      ]) {
        await c.query('SAVEPOINT s');
        assert.equal(await sqlstate(c.query(sql, params)), code, sql);
        await c.query('ROLLBACK TO s');
      }
      assert.equal((await c.query('SELECT count(*)::int n FROM resource_shares WHERE resource_id=$1', [deal])).rows[0].n, 2);
      await c.query('DELETE FROM deals WHERE id = $1', [deal]);
      assert.equal((await c.query('SELECT count(*)::int n FROM resource_shares WHERE resource_id=$1', [deal])).rows[0].n, 0);
    });
  });

  test('approvals: ninguém aprova o próprio pedido; decisão exige decisor e data', async () => {
    await asA(async (c) => {
      const ins = (status, decidedBy, decidedAt) =>
        c.query(`INSERT INTO approvals (tenant_id, entity, action, context, requested_by, status, decided_by, decided_at) VALUES ($1,'proposal','update','{"discountPct":12}',$2,$3,$4,$5) RETURNING id`, [A, U.a1, status, decidedBy, decidedAt]);
      await ins('pending', null, null);
      await ins('approved', U.a2, new Date('2026-10-09T00:00:00Z'));
      for (const [status, by, at] of [['approved', U.a1, new Date('2026-10-09T00:00:00Z')], ['approved', null, null], ['rejected', U.a2, null], ['talvez', null, null]]) {
        await c.query('SAVEPOINT s');
        assert.equal(await sqlstate(ins(status, by, at)), '23514', `${status}/${by}`);
        await c.query('ROLLBACK TO s');
      }
    });
  });

  test('CHECKs de formato: telefone, e-mail, CPF/CNPJ, status, valores e enums', async () => {
    await asA(async (c) => {
      const bad = [
        [`INSERT INTO contacts (tenant_id, name, phone) VALUES ($1,'x','abc')`], [`INSERT INTO contacts (tenant_id, name, phone) VALUES ($1,'x','123')`],
        [`INSERT INTO contacts (tenant_id, name, email) VALUES ($1,'x','sem-arroba')`], [`INSERT INTO contacts (tenant_id, name, document) VALUES ($1,'x','123456789012')`],
        [`INSERT INTO contacts (tenant_id, name, status) VALUES ($1,'x','Ativo')`], [`INSERT INTO contacts (tenant_id, name) VALUES ($1,'   ')`],
        [`INSERT INTO deals (tenant_id, title, value) VALUES ($1,'x',-1)`], [`INSERT INTO deals (tenant_id, title, discount) VALUES ($1,'x',101)`],
        [`INSERT INTO deals (tenant_id, title, status) VALUES ($1,'x','perdido')`], [`INSERT INTO deals (tenant_id, title, items) VALUES ($1,'x','{}')`],
        [`INSERT INTO calls (tenant_id, direction) VALUES ($1,'sideways')`], [`INSERT INTO users (tenant_id, email, name) VALUES ($1,'a1@X.com','dup')`], // e-mail único sem caixa
        [`INSERT INTO tenants (name, slug) VALUES ('x','Slug Inválido')`],
      ];
      for (const [sql] of bad) {
        await c.query('SAVEPOINT s');
        const code = await sqlstate(c.query(sql, sql.includes('$1') ? [A] : []));
        assert.ok(['23514', '23505', '42501'].includes(code), `${sql} -> ${code}`);
        await c.query('ROLLBACK TO s');
      }
      await c.query(`INSERT INTO contacts (tenant_id, name, phone, email, document, status, source) VALUES ($1,'ok','+5511999998888','a@b.co','12345678000199','lead_quente','whatsapp')`, [A]);
    });
  });

  // ------------------------------------------------------------------ camada 2 dirigida
  describe('RLS camada 2 (escopo grosso de leitura)', () => {
    const D = {};
    before(async () => {
      Object.assign(D, { d1: nu(), d2: nu(), d3: nu(), d4: nu(), c1: nu(), c2: nu(), v1: nu(), v2: nu() });
      await adminTx(h.admin, A, async (c) => {
        const deal = (id, owner, team) => c.query(`INSERT INTO deals (id, tenant_id, owner_id, team_id, title) VALUES ($1,$2,$3,$4,'d')`, [id, A, owner, team]);
        await deal(D.d1, U.a1, null); // meu
        await deal(D.d2, U.a2, T.G1); // da equipe G1
        await deal(D.d3, null, T.R); // sem dono, equipe raiz
        await deal(D.d4, U.a3, null); // alheio, sem equipe
        await c.query(`INSERT INTO contacts (id, tenant_id, owner_id, team_id, name) VALUES ($1,$3,$4,NULL,'c1'), ($2,$3,$5,$6,'c2')`, [D.c1, D.c2, A, U.a1, U.a2, T.GG1]);
        await c.query(`INSERT INTO conversations (id, tenant_id, owner_id, assignee_id, team_id) VALUES ($1,$3,$4,$5,NULL), ($2,$3,$5,NULL,$6)`, [D.v1, D.v2, A, U.a2, U.a1, T.G1]);
        await c.query(`INSERT INTO companies (tenant_id, name) VALUES ($1,'comp-visivel')`, [A]);
      });
    });
    const ids = async (opts, table = 'deals') => (await asA((c) => c.query(`SELECT id FROM ${table}`), opts)).rows.map((r) => r.id).sort();
    const names = (...k) => k.map((x) => D[x]).sort();

    test('own / team / team_tree / tenant / none', async () => {
      assert.deepEqual(await ids({ readScopes: { deals: 'own' } }), names('d1'));
      assert.deepEqual(await ids({ readScopes: { deals: 'none' } }), []);
      assert.deepEqual(await ids({ readScopes: { deals: 'team' }, userId: U.a1, teamIds: [T.G1] }), names('d1', 'd2'));
      assert.deepEqual(await ids({ readScopes: { deals: 'team' }, userId: U.a1, teamIds: [T.C1] }), names('d1')); // team NÃO expande subárvore
      assert.deepEqual(await ids({ readScopes: { deals: 'team_tree' }, userId: U.a1, teamIds: [T.C1], teamTreeIds: [T.C1, T.G1, T.G2, T.GG1] }), names('d1', 'd2'));
      assert.deepEqual(await ids({ readScopes: { deals: 'team_tree' }, userId: U.a1, teamIds: [T.R], teamTreeIds: [T.R, T.C1, T.G1] }), names('d1', 'd2', 'd3'));
      assert.deepEqual(await ids({ readScopes: { deals: 'tenant' } }), names('d1', 'd2', 'd3', 'd4'));
      // conversation: o dono é assignee_id (não owner_id)
      assert.deepEqual(await ids({ readScopes: { conversations: 'own' }, userId: U.a1 }, 'conversations'), names('v1'));
      assert.deepEqual(await ids({ readScopes: { conversations: 'own' }, userId: U.a2 }, 'conversations'), []); // a2 é owner_id de v1, mas não assignee
    });

    test('falha fechado: escopo ausente, vazio ou desconhecido = nenhuma linha; tabela sem camada 2 não é afetada', async () => {
      assert.deepEqual(await ids({ readScopes: undefined }), []);
      assert.deepEqual(await ids({ readScopes: {} }, 'contacts'), []);
      const c = await app.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.user_id',$2,true), set_config('app.read_scope_deals','superadmin',true)`, [A, U.a1]);
        assert.equal((await c.query('SELECT count(*)::int n FROM deals')).rows[0].n, 0);
        await c.query('ROLLBACK');
      } finally {
        c.release();
      }
      assert.equal((await ids({ readScopes: {} }, 'companies')).length, 1); // companies: só isolamento de tenant
    });

    test('compartilhamento amplia o teto: usuário direto e equipe (com subárvore, como no motor)', async () => {
      await adminTx(h.admin, A, async (c) => {
        await c.query(`INSERT INTO resource_shares (tenant_id, entity, resource_id, subject_type, subject_id, level) VALUES ($1,'deal',$2,'user',$3,'read')`, [A, D.d4, U.a1]);
        await c.query(`INSERT INTO resource_shares (tenant_id, entity, resource_id, subject_type, subject_id, level) VALUES ($1,'deal',$2,'team',$3,'edit')`, [A, D.d3, T.G1]);
        await c.query(`INSERT INTO resource_shares (tenant_id, entity, resource_id, subject_type, subject_id, level) VALUES ($1,'contact',$2,'team',$3,'read')`, [A, D.c1, T.G1]);
      });
      try {
        // own + share de usuário
        assert.deepEqual(await ids({ readScopes: { deals: 'own' }, userId: U.a1 }), names('d1', 'd4'));
        // usuário em G1 (diretas) com subárvore [G1, GG1]: share de equipe G1 vale
        assert.deepEqual(await ids({ readScopes: { deals: 'own' }, userId: U.a3, teamIds: [T.G1], teamTreeIds: [T.G1, T.GG1] }), names('d3', 'd4'));
        // usuário só em GG1 (filha de G1): share em G1 (pai) NÃO o alcança
        assert.deepEqual(await ids({ readScopes: { deals: 'none' }, userId: U.a2, teamIds: [T.GG1], teamTreeIds: [T.GG1] }), []);
        // usuário em C1 (pai de G1): subárvore inclui G1 => vê d3
        assert.deepEqual(await ids({ readScopes: { deals: 'none' }, userId: U.a2, teamIds: [T.C1], teamTreeIds: [T.C1, T.G1, T.G2, T.GG1] }), names('d3'));
        assert.deepEqual(await ids({ readScopes: { contacts: 'none' }, userId: U.a2, teamIds: [T.G1], teamTreeIds: [T.G1, T.GG1] }, 'contacts'), names('c1'));
        // conversas não são compartilháveis: share não existe para elas
        assert.deepEqual(await ids({ readScopes: { conversations: 'none' }, userId: U.a2 }, 'conversations'), []);
      } finally {
        await adminTx(h.admin, A, (c) => c.query('DELETE FROM resource_shares WHERE tenant_id = $1', [A]));
      }
    });

    test('escrita: o teto de leitura também limita UPDATE/DELETE de linhas fora do escopo (documentado)', async () => {
      await asA(async (c) => {
        assert.equal((await c.query(`UPDATE deals SET title = 'x' WHERE id = $1`, [D.d4])).rowCount, 0);
        assert.equal((await c.query(`DELETE FROM deals WHERE id = $1`, [D.d4])).rowCount, 0);
        // INSERT ... RETURNING de linha fora do próprio escopo falha: o escopo precisa cobrir o que a ação cria
        await c.query('SAVEPOINT s');
        assert.equal(await sqlstate(c.query(`INSERT INTO deals (tenant_id, owner_id, title) VALUES ($1,$2,'x') RETURNING id`, [A, U.a3])), '42501');
        await c.query('ROLLBACK TO s');
        assert.equal((await c.query(`INSERT INTO deals (tenant_id, owner_id, title) VALUES ($1,$2,'x') RETURNING id`, [A, U.a1])).rowCount, 1);
      }, { readScopes: { deals: 'own' } });
    });
  });

  // ------------------------------------------------------------------ withTenant
  describe('withTenant', () => {
    test('COMMIT persiste; erro no callback faz ROLLBACK e relança o erro original; client sempre devolvido ao pool', async () => {
      const pool = h.appPool({ max: 2 });
      const mine = () => withTenant(pool, ctx(A, { readScopes: 'tenant' }), (c) => c.query(`SELECT count(*)::int n FROM tasks WHERE title = 'persist-test'`));
      await withTenant(pool, ctx(A), (c) => c.query(`INSERT INTO tasks (tenant_id, owner_id, title) VALUES ($1,$2,'persist-test')`, [A, U.a1]));
      assert.equal((await mine()).rows[0].n, 1);
      const boom = new Error('falha de negócio');
      await assert.rejects(
        withTenant(pool, ctx(A), async (c) => {
          await c.query(`INSERT INTO tasks (tenant_id, owner_id, title) VALUES ($1,$2,'persist-test')`, [A, U.a1]);
          throw boom;
        }),
        (e) => e === boom
      );
      assert.equal((await mine()).rows[0].n, 1, 'inserção do callback que falhou deveria ter sido revertida');
      // erro SQL no meio (transação abortada) também reverte e libera
      await assert.rejects(withTenant(pool, ctx(A), async (c) => { await c.query('SELECT * FROM tabela_inexistente'); }), /tabela_inexistente/);
      assert.equal(pool.totalCount, pool.idleCount, 'client vazou (não devolvido ao pool)');
      assert.equal(pool.waitingCount, 0);
    });

    test('release: sucesso e erro liberam; ROLLBACK que falha DESCARTA a conexão (release(true))', async () => {
      const calls = [];
      const mkClient = (failRollback) => ({
        query: async (sql) => {
          calls.push(String(sql).split(/\s/)[0]);
          if (failRollback && sql === 'ROLLBACK') throw new Error('rollback quebrou');
          return { rows: [] };
        },
        release: (d) => calls.push('release:' + String(d)),
      });
      await withTenant({ connect: async () => mkClient(false) }, { tenantId: A }, async () => 1);
      assert.deepEqual(calls.filter((c) => c === 'COMMIT' || c.startsWith('release')), ['COMMIT', 'release:false']);
      calls.length = 0;
      await assert.rejects(withTenant({ connect: async () => mkClient(false) }, { tenantId: A }, async () => { throw new Error('x'); }), /x/);
      assert.deepEqual(calls.filter((c) => c === 'ROLLBACK' || c.startsWith('release')), ['ROLLBACK', 'release:false']);
      calls.length = 0;
      await assert.rejects(withTenant({ connect: async () => mkClient(true) }, { tenantId: A }, async () => { throw new Error('y'); }), /y/);
      assert.deepEqual(calls.filter((c) => c.startsWith('release')), ['release:true']);
    });

    test('readOnly bloqueia escrita; userId é opcional (job de sistema); UUID em maiúsculas é normalizado', async () => {
      await withTenant(app, { tenantId: A, readScopes: 'tenant', readOnly: true }, async (c) => {
        await c.query('SAVEPOINT s');
        assert.equal(await sqlstate(c.query(`INSERT INTO tasks (tenant_id, title) VALUES ($1,'x')`, [A])), '25006');
        await c.query('ROLLBACK TO s');
        assert.ok((await c.query('SELECT count(*)::int n FROM deals')).rows[0].n > 0);
      });
      const { rows } = await withTenant(app, { tenantId: A.toUpperCase(), userId: U.a1.toUpperCase() }, (c) => c.query(`SELECT current_setting('app.tenant_id') t, current_setting('app.user_id') u, current_setting('app.team_ids') tm`));
      assert.deepEqual(rows[0], { t: A, u: U.a1, tm: '{}' });
    });

    test('isolamento entre chamadas concorrentes de tenants diferentes no mesmo pool (sem vazamento de contexto)', async () => {
      const pool = h.appPool({ max: 3 });
      const jobs = [];
      for (let i = 0; i < 60; i++) {
        const tid = i % 2 ? A : B;
        jobs.push(withTenant(pool, { tenantId: tid, readScopes: 'tenant' }, async (c) => {
          await c.query('SELECT pg_sleep(0.005)');
          return (await c.query('SELECT DISTINCT tenant_id FROM users')).rows.map((r) => r.tenant_id);
        }).then((r) => assert.deepEqual(r, [tid])));
      }
      await Promise.all(jobs);
    });
  });
});
