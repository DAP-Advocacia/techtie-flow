// Motor de autorização. Funções puras: nada de I/O, relógio ou estado global —
// a mesma entrada dá sempre a mesma saída (testável, cacheável, auditável).
//
// REGRAS DE COMPOSIÇÃO (leia isto antes de mexer — é o contrato de segurança):
//   1. Permissões SOMAM: o usuário pode o que QUALQUER um dos seus perfis permite.
//   2. Restrições VENCEM: uma negação (deny) ou campo oculto/travado em QUALQUER
//      perfil prevalece sobre qualquer permissão.
//   3. Isolamento de tenant é INCONDICIONAL: `tenantId` do registro precisa ser o
//      do usuário, e nenhum perfil/negação/compartilhamento consegue desligar isso.
//   4. Falha fechado: entidade/ação desconhecida, usuário inativo, perfil de outro
//      tenant, atributo ausente → negado.
//
// Fluxo: compileAccess() transforma (usuário, perfis, equipes, entidade, ação)
// numa expressão (expr.js). decide() avalia contra UM registro; filterFor() devolve
// a expressão para filtrar listas (JS ou SQL). As duas usam a MESMA compilação.
import { SCOPES, ENTITIES, IMMUTABLE_ATTRS, CONTROLLED_ATTRS, ACTIONS, OPERATORS, REFS, scopeRank } from './catalog.js';
import { TRUE, FALSE, and, or, not, cmp, shared, evaluate, describe } from './expr.js';

// ---------------------------------------------------------------------------
// Organograma
// ---------------------------------------------------------------------------

/** Lista (array ou Set) -> array; qualquer outra coisa (string, número, objeto, null) vira []. */
const listOf = (x) => (Array.isArray(x) ? x : x instanceof Set ? [...x] : []);

/** Ids das equipes dadas + todas as descendentes. Tolera ciclos (visited). */
export function expandTeams(org, teamIds) {
  // CORREÇÃO: `teams`/`teamIds` que não são lista (string, número) lançavam TypeError
  // ou, pior, uma string era iterada caractere a caractere ('T1' virava as equipes 'T' e '1').
  const teams = listOf(org?.teams);
  const children = new Map();
  for (const t of teams) {
    if (!t || !t.parentId) continue;
    if (!children.has(t.parentId)) children.set(t.parentId, []);
    children.get(t.parentId).push(t.id);
  }
  const seen = new Set();
  const stack = [...listOf(teamIds)];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const c of children.get(id) || []) stack.push(c);
  }
  return [...seen];
}

// ---------------------------------------------------------------------------
// Compilação
// ---------------------------------------------------------------------------

/** Perfis efetivos do usuário: só os do mesmo tenant (ou de sistema, sem tenant). */
export function effectiveRoles(ctx) {
  const { subject, roles } = ctx || {};
  if (!subject) return [];
  // CORREÇÃO: (1) roleIds não-lista (número) lançava TypeError e string era iterada por
  // caractere; (2) com `roles` como objeto simples, roleIds ['constructor'] / ['__proto__']
  // / ['toString'] resolviam para propriedades herdadas de Object.prototype.
  const get =
    typeof roles?.get === 'function'
      ? (id) => roles.get(id)
      : (id) => (roles && typeof roles === 'object' && Object.hasOwn(roles, id) ? roles[id] : undefined);
  const out = [];
  for (const id of listOf(subject.roleIds)) {
    const role = get(id);
    if (!role || typeof role !== 'object') continue;
    // Perfil sem tenantId só vale se for de SISTEMA de verdade (system:true); sem isso, uma linha de perfil
    // gravada sem tenant_id viraria "perfil global" silencioso para todos os tenants. Outro tenant: ignora.
    if (role.tenantId == null ? role.system !== true : role.tenantId !== subject.tenantId) continue;
    out.push(role);
  }
  return out;
}

function scopePredicate(entity, scope, ctx) {
  const { subject, org } = ctx;
  const owner = entity.ownerField;
  const team = entity.teamField;
  switch (scope) {
    case 'tenant':
      return TRUE;
    case 'own':
      return owner ? cmp(owner, 'eq', subject.id) : FALSE;
    case 'team':
      return or(owner ? cmp(owner, 'eq', subject.id) : FALSE, team ? cmp(team, 'in', [...listOf(subject.teamIds)]) : FALSE);
    case 'team_tree':
      return or(owner ? cmp(owner, 'eq', subject.id) : FALSE, team ? cmp(team, 'in', expandTeams(org, subject.teamIds)) : FALSE);
    default:
      return FALSE; // 'none' ou escopo desconhecido
  }
}

const NEEDS_NO_VALUE = new Set(['isNull', 'notNull']);

/**
 * Condição bem formada? (op conhecido, ref conhecida, valor do tipo que o operador
 * exige). Condição malformada é DESCONHECIDA e resolve pelo lado seguro — antes, um
 * op desconhecido LANÇAVA dentro de decide(); `in` com valor não-lista e `eq` sem valor
 * viravam "falso" também no deny/aprovação, ou seja, a negação deixava de se aplicar
 * (falha ABERTA) quando o perfil estava corrompido no banco.
 */
function wellFormedCondition(cond, value) {
  if (!cond || typeof cond !== 'object' || typeof cond.field !== 'string') return false;
  if (!OPERATORS.includes(cond.op)) return false;
  if (cond.ref !== undefined && !REFS.includes(cond.ref)) return false;
  if (NEEDS_NO_VALUE.has(cond.op)) return true;
  if (cond.op === 'in' || cond.op === 'nin') return Array.isArray(value);
  if (value === undefined) return false; // eq/ne/lt… sem valor (ou ref que não resolveu: usuário sem id)
  return value === null || typeof value !== 'object'; // escalar (null é dado: eq null é falso)
}

/**
 * Valor de contexto utilizável? O contexto vem do APP (muitas vezes de um corpo de
 * requisição): `discountPct: "8%"`, NaN ou um array faziam `gt 5` dar FALSO — e, na
 * condição de aprovação ("exige aprovação quando desconto > 5"), falso = NÃO exige:
 * o atendente passava um desconto de 8% sem aprovação (falha ABERTA). Agora valor de
 * contexto de tipo diferente do da condição (ou NaN/objeto) é DESCONHECIDO e resolve
 * pelo lado seguro. null continua sendo dado (ver questoesDeDesign).
 */
function ctxValueCompatible(left, op, value) {
  // null NÃO é dado utilizável no contexto (era a brecha `discountPct: null` => sem aprovação);
  // só os operadores isNull/notNull aceitam. Número negativo também é inválido: todo ctx numérico do
  // catálogo (desconto %, nº de linhas) é >= 0, e `-1 > 5` é falso => "não exige aprovação".
  if (left === null) return NEEDS_NO_VALUE.has(op);
  if (typeof left === 'number' && left < 0) return false;
  const t = typeof left;
  if (t === 'number' ? Number.isNaN(left) : t !== 'string' && t !== 'boolean') return false;
  if (NEEDS_NO_VALUE.has(op)) return true;
  const sample = (Array.isArray(value) ? value : [value]).filter((v) => v != null);
  return sample.every((v) => typeof v === t);
}

/** Resolve uma condição ({field, op, value|ref}). `context`: contexto da operação, se houver. */
function conditionPredicate(cond, entity, ctx, { context, mode }) {
  const { subject } = ctx;
  const unknown = mode === 'deny' ? TRUE : FALSE; // lado seguro
  let value = cond?.value;
  if (cond?.ref === '$user.id') value = subject.id;
  else if (cond?.ref === '$user.teamIds') value = [...listOf(subject.teamIds)];
  if (!wellFormedCondition(cond, value)) return unknown;

  if (cond.field.startsWith('ctx.')) {
    // Atributo de contexto da operação (ex.: ctx.toStageKind). Sem contexto
    // (compilação de lista), é DESCONHECIDO: no lado "permite" vira falso e no
    // lado "nega" vira verdadeiro — sempre pelo lado seguro.
    // Chave ausente no contexto também é DESCONHECIDA: quem esquece de passar
    // toStageKind ao mover um negócio não pode, por isso, escapar de uma negação.
    const key = cond.field.slice(4);
    if (!context || typeof context !== 'object' || !Object.hasOwn(context, key) || context[key] === undefined) return unknown;
    const left = context[key];
    if (!ctxValueCompatible(left, cond.op, value)) return unknown;
    return evaluate(cmp('__ctx', cond.op, value), { __ctx: left }) ? TRUE : FALSE;
  }
  if (!Object.hasOwn(entity.attrs, cond.field)) return unknown; // atributo inexistente: lado seguro
  return cmp(cond.field, cond.op, value);
}

function conditionsPredicate(conds, entity, ctx, opts) {
  if (conds === undefined || conds === null) return TRUE;
  // "lista" de condições que não é lista: dado corrompido => desconhecida (lado seguro)
  if (!Array.isArray(conds)) return opts.mode === 'deny' ? TRUE : FALSE;
  return and(conds.map((c) => conditionPredicate(c, entity, ctx, opts)));
}

/** Predicado das partições do perfil (pipelineId/instanceId) para a entidade. */
function partitionPredicate(role, entity) {
  const parts = [];
  // `partitions` ausente/nulo = sem restrição. Qualquer outra coisa que não seja um objeto
  // (string, número, lista) é dado corrompido: não dá para saber o que foi restrito, então
  // restringe TUDO (antes: ignorado = sem restrição, ou seja, falha aberta). Só vale a chave PRÓPRIA.
  const cfg = role.partitions;
  const corrupted = cfg !== undefined && cfg !== null && (typeof cfg !== 'object' || Array.isArray(cfg));
  for (const [key, attr] of Object.entries(entity.partitions || {})) {
    if (corrupted) {
      parts.push(cmp(attr, 'in', []));
      continue;
    }
    const allowed = cfg && Object.hasOwn(cfg, key) ? cfg[key] : undefined;
    if (allowed === undefined || allowed === 'all') continue;
    parts.push(cmp(attr, 'in', Array.isArray(allowed) ? [...allowed] : []));
  }
  return and(parts);
}

// Regra (grant/deny) bem formada: objeto com entidade string e ações em LISTA.
// CORREÇÃO: `actions` como string fazia `'readonly'.includes('read')` dar true (grant
// "vazando" para outra ação por substring) e `actions` ausente lançava TypeError.
const ruleWellFormed = (g) => !!g && typeof g === 'object' && typeof g.entity === 'string' && Array.isArray(g.actions);
const grantMatches = (g, entityName, action) =>
  ruleWellFormed(g) && (g.entity === entityName || g.entity === '*') && (g.actions.includes(action) || g.actions.includes('*'));

/**
 * Compila a política de `ctx.subject` para (entidade, ação).
 * ctx = { subject, roles, org, policy? }
 * opts.context = contexto da operação (move, approve…); ausente = compilação para lista.
 * Devolve { entity, tenant, branches:[{source, expr, parts, approvalWhen}], denies:[{source, expr}] }
 * ou { blocked: 'motivo' } quando nada pode ser permitido.
 */
export function compileAccess(ctx, entityName, action, { context } = {}) {
  const entity = typeof entityName === 'string' ? ENTITIES[entityName] : undefined;
  if (!entity || !entity.actions.includes(action)) return { blocked: 'unknown_action' };
  const { subject } = ctx || {};
  if (!subject || subject.status !== 'active') return { blocked: 'subject_inactive' };
  // MFA é FALHA-FECHADA: política ausente conta como "exige". Para desligar é preciso dizer
  // explicitamente `requireMfaForSensitive: false`. E só `mfa === true` vale (a string 'false' é truthy).
  if (ACTIONS[action]?.sensitive && ctx.policy?.requireMfaForSensitive !== false && subject.mfa !== true) return { blocked: 'mfa_required' };

  const tenant = cmp('tenantId', 'eq', subject.tenantId);
  const branches = [];
  const denies = [];

  const addGrants = (source, grants, role) => {
    listOf(grants).forEach((g, i) => {
      if (!grantMatches(g, entityName, action)) return; // grant malformado: ignorado (= nega)
      const scope = scopePredicate(entity, g.scope, ctx);
      const partition = role ? partitionPredicate(role, entity) : TRUE;
      const conditions = conditionsPredicate(g.conditions, entity, ctx, { context, mode: 'allow' });
      // "exige aprovação quando…": desconhecido = exige (mode 'deny' resolve o desconhecido para TRUE).
      const approvalWhen = g.approval ? conditionsPredicate(g.approval.when, entity, ctx, { context, mode: 'deny' }) : null;
      branches.push({
        source: `${source}#${i}`,
        expr: and(scope, partition, conditions),
        parts: { scope, partition, conditions },
        approvalWhen,
        hasApproval: !!g.approval,
      });
    });
  };
  const addDenies = (source, list) => {
    // `denies` que não é lista (string, objeto…) é dado corrompido: nega tudo (antes: ignorado).
    if (list !== undefined && list !== null && !Array.isArray(list) && !(list instanceof Set)) {
      denies.push({ source: `${source}#?`, expr: TRUE });
      return;
    }
    listOf(list).forEach((d, i) => {
      // CORREÇÃO (falha fechado): uma negação MALFORMADA (sem entidade, `actions` que não
      // é lista…) era ignorada em silêncio — ou seja, uma negação corrompida liberava o
      // que devia bloquear. Agora ela vale para qualquer entidade/ação.
      if (!ruleWellFormed(d)) {
        denies.push({ source: `${source}#${i}`, expr: TRUE });
        return;
      }
      if (!grantMatches(d, entityName, action)) return;
      denies.push({ source: `${source}#${i}`, expr: conditionsPredicate(d.conditions, entity, ctx, { context, mode: 'deny' }) });
    });
  };

  for (const role of effectiveRoles(ctx)) {
    addGrants(`perfil:${role.id}`, role.grants, role);
    addDenies(`perfil:${role.id}:nega`, role.denies);
  }
  addGrants('usuario', subject.overrides?.grants, null);
  addDenies('usuario:nega', subject.overrides?.denies);

  // Compartilhamento explícito por registro ("compartilhar este negócio com Fulano"):
  // dá leitura/edição sem perfil nenhum — mas ainda respeita tenant e negações.
  if (entity.shareable && (action === 'read' || action === 'update')) {
    const levels = action === 'read' ? ['read', 'edit'] : ['edit'];
    // Compartilhar "com a equipe X" vale para MEMBROS de X, não para quem está acima na hierarquia:
    // por isso as equipes do usuário SEM expandir para descendentes (expandir vazaria para cima).
    const e = shared(entityName, levels, subject.id, [...listOf(subject.teamIds)]);
    branches.push({ source: 'compartilhamento', expr: e, parts: { scope: e, partition: TRUE, conditions: TRUE }, approvalWhen: null, hasApproval: false });
  }

  return { entity, tenant, branches, denies };
}

/** Expressão final: tenant E (algum ramo permite) E NÃO (alguma negação). */
function finalExpr(compiled) {
  if (compiled.blocked) return FALSE;
  const allow = or(compiled.branches.map((b) => b.expr));
  const deny = or(compiled.denies.map((d) => d.expr));
  return and(compiled.tenant, allow, not(deny));
}

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------

/**
 * Filtro para LISTAS. Devolve a expressão (use toPredicate para arrays em JS,
 * toSql para o banco). `read` é o caso comum, mas vale para qualquer ação.
 */
export function filterFor(ctx, entityName, action = 'read') {
  const compiled = compileAccess(ctx, entityName, action);
  return { expr: finalExpr(compiled), blocked: compiled.blocked || null, entity: typeof entityName === 'string' ? ENTITIES[entityName] : undefined };
}

/**
 * Decisão sobre UM registro.
 * @returns {{effect:'allow'|'deny'|'approval', reason:string, matched:string[]}}
 *  reasons: ok | needs_approval | unknown_action | subject_inactive | mfa_required |
 *           tenant_mismatch | denied | no_grant
 */
export function decide(ctx, entityName, action, row, context) {
  const compiled = compileAccess(ctx, entityName, action, { context });
  if (compiled.blocked) return { effect: 'deny', reason: compiled.blocked, matched: [] };
  const target = row || {};

  if (!evaluate(compiled.tenant, target)) return { effect: 'deny', reason: 'tenant_mismatch', matched: [] };

  const hit = compiled.denies.find((d) => evaluate(d.expr, target));
  if (hit) return { effect: 'deny', reason: 'denied', matched: [hit.source] };

  const matched = compiled.branches.filter((b) => evaluate(b.expr, target));
  if (!matched.length) return { effect: 'deny', reason: 'no_grant', matched: [] };

  // Algum ramo permite SEM exigir aprovação? Então é permitido direto.
  const direct = matched.filter((b) => !b.hasApproval || !evaluate(b.approvalWhen, target));
  if (direct.length) return { effect: 'allow', reason: 'ok', matched: direct.map((b) => b.source) };
  return { effect: 'approval', reason: 'needs_approval', matched: matched.map((b) => b.source) };
}

/** true só se permitido DIRETO (aprovação pendente NÃO conta). */
export const can = (ctx, entity, action, row, context) => decide(ctx, entity, action, row, context).effect === 'allow';

/** Permitido direto ou mediante aprovação (para habilitar o botão com aviso). */
export const canOrRequest = (ctx, entity, action, row, context) => decide(ctx, entity, action, row, context).effect !== 'deny';

/**
 * Explica a decisão ramo a ramo — para a tela "por que não posso?" e para
 * auditoria. Não é usado no caminho quente.
 */
export function explain(ctx, entityName, action, row, context) {
  const decision = decide(ctx, entityName, action, row, context);
  const compiled = compileAccess(ctx, entityName, action, { context });
  if (compiled.blocked) return { ...decision, branches: [], denies: [] };
  const target = row || {};
  const branches = compiled.branches.map((b) => {
    const scopeOk = evaluate(b.parts.scope, target);
    const partitionOk = evaluate(b.parts.partition, target);
    const condOk = evaluate(b.parts.conditions, target);
    return {
      source: b.source,
      matched: scopeOk && partitionOk && condOk,
      failedAt: !scopeOk ? 'escopo' : !partitionOk ? 'particao' : !condOk ? 'condicao' : null,
      rule: describe(b.expr),
    };
  });
  const denies = compiled.denies.map((d) => ({ source: d.source, applies: evaluate(d.expr, target), rule: describe(d.expr) }));
  return { ...decision, branches, denies };
}

// ---------------------------------------------------------------------------
// Campos (ocultar / travar) — restrição vence, como nas negações
// ---------------------------------------------------------------------------

const ACCESS_ORDER = { write: 0, readonly: 1, hidden: 2 };

/**
 * CORREÇÃO (falha fechado): regra de campo com `access` desconhecido (typo, 'HIDDEN',
 * 'none') era ignorada — o campo continuava editável/visível. Agora vale como 'hidden'.
 * Antes também, as restrições de campo do USUÁRIO (overrides) não aceitavam entidade
 * '*', ao contrário das do perfil.
 */
const accessOf = (rule) => (rule.access === 'write' || rule.access === 'readonly' ? rule.access : 'hidden');

/**
 * Restrições de campo do usuário para a entidade: { campo: 'readonly'|'hidden' }.
 * O mais restritivo entre TODOS os perfis prevalece. Campo sem regra = 'write'.
 */
export function fieldAccess(ctx, entityName) {
  const entity = typeof entityName === 'string' ? ENTITIES[entityName] : undefined;
  const out = {};
  if (!entity) return out;
  const hide = (field, access) => {
    const cur = out[field] || 'write';
    if (ACCESS_ORDER[access] > ACCESS_ORDER[cur]) out[field] = access;
  };
  const apply = (rule) => {
    // regra de campo MALFORMADA (não-objeto, entidade/campo que não são texto): não dá para saber
    // o que ela queria restringir => oculta todos os campos restringíveis da entidade (falha fechado).
    if (!rule || typeof rule !== 'object' || typeof rule.entity !== 'string' || typeof rule.field !== 'string') {
      for (const f of entity.fields) hide(f, 'hidden');
      return;
    }
    if ((rule.entity !== entityName && rule.entity !== '*') || !entity.fields.includes(rule.field)) return;
    hide(rule.field, accessOf(rule));
  };
  const each = (list) => {
    if (list === undefined || list === null) return;
    if (!Array.isArray(list) && !(list instanceof Set)) return apply(undefined); // "lista" corrompida
    for (const rule of listOf(list)) apply(rule);
  };
  for (const role of effectiveRoles(ctx)) each(role.fields);
  each(ctx?.subject?.overrides?.fields);
  return out;
}

/** Cópia do registro sem os campos ocultos — use ao serializar respostas de API. */
export function maskRow(ctx, entityName, row) {
  // entidade desconhecida: não há como saber o que é sensível => não devolve nada (falha fechado)
  if (!Object.hasOwn(ENTITIES, entityName) || !row || typeof row !== 'object' || Array.isArray(row)) return {};
  const restricted = fieldAccess(ctx, entityName);
  const out = row && typeof row === 'object' ? { ...row } : {};
  for (const [field, access] of Object.entries(restricted)) if (access === 'hidden') delete out[field];
  return out;
}

/** Pode alterar este campo deste registro? (permissão de update + campo não travado/oculto) */
export function canWriteField(ctx, entityName, field, row, context) {
  if (IMMUTABLE_ATTRS.includes(field)) return false;
  const access = fieldAccess(ctx, entityName)[field] || 'write';
  if (access !== 'write' || !can(ctx, entityName, 'update', row, context)) return false;
  // atributo de controle (dono, etapa, funil…): também exige a ação controladora
  const controller = Object.hasOwn(CONTROLLED_ATTRS, field) ? CONTROLLED_ATTRS[field] : null;
  return controller ? ENTITIES[entityName]?.actions.includes(controller) && can(ctx, entityName, controller, row, context) : true;
}

/**
 * Valida um PATCH inteiro (o que a API deve chamar antes de gravar). Recusa chave imutável, exige a
 * ação controladora para dono/etapa/funil, aplica restrição de campo e, por fim, confere se o
 * registro RESULTANTE ainda é editável por este usuário (equivalente a um WITH CHECK): um update não
 * pode jogar o registro para fora do escopo do ator nem para uma partição proibida.
 * `before` = linha lida do banco; `patch` = só as chaves que o cliente quer mudar.
 * @returns {{ok:boolean, denied:{field:string, reason:string}[]}}
 */
export function checkPatch(ctx, entityName, before, patch, context) {
  const denied = [];
  const entity = ENTITIES[entityName];
  if (!entity) return { ok: false, denied: [{ field: '*', reason: 'unknown_entity' }] };
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, denied: [{ field: '*', reason: 'bad_patch' }] };
  for (const field of Object.keys(patch)) {
    if (IMMUTABLE_ATTRS.includes(field)) denied.push({ field, reason: 'immutable' });
    else if (!canWriteField(ctx, entityName, field, before, context)) denied.push({ field, reason: 'field_not_writable' });
  }
  if (!denied.length) {
    const after = { ...before, ...patch };
    if (!can(ctx, entityName, 'update', after, context)) denied.push({ field: '*', reason: 'result_out_of_scope' });
  }
  return { ok: denied.length === 0, denied };
}

// ---------------------------------------------------------------------------
// Resumo para a tela (simulador "ver como")
// ---------------------------------------------------------------------------

/**
 * Matriz efetiva: para cada entidade × ação, o MAIOR escopo incondicional que o
 * usuário tem, e se há condições/partições/aprovação/negação envolvidas.
 * É um RESUMO para exibir — a decisão real é sempre decide()/filterFor().
 * @returns {{[entity:string]:{[action:string]:{scope:string, conditional:boolean, approval:boolean, denied:boolean, shared:boolean}}}}
 */
export function effectiveMatrix(ctx) {
  const roles = effectiveRoles(ctx);
  const result = {};
  const active = ctx.subject?.status === 'active';
  const sources = [
    ...roles.map((r) => ({ grants: listOf(r.grants).filter(ruleWellFormed), denies: listOf(r.denies).filter(ruleWellFormed), role: r })),
    { grants: listOf(ctx.subject?.overrides?.grants).filter(ruleWellFormed), denies: listOf(ctx.subject?.overrides?.denies).filter(ruleWellFormed), role: null },
  ];
  for (const [name, entity] of Object.entries(ENTITIES)) {
    result[name] = {};
    for (const action of entity.actions) {
      let best = 'none';
      let conditional = false;
      let approval = false;
      let denied = false;
      let partitioned = false;
      for (const { grants, denies, role } of sources) {
        for (const g of grants) {
          if (!grantMatches(g, name, action)) continue;
          // null/'' também restringem no motor (só undefined e 'all' liberam)
          const hasPart = role && Object.keys(entity.partitions).some((k) => role.partitions?.[k] !== undefined && role.partitions[k] !== 'all');
          const cond = (g.conditions || []).length > 0 || hasPart;
          const rank = scopeRank(g.scope);
          // grant incondicional de escopo maior substitui; condicional só conta se nada melhor
          if (rank > scopeRank(best) || (rank === scopeRank(best) && !cond && conditional)) {
            best = g.scope;
            conditional = !!cond;
            approval = !!g.approval;
            partitioned = !!hasPart;
          }
        }
        for (const d of denies) if (grantMatches(d, name, action)) denied = true;
      }
      result[name][action] = {
        scope: active ? best : 'none',
        conditional: conditional || partitioned,
        approval,
        denied,
        shared: entity.shareable && (action === 'read' || action === 'update'),
      };
    }
  }
  return result;
}

export { SCOPES };
