'use strict';
// Executa trabalho no Postgres COM o contexto de tenant/usuário aplicado.
//
// Por que existe: o isolamento de tenant (RLS — db/migrations/0001_permissions.sql)
// lê app.tenant_id & cia. do set_config da TRANSAÇÃO. Com PgBouncer em modo
// transação (pooler do Supabase, porta 6543) a conexão física é trocada a cada
// transação, então só set_config(..., true) — local à transação — é seguro:
// nada vaza para o próximo cliente do pool, mesmo se algo falhar no meio.
//
// Uso:
//   await withTenant(pool, { tenantId, userId, teamIds, teamTreeIds, readScopes }, async (client) => {
//     const { rows } = await client.query('SELECT id FROM deals t WHERE ' + sql, params);
//   });
//
// readScopes: { deals:'team_tree', contacts:'own', conversations:'tenant' } (calculado por
// db/read-scopes.mjs a partir do motor) ou a string 'tenant' (atalho para jobs de sistema,
// que enxergam todo o tenant). SEM readScopes as tabelas da camada 2 ficam VAZIAS (falha fechado).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCOPES = new Set(['none', 'own', 'team', 'team_tree', 'tenant']);
// Tabelas com política read_scope na migração. Chave = nome da tabela.
const SCOPED_TABLES = ['deals', 'contacts', 'conversations'];

const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

function uuidList(name, list) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw new TypeError(`withTenant: ${name} deve ser um array de UUIDs`);
  for (const id of list) if (!isUuid(id)) throw new TypeError(`withTenant: ${name} contém UUID inválido`);
  return [...new Set(list.map((s) => s.toLowerCase()))];
}

const pgArray = (ids) => '{' + ids.join(',') + '}';

/** Valida tudo ANTES de abrir conexão. Devolve os valores prontos para o set_config. */
function buildContext({ tenantId, userId, teamIds, teamTreeIds, readScopes } = {}) {
  if (!isUuid(tenantId)) throw new TypeError('withTenant: tenantId deve ser um UUID');
  if (userId != null && !isUuid(userId)) throw new TypeError('withTenant: userId deve ser um UUID');
  const teams = uuidList('teamIds', teamIds);
  // A árvore SEMPRE contém as equipes diretas (superset do motor); se a app não
  // informar a árvore, o teto de RLS fica restrito às equipes diretas.
  const tree = uuidList('teamTreeIds', [...teams, ...(teamTreeIds || [])]);

  const scopes = [];
  const entries = typeof readScopes === 'string' ? SCOPED_TABLES.map((t) => [t, readScopes]) : Object.entries(readScopes || {});
  for (const [table, scope] of entries) {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(table)) throw new TypeError('withTenant: nome de tabela inválido em readScopes');
    if (!SCOPES.has(scope)) throw new TypeError(`withTenant: escopo inválido para ${table}`);
    scopes.push([`app.read_scope_${table}`, scope]);
  }
  return {
    tenantId: tenantId.toLowerCase(),
    userId: userId ? userId.toLowerCase() : '',
    teams: pgArray(teams),
    tree: pgArray(tree),
    scopeKeys: scopes.map((s) => s[0]),
    scopeVals: scopes.map((s) => s[1]),
  };
}

/**
 * Abre transação, aplica o contexto LOCAL, roda `fn(client)` e faz COMMIT; em erro faz
 * ROLLBACK e relança o erro original. Sempre libera o client (descartando-o se o
 * ROLLBACK falhar, para uma conexão em estado duvidoso nunca voltar ao pool).
 * `readOnly: true` abre a transação como READ ONLY.
 */
async function withTenant(pool, ctx, fn) {
  if (typeof fn !== 'function') throw new TypeError('withTenant: callback obrigatório');
  const c = buildContext(ctx);
  const client = await pool.connect();
  let destroy = false;
  try {
    await client.query(ctx.readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
    // Um único round-trip; todos os valores são PARÂMETROS (nada interpolado).
    await client.query(
      `SELECT set_config('app.tenant_id', $1, true),
              set_config('app.user_id', $2, true),
              set_config('app.team_ids', $3, true),
              set_config('app.team_tree_ids', $4, true),
              (SELECT count(set_config(s.k, s.v, true)) FROM unnest($5::text[], $6::text[]) AS s(k, v))`,
      [c.tenantId, c.userId, c.teams, c.tree, c.scopeKeys, c.scopeVals]
    );
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      destroy = true;
    }
    throw err;
  } finally {
    client.release(destroy);
  }
}

module.exports = { withTenant, isUuid, SCOPED_TABLES };
