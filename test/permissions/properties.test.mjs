// PROPRIEDADES do motor, com fuzz de semente fixa (reprodutível):
//  (a) equivalência objeto <-> lista (decide x filterFor) e contra um ORÁCULO independente
//  (b) isolamento de tenant
//  (c) monotonicidade
//  (d) deny vence
// Em falha: imprime semente, comando para reproduzir e o caso mínimo (JSON).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ENTITIES, SYSTEM_ROLES, decide, filterFor, toPredicate, evaluate, fieldAccess, maskRow, can, canWriteField, explain } from '../../shared/permissions/index.js';
import { Rng, knobs, fuzz, genCase, genRule, genRow, mkCtx, oracle, ENTITY_NAMES } from './support.mjs';

const RANK = { deny: 0, approval: 1, allow: 2 };
const clone = (x) => JSON.parse(JSON.stringify(x));
const pred = (ctx, entity, action) => toPredicate(filterFor(ctx, entity, action).expr);

describe('(a) equivalência objeto <-> lista', () => {
  test('decide() === toPredicate(filterFor()) para read, sem aprovação (invariante central)', () => {
    const stats = { allow: 0, deny: 0 };
    fuzz('equivalencia-read', {
      seed: 101,
      n: 6000,
      gen: (rng) => genCase(rng, { action: 'read', entity: rng.pick(ENTITY_NAMES.filter((e) => ENTITIES[e].actions.includes('read'))), noApproval: true, sysP: 0.35 }),
      check: (c) => {
        const ctx = mkCtx(c);
        const d = decide(ctx, c.entity, 'read', c.row);
        const p = pred(ctx, c.entity, 'read')(c.row);
        assert.equal(d.effect === 'allow', p, `decide=${d.effect}/${d.reason} lista=${p}`);
        assert.notEqual(d.effect, 'approval', 'sem grants com aprovação não pode haver effect=approval');
        stats[p ? 'allow' : 'deny']++;
      },
    });
    // o gerador não pode ser degenerado: precisa exercitar os dois lados
    assert.ok(stats.allow > 300, `poucos allow (${stats.allow})`);
    assert.ok(stats.deny > 300, `poucos deny (${stats.deny})`);
  });

  test('qualquer ação, ctx OMITIDO: lista permite sse decide != deny (aprovação aparece na lista)', () => {
    const stats = { allow: 0, approval: 0, deny: 0 };
    fuzz('equivalencia-qualquer-acao', {
      seed: 202,
      n: 8000,
      gen: (rng) => {
        const c = genCase(rng, { approvalP: 0.3, sysP: 0.3 });
        c.context = undefined; // compilação de lista nunca tem contexto de operação
        return c;
      },
      check: (c) => {
        const ctx = mkCtx(c);
        const d = decide(ctx, c.entity, c.action, c.row, undefined);
        const p = pred(ctx, c.entity, c.action)(c.row);
        assert.equal(p, d.effect !== 'deny', `decide=${d.effect}/${d.reason} lista=${p}`);
        // allow direto nunca pode ser MAIS que a lista
        if (d.effect === 'allow') assert.equal(p, true);
        stats[d.effect]++;
      },
    });
    assert.ok(stats.allow > 200 && stats.approval > 20 && stats.deny > 200, JSON.stringify(stats));
  });

  test('ctx omitido === ctx {} (chave ausente é desconhecida): mesma decisão em todas as ações', () => {
    fuzz('ctx-omitido-vs-vazio', {
      seed: 303,
      n: 4000,
      gen: (rng) => genCase(rng, { approvalP: 0.3 }),
      check: (c) => {
        const ctx = mkCtx(c);
        const a = decide(ctx, c.entity, c.action, c.row, undefined);
        const b = decide(ctx, c.entity, c.action, c.row, {});
        assert.equal(a.effect, b.effect);
        assert.equal(a.reason, b.reason);
      },
    });
  });

  test('decide() com contexto === ORÁCULO independente (efeito allow/approval/deny)', () => {
    const stats = { allow: 0, approval: 0, deny: 0 };
    fuzz('oraculo', {
      seed: 404,
      n: 12000,
      gen: (rng) => genCase(rng, { approvalP: 0.6, sysP: 0.3 }),
      check: (c) => {
        const d = decide(mkCtx(c), c.entity, c.action, c.row, c.context);
        const o = oracle(c);
        assert.equal(d.effect, o, `motor=${d.effect}/${d.reason} oráculo=${o}`);
        stats[o]++;
      },
    });
    assert.ok(stats.allow > 500 && stats.approval > 50 && stats.deny > 500, JSON.stringify(stats));
  });

  test('valores NULL em condições e registros (JS === oráculo === semântica IS DISTINCT FROM do SQL)', () => {
    const saved = { ...knobs };
    Object.assign(knobs, { condNull: 0.4, rowNull: 0.4, rowMissing: 0.4 });
    try {
      fuzz('nulos', {
        seed: 451,
        n: 12000,
        gen: (rng) => genCase(rng, { approvalP: 0.3, sysP: 0.1, denyP: 0.8 }),
        check: (c) => {
          const ctx = mkCtx(c);
          const d = decide(ctx, c.entity, c.action, c.row, c.context);
          assert.equal(d.effect, oracle(c), `motor=${d.effect}/${d.reason}`);
          const c0 = { ...c, context: undefined };
          assert.equal(pred(ctx, c.entity, c.action)(c.row), decide(ctx, c.entity, c.action, c.row).effect !== 'deny');
          void c0;
        },
      });
    } finally {
      Object.assign(knobs, saved);
    }
  });

  test('expressão do filtro é serializável em JSON e continua equivalente depois do round-trip', () => {
    fuzz('expr-json', {
      seed: 505,
      n: 3000,
      gen: (rng) => genCase(rng, { sysP: 0.3 }),
      check: (c) => {
        const ctx = mkCtx(c);
        const { expr } = filterFor(ctx, c.entity, c.action);
        const back = JSON.parse(JSON.stringify(expr));
        assert.equal(evaluate(back, c.row), evaluate(expr, c.row));
      },
    });
  });

  test('determinismo: duas chamadas iguais dão a mesma resposta e não mutam a entrada', () => {
    fuzz('determinismo', {
      seed: 606,
      n: 1500,
      gen: (rng) => genCase(rng, { approvalP: 0.3 }),
      check: (c) => {
        const before = JSON.stringify(c);
        const ctx = mkCtx(c);
        const d1 = decide(ctx, c.entity, c.action, c.row, c.context);
        const e1 = explain(ctx, c.entity, c.action, c.row, c.context);
        const d2 = decide(ctx, c.entity, c.action, c.row, c.context);
        assert.deepEqual(d1, d2);
        assert.equal(e1.effect, d1.effect);
        assert.equal(JSON.stringify(c), before, 'o motor mutou a entrada');
      },
    });
  });
});

describe('(b) isolamento de tenant: nada alcança registro de outro tenant', () => {
  // o atacante recebe TODO poder possível: perfil curinga, override curinga, registro compartilhado com ele
  const FOREIGN = ['B', null, undefined, '', 'a', 'A ', ' A', 'AA', 0, false, ['A'], { toString: () => 'A' }, 'A\u0000', 'A\n'];

  test('nenhuma combinação aleatória (grants/denies/overrides/shares/partições) dá allow em tenant alheio', () => {
    const decided = { n: 0 };
    fuzz('isolamento-tenant', {
      seed: 707,
      n: 6000,
      shrinkable: false, // tenantId do registro tem valores não-JSON (objeto com toString)
      gen: (rng) => {
        const c = genCase(rng, { subjectTenant: 'A', approvalP: 0.2, sysP: 0.5 });
        c.subject.status = 'active';
        c.policy = { requireMfaForSensitive: false };
        c.row.tenantId = rng.pick(FOREIGN);
        c.subject.overrides = c.subject.overrides || { grants: [], denies: [], fields: [] };
        if (rng.bool(0.5)) c.subject.overrides.grants.push({ entity: '*', actions: ['*'], scope: 'tenant' });
        c.subject.overrides.denies = [];
        c.roles.push({ id: 'god', name: 'god', tenantId: 'A', system: false, grants: [{ entity: '*', actions: ['*'], scope: 'tenant' }], denies: [], partitions: {}, fields: [] });
        if (rng.bool(0.7)) c.subject.roleIds.push('god', 'role_admin');
        c.row.sharedWith = [
          { type: 'user', id: c.subject.id, level: 'edit' },
          ...c.subject.teamIds.map((id) => ({ type: 'team', id, level: 'edit' })),
        ];
        c.row.ownerId = c.subject.id;
        c.row.assigneeId = c.subject.id;
        return c;
      },
      check: (c) => {
        const ctx = mkCtx(c);
        for (const action of ENTITIES[c.entity].actions) {
          const d = decide(ctx, c.entity, action, c.row, c.context);
          assert.equal(d.effect, 'deny', `${c.entity}.${action}: ${d.effect}/${d.reason}`);
          assert.equal(pred(ctx, c.entity, action)(c.row), false, `lista ${c.entity}.${action} deixou passar`);
          assert.equal(can(ctx, c.entity, action, c.row, c.context), false);
          decided.n++;
        }
        assert.equal(canWriteField(ctx, c.entity, ENTITIES[c.entity].fields[0] ?? 'x', c.row, c.context), false);
      },
    });
    assert.ok(decided.n > 10000);
  });

  test('o mesmo ator com tenant CERTO tem acesso (a configuração acima de fato é "todo-poderosa")', () => {
    fuzz('isolamento-sanidade', {
      seed: 708,
      n: 500,
      gen: (rng) => {
        const c = genCase(rng, { subjectTenant: 'A', rowTenant: 'A' });
        c.subject.status = 'active';
        c.policy = { requireMfaForSensitive: false };
        c.roles.push({ id: 'god', name: 'god', tenantId: 'A', system: false, grants: [{ entity: '*', actions: ['*'], scope: 'tenant' }], denies: [], partitions: {}, fields: [] });
        c.subject.roleIds = ['god'];
        c.subject.overrides = undefined;
        c.roles = c.roles.filter((r) => r.id === 'god');
        return c;
      },
      check: (c) => {
        assert.equal(decide(mkCtx(c), c.entity, c.action, c.row, c.context).effect, 'allow');
      },
    });
  });

  test('perfil de outro tenant é IGNORADO mesmo referenciado pelo usuário (inclusive no oráculo)', () => {
    fuzz('perfil-estrangeiro', {
      seed: 709,
      n: 1500,
      gen: (rng) => {
        const c = genCase(rng, { rowTenant: 'A', subjectTenant: 'A' });
        c.subject.status = 'active';
        c.subject.overrides = undefined;
        c.roles = [{ id: 'foreign', name: 'f', tenantId: 'B', system: false, grants: [{ entity: '*', actions: ['*'], scope: 'tenant' }], denies: [], partitions: {}, fields: [] }];
        c.subject.roleIds = ['foreign'];
        c.row.sharedWith = undefined;
        return c;
      },
      check: (c) => assert.equal(decide(mkCtx(c), c.entity, c.action, c.row, c.context).effect, 'deny'),
    });
  });
});

/** Deriva um caso com mais um grant (em perfil do tenant A existente, ou em override). */
function withExtraGrant(c, rule) {
  const out = clone(c);
  const own = out.roles.find((r) => r.tenantId === 'A' && out.subject.roleIds.includes(r.id));
  if (own) own.grants.push(rule);
  else {
    out.subject.overrides = out.subject.overrides || { grants: [], denies: [], fields: [] };
    out.subject.overrides.grants.push(rule);
  }
  return out;
}
function withExtraDeny(c, rule, toRole) {
  const out = clone(c);
  const own = out.roles.find((r) => r.tenantId === 'A' && out.subject.roleIds.includes(r.id));
  if (toRole && own) own.denies.push(rule);
  else {
    out.subject.overrides = out.subject.overrides || { grants: [], denies: [], fields: [] };
    out.subject.overrides.denies = [...(out.subject.overrides.denies || []), rule];
  }
  return out;
}

describe('(c) monotonicidade', () => {
  test('acrescentar um GRANT nunca remove acesso (deny < approval < allow)', () => {
    let widened = 0;
    fuzz('monotonia-grant', {
      seed: 808,
      n: 8000,
      gen: (rng) => {
        const c = genCase(rng, { approvalP: 0.3, sysP: 0.3 });
        const rule = genRule(rng, 'grants', { entityName: rng.bool(0.8) ? c.entity : undefined, approvalP: 0.3 });
        return { c, rule };
      },
      check: ({ c, rule }) => {
        const before = decide(mkCtx(c), c.entity, c.action, c.row, c.context).effect;
        const c2 = withExtraGrant(c, rule);
        const after = decide(mkCtx(c2), c.entity, c.action, c.row, c.context).effect;
        assert.ok(RANK[after] >= RANK[before], `antes=${before} depois=${after}`);
        if (RANK[after] > RANK[before]) widened++;
        // a lista também: quem passava continua passando
        const p1 = pred(mkCtx(c), c.entity, c.action)(c.row);
        const p2 = pred(mkCtx(c2), c.entity, c.action)(c.row);
        assert.ok(!p1 || p2, 'lista: linha que passava deixou de passar após ganhar um grant');
      },
    });
    assert.ok(widened > 100, `o gerador quase nunca amplia (${widened})`);
  });

  test('acrescentar um DENY nunca adiciona acesso', () => {
    let narrowed = 0;
    fuzz('monotonia-deny', {
      seed: 809,
      n: 8000,
      gen: (rng) => {
        const c = genCase(rng, { approvalP: 0.3, sysP: 0.35 });
        const rule = genRule(rng, 'denies', { entityName: rng.bool(0.8) ? c.entity : undefined, condP: 0.6 });
        return { c, rule, toRole: rng.bool() };
      },
      check: ({ c, rule, toRole }) => {
        const before = decide(mkCtx(c), c.entity, c.action, c.row, c.context).effect;
        const c2 = withExtraDeny(c, rule, toRole);
        const after = decide(mkCtx(c2), c.entity, c.action, c.row, c.context).effect;
        assert.ok(RANK[after] <= RANK[before], `antes=${before} depois=${after}`);
        if (RANK[after] < RANK[before]) narrowed++;
        const p1 = pred(mkCtx(c), c.entity, c.action)(c.row);
        const p2 = pred(mkCtx(c2), c.entity, c.action)(c.row);
        assert.ok(!p2 || p1, 'lista: deny novo fez passar uma linha que não passava');
      },
    });
    assert.ok(narrowed > 100, `o gerador quase nunca restringe (${narrowed})`);
  });

  test('acrescentar restrição de CAMPO nunca libera campo (fieldAccess/maskRow só pioram)', () => {
    const ORDER = { write: 0, readonly: 1, hidden: 2 };
    fuzz('monotonia-campos', {
      seed: 810,
      n: 3000,
      gen: (rng) => {
        const c = genCase(rng, { sysP: 0.5 });
        const e = rng.pick(['contact', 'deal', 'conversation', 'proposal', 'company']);
        return { c, e, rule: { entity: rng.bool(0.2) ? '*' : e, field: rng.pick(ENTITIES[e].fields), access: rng.pick(['readonly', 'hidden']) }, toRole: rng.bool() };
      },
      check: ({ c, e, rule, toRole }) => {
        const before = fieldAccess(mkCtx(c), e);
        const c2 = clone(c);
        const role = c2.roles.find((r) => r.tenantId === 'A' && c2.subject.roleIds.includes(r.id));
        if (toRole && role) role.fields.push(rule);
        else {
          c2.subject.overrides = c2.subject.overrides || { grants: [], denies: [], fields: [] };
          c2.subject.overrides.fields = [...(c2.subject.overrides.fields || []), rule];
        }
        const after = fieldAccess(mkCtx(c2), e);
        for (const f of ENTITIES[e].fields) assert.ok(ORDER[after[f] || 'write'] >= ORDER[before[f] || 'write'], `campo ${f} ficou mais livre`);
        const row = Object.fromEntries(ENTITIES[e].fields.map((f) => [f, 'x']));
        const m1 = maskRow(mkCtx(c), e, row);
        const m2 = maskRow(mkCtx(c2), e, row);
        for (const f of Object.keys(m2)) assert.ok(f in m1, `maskRow revelou ${f} após acrescentar restrição`);
      },
    });
  });
});

describe('(d) deny vence', () => {
  test('um deny que se aplica ao registro resulta SEMPRE em deny (e some da lista)', () => {
    fuzz('deny-vence', {
      seed: 909,
      n: 8000,
      gen: (rng) => {
        const c = genCase(rng, { approvalP: 0.25, sysP: 0.5, rowTenant: 'A', subjectTenant: 'A' });
        c.subject.status = 'active';
        c.policy = { requireMfaForSensitive: false };
        // deny que SEGURAMENTE se aplica: ou incondicional, ou condicionado a valores reais do registro
        const kind = rng.pick(['uncond', 'row', 'wild']);
        const deny = { entity: kind === 'wild' ? '*' : c.entity, actions: kind === 'wild' ? ['*'] : [c.action] };
        if (kind === 'row') {
          const attrs = Object.entries(ENTITIES[c.entity].attrs).filter(([k]) => c.row[k] !== undefined && c.row[k] !== null && k !== 'sharedWith');
          deny.conditions = rng.some(attrs, 1, 2).map(([k]) => ({ field: k, op: 'eq', value: c.row[k] }));
          deny.conditions.push({ field: 'ctx.__sempre_ausente', op: 'eq', value: 1 }); // ctx desconhecido => no deny vira verdadeiro
        }
        // com o usuário muito permissivo (para o deny ser a ÚNICA coisa que impede)
        c.subject.overrides = { grants: [{ entity: '*', actions: ['*'], scope: 'tenant' }], denies: [], fields: [] };
        c.subject.roleIds = c.subject.roleIds.filter((id) => id !== 'role_viewer' && id !== 'role_sdr' && id !== 'role_manager');
        for (const r of c.roles) r.denies = [];
        c.row.sharedWith = [{ type: 'user', id: c.subject.id, level: 'edit' }];
        return { c, deny, toRole: rng.bool() };
      },
      check: ({ c, deny, toRole }) => {
        const permissive = decide(mkCtx(c), c.entity, c.action, c.row, c.context);
        assert.equal(permissive.effect, 'allow', 'pré-condição: sem o deny o usuário deveria poder');
        const c2 = clone(c);
        const role = c2.roles.find((r) => r.tenantId === 'A' && c2.subject.roleIds.includes(r.id));
        if (toRole && role) role.denies.push(deny);
        else c2.subject.overrides.denies.push(deny);
        const ctx = mkCtx(c2);
        const d = decide(ctx, c.entity, c.action, c.row, c.context);
        assert.equal(d.effect, 'deny');
        assert.equal(d.reason, 'denied');
        assert.equal(can(ctx, c.entity, c.action, c.row, c.context), false);
        assert.equal(pred(ctx, c.entity, c.action)(c.row), false);
      },
    });
  });

  test('um deny em QUALQUER perfil vence grants de TODOS os outros (inclusive Admin)', () => {
    fuzz('deny-vence-admin', {
      seed: 910,
      n: 3000,
      gen: (rng) => {
        const c = genCase(rng, { rowTenant: 'A', subjectTenant: 'A' });
        c.subject.status = 'active';
        c.policy = { requireMfaForSensitive: false };
        c.subject.roleIds = ['role_admin', 'only_deny'];
        c.roles = [{ id: 'only_deny', name: 'd', tenantId: 'A', system: false, grants: [], denies: [{ entity: c.entity, actions: [c.action] }], partitions: {}, fields: [] }];
        c.subject.overrides = undefined;
        return c;
      },
      check: (c) => {
        const d = decide(mkCtx(c), c.entity, c.action, c.row, c.context);
        assert.equal(d.effect, 'deny');
        assert.equal(d.reason, 'denied');
      },
    });
  });
});

test('sanidade do oráculo: concorda com os perfis de sistema nos 6 papéis (smoke)', () => {
  const rng = new Rng(1);
  for (const role of SYSTEM_ROLES) {
    for (let i = 0; i < 200; i++) {
      const entity = rng.pick(ENTITY_NAMES);
      const action = rng.pick(ENTITIES[entity].actions);
      const c = {
        subject: { id: 'u1', tenantId: 'A', status: 'active', roleIds: [role.id], teamIds: ['t1'], mfa: true },
        roles: [],
        org: { teams: [{ id: 't1' }, { id: 't2', parentId: 't1' }] },
        policy: { requireMfaForSensitive: false },
        entity,
        action,
        row: genRow(rng, entity, { tenantId: 'A' }),
        context: undefined,
      };
      assert.equal(decide(mkCtx(c), entity, action, c.row).effect, oracle(c), `${role.id} ${entity}.${action}`);
    }
  }
});
