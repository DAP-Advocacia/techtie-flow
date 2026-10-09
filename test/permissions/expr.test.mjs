// expr.js: álgebra de predicados (evaluate) e SEGURANÇA do toSql (injeção, nomes, parâmetros).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TRUE, FALSE, and, or, not, cmp, shared, evaluate, toPredicate, toSql, describe as describeExpr, ENTITIES, columnOf, OPERATORS, filterFor } from '../../shared/permissions/index.js';
import { Rng, fuzz, genCase, mkCtx, ENTITY_NAMES } from './support.mjs';

const DEAL = ENTITIES.deal;
const CONV = ENTITIES.conversation;

describe('construtores: simplificação e identidades', () => {
  const a = cmp('x', 'eq', 1);
  const b = cmp('y', 'eq', 2);
  test('and/or vazios e elementos neutros/absorventes', () => {
    assert.equal(and(), TRUE);
    assert.equal(or(), FALSE);
    assert.equal(and(TRUE, TRUE), TRUE);
    assert.equal(or(FALSE, FALSE), FALSE);
    assert.equal(and(a, FALSE, b), FALSE);
    assert.equal(or(a, TRUE, b), TRUE);
    assert.deepEqual(and(a, TRUE), a);
    assert.deepEqual(or(a, FALSE), a);
  });
  test('achata aninhados e aceita arrays', () => {
    assert.deepEqual(and(a, and(b, a)), { t: 'and', args: [a, b, a] });
    assert.deepEqual(or([a, b]), { t: 'or', args: [a, b] });
    assert.deepEqual(and([a], [b]).args.length, 2);
  });
  test('not: dupla negação e constantes', () => {
    assert.equal(not(TRUE), FALSE);
    assert.equal(not(FALSE), TRUE);
    assert.deepEqual(not(not(a)), a);
    assert.deepEqual(not(a), { t: 'not', arg: a });
  });
  test('TRUE/FALSE são imutáveis (compartilhados por todos os tenants)', () => {
    assert.throws(() => (TRUE.t = 'false'), TypeError);
    assert.throws(() => (FALSE.t = 'true'), TypeError);
  });
});

describe('evaluate: lógica dois-valorada', () => {
  const row = { a: 1, n: null, s: 'x' };
  test('não-cmp: constantes, and/or/not', () => {
    assert.equal(evaluate(TRUE, row), true);
    assert.equal(evaluate(FALSE, row), false);
    assert.equal(evaluate({ t: 'and', args: [cmp('a', 'eq', 1), cmp('s', 'eq', 'x')] }, row), true);
    assert.equal(evaluate({ t: 'and', args: [cmp('a', 'eq', 1), cmp('s', 'eq', 'y')] }, row), false);
    assert.equal(evaluate({ t: 'or', args: [cmp('a', 'eq', 2), cmp('s', 'eq', 'x')] }, row), true);
    assert.equal(evaluate({ t: 'or', args: [] }, row), false);
    assert.equal(evaluate({ t: 'and', args: [] }, row), true);
  });
  test('NOT de comparação com null funciona como no SQL com COALESCE: not(eq) em null é TRUE', () => {
    assert.equal(evaluate(not(cmp('n', 'eq', 1)), row), true);
    assert.equal(evaluate(not(cmp('n', 'ne', 1)), row), false);
    assert.equal(evaluate(not(cmp('n', 'in', [1])), row), true);
    assert.equal(evaluate(not(cmp('n', 'lt', 1)), row), true);
    assert.equal(evaluate(not(cmp('missing', 'gt', 1)), row), true);
  });
  test('linha nula/indefinida: tudo falso exceto ne/nin/isNull', () => {
    for (const r of [null, undefined]) {
      assert.equal(evaluate(cmp('a', 'eq', 1), r), false);
      assert.equal(evaluate(cmp('a', 'ne', 1), r), true);
      assert.equal(evaluate(cmp('a', 'isNull'), r), true);
      assert.equal(evaluate(cmp('a', 'notNull'), r), false);
      assert.equal(evaluate(cmp('a', 'nin', [1]), r), true);
      assert.equal(evaluate(shared('deal', ['read'], 'u', []), r), false);
    }
  });
  test('in/nin com valor que não é lista', () => {
    assert.equal(evaluate(cmp('a', 'in', 1), row), false);
    assert.equal(evaluate(cmp('a', 'nin', 1), row), true);
  });
  test('comparação é ESTRITA (sem coerção): "1" não é 1; strings comparam por ordem lexicográfica', () => {
    assert.equal(evaluate(cmp('a', 'eq', '1'), row), false);
    assert.equal(evaluate(cmp('a', 'in', ['1']), row), false);
    assert.equal(evaluate(cmp('s', 'gt', 'a'), row), true);
  });
  test('valor nulo em comparações ordenadas é FALSO e ne com valor nulo é IS DISTINCT FROM (igual ao SQL)', () => {
    for (const op of ['lt', 'lte', 'gt', 'gte']) for (const left of [-1, 0, 5, null]) assert.equal(evaluate(cmp('v', op, null), { v: left }), false, `${left} ${op} null`);
    for (const op of ['lt', 'lte', 'gt', 'gte']) assert.equal(evaluate(cmp('v', op, undefined), { v: 5 }), false);
    assert.equal(evaluate(cmp('v', 'ne', null), { v: null }), false);
    assert.equal(evaluate(cmp('v', 'ne', null), { v: 0 }), true);
    assert.equal(evaluate(cmp('v', 'ne', undefined), { v: undefined }), false);
    assert.equal(evaluate(cmp('v', 'eq', null), { v: null }), false);
  });
  test('nós e operadores desconhecidos lançam (nunca "permitem" em silêncio)', () => {
    assert.throws(() => evaluate({ t: 'xor', args: [] }, row), /desconhecido/);
    assert.throws(() => evaluate(cmp('a', 'like', 1), row), /desconhecido/);
  });
  test('shared: exige tipo, nível e id; id ausente nunca casa; entradas nulas não lançam', () => {
    const e = shared('deal', ['read', 'edit'], 'u1', ['t1', 't2']);
    const ev = (sw) => evaluate(e, { sharedWith: sw });
    assert.equal(ev([{ type: 'user', id: 'u1', level: 'read' }]), true);
    assert.equal(ev([{ type: 'team', id: 't2', level: 'edit' }]), true);
    assert.equal(ev([{ type: 'team', id: 't9', level: 'edit' }]), false);
    assert.equal(ev([{ type: 'user', id: 'u1', level: 'owner' }]), false);
    assert.equal(ev([{ type: 'user', level: 'read' }]), false);
    assert.equal(ev([null, undefined, 5, 'x', {}]), false);
    assert.equal(ev(undefined), false);
    assert.equal(ev({ 0: { type: 'user', id: 'u1', level: 'read' }, length: 1 }), false, 'array-like não é lista');
    // usuário SEM id não casa com share sem id (undefined === undefined)
    assert.equal(evaluate(shared('deal', ['read'], undefined, []), { sharedWith: [{ type: 'user', level: 'read' }] }), false);
    assert.equal(evaluate(shared('deal', ['read'], null, []), { sharedWith: [{ type: 'user', id: null, level: 'read' }] }), false);
    assert.equal(evaluate(shared('deal', ['read'], 'u', [undefined]), { sharedWith: [{ type: 'team', level: 'read' }] }), false);
  });
  test('describe() não lança e menciona operador/campo', () => {
    const e = and(cmp('ownerId', 'eq', 'u1'), or(cmp('v', 'isNull'), not(cmp('x', 'in', [1]))), shared('deal', ['read'], 'u', []));
    const text = describeExpr(e);
    assert.match(text, /ownerId eq "u1"/);
    assert.match(text, /v isNull/);
    assert.equal(describeExpr(TRUE), 'sempre');
    assert.equal(describeExpr(FALSE), 'nunca');
    assert.equal(describeExpr({ t: '??' }), '?');
  });
});

describe('toSql: texto gerado (golden)', () => {
  const sql = (e, def = DEAL, o) => toSql(e, def, o);
  test('constantes', () => {
    assert.deepEqual(sql(TRUE), { sql: 'TRUE', params: [] });
    assert.deepEqual(sql(FALSE), { sql: 'FALSE', params: [] });
  });
  test('cada operador, com cast do tipo do atributo e alias', () => {
    const o = { alias: 'd' };
    assert.deepEqual(sql(cmp('ownerId', 'eq', 'u'), DEAL, o), { sql: 'COALESCE(d.owner_id = $1::uuid, FALSE)', params: ['u'] });
    assert.deepEqual(sql(cmp('status', 'ne', 'won'), DEAL, o), { sql: '(d.status IS DISTINCT FROM $1::text)', params: ['won'] });
    assert.deepEqual(sql(cmp('pipelineId', 'in', ['a', 'b']), DEAL, o), { sql: 'COALESCE(d.pipeline_id = ANY($1::uuid[]), FALSE)', params: [['a', 'b']] });
    assert.deepEqual(sql(cmp('pipelineId', 'nin', ['a']), DEAL, o), { sql: '(NOT COALESCE(d.pipeline_id = ANY($1::uuid[]), FALSE))', params: [['a']] });
    assert.deepEqual(sql(cmp('value', 'lt', 5), DEAL, o), { sql: 'COALESCE(d.value < $1::numeric, FALSE)', params: [5] });
    assert.deepEqual(sql(cmp('value', 'lte', 5), DEAL, o), { sql: 'COALESCE(d.value <= $1::numeric, FALSE)', params: [5] });
    assert.deepEqual(sql(cmp('value', 'gt', 5), DEAL, o), { sql: 'COALESCE(d.value > $1::numeric, FALSE)', params: [5] });
    assert.deepEqual(sql(cmp('value', 'gte', 5), DEAL, o), { sql: 'COALESCE(d.value >= $1::numeric, FALSE)', params: [5] });
    assert.deepEqual(sql(cmp('teamId', 'isNull'), DEAL, o), { sql: '(d.team_id IS NULL)', params: [] });
    assert.deepEqual(sql(cmp('teamId', 'notNull'), DEAL, o), { sql: '(d.team_id IS NOT NULL)', params: [] });
    assert.deepEqual(sql(cmp('assigneeId', 'eq', 'u'), CONV, o), { sql: 'COALESCE(d.assignee_id = $1::uuid, FALSE)', params: ['u'] });
    assert.deepEqual(sql(cmp('instanceId', 'eq', 'i'), CONV, o), { sql: 'COALESCE(d.instance_id = $1::uuid, FALSE)', params: ['i'] });
    assert.deepEqual(sql(cmp('tenantId', 'eq', 'A')), { sql: 'COALESCE(t.tenant_id = $1::uuid, FALSE)', params: ['A'] });
  });
  test('and/or/not e ordem dos parâmetros', () => {
    const e = and(cmp('tenantId', 'eq', 'A'), or(cmp('ownerId', 'eq', 'u'), cmp('teamId', 'in', ['x'])), not(cmp('status', 'eq', 's')));
    const r = sql(e, DEAL, { alias: 'd' });
    assert.equal(r.sql, '(COALESCE(d.tenant_id = $1::uuid, FALSE) AND (COALESCE(d.owner_id = $2::uuid, FALSE) OR COALESCE(d.team_id = ANY($3::uuid[]), FALSE)) AND (NOT COALESCE(d.status = $4::text, FALSE)))');
    assert.deepEqual(r.params, ['A', 'u', ['x'], 's']);
  });
  test('shared: 4 parâmetros, amarrado ao tenant e à linha', () => {
    const r = sql(shared('deal', ['read', 'edit'], 'u1', ['t1']), DEAL, { alias: 'd', startAt: 3 });
    assert.equal(
      r.sql,
      "EXISTS (SELECT 1 FROM resource_shares shr_ WHERE shr_.tenant_id = d.tenant_id AND shr_.entity = $3::text AND shr_.resource_id = d.id AND shr_.level = ANY($4::text[]) AND ((shr_.subject_type = 'user' AND shr_.subject_id = $5::uuid) OR (shr_.subject_type = 'team' AND shr_.subject_id = ANY($6::uuid[]))))"
    );
    assert.deepEqual(r.params, ['deal', ['read', 'edit'], 'u1', ['t1']]);
  });
  test('columnOf: camelCase -> snake_case', () => {
    assert.equal(columnOf('ownerId'), 'owner_id');
    assert.equal(columnOf('tenantId'), 'tenant_id');
    assert.equal(columnOf('status'), 'status');
  });
});

describe('toSql: numeração de parâmetros (startAt)', () => {
  const e = and(cmp('ownerId', 'eq', 'u'), cmp('status', 'in', ['a']), shared('deal', ['read'], 'u', []));
  const placeholders = (s) => [...s.matchAll(/\$(\d+)::/g)].map((m) => Number(m[1]));
  for (const startAt of [1, 2, 7, 100, 9999]) {
    test(`startAt=${startAt}: numeração contígua, na ordem e sem lacunas`, () => {
      const { sql, params } = toSql(e, DEAL, { startAt });
      assert.equal(params.length, 2 + 4);
      assert.deepEqual(placeholders(sql), Array.from({ length: params.length }, (_, i) => startAt + i));
    });
  }
  test('startAt inválido lança (string "1" gerava $10 no lugar de $1)', () => {
    for (const startAt of [0, -1, 1.5, '1', '2', NaN, Infinity, null, {}, [], true]) assert.throws(() => toSql(cmp('ownerId', 'eq', 'u'), DEAL, { startAt }), /startAt/, String(startAt));
  });
  test('composição com outra query: params reais continuam alinhados com o texto', () => {
    const first = ['filtro-externo', 'outro'];
    const { sql, params } = toSql(cmp('ownerId', 'eq', 'u'), DEAL, { alias: 'd', startAt: first.length + 1 });
    assert.equal(sql, 'COALESCE(d.owner_id = $3::uuid, FALSE)');
    assert.deepEqual([...first, ...params][3 - 1], 'u');
  });
});

describe('toSql: nunca interpola valores, nomes ou aliases suspeitos', () => {
  const EVIL = [
    "'; DROP TABLE deals;--",
    "' OR '1'='1",
    '"; DELETE FROM users; --',
    'x\u0000y',
    '\u0000',
    '$1',
    '$1::text) OR (TRUE',
    '${process.exit(1)}',
    '\\',
    "'",
    '\n--\n',
    '/* x */',
    'ß‮evil',
    ')); DROP SCHEMA public CASCADE;--',
    '',
    ' ',
  ];

  test('valores maliciosos só aparecem em params — nunca no texto SQL', () => {
    for (const v of EVIL) {
      for (const op of ['eq', 'ne', 'lt', 'lte', 'gt', 'gte']) {
        const { sql, params } = toSql(cmp('status', op, v), DEAL, { alias: 'd' });
        assert.deepEqual(params, [v]);
        if (v.length > 1 && !v.startsWith('$')) assert.ok(!sql.includes(v), `${op} vazou ${JSON.stringify(v)}`); // '$1' é o próprio marcador legítimo
        assert.ok(!/DROP|DELETE|process|OR '1'|--/.test(sql), sql);
      }
      for (const op of ['in', 'nin']) {
        const { sql, params } = toSql(cmp('status', op, [v, v]), DEAL);
        assert.deepEqual(params, [[v, v]]);
        if (v.length > 1 && !v.startsWith('$')) assert.ok(!sql.includes(v));
      }
      const s = toSql(shared('deal', [v], v, [v]), DEAL);
      assert.deepEqual(s.params, ['deal', [v], v, [v]]);
      if (v.length > 1 && !v.startsWith('$')) assert.ok(!s.sql.includes(v));
    }
  });

  test('o texto SQL de um cmp tem tamanho constante, independente do valor (array enorme vira 1 parâmetro)', () => {
    const huge = Array.from({ length: 200_000 }, (_, i) => `id-${i}-'; DROP--`);
    const small = toSql(cmp('ownerId', 'in', ['a']), DEAL);
    const big = toSql(cmp('ownerId', 'in', huge), DEAL);
    assert.equal(big.sql, small.sql);
    assert.equal(big.params.length, 1);
    assert.equal(big.params[0].length, 200_000);
    const longStr = 'x'.repeat(5_000_000);
    assert.equal(toSql(cmp('status', 'eq', longStr), DEAL).sql.length, toSql(cmp('status', 'eq', 'a'), DEAL).sql.length);
  });

  test('nomes de atributo inválidos (injeção, protótipo, vazio, tipo errado) LANÇAM', () => {
    const BAD = [
      'ownerId; DROP TABLE deals',
      'ownerId) OR (1=1',
      'owner_id', // coluna física direta não é atributo do catálogo
      't.owner_id',
      'ownerId ',
      ' ownerId',
      'OwnerId',
      '"ownerId"',
      '',
      'constructor',
      '__proto__',
      'toString',
      'hasOwnProperty',
      'valueOf',
      'prototype',
      'naoExiste',
      'phone', // campo restringível, não atributo
      'sharedWith',
      undefined,
      null,
      123,
      {},
      ['ownerId'],
      Symbol('x'),
    ];
    for (const field of BAD) {
      assert.throws(() => toSql({ t: 'cmp', field, op: 'eq', value: 'x' }, DEAL), /atributo/, String(typeof field === 'symbol' ? 'symbol' : JSON.stringify(field)));
    }
    // atributo existe em outra entidade mas não nesta
    assert.throws(() => toSql(cmp('assigneeId', 'eq', 'x'), DEAL), /não existe/);
    assert.throws(() => toSql(cmp('stageId', 'eq', 'x'), CONV), /não existe/);
    // até para isNull/notNull (que não têm valor)
    assert.throws(() => toSql({ t: 'cmp', field: 'x; DROP', op: 'isNull' }, DEAL), /atributo/);
  });

  test('alias inválido LANÇA; alias válido aparece só como identificador', () => {
    const BAD = ['', ' ', 't; DROP TABLE x', 't.x', 't x', "t'", 't"', 't--', '1t', 't\n', '\nt', 't\u0000', 'é', 't)', '*', 't/*', null, 5, ['t'], { toString: () => 't' }, Symbol('t'), true, '$1'];
    for (const alias of BAD) assert.throws(() => toSql(cmp('ownerId', 'eq', 'x'), DEAL, { alias }), /alias/, typeof alias === 'symbol' ? 'symbol' : JSON.stringify(alias));
    for (const alias of ['t', 'd', '_x', 'Deal2', 'a_b_c9']) assert.match(toSql(cmp('ownerId', 'eq', 'x'), DEAL, { alias }).sql, new RegExp(`^COALESCE\\(${alias}\\.owner_id`));
    // alias inválido lança mesmo quando a expressão é TRUE/FALSE (não pode depender do caminho)
    assert.throws(() => toSql(TRUE, DEAL, { alias: 'x; y' }), /alias/);
  });

  test('operador e nó desconhecidos lançam (nunca viram SQL)', () => {
    for (const op of ['like', 'EQ', '=', 'eq; DROP', undefined, null, '__proto__', 'constructor', 'toString']) {
      assert.throws(() => toSql({ t: 'cmp', field: 'ownerId', op, value: 'x' }, DEAL), /operador/, String(op));
    }
    for (const t of ['xor', undefined, null, '__proto__', 'raw']) assert.throws(() => toSql({ t }, DEAL), /nó de expressão/, String(t));
    assert.throws(() => toSql({ t: 'raw', sql: '1=1' }, DEAL), /nó de expressão/);
  });

  test('entityDef sem attrs / entidade desconhecida lança em vez de gerar SQL', () => {
    assert.throws(() => toSql(cmp('ownerId', 'eq', 'x'), { table: 'x', attrs: {} }), /não existe/);
    assert.throws(() => toSql(cmp('ownerId', 'eq', 'x'), undefined), TypeError);
    // tipo de atributo fora de PG_TYPES nunca vira cast arbitrário
    assert.throws(() => toSql(cmp('x', 'eq', 'v'), { table: 't', attrs: { x: "text); DROP TABLE t;--" } }), /não existe/);
    assert.throws(() => toSql(cmp('x', 'eq', 'v'), { table: 't', attrs: { x: 'constructor' } }), /não existe/);
  });

  test('a lista (filterFor) de entidade desconhecida/negada vira FALSE no SQL, sem lançar', () => {
    const ctx = mkCtx({ subject: { id: 'u', tenantId: 'A', status: 'suspended', roleIds: ['role_admin'] }, roles: [], org: { teams: [] }, policy: {} });
    const f = filterFor(ctx, 'deal', 'read');
    assert.equal(toSql(f.expr, f.entity).sql, 'FALSE');
  });
});

// ---------------------------------------------------------------------------
// Lista branca de tokens: TODO texto gerado só pode conter tokens conhecidos.
// ---------------------------------------------------------------------------
function tokensOf(sql, alias, entity) {
  const cols = [...new Set([...Object.keys(entity.attrs).map(columnOf), 'tenant_id', 'id'])];
  const rx = new RegExp(
    '^(?:' +
      [
        '\\s+',
        '[(),]',
        '<=|>=|=|<|>',
        '\\b(?:AND|OR|NOT|TRUE|FALSE|NULL|IS|DISTINCT|FROM|ANY|EXISTS|SELECT|WHERE|COALESCE)\\b',
        '\\b1\\b',
        '\\bresource_shares\\b',
        '\\bshr_\\.(?:tenant_id|entity|resource_id|level|subject_type|subject_id)\\b',
        '\\bshr_\\b',
        "'(?:user|team)'",
        '\\$\\d+::(?:uuid|text|numeric|boolean)(?:\\[\\])?',
        `\\b${alias}\\.(?:${cols.join('|')})\\b`,
        `\\b${alias}\\.(?:tenant_id|id)\\b`,
      ].join('|') +
      ')'
  );
  const out = [];
  let rest = sql;
  while (rest.length) {
    const m = rx.exec(rest);
    if (!m || !m[0].length) throw new Error(`token inesperado em: ${JSON.stringify(rest.slice(0, 60))}\nSQL: ${sql}`);
    if (!/^\s+$/.test(m[0])) out.push(m[0]);
    rest = rest.slice(m[0].length);
  }
  return out;
}

function expectedParams(e, out = []) {
  switch (e.t) {
    case 'and':
    case 'or':
      e.args.forEach((a) => expectedParams(a, out));
      break;
    case 'not':
      expectedParams(e.arg, out);
      break;
    case 'cmp':
      if (e.op !== 'isNull' && e.op !== 'notNull') out.push(e.value);
      break;
    case 'shared':
      out.push(e.entity, e.levels, e.userId, e.teamIds);
      break;
  }
  return out;
}

describe('toSql: lista branca de tokens (fuzz)', () => {
  const ALIASES = ['t', 'd', '_x', 'Deal2', 'a_b_c9'];

  test('expressões reais do motor (filterFor) só geram tokens esperados e params alinhados', () => {
    let nonTrivial = 0;
    fuzz('sql-whitelist-motor', {
      seed: 1111,
      n: 4000,
      gen: (rng) => ({ c: genCase(rng, { sysP: 0.3, approvalP: 0.3 }), alias: rng.pick(ALIASES), startAt: 1 + rng.int(50) }),
      check: ({ c, alias, startAt }) => {
        const f = filterFor(mkCtx(c), c.entity, c.action);
        const { sql, params } = toSql(f.expr, f.entity ?? ENTITIES[c.entity], { alias, startAt });
        tokensOf(sql, alias, ENTITIES[c.entity]);
        const nums = [...sql.matchAll(/\$(\d+)::/g)].map((m) => Number(m[1]));
        assert.deepEqual(nums, params.map((_, i) => startAt + i));
        assert.deepEqual(params, expectedParams(f.expr));
        if (params.length > 3) nonTrivial++;
      },
      shrinkable: false,
    });
    assert.ok(nonTrivial > 100, `poucos casos não triviais (${nonTrivial})`);
  });

  test('árvores ALEATÓRIAS com valores maliciosos: texto só tem tokens da lista e valores só em params', () => {
    const EVIL_POOL = [...EVIL_VALUES(), 7, null, true, 0, -1, 1e308];
    const attrs = (def) => Object.keys(def.attrs);
    const genTree = (rng, def, depth) => {
      const r = rng.float();
      if (depth <= 0 || r < 0.45) {
        if (rng.bool(0.1)) return rng.pick([TRUE, FALSE]);
        if (rng.bool(0.12)) return shared(rng.pick(ENTITY_NAMES), [rng.pick(EVIL_POOL)], rng.pick(EVIL_POOL), [rng.pick(EVIL_POOL)]);
        const op = rng.pick(OPERATORS);
        const v = op === 'in' || op === 'nin' ? Array.from({ length: rng.int(4) }, () => rng.pick(EVIL_POOL)) : rng.pick(EVIL_POOL);
        return cmp(rng.pick(attrs(def)), op, v);
      }
      const k = 1 + rng.int(3);
      if (r < 0.7) return { t: 'and', args: Array.from({ length: k }, () => genTree(rng, def, depth - 1)) };
      if (r < 0.9) return { t: 'or', args: Array.from({ length: k }, () => genTree(rng, def, depth - 1)) };
      return { t: 'not', arg: genTree(rng, def, depth - 1) };
    };
    fuzz('sql-whitelist-arvores', {
      seed: 1212,
      n: 3000,
      shrinkable: false,
      gen: (rng) => {
        const entity = rng.pick(ENTITY_NAMES);
        return { entity, tree: genTree(rng, ENTITIES[entity], 3), alias: rng.pick(ALIASES), startAt: 1 + rng.int(9) };
      },
      check: ({ entity, tree, alias, startAt }) => {
        const { sql, params } = toSql(tree, ENTITIES[entity], { alias, startAt });
        tokensOf(sql, alias, ENTITIES[entity]);
        assert.deepEqual(params, expectedParams(tree));
        for (const v of EVIL_VALUES()) if (v.length > 2 && !v.startsWith('$')) assert.ok(!sql.includes(v), `vazou ${JSON.stringify(v)}`);
      },
    });
  });

  test('o verificador de tokens de fato rejeita texto estranho (teste do teste)', () => {
    assert.throws(() => tokensOf("COALESCE(t.owner_id = $1::uuid, FALSE) OR 'x'='x'", 't', DEAL), /token inesperado/);
    assert.throws(() => tokensOf('t.owner_id = 1; DROP TABLE x', 't', DEAL), /token inesperado/);
    assert.throws(() => tokensOf('COALESCE(t.naoexiste = $1::uuid, FALSE)', 't', DEAL), /token inesperado/);
    assert.doesNotThrow(() => tokensOf('COALESCE(t.owner_id = $1::uuid, FALSE)', 't', DEAL));
  });
});

function EVIL_VALUES() {
  return ["'; DROP TABLE deals;--", "' OR '1'='1", 'x\u0000y', '$1', '$2::text) OR (TRUE', ')); DROP SCHEMA public CASCADE;--', '\n--\n', '/* x */', '${1+1}', 'UNION SELECT password FROM users'];
}

test('toPredicate devolve função pura (row)=>boolean', () => {
  const p = toPredicate(cmp('a', 'eq', 1));
  assert.equal(p({ a: 1 }), true);
  assert.equal(p({ a: 2 }), false);
  assert.equal(p(undefined), false);
});

test('fixture do Rng é determinística (mesma semente => mesma sequência)', () => {
  const a = new Rng(42);
  const b = new Rng(42);
  for (let i = 0; i < 100; i++) assert.equal(a.float(), b.float());
  assert.notEqual(new Rng(43).float(), new Rng(42).float());
});
