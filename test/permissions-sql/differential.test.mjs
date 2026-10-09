// TESTE DIFERENCIAL — o mais importante.
//
// Para cada usuário x entidade x ação, compara o CONJUNTO DE IDs que o Postgres
// devolve ao executar o WHERE compilado pelo motor (toSql) com o conjunto que o
// motor calcula em JS (toPredicate sobre as mesmas linhas). Têm de ser IGUAIS.
// Também prova que o teto de RLS (camada 2) é SEMPRE superset do que o motor permite.
//
// Dados: PRNG mulberry32 de semente fixa (TTF_DIFF_SEED sobrescreve, para fuzz),
// sem Date.now/Math.random. Em divergência: imprime semente, usuário, registro e
// as duas expressões — isso é BUG DO MOTOR OU DO toSql, não do teste.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { detectEnv, startPostgres, adminTx, mulberry32, uuidGen } from './_harness.mjs';
import * as P from '../../shared/permissions/index.js';
import { readScopesFor } from '../../db/read-scopes.mjs';

const require = createRequire(import.meta.url);
const { withTenant } = require('../../src/db-tenant.js');
const env = await detectEnv();

const SEED = Number(process.env.TTF_DIFF_SEED ?? 20261009);
const { ENTITIES, SCOPES, SYSTEM_ROLES } = P;

// ---------------------------------------------------------------------------
// Geração do mundo (pura e determinística)
// ---------------------------------------------------------------------------
const V = {
  deal: { status: ['open', 'won', 'lost'] },
  contact: { status: ['lead', 'active', 'inactive', 'blocked'], source: ['whatsapp', 'site', 'indicacao', 'import'] },
  company: { status: ['prospect', 'customer', 'churned'] },
  conversation: { status: ['open', 'pending', 'resolved', 'bot'] },
  proposal: { status: ['draft', 'sent', 'accepted', 'rejected'] },
  task: { status: ['todo', 'doing', 'done'] },
  call: { direction: ['inbound', 'outbound'] },
};
const RECORD_ENTITIES = ['contact', 'company', 'deal', 'conversation', 'proposal', 'task', 'call'];
const CONFIG_WITH_TABLE = ['user', 'role', 'pipeline', 'instance', 'audit_log'];
const TABLE_ENTITIES = [...RECORD_ENTITIES, ...CONFIG_WITH_TABLE];

function buildWorld(seed) {
  const rng = mulberry32(seed);
  const newId = uuidGen(rng);
  const int = (n) => Math.floor(rng() * n);
  const chance = (p) => rng() < p;
  const pick = (a) => a[int(a.length)];
  const sample = (a, k) => {
    const c = [...a];
    const out = [];
    while (out.length < k && c.length) out.push(c.splice(int(c.length), 1)[0]);
    return out;
  };
  const half = (max) => int(max * 2) / 2; // múltiplos de 0.5: exatos em float E em numeric(14,2)

  const tenants = [];
  const world = { seed, tenants, rows: {}, rolesInvalid: 0 };
  for (const t of ['tenant_a', 'tenant_b', 'tenant_c']) {
    const T = { key: t, id: newId(), policy: { requireMfaForSensitive: t === 'tenant_a' } };
    T.pipelines = Array.from({ length: 4 }, () => ({ id: newId() }));
    T.stages = T.pipelines.flatMap((p) => ['open', 'open', 'won', 'lost'].map((kind) => ({ id: newId(), pipelineId: p.id, kind })));
    T.instances = Array.from({ length: 3 }, () => ({ id: newId() }));

    // organograma: 2 raízes, até 4 níveis (raiz > filha > neta > bisneta)
    T.teams = [];
    const addTeam = (parentId) => {
      const x = { id: newId(), parentId };
      T.teams.push(x);
      return x;
    };
    const r0 = addTeam(null);
    const r1 = addTeam(null);
    const chain = [r0];
    for (let d = 1; d <= 3; d++) chain.push(addTeam(chain[d - 1].id)); // cadeia garante profundidade 3
    for (const root of [r0, r1]) {
      for (let k = 0; k < 2 + int(2); k++) {
        const c1 = addTeam(root.id);
        if (chance(0.7)) {
          const c2 = addTeam(c1.id);
          if (chance(0.5)) addTeam(c2.id);
        }
      }
    }

    T.users = Array.from({ length: 12 }, (_, i) => ({
      id: newId(),
      status: i === 1 ? 'suspended' : i === 2 ? 'invited' : 'active',
      mfa: chance(0.6),
      teamIds: sample(T.teams.map((x) => x.id), int(4)), // 0..3 equipes
      roleIds: [],
      overrides: {},
    }));
    world.tenants.push(T);
  }

  // ---- linhas de negócio ----
  const nullable = (p, v) => (chance(p) ? null : v);
  const rows = (world.rows = { contacts: [], companies: [], deals: [], conversations: [], proposals: [], tasks: [], calls: [], users: [], roles: [], pipelines: [], instances: [], audit_log: [] });
  for (const T of world.tenants) {
    const uid = () => pick(T.users).id;
    const tid = () => pick(T.teams).id;
    const base = () => ({ id: newId(), tenantId: T.id, ownerId: nullable(0.12, uid()), teamId: nullable(0.15, tid()), sharedWith: [] });
    for (let i = 0; i < 800; i++) {
      const pipeline = nullable(0.1, pick(T.pipelines).id);
      const stage = pipeline && chance(0.85) ? pick(T.stages.filter((s) => s.pipelineId === pipeline)).id : null;
      rows.deals.push({ ...base(), title: 'd' + i, pipelineId: pipeline, stageId: stage, value: nullable(0.15, half(100000)), status: pick(V.deal.status) });
      rows.contacts.push({ ...base(), name: 'c' + i, source: nullable(0.2, pick(V.contact.source)), status: nullable(0.1, pick(V.contact.status)) });
      const conv = base();
      rows.conversations.push({ ...conv, assigneeId: nullable(0.3, uid()), instanceId: nullable(0.1, pick(T.instances).id), status: nullable(0.05, pick(V.conversation.status)) });
    }
    for (let i = 0; i < 300; i++) {
      rows.companies.push({ ...base(), name: 'co' + i, status: nullable(0.2, pick(V.company.status)) });
      rows.proposals.push({ ...base(), status: nullable(0.1, pick(V.proposal.status)), discountPct: nullable(0.3, half(30)) });
      rows.tasks.push({ ...base(), status: nullable(0.1, pick(V.task.status)) });
      rows.calls.push({ ...base(), instanceId: nullable(0.1, pick(T.instances).id), direction: nullable(0.1, pick(V.call.direction)) });
    }
    for (const u of T.users) rows.users.push({ id: u.id, tenantId: T.id, sharedWith: [] });
    for (const p of T.pipelines) rows.pipelines.push({ id: p.id, tenantId: T.id, sharedWith: [] });
    for (const x of T.instances) rows.instances.push({ id: x.id, tenantId: T.id, sharedWith: [] });
    for (let i = 0; i < 6; i++) rows.audit_log.push({ id: newId(), tenantId: T.id, sharedWith: [] });

    // compartilhamentos (deal/contact/company), usuário ou equipe, read/edit, sem duplicata
    T.shares = [];
    const seen = new Set();
    for (let i = 0; i < 300; i++) {
      const entity = pick(['deal', 'contact', 'company']);
      const table = ENTITIES[entity].table;
      const target = pick(rows[table].filter((r) => r.tenantId === T.id).slice(0, 400));
      const subjectType = chance(0.55) ? 'user' : 'team';
      const subjectId = subjectType === 'user' ? uid() : tid();
      const key = `${entity}|${target.id}|${subjectType}|${subjectId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const level = chance(0.5) ? 'read' : 'edit';
      T.shares.push({ entity, resourceId: target.id, subjectType, subjectId, level });
      target.sharedWith.push({ type: subjectType, id: subjectId, level });
    }
  }

  // ---- perfis personalizados, atribuições, overrides ----
  const attrDomain = (T, entName, field, tableRows) => {
    const ent = ENTITIES[entName];
    switch (field) {
      case 'ownerId': case 'assigneeId': return () => (chance(0.1) ? newId() : pick(T.users).id);
      case 'teamId': return () => (chance(0.1) ? newId() : pick(T.teams).id);
      case 'pipelineId': return () => (chance(0.1) ? newId() : pick(T.pipelines).id);
      case 'stageId': return () => (chance(0.1) ? newId() : pick(T.stages).id);
      case 'instanceId': return () => (chance(0.1) ? newId() : pick(T.instances).id);
      case 'id': return () => { const mine = tableRows.filter((r) => r.tenantId === T.id).slice(0, 50); return mine.length ? pick(mine).id : newId(); };
      case 'value': return () => half(100000);
      case 'discountPct': return () => half(30);
      default: {
        const vocab = V[entName]?.[field];
        if (vocab) return () => (chance(0.1) ? 'inexistente' : pick(vocab));
        return () => 'x';
      }
    }
  };

  const genCondition = (T, entName) => {
    const ent = ENTITIES[entName];
    const tableRows = rows[ent.table] || [];
    const fields = Object.keys(ent.attrs).filter((a) => a !== 'tenantId');
    const field = pick(fields);
    const type = ent.attrs[field];
    // referências ao usuário
    if (chance(0.15)) {
      if (field === ent.ownerField || field === 'ownerId' || field === 'assigneeId') return { field, op: pick(['eq', 'ne']), ref: '$user.id' };
      if (field === 'teamId') return { field, op: pick(['in', 'nin']), ref: '$user.teamIds' };
    }
    const dom = attrDomain(T, entName, field, tableRows);
    const ops = type === 'numeric' ? ['eq', 'ne', 'in', 'nin', 'lt', 'lte', 'gt', 'gte', 'isNull', 'notNull'] : ['eq', 'ne', 'in', 'nin', 'isNull', 'notNull'];
    const op = pick(ops);
    if (op === 'isNull' || op === 'notNull') return { field, op };
    if (op === 'in' || op === 'nin') return { field, op, value: Array.from({ length: 1 + int(3) }, dom) };
    return { field, op, value: dom() };
  };

  const genGrant = (T, kind) => {
    if (chance(0.05) && kind === 'grants') return { entity: '*', actions: ['*'], scope: 'tenant' };
    const name = chance(0.15) ? pick(CONFIG_WITH_TABLE) : pick(RECORD_ENTITIES);
    const ent = ENTITIES[name];
    let actions = chance(0.08) ? ['*'] : sample(ent.actions, 1 + int(4));
    if (actions[0] !== '*' && chance(0.6) && !actions.includes('read')) actions = ['read', ...actions]; // leitura é o caso comum
    if (actions[0] === '*') actions = ['*'];
    const g = { entity: name, actions };
    if (kind === 'grants') g.scope = chance(0.7) ? pick(ent.scopes.filter((s) => s !== 'none' && s !== 'tenant').concat(ent.scopes.length === 2 ? ['tenant'] : [])) : pick(ent.scopes);
    const nc = chance(kind === 'denies' ? 0.9 : 0.4) ? 1 + int(2) : 0;
    const conds = Array.from({ length: nc }, () => genCondition(T, name));
    // condições de contexto (só onde a ação as define) — sem contexto na lista: permite=falso, nega=verdadeiro
    if (name === 'deal' && actions.length === 1 && actions[0] === 'move' && chance(0.7)) conds.push({ field: 'ctx.toStageKind', op: 'in', value: ['won', 'lost'] });
    if ((name === 'proposal' || name === 'deal') && actions.length === 1 && actions[0] === 'approve' && chance(0.7)) conds.push({ field: 'ctx.discountPct', op: 'lte', value: 10 + int(10) });
    if (conds.length) g.conditions = conds;
    if (kind === 'grants' && name === 'proposal' && actions.length === 1 && actions[0] === 'update' && chance(0.4)) g.approval = { when: [{ field: 'ctx.discountPct', op: 'gt', value: 5 }] };
    return g;
  };

  const genRole = (T, idx) => {
    for (let attempt = 0; attempt < 30; attempt++) {
      const role = {
        id: newId(), tenantId: T.id, name: `Perfil ${T.key} ${idx}`, system: false,
        grants: Array.from({ length: 3 + int(7) }, () => genGrant(T, 'grants')),
        denies: Array.from({ length: int(3) }, () => genGrant(T, 'denies')).map((d) => {
          delete d.scope;
          return d;
        }),
        partitions: {},
        fields: [],
      };
      if (chance(0.35)) role.partitions.pipelineId = chance(0.1) ? [] : sample(T.pipelines.map((p) => p.id), 1 + int(3));
      if (chance(0.25)) role.partitions.instanceId = chance(0.1) ? [] : sample(T.instances.map((p) => p.id), 1 + int(2));
      if (P.validateRole(role).length === 0) return role;
      world.rolesInvalid++;
    }
    throw new Error('não consegui gerar perfil válido');
  };

  const sysIds = SYSTEM_ROLES.map((r) => r.id);
  for (const T of world.tenants) {
    T.customRoles = Array.from({ length: 8 }, (_, i) => genRole(T, i));
    for (const r of T.customRoles) rows.roles.push({ id: r.id, tenantId: T.id, sharedWith: [] });
    T.users.forEach((u, i) => {
      const ids = [];
      if (i === 0) ids.push('role_admin');
      else if (i < 7) ids.push(sysIds[i % sysIds.length]); // todos os perfis de sistema aparecem
      if (i >= 4) ids.push(pick(T.customRoles).id);
      if (i >= 8 && chance(0.7)) ids.push(pick(T.customRoles).id);
      if (i >= 3 && i < 8 && chance(0.5)) ids.push(pick(T.customRoles).id);
      if (!ids.length) ids.push(pick(sysIds));
      u.roleIds = [...new Set(ids)];
      if (chance(0.3)) {
        const o = { grants: Array.from({ length: 1 + int(2) }, () => genGrant(T, 'grants')) };
        if (chance(0.5)) o.denies = [genGrant(T, 'denies')].map((d) => (delete d.scope, d));
        if (P.validateRole({ id: 'o', name: 'o', grants: o.grants, denies: o.denies || [], partitions: {}, fields: [] }).length === 0) u.overrides = o;
      }
    });
  }
  return world;
}

// ---------------------------------------------------------------------------
// Carga no Postgres
// ---------------------------------------------------------------------------
const snake = P.columnOf;
async function bulk(c, table, cols, jsRows, map) {
  if (!jsRows.length) return;
  const list = cols.map(([n]) => n).join(', ');
  const defs = cols.map(([n, t]) => `${n} ${t}`).join(', ');
  const data = jsRows.map(map);
  for (let i = 0; i < data.length; i += 1000) {
    await c.query(`INSERT INTO ${table} (${list}) SELECT ${list} FROM jsonb_to_recordset($1::jsonb) AS x(${defs})`, [JSON.stringify(data.slice(i, i + 1000))]);
  }
}
const col = (...names) => names.map((n) => [n, n === 'value' || n === 'discount_pct' ? 'numeric' : n === 'system_role_id' ? 'text' : n.endsWith('_id') || n === 'id' ? 'uuid' : 'text']);

async function loadWorld(h, world) {
  const { rows } = world;
  for (const T of world.tenants) {
    await h.admin.query('INSERT INTO tenants (id, name, slug, settings) VALUES ($1,$2,$3,$4)', [T.id, T.key, T.key.replace('_', '-'), JSON.stringify(T.policy)]);
    await adminTx(h.admin, T.id, async (c) => {
      await bulk(c, 'users', [...col('id', 'tenant_id', 'email', 'name', 'status'), ['mfa_enabled', 'boolean'], ['overrides', 'jsonb']], T.users, (u) => ({ id: u.id, tenant_id: T.id, email: `${u.id}@t.com`, name: 'u', status: u.status, mfa_enabled: u.mfa, overrides: u.overrides }));
      for (const t of T.teams) await c.query('INSERT INTO teams (id, tenant_id, name, parent_id) VALUES ($1,$2,$3,$4)', [t.id, T.id, 'eq', t.parentId]); // pais antes dos filhos (ordem de criação)
      await bulk(c, 'team_members', col('tenant_id', 'team_id', 'user_id'), T.users.flatMap((u) => u.teamIds.map((tm) => ({ u, tm }))), ({ u, tm }) => ({ tenant_id: T.id, team_id: tm, user_id: u.id }));
      await bulk(c, 'pipelines', col('id', 'tenant_id', 'name'), T.pipelines, (p) => ({ id: p.id, tenant_id: T.id, name: 'p' }));
      await bulk(c, 'pipeline_stages', [...col('id', 'tenant_id', 'pipeline_id', 'name', 'kind')], T.stages, (s) => ({ id: s.id, tenant_id: T.id, pipeline_id: s.pipelineId, name: 's', kind: s.kind }));
      await bulk(c, 'instances', col('id', 'tenant_id', 'name'), T.instances, (x) => ({ id: x.id, tenant_id: T.id, name: 'i' }));
      await bulk(c, 'roles', [...col('id', 'tenant_id', 'name'), ['definition', 'jsonb']], T.customRoles, (r) => ({ id: r.id, tenant_id: T.id, name: r.name, definition: { grants: r.grants, denies: r.denies, partitions: r.partitions, fields: r.fields } }));
      await bulk(c, 'user_roles', col('tenant_id', 'user_id', 'system_role_id', 'role_id'), T.users.flatMap((u) => u.roleIds.map((rid) => ({ u, rid }))), ({ u, rid }) => ({
        tenant_id: T.id, user_id: u.id, system_role_id: rid.startsWith('role_') ? rid : null, role_id: rid.startsWith('role_') ? null : rid,
      }));
      const mine = (table) => rows[table].filter((r) => r.tenantId === T.id);
      const common = (r) => ({ id: r.id, tenant_id: T.id, owner_id: r.ownerId, team_id: r.teamId });
      await bulk(c, 'contacts', col('id', 'tenant_id', 'owner_id', 'team_id', 'name', 'source', 'status'), mine('contacts'), (r) => ({ ...common(r), name: r.name, source: r.source, status: r.status }));
      await bulk(c, 'companies', col('id', 'tenant_id', 'owner_id', 'team_id', 'name', 'status'), mine('companies'), (r) => ({ ...common(r), name: r.name, status: r.status }));
      await bulk(c, 'deals', col('id', 'tenant_id', 'owner_id', 'team_id', 'title', 'pipeline_id', 'stage_id', 'value', 'status'), mine('deals'), (r) => ({ ...common(r), title: r.title, pipeline_id: r.pipelineId, stage_id: r.stageId, value: r.value, status: r.status }));
      await bulk(c, 'conversations', col('id', 'tenant_id', 'owner_id', 'team_id', 'assignee_id', 'instance_id', 'status'), mine('conversations'), (r) => ({ ...common(r), assignee_id: r.assigneeId, instance_id: r.instanceId, status: r.status }));
      await bulk(c, 'proposals', col('id', 'tenant_id', 'owner_id', 'team_id', 'status', 'discount_pct'), mine('proposals'), (r) => ({ ...common(r), status: r.status, discount_pct: r.discountPct }));
      await bulk(c, 'tasks', col('id', 'tenant_id', 'owner_id', 'team_id', 'status'), mine('tasks'), (r) => ({ ...common(r), status: r.status }));
      await bulk(c, 'calls', col('id', 'tenant_id', 'owner_id', 'team_id', 'instance_id', 'direction'), mine('calls'), (r) => ({ ...common(r), instance_id: r.instanceId, direction: r.direction }));
      await bulk(c, 'audit_log', col('id', 'tenant_id', 'action'), mine('audit_log'), (r) => ({ id: r.id, tenant_id: T.id, action: 'seed.diff' }));
      await bulk(c, 'resource_shares', col('tenant_id', 'entity', 'resource_id', 'subject_type', 'subject_id', 'level'), T.shares, (s) => ({ tenant_id: T.id, entity: s.entity, resource_id: s.resourceId, subject_type: s.subjectType, subject_id: s.subjectId, level: s.level }));
    });
  }
}

/** Mexe no organograma já carregado (mover subárvores) para exercitar o trigger da closure em escala. */
async function reorganize(h, world, seed) {
  const rng = mulberry32(seed ^ 0x9e3779b9);
  for (const T of world.tenants) {
    const subtree = (id) => P.expandTeams({ teams: T.teams }, [id]);
    await adminTx(h.admin, T.id, async (c) => {
      let moves = 0;
      for (let i = 0; i < 40 && moves < 6; i++) {
        const t = T.teams[Math.floor(rng() * T.teams.length)];
        if (T.teams.indexOf(t) < 5) continue; // preserva a cadeia profunda (índices 0..4)
        const candidates = T.teams.filter((p) => !subtree(t.id).includes(p.id) && p.id !== t.parentId);
        const parent = rng() < 0.15 ? null : candidates[Math.floor(rng() * candidates.length)]?.id ?? null;
        await c.query('UPDATE teams SET parent_id = $2 WHERE id = $1', [t.id, parent]);
        t.parentId = parent;
        moves++;
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Contexto de motor montado a partir do que o BANCO devolve (como a app faria)
// ---------------------------------------------------------------------------
async function loadSubjects(app, world) {
  const out = [];
  for (const T of world.tenants) {
    await withTenant(app, { tenantId: T.id, readScopes: 'tenant' }, async (c) => {
      const users = (await c.query('SELECT id, status, mfa_enabled, overrides FROM users ORDER BY id')).rows;
      const teams = (await c.query('SELECT id, parent_id FROM teams ORDER BY id')).rows;
      const members = (await c.query('SELECT user_id, team_id FROM team_members')).rows;
      const urs = (await c.query('SELECT user_id, system_role_id, role_id FROM user_roles')).rows;
      const roleRows = (await c.query('SELECT id, name, definition FROM roles')).rows;
      const policy = (await c.query('SELECT settings FROM tenants')).rows[0].settings;
      const org = { teams: teams.map((t) => ({ id: t.id, parentId: t.parent_id })) };
      const tenantRoles = roleRows.map((r) => ({ ...r.definition, id: r.id, tenantId: T.id, name: r.name, system: false })); // identidade vem das colunas
      for (const u of users) {
        const teamIds = members.filter((m) => m.user_id === u.id).map((m) => m.team_id);
        const treeDb = (await c.query('SELECT DISTINCT descendant_id FROM team_closure WHERE ancestor_id = ANY($1::uuid[])', [teamIds])).rows.map((r) => r.descendant_id).sort();
        assert.deepEqual(treeDb, P.expandTeams(org, teamIds).sort(), `closure != expandTeams (usuário ${u.id})`);
        const roleIds = urs.filter((x) => x.user_id === u.id).map((x) => x.system_role_id ?? x.role_id);
        const ctx = P.createContext({ subject: { id: u.id, tenantId: T.id, status: u.status, mfa: u.mfa_enabled, roleIds, teamIds, overrides: u.overrides }, tenantRoles, org, policy });
        out.push({ tenant: T, user: u, teamIds, treeIds: treeDb, ctx, label: `${T.key}/${u.id.slice(0, 8)}[${roleIds.map((r) => (r.startsWith('role_') ? r : 'custom')).join('+')}/${u.status}]` });
      }
    });
  }
  return out;
}

const TABLE_OF = (entity) => ENTITIES[entity].table;
const idSet = (arr) => new Set(arr);
function diffSets(expected, actual) {
  const missing = [...expected].filter((x) => !actual.has(x));
  const extra = [...actual].filter((x) => !expected.has(x));
  return { missing, extra };
}

describe(`teste diferencial motor JS x Postgres (semente ${SEED})`, { skip: env.skip || false }, () => {
  let h;
  let world;
  let subjects;
  const stats = { comparisons: 0, nonTrivial: 0, sharedExprs: 0, blocked: 0, rowsCompared: 0, rlsNarrower: 0 };
  const rowsByTable = () => world.rows;

  before(async () => {
    h = await startPostgres(env.pg, 'diff');
    world = buildWorld(SEED);
    await loadWorld(h, world);
    await reorganize(h, world, SEED);
    subjects = await loadSubjects(h.app, world);
  });
  after(async () => {
    if (h) await h.dispose();
  });

  /** Expressão -> {sql, params, expectedIds:Set} para um usuário/entidade/ação. */
  const planCache = new Map();
  function plan(s, entity, action) {
    const key = `${s.user.id}|${entity}|${action}`;
    if (!planCache.has(key)) planCache.set(key, buildPlan(s, entity, action));
    return planCache.get(key);
  }
  function buildPlan(s, entity, action) {
    const f = P.filterFor(s.ctx, entity, action);
    const { sql, params } = P.toSql(f.expr, ENTITIES[entity], { alias: 't' });
    const pred = P.toPredicate(f.expr);
    const expected = idSet(rowsByTable()[TABLE_OF(entity)].filter(pred).map((r) => r.id));
    return { f, sql, params, expected, pred };
  }

  const report = (s, entity, action, p, d, source) => {
    const rowsAll = rowsByTable()[TABLE_OF(entity)];
    const bad = [...d.missing.map((id) => ({ id, jsAllows: true, pgAllows: false })), ...d.extra.map((id) => ({ id, jsAllows: false, pgAllows: true }))].slice(0, 3);
    return {
      semente: SEED, origem: source, usuario: s.label, userId: s.user.id, entidade: entity, acao: action,
      faltandoNoPg: d.missing.length, sobrandoNoPg: d.extra.length,
      exemplos: bad.map((b) => ({ ...b, registro: rowsAll.find((r) => r.id === b.id) })),
      exprJs: P.describe(p.f.expr), sql: p.sql, params: p.params,
    };
  };

  test('o mundo gerado é grande e variado (≥3 tenants, ≥30 usuários, ≥2000 por tabela principal, árvore ≥3 níveis, perfis válidos)', async (t) => {
    assert.equal(world.tenants.length, 3);
    assert.ok(subjects.length >= 30, 'usuários: ' + subjects.length);
    for (const tbl of ['deals', 'contacts', 'conversations']) assert.ok(world.rows[tbl].length >= 2000, tbl);
    const { rows } = await h.admin.query('SELECT tenant_id, max(depth)::int d FROM team_closure GROUP BY 1');
    assert.equal(rows.length, 3);
    for (const r of rows) assert.ok(r.d >= 3, 'profundidade da árvore: ' + r.d);
    const nulls = (tbl, f) => world.rows[tbl].filter((r) => r[f] == null).length;
    assert.ok(nulls('deals', 'ownerId') > 0 && nulls('deals', 'value') > 0 && nulls('deals', 'pipelineId') > 0 && nulls('contacts', 'status') > 0 && nulls('conversations', 'assigneeId') > 0);
    const custom = world.tenants.flatMap((x) => x.customRoles);
    assert.ok(custom.some((r) => r.denies.length) && custom.some((r) => Object.keys(r.partitions).length) && custom.some((r) => r.grants.some((g) => g.conditions)));
    assert.ok(world.tenants.some((x) => x.users.some((u) => u.overrides.grants)), 'sem overrides');
    assert.ok(world.tenants.some((x) => x.shares.length > 100));
    const statuses = new Set(subjects.map((s) => s.user.status));
    assert.deepEqual([...statuses].sort(), ['active', 'invited', 'suspended']);
    t.diagnostic(`semente=${SEED} usuários=${subjects.length} perfisInválidosDescartados=${world.rolesInvalid} linhas(deals/contacts/conversations)=${world.rows.deals.length}/${world.rows.contacts.length}/${world.rows.conversations.length} shares=${world.tenants.reduce((a, x) => a + x.shares.length, 0)}`);
  });

  test('(c1) WHERE de toSql no Postgres == toPredicate em JS — todos os usuários x entidades x ações (sem RLS: semântica pura do SQL)', async (t) => {
    const divergences = [];
    for (const s of subjects) {
      for (const entity of TABLE_ENTITIES) {
        for (const action of ENTITIES[entity].actions) {
          const p = plan(s, entity, action);
          const { rows } = await h.admin.query(`SELECT id FROM ${TABLE_OF(entity)} t WHERE ${p.sql}`, p.params);
          const actual = idSet(rows.map((r) => r.id));
          const d = diffSets(p.expected, actual);
          stats.comparisons++;
          stats.rowsCompared += rowsByTable()[TABLE_OF(entity)].length;
          const tenantTotal = rowsByTable()[TABLE_OF(entity)].filter((r) => r.tenantId === s.tenant.id).length;
          const kind = p.expected.size === 0 ? 'vazio' : p.expected.size >= tenantTotal ? 'tenantInteiro' : 'parcial';
          stats[kind] = (stats[kind] || 0) + 1;
          if (kind === 'parcial') {
            stats.nonTrivial++;
            if (RECORD_ENTITIES.includes(entity)) stats.parcialRecord = (stats.parcialRecord || 0) + 1;
          }
          if (p.sql.includes('resource_shares')) stats.sharedExprs++;
          if (p.f.blocked) stats.blocked++;
          if (d.missing.length || d.extra.length) divergences.push(report(s, entity, action, p, d, 'superusuario'));
        }
      }
    }
    t.diagnostic(`comparações=${stats.comparisons} vazio=${stats.vazio} parcial=${stats.parcial} (entidades de CRM: ${stats.parcialRecord}) tenantInteiro=${stats.tenantInteiro} não-triviais=${stats.nonTrivial} comCompartilhamento=${stats.sharedExprs} bloqueadas(MFA/inativo)=${stats.blocked} linhasVarridas=${stats.rowsCompared}`);
    assert.ok(stats.parcialRecord > 100, 'poucos casos parciais (entidades de CRM): ' + stats.parcialRecord);
    assert.ok(stats.sharedExprs > 30, "poucos casos com compartilhamento: " + stats.sharedExprs);
    assert.deepEqual(divergences.slice(0, 5), [], `DIVERGÊNCIAS motor x Postgres (${divergences.length}), semente ${SEED}:\n` + JSON.stringify(divergences.slice(0, 3), null, 2));
  });

  test('(c2) idem como app_user COM RLS ligado (tenant + camada 2 + variáveis setadas): o resultado continua IGUAL ao do motor', async () => {
    const divergences = [];
    for (const s of subjects) {
      const readScopes = readScopesFor(s.ctx);
      await withTenant(h.app, { tenantId: s.tenant.id, userId: s.user.id, teamIds: s.teamIds, teamTreeIds: s.treeIds, readScopes }, async (c) => {
        for (const entity of TABLE_ENTITIES) {
          for (const action of ENTITIES[entity].actions) {
            const p = plan(s, entity, action);
            const { rows } = await c.query(`SELECT id FROM ${TABLE_OF(entity)} t WHERE ${p.sql}`, p.params);
            const d = diffSets(p.expected, idSet(rows.map((r) => r.id)));
            if (d.missing.length || d.extra.length) divergences.push(report(s, entity, action, p, d, 'app_user+RLS'));
          }
        }
      });
    }
    assert.deepEqual(divergences.slice(0, 5), [], `DIVERGÊNCIAS com RLS (${divergences.length}), semente ${SEED}:\n` + JSON.stringify(divergences.slice(0, 3), null, 2));
  });

  test('(d) camada 2: conjunto visível pelo RLS ⊇ conjunto do motor, para TODO usuário, entidade e ação (nunca mais restritivo que o motor)', async (t) => {
    const violations = [];
    let strictlyNarrower = 0;
    let checks = 0;
    for (const s of subjects) {
      const readScopes = readScopesFor(s.ctx);
      await withTenant(h.app, { tenantId: s.tenant.id, userId: s.user.id, teamIds: s.teamIds, teamTreeIds: s.treeIds, readScopes }, async (c) => {
        for (const entity of TABLE_ENTITIES) {
          const table = TABLE_OF(entity);
          const rlsSet = idSet((await c.query(`SELECT id FROM ${table}`)).rows.map((r) => r.id)); // SEM WHERE: só o RLS
          const tenantRows = rowsByTable()[table].filter((r) => r.tenantId === s.tenant.id);
          const tenantIds = new Set(tenantRows.map((r) => r.id));
          assert.ok([...rlsSet].every((id) => tenantIds.has(id)), 'RLS devolveu linha de outro tenant em ' + table);
          if (rlsSet.size < tenantRows.length) strictlyNarrower++;
          for (const action of ENTITIES[entity].actions) {
            const p = plan(s, entity, action);
            checks++;
            const missing = [...p.expected].filter((id) => !rlsSet.has(id));
            if (missing.length) violations.push({ ...report(s, entity, action, p, { missing, extra: [] }, 'RLS-superset'), readScopes: readScopes[table] });
          }
        }
      });
    }
    stats.rlsNarrower = strictlyNarrower;
    t.diagnostic(`checagens=${checks}; (usuário,tabela) em que o RLS é estritamente mais estreito que "o tenant inteiro"=${strictlyNarrower}`);
    assert.ok(strictlyNarrower > 20, 'a camada 2 não está restringindo nada — teste vácuo');
    assert.deepEqual(violations.slice(0, 5), [], `RLS MAIS RESTRITIVO que o motor (${violations.length}), semente ${SEED}:\n` + JSON.stringify(violations.slice(0, 3), null, 2));
  });

  test('(d-controle) o teste TEM dentes: um teto de RLS errado de propósito (um degrau abaixo) é detectado como não-superset', async () => {
    const narrower = { tenant: 'team_tree', team_tree: 'team', team: 'own', own: 'none', none: 'none' };
    let detected = 0;
    for (const s of subjects) {
      const real = readScopesFor(s.ctx);
      const wrong = Object.fromEntries(Object.entries(real).map(([k, v]) => [k, narrower[v]]));
      await withTenant(h.app, { tenantId: s.tenant.id, userId: s.user.id, teamIds: s.teamIds, teamTreeIds: s.treeIds, readScopes: wrong }, async (c) => {
        for (const entity of ['deal', 'contact', 'conversation']) {
          const rlsSet = idSet((await c.query(`SELECT id FROM ${TABLE_OF(entity)}`)).rows.map((r) => r.id));
          for (const action of ENTITIES[entity].actions) {
            const p = plan(s, entity, action);
            if ([...p.expected].some((id) => !rlsSet.has(id))) {
              detected++;
              break;
            }
          }
        }
      });
    }
    assert.ok(detected > 10, 'o teste de superset não detectaria um teto errado (detectados: ' + detected + ')');
  });

  test('(d2) readScopesFor: escopo calculado é exatamente o maior escopo de grants do usuário (e none para inativo)', () => {
    for (const s of subjects) {
      const rs = readScopesFor(s.ctx);
      for (const k of Object.keys(rs)) assert.ok(SCOPES.includes(rs[k]));
      if (s.user.status !== 'active') assert.deepEqual(Object.values(rs), ['none', 'none', 'none']);
    }
    const admin = subjects.find((s) => s.ctx.subject.roleIds.includes('role_admin') && s.user.status === 'active');
    assert.deepEqual(readScopesFor(admin.ctx), { deals: 'tenant', contacts: 'tenant', conversations: 'tenant' });
  });

  test('closure no banco bate com expandTeams do motor após movimentos de subárvore (por usuário; verificado em loadSubjects)', () => {
    assert.ok(subjects.every((s) => s.treeIds.length >= s.teamIds.length));
  });
});

// ---------------------------------------------------------------------------
// Casos de borda construídos À MÃO: valores que validateRole aceita mas em que
// JS e SQL podem divergir. Cada divergência é um achado a reportar sobre o
// motor/toSql (todo: = bug conhecido, não quebra a suíte; vira falha ao ser corrigido).
// ---------------------------------------------------------------------------
describe('casos de borda motor x Postgres (achados)', { skip: env.skip || false }, () => {
  let h;
  let world;
  let A;
  before(async () => {
    world = buildWorld(777);
    h = await startPostgres(env.pg, 'edge');
    await loadWorld(h, world);
    A = world.tenants[1];
  });
  after(async () => {
    if (h) await h.dispose();
  });

  /** Executa o filtro do perfil `grant` para (entidade, read) e compara com JS. Devolve divergências. */
  async function run(entityName, condition, { sqlEntity } = {}) {
    const ent = ENTITIES[entityName];
    const role = { id: 'role_edge', tenantId: null, system: false, name: 'edge', grants: [{ entity: entityName, actions: ['read'], scope: 'tenant', conditions: [condition] }], denies: [], partitions: {}, fields: [] };
    const base = P.createContext({ subject: { id: A.users[0].id, tenantId: A.id, status: 'active', roleIds: [], teamIds: [] }, org: { teams: [] } });
    base.roles.set('role_edge', role);
    base.subject.roleIds = ['role_edge'];
    const f = P.filterFor(base, entityName, 'read');
    const { sql, params } = P.toSql(f.expr, ent, { alias: 't' });
    const expected = new Set(world.rows[ent.table].filter(P.toPredicate(f.expr)).map((r) => r.id));
    let pg;
    try {
      pg = new Set((await h.admin.query(`SELECT id FROM ${ent.table} t WHERE ${sql}`, params)).rows.map((r) => r.id));
    } catch (e) {
      return { erroSql: e.message, sql, validate: P.validateRole(role).length };
    }
    const d = diffSets(expected, pg);
    return d.missing.length || d.extra.length ? { faltandoNoPg: d.missing.length, sobrandoNoPg: d.extra.length, sql, params, validate: P.validateRole(role).length } : null;
  }

  test('ne com value null (IS DISTINCT FROM NULL)', async () => {
    assert.equal(await run('contact', { field: 'status', op: 'ne', value: null }), null);
  });
  test('in / nin com null dentro do array', async () => {
    assert.equal(await run('contact', { field: 'status', op: 'in', value: ['lead', null] }), null);
    assert.equal(await run('contact', { field: 'status', op: 'nin', value: ['lead', null] }), null);
  });
  test('lt/gt/lte/gte contra valor null (JS: null vira 0; SQL: NULL)', async () => {
    for (const op of ['lt', 'lte', 'gt', 'gte']) assert.equal(await run('deal', { field: 'value', op, value: null }), null, op);
  });
  test('isNull/notNull e ne/nin em atributos nulos (partição, valor, responsável)', async () => {
    for (const [e, f] of [['deal', 'pipelineId'], ['deal', 'value'], ['conversation', 'assigneeId'], ['contact', 'source']]) {
      for (const op of ['isNull', 'notNull']) assert.equal(await run(e, { field: f, op }), null, e + f + op);
    }
    assert.equal(await run('deal', { field: 'value', op: 'nin', value: [0.5, 1] }), null);
    assert.equal(await run('deal', { field: 'value', op: 'ne', value: 0.5 }), null);
  });

  test('uuid com literal não-uuid (validateRole aceita): JS=false, SQL=erro de cast em runtime', { todo: 'achado: falta validar o tipo do literal em validateRole' }, async () => {
    assert.equal(await run('deal', { field: 'ownerId', op: 'eq', value: 'nao-e-uuid' }), null);
  });
  test('numeric com literal string não numérico (validateRole aceita)', { todo: 'achado: falta validar o tipo do literal em validateRole' }, async () => {
    assert.equal(await run('deal', { field: 'value', op: 'gt', value: 'abc' }), null);
  });
  test('text com literal numérico: eq 5 vs status "5" (SQL coage 5::text, JS usa ===)', { todo: 'achado: coerção de tipo no SQL que o JS não faz' }, async () => {
    const { rows } = await h.admin.query(`INSERT INTO contacts (tenant_id, name, status) VALUES ($1, 'status-cinco', '5') RETURNING id`, [A.id]);
    world.rows.contacts.push({ id: rows[0].id, tenantId: A.id, status: '5', sharedWith: [] });
    try {
      assert.equal(await run('contact', { field: 'status', op: 'eq', value: 5 }), null);
    } finally {
      world.rows.contacts.pop();
      await h.admin.query('DELETE FROM contacts WHERE id = $1', [rows[0].id]);
    }
  });
  test('lt/gt em text dependem da COLLATION da coluna/banco; o JS compara por code unit (Supabase usa en_US.UTF-8)', { todo: 'achado: toSql não fixa COLLATE "C" em comparações de text' }, async () => {
    await h.admin.query('CREATE TABLE edge_text (id uuid PRIMARY KEY, tenant_id uuid, status text COLLATE "en-US-x-icu")');
    const vals = ['Zeta', 'alpha', 'Beta', 'beta', '_x', '10', '9', 'b'];
    const rows = vals.map((v, i) => ({ id: `00000000-0000-4000-c000-00000000000${i}`, tenantId: A.id, status: v }));
    for (const r of rows) await h.admin.query('INSERT INTO edge_text VALUES ($1,$2,$3)', [r.id, r.tenantId, r.status]);
    const def = { table: 'edge_text', attrs: { id: 'uuid', tenantId: 'uuid', status: 'text' } };
    const expr = P.cmp('status', 'lt', 'b');
    const { sql, params } = P.toSql(expr, def, { alias: 't' });
    const pg = new Set((await h.admin.query(`SELECT id FROM edge_text t WHERE ${sql}`, params)).rows.map((r) => r.id));
    const js = new Set(rows.filter(P.toPredicate(expr)).map((r) => r.id));
    assert.deepEqual(diffSets(js, pg), { missing: [], extra: [] });
  });
  test('integração: numeric do pg chega como STRING ("100.50"); decide()/evaluate com eq numérico erra se a linha não for normalizada', { todo: 'risco de integração: normalizar linhas do pg (setTypeParser 1700 ou ::float8) antes de decide()' }, async () => {
    const { rows } = await h.admin.query(`SELECT value FROM deals WHERE value IS NOT NULL LIMIT 1`);
    const v = rows[0].value; // string
    assert.equal(typeof v, 'number', 'pg devolveu numeric como ' + typeof v);
  });
  test('controle de sensibilidade: trocar IS DISTINCT FROM por <> / remover COALESCE no SQL É detectado como divergência', async () => {
    const ent = ENTITIES.contact;
    const expr = P.cmp('status', 'ne', 'lead');
    const { sql, params } = P.toSql(expr, ent, { alias: 't' });
    const mutated = sql.replace('IS DISTINCT FROM', '<>');
    assert.notEqual(mutated, sql);
    const run1 = async (q) => new Set((await h.admin.query(`SELECT id FROM contacts t WHERE ${q}`, params)).rows.map((r) => r.id));
    const js = new Set(world.rows.contacts.filter(P.toPredicate(expr)).map((r) => r.id));
    assert.deepEqual(diffSets(js, await run1(sql)), { missing: [], extra: [] });
    const bad = diffSets(js, await run1(mutated));
    assert.ok(bad.missing.length > 0, 'a mutação (lógica de 3 valores) não foi detectada');
  });
});
