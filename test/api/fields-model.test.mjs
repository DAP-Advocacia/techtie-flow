// Data, hora e busca de contato em pt-BR (public/js/fields/model.js) + duração legível do Dashboard.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const M = await import('../../public/js/fields/model.js');
await import('../ui/dom-env.mjs'); // registra o carregador de /shared
const { fmtSecs } = await import('../../public/js/screens/dashboard/model.js');

test('máscara de data: só números, barras sozinhas, até 8 dígitos', () => {
  assert.equal(M.maskDate('2'), '2');
  assert.equal(M.maskDate('231'), '23/1');
  assert.equal(M.maskDate('23102026'), '23/10/2026');
  assert.equal(M.maskDate('23/10/2026 xx 99'), '23/10/2026');
  assert.equal(M.maskDate(''), '');
});

test('dd/mm/aaaa ⇄ aaaa-mm-dd; dia que não existe e data incompleta viram vazio', () => {
  assert.equal(M.isoFromBr('23/10/2026'), '2026-10-23');
  assert.equal(M.isoFromBr('29/02/2028'), '2028-02-29', 'ano bissexto');
  assert.equal(M.isoFromBr('29/02/2027'), '');
  assert.equal(M.isoFromBr('31/04/2026'), '');
  assert.equal(M.isoFromBr('23/10/26'), '');
  assert.equal(M.isoFromBr('23/10/1850'), '');
  assert.equal(M.brFromIso('2026-10-23'), '23/10/2026');
  assert.equal(M.brFromIso(''), '');
});

test('hora de 24 h: máscara e validação', () => {
  assert.equal(M.maskTime('0930'), '09:30');
  assert.equal(M.maskTime('9'), '9');
  assert.equal(M.cleanTime('09:30'), '09:30');
  assert.equal(M.cleanTime('9:30'), '09:30');
  assert.equal(M.cleanTime('0930'), '09:30');
  assert.equal(M.cleanTime('24:00'), '');
  assert.equal(M.cleanTime('12:60'), '');
  assert.equal(M.cleanTime('às 9'), '');
});

test('telefone legível: celular, fixo e outros países', () => {
  assert.equal(M.prettyPhone('+5511987654321'), '+55 11 98765-4321');
  assert.equal(M.prettyPhone('551134567890'), '+55 11 3456-7890');
  assert.equal(M.prettyPhone('14155550123'), '+14155550123');
  assert.equal(M.prettyPhone(''), '');
  assert.equal(M.nameIsPhone({ name: '+55 11 98765-4321' }), true);
  assert.equal(M.nameIsPhone({ name: '5511987654321' }), true);
  assert.equal(M.nameIsPhone({ name: 'Ana 2' }), false);
});

const CONTACTS = [
  { id: 'a', name: 'Ana Souza', company: 'Acme', phone: '+5511987654321', email: 'ana@acme.com' },
  { id: 'b', name: 'Bruno Alves', company: 'Beta Ltda', phone: '+5521999990000', email: 'bruno@beta.com' },
  { id: 'c', name: 'Cláudia Souza', company: '', phone: '+5531988887777', email: '' },
  { id: 'd', name: '+55 11 90000-1111', company: '', phone: '+5511900001111', email: '' },
];

test('busca de contato: nome sem acento, empresa, e-mail e telefone em qualquer pedaço (com ou sem máscara)', () => {
  const ids = (q) => M.searchContacts(CONTACTS, q).items.map((c) => c.id);
  assert.deepEqual(ids('claudia'), ['c'], 'sem acento');
  assert.deepEqual(ids('acme'), ['a']);
  assert.deepEqual(ids('beta.com'), ['b']);
  assert.deepEqual(ids('98765'), ['a'], 'pedaço do telefone');
  assert.deepEqual(ids('11 90000'), ['d'], 'mais de um termo: todos precisam aparecer');
  assert.deepEqual(ids('souza'), ['a', 'c']);
  assert.deepEqual(ids('zzz'), []);
  assert.equal(M.searchContacts(CONTACTS, '').total, 4, 'sem termo: todos, em ordem de nome');
});

test('busca de contato: quem COMEÇA com o termo vem antes, e o limite corta a lista mas conta o total', () => {
  const list = [
    { id: '1', name: 'Maria Ana', phone: '' },
    { id: '2', name: 'Ana Maria', phone: '' },
  ];
  assert.deepEqual(M.searchContacts(list, 'ana').items.map((c) => c.id), ['2', '1']);
  const many = Array.from({ length: 120 }, (_, i) => ({ id: `x${i}`, name: `Pessoa ${String(i).padStart(3, '0')}`, phone: '' }));
  const r = M.searchContacts(many, 'pessoa', 40);
  assert.equal(r.items.length, 40);
  assert.equal(r.total, 120);
});

test('duração do Dashboard: segundos, minutos, horas e dias (nada de “9829m 38s”)', () => {
  assert.equal(fmtSecs(8), '8s');
  assert.equal(fmtSecs(130), '2m 10s');
  assert.equal(fmtSecs(182), '3m 02s');
  assert.equal(fmtSecs(7500), '2h 05min');
  assert.equal(fmtSecs(9829 * 60 + 38), '6d 19h');
  assert.equal(fmtSecs(null), '—');
});
