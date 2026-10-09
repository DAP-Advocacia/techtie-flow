// Modelo de edição de perfis — funções PURAS (sem DOM, sem store).
//
// A matriz da tela edita só os grants "simples" (sem condição nem aprovação) de
// forma canônica: um grant por (entidade, escopo) agrupando ações. Grants
// "avançados" (com condições e/ou aprovação) ficam como estão e são editados na
// seção de regras avançadas. Tudo aqui devolve dados; quem valida de verdade é
// sempre o motor (validateRole / checkNoEscalation) — a UI só reflete.
import { ENTITIES, SCOPES, validateRole, checkNoEscalation, diffRoles, scopeRank } from '/shared/permissions/index.js';
import { slug, entityLabel, actionLabel, scopeLabel } from './labels.js';

export const clone = (x) => JSON.parse(JSON.stringify(x));

/**
 * Regra "avançada": tem condição ou aprovação. `_adv` marca regras recém-criadas
 * na tela que ainda estão sem condição (senão elas "pulariam" para a matriz
 * enquanto a pessoa ainda está montando a regra). É removido ao salvar.
 */
export const isReal = (g) => (g.conditions || []).length > 0 || !!g.approval;
export const isAdvanced = (g) => !!g._adv || isReal(g);

/** Pares [entidade, ação] a que uma regra se aplica (expande '*'). */
export function expandRule(rule) {
  const entities = rule.entity === '*' ? Object.keys(ENTITIES) : ENTITIES[rule.entity] ? [rule.entity] : [];
  const out = [];
  for (const e of entities) {
    const actions = (rule.actions || []).includes('*') ? ENTITIES[e].actions : rule.actions || [];
    for (const a of actions) if (ENTITIES[e].actions.includes(a)) out.push([e, a]);
  }
  return out;
}

const key = (e, a) => `${e}.${a}`;

/** (entidade.ação) -> maior escopo entre os grants simples. */
export function simpleCells(role) {
  const cells = new Map();
  for (const g of role.grants || []) {
    if (isAdvanced(g) || !g.scope || g.scope === 'none') continue;
    for (const [e, a] of expandRule(g)) {
      const k = key(e, a);
      if (!cells.has(k) || scopeRank(g.scope) > scopeRank(cells.get(k))) cells.set(k, g.scope);
    }
  }
  return cells;
}

/** (entidade.ação) -> quantos grants avançados tocam a célula. */
export function advancedCells(role) {
  const out = new Map();
  (role.grants || []).forEach((g) => {
    if (!isAdvanced(g)) return;
    for (const [e, a] of expandRule(g)) out.set(key(e, a), (out.get(key(e, a)) || 0) + 1);
  });
  return out;
}

/** (entidade.ação) -> { full, partial } negações (full = sem condição). */
export function denyCells(role) {
  const out = new Map();
  for (const d of role.denies || []) {
    const full = !(d.conditions || []).length;
    for (const [e, a] of expandRule(d)) {
      const cur = out.get(key(e, a)) || { full: false, partial: false };
      if (full) cur.full = true;
      else cur.partial = true;
      out.set(key(e, a), cur);
    }
  }
  return out;
}

/** Reescreve os grants simples do perfil a partir das células, mantendo os avançados. */
export function rebuildSimple(role, cells) {
  const groups = new Map();
  for (const [entity, def] of Object.entries(ENTITIES)) {
    for (const action of def.actions) {
      const scope = cells.get(key(entity, action));
      if (!scope || scope === 'none') continue;
      const gk = `${entity}|${scope}`;
      if (!groups.has(gk)) groups.set(gk, { entity, actions: [], scope });
      groups.get(gk).actions.push(action);
    }
  }
  const simple = [...groups.values()].sort((a, b) => Object.keys(ENTITIES).indexOf(a.entity) - Object.keys(ENTITIES).indexOf(b.entity) || scopeRank(b.scope) - scopeRank(a.scope));
  role.grants = [...simple, ...(role.grants || []).filter(isAdvanced)];
  return role;
}

export function setCell(role, entity, action, scope) {
  const cells = simpleCells(role);
  if (scope === 'none') cells.delete(key(entity, action));
  else cells.set(key(entity, action), scope);
  return rebuildSimple(role, cells);
}

const cleanConds = (list) =>
  (list || []).map((c) => {
    const out = { field: c.field, op: c.op };
    if (c.op === 'isNull' || c.op === 'notNull') return out;
    if (c.ref) out.ref = c.ref;
    else out.value = c.value;
    return out;
  });

/** Forma estável de salvar/comparar: ordem fixa, sem marcas de edição, sem vazios. */
export function normalizeRole(role, { tenantId, id } = {}) {
  const r = clone(role);
  // 1) tira as marcas de edição e limpa condições vazias
  const rules = (r.grants || []).map((g) => {
    const out = { entity: g.entity, actions: [...g.actions], scope: g.scope };
    const conds = cleanConds(g.conditions);
    if (conds.length) out.conditions = conds;
    // aprovação SEM condição = "sempre exige aprovação" (when vazio vale verdadeiro no motor): preserva
    if (g.approval) out.approval = { when: cleanConds(g.approval.when) };
    return out;
  });
  // 2) sem condição nem aprovação = permissão simples: vai para a forma canônica da matriz
  const plain = rules.filter((g) => !g.conditions && !g.approval);
  const withCond = rules.filter((g) => g.conditions || g.approval);
  const simple = rebuildSimple({ grants: [] }, simpleCells({ grants: plain })).grants;

  const denies = (r.denies || []).map((d) => {
    const out = { entity: d.entity, actions: [...d.actions] };
    const conds = cleanConds(d.conditions);
    if (conds.length) out.conditions = conds;
    return out;
  });
  const partitions = {};
  for (const k of Object.keys(r.partitions || {}).sort()) {
    const v = r.partitions[k];
    if (v !== 'all' && v !== undefined) partitions[k] = [...v].sort();
  }
  const fields = (r.fields || [])
    .filter((f) => f.access === 'hidden' || f.access === 'readonly')
    .map((f) => ({ entity: f.entity, field: f.field, access: f.access }))
    .sort((a, b) => `${a.entity}.${a.field}`.localeCompare(`${b.entity}.${b.field}`));
  return {
    ...r,
    id: id ?? r.id,
    tenantId: tenantId ?? r.tenantId,
    system: false,
    name: String(r.name ?? '').trim(),
    description: String(r.description ?? '').trim(),
    grants: [...simple, ...withCond],
    denies,
    partitions,
    fields,
  };
}

export const blankRole = () => ({ id: '', name: '', description: '', tenantId: null, system: false, grants: [], denies: [], partitions: {}, fields: [] });

/** Id novo para perfil do tenant: role_t_<slug>, com sufixo se já existir. */
export function newRoleId(name, existingIds) {
  const base = `role_t_${slug(name)}`;
  if (!existingIds.has(base)) return base;
  let id;
  do id = `${base}_${Math.random().toString(36).slice(2, 6)}`;
  while (existingIds.has(id));
  return id;
}

// ---------------------------------------------------------------------------
// Erros de validateRole, agrupados por onde aparecem na tela
// ---------------------------------------------------------------------------

/** { name:[msg], rules: Map(índiceDoGrant -> [msg]), denies: Map(i -> [msg]), other:[{path,message}] } */
export function groupErrors(errors) {
  const out = { name: [], rules: new Map(), denies: new Map(), other: [] };
  const push = (map, i, m) => map.set(i, [...(map.get(i) || []), m]);
  for (const e of errors) {
    let m;
    if (e.path === 'name') out.name.push(e.message);
    else if ((m = /^grants\[(\d+)\]/.exec(e.path))) push(out.rules, Number(m[1]), e.message);
    else if ((m = /^denies\[(\d+)\]/.exec(e.path))) push(out.denies, Number(m[1]), e.message);
    else out.other.push(e);
  }
  return out;
}

/** Texto amigável para um caminho de erro do motor ("grants[2].conditions[0]"). */
export function pathLabel(role, path) {
  if (path === 'name') return 'Nome';
  if (path === 'id') return 'Identificador';
  let m = /^(grants|denies)\[(\d+)\](.*)$/.exec(path);
  if (m) {
    const rule = (role?.[m[1]] || [])[Number(m[2])];
    const what = m[1] === 'grants' ? 'Regra' : 'Negação';
    const where = rule ? ` (${entityLabel(rule.entity)})` : '';
    const sub = m[3].includes('approval') ? ' › aprovação' : m[3].includes('conditions') ? ' › condição' : m[3].includes('scope') ? ' › escopo' : m[3].includes('actions') ? ' › ações' : '';
    return `${what} ${Number(m[2]) + 1}${where}${sub}`;
  }
  if ((m = /^partitions\.(.+)$/.exec(path))) return `Recorte ${m[1] === 'pipelineId' ? 'de pipelines' : 'de instâncias'}`;
  if ((m = /^fields\[(\d+)\]/.exec(path))) return `Campo restrito ${Number(m[1]) + 1}`;
  return path || 'Perfil';
}

/**
 * Valida o que SERÁ salvo (forma normalizada) e leva cada erro de volta à regra
 * da tela que o causou. Os índices de validateRole são os do perfil normalizado
 * (grants simples primeiro), não os da lista de edição — daí o deslocamento.
 */
export function validateDraftRole(role, ids) {
  const norm = normalizeRole(role, ids);
  const errors = validateRole(norm);
  const grouped = groupErrors(errors);
  const adv = (role.grants || []).filter(isAdvanced);
  const realIdx = adv.map((g, i) => (isReal(g) ? i : -1)).filter((i) => i >= 0);
  const offset = norm.grants.length - realIdx.length;
  const byAdv = new Map();
  const other = [...grouped.other];
  for (const [ni, msgs] of grouped.rules) {
    const k = ni - offset;
    if (k >= 0 && k < realIdx.length) byAdv.set(realIdx[k], msgs);
    else msgs.forEach((message) => other.push({ path: `grants[${ni}]`, message }));
  }
  return { norm, errors, name: grouped.name, byAdv, denies: grouped.denies, other };
}

// ---------------------------------------------------------------------------
// Escalonamento: "você não pode conceder o que não tem"
// ---------------------------------------------------------------------------

const vKey = (v) => `${v.entity}|${v.action}|${v.scope}`;

/**
 * Violações de escalonamento do candidato. Ao EDITAR (before != null) só conta
 * poder NOVO: remover ou manter o que o perfil já dava não é escalar — senão um
 * ator limitado ficaria impedido até de reduzir um perfil poderoso.
 */
export function escalationViolations(actorCtx, after, before = null) {
  const { violations } = checkNoEscalation(actorCtx, after);
  if (!before) return violations;
  const prior = new Set(checkNoEscalation(actorCtx, before).violations.map(vKey));
  return violations.filter((v) => !prior.has(vKey(v)));
}

export const violationText = (v) => `Você não pode conceder: ${entityLabel(v.entity)} › ${actionLabel(v.action)} › ${scopeLabel(v.scope)} — seu perfil não tem esse poder`;

export { diffRoles, SCOPES };

// ---------------------------------------------------------------------------
// Presets de 1 clique
// ---------------------------------------------------------------------------

const QUEUE_ACTIONS = ['read', 'send_message', 'note', 'transfer', 'resolve'];

/**
 * Cada preset devolve { grants:[], denies:[] } a acrescentar ao perfil.
 * `param`: número pedido antes de aplicar (ex.: % de desconto).
 */
export const PRESETS = [
  {
    id: 'queue',
    area: 'grants',
    label: 'Atendente só vê a fila (conversa sem responsável)',
    hint: 'Libera ler e responder conversas que ainda não têm responsável, em toda a empresa.',
    build: () => ({ grants: [{ entity: 'conversation', actions: [...QUEUE_ACTIONS], scope: 'tenant', conditions: [{ field: 'assigneeId', op: 'isNull' }] }], denies: [] }),
  },
  {
    id: 'discount_approve',
    area: 'grants',
    label: 'Aprovar desconto até X%',
    hint: 'Pode aprovar propostas e negócios com desconto até o limite, dentro da equipe e subequipes.',
    param: { label: 'Desconto máximo (%)', value: 15, min: 0, max: 100 },
    build: (x) => ({
      grants: ['proposal', 'deal'].map((entity) => ({ entity, actions: ['approve'], scope: 'team_tree', conditions: [{ field: 'ctx.discountPct', op: 'lte', value: x }] })),
      denies: [],
    }),
  },
  {
    id: 'discount_needs_approval',
    area: 'grants',
    label: 'Desconto acima de X% exige aprovação',
    hint: 'Pode editar as próprias propostas, mas desconto acima do limite só mediante aprovação de um gestor.',
    param: { label: 'Limite sem aprovação (%)', value: 5, min: 0, max: 100 },
    build: (x) => ({ grants: [{ entity: 'proposal', actions: ['update'], scope: 'own', approval: { when: [{ field: 'ctx.discountPct', op: 'gt', value: x }] } }], denies: [] }),
  },
  {
    id: 'no_edit_closed',
    area: 'both',
    label: 'Não editar negócio ganho/perdido',
    hint: 'Cria uma negação (vence qualquer permissão): negócio fechado fica somente leitura.',
    build: () => ({ grants: [], denies: [{ entity: 'deal', actions: ['update'], conditions: [{ field: 'status', op: 'in', value: ['won', 'lost'] }] }] }),
  },
  {
    id: 'no_export',
    area: 'denies',
    label: 'Não pode exportar',
    hint: 'Bloqueia exportação em qualquer entidade.',
    build: () => ({ grants: [], denies: [{ entity: '*', actions: ['export'] }] }),
  },
  {
    id: 'no_move_closed',
    area: 'denies',
    label: 'Não pode mover para Ganho/Perdido',
    hint: 'Move negócios entre etapas normais, mas não fecha (ganho ou perdido).',
    build: () => ({ grants: [], denies: [{ entity: 'deal', actions: ['move'], conditions: [{ field: 'ctx.toStageKind', op: 'in', value: ['won', 'lost'] }] }] }),
  },
  {
    id: 'no_delete',
    area: 'denies',
    label: 'Não pode apagar',
    hint: 'Bloqueia exclusão em qualquer entidade.',
    build: () => ({ grants: [], denies: [{ entity: '*', actions: ['delete'] }] }),
  },
];
