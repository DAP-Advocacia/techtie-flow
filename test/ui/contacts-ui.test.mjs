// Contatos (modo lista): filtros rápidos com contagem, ordenação com letras, linhas com negócios/responsável e ficha com
// copiar, e-mail, etiquetas, atividade e "+ Negócio" com o contato já escolhido. Campos ocultos continuam ocultos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, fire, tick, $, $$, text } from './dom-env.mjs';

installDom();
const { store } = await import('../../public/js/store.js');
const contactsScreen = (await import('../../public/js/screens/contacts.js')).default;
const { visible } = await import('../../public/js/access.js');

const click = (el) => fire(el, 'click');
const pick = (sel, value) => {
  sel.value = value;
  fire(sel, 'change');
};
const asUser = (id) => (store.state.currentUserId = id);
const reset = () => {
  localStorage.removeItem('ttf:contacts:list');
  localStorage.removeItem('ttf:contacts:mode');
};
async function mountContacts() {
  document.getElementById('app').replaceChildren();
  location.hash = '#/contacts';
  const host = document.createElement('div');
  document.getElementById('app').append(host);
  const cleanup = await contactsScreen.mount(host, { store, navigate: () => {} });
  return { host, cleanup };
}
const names = (host) => $$(host, '.contacts-item__name').map((n) => text(n));
const chip = (host, id) => $(host, `.contacts-chip[data-quick="${id}"]`);
const item = (host, name) => $$(host, '.contacts-item').find((b) => text(b).includes(name));

test('Contatos: filtros rápidos mostram a contagem e filtram; a escolha fica lembrada', async () => {
  reset();
  asUser('u_marina');
  const { host, cleanup } = await mountContacts();
  const total = visible('contact', store.state.contacts).length;
  assert.deepEqual($$(host, '.contacts-chip').map((c) => text(c).replace(/\d+$/, '').trim()), ['Todos', 'Meus', 'Sem responsável', 'Com negócio aberto', 'Novos (30 dias)']);
  assert.match(text(chip(host, 'all')), new RegExp(`${total}$`));
  assert.equal(chip(host, 'all').getAttribute('aria-pressed'), 'true');
  click(chip(host, 'mine'));
  const mine = store.state.contacts.filter((c) => c.ownerId === 'u_marina').length;
  assert.equal(names(host).length, mine);
  assert.equal(chip(host, 'mine').getAttribute('aria-pressed'), 'true');
  assert.match(text($(host, '.contacts-count')), new RegExp(`${mine} contatos encontrados`));
  click(chip(host, 'recent'));
  const recent = store.state.contacts.filter((c) => c.createdAt && Date.now() - c.createdAt < 30 * 86400000).length;
  assert.equal(names(host).length, recent);
  assert.ok(recent > 0 && recent < total);
  click(chip(host, 'noowner'));
  assert.equal(names(host).length, 0);
  assert.match(text($(host, '.contacts-none')), /Nenhum contato com esse filtro/);
  cleanup();
  const again = await mountContacts();
  assert.equal(chip(again.host, 'noowner').getAttribute('aria-pressed'), 'true', 'lembra o filtro');
  click(chip(again.host, 'all'));
  assert.equal(names(again.host).length, total);
  again.cleanup();
});

test('Contatos: o filtro rápido soma com a busca; contagens dos filtros respeitam a busca digitada', async () => {
  reset();
  asUser('u_marina');
  const { host, cleanup } = await mountContacts();
  const search = $(host, '.contacts-search__input');
  search.value = 'lopes';
  fire(search, 'input');
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(names(host), ['Helena Lopes']);
  assert.match(text(chip(host, 'all')), /1$/);
  click(chip(host, 'noowner'));
  assert.equal(names(host).length, 0);
  click(chip(host, 'all'));
  cleanup();
});

test('Contatos: ordenar por nome (com letras), empresa ou mais recentes', async () => {
  reset();
  asUser('u_marina');
  const { host, cleanup } = await mountContacts();
  assert.deepEqual($$(host, '.contacts-letter').map((l) => text(l)), ['B', 'C', 'G', 'H', 'N', 'O', 'P']);
  assert.equal(names(host)[0], 'Bruno Tavares');
  pick($(host, '.contacts-sort'), 'recent');
  assert.equal(names(host)[0], 'Bruno Tavares', 'o mais novo primeiro (2 dias)');
  assert.equal(names(host)[names(host).length - 1], 'Otávio Vieira', 'o mais antigo por último (60 dias)');
  assert.equal($$(host, '.contacts-letter').length, 0, 'por data não há letras');
  pick($(host, '.contacts-sort'), 'company');
  assert.equal(names(host)[0], 'Grupo Aurora', 'Aurora Distribuidora vem primeiro');
  assert.equal(localStorage.getItem('ttf:contacts:list') && JSON.parse(localStorage.getItem('ttf:contacts:list')).sort, 'company');
  pick($(host, '.contacts-sort'), 'name');
  cleanup();
});

test('Contatos: a linha mostra negócios abertos e o responsável', async () => {
  reset();
  asUser('u_marina');
  const { host, cleanup } = await mountContacts();
  const carlos = item(host, 'Carlos Menezes');
  assert.match(text($(carlos, '.contacts-item__deals')), /1 negócio/);
  assert.equal($(carlos, '.contacts-item__meta .avatar').getAttribute('title'), 'Marina Alves');
  cleanup();
});

test('Contatos (ficha): copiar telefone/e-mail, e-mail, etiquetas, cadastrado em, atividade e "+ Negócio" com o contato já escolhido', async () => {
  reset();
  asUser('u_marina');
  const copied = [];
  navigator.clipboard = { writeText: async (v) => copied.push(v) };
  const { host, cleanup } = await mountContacts();
  click(item(host, 'Carlos Menezes'));
  const detail = $(host, '.contacts-detail');
  assert.equal($$(detail, '.contacts-copy').length, 2);
  click($(detail, '.contacts-copy[aria-label="Copiar telefone"]'));
  click($(detail, '.contacts-copy[aria-label="Copiar e-mail"]'));
  await tick(5);
  assert.deepEqual(copied, ['+55 11 98765-4321', 'carlos@menezes.eng.br']);
  assert.equal($$(detail, 'a.btn').find((a) => /E-mail/.test(text(a))).getAttribute('href'), 'mailto:carlos@menezes.eng.br');
  assert.match(text(detail), /Quente/);
  assert.match(text(detail), /Integração ERP/);
  assert.match(text(detail), /Cadastrado em/);
  if ((store.state.timeline?.c_carlos || []).length) assert.match(text(detail), /Atividade/);
  const add = $(detail, '.contacts-block__add');
  assert.match(text(add), /\+ Negócio/);
  click(add);
  const modal = document.querySelector('.pipeline-modal');
  assert.ok(modal, 'abriu o novo negócio');
  assert.equal($(modal, 'select').value, 'c_carlos', 'o contato já vem escolhido');
  [...modal.querySelectorAll('button')].find((b) => /Cancelar/.test(text(b)))?.click();
  cleanup();
});

test('Contatos (ficha): campo oculto no perfil não ganha botão de copiar; quem não cria negócio não vê "+ Negócio"', async () => {
  reset();
  asUser('u_julia'); // Financeiro: telefone oculto, lê contatos de todos
  const { host, cleanup } = await mountContacts();
  click(item(host, 'Carlos Menezes'));
  const detail = $(host, '.contacts-detail');
  assert.ok(!$(detail, '.contacts-copy[aria-label="Copiar telefone"]'), 'telefone oculto: sem copiar');
  assert.ok(!/\+55/.test(text(detail)), 'nenhum telefone na ficha');
  assert.ok($(detail, '.contacts-copy[aria-label="Copiar e-mail"]'), 'o e-mail continua visível');
  assert.ok(!$(detail, '.contacts-block__add'), 'Financeiro não cria negócio');
  cleanup();
  asUser('u_marina');
});
