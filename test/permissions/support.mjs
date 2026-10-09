// Infraestrutura compartilhada dos testes do motor de permissões:
// PRNG com semente (mulberry32), geradores de casos aleatórios, um ORÁCULO
// independente do motor (reimplementa as regras 1-4 de outra forma, sem usar
// expr.js) e o runner de fuzz que, em falha, imprime semente + caso mínimo.
//
// Nada aqui usa Math.random nem relógio: todo caso é função de (semente, índice).
import { ENTITIES, ACTIONS, SYSTEM_ROLES, createContext } from '../../shared/permissions/index.js';

// ---------------------------------------------------------------------------
// PRNG
// ---------------------------------------------------------------------------
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  constructor(seed) {
    this.seed = seed;
    this.next = mulberry32(seed);
  }
  float() {
    return this.next();
  }
  int(n) {
    return Math.floor(this.next() * n);
  }
  bool(p = 0.5) {
    return this.next() < p;
  }
  pick(arr) {
    return arr[this.int(arr.length)];
  }
  /** Subconjunto aleatório (cada item entra com prob. p), mantendo a ordem. */
  subset(arr, p = 0.5) {
    return arr.filter(() => this.bool(p));
  }
  /** Entre min e max itens distintos. */
  some(arr, min, max) {
    const k = min + this.int(max - min + 1);
    const pool = [...arr];
    const out = [];
    while (out.length < k && pool.length) out.push(pool.splice(this.int(pool.length), 1)[0]);
    return out;
  }
  weighted(entries) {
    const total = entries.reduce((s, [, w]) => s + w, 0);
    let r = this.next() * total;
    for (const [v, w] of entries) if ((r -= w) < 0) return v;
    return entries[entries.length - 1][0];
  }
}

// ---------------------------------------------------------------------------
// Universo pequeno (para que os acertos aconteçam com frequência)
// ---------------------------------------------------------------------------
export const TENANTS = ['A', 'B'];
export const USERS = ['u1', 'u2', 'u3', 'u4'];
export const TEAMS = ['t1', 't2', 't3', 't4', 't5', 't6'];
export const PIPES = ['p1', 'p2', 'p3'];
export const INSTS = ['i1', 'i2'];
export const ENTITY_NAMES = Object.keys(ENTITIES);
export const ACTION_NAMES = Object.keys(ACTIONS);
const CTX_KEYS = ['discountPct', 'rowCount', 'fromStageId', 'toStageId', 'fromStageKind', 'toStageKind'];
const UUID_POOL = [...USERS, ...TEAMS, ...PIPES, ...INSTS, 'x1'];
const TEXT_POOL = ['open', 'won', 'lost', 'new', 'inbound', 'outbound', 'vip', 's1', 's2'];
const NUM_POOL = [0, 5, 8, 10, 15, 20, 100];

/** Botões do gerador (os testes de valores nulos aumentam a frequência de null). */
export const knobs = { condNull: 0.12, rowNull: 0.08, rowMissing: 0.04 };

export const attrNames = (entity) => Object.keys(ENTITIES[entity].attrs);

function genScalar(rng, type, { nullP = 0.04 } = {}) {
  if (rng.bool(nullP)) return null;
  if (type === 'numeric') return rng.pick(NUM_POOL);
  if (type === 'text') return rng.pick(TEXT_POOL);
  if (type === 'boolean') return rng.bool();
  return rng.pick(UUID_POOL);
}

// ---------------------------------------------------------------------------
// Organograma, perfis, usuários, registros
// ---------------------------------------------------------------------------
/** Floresta aleatória; com chance de ciclos e auto-referência (o motor precisa tolerar). */
export function genOrg(rng, { cycles = true } = {}) {
  const teams = TEAMS.map((id) => ({ id }));
  for (const t of teams) {
    if (!rng.bool(0.55)) continue;
    if (cycles) t.parentId = rng.pick(TEAMS);
    else {
      const earlier = TEAMS.slice(0, TEAMS.indexOf(t.id));
      if (earlier.length) t.parentId = rng.pick(earlier);
    }
  }
  return { teams };
}

export function genCondition(rng, entityName, { ctxP = 0.15 } = {}) {
  let field;
  let type;
  if (rng.bool(ctxP)) {
    field = 'ctx.' + rng.pick(CTX_KEYS);
    type = field.endsWith('discountPct') || field.endsWith('rowCount') ? 'numeric' : 'text';
  } else if (rng.bool(0.03)) {
    field = 'bogus';
    type = 'text';
  } else if (entityName === '*') {
    field = rng.pick(['id', 'tenantId']);
    type = 'uuid';
  } else {
    [field, type] = rng.pick(Object.entries(ENTITIES[entityName].attrs));
  }
  const isCtx = field.startsWith('ctx.');
  const ops = type === 'numeric' ? ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'in', 'nin', 'isNull', 'notNull'] : ['eq', 'ne', 'in', 'nin', 'isNull', 'notNull'];
  const op = rng.pick(ops);
  const cond = { field, op };
  if (op === 'isNull' || op === 'notNull') return cond;
  const isList = op === 'in' || op === 'nin';
  if (type === 'uuid' && !isCtx && (op === 'eq' || op === 'ne' || isList) && rng.bool(0.15)) {
    cond.ref = isList ? '$user.teamIds' : '$user.id';
    return cond;
  }
  const one = () => genScalar(rng, type === 'numeric' ? 'numeric' : type === 'uuid' && !isCtx ? 'uuid' : 'text', { nullP: knobs.condNull });
  cond.value = isList ? Array.from({ length: rng.int(4) }, one) : one();
  return cond;
}

export function genRule(rng, kind, { entityName, approvalP = 0.15, condP = 0.35, ctxP = 0.15 } = {}) {
  const name = entityName ?? (rng.bool(0.1) ? '*' : rng.pick(ENTITY_NAMES));
  const pool = name === '*' ? ACTION_NAMES : ENTITIES[name].actions;
  const actions = rng.bool(0.12) ? ['*'] : rng.some(pool, 1, Math.min(4, pool.length));
  const rule = { entity: name, actions };
  if (kind === 'grants') {
    const allowed = name === '*' ? ['tenant'] : ENTITIES[name].scopes;
    rule.scope = rng.weighted(allowed.map((s) => [s, s === 'none' ? 1 : s === 'tenant' ? 3 : 2]));
  }
  if (rng.bool(condP)) rule.conditions = Array.from({ length: 1 + rng.int(2) }, () => genCondition(rng, name, { ctxP }));
  if (kind === 'grants' && rng.bool(approvalP)) rule.approval = { when: rng.bool(0.8) ? [genCondition(rng, name, { ctxP: 0.6 })] : [] };
  return rule;
}

export function genRole(rng, { id, tenantId, system = false, approvalP = 0.15, noApproval = false, denyP = 0.5 } = {}) {
  const role = {
    id,
    name: id,
    tenantId,
    system,
    grants: Array.from({ length: rng.int(5) }, () => genRule(rng, 'grants', { approvalP: noApproval ? 0 : approvalP })),
    denies: rng.bool(denyP) ? Array.from({ length: 1 + rng.int(2) }, () => genRule(rng, 'denies', { condP: 0.5 })) : [],
    partitions: {},
    fields: [],
  };
  if (rng.bool(0.3)) role.partitions.pipelineId = rng.bool(0.3) ? 'all' : rng.some(PIPES, 0, 2);
  if (rng.bool(0.3)) role.partitions.instanceId = rng.bool(0.3) ? 'all' : rng.some(INSTS, 0, 1);
  const fe = rng.pick(['contact', 'deal', 'conversation', 'proposal', 'company']);
  if (rng.bool(0.4)) role.fields.push({ entity: fe, field: rng.pick(ENTITIES[fe].fields), access: rng.pick(['hidden', 'readonly']) });
  return role;
}

export function genSubject(rng, { roleIds, tenantId, approvalP = 0.15 } = {}) {
  const s = {
    id: rng.pick(USERS),
    tenantId: tenantId ?? (rng.bool(0.93) ? 'A' : 'B'),
    status: rng.weighted([
      ['active', 90],
      ['suspended', 5],
      ['invited', 5],
    ]),
    teamIds: rng.some(TEAMS, 0, 3),
    roleIds: roleIds ?? [],
    mfa: rng.bool(0.6),
  };
  if (rng.bool(0.25)) {
    s.overrides = {
      grants: Array.from({ length: rng.int(3) }, () => genRule(rng, 'grants', { approvalP })),
      denies: rng.bool(0.4) ? [genRule(rng, 'denies', { condP: 0.5 })] : [],
      fields: rng.bool(0.3) ? [{ entity: 'deal', field: rng.pick(ENTITIES.deal.fields), access: rng.pick(['hidden', 'readonly']) }] : [],
    };
  }
  return s;
}

export function genRow(rng, entityName, { tenantId } = {}) {
  const entity = ENTITIES[entityName];
  const row = { id: 'r' + rng.int(1000), tenantId: tenantId ?? (rng.bool(0.85) ? 'A' : rng.pick(['B', null, undefined])) };
  for (const [attr, type] of Object.entries(entity.attrs)) {
    if (attr === 'id' || attr === 'tenantId') continue;
    let v;
    if (attr === 'teamId') v = rng.bool(Math.max(0.1, knobs.rowNull)) ? null : rng.pick(TEAMS);
    else if (attr === 'ownerId' || attr === 'assigneeId') v = rng.bool(Math.max(0.12, knobs.rowNull)) ? null : rng.pick(USERS);
    else if (attr === 'pipelineId') v = rng.pick(PIPES);
    else if (attr === 'instanceId') v = rng.pick(INSTS);
    else v = genScalar(rng, type, { nullP: knobs.rowNull });
    if (rng.bool(knobs.rowNull > 0.1 ? knobs.rowNull : 0.04)) v = rng.bool(knobs.rowMissing > 0.04 ? 0.5 : 1) ? undefined : null; // atributo ausente
    row[attr] = v;
  }
  if (rng.bool(0.3)) {
    row.sharedWith = Array.from({ length: 1 + rng.int(2) }, () => {
      const type = rng.pick(['user', 'team']);
      return { type, id: type === 'user' ? rng.pick(USERS) : rng.pick(TEAMS), level: rng.pick(['read', 'edit']) };
    });
  }
  return row;
}

export function genContext(rng, action) {
  const keys = ACTIONS[action].ctx || [];
  if (rng.bool(0.4)) return undefined;
  const ctx = {};
  for (const k of keys) {
    if (rng.bool(0.1)) continue; // chave ausente
    ctx[k] = k === 'discountPct' || k === 'rowCount' ? rng.pick(NUM_POOL) : rng.pick(TEXT_POOL);
    if (rng.bool(0.05)) ctx[k] = null;
  }
  return ctx;
}

/**
 * Caso completo de decisão, em JSON puro (para poder ser reduzido/impresso).
 *   { subject, roles:[...], org, policy, entity, action, row, context }
 */
export function genCase(rng, opts = {}) {
  const roles = [];
  const nA = rng.int(3);
  for (let i = 0; i < nA; i++) roles.push(genRole(rng, { id: `rA${i}`, tenantId: 'A', noApproval: opts.noApproval, approvalP: opts.approvalP, denyP: opts.denyP }));
  if (rng.bool(0.25)) roles.push(genRole(rng, { id: 'rB0', tenantId: 'B', noApproval: opts.noApproval }));
  const sysIds = rng.subset(
    SYSTEM_ROLES.map((r) => r.id),
    opts.sysP ?? 0.22
  );
  const roleIds = [...sysIds, ...roles.map((r) => r.id).filter(() => rng.bool(0.85))];
  if (rng.bool(0.05)) roleIds.push('ghost');
  const subject = genSubject(rng, { roleIds, tenantId: opts.subjectTenant, approvalP: opts.noApproval ? 0 : opts.approvalP });
  const entity = opts.entity ?? rng.pick(ENTITY_NAMES);
  const action = opts.action ?? rng.pick(ENTITIES[entity].actions);
  return {
    subject,
    roles,
    org: genOrg(rng),
    policy: { requireMfaForSensitive: rng.bool(0.3) },
    entity,
    action,
    row: genRow(rng, entity, { tenantId: opts.rowTenant }),
    context: genContext(rng, action),
  };
}

/** Monta o ctx do motor a partir do caso em JSON. NÃO passa por createContext (perfis estrangeiros precisam chegar ao motor). */
export function mkCtx(c) {
  const roles = new Map(SYSTEM_ROLES.map((r) => [r.id, r]));
  for (const r of Array.isArray(c.roles) ? c.roles : []) if (r && typeof r === 'object') roles.set(r.id, r);
  return { subject: c.subject, roles, org: c.org, policy: c.policy };
}

// ---------------------------------------------------------------------------
// ORÁCULO — reimplementação independente das regras 1-4 (sem expr.js).
// Devolve 'allow' | 'approval' | 'deny'.
// ---------------------------------------------------------------------------
const isNil = (x) => x === null || x === undefined;

export function cmp2(left, op, v) {
  switch (op) {
    case 'isNull':
      return isNil(left);
    case 'notNull':
      return !isNil(left);
    case 'eq':
      return !isNil(left) && left === v;
    case 'ne':
      // IS DISTINCT FROM: null contra null não é "distinto"
      if (isNil(v)) return !isNil(left);
      return isNil(left) || left !== v;
    case 'in':
      return !isNil(left) && Array.isArray(v) && v.some((x) => x === left);
    case 'nin':
      return isNil(left) || !(Array.isArray(v) && v.some((x) => x === left));
    case 'lt':
      return !isNil(left) && !isNil(v) && left < v;
    case 'lte':
      return !isNil(left) && !isNil(v) && left <= v;
    case 'gt':
      return !isNil(left) && !isNil(v) && left > v;
    case 'gte':
      return !isNil(left) && !isNil(v) && left >= v;
    default:
      throw new Error('oraculo: op ' + op);
  }
}

function descendsFrom(org, teamId, roots) {
  // sobe pela cadeia de pais (algoritmo diferente do motor, que desce pelos filhos)
  const parent = new Map((org?.teams || []).map((t) => [t.id, t.parentId]));
  const seen = new Set();
  let cur = teamId;
  while (cur !== undefined && cur !== null && !seen.has(cur)) {
    if (roots.includes(cur)) return true;
    seen.add(cur);
    cur = parent.get(cur);
  }
  return false;
}

export function oracle(c) {
  const E = ENTITIES[c.entity];
  if (!E || !E.actions.includes(c.action)) return 'deny';
  const s = c.subject;
  if (!s || s.status !== 'active') return 'deny';
  // MFA falha-fechada: política ausente = exige; só `requireMfaForSensitive: false` desliga; só mfa === true vale
  if (ACTIONS[c.action].sensitive && c.policy?.requireMfaForSensitive !== false && s.mfa !== true) return 'deny';
  const row = c.row || {};
  if (isNil(row.tenantId) || row.tenantId !== s.tenantId) return 'deny';

  const teamIds = s.teamIds || [];
  const rolesById = new Map(SYSTEM_ROLES.map((r) => [r.id, r]));
  for (const r of Array.isArray(c.roles) ? c.roles : []) if (r && typeof r === 'object') rolesById.set(r.id, r);
  const roles = (s.roleIds || []).map((id) => rolesById.get(id)).filter((r) => r && (isNil(r.tenantId) ? r.system === true : r.tenantId === s.tenantId));

  const condHolds = (cond, mode) => {
    let v = cond.value;
    if (cond.ref === '$user.id') v = s.id;
    if (cond.ref === '$user.teamIds') v = teamIds;
    let left;
    if (cond.field.startsWith('ctx.')) {
      const k = cond.field.slice(4);
      if (!c.context || c.context[k] === undefined) return mode === 'deny';
      left = c.context[k];
      // null só serve para isNull/notNull; número negativo é inválido no contexto (desconto %, nº de linhas)
      if (left === null && cond.op !== 'isNull' && cond.op !== 'notNull') return mode === 'deny';
      if (typeof left === 'number' && left < 0) return mode === 'deny';
    } else {
      if (!Object.hasOwn(E.attrs, cond.field)) return mode === 'deny';
      left = row[cond.field];
    }
    return cmp2(left, cond.op, v);
  };
  const allCond = (list, mode) => (list || []).every((x) => condHolds(x, mode));
  const matches = (g) => (g.entity === c.entity || g.entity === '*') && (g.actions.includes(c.action) || g.actions.includes('*'));

  const scopeOk = (scope) => {
    const owner = E.ownerField ? row[E.ownerField] : undefined;
    const team = E.teamField ? row[E.teamField] : undefined;
    const isOwner = !!E.ownerField && !isNil(owner) && owner === s.id;
    switch (scope) {
      case 'tenant':
        return true;
      case 'own':
        return isOwner;
      case 'team':
        return isOwner || (!!E.teamField && !isNil(team) && teamIds.includes(team));
      case 'team_tree':
        return isOwner || (!!E.teamField && !isNil(team) && descendsFrom(c.org, team, teamIds));
      default:
        return false;
    }
  };
  const partOk = (role) => {
    for (const [key, attr] of Object.entries(E.partitions)) {
      const allowed = role.partitions?.[key];
      if (allowed === undefined || allowed === 'all') continue;
      const v = row[attr];
      if (!(Array.isArray(allowed) && !isNil(v) && allowed.includes(v))) return false;
    }
    return true;
  };

  const sources = [
    ...roles.map((r) => ({ role: r, grants: r.grants || [], denies: r.denies || [] })),
    { role: null, grants: s.overrides?.grants || [], denies: s.overrides?.denies || [] },
  ];
  for (const src of sources) for (const d of src.denies) if (matches(d) && allCond(d.conditions, 'deny')) return 'deny';

  let best = 'deny';
  for (const src of sources) {
    for (const g of src.grants) {
      if (!matches(g)) continue;
      if (!scopeOk(g.scope)) continue;
      if (src.role && !partOk(src.role)) continue;
      if (!allCond(g.conditions, 'allow')) continue;
      const needsApproval = g.approval ? allCond(g.approval.when, 'deny') : false;
      if (!needsApproval) return 'allow';
      best = 'approval';
    }
  }
  if (E.shareable && (c.action === 'read' || c.action === 'update')) {
    const levels = c.action === 'read' ? ['read', 'edit'] : ['edit'];
    const shares = Array.isArray(row.sharedWith) ? row.sharedWith : [];
    const treeTeams = [];
    const stack = [...teamIds];
    const seen = new Set();
    while (stack.length) {
      const x = stack.pop();
      if (seen.has(x)) continue;
      seen.add(x);
      treeTeams.push(x);
      for (const t of c.org?.teams || []) if (t.parentId === x) stack.push(t.id);
    }
    if (shares.some((g) => levels.includes(g.level) && ((g.type === 'user' && g.id === s.id) || (g.type === 'team' && teamIds.includes(g.id))))) return 'allow';
  }
  return best;
}

// ---------------------------------------------------------------------------
// Runner de fuzz + redutor de casos
// ---------------------------------------------------------------------------
/** Reduz um caso JSON removendo elementos de listas e chaves de objetos enquanto `bad(caso)` continuar verdadeiro. */
export function shrink(value, bad, budget = 3000) {
  const clone = (x) => JSON.parse(JSON.stringify(x));
  let cur = clone(value);
  let steps = 0;
  const paths = (obj, prefix = []) => {
    const out = [];
    if (obj && typeof obj === 'object') {
      for (const k of Object.keys(obj)) {
        out.push([...prefix, k]);
        out.push(...paths(obj[k], [...prefix, k]));
      }
    }
    return out;
  };
  const without = (root, path) => {
    const c = clone(root);
    let o = c;
    for (const k of path.slice(0, -1)) o = o[k];
    const last = path[path.length - 1];
    if (Array.isArray(o)) o.splice(Number(last), 1);
    else delete o[last];
    return c;
  };
  let changed = true;
  while (changed && steps < budget) {
    changed = false;
    for (const p of paths(cur).reverse()) {
      if (steps++ > budget) break;
      let cand;
      try {
        cand = without(cur, p);
      } catch {
        continue;
      }
      let still = false;
      try {
        still = bad(cand);
      } catch {
        still = false;
      }
      if (still) {
        cur = cand;
        changed = true;
        break;
      }
    }
  }
  return cur;
}

/**
 * Executa `n` casos determinísticos. O caso i usa a semente (seed + i*7919), então
 * toda falha é reproduzível: FUZZ_SEED=<base> FUZZ_N=<i+1> npm test.
 * `check` lança (assert) quando a propriedade é violada.
 */
export function fuzz(name, { seed = 1, n = 1000, gen, check, shrinkable = true }) {
  const baseSeed = process.env.FUZZ_SEED ? Number(process.env.FUZZ_SEED) : seed;
  const count = process.env.FUZZ_N ? Number(process.env.FUZZ_N) : n;
  for (let i = 0; i < count; i++) {
    const caseSeed = (baseSeed + i * 7919) >>> 0;
    const rng = new Rng(caseSeed);
    const input = gen(rng, i);
    try {
      check(input, i);
    } catch (e) {
      let minimal = input;
      if (shrinkable) {
        // só vale reduzir se a MESMA falha continuar acontecendo (senão o redutor degenera)
        const sig = String(e && e.message);
        minimal = shrink(input, (cand) => {
          try {
            check(cand, i);
            return false;
          } catch (e2) {
            return String(e2 && e2.message) === sig;
          }
        });
      }
      const msg =
        `[fuzz:${name}] FALHOU no caso #${i}\n` +
        `  semente do caso: ${caseSeed} (base ${baseSeed}; reproduza com FUZZ_SEED=${baseSeed} FUZZ_N=${i + 1})\n` +
        `  erro: ${e && e.message ? e.message.split('\n').slice(0, 8).join('\n        ') : e}\n` +
        `  CASO MÍNIMO: ${JSON.stringify(minimal)}`;
      const err = new Error(msg);
      err.cause = e;
      throw err;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Fixtures determinísticas dos testes unitários e da matriz dourada
// ---------------------------------------------------------------------------
export const ORG = {
  teams: [
    { id: 'T1' }, // raiz da equipe do usuário
    { id: 'T1a', parentId: 'T1' }, // subequipe
    { id: 'T1a1', parentId: 'T1a' }, // sub-subequipe
    { id: 'T2' }, // outra equipe, fora da árvore
    { id: 'T2a', parentId: 'T2' },
  ],
};

export const subjectOf = (id, roleIds, extra = {}) => ({ id, tenantId: 'A', status: 'active', roleIds, teamIds: ['T1'], mfa: true, ...extra });

export const ctxOf = (subject, { tenantRoles = [], org = ORG, policy = {} } = {}) => createContext({ subject, tenantRoles, org, policy });

/** Perfil de tenant mínimo para testes unitários. */
export const roleOf = (id, grants, extra = {}) => ({ id, name: id, tenantId: 'A', system: false, grants, denies: [], partitions: {}, fields: [], ...extra });
