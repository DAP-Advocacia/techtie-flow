// Ponte entre o store do protótipo e o motor de permissões (shared/permissions).
// No backend real isto não existe: a API monta o contexto a partir do banco e
// chama o MESMO motor. Aqui só adaptamos o formato do mock:
//  - decora cada registro com os atributos que o motor exige (tenantId, teamId, status…);
//  - monta o contexto (perfis, organograma, política) do usuário atual;
//  - guarda um cache que é descartado a cada mudança do store (equivale à "versão de
//    permissão" do backend: mudou perfil/equipe/status → recalcula).
import {
  createContext,
  decide as engineDecide,
  filterFor,
  toPredicate,
  maskRow,
  fieldAccess,
  explain as engineExplain,
  effectiveMatrix,
  ENTITIES,
} from '/shared/permissions/index.js';
import { store } from './store.js';

let cache = new Map();
store.subscribe(() => {
  cache = new Map();
});

/** Contexto do motor para `userId` (padrão: usuário logado). */
export function ctxFor(userId = store.state.currentUserId) {
  const key = `ctx:${userId}`;
  if (cache.has(key)) return cache.get(key);
  const s = store.state;
  const user = s.users.find((u) => u.id === userId);
  const ctx = createContext({
    // usuário desconhecido = sem papéis e inativo (falha fechado)
    subject: user ? { ...user, roleIds: user.roleIds || [], teamIds: user.teamIds || [] } : { id: userId, tenantId: s.tenant.id, status: 'inactive', roleIds: [], teamIds: [] },
    tenantRoles: s.roles.filter((r) => !r.system),
    org: { teams: s.teams.map((t) => ({ id: t.id, parentId: t.parentId || null })) },
    policy: s.tenant.policy || {},
  });
  cache.set(key, ctx);
  return ctx;
}

const teamOf = (state, userId) => state.users.find((u) => u.id === userId)?.teamIds?.[0] ?? null;

/** Registro do mock → formato do motor (mesmos campos que existiriam nas colunas do banco). */
export function aclRow(entity, row, state = store.state) {
  if (!row) return row;
  const base = { ...row, tenantId: row.tenantId ?? state.tenant.id };
  switch (entity) {
    case 'contact':
    case 'company':
      return { ...base, teamId: base.teamId ?? teamOf(state, row.ownerId) };
    case 'deal': {
      const kind = state.pipelines.flatMap((p) => p.stages).find((st) => st.id === row.stageId)?.kind;
      return { ...base, teamId: base.teamId ?? teamOf(state, row.ownerId), status: kind === 'won' ? 'won' : kind === 'lost' ? 'lost' : 'open' };
    }
    case 'conversation':
      return { ...base, teamId: base.teamId ?? (row.assigneeId ? teamOf(state, row.assigneeId) : null), assigneeId: row.assigneeId ?? null };
    default:
      return base;
  }
}

/** Decisão (3 estados) do usuário atual sobre um registro. Registro null = só tenant. */
export function decide(entity, action, row, context, userId) {
  return engineDecide(ctxFor(userId), entity, action, row ? aclRow(entity, row) : { tenantId: store.state.tenant.id }, context);
}

/** true só se permitido direto (aprovação pendente não conta). */
export const can = (entity, action, row, context, userId) => decide(entity, action, row, context, userId).effect === 'allow';

/** Permitido direto ou mediante aprovação (habilitar o botão com aviso). */
export const canOrRequest = (entity, action, row, context, userId) => decide(entity, action, row, context, userId).effect !== 'deny';

/** Lista filtrada pelas permissões do usuário (equivale ao WHERE compilado no backend). */
export function visible(entity, rows, action = 'read', userId) {
  const key = `f:${userId ?? store.state.currentUserId}:${entity}:${action}`;
  if (!cache.has(key)) cache.set(key, toPredicate(filterFor(ctxFor(userId), entity, action).expr));
  const pred = cache.get(key);
  return rows.filter((r) => pred(aclRow(entity, r)));
}

/**
 * O usuário pode (em tese) executar a ação em ALGUM registro da entidade? Serve
 * para menu e rota — onde não há registro. Diferente de can(): um Atendente
 * "pode ler negócios" (os próprios) mesmo sem um negócio específico em mãos.
 */
export function canAccess(entity, action = 'read', userId) {
  const key = `a:${userId ?? store.state.currentUserId}:${entity}:${action}`;
  if (!cache.has(key)) cache.set(key, filterFor(ctxFor(userId), entity, action).expr.t !== 'false');
  return cache.get(key);
}

/** Acesso a um campo do usuário atual: 'write' | 'readonly' | 'hidden'. */
export function fieldLevel(entity, field, userId) {
  return fieldAccess(ctxFor(userId), entity)[field] || 'write';
}

/** Cópia do registro sem os campos ocultos (use ao exibir). */
export const mask = (entity, row, userId) => maskRow(ctxFor(userId), entity, row);

/** Explicação ramo a ramo (por que posso / não posso). */
export const explain = (entity, action, row, context, userId) =>
  engineExplain(ctxFor(userId), entity, action, row ? aclRow(entity, row) : { tenantId: store.state.tenant.id }, context);

/** Resumo entidade × ação do usuário (simulador). */
export const matrixFor = (userId) => effectiveMatrix(ctxFor(userId));

export const ENTITY_NAMES = Object.keys(ENTITIES);

/** Texto curto do motivo de uma negação, para toasts e dicas. */
export function denyMessage(decision) {
  switch (decision.reason) {
    case 'denied':
      return 'Uma regra do seu perfil bloqueia esta ação.';
    case 'no_grant':
      return 'Seu perfil não permite esta ação neste registro.';
    case 'mfa_required':
      return 'Ação sensível: ative a verificação em duas etapas (MFA).';
    case 'subject_inactive':
      return 'Seu acesso está inativo.';
    case 'tenant_mismatch':
      return 'Registro de outra empresa.';
    case 'needs_approval':
      return 'Esta ação precisa da aprovação de um gestor.';
    default:
      return 'Ação não permitida.';
  }
}

/** Registra evento de auditoria no store (no backend: INSERT em audit_log). */
export function audit(action, target, detail) {
  store.update((s) => {
    s.auditLog.unshift({ id: `ev${Date.now().toString(36)}${s.auditLog.length}`, at: Date.now(), actorId: s.currentUserId, action, target, detail });
  });
}
