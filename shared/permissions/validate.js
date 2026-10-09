// Validações de GESTÃO de permissões — o que impede que a própria tela de
// permissões vire o vetor de ataque: perfil malformado, usuário se dando mais
// poder do que tem (escalonamento), tenant ficando sem administrador, edição
// de perfil de sistema. O motor (engine.js) decide acesso a dados; isto decide
// quem pode MUDAR as regras e o que é uma regra válida.
import { ENTITIES, ACTIONS, SCOPES, OPERATORS, REFS, PARTITIONS, scopeRank } from './catalog.js';
import { effectiveRoles } from './engine.js';

const err = (path, message) => ({ path, message });
const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const arr = (x) => (Array.isArray(x) ? x : []);
// String() lança com Symbol; mensagens de erro nunca podem lançar.
const show = (x) => {
  try {
    return String(x);
  } catch {
    return typeof x;
  }
};

function validateConditions(conds, entityNames, actions, path, errors, { allowCtx }) {
  if (conds === undefined) return;
  if (!Array.isArray(conds)) return errors.push(err(path, 'condições devem ser uma lista'));
  conds.forEach((c, i) => {
    const p = `${path}[${i}]`;
    if (!c || typeof c.field !== 'string') return errors.push(err(p, 'condição sem campo'));
    if (!OPERATORS.includes(c.op)) errors.push(err(p, `operador inválido: ${show(c.op)}`));
    if (c.ref !== undefined && !REFS.includes(c.ref)) errors.push(err(p, `referência inválida: ${show(c.ref)}`));
    const needsArray = c.op === 'in' || c.op === 'nin';
    const noValue = c.op === 'isNull' || c.op === 'notNull';
    if (!noValue && c.ref === undefined && c.value === undefined) errors.push(err(p, 'condição sem valor'));
    if (needsArray && c.ref === undefined && !Array.isArray(c.value)) errors.push(err(p, `${c.op} exige uma lista`));
    // valor escalar para operadores escalares (o motor trata lista/objeto aí como condição corrompida)
    if (!noValue && !needsArray && c.ref === undefined && c.value !== undefined && c.value !== null && typeof c.value === 'object') errors.push(err(p, `${show(c.op)} exige um valor simples, não lista/objeto`));
    // ref do tipo certo para o operador: $user.teamIds é lista (in/nin); $user.id é escalar
    if (c.ref === '$user.teamIds' && !needsArray) errors.push(err(p, '$user.teamIds só combina com in/nin'));
    if (c.ref === '$user.id' && (needsArray || noValue)) errors.push(err(p, '$user.id só combina com operadores escalares'));
    if (c.field.startsWith('ctx.')) {
      if (!allowCtx) return errors.push(err(p, 'contexto (ctx.*) não é permitido aqui'));
      const key = c.field.slice(4);
      const ok = actions.every((a) => a === '*' || (ACTIONS[a]?.ctx || []).includes(key));
      if (!ok) errors.push(err(p, `ctx.${key} não existe para a(s) ação(ões) ${actions.map(show).join(', ')}`));
    } else {
      const names = entityNames;
      if (!names.every((n) => ENTITIES[n] && Object.hasOwn(ENTITIES[n].attrs, c.field))) errors.push(err(p, `atributo desconhecido: ${c.field}`));
    }
  });
}

const resolveEntities = (e) => (e === '*' ? Object.keys(ENTITIES) : typeof e === 'string' && ENTITIES[e] ? [e] : []);

/** Valida um perfil. Devolve lista de { path, message } (vazia = válido). Nunca lança. */
export function validateRole(role) {
  const errors = [];
  if (!role || typeof role !== 'object' || Array.isArray(role)) return [err('', 'perfil inválido')];
  if (!role.id || typeof role.id !== 'string') errors.push(err('id', 'id obrigatório'));
  if (!role.name || !show(role.name).trim()) errors.push(err('name', 'nome obrigatório'));
  else if (show(role.name).length > 60) errors.push(err('name', 'nome longo demais (máx. 60)'));

  const checkRules = (list, kind) => {
    if (!Array.isArray(list)) return errors.push(err(kind, 'deve ser uma lista'));
    list.forEach((r, i) => {
      const p = `${kind}[${i}]`;
      if (!isObj(r)) return errors.push(err(p, 'regra inválida'));
      const names = resolveEntities(r.entity);
      if (!names.length) return errors.push(err(`${p}.entity`, `entidade desconhecida: ${show(r.entity)}`));
      if (!Array.isArray(r.actions) || !r.actions.length) return errors.push(err(`${p}.actions`, 'ações obrigatórias'));
      for (const a of r.actions) {
        if (a === '*') {
          if (r.actions.length > 1) errors.push(err(`${p}.actions`, "'*' deve vir sozinho"));
          continue;
        }
        if (typeof a !== 'string' || !ACTIONS[a]) errors.push(err(`${p}.actions`, `ação desconhecida: ${show(a)}`));
        // entidade '*' = basta a ação existir no catálogo (o motor ignora entidades que não a têm)
        else if (!(r.entity === '*' ? true : names.every((n) => ENTITIES[n].actions.includes(a)))) {
          errors.push(err(`${p}.actions`, `ação ${a} não existe em ${r.entity}`));
        }
      }
      if (kind === 'grants') {
        if (!SCOPES.includes(r.scope)) errors.push(err(`${p}.scope`, `escopo inválido: ${show(r.scope)}`));
        else if (r.entity !== '*' && !ENTITIES[r.entity].scopes.includes(r.scope)) errors.push(err(`${p}.scope`, `escopo ${r.scope} não se aplica a ${r.entity}`));
        if (r.entity === '*' && r.scope !== 'tenant' && r.scope !== 'none') errors.push(err(`${p}.scope`, "entidade '*' só aceita escopo tenant"));
      }
      validateConditions(r.conditions, names, r.actions, `${p}.conditions`, errors, { allowCtx: true });
      if (r.approval) {
        if (!isObj(r.approval)) errors.push(err(`${p}.approval`, 'aprovação inválida'));
        else validateConditions(r.approval.when, names, r.actions, `${p}.approval.when`, errors, { allowCtx: true });
      }
    });
  };
  checkRules(role.grants || [], 'grants');
  checkRules(role.denies || [], 'denies');

  if (role.partitions !== undefined && role.partitions !== null && !isObj(role.partitions)) errors.push(err('partitions', 'deve ser um objeto'));
  else
    for (const [key, val] of Object.entries(role.partitions || {})) {
      if (!PARTITIONS[key]) errors.push(err(`partitions.${key}`, `partição desconhecida: ${key}`));
      else if (val !== 'all' && !(Array.isArray(val) && val.every((v) => typeof v === 'string'))) errors.push(err(`partitions.${key}`, "use 'all' ou uma lista de ids"));
    }
  if (role.fields != null && !Array.isArray(role.fields)) errors.push(err('fields', 'deve ser uma lista'));
  else
    arr(role.fields).forEach((f, i) => {
      if (!isObj(f)) return errors.push(err(`fields[${i}]`, 'regra de campo inválida'));
      const e = typeof f.entity === 'string' ? ENTITIES[f.entity] : undefined;
      if (!e) errors.push(err(`fields[${i}].entity`, `entidade desconhecida: ${show(f.entity)}`));
      else if (!e.fields.includes(f.field)) errors.push(err(`fields[${i}].field`, `campo ${show(f.field)} não é restringível em ${f.entity}`));
      if (!['hidden', 'readonly'].includes(f.access)) errors.push(err(`fields[${i}].access`, 'use hidden ou readonly'));
    });
  return errors;
}

/** Perfis de sistema não se editam nem apagam: clonar e alterar a cópia. */
export const isImmutableRole = (role) => !!role?.system;

// ---------------------------------------------------------------------------
// Escalonamento de privilégio
// ---------------------------------------------------------------------------

const expandRule = (rule) => {
  const entities = rule.entity === '*' ? Object.keys(ENTITIES) : [rule.entity];
  const out = [];
  for (const e of entities) {
    if (!ENTITIES[e]) continue;
    const actions = rule.actions.includes('*') ? ENTITIES[e].actions : rule.actions;
    for (const a of actions) if (ENTITIES[e].actions.includes(a)) out.push([e, a]);
  }
  return out;
};

// Mesma leitura que o motor faz (engine.js/partitionPredicate): ausente ou 'all' = tudo;
// qualquer outra coisa que não seja lista (null, '', string) = NADA.
// CORREÇÃO: aqui `null ?? 'all'` virava "tudo" (o motor trata como nada) e uma string
// em `want.every` lançava TypeError.
const partitionOf = (role, key) => {
  const v = role?.partitions?.[key];
  return v === undefined || v === 'all' ? 'all' : Array.isArray(v) ? v : [];
};

function partitionsCover(actorRole, candidate, entityName) {
  for (const key of Object.keys(ENTITIES[entityName].partitions || {})) {
    const have = partitionOf(actorRole, key);
    const want = partitionOf(candidate, key);
    if (have === 'all') continue;
    if (want === 'all') return false;
    if (!want.every((v) => have.includes(v))) return false;
  }
  return true;
}

const ruleOk = (r) => isObj(r) && typeof r.entity === 'string' && Array.isArray(r.actions);
const ruleCovers = (r, entity, action) => ruleOk(r) && (r.entity === entity || r.entity === '*') && (r.actions.includes(action) || r.actions.includes('*'));
const hasConditions = (r) => (Array.isArray(r.conditions) ? r.conditions.length > 0 : !!r.conditions);
const condKey = (r) => JSON.stringify(r.conditions || []);

/**
 * O ator só pode criar/atribuir perfil cujos grants ele MESMO possui (regra do
 * "não dá o que não tem"). Conservador: na dúvida, recusa. Um grant do ator
 * cobre o candidato se tiver escopo >= , nenhuma condição, nenhuma aprovação, e
 * partições que contenham as do candidato. (Negações e restrições de campo do
 * candidato só reduzem poder, então nunca contam como escalonamento.)
 *
 * CORREÇÕES (o ator era tratado como se não tivesse restrições):
 *  - ator INATIVO/ausente (suspenso, convidado) não pode conceder nada;
 *  - NEGAÇÕES do ator valem: quem tem `grant export` num perfil mas `deny export` em
 *    outro NÃO pode dar `export` — senão o candidato obtinha um allow que o ator não
 *    tem (a negação do ator se "lavava" no perfil novo). Exceção: o candidato repete a
 *    mesma negação (mesma entidade/ação e condições idênticas);
 *  - candidato malformado é recusado, em vez de lançar exceção.
 * Restrições de CAMPO do ator (ex.: telefone oculto) ainda não são propagadas — ver
 * questoesDeDesign no relatório dos testes.
 * @returns {{ok:boolean, violations:{entity:string, action:string, scope:string, reason?:string}[]}}
 */
export function checkNoEscalation(actorCtx, candidate) {
  const refuse = (reason) => ({ ok: false, violations: [{ entity: '*', action: '*', scope: '*', reason }] });
  const subject = actorCtx?.subject;
  if (!subject || subject.status !== 'active') return refuse('subject_inactive');
  if (!isObj(candidate) || (candidate.grants != null && !Array.isArray(candidate.grants))) return refuse('candidate_malformed');

  const actorRoles = effectiveRoles(actorCtx);
  const ov = subject.overrides;
  const actorSources = [...actorRoles.map((r) => ({ role: r, grants: arr(r.grants) })), { role: null, grants: arr(ov?.grants) }];
  const actorDenies = [...actorRoles.flatMap((r) => (Array.isArray(r.denies) ? r.denies : [])), ...arr(ov?.denies)];
  const candidateDenies = arr(candidate.denies);
  const violations = [];
  for (const grant of candidate.grants || []) {
    if (!ruleOk(grant) || typeof grant.scope !== 'string') {
      violations.push({ entity: String(grant?.entity), action: '*', scope: String(grant?.scope), reason: 'rule_malformed' });
      continue;
    }
    if (grant.scope === 'none') continue;
    for (const [entity, action] of expandRule(grant)) {
      const blockedByActorDeny = actorDenies.some((d) => {
        if (ruleOk(d) && !ruleCovers(d, entity, action)) return false; // negação de outra coisa
        // negação aplicável (ou malformada, que o motor trata como "nega tudo")
        const mirrored = ruleOk(d) && candidateDenies.some((cd) => ruleCovers(cd, entity, action) && condKey(cd) === condKey(d));
        return !mirrored;
      });
      const covered =
        !blockedByActorDeny &&
        actorSources.some(({ role, grants }) =>
          grants.some(
            (a) =>
              ruleCovers(a, entity, action) &&
              scopeRank(a.scope) >= scopeRank(grant.scope) &&
              !hasConditions(a) &&
              !a.approval &&
              partitionsCover(role, candidate, entity)
          )
        );
      // candidato condicional/aprovado é mais estreito que o ator incondicional: coberto.
      if (!covered) violations.push({ entity, action, scope: grant.scope });
    }
  }
  return { ok: violations.length === 0, violations };
}

// ---------------------------------------------------------------------------
// Último administrador
// ---------------------------------------------------------------------------

// Só o perfil de sistema (sem tenant) conta como Admin: um perfil de tenant chamado
// 'role_admin' não pode se passar por ele.
const isAdminRole = (role) => !!role && role.system === true && role.tenantId == null && role.id === 'role_admin';

export function countActiveAdmins(users, roles, tenantId) {
  const get = typeof roles?.get === 'function' ? (id) => roles.get(id) : (id) => (roles && Object.hasOwn(roles, id) ? roles[id] : undefined);
  return arr(users).filter((u) => u && u.tenantId === tenantId && u.status === 'active' && arr(u.roleIds).some((id) => isAdminRole(get(id)))).length;
}

/**
 * Esta mudança deixaria o tenant sem administrador ativo?
 * change = { userId, roleIds?, status? } (campos ausentes = não mudam)
 */
export function wouldRemoveLastAdmin(users, roles, tenantId, change) {
  const after = arr(users).map((u) => (u && change && u.id === change.userId ? { ...u, ...(change.roleIds ? { roleIds: change.roleIds } : {}), ...(change.status ? { status: change.status } : {}) } : u));
  return countActiveAdmins(users, roles, tenantId) > 0 && countActiveAdmins(after, roles, tenantId) === 0;
}

// ---------------------------------------------------------------------------
// Auditoria de mudanças de perfil
// ---------------------------------------------------------------------------

const ruleKey = (r) => `${r.entity}:${[...arr(r.actions)].sort().join(',')}:${r.scope ?? ''}:${JSON.stringify(r.conditions || [])}:${JSON.stringify(r.approval || null)}`;

/** Diferença legível entre dois perfis (para o log de auditoria e a tela). */
export function diffRoles(before, after) {
  const changes = [];
  const keys = (list) => new Map(arr(list).filter(isObj).map((r) => [ruleKey(r), r]));
  for (const kind of ['grants', 'denies']) {
    const a = keys(before?.[kind]);
    const b = keys(after?.[kind]);
    for (const [k, r] of b) if (!a.has(k)) changes.push({ type: 'added', kind, rule: r });
    for (const [k, r] of a) if (!b.has(k)) changes.push({ type: 'removed', kind, rule: r });
  }
  if (JSON.stringify(before?.partitions || {}) !== JSON.stringify(after?.partitions || {})) changes.push({ type: 'changed', kind: 'partitions', before: before?.partitions || {}, after: after?.partitions || {} });
  if (JSON.stringify(before?.fields || []) !== JSON.stringify(after?.fields || [])) changes.push({ type: 'changed', kind: 'fields', before: before?.fields || [], after: after?.fields || [] });
  if (before?.name !== after?.name) changes.push({ type: 'changed', kind: 'name', before: before?.name, after: after?.name });
  return changes;
}

/** Evento de auditoria padronizado (quem fez o quê, quando, com o que mudou). */
export function auditEvent({ at, tenantId, actorId, action, target, before, after }) {
  return { at, tenantId, actorId, action, target, diff: before !== undefined && after !== undefined ? diffRoles(before, after) : undefined };
}
