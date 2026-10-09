// validate.js: validateRole (g), wouldRemoveLastAdmin (h), diffRoles (i), auditEvent, cloneRole.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateRole,
  wouldRemoveLastAdmin,
  countActiveAdmins,
  diffRoles,
  auditEvent,
  isImmutableRole,
  cloneRole,
  SYSTEM_ROLES,
  systemRoleMap,
  ENTITIES,
  ACTIONS,
  SCOPES,
  OPERATORS,
  decide,
  filterFor,
  toSql,
  toPredicate,
  fieldAccess,
} from '../../shared/permissions/index.js';
import { Rng, fuzz, genRow, genContext, mkCtx, ENTITY_NAMES, TEAMS } from './support.mjs';

const clone = (x) => JSON.parse(JSON.stringify(x));
const base = () => ({
  id: 'custom',
  name: 'Perfil de teste',
  tenantId: 'A',
  system: false,
  grants: [{ entity: 'deal', actions: ['read', 'update'], scope: 'team', conditions: [{ field: 'status', op: 'eq', value: 'open' }] }],
  denies: [{ entity: 'deal', actions: ['delete'] }],
  partitions: { pipelineId: ['p1'] },
  fields: [{ entity: 'deal', field: 'value', access: 'readonly' }],
});
const paths = (errors) => errors.map((e) => e.path);

describe('validateRole: aceita o que é válido', () => {
  test('todos os 6 perfis de sistema e seus clones passam sem erro', () => {
    for (const r of SYSTEM_ROLES) {
      assert.deepEqual(validateRole(r), [], r.id);
      assert.deepEqual(validateRole(cloneRole(r, { id: 'novo', name: 'Novo', tenantId: 'A' })), [], 'clone de ' + r.id);
    }
  });
  test('perfil base de teste é válido', () => assert.deepEqual(validateRole(base()), []));
  test('perfil vazio (só id e nome) é válido; nome de 60 caracteres é o limite', () => {
    assert.deepEqual(validateRole({ id: 'x', name: 'x' }), []);
    assert.deepEqual(validateRole({ id: 'x', name: 'n'.repeat(60) }), []);
    assert.deepEqual(validateRole({ id: 'x', name: 'x', grants: null, denies: null, partitions: null, fields: null }), []);
  });
  test("curingas válidos: entidade '*' com tenant, ação '*' sozinha, partição 'all', ctx coerente com a ação", () => {
    const r = {
      id: 'x',
      name: 'x',
      grants: [
        { entity: '*', actions: ['*'], scope: 'tenant' },
        { entity: '*', actions: ['read'], scope: 'tenant' },
        { entity: '*', actions: ['*'], scope: 'none' },
        { entity: 'deal', actions: ['approve'], scope: 'team_tree', conditions: [{ field: 'ctx.discountPct', op: 'lte', value: 15 }] },
        { entity: 'deal', actions: ['move'], scope: 'own', conditions: [{ field: 'ctx.toStageKind', op: 'nin', value: ['won'] }] },
        { entity: 'conversation', actions: ['read'], scope: 'tenant', conditions: [{ field: 'assigneeId', op: 'isNull' }] },
        { entity: 'deal', actions: ['read'], scope: 'tenant', conditions: [{ field: 'ownerId', op: 'eq', ref: '$user.id' }, { field: 'teamId', op: 'in', ref: '$user.teamIds' }] },
        { entity: 'proposal', actions: ['update'], scope: 'own', approval: { when: [{ field: 'ctx.discountPct', op: 'gt', value: 5 }] } },
      ],
      partitions: { pipelineId: 'all', instanceId: ['i1', 'i2'] },
    };
    assert.deepEqual(validateRole(r), []);
  });
});

describe('validateRole: rejeita (cada caso tem que produzir ao menos um erro, com o caminho certo)', () => {
  const mutate = (fn) => {
    const r = base();
    fn(r);
    return r;
  };
  // [rótulo, perfil, caminho esperado em algum erro]
  const BAD = [
    ['sem id', mutate((r) => delete r.id), 'id'],
    ['id vazio', mutate((r) => (r.id = '')), 'id'],
    ['id numérico', mutate((r) => (r.id = 5)), 'id'],
    ['id objeto', mutate((r) => (r.id = {})), 'id'],
    ['sem nome', mutate((r) => delete r.name), 'name'],
    ['nome em branco', mutate((r) => (r.name = '   ')), 'name'],
    ['nome com 61 caracteres', mutate((r) => (r.name = 'n'.repeat(61))), 'name'],
    ['grants não é lista (string)', mutate((r) => (r.grants = 'x')), 'grants'],
    ['grants não é lista (objeto)', mutate((r) => (r.grants = { a: 1 })), 'grants'],
    ['grants não é lista (número)', mutate((r) => (r.grants = 5)), 'grants'],
    ['grant nulo', mutate((r) => (r.grants = [null])), 'grants[0]'],
    ['grant número', mutate((r) => (r.grants = [5])), 'grants[0]'],
    ['grant string', mutate((r) => (r.grants = ['read'])), 'grants[0]'],
    ['grant lista', mutate((r) => (r.grants = [[]])), 'grants[0]'],
    ['entidade desconhecida', mutate((r) => (r.grants[0].entity = 'naoExiste')), 'grants[0].entity'],
    ['entidade __proto__', mutate((r) => (r.grants[0].entity = '__proto__')), 'grants[0].entity'],
    ['entidade constructor', mutate((r) => (r.grants[0].entity = 'constructor')), 'grants[0].entity'],
    ['entidade toString', mutate((r) => (r.grants[0].entity = 'toString')), 'grants[0].entity'],
    ['entidade ausente', mutate((r) => delete r.grants[0].entity), 'grants[0].entity'],
    ['entidade número', mutate((r) => (r.grants[0].entity = 5)), 'grants[0].entity'],
    ['entidade com caixa errada', mutate((r) => (r.grants[0].entity = 'Deal')), 'grants[0].entity'],
    ['actions ausente', mutate((r) => delete r.grants[0].actions), 'grants[0].actions'],
    ['actions vazia', mutate((r) => (r.grants[0].actions = [])), 'grants[0].actions'],
    ['actions string', mutate((r) => (r.grants[0].actions = 'read')), 'grants[0].actions'],
    ['ação desconhecida', mutate((r) => (r.grants[0].actions = ['naoExiste'])), 'grants[0].actions'],
    ['ação __proto__', mutate((r) => (r.grants[0].actions = ['__proto__'])), 'grants[0].actions'],
    ['ação constructor', mutate((r) => (r.grants[0].actions = ['constructor'])), 'grants[0].actions'],
    ['ação toString', mutate((r) => (r.grants[0].actions = ['toString'])), 'grants[0].actions'],
    ['ação numérica', mutate((r) => (r.grants[0].actions = [5])), 'grants[0].actions'],
    ['ação nula', mutate((r) => (r.grants[0].actions = [null])), 'grants[0].actions'],
    ["'*' misturado com outras ações", mutate((r) => (r.grants[0].actions = ['*', 'read'])), 'grants[0].actions'],
    ['ação que a entidade não tem (contact.approve)', mutate((r) => (r.grants[0] = { entity: 'contact', actions: ['approve'], scope: 'tenant' })), 'grants[0].actions'],
    ['escopo ausente', mutate((r) => delete r.grants[0].scope), 'grants[0].scope'],
    ['escopo inválido', mutate((r) => (r.grants[0].scope = 'global')), 'grants[0].scope'],
    ['escopo com caixa errada', mutate((r) => (r.grants[0].scope = 'Tenant')), 'grants[0].scope'],
    ['escopo de equipe em entidade de configuração', mutate((r) => (r.grants[0] = { entity: 'product', actions: ['read'], scope: 'team' })), 'grants[0].scope'],
    ["escopo 'own' em entidade de configuração", mutate((r) => (r.grants[0] = { entity: 'billing', actions: ['read'], scope: 'own' })), 'grants[0].scope'],
    ["entidade '*' com escopo de equipe", mutate((r) => (r.grants[0] = { entity: '*', actions: ['read'], scope: 'team' })), 'grants[0].scope'],
    ['conditions não é lista', mutate((r) => (r.grants[0].conditions = 'x')), 'grants[0].conditions'],
    ['conditions objeto', mutate((r) => (r.grants[0].conditions = {})), 'grants[0].conditions'],
    ['condição nula', mutate((r) => (r.grants[0].conditions = [null])), 'grants[0].conditions[0]'],
    ['condição sem field', mutate((r) => (r.grants[0].conditions = [{ op: 'eq', value: 1 }])), 'grants[0].conditions[0]'],
    ['condição com field número', mutate((r) => (r.grants[0].conditions = [{ field: 5, op: 'eq', value: 1 }])), 'grants[0].conditions[0]'],
    ['operador inválido', mutate((r) => (r.grants[0].conditions = [{ field: 'status', op: 'like', value: 'x' }])), 'grants[0].conditions[0]'],
    ['operador ausente', mutate((r) => (r.grants[0].conditions = [{ field: 'status', value: 'x' }])), 'grants[0].conditions[0]'],
    ['operador __proto__', mutate((r) => (r.grants[0].conditions = [{ field: 'status', op: '__proto__', value: 'x' }])), 'grants[0].conditions[0]'],
    ['ref inválida', mutate((r) => (r.grants[0].conditions = [{ field: 'ownerId', op: 'eq', ref: '$user.admin' }])), 'grants[0].conditions[0]'],
    ['ref __proto__', mutate((r) => (r.grants[0].conditions = [{ field: 'ownerId', op: 'eq', ref: '__proto__' }])), 'grants[0].conditions[0]'],
    ['ref $user.teamIds em eq', mutate((r) => (r.grants[0].conditions = [{ field: 'teamId', op: 'eq', ref: '$user.teamIds' }])), 'grants[0].conditions[0]'],
    ['ref $user.id em in', mutate((r) => (r.grants[0].conditions = [{ field: 'teamId', op: 'in', ref: '$user.id' }])), 'grants[0].conditions[0]'],
    ['eq sem valor', mutate((r) => (r.grants[0].conditions = [{ field: 'status', op: 'eq' }])), 'grants[0].conditions[0]'],
    ['eq com lista', mutate((r) => (r.grants[0].conditions = [{ field: 'status', op: 'eq', value: ['a'] }])), 'grants[0].conditions[0]'],
    ['eq com objeto', mutate((r) => (r.grants[0].conditions = [{ field: 'status', op: 'eq', value: { a: 1 } }])), 'grants[0].conditions[0]'],
    ['in sem lista', mutate((r) => (r.grants[0].conditions = [{ field: 'status', op: 'in', value: 'a' }])), 'grants[0].conditions[0]'],
    ['nin sem lista', mutate((r) => (r.grants[0].conditions = [{ field: 'status', op: 'nin', value: 5 }])), 'grants[0].conditions[0]'],
    ['atributo desconhecido', mutate((r) => (r.grants[0].conditions = [{ field: 'naoExiste', op: 'isNull' }])), 'grants[0].conditions[0]'],
    ['atributo de protótipo', mutate((r) => (r.grants[0].conditions = [{ field: 'constructor', op: 'notNull' }])), 'grants[0].conditions[0]'],
    ['atributo __proto__', mutate((r) => (r.grants[0].conditions = [{ field: '__proto__', op: 'notNull' }])), 'grants[0].conditions[0]'],
    ['campo restringível usado como atributo', mutate((r) => (r.grants[0].conditions = [{ field: 'phone', op: 'isNull' }])), 'grants[0].conditions[0]'],
    ['ctx que a ação não tem', mutate((r) => (r.grants[0].conditions = [{ field: 'ctx.toStageKind', op: 'eq', value: 'x' }])), 'grants[0].conditions[0]'],
    ['ctx desconhecido', mutate((r) => (r.grants[0] = { entity: 'deal', actions: ['move'], scope: 'own', conditions: [{ field: 'ctx.inventado', op: 'eq', value: 1 }] })), 'grants[0].conditions[0]'],
    ['approval não é objeto', mutate((r) => (r.grants[0].approval = 'sim')), 'grants[0].approval'],
    ['approval.when não é lista', mutate((r) => (r.grants[0].approval = { when: 'x' })), 'grants[0].approval.when'],
    ['approval.when com condição inválida', mutate((r) => (r.grants[0].approval = { when: [{ field: 'ctx.discountPct', op: 'zzz', value: 1 }] })), 'grants[0].approval.when[0]'],
    ['denies não é lista', mutate((r) => (r.denies = 'x')), 'denies'],
    ['deny nulo', mutate((r) => (r.denies = [null])), 'denies[0]'],
    ['deny com entidade desconhecida', mutate((r) => (r.denies = [{ entity: 'x', actions: ['read'] }])), 'denies[0].entity'],
    ['deny sem ações', mutate((r) => (r.denies = [{ entity: 'deal' }])), 'denies[0].actions'],
    ['deny com ação desconhecida', mutate((r) => (r.denies = [{ entity: 'deal', actions: ['zzz'] }])), 'denies[0].actions'],
    ['deny com condição inválida', mutate((r) => (r.denies = [{ entity: 'deal', actions: ['read'], conditions: [{ field: 'status', op: 'eq' }] }])), 'denies[0].conditions[0]'],
    ['partição desconhecida', mutate((r) => (r.partitions = { naoExiste: ['x'] })), 'partitions.naoExiste'],
    ['partição de protótipo', mutate((r) => (r.partitions = { constructor: ['x'] })), 'partitions.constructor'],
    ['partição string', mutate((r) => (r.partitions = { pipelineId: 'p1' })), 'partitions.pipelineId'],
    ['partição lista de números', mutate((r) => (r.partitions = { pipelineId: [1, 2] })), 'partitions.pipelineId'],
    ['partição null', mutate((r) => (r.partitions = { pipelineId: null })), 'partitions.pipelineId'],
    ['partição lista com objeto', mutate((r) => (r.partitions = { pipelineId: [{}] })), 'partitions.pipelineId'],
    ['partitions string', mutate((r) => (r.partitions = 'x')), 'partitions'],
    ['partitions lista', mutate((r) => (r.partitions = ['pipelineId'])), 'partitions'],
    ['partitions número', mutate((r) => (r.partitions = 5)), 'partitions'],
    ['fields não é lista', mutate((r) => (r.fields = 'x')), 'fields'],
    ['fields objeto', mutate((r) => (r.fields = {})), 'fields'],
    ['campo nulo', mutate((r) => (r.fields = [null])), 'fields[0]'],
    ['campo com entidade desconhecida', mutate((r) => (r.fields = [{ entity: 'x', field: 'value', access: 'hidden' }])), 'fields[0].entity'],
    ['campo com entidade __proto__', mutate((r) => (r.fields = [{ entity: '__proto__', field: 'value', access: 'hidden' }])), 'fields[0].entity'],
    ['campo não restringível', mutate((r) => (r.fields = [{ entity: 'deal', field: 'status', access: 'hidden' }])), 'fields[0].field'],
    ['campo de outra entidade', mutate((r) => (r.fields = [{ entity: 'deal', field: 'phone', access: 'hidden' }])), 'fields[0].field'],
    ['access inválido', mutate((r) => (r.fields = [{ entity: 'deal', field: 'value', access: 'write' }])), 'fields[0].access'],
    ['access ausente', mutate((r) => (r.fields = [{ entity: 'deal', field: 'value' }])), 'fields[0].access'],
    ['access com caixa errada', mutate((r) => (r.fields = [{ entity: 'deal', field: 'value', access: 'HIDDEN' }])), 'fields[0].access'],
  ];
  for (const [label, role, path] of BAD) {
    test(`rejeita: ${label}`, () => {
      const errors = validateRole(role);
      assert.ok(errors.length > 0, 'devia rejeitar');
      assert.ok(paths(errors).some((p) => p === path), `esperava erro em "${path}"; obtido: ${JSON.stringify(paths(errors))}`);
      for (const e of errors) {
        assert.equal(typeof e.path, 'string');
        assert.equal(typeof e.message, 'string');
        assert.ok(e.message.length > 0);
      }
    });
  }

  test('raiz que não é perfil: null, undefined, número, string, lista, função', () => {
    for (const v of [null, undefined, 0, 5, '', 'x', [], [base()], true, () => base()]) {
      const e = validateRole(v);
      assert.equal(e.length, 1);
      assert.equal(e[0].path, '');
    }
  });

  test('acumula vários erros no mesmo perfil', () => {
    const r = { id: '', name: '', grants: [{ entity: 'x' }, { entity: 'deal', actions: ['zzz'], scope: 'galaxy' }], partitions: { y: 1 }, fields: [{ entity: 'z' }] };
    const errors = validateRole(r);
    assert.ok(errors.length >= 7, JSON.stringify(paths(errors)));
  });
});

describe('validateRole: fuzz — nunca lança, retorna lista bem formada; se aceitar, o motor aguenta', () => {
  const GARBAGE = [undefined, null, 0, 1, -1, NaN, Infinity, '', 'x', 'read', '*', 'deal', 'tenant', true, false, [], [null], ['*'], ['read'], [[]], [{}], {}, { a: 1 }, '__proto__', 'constructor', 'toString', ' ', 'ctx.x', '$user.id', 1e21, { entity: 'deal', actions: ['read'], scope: 'tenant' }, [{ entity: 'deal', actions: ['read'], scope: 'tenant' }], [{ field: 'status', op: 'eq', value: 1 }]];
  const pathsOf = (obj, prefix = [], out = []) => {
    if (obj && typeof obj === 'object') {
      for (const k of Object.keys(obj)) {
        out.push([...prefix, k]);
        pathsOf(obj[k], [...prefix, k], out);
      }
    }
    return out;
  };
  const setPath = (root, path, value, del) => {
    let o = root;
    for (const k of path.slice(0, -1)) o = o[k];
    const last = path[path.length - 1];
    if (del) {
      if (Array.isArray(o)) o.splice(Number(last), 1);
      else delete o[last];
    } else o[last] = typeof value === 'object' && value !== null ? JSON.parse(JSON.stringify(value)) : value;
  };

  test('perfis de sistema/válidos com 1-4 mutações: validateRole não lança e devolve [{path,message}]', () => {
    const stats = { rejected: 0, accepted: 0 };
    fuzz('validateRole-mutacao', {
      seed: 7171,
      n: 8000,
      shrinkable: false,
      gen: (rng) => {
        const r = clone(rng.bool(0.5) ? rng.pick(SYSTEM_ROLES) : base());
        const hits = 1 + rng.int(4);
        const log = [];
        for (let i = 0; i < hits; i++) {
          const ps = pathsOf(r);
          if (!ps.length) break;
          const p = rng.pick(ps);
          const del = rng.bool(0.2);
          const v = rng.pick(GARBAGE);
          try {
            setPath(r, p, v, del);
            log.push([p.join('.'), del ? '<del>' : v]);
          } catch {
            /* caminho removido */
          }
        }
        return { r, log, probe: genRow(rng, rng.pick(ENTITY_NAMES), { tenantId: 'A' }), rngSeed: rng.int(1e9) };
      },
      check: ({ r, log, probe }) => {
        let errors;
        try {
          errors = validateRole(r);
          assert.ok(Array.isArray(errors));
          for (const e of errors) assert.ok(typeof e.path === 'string' && typeof e.message === 'string');
          if (errors.length) {
            stats.rejected++;
            return;
          }
          stats.accepted++;
          // perfil ACEITO tem que ser executável pelo motor, em todas as entidades/ações, sem exceção
          const ctx = mkCtx({ subject: { id: 'u1', tenantId: 'A', status: 'active', roleIds: [r.id], teamIds: ['t1'], mfa: true }, roles: [{ ...r, tenantId: 'A', system: false }], org: { teams: [] }, policy: {} });
          for (const [name, e] of Object.entries(ENTITIES)) {
            for (const a of e.actions) {
              decide(ctx, name, a, probe, genContext(new Rng(1), a));
              const f = filterFor(ctx, name, a);
              toSql(f.expr, f.entity);
              toPredicate(f.expr)(probe);
            }
            fieldAccess(ctx, name);
          }
        } catch (e) {
          e.message += `\n  mutações: ${JSON.stringify(log)}`;
          throw e;
        }
      },
    });
    assert.ok(stats.rejected > 2000 && stats.accepted > 300, JSON.stringify(stats));
  });

  test('perfis gerados VÁLIDOS por construção são aceitos (positivo) e o motor os executa', () => {
    const genValidRule = (rng, kind) => {
      const entity = rng.bool(0.1) ? '*' : rng.pick(ENTITY_NAMES);
      const pool = entity === '*' ? Object.keys(ACTIONS) : ENTITIES[entity].actions;
      const rule = { entity, actions: rng.bool(0.15) ? ['*'] : rng.some(pool, 1, 3) };
      if (kind === 'grants') rule.scope = entity === '*' ? 'tenant' : rng.pick(ENTITIES[entity].scopes);
      if (rng.bool(0.4)) {
        const attrs = entity === '*' ? [['id', 'uuid'], ['tenantId', 'uuid']] : Object.entries(ENTITIES[entity].attrs);
        const [field, type] = rng.pick(attrs);
        const op = rng.pick(type === 'numeric' ? OPERATORS : OPERATORS.filter((o) => !['lt', 'lte', 'gt', 'gte'].includes(o)));
        const cond = { field, op };
        if (op === 'in' || op === 'nin') cond.value = rng.some(['a', 'b', 'c'], 0, 3);
        else if (op !== 'isNull' && op !== 'notNull') cond.value = type === 'numeric' ? rng.int(100) : 'a';
        rule.conditions = [cond];
      }
      if (rng.bool(0.3) && rule.actions[0] !== '*') {
        const withCtx = rule.actions.filter((a) => (ACTIONS[a].ctx || []).length);
        if (withCtx.length === rule.actions.length) {
          const key = ACTIONS[rule.actions[0]].ctx.find((k) => rule.actions.every((a) => ACTIONS[a].ctx.includes(k)));
          if (key) (rule.conditions ||= []).push({ field: `ctx.${key}`, op: 'eq', value: 'x' });
        }
      }
      if (kind === 'grants' && rng.bool(0.2)) rule.approval = { when: [] };
      return rule;
    };
    fuzz('validateRole-valido', {
      seed: 7272,
      n: 3000,
      shrinkable: false,
      gen: (rng) => ({
        id: 'r' + rng.int(99),
        name: 'Perfil ' + rng.int(99),
        grants: Array.from({ length: rng.int(5) }, () => genValidRule(rng, 'grants')),
        denies: Array.from({ length: rng.int(3) }, () => genValidRule(rng, 'denies')),
        partitions: rng.bool(0.5) ? { pipelineId: rng.bool(0.3) ? 'all' : rng.some(['p1', 'p2'], 0, 2), instanceId: rng.some(['i1'], 0, 1) } : {},
        fields: rng.bool(0.4) ? [{ entity: 'contact', field: rng.pick(ENTITIES.contact.fields), access: rng.pick(['hidden', 'readonly']) }] : [],
      }),
      check: (r) => assert.deepEqual(validateRole(r), []),
    });
  });

  test('fuzz de FORMAS inválidas na raiz: objetos aleatórios nunca lançam', () => {
    fuzz('validateRole-lixo', {
      seed: 7373,
      n: 4000,
      shrinkable: false,
      gen: (rng) => {
        const o = {};
        for (const k of ['id', 'name', 'grants', 'denies', 'partitions', 'fields', 'tenantId', 'system', 'approval']) if (rng.bool(0.7)) o[k] = rng.pick(GARBAGE);
        return o;
      },
      check: (o) => {
        const e = validateRole(o);
        assert.ok(Array.isArray(e));
        // sem id e nome válidos sempre rejeita
        if (typeof o.id !== 'string' || !o.id || o.name == null || !String(o.name).trim()) assert.ok(e.length > 0);
      },
    });
  });
});

describe('isImmutableRole / cloneRole', () => {
  test('perfis de sistema são imutáveis; perfil de tenant, não', () => {
    for (const r of SYSTEM_ROLES) assert.equal(isImmutableRole(r), true);
    assert.equal(isImmutableRole(base()), false);
    assert.equal(isImmutableRole(null), false);
    assert.equal(isImmutableRole(undefined), false);
    assert.equal(isImmutableRole({ system: false }), false);
  });
  test('cloneRole: cópia profunda, editável, sem system e com o tenant dado', () => {
    for (const r of SYSTEM_ROLES) {
      const c = cloneRole(r, { id: 'c', name: 'C', tenantId: 'T' });
      assert.equal(c.system, false);
      assert.equal(c.tenantId, 'T');
      assert.equal(c.id, 'c');
      assert.equal(c.name, 'C');
      assert.deepEqual(c.grants, r.grants);
      assert.notEqual(c.grants, r.grants);
      if (c.grants[0]) assert.notEqual(c.grants[0], r.grants[0]);
      c.grants.push({ entity: 'x' }); // editável (o original é congelado)
      assert.equal(r.grants.length === c.grants.length, false);
    }
  });
  test('systemRoleMap devolve os mesmos 6 perfis, por id', () => {
    const m = systemRoleMap();
    assert.equal(m.size, 6);
    for (const r of SYSTEM_ROLES) assert.equal(m.get(r.id), r);
  });
});

// ---------------------------------------------------------------------------
// (h) último administrador
// ---------------------------------------------------------------------------
describe('wouldRemoveLastAdmin', () => {
  const roles = new Map([...systemRoleMap(), ['custom', { id: 'custom', tenantId: 'A', system: false, grants: [] }]]);
  const U = (id, roleIds, status = 'active', tenantId = 'A') => ({ id, tenantId, status, roleIds });

  test('único admin: rebaixar, suspender, convidar e esvaziar perfis => true', () => {
    const users = [U('a', ['role_admin']), U('b', ['role_agent'])];
    assert.equal(wouldRemoveLastAdmin(users, roles, 'A', { userId: 'a', roleIds: ['role_agent'] }), true);
    assert.equal(wouldRemoveLastAdmin(users, roles, 'A', { userId: 'a', roleIds: [] }), true);
    assert.equal(wouldRemoveLastAdmin(users, roles, 'A', { userId: 'a', status: 'suspended' }), true);
    assert.equal(wouldRemoveLastAdmin(users, roles, 'A', { userId: 'a', status: 'invited' }), true);
    assert.equal(wouldRemoveLastAdmin(users, roles, 'A', { userId: 'a', status: 'deleted' }), true);
    assert.equal(wouldRemoveLastAdmin(users, roles, 'A', { userId: 'a', roleIds: ['custom'], status: 'active' }), true);
  });
  test('mudanças inofensivas => false', () => {
    const users = [U('a', ['role_admin']), U('b', ['role_agent'])];
    assert.equal(wouldRemoveLastAdmin(users, roles, 'A', { userId: 'a' }), false, 'nada muda');
    assert.equal(wouldRemoveLastAdmin(users, roles, 'A', { userId: 'a', roleIds: ['role_admin', 'role_agent'] }), false);
    assert.equal(wouldRemoveLastAdmin(users, roles, 'A', { userId: 'a', status: 'active' }), false);
    assert.equal(wouldRemoveLastAdmin(users, roles, 'A', { userId: 'b', status: 'suspended' }), false);
    assert.equal(wouldRemoveLastAdmin(users, roles, 'A', { userId: 'b', roleIds: ['role_admin'] }), false);
    assert.equal(wouldRemoveLastAdmin(users, roles, 'A', { userId: 'zzz', roleIds: [] }), false, 'usuário inexistente');
  });
  test('dois admins ativos: tirar um pode; tirar o segundo (já sem o primeiro) não', () => {
    const users = [U('a', ['role_admin']), U('b', ['role_admin'])];
    assert.equal(wouldRemoveLastAdmin(users, roles, 'A', { userId: 'a', roleIds: [] }), false);
    const depois = [U('a', []), U('b', ['role_admin'])];
    assert.equal(wouldRemoveLastAdmin(depois, roles, 'A', { userId: 'b', roleIds: [] }), true);
  });
  test('admin suspenso/convidado/de outro tenant NÃO conta como administrador', () => {
    const users = [U('a', ['role_admin']), U('s', ['role_admin'], 'suspended'), U('i', ['role_admin'], 'invited'), U('x', ['role_admin'], 'active', 'B')];
    assert.equal(countActiveAdmins(users, roles, 'A'), 1);
    assert.equal(wouldRemoveLastAdmin(users, roles, 'A', { userId: 'a', roleIds: [] }), true);
    assert.equal(wouldRemoveLastAdmin(users, roles, 'A', { userId: 'x', roleIds: [] }), false, 'mexer em admin de OUTRO tenant não afeta este');
    assert.equal(countActiveAdmins(users, roles, 'B'), 1);
  });
  test('perfil de tenant com id "role_admin" (impostor) não vale como Admin', () => {
    const impostor = new Map([...roles, ['role_admin', { id: 'role_admin', tenantId: 'A', system: false, grants: [] }]]);
    const users = [U('a', ['role_admin'])];
    assert.equal(countActiveAdmins(users, impostor, 'A'), 0);
    const semSystem = new Map([...roles, ['role_admin', { id: 'role_admin', tenantId: null, system: false }]]);
    assert.equal(countActiveAdmins(users, semSystem, 'A'), 0);
    const comTenant = new Map([...roles, ['role_admin', { id: 'role_admin', tenantId: 'A', system: true }]]);
    assert.equal(countActiveAdmins(users, comTenant, 'A'), 0, 'system:true mas com dono não é o Admin de sistema');
  });
  test('tenant que já não tem administrador: não há o que remover => false', () => {
    assert.equal(wouldRemoveLastAdmin([U('a', ['role_agent'])], roles, 'A', { userId: 'a', status: 'suspended' }), false);
    assert.equal(wouldRemoveLastAdmin([], roles, 'A', { userId: 'a', roleIds: [] }), false);
  });
  test('roles como objeto simples e usuários/entradas malformados não lançam', () => {
    const plain = Object.fromEntries(roles);
    const users = [U('a', ['role_admin'])];
    assert.equal(wouldRemoveLastAdmin(users, plain, 'A', { userId: 'a', roleIds: [] }), true);
    for (const r of [undefined, null, {}, [], 5]) assert.doesNotThrow(() => wouldRemoveLastAdmin(users, r, 'A', { userId: 'a', roleIds: [] }));
    for (const u of [undefined, null, {}, 'x', [null, {}, { roleIds: 5 }, { roleIds: 'role_admin', status: 'active', tenantId: 'A' }]]) assert.doesNotThrow(() => wouldRemoveLastAdmin(u, roles, 'A', { userId: 'a', roleIds: [] }));
    assert.equal(countActiveAdmins([{ id: 'z', tenantId: 'A', status: 'active', roleIds: 'role_admin' }], roles, 'A'), 0, 'roleIds string não é lista');
    assert.doesNotThrow(() => wouldRemoveLastAdmin(users, roles, 'A', undefined));
    assert.doesNotThrow(() => wouldRemoveLastAdmin(users, plain, 'A', {}));
    for (const id of ['__proto__', 'constructor', 'toString']) assert.equal(countActiveAdmins([U('p', [id])], plain, 'A'), 0, id);
  });

  test('fuzz contra implementação ingênua (contagem à mão)', () => {
    const naive = (users, tenantId, change) => {
      const isAdmin = (u) => u.tenantId === tenantId && u.status === 'active' && u.roleIds.includes('role_admin');
      const before = users.filter(isAdmin).length;
      const after = users.map((u) => (u.id === change.userId ? { ...u, roleIds: change.roleIds ?? u.roleIds, status: change.status ?? u.status } : u)).filter(isAdmin).length;
      return before > 0 && after === 0;
    };
    const stats = { true: 0, false: 0 };
    fuzz('ultimo-admin', {
      seed: 8181,
      n: 8000,
      gen: (rng) => {
        const nu = 1 + rng.int(5);
        const users = Array.from({ length: nu }, (_, i) => ({
          id: 'u' + i,
          tenantId: rng.weighted([['A', 80], ['B', 20]]),
          status: rng.weighted([['active', 70], ['suspended', 15], ['invited', 15]]),
          roleIds: rng.subset(['role_admin', 'role_agent', 'role_viewer', 'custom'], 0.4),
        }));
        const change = { userId: 'u' + rng.int(nu + 1) };
        if (rng.bool(0.6)) change.roleIds = rng.subset(['role_admin', 'role_agent', 'custom'], 0.4);
        if (rng.bool(0.5)) change.status = rng.pick(['active', 'suspended', 'invited', 'deleted']);
        return { users, change };
      },
      check: ({ users, change }) => {
        const got = wouldRemoveLastAdmin(users, roles, 'A', change);
        assert.equal(got, naive(users, 'A', change));
        stats[got]++;
      },
    });
    assert.ok(stats.true > 300 && stats.false > 300, JSON.stringify(stats));
  });
});

// ---------------------------------------------------------------------------
// (i) diffRoles
// ---------------------------------------------------------------------------
describe('diffRoles', () => {
  const ruleStr = (r) => JSON.stringify(r);
  const sortedRules = (changes, type, kind) => changes.filter((c) => c.type === type && c.kind === kind).map((c) => ruleStr(c.rule)).sort();

  test('perfil igual a si mesmo, ou clone, ou com regras reordenadas/ações reordenadas: sem mudanças', () => {
    for (const r of SYSTEM_ROLES) {
      assert.deepEqual(diffRoles(r, r), [], r.id);
      assert.deepEqual(diffRoles(r, clone(r)), []);
      const rev = clone(r);
      rev.grants.reverse();
      for (const g of rev.grants) g.actions.reverse();
      assert.deepEqual(diffRoles(r, rev), [], 'ordem não é mudança');
    }
  });
  test('adicionar, remover, alterar escopo/condições/aprovação/ações são detectados', () => {
    const a = base();
    const grant = { entity: 'contact', actions: ['read'], scope: 'tenant' };
    let b = clone(a);
    b.grants.push(grant);
    assert.deepEqual(diffRoles(a, b), [{ type: 'added', kind: 'grants', rule: grant }]);
    assert.deepEqual(diffRoles(b, a), [{ type: 'removed', kind: 'grants', rule: grant }]);
    for (const mut of [(r) => (r.grants[0].scope = 'tenant'), (r) => (r.grants[0].actions.push('delete')), (r) => (r.grants[0].conditions[0].value = 'won'), (r) => (r.grants[0].conditions = []), (r) => (r.grants[0].approval = { when: [] }), (r) => (r.grants[0].entity = 'company'), (r) => r.denies.push({ entity: 'deal', actions: ['export'] }), (r) => (r.denies = [])]) {
      b = clone(a);
      mut(b);
      const d = diffRoles(a, b);
      assert.ok(d.length >= 1, String(mut));
      assert.ok(d.some((x) => x.type === 'added' || x.type === 'removed'), String(mut));
    }
  });
  test('partições, campos e nome são detectados como "changed"', () => {
    const a = base();
    const b = clone(a);
    b.partitions = { pipelineId: ['p1', 'p2'] };
    b.fields = [];
    b.name = 'Outro';
    assert.deepEqual(
      diffRoles(a, b).map((c) => [c.type, c.kind]),
      [['changed', 'partitions'], ['changed', 'fields'], ['changed', 'name']]
    );
    const d = diffRoles(a, b).find((c) => c.kind === 'partitions');
    assert.deepEqual(d.before, { pipelineId: ['p1'] });
    assert.deepEqual(d.after, { pipelineId: ['p1', 'p2'] });
  });
  test('perfis nulos/parciais não lançam', () => {
    assert.deepEqual(diffRoles(undefined, undefined), []);
    assert.deepEqual(diffRoles({}, {}), []);
    assert.doesNotThrow(() => diffRoles(null, base()));
    assert.ok(diffRoles(null, base()).length > 0);
    assert.ok(diffRoles(base(), null).length > 0);
    assert.doesNotThrow(() => diffRoles({ grants: 'x', denies: 5 }, { grants: [null, 5, {}, { entity: 'x' }] }));
  });

  test('fuzz: simetria (added(a,b) == removed(b,a), e vice-versa), identidade e trânsito vazio', () => {
    const genRole = (rng) => {
      const r = clone(base());
      r.grants = Array.from({ length: rng.int(4) }, () => ({ entity: rng.pick(['deal', 'contact', 'task']), actions: rng.some(['read', 'update', 'delete', 'create'], 1, 3), scope: rng.pick(['own', 'team', 'tenant']), ...(rng.bool(0.3) ? { conditions: [{ field: 'status', op: 'eq', value: rng.pick(['a', 'b']) }] } : {}), ...(rng.bool(0.2) ? { approval: { when: [] } } : {}) }));
      r.denies = Array.from({ length: rng.int(3) }, () => ({ entity: rng.pick(['deal', 'contact']), actions: rng.some(['read', 'export', 'delete'], 1, 2) }));
      r.partitions = rng.bool(0.5) ? { pipelineId: rng.some(['p1', 'p2', 'p3'], 0, 3) } : {};
      r.fields = rng.bool(0.4) ? [{ entity: 'deal', field: 'value', access: rng.pick(['hidden', 'readonly']) }] : [];
      r.name = rng.pick(['A', 'B']);
      return r;
    };
    const dedupe = (list) => [...new Map(list.map((x) => [JSON.stringify([x.entity, [...x.actions].sort(), x.scope ?? '', x.conditions ?? [], x.approval ?? null]), x])).values()];
    fuzz('diff-simetria', {
      seed: 9191,
      n: 6000,
      shrinkable: false,
      gen: (rng) => ({ a: genRole(rng), b: genRole(rng), c: genRole(rng) }),
      check: ({ a, b }) => {
        const ab = diffRoles(a, b);
        const ba = diffRoles(b, a);
        for (const kind of ['grants', 'denies']) {
          assert.deepEqual(sortedRules(ab, 'added', kind), sortedRules(ba, 'removed', kind));
          assert.deepEqual(sortedRules(ab, 'removed', kind), sortedRules(ba, 'added', kind));
        }
        for (const kind of ['partitions', 'fields', 'name']) {
          const x = ab.find((c) => c.kind === kind);
          const y = ba.find((c) => c.kind === kind);
          assert.equal(!!x, !!y, kind);
          if (x) {
            assert.deepEqual(x.before, y.after);
            assert.deepEqual(x.after, y.before);
          }
        }
        assert.deepEqual(diffRoles(a, a), []);
        assert.deepEqual(diffRoles(a, clone(a)), []);
        // "adicionado" nunca é algo que já existia (e "removido" nunca é algo que continua)
        const keyOf = (x) => JSON.stringify([x.entity, [...x.actions].sort(), x.scope ?? '', x.conditions ?? [], x.approval ?? null]);
        for (const ch of ab) {
          if (ch.type === 'added') assert.ok(!(a[ch.kind] || []).some((x) => keyOf(x) === keyOf(ch.rule)));
          if (ch.type === 'removed') assert.ok(!(b[ch.kind] || []).some((x) => keyOf(x) === keyOf(ch.rule)));
        }
        void dedupe;
      },
    });
  });

  test('fuzz semântico: diff vazio (grants/denies/partições/campos iguais) => decisões idênticas', () => {
    fuzz('diff-vazio-igual-comportamento', {
      seed: 9292,
      n: 3000,
      shrinkable: false,
      gen: (rng) => {
        const mk = () => {
          const r = clone(base());
          r.grants = Array.from({ length: 1 + rng.int(3) }, () => ({ entity: 'deal', actions: rng.some(['read', 'update', 'delete'], 1, 3), scope: rng.pick(['own', 'team', 'tenant']), ...(rng.bool(0.3) ? { conditions: [{ field: 'status', op: 'eq', value: 'open' }] } : {}) }));
          r.denies = rng.bool(0.4) ? [{ entity: 'deal', actions: ['delete'] }] : [];
          return r;
        };
        const a = mk();
        const b = rng.bool(0.5) ? clone(a) : mk();
        if (rng.bool(0.5)) {
          b.grants.reverse();
          for (const g of b.grants) g.actions.reverse();
        }
        const rows = Array.from({ length: 12 }, () => genRow(rng, 'deal', { tenantId: 'A' }));
        return { a, b, rows };
      },
      check: ({ a, b, rows }) => {
        const d = diffRoles(a, b);
        if (d.length) return;
        const mk = (r) => mkCtx({ subject: { id: 'u1', tenantId: 'A', status: 'active', roleIds: ['x'], teamIds: ['t1', 't2'] }, roles: [{ ...r, id: 'x' }], org: { teams: [{ id: 't2', parentId: 't1' }] }, policy: {} });
        const ca = mk(a);
        const cb = mk(b);
        for (const row of rows) for (const act of ['read', 'update', 'delete']) assert.equal(decide(ca, 'deal', act, row).effect, decide(cb, 'deal', act, row).effect);
      },
    });
    void TEAMS;
  });
});

describe('auditEvent', () => {
  test('monta o evento padronizado; diff só quando há antes E depois', () => {
    const a = base();
    const b = clone(a);
    b.name = 'Novo';
    const ev = auditEvent({ at: '2026-10-09T12:00:00Z', tenantId: 'A', actorId: 'u1', action: 'role.update', target: { type: 'role', id: 'custom' }, before: a, after: b });
    assert.deepEqual(Object.keys(ev), ['at', 'tenantId', 'actorId', 'action', 'target', 'diff']);
    assert.deepEqual(ev.diff, [{ type: 'changed', kind: 'name', before: 'Perfil de teste', after: 'Novo' }]);
    assert.equal(auditEvent({ at: 'x', tenantId: 'A', actorId: 'u', action: 'role.create', target: 't', after: b }).diff, undefined);
    assert.equal(auditEvent({ at: 'x', tenantId: 'A', actorId: 'u', action: 'role.delete', target: 't', before: b }).diff, undefined);
    assert.deepEqual(auditEvent({ at: 'x', tenantId: 'A', actorId: 'u', action: 'a', target: 't', before: a, after: clone(a) }).diff, []);
  });
});

test('todo SCOPES é aceito por alguma entidade de registro (sanidade do catálogo)', () => {
  for (const s of SCOPES) assert.ok(Object.values(ENTITIES).some((e) => e.scopes.includes(s)), s);
});
