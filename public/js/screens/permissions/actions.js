// "Camada de serviço" do protótipo: toda mudança de perfil, usuário e política
// passa por aqui. Cada operação RE-VALIDA tudo no motor (decide, validateRole,
// checkNoEscalation, wouldRemoveLastAdmin) antes de gravar — no backend real
// este é o handler da API; a UI só chama e reflete o resultado. Por isso os
// botões desabilitados são cortesia: se alguém forçar a chamada, o motor recusa.
//
// Cada mudança grava estado + evento de auditoria na MESMA store.update, para
// nunca existir mudança sem trilha (o helper audit() de access.js faria dois
// updates e só aceita texto; aqui o evento também leva o `diff` estruturado).
import { decide, ctxFor, denyMessage } from '../../access.js';
import { validateRole, isImmutableRole, wouldRemoveLastAdmin, auditEvent, diffRoles, checkNoEscalation } from '/shared/permissions/index.js';
import { normalizeRole, escalationViolations, violationText, blankRole, newRoleId } from './model.js';
import { slug } from './labels.js';

const ABILITY = {
  'role.read': 'ver perfis de acesso',
  'role.create': 'criar perfis de acesso',
  'role.update': 'editar perfis de acesso',
  'role.delete': 'excluir perfis de acesso',
  'role.assign': 'atribuir perfis a usuários',
  'user.create': 'convidar usuários',
  'user.update': 'alterar usuários (dados, status, MFA e equipes)',
  'user.delete': 'remover usuários',
  'tenant_settings.update': 'alterar a política de segurança da empresa',
  'audit_log.read': 'ver a auditoria',
};

/** O usuário logado pode (em tese) fazer entidade.ação? `hint` explica o porquê quando não. */
export function authority(entity, action) {
  const decision = decide(entity, action, null);
  const ok = decision.effect === 'allow';
  let hint = '';
  if (!ok) {
    const what = ABILITY[`${entity}.${action}`] || `${action} em ${entity}`;
    hint = decision.reason === 'no_grant' ? `Seu perfil não permite ${what}.` : denyMessage(decision);
  }
  return { ok, hint, decision };
}

const nextEventId = (log) => `ev${Date.now().toString(36)}${log.length}${Math.random().toString(36).slice(2, 5)}`;

/** Aplica `mutate` e registra o evento na mesma atualização do store. */
function commit(store, mutate, event) {
  store.update((s) => {
    mutate(s);
    s.auditLog.unshift({ id: nextEventId(s.auditLog), ...event, at: Date.now(), tenantId: s.tenant.id, actorId: s.currentUserId });
  });
}

const fail = (problems) => ({ ok: false, problems: [].concat(problems) });
const rolesMap = () => ctxFor().roles;

// ---------------------------------------------------------------------------
// Perfis
// ---------------------------------------------------------------------------

/**
 * Verificação (sem gravar) de um perfil que se quer salvar. `draft` =
 * { role (cópia de trabalho), base (perfil gravado ou null), cloneOf, isNew }.
 */
export function checkRoleSave(state, draft, id) {
  const problems = [];
  const auth = authority('role', draft.isNew ? 'create' : 'update');
  if (!auth.ok) problems.push(auth.hint);

  const stored = draft.isNew ? null : state.roles.find((r) => r.id === draft.base.id);
  if (!draft.isNew && !stored) problems.push('Este perfil não existe mais.');
  if (stored && isImmutableRole(stored)) problems.push('Perfil de fábrica não pode ser alterado — clone para personalizar.');

  const ids = { tenantId: state.tenant.id, id };
  const after = normalizeRole(draft.role, ids);
  const beforeSrc = draft.isNew ? draft.cloneOf : draft.base;
  const before = beforeSrc ? normalizeRole(beforeSrc, { tenantId: state.tenant.id, id: beforeSrc.id }) : null;

  const errors = validateRole(after);
  const dup = state.roles.some((r) => r.id !== id && r.name.trim().toLowerCase() === after.name.toLowerCase());
  if (after.name && dup) errors.push({ path: 'name', message: 'já existe um perfil com este nome' });

  const violations = escalationViolations(ctxFor(), after, draft.isNew ? null : before);
  // edição concorrente: o perfil gravado mudou depois que esta edição começou
  if (stored && JSON.stringify(normalizeRole(stored)) !== JSON.stringify(normalizeRole(draft.base))) {
    problems.push('Este perfil foi alterado por outra pessoa depois que você começou a editar. Descarte as alterações e abra de novo.');
  }
  // diffRoles não cobre a descrição (não muda o que o perfil pode): acrescenta para a revisão/auditoria
  const descChange = !draft.isNew && before && before.description !== after.description ? [{ type: 'changed', kind: 'description', before: before.description, after: after.description }] : [];
  const changes = [...diffRoles(before || blankRole(), after).filter((c) => !(draft.isNew && c.kind === 'name')), ...descChange];
  return { ok: !problems.length && !errors.length && !violations.length, problems, errors, violations, violationTexts: violations.map(violationText), after, before, changes };
}

/** Grava o perfil (novo ou existente) + auditoria. Devolve { ok, roleId } ou { ok:false, ... }. */
export function saveRole(store, draft) {
  const state = store.state;
  const id = draft.isNew ? newRoleId(draft.role.name, new Set(state.roles.map((r) => r.id))) : draft.base.id;
  const check = checkRoleSave(state, draft, id);
  if (!check.ok) return { ...check, ok: false };
  const { after, before } = check;
  const action = draft.isNew ? 'role.create' : 'role.update';
  const detail = draft.isNew
    ? `Perfil "${after.name}" criado${draft.cloneOf ? ` a partir de ${draft.cloneOf.name}` : ' em branco'}`
    : `Perfil "${after.name}" alterado — ${check.changes.length} ${check.changes.length === 1 ? 'mudança' : 'mudanças'}`;
  const evt = auditEvent({ at: Date.now(), tenantId: state.tenant.id, actorId: state.currentUserId, action, target: id, before: before || blankRole(), after });
  const diff = [...(evt.diff || []).filter((c) => !(draft.isNew && c.kind === 'name')), ...check.changes.filter((c) => c.kind === 'description')];
  commit(
    store,
    (s) => {
      const i = s.roles.findIndex((r) => r.id === id);
      if (i >= 0) s.roles[i] = after;
      else s.roles.push(after);
    },
    { action, target: id, detail, diff }
  );
  return { ok: true, roleId: id, id };
}

/** Quem usa o perfil (qualquer status). */
export const usersOfRole = (state, roleId) => state.users.filter((u) => (u.roleIds || []).includes(roleId));

export function checkRoleDelete(state, roleId) {
  const role = state.roles.find((r) => r.id === roleId);
  if (!role) return fail('Perfil não encontrado.');
  const auth = authority('role', 'delete');
  if (!auth.ok) return fail(auth.hint);
  if (isImmutableRole(role)) return fail('Perfis de fábrica não podem ser excluídos.');
  const users = usersOfRole(state, roleId);
  if (users.length) return { ok: false, problems: [`${users.length === 1 ? '1 usuário usa' : `${users.length} usuários usam`} este perfil (${users.map((u) => u.name).join(', ')}). Reatribua ${users.length === 1 ? 'essa pessoa' : 'essas pessoas'} a outro perfil antes de excluir.`], users };
  return { ok: true, problems: [], role };
}

export function deleteRole(store, roleId) {
  const check = checkRoleDelete(store.state, roleId);
  if (!check.ok) return check;
  commit(
    store,
    (s) => {
      s.roles = s.roles.filter((r) => r.id !== roleId);
    },
    { action: 'role.delete', target: roleId, detail: `Perfil "${check.role.name}" excluído` }
  );
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Usuários
// ---------------------------------------------------------------------------

const userOf = (state, id) => state.users.find((u) => u.id === id);

/** Pode o ator atribuir este perfil? (escalonamento) — devolve textos de violação. */
export function roleAssignProblems(roleId) {
  const role = rolesMap().get(roleId);
  if (!role) return ['Perfil inexistente ou de outra empresa.'];
  return checkNoEscalation(ctxFor(), role).violations.map(violationText);
}

/** Verifica (sem gravar) a troca de perfis de um usuário. */
export function checkUserRoles(state, userId, nextRoleIds) {
  const user = userOf(state, userId);
  if (!user || user.isBot) return fail('Este usuário não recebe perfis.');
  const auth = authority('role', 'assign');
  if (!auth.ok) return fail(auth.hint);
  const cur = user.roleIds || [];
  const added = nextRoleIds.filter((id) => !cur.includes(id));
  const removed = cur.filter((id) => !nextRoleIds.includes(id));
  const problems = [];
  for (const id of added) {
    const name = state.roles.find((r) => r.id === id)?.name || id;
    const v = roleAssignProblems(id);
    if (v.length) problems.push(`Não é possível atribuir "${name}": ${v[0].replace(/^Você não pode conceder: /, 'você não pode conceder ')}${v.length > 1 ? ` (+${v.length - 1})` : ''}.`);
  }
  if (wouldRemoveLastAdmin(state.users, rolesMap(), state.tenant.id, { userId, roleIds: nextRoleIds })) problems.push('Esta mudança deixaria a empresa sem nenhum administrador ativo.');
  else if (userId === state.currentUserId && removed.length) problems.push('Você não pode remover os próprios perfis — peça a outro administrador.');
  if (!added.length && !removed.length) problems.push('Nada mudou.');
  return { ok: !problems.length, problems, added, removed, user };
}

export function saveUserRoles(store, userId, nextRoleIds) {
  const check = checkUserRoles(store.state, userId, nextRoleIds);
  if (!check.ok) return check;
  const names = (ids) => ids.map((id) => store.state.roles.find((r) => r.id === id)?.name || id).join(', ') || 'nenhum';
  const detail = `Perfis de ${check.user.name}: ${names(check.user.roleIds || [])} → ${names(nextRoleIds)}`;
  commit(
    store,
    (s) => {
      userOf(s, userId).roleIds = [...nextRoleIds];
    },
    { action: 'role.assign', target: userId, detail }
  );
  return { ok: true };
}

export function checkUserStatus(state, userId, status) {
  const user = userOf(state, userId);
  if (!user || user.isBot) return fail('Este usuário não pode ser alterado.');
  const auth = authority('user', 'update');
  if (!auth.ok) return fail(auth.hint);
  const problems = [];
  if (status === 'suspended') {
    if (userId === state.currentUserId) problems.push('Você não pode suspender a si mesmo.');
    if (wouldRemoveLastAdmin(state.users, rolesMap(), state.tenant.id, { userId, status })) problems.push('Esta mudança deixaria a empresa sem nenhum administrador ativo.');
  }
  if (user.status === status) problems.push('O usuário já está neste status.');
  return { ok: !problems.length, problems, user };
}

export function setUserStatus(store, userId, status) {
  const check = checkUserStatus(store.state, userId, status);
  if (!check.ok) return check;
  commit(
    store,
    (s) => {
      userOf(s, userId).status = status;
    },
    { action: status === 'suspended' ? 'user.suspend' : 'user.reactivate', target: userId, detail: `${check.user.name} ${status === 'suspended' ? 'suspenso(a)' : 'reativado(a)'}` }
  );
  return { ok: true };
}

export function saveUserTeams(store, userId, teamIds) {
  const state = store.state;
  const user = userOf(state, userId);
  if (!user || user.isBot) return fail('Este usuário não pode ser alterado.');
  const auth = authority('user', 'update');
  if (!auth.ok) return fail(auth.hint);
  if (teamIds.some((id) => !state.teams.some((t) => t.id === id))) return fail('Equipe inexistente.');
  const same = JSON.stringify([...teamIds].sort()) === JSON.stringify([...(user.teamIds || [])].sort());
  if (same) return fail('Nada mudou.');
  const names = (ids) => ids.map((id) => state.teams.find((t) => t.id === id)?.name || id).join(', ') || 'nenhuma';
  commit(
    store,
    (s) => {
      userOf(s, userId).teamIds = [...teamIds];
    },
    { action: 'user.teams', target: userId, detail: `Equipes de ${user.name}: ${names(user.teamIds || [])} → ${names(teamIds)}` }
  );
  return { ok: true };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function checkInvite(state, { email, name, roleId, teamId }) {
  const errors = {};
  const mail = String(email || '').trim().toLowerCase();
  if (!EMAIL.test(mail)) errors.email = 'Informe um e-mail válido.';
  else if (state.users.some((u) => (u.email || '').toLowerCase() === mail)) errors.email = 'Já existe um usuário com este e-mail.';
  if (!roleId) errors.role = 'Escolha um perfil.';
  else {
    const v = roleAssignProblems(roleId);
    if (v.length) errors.role = v[0];
  }
  if (teamId && !state.teams.some((t) => t.id === teamId)) errors.team = 'Equipe inexistente.';
  const problems = [];
  for (const [entity, action] of [['user', 'create'], ['role', 'assign']]) {
    const a = authority(entity, action);
    if (!a.ok) problems.push(a.hint);
  }
  return { ok: !problems.length && !Object.keys(errors).length, errors, problems, mail };
}

export function inviteUser(store, form) {
  const check = checkInvite(store.state, form);
  if (!check.ok) return check;
  const local = check.mail.split('@')[0];
  const display = String(form.name || '').trim() || local.replace(/[._-]+/g, ' ').replace(/\b\p{L}/gu, (c) => c.toUpperCase());
  const ids = new Set(store.state.users.map((u) => u.id));
  let id = `u_${slug(display)}`;
  while (ids.has(id)) id = `u_${slug(display)}_${Math.random().toString(36).slice(2, 5)}`;
  const roleName = store.state.roles.find((r) => r.id === form.roleId)?.name || form.roleId;
  commit(
    store,
    (s) => {
      s.users.push({ id, tenantId: s.tenant.id, name: display, email: check.mail, roleIds: [form.roleId], teamIds: form.teamId ? [form.teamId] : [], status: 'invited', mfa: false });
    },
    { action: 'user.invite', target: id, detail: `Convite enviado a ${check.mail} (perfil ${roleName})` }
  );
  return { ok: true, userId: id };
}

// ---------------------------------------------------------------------------
// Dados do usuário, convite, MFA e remoção
// ---------------------------------------------------------------------------

/** Valida a edição de nome/e-mail (sem gravar). `errors` por campo + `problems` gerais. */
export function checkUserEdit(state, userId, { name, email }) {
  const user = userOf(state, userId);
  const errors = {};
  const problems = [];
  if (!user || user.isBot) problems.push('Este usuário não pode ser alterado.');
  const auth = authority('user', 'update');
  if (!auth.ok) problems.push(auth.hint);
  const nm = String(name ?? '').trim();
  const mail = String(email ?? '').trim().toLowerCase();
  if (!nm) errors.name = 'Informe o nome.';
  else if (nm.length > 80) errors.name = 'Nome longo demais (máx. 80).';
  if (!EMAIL.test(mail)) errors.email = 'Informe um e-mail válido.';
  else if (state.users.some((u) => u.id !== userId && (u.email || '').toLowerCase() === mail)) errors.email = 'Já existe um usuário com este e-mail.';
  if (user && !problems.length && !Object.keys(errors).length && user.name === nm && (user.email || '').toLowerCase() === mail) problems.push('Nada mudou.');
  return { ok: !problems.length && !Object.keys(errors).length, errors, problems, name: nm, mail, user };
}

export function saveUserProfile(store, userId, form) {
  const check = checkUserEdit(store.state, userId, form);
  if (!check.ok) return check;
  const { user } = check;
  const changes = [];
  if (user.name !== check.name) changes.push(`nome "${user.name}" → "${check.name}"`);
  if ((user.email || '').toLowerCase() !== check.mail) changes.push(`e-mail ${user.email || '—'} → ${check.mail}`);
  commit(
    store,
    (s) => {
      const u = userOf(s, userId);
      u.name = check.name;
      u.email = check.mail;
    },
    { action: 'user.update', target: userId, detail: `Dados de ${user.name}: ${changes.join('; ')}` }
  );
  return { ok: true };
}

/** Reenviar convite: só para quem ainda está "convidado". */
export function resendInvite(store, userId) {
  const user = userOf(store.state, userId);
  if (!user || user.isBot) return fail('Este usuário não pode ser alterado.');
  const auth = authority('user', 'create');
  if (!auth.ok) return fail(auth.hint);
  if (user.status !== 'invited') return fail('Só dá para reenviar o convite de quem ainda não aceitou.');
  commit(
    store,
    (s) => {
      userOf(s, userId).invitedAt = Date.now();
    },
    { action: 'user.invite', target: userId, detail: `Convite reenviado a ${user.email}` }
  );
  return { ok: true };
}

/** Redefinir MFA: a pessoa terá de cadastrar o segundo fator de novo no próximo acesso. */
export function checkResetMfa(state, userId) {
  const user = userOf(state, userId);
  if (!user || user.isBot) return fail('Este usuário não pode ser alterado.');
  const auth = authority('user', 'update');
  if (!auth.ok) return fail(auth.hint);
  const problems = [];
  if (userId === state.currentUserId) problems.push('Peça a outro administrador para redefinir o seu MFA.');
  if (!user.mfa) problems.push('Esta pessoa não tem MFA ativo.');
  return { ok: !problems.length, problems, user };
}

export function resetUserMfa(store, userId) {
  const check = checkResetMfa(store.state, userId);
  if (!check.ok) return check;
  commit(
    store,
    (s) => {
      userOf(s, userId).mfa = false;
    },
    { action: 'user.mfa_reset', target: userId, detail: `MFA de ${check.user.name} redefinido` }
  );
  return { ok: true };
}

/**
 * Remover usuário. Recusa: a si mesmo, o último admin, e quem ainda é DONO de negócios,
 * contatos ou conversas (apagar deixaria registros órfãos — transfira antes, ou suspenda).
 */
export function checkUserRemove(state, userId) {
  const user = userOf(state, userId);
  if (!user || user.isBot) return fail('Este usuário não pode ser removido.');
  const auth = authority('user', 'delete');
  if (!auth.ok) return fail(auth.hint);
  const problems = [];
  if (userId === state.currentUserId) problems.push('Você não pode remover a si mesmo.');
  if (wouldRemoveLastAdmin(state.users, rolesMap(), state.tenant.id, { userId, status: 'deleted' })) problems.push('Esta mudança deixaria a empresa sem nenhum administrador ativo.');
  const owned = {
    negócios: state.deals.filter((d) => d.ownerId === userId).length,
    contatos: state.contacts.filter((c) => c.ownerId === userId).length,
    conversas: state.conversations.filter((c) => c.assigneeId === userId).length,
  };
  const parts = Object.entries(owned).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`);
  if (parts.length) problems.push(`Ainda é responsável por ${parts.join(', ')}. Transfira antes de remover (ou apenas suspenda o acesso).`);
  return { ok: !problems.length, problems, user };
}

export function removeUser(store, userId) {
  const check = checkUserRemove(store.state, userId);
  if (!check.ok) return check;
  commit(
    store,
    (s) => {
      s.users = s.users.filter((u) => u.id !== userId);
    },
    { action: 'user.remove', target: userId, detail: `${check.user.name} (${check.user.email || 'sem e-mail'}) removido(a)` }
  );
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Política
// ---------------------------------------------------------------------------

export function checkPolicy(state, requireMfa) {
  const auth = authority('tenant_settings', 'update');
  if (!auth.ok) return fail(auth.hint);
  const me = userOf(state, state.currentUserId);
  // ligar a política sem ter MFA trancaria o próprio autor para fora das ações sensíveis
  if (requireMfa && !me?.mfa) return fail('Você não tem a verificação em duas etapas ativa: ligar esta política bloquearia as suas próprias ações sensíveis. Ative o MFA na sua conta antes.');
  if (!!state.tenant.policy?.requireMfaForSensitive === !!requireMfa) return fail('Nada mudou.');
  return { ok: true, problems: [] };
}

export function setPolicy(store, requireMfa) {
  const check = checkPolicy(store.state, requireMfa);
  if (!check.ok) return check;
  commit(
    store,
    (s) => {
      s.tenant.policy = { ...(s.tenant.policy || {}), requireMfaForSensitive: !!requireMfa };
    },
    { action: 'policy.update', target: 'requireMfaForSensitive', detail: requireMfa ? 'MFA passou a ser obrigatório para ações sensíveis' : 'MFA deixou de ser obrigatório para ações sensíveis' }
  );
  return { ok: true };
}
