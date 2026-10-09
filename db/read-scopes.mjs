// Calcula o teto grosso de leitura (RLS camada 2) a partir do MOTOR — nunca de
// outra lógica. Resultado: { deals, contacts, conversations } com o valor de
// app.read_scope_<tabela> (ver withTenant em src/db-tenant.js).
//
// Regra: o MAIOR escopo que QUALQUER grant (de qualquer ação, perfil ou override)
// dá ao usuário sobre a entidade, ignorando condições/partições/negações/MFA, que
// só restringem. Resultado = superset do motor por construção (e o teste
// diferencial em test/permissions-sql prova). Usuário inativo => 'none'.
import { ENTITIES, SCOPES, scopeRank } from '../shared/permissions/catalog.js';
import { effectiveRoles } from '../shared/permissions/engine.js';

/** entidade do catálogo -> tabela com política read_scope. Derivado do catálogo. */
export const RLS_SCOPED_ENTITIES = ['deal', 'contact', 'conversation'];

export function readScopesFor(ctx) {
  const out = {};
  const active = ctx.subject?.status === 'active';
  const sources = [...effectiveRoles(ctx).map((r) => r.grants || []), ctx.subject?.overrides?.grants || []];
  for (const name of RLS_SCOPED_ENTITIES) {
    let best = 'none';
    if (active) {
      for (const grants of sources) {
        for (const g of grants) {
          if (g.entity !== name && g.entity !== '*') continue;
          if (!SCOPES.includes(g.scope)) continue;
          if (scopeRank(g.scope) > scopeRank(best)) best = g.scope;
        }
      }
    }
    out[ENTITIES[name].table] = best;
  }
  return out;
}
