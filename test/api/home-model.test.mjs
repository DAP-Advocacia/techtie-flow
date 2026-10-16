import { test } from 'node:test';
import assert from 'node:assert/strict';
const { greeting, summarizeHome, replyNow } = await import('../../public/js/screens/home/model.js');

test('saudação pela hora local', () => {
  const at = (h) => greeting(new Date(2026, 9, 16, h, 0));
  assert.deepEqual([at(2), at(8), at(14), at(19)], ['Boa noite', 'Bom dia', 'Boa tarde', 'Boa noite']);
});

test('resumo: não lidas, fila, minhas (sem resolvidas), negócios abertos e valor', () => {
  const kind = { s1: 'open', s2: 'open', won: 'won', lost: 'lost' };
  const s = summarizeHome({
    conversations: [
      { unread: 2, status: 'queue', assigneeId: null },
      { unread: 1, status: 'open', assigneeId: 'me' },
      { unread: 0, status: 'resolved', assigneeId: 'me' },
      { unread: 0, status: 'open', assigneeId: 'outro' },
    ],
    deals: [{ stageId: 's1', value: 1000 }, { stageId: 's2', value: '500.5' }, { stageId: 'won', value: 9999 }, { stageId: 'lost', value: 1 }],
    stageKind: (id) => kind[id],
    meId: 'me',
  });
  assert.deepEqual(s, { unread: 3, queue: 1, mine: 1, openDeals: 2, openValue: 1500.5 });
});

test('valor oculto pelo perfil vira null (nunca um 0 que pareça verdadeiro) e lista vazia não quebra', () => {
  assert.equal(summarizeHome({ deals: [{ stageId: 'a', value: 5 }], valueHidden: true }).openValue, null);
  assert.deepEqual(summarizeHome({}), { unread: 0, queue: 0, mine: 0, openDeals: 0, openValue: 0 });
});

test('"responder agora": só com não lidas e não resolvidas, mais recente primeiro, com limite', () => {
  const list = [
    { id: 'a', unread: 1, status: 'open', lastMessageAt: 10 },
    { id: 'b', unread: 3, status: 'queue', lastMessageAt: 30 },
    { id: 'c', unread: 0, status: 'open', lastMessageAt: 99 },
    { id: 'd', unread: 2, status: 'resolved', lastMessageAt: 50 },
    { id: 'e', unread: 1, status: 'open', lastMessageAt: 20 },
  ];
  assert.deepEqual(replyNow(list).map((c) => c.id), ['b', 'e', 'a']);
  assert.deepEqual(replyNow(list, 1).map((c) => c.id), ['b']);
});
