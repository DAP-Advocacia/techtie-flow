// Campos pt-BR no DOM simulado: data dd/mm/aaaa, hora de 24 h e busca de contato (public/js/fields).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, fire, $, $$, text } from './dom-env.mjs';

installDom();
const { dateField, timeField, contactField } = await import('../../public/js/fields/index.js');

// digitar de verdade: escreve o texto cru do <input> (o campo de hora troca o `value` do elemento por um que já limpa)
const rawSet = (el, v) => {
  let p = Object.getPrototypeOf(el);
  while (p && !Object.getOwnPropertyDescriptor(p, 'value')) p = Object.getPrototypeOf(p);
  Object.getOwnPropertyDescriptor(p, 'value').set.call(el, v);
};
const type = (input, v) => {
  rawSet(input, v);
  fire(input, 'input');
};
const count = (el) => {
  let n = 0;
  el.addEventListener('change', () => n++);
  return () => n;
};

test('data: o usuário vê dd/mm/aaaa, o valor sai ISO e o change só dispara com data real', () => {
  const f = dateField({ label: 'Prazo', value: '2026-10-23' });
  const t = $(f, '.datefield__text');
  assert.equal(t.value, '23/10/2026', 'nunca mm/dd/aaaa');
  assert.equal(f.value, '2026-10-23');
  const changes = count(f);
  type(t, '15');
  assert.equal(t.value, '15');
  assert.equal(f.value, '', 'incompleta não vale');
  type(t, '15/1');
  type(t, '15012027');
  assert.equal(t.value, '15/01/2027', 'a máscara põe as barras');
  assert.equal(f.value, '2027-01-15');
  assert.equal(changes(), 1);
  type(t, '31/02/2027');
  assert.equal(f.value, '', 'dia que não existe');
  assert.equal(t.getAttribute('aria-invalid'), 'true');
  type(t, '');
  assert.equal(changes(), 2, 'apagar tudo também avisa');
  f.value = '2028-02-29';
  assert.equal(t.value, '29/02/2028', 'atribuir mostra no formato brasileiro');
  assert.equal(t.hasAttribute('aria-invalid'), false);
  f.disabled = true;
  assert.equal(t.disabled, true);
});

test('hora: 24 h com máscara; 9:30 vira 09:30; hora que não existe fica sem valor', () => {
  const f = timeField({ label: 'Hora', value: '14:05' });
  assert.equal(f.value, '14:05');
  const changes = count(f);
  type(f, '0930');
  assert.equal(f.value, '09:30');
  assert.equal(changes(), 1);
  type(f, '2561');
  assert.equal(f.value, '');
  assert.equal(f.getAttribute('aria-invalid'), 'true');
  type(f, '');
  f.value = '8:5';
  assert.equal(f.value, '', 'incompleta');
  f.value = '18:45';
  assert.equal(f.value, '18:45');
});

const CONTACTS = [
  { id: 'a', name: 'Ana Souza', company: 'Acme', phone: '+5511987654321', email: 'ana@acme.com' },
  { id: 'b', name: 'Bruno Alves', company: 'Beta', phone: '+5521999990000', email: '' },
  { id: 'd', name: '+55 11 90000-1111', company: '', phone: '+5511900001111', email: '' },
];
const rows = (f) => $$(f, '.combo__opt');
const names = (f) => rows(f).map((r) => text($(r, '.combo__name')));
const pickRow = (f, label) => fire(rows(f).find((r) => text(r).includes(label)), 'mousedown');

test('contato: busca por nome, telefone ou e-mail; escolher dispara change e mostra o nome', () => {
  const f = contactField({ contacts: CONTACTS, label: 'Contato' });
  const input = $(f, 'input');
  const changes = count(f);
  fire(input, 'focus');
  assert.equal($(f, '.combo__list').hidden, false);
  assert.equal(rows(f).length, 3);
  assert.ok(names(f).includes('+55 11 90000-1111'), 'contato sem nome aparece com o telefone formatado');
  type(input, 'beta');
  assert.deepEqual(names(f), ['Bruno Alves']);
  type(input, '98765');
  assert.deepEqual(names(f), ['Ana Souza']);
  assert.match(text(rows(f)[0]), /Acme · \+55 11 98765-4321 · ana@acme\.com/);
  type(input, 'nao existe');
  assert.match(text($(f, '.combo__empty')), /Nenhum contato com “nao existe”/);
  type(input, 'ana');
  pickRow(f, 'Ana Souza');
  assert.equal(f.value, 'a');
  assert.equal(input.value, 'Ana Souza');
  assert.equal($(f, '.combo__list').hidden, true);
  assert.equal(changes(), 1);
  pickRow(f, 'Ana Souza'); // lista fechada: nada acontece
});

test('contato: teclado (setas + Enter, Esc só fecha a lista), "Nenhum", linha extra e limpar', () => {
  const f = contactField({ contacts: CONTACTS, none: '— Nenhum —', extra: [{ value: '__new__', label: '+ Novo contato…' }] });
  const input = $(f, 'input');
  const changes = count(f);
  fire(input, 'focus');
  assert.deepEqual(names(f).slice(0, 2), ['— Nenhum —', '+ Novo contato…']);
  type(input, 'bruno');
  const enter = fire(input, 'keydown', { key: 'Enter' });
  assert.equal(f.value, 'b', 'com busca, a 1ª linha já vem marcada');
  assert.equal(enter.defaultPrevented, true, 'Enter não envia o formulário');
  fire(input, 'focus');
  fire(input, 'keydown', { key: 'Escape' });
  assert.equal($(f, '.combo__list').hidden, true);
  assert.equal(f.value, 'b', 'Esc não troca a escolha');
  // extra
  fire(input, 'focus');
  pickRow(f, '+ Novo contato…');
  assert.equal(f.value, '__new__');
  assert.equal(input.value, '+ Novo contato…');
  // limpar
  assert.equal($(f, '.combo__clear').hidden, false);
  fire($(f, '.combo__clear'), 'click');
  assert.equal(f.value, '');
  assert.equal(input.value, '');
  assert.equal(changes(), 3);
  // atribuir de fora (ex.: negócio escolhido traz o contato)
  f.value = 'd';
  assert.equal(input.value, '+55 11 90000-1111');
  f.disabled = true;
  assert.equal(input.disabled, true);
  assert.equal($(f, '.combo__clear').hidden, true);
});

test('contato: base grande mostra só 40 por vez e avisa; texto solto volta ao contato escolhido ao sair', () => {
  const many = Array.from({ length: 500 }, (_, i) => ({ id: `m${i}`, name: `Cliente ${String(i).padStart(3, '0')}`, phone: `+55119${String(10000000 + i)}`, company: '', email: '' }));
  const f = contactField({ contacts: many });
  const input = $(f, 'input');
  fire(input, 'focus');
  assert.equal(rows(f).length, 40);
  assert.match(text($(f, '.combo__more')), /Mostrando 40 de 500/);
  type(input, '499');
  assert.deepEqual(names(f), ['Cliente 499']);
  pickRow(f, 'Cliente 499');
  type(input, 'lixo digitado');
  fire(input, 'blur');
  assert.equal(input.value, 'Cliente 499', 'sair do campo sem escolher desfaz o texto solto');
  assert.equal(f.value, 'm499');
  f.setContacts(many.slice(0, 10));
  assert.equal(input.value, '', 'o contato escolhido saiu da lista: o campo não inventa nome');
});
