// Funis configuráveis: regras das etapas, nomes, motivos de perda e previsão ponderada (modelo puro).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const M = await import('../../public/js/screens/funnels/model.js');
const { defaultStages, normalizeStages, validateStages, validatePipelineName, cleanReasons, validateReasons, moveItem, weightedValue, spread, SUGGESTED_REASONS } = M;

test('etapas padrão de um funil novo: 3 abertas espalhadas (25/50/75), ganho 100 e perdido 0', () => {
  assert.deepEqual(defaultStages().map((s) => [s.name, s.kind, s.probability]), [['Novo', 'open', 25], ['Qualificação', 'open', 50], ['Proposta', 'open', 75], ['Ganho', 'won', 100], ['Perdido', 'lost', 0]]);
  assert.deepEqual([spread(0, 2), spread(1, 2)], [33, 67]);
  assert.equal(validateStages(defaultStages()), '');
});

test('normalizar: ganho vira 100, perdido 0, aberta fica inteira entre 0 e 100; tipo estranho vira aberta; nome sem espaços sobrando', () => {
  const n = normalizeStages([{ name: '  Em   análise ', kind: 'open', probability: 60.6 }, { name: 'G', kind: 'won', probability: 7 }, { name: 'P', kind: 'lost', probability: 90 }, { name: 'X', kind: 'nada', probability: 150 }, { name: 'Y', kind: 'open', probability: 'abc' }, { name: 'Z', kind: 'open', probability: -5 }]);
  assert.deepEqual(n.map((s) => [s.name, s.kind, s.probability]), [['Em análise', 'open', 61], ['G', 'won', 100], ['P', 'lost', 0], ['X', 'open', 100], ['Y', 'open', 0], ['Z', 'open', 0]]);
});

test('validar etapas: de 3 a 30, nome, probabilidade e os três tipos presentes', () => {
  const ok = defaultStages();
  assert.equal(validateStages(ok), '');
  assert.match(validateStages(ok.slice(0, 2)), /de 3 a 30/);
  assert.match(validateStages(Array.from({ length: 31 }, () => ok[0])), /de 3 a 30/);
  assert.match(validateStages([{ ...ok[0], name: '   ' }, ...ok.slice(1)]), /Dê um nome à etapa 1/);
  assert.match(validateStages([{ ...ok[0], name: 'x'.repeat(201) }, ...ok.slice(1)]), /200 caracteres/);
  assert.match(validateStages([{ ...ok[0], probability: 101 }, ...ok.slice(1)]), /entre 0 e 100/);
  assert.match(validateStages([{ ...ok[0], probability: '' }, ...ok.slice(1)]), /entre 0 e 100/);
  assert.match(validateStages([ok[0], ok[1], ok[2], ok[3], { ...ok[4], kind: 'won' }]), /etapa perdida/);
  assert.match(validateStages([ok[0], ok[1], ok[2], ok[4], { ...ok[4], name: 'Perdido 2' }]), /etapa ganha/);
  assert.match(validateStages([ok[3], ok[4], { ...ok[4], name: 'Outra' }]), /em andamento/);
  assert.match(validateStages(null), /de 3 a 30/);
});

test('nome do funil: obrigatório, sem repetir outro (caixa e acento não contam)', () => {
  assert.equal(validatePipelineName('Pós-venda', ['Comercial']), '');
  assert.match(validatePipelineName('   '), /Informe o nome/);
  assert.match(validatePipelineName('x'.repeat(201)), /200 caracteres/);
  assert.match(validatePipelineName(' COMERCIAL ', ['Comercial']), /Já existe/);
  assert.match(validatePipelineName('Pos-venda', ['Pós-venda']), /Já existe/);
});

test('motivos de perda: limpar tira vazios e repetidos; validar avisa o resto', () => {
  assert.deepEqual(cleanReasons([' Preço ', 'preço', '', '  ', 'Sem  resposta']), ['Preço', 'Sem resposta']);
  assert.equal(validateReasons(['A', 'B']), '');
  assert.match(validateReasons(['A', 'a']), /repetidos/);
  assert.match(validateReasons(['x'.repeat(81)]), /80 caracteres/);
  assert.match(validateReasons(Array.from({ length: 31 }, (_, i) => `m${i}`)), /Até 30/);
  assert.equal(validateReasons([]), '');
  assert.ok(SUGGESTED_REASONS.every((r) => r.length <= 80) && validateReasons(SUGGESTED_REASONS) === '');
});

test('reordenar e previsão ponderada', () => {
  assert.deepEqual(moveItem(['a', 'b', 'c'], 0, 2), ['b', 'c', 'a']);
  assert.deepEqual(moveItem(['a', 'b', 'c'], 2, 1), ['a', 'c', 'b']);
  const same = ['a', 'b'];
  assert.equal(moveItem(same, 0, 5), same);
  assert.equal(moveItem(same, -1, 0), same);
  assert.equal(weightedValue(1000, 25), 250);
  assert.equal(weightedValue('18400', 33), 6072);
  assert.equal(weightedValue(100, 150), 100, 'probabilidade acima de 100 não passa do valor');
  assert.equal(weightedValue(100, 'x'), 0);
  assert.equal(weightedValue(null, 50), 0, 'sem valor, nada a ponderar');
  assert.equal(weightedValue(undefined, 50), null);
  assert.equal(weightedValue('abc', 50), null);
});
