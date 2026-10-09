// Ponto de entrada do módulo de permissões (isomórfico: navegador e Node).
export * from './catalog.js';
export * from './expr.js';
export * from './engine.js';
export * from './roles.js';
export * from './validate.js';

import { systemRoleMap } from './roles.js';

/**
 * Monta o contexto que o motor consome. `roles` = mapa id -> perfil (sistema +
 * do tenant); `org` = { teams:[{id,parentId}] }; `policy` = política do tenant
 * ({ requireMfaForSensitive }).
 */
export function createContext({ subject, tenantRoles = [], org = { teams: [] }, policy = {} }) {
  const roles = systemRoleMap();
  for (const r of Array.isArray(tenantRoles) ? tenantRoles : []) {
    // Perfil de tenant não pode ser "de sistema", sem dono, de outro tenant nem
    // reaproveitar o id de um perfil de sistema (senão sobrescreveria o Admin).
    // (r nulo e tenantId nulo/ausente também são recusados: antes `undefined === undefined`
    // deixava passar um perfil sem dono quando o usuário também não tinha tenant.)
    if (!r || typeof r !== 'object' || r.system || r.tenantId == null || r.tenantId !== subject?.tenantId || roles.has(r.id)) continue;
    roles.set(r.id, r);
  }
  return { subject, roles, org, policy };
}
