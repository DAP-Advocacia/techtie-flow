// Início: "Fechando este mês" e meta de receita do mês (modelo puro).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { closingThisMonth, monthGoal } = await import('../../public/js/screens/home/model.js');
const NOW = new Date(2026, 9, 21, 15, 0); // 21/10/2026 (mês com 31 dias)
const ts = (y, m, d) => new Date(y, m - 1, d, 12).getTime();

test('fechando este mês: só abertos com previsão no mês, do mais próximo ao mais distante; conta atrasados e meses anteriores', () => {
  const kind = { a: 'open', w: 'won', l: 'lost' };
  const deals = [
    { id: 'x1', stageId: 'a', value: 100, expectedClose: '2026-10-30' },
    { id: 'x2', stageId: 'a', value: 300, expectedClose: '2026-10-05' }, // já passou, segue aberto
    { id: 'x3', stageId: 'a', value: 50, expectedClose: '2026-10-21' }, // hoje: não é atraso
    { id: 'x4', stageId: 'a', value: 70, expectedClose: '2026-11-01' }, // mês seguinte
    { id: 'x5', stageId: 'a', value: 80, expectedClose: '2026-09-28' }, // mês anterior: só conta
    { id: 'x6', stageId: 'w', value: 999, expectedClose: '2026-10-10' }, // ganho: fora
    { id: 'x7', stageId: 'l', value: 999, expectedClose: '2026-10-11' }, // perdido: fora
    { id: 'x8', stageId: 'a', value: 5, expectedClose: null },
    { id: 'x9', stageId: 'a', value: 5, expectedClose: '2026-02-31' }, // data impossível: ignora
    { id: 'xa', stageId: 'a', value: 200, expectedClose: '2026-10-30' }, // empate de data: maior valor primeiro
  ];
  const r = closingThisMonth({ deals, stageKind: (id) => kind[id], now: NOW });
  assert.deepEqual(r.rows.map((x) => x.deal.id), ['x2', 'x3', 'xa', 'x1']);
  assert.deepEqual(r.rows.map((x) => x.late), [true, false, false, false]);
  assert.equal(r.count, 4);
  assert.equal(r.late, 1);
  assert.equal(r.overdueBefore, 1);
  assert.equal(r.total, 650);
  assert.equal(closingThisMonth({ deals, stageKind: (id) => kind[id], now: NOW, valueHidden: true }).total, null, 'valor oculto: sem total (nunca 0)');
  assert.deepEqual(closingThisMonth({}), { rows: [], count: 0, late: 0, overdueBefore: 0, total: 0, weighted: 0 });
  // previsão ponderada: valor × probabilidade da etapa de cada negócio (etapa sem probabilidade conta 0)
  const prob = { a: 50, b: 20 };
  const w = closingThisMonth({ deals: [{ stageId: 'a', value: 1000, expectedClose: '2026-10-30' }, { stageId: 'b', value: 500, expectedClose: '2026-10-25' }, { stageId: 'zz', value: 999, expectedClose: '2026-10-26' }], stageKind: () => 'open', probability: (id) => prob[id], now: NOW });
  assert.equal(w.total, 2499);
  assert.equal(w.weighted, 600, '1000×50% + 500×20% + 999×0%');
  assert.equal(closingThisMonth({ deals: [{ stageId: 'a', value: 1000, expectedClose: '2026-10-30' }], probability: () => 50, now: NOW, valueHidden: true }).weighted, null, 'valor oculto: sem previsão');
});

test('meta do mês: soma só os ganhos deste mês, % da meta, o que falta, dias restantes e ritmo', () => {
  const kind = { a: 'open', w: 'won', l: 'lost' };
  const deals = [
    { stageId: 'w', value: 40000, stageChangedAt: ts(2026, 10, 3) },
    { stageId: 'w', value: 20000, stageChangedAt: ts(2026, 10, 20) },
    { stageId: 'w', value: 99999, stageChangedAt: ts(2026, 9, 30) }, // mês passado
    { stageId: 'w', value: 99999, stageChangedAt: ts(2026, 11, 1) }, // futuro (relógio torto): fora
    { stageId: 'l', value: 5000, stageChangedAt: ts(2026, 10, 4) }, // perdido não conta
    { stageId: 'a', value: 7000, stageChangedAt: ts(2026, 10, 4) }, // aberto não conta
    { stageId: 'w', value: 1, stageChangedAt: null }, // sem data de mudança: fora
  ];
  const m = monthGoal({ deals, stageKind: (id) => kind[id], goal: 100000, now: NOW });
  assert.equal(m.won, 60000);
  assert.equal(m.goal, 100000);
  assert.equal(m.pct, 0.6);
  assert.equal(m.remaining, 40000);
  assert.equal(m.daysLeft, 10, '21 → 31 de outubro');
  assert.equal(m.onTrack, false, 'ritmo linear do dia 21 de 31 = 67.741');
  assert.equal(monthGoal({ deals, stageKind: (id) => kind[id], goal: 80000, now: NOW }).onTrack, true);
  assert.equal(monthGoal({ deals, stageKind: (id) => kind[id], goal: 50000, now: NOW }).remaining, 0, 'meta batida: nada falta');
  assert.ok(monthGoal({ deals, stageKind: (id) => kind[id], goal: 50000, now: NOW }).pct > 1, 'passa de 100%');
});

test('meta do mês: sem meta definida mostra o ganho e nada mais; valor oculto = null; último dia do mês = 0 dias', () => {
  const kind = { w: 'won' };
  const one = [{ stageId: 'w', value: 10, stageChangedAt: ts(2026, 10, 2) }];
  for (const none of [null, undefined, 0, '', 'abc', -5]) {
    assert.deepEqual(monthGoal({ deals: one, stageKind: (id) => kind[id], goal: none, now: NOW }), { goal: null, won: 10, pct: null, remaining: null, daysLeft: 10, onTrack: null });
  }
  assert.equal(monthGoal({ deals: one, stageKind: (id) => kind[id], goal: 100, now: NOW, valueHidden: true }), null);
  assert.equal(monthGoal({ deals: one, stageKind: (id) => kind[id], goal: 100, now: new Date(2026, 9, 31, 20, 0) }).daysLeft, 0);
  assert.equal(monthGoal({ deals: [], goal: 100, now: new Date(2028, 1, 29) }).daysLeft, 0, 'fevereiro bissexto');
});
