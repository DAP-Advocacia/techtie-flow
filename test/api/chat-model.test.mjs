// Chat interno: modelo puro (títulos, prévias, não lidas, agrupamento por dia e por pessoa, grupo).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const M = await import('../../public/js/screens/inbox/chat/model.js');
const { dmKey, peerOf, roomTitle, previewOf, unreadOf, sortRooms, matchRoom, dayLabel, groupMessages, validateGroup, cleanDraft } = M;
const names = { me: 'Marina Alves', a: 'Ana Souza', b: 'Bia Martins' };
const nameOf = (id) => names[id];
const NOW = new Date(2026, 9, 21, 15, 0).getTime();
const at = (d, h = 10, m = 0) => new Date(2026, 9, d, h, m).getTime();

test('chave da conversa direta é a mesma nas duas pontas; título e a outra pessoa', () => {
  assert.equal(dmKey('b', 'a'), dmKey('a', 'b'));
  const dm = { kind: 'dm', members: ['me', 'a'] };
  assert.equal(peerOf(dm, 'me'), 'a');
  assert.equal(peerOf(dm, 'a'), 'me');
  assert.equal(roomTitle(dm, 'me', nameOf), 'Ana Souza');
  assert.equal(roomTitle({ kind: 'dm', members: ['me', 'zz'] }, 'me', nameOf), 'Pessoa removida');
  assert.equal(roomTitle({ kind: 'group', name: 'Comercial', members: [] }, 'me', nameOf), 'Comercial');
  assert.equal(peerOf({ kind: 'group', members: ['me', 'a'] }, 'me'), null);
});

test('prévia: "Você:", nome em grupo, texto puro na direta e salas sem mensagem', () => {
  const dm = { kind: 'dm', members: ['me', 'a'], lastBody: 'Fechado!', lastAuthorId: 'a' };
  assert.equal(previewOf(dm, 'me', nameOf), 'Fechado!');
  assert.equal(previewOf({ ...dm, lastAuthorId: 'me' }, 'me', nameOf), 'Você: Fechado!');
  assert.equal(previewOf({ kind: 'group', members: [], lastBody: 'Bom dia', lastAuthorId: 'b' }, 'me', nameOf), 'Bia: Bom dia');
  assert.equal(previewOf({ kind: 'group', members: [], lastBody: '' }, 'me', nameOf), 'Grupo criado');
  assert.equal(previewOf({ kind: 'dm', members: [], lastBody: '' }, 'me', nameOf), 'Nenhuma mensagem ainda');
});

test('não lidas: o servidor manda o número; no protótipo conta pela marca de leitura e ignora as próprias', () => {
  assert.equal(unreadOf({ unread: 3 }, 'me'), 3);
  assert.equal(unreadOf({}, 'me'), 0);
  const msgs = [{ at: 100, authorId: 'a' }, { at: 200, authorId: 'me' }, { at: 300, authorId: 'a' }, { at: 400, authorId: 'b' }];
  assert.equal(unreadOf({ reads: { me: 150 } }, 'me', msgs), 2, 'depois de 150, só as dos outros');
  assert.equal(unreadOf({ reads: {} }, 'me', msgs), 3);
  assert.equal(unreadOf({ reads: { me: 999 } }, 'me', msgs), 0);
});

test('ordenar salas: mais recente primeiro; sem mensagem no fim, por nome; busca sem acento', () => {
  const r = [{ id: 1, name: 'Zeta' }, { id: 2, name: 'Alfa', lastAt: 50 }, { id: 3, name: 'Ágata' }, { id: 4, name: 'Beta', lastAt: 90 }];
  assert.deepEqual(sortRooms(r).map((x) => x.id), [4, 2, 3, 1]);
  assert.equal(matchRoom('João Pereira', 'joao'), true);
  assert.equal(matchRoom('João Pereira', 'zzz'), false);
  assert.equal(matchRoom('João', '   '), true);
});

test('rótulo do dia: Hoje, Ontem, data por extenso (com ano se for de outro ano)', () => {
  assert.equal(dayLabel(at(21, 9), NOW), 'Hoje');
  assert.equal(dayLabel(at(20, 23), NOW), 'Ontem');
  assert.match(dayLabel(at(3), NOW), /3 de outubro/);
  assert.match(dayLabel(new Date(2025, 11, 25).getTime(), NOW), /25 de dezembro de 2025/);
});

test('agrupar mensagens: separador de dia; blocos da mesma pessoa até 5 min; troca de pessoa ou pausa abre bloco', () => {
  const msgs = [
    { id: 1, authorId: 'a', at: at(20, 10, 0) },
    { id: 2, authorId: 'a', at: at(20, 10, 2) }, // mesmo bloco
    { id: 3, authorId: 'a', at: at(20, 10, 30) }, // pausa longa: novo bloco
    { id: 4, authorId: 'me', at: at(20, 10, 31) }, // outra pessoa
    { id: 5, authorId: 'me', at: at(21, 9, 0) }, // outro dia
  ];
  const g = groupMessages(msgs, NOW);
  assert.deepEqual(g.map((x) => (x.type === 'day' ? `dia:${x.label}` : `m${x.msg.id}${x.first ? '^' : ''}${x.last ? '$' : ''}`)), ['dia:Ontem', 'm1^', 'm2$', 'm3^$', 'm4^$', 'dia:Hoje', 'm5^$']);
  assert.deepEqual(groupMessages([], NOW), []);
});

test('grupo: nome, pessoas e limite; rascunho limpo', () => {
  assert.equal(validateGroup('Comercial', ['a']), '');
  assert.match(validateGroup('  ', ['a']), /nome/);
  assert.match(validateGroup('x'.repeat(81), ['a']), /80/);
  assert.match(validateGroup('Comercial', []), /mais uma pessoa/);
  assert.match(validateGroup('Comercial', Array.from({ length: 50 }, (_, i) => `u${i}`)), /no máximo 50/);
  assert.equal(cleanDraft('  oi\r\ntudo bem?  '), 'oi\ntudo bem?');
  assert.equal(cleanDraft('   '), '');
});
