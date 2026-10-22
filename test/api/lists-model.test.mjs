// Listas em tabela: filtros por tipo, ordenação, busca e visões salvas (modelo puro).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const M = await import('../../public/js/lists/model.js');
const { applyFilters, sortRows, searchRows, runList, normalizeState, defaultState, describeFilter, makeViewsStore, matchFilter, parseDay, opsOf } = M;

const NOW = new Date(2026, 9, 21, 10, 0); // 21/10/2026
const at = (y, m, d) => new Date(y, m - 1, d, 12).getTime();
const COLS = [
  { id: 'name', label: 'Nome', type: 'text', get: (r) => r.name, search: true, visible: true },
  { id: 'company', label: 'Empresa', type: 'text', get: (r) => r.company, search: true, visible: true },
  { id: 'value', label: 'Valor', type: 'money', get: (r) => r.value, visible: true },
  { id: 'qty', label: 'Qtd', type: 'number', get: (r) => r.qty },
  { id: 'due', label: 'Prazo', type: 'date', get: (r) => r.due },
  { id: 'stage', label: 'Etapa', type: 'enum', get: (r) => r.stage, options: () => [{ value: 'a', label: 'Aberta' }, { value: 'w', label: 'Ganha' }] },
  { id: 'hot', label: 'Quente', type: 'bool', get: (r) => r.hot },
];
const ROWS = [
  { id: 1, name: 'Ação Ótima', company: 'Souza Ltda', value: 1000, qty: 2, due: at(2026, 10, 21), stage: 'a', hot: true },
  { id: 2, name: 'beta', company: '', value: 250.5, qty: 10, due: at(2026, 10, 10), stage: 'w', hot: false },
  { id: 3, name: 'Gama', company: 'Souza & Cia', value: null, qty: 1, due: at(2026, 11, 3), stage: 'a', hot: false },
  { id: 4, name: 'delta', company: 'Pereira', value: 99999, qty: null, due: null, stage: null, hot: true },
];
const ids = (rows) => rows.map((r) => r.id);
const F = (col, op, value, to) => ({ col, op, value, to });
const run = (filters) => ids(applyFilters(ROWS, filters, COLS, {}, NOW));

test('texto: contém, não contém, igual, vazio — sem acento e sem caixa', () => {
  assert.deepEqual(run([F('name', 'contains', 'acao')]), [1], 'sem acento');
  assert.deepEqual(run([F('company', 'contains', 'souza')]), [1, 3]);
  assert.deepEqual(run([F('company', 'notContains', 'souza')]), [2, 4]);
  assert.deepEqual(run([F('name', 'equals', 'BETA')]), [2]);
  assert.deepEqual(run([F('company', 'empty')]), [2]);
  assert.deepEqual(run([F('company', 'notEmpty')]), [1, 3, 4]);
  assert.deepEqual(run([F('name', 'contains', '')]), [1, 2, 3, 4], 'filtro sem valor não restringe');
});

test('número e dinheiro: maior, menor, igual, entre (em qualquer ordem) e vazio; valor nulo nunca passa em comparação', () => {
  assert.deepEqual(run([F('value', 'gt', 500)]), [1, 4]);
  assert.deepEqual(run([F('value', 'lt', 500)]), [2], 'nulo não é menor que nada');
  assert.deepEqual(run([F('value', 'eq', 250.5)]), [2]);
  assert.deepEqual(run([F('value', 'between', 200, 1000)]), [1, 2]);
  assert.deepEqual(run([F('value', 'between', 1000, 200)]), [1, 2], 'entre 1000 e 200 = entre 200 e 1000');
  assert.deepEqual(run([F('value', 'empty')]), [3]);
  assert.deepEqual(run([F('qty', 'gt', '1')]), [1, 2], 'valor digitado como texto');
  assert.deepEqual(run([F('qty', 'gt', '')]), [1, 2, 3, 4]);
  assert.deepEqual(run([F('qty', 'between', 1, undefined)]), [1, 2, 3, 4], 'faixa incompleta não restringe');
});

test('data: hoje, últimos 7/30 dias, neste mês, já passou, ainda vai chegar, antes/depois de, vazio', () => {
  assert.deepEqual(run([F('due', 'today')]), [1]);
  assert.deepEqual(run([F('due', 'last7')]), [1], '10/10 está fora dos 7 dias');
  assert.deepEqual(run([F('due', 'last30')]), [1, 2]);
  assert.deepEqual(run([F('due', 'thisMonth')]), [1, 2]);
  assert.deepEqual(run([F('due', 'overdue')]), [2]);
  assert.deepEqual(run([F('due', 'future')]), [3]);
  assert.deepEqual(run([F('due', 'before', '2026-10-21')]), [2]);
  assert.deepEqual(run([F('due', 'after', '2026-10-21')]), [3]);
  assert.deepEqual(run([F('due', 'after', 'lixo')]), [1, 2, 3], 'data inválida não restringe (sem prazo continua de fora)');
  assert.deepEqual(run([F('due', 'empty')]), [4]);
  assert.deepEqual(run([F('due', 'notEmpty')]), [1, 2, 3]);
  assert.equal(Number.isNaN(parseDay('2026-02-31')), true);
  assert.equal(parseDay('2026-02-28'), new Date(2026, 1, 28).getTime());
});

test('parseNumber: pt-BR e ponto decimal; ambíguo ou lixo é inválido', () => {
  const { parseNumber } = M;
  assert.equal(parseNumber('1.500,50'), 1500.5);
  assert.equal(parseNumber('R$ 1.200'), 1200);
  assert.equal(parseNumber('1500'), 1500);
  assert.equal(parseNumber('1500.5'), 1500.5);
  assert.equal(parseNumber('0,5'), 0.5);
  assert.equal(parseNumber('-3'), -3);
  for (const bad of ['', '  ', 'abc', '1,234.50', '1.2.3', '12a']) assert.equal(Number.isNaN(parseNumber(bad)), true, `"${bad}" é inválido`);
});

test('enum e booleano; vários filtros somam (E); coluna desconhecida é ignorada', () => {
  assert.deepEqual(run([F('stage', 'is', 'a')]), [1, 3]);
  assert.deepEqual(run([F('stage', 'isNot', 'a')]), [2, 4]);
  assert.deepEqual(run([F('stage', 'empty')]), [4]);
  assert.deepEqual(run([F('hot', 'yes')]), [1, 4]);
  assert.deepEqual(run([F('hot', 'no')]), [2, 3]);
  assert.deepEqual(run([F('stage', 'is', 'a'), F('hot', 'yes')]), [1]);
  assert.deepEqual(run([F('naoexiste', 'contains', 'x')]), [1, 2, 3, 4]);
  assert.deepEqual(applyFilters(ROWS, [], COLS, {}, NOW), ROWS);
  assert.deepEqual(applyFilters(ROWS, null, COLS, {}, NOW), ROWS);
});

test('busca livre: todas as palavras em alguma coluna pesquisável; sem acento', () => {
  assert.deepEqual(ids(searchRows(ROWS, 'souza gama', COLS, {})), [3]);
  assert.deepEqual(ids(searchRows(ROWS, 'acao souza', COLS, {})), [1]);
  assert.deepEqual(ids(searchRows(ROWS, 'zzz', COLS, {})), []);
  assert.deepEqual(ids(searchRows(ROWS, '  ', COLS, {})), [1, 2, 3, 4]);
  assert.deepEqual(ids(searchRows(ROWS, '250', COLS, {})), [], 'só colunas marcadas com search');
});

test('ordenação: texto natural sem acento, número, data; vazios sempre por último; estável', () => {
  const sorted = (sort) => ids(sortRows(ROWS, sort, COLS, {}));
  assert.deepEqual(sorted({ col: 'name', dir: 'asc' }), [1, 2, 4, 3], 'Ação, beta, delta, Gama');
  assert.deepEqual(sorted({ col: 'name', dir: 'desc' }), [3, 4, 2, 1]);
  assert.deepEqual(sorted({ col: 'value', dir: 'asc' }), [2, 1, 4, 3], 'nulo por último');
  assert.deepEqual(sorted({ col: 'value', dir: 'desc' }), [4, 1, 2, 3], 'nulo por último também no decrescente');
  assert.deepEqual(sorted({ col: 'due', dir: 'asc' }), [2, 1, 3, 4]);
  assert.deepEqual(sorted(null), [1, 2, 3, 4]);
  assert.deepEqual(sorted({ col: 'naoexiste', dir: 'asc' }), [1, 2, 3, 4]);
  const bySortValue = [{ id: 1, k: 'z-id', label: 'Ana' }, { id: 2, k: 'a-id', label: 'Zeca' }];
  const colSV = [{ id: 'k', type: 'enum', get: (r) => r.k, sortValue: (r) => r.label }];
  assert.deepEqual(ids(sortRows(bySortValue, { col: 'k', dir: 'asc' }, colSV, {})), [1, 2], 'ordena pelo rótulo (sortValue), não pelo id filtrado');
  const nat = [{ id: 'a', name: 'Item 10' }, { id: 'b', name: 'Item 2' }];
  assert.deepEqual(ids(sortRows(nat, { col: 'name', dir: 'asc' }, COLS, {})), ['b', 'a'], '2 antes de 10');
});

test('runList junta busca + filtros + ordenação; estado normalizado descarta colunas que sumiram', () => {
  const st = { columns: [], sort: { col: 'value', dir: 'desc' }, filters: [F('stage', 'is', 'a')], q: 'souza' };
  assert.deepEqual(ids(runList(ROWS, st, COLS, {}, NOW)), [1, 3]);
  const n = normalizeState({ columns: ['name', 'sumiu', 'value'], sort: { col: 'sumiu', dir: 'asc' }, filters: [F('sumiu', 'is', 'x'), F('stage', 'is', 'a'), { col: 'stage' }], q: 5 }, COLS);
  assert.deepEqual(n, { columns: ['name', 'value'], sort: null, filters: [F('stage', 'is', 'a')], q: '5' });
  assert.deepEqual(defaultState(COLS).columns, ['name', 'company', 'value'], 'padrão: as colunas visíveis');
  assert.deepEqual(defaultState(COLS, { sort: { col: 'value', dir: 'desc' } }).sort, { col: 'value', dir: 'desc' });
});

test('rótulos dos filtros para os chips', () => {
  assert.equal(describeFilter(F('value', 'gt', 1000), COLS, {}), 'Valor maior que 1000');
  assert.equal(describeFilter(F('stage', 'is', 'w'), COLS, {}), 'Etapa é Ganha');
  assert.equal(describeFilter(F('due', 'before', '2026-10-21'), COLS, {}), 'Prazo antes de 21/10/2026');
  assert.equal(describeFilter(F('company', 'empty'), COLS, {}), 'Empresa está vazio');
  assert.equal(describeFilter(F('qty', 'between', 1, 5), COLS, {}), 'Qtd entre 1 e 5');
  assert.equal(describeFilter(F('naoexiste', 'is', 1), COLS, {}), '');
  assert.ok(opsOf({ type: 'bool' }).every((o) => o.noValue));
  assert.equal(matchFilter(F('x', 'contains', 'a'), 'abc', { type: 'texto-estranho' }), true, 'tipo desconhecido não restringe');
});

test('visões salvas: fábrica fixa, salvar/sobrescrever por nome, lembrar a última, apagar só as suas e tolerar armazenamento quebrado', () => {
  const mem = new Map();
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v) };
  const builtins = [{ id: 'all', name: 'Todos', state: { columns: ['name'], sort: null, filters: [], q: '' } }];
  const vs = makeViewsStore(storage, 'deals', builtins);
  assert.deepEqual(vs.all().map((v) => [v.id, !!v.builtin]), [['all', true]]);
  const v1 = vs.save('  Quentes  ', { columns: ['name'], sort: null, filters: [F('hot', 'yes')], q: '' });
  assert.equal(v1.name, 'Quentes');
  assert.equal(vs.last(), v1.id);
  const again = vs.save('quentes', { columns: ['name', 'value'], sort: null, filters: [], q: 'x' });
  assert.equal(again.id, v1.id, 'mesmo nome (sem acento/caixa) sobrescreve');
  assert.equal(vs.all().length, 2);
  assert.deepEqual(vs.get(v1.id).state.columns, ['name', 'value']);
  assert.equal(vs.save('   ', {}), null, 'sem nome não salva');
  assert.equal(vs.remove('all'), false, 'visão de fábrica não se apaga');
  assert.equal(vs.remove(v1.id), true);
  assert.equal(vs.last(), null);
  assert.equal(vs.get(v1.id), null);
  // outra lista não se mistura
  makeViewsStore(storage, 'contacts', []).save('A', { columns: [] });
  assert.equal(vs.all().length, 1);
  // armazenamento corrompido ou sem escrita
  mem.set('ttf:views:deals', '{lixo');
  assert.deepEqual(vs.all().map((v) => v.id), ['all']);
  assert.doesNotThrow(() => makeViewsStore({ getItem() { throw new Error('x'); }, setItem() { throw new Error('y'); } }, 'x', []).save('n', { columns: [] }));
});
