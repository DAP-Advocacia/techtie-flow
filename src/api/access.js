'use strict';
// Acesso do usuário NO SERVIDOR: carrega perfis, equipes e política do banco e monta o contexto
// do motor de permissões (shared/permissions). É o equivalente de public/js/access.js, só que
// com dados reais. Toda decisão de acesso da API passa por aqui — o front é apenas reflexo.
const { withTenant } = require('../db-tenant');

let enginePromise;
/** O motor é ESM (roda também no navegador); o backend é CommonJS, então importa dinamicamente. */
function engine() {
  enginePromise ||= Promise.all([import('../../shared/permissions/index.js'), import('../../db/read-scopes.mjs')]).then(([E, R]) => ({ ...E, readScopesFor: R.readScopesFor }));
  return enginePromise;
}

// Cache curto: várias requisições seguidas do mesmo usuário (a tela dispara várias) reusam o
// contexto. 5 s é curto o bastante para mudança de perfil/suspensão valer quase na hora.
// No backend de produção o certo é a "versão de permissão" por usuário (docs/permissoes.md §7).
const TTL_MS = 5000;
const cache = new Map();
const pending = new Map();

async function loadAccess(pool, { userId, tenantId }) {
  const E = await engine();
  const d = await withTenant(pool, { tenantId, userId, readScopes: 'tenant', readOnly: true }, async (c) => {
    const user = (await c.query('SELECT id, tenant_id, email, name, status, mfa_enabled, overrides FROM users WHERE id = $1', [userId])).rows[0];
    if (!user) return null;
    return {
      user,
      userRoles: (await c.query('SELECT system_role_id, role_id FROM user_roles WHERE user_id = $1', [userId])).rows,
      roles: (await c.query('SELECT id, name, description, definition FROM roles')).rows,
      teams: (await c.query('SELECT id, parent_id FROM teams')).rows,
      myTeams: (await c.query('SELECT team_id FROM team_members WHERE user_id = $1', [userId])).rows,
      tenant: (await c.query('SELECT id, name, settings FROM tenants WHERE id = $1', [tenantId])).rows[0],
    };
  });
  if (!d) return null;

  const teamIds = d.myTeams.map((r) => r.team_id);
  const org = { teams: d.teams.map((t) => ({ id: t.id, parentId: t.parent_id })) };
  const subject = {
    id: d.user.id,
    tenantId,
    status: d.user.status,
    roleIds: d.userRoles.map((r) => r.system_role_id || r.role_id),
    teamIds,
    mfa: d.user.mfa_enabled === true,
    overrides: d.user.overrides && typeof d.user.overrides === 'object' ? d.user.overrides : {},
  };
  const tenantRoles = d.roles.map((r) => ({ ...r.definition, id: r.id, name: r.name, description: r.description || '', tenantId, system: false }));
  const ctx = E.createContext({ subject, tenantRoles, org, policy: d.tenant?.settings || {} });
  return {
    E,
    ctx,
    tenantId,
    userId,
    user: { id: d.user.id, name: d.user.name, email: d.user.email, status: d.user.status },
    tenant: d.tenant,
    teamIds,
    teamTreeIds: E.expandTeams(org, teamIds),
    readScopes: E.readScopesFor(ctx),
    roleDefs: tenantRoles,
  };
}

/** Acesso do usuário (com cache curto). Devolve null se o usuário não existe neste tenant. */
async function getAccess(pool, key) {
  const k = `${key.tenantId}:${key.userId}`;
  const hit = cache.get(k);
  if (hit && hit.exp > Date.now()) return hit.value;
  if (!pending.has(k)) {
    pending.set(
      k,
      loadAccess(pool, key)
        .then((value) => {
          cache.set(k, { value, exp: Date.now() + TTL_MS });
          if (cache.size > 2000) for (const [ck, cv] of cache) if (cv.exp < Date.now()) cache.delete(ck);
          return value;
        })
        .finally(() => pending.delete(k))
    );
  }
  return pending.get(k);
}

/** Descarta o cache de um usuário (após mudar perfil/status). */
const invalidate = (tenantId, userId) => cache.delete(`${tenantId}:${userId}`);

/** Abre transação COM o contexto do usuário (RLS de tenant + teto de leitura por escopo). */
function tx(pool, access, fn, { readOnly = false } = {}) {
  return withTenant(pool, { tenantId: access.tenantId, userId: access.userId, teamIds: access.teamIds, teamTreeIds: access.teamTreeIds, readScopes: access.readScopes, readOnly }, fn);
}

/** WHERE (parametrizado) que o motor gera para listar `entityName` com a ação dada. */
function listWhere(access, entityName, action = 'read', alias = 't') {
  const { expr, entity, blocked } = access.E.filterFor(access.ctx, entityName, action);
  if (blocked) return { sql: 'FALSE', params: [] };
  return access.E.toSql(expr, entity, { alias });
}

/** true se o usuário pode executar a ação em ALGUM registro da entidade (menu/rota). */
function canAccess(access, entityName, action = 'read') {
  return access.E.filterFor(access.ctx, entityName, action).expr.t !== 'false';
}

module.exports = { engine, getAccess, invalidate, tx, listWhere, canAccess };
