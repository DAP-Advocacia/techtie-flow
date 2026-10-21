// Busca global (Ctrl+K), "+ Novo" e avisos da barra superior, executados num DOM simulado.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, fire, tick, $, $$, text } from './dom-env.mjs';

installDom();
const { store } = await import('../../public/js/store.js');
const { openPalette, closePalette, currentEntries, runEntry } = await import('../../public/js/search/palette.js');
const { renderTopbar, attention } = await import('../../public/js/shell/topbar.js');
const { closeMenu } = await import('../../public/js/shell/menu.js');
const { hashParam, hashParts, linkTo } = await import('../../public/js/router.js');

const admin = () => store.state.users.find((u) => (u.roleIds || []).includes('role_admin'));
const as = (role) => (store.state.currentUserId = store.state.users.find((u) => (u.roleIds || []).includes(role) && !u.isBot).id);
const type = (input, value) => {
  input.value = value;
  fire(input, 'input');
};
const key = (el, k) => fire(el, 'keydown', { key: k });

before(() => {
  store.state.currentUserId = admin().id;
  store.state.tasks = [];
  location.hash = '#/home';
});

test('roteador: link com parâmetros vai e volta', () => {
  assert.equal(linkTo('deal', { id: 'a b' }), '#/deal?id=a+b');
  assert.equal(linkTo('tasks'), '#/tasks');
  location.hash = '#/contacts?c=abc&x=1';
  assert.deepEqual([hashParts().id, hashParam('c'), hashParam('x'), hashParam('nao')], ['contacts', 'abc', '1', null]);
  location.hash = '#/home';
});

test('busca global: abre vazia com atalhos, acha contato/negócio/conversa e navega com Enter', async () => {
  openPalette();
  const input = $(document, '.palette__input');
  assert.ok(input, 'abriu');
  assert.match(text($(document, '.palette__list')), /Ir para e criar/);
  assert.match(text($(document, '.palette__list')), /Início/);

  const contact = store.state.contacts[0];
  type(input, contact.name.split(' ')[0].toLowerCase());
  const labels = $$(document, '.palette__label').map(text);
  assert.ok(labels.includes('Contatos'), 'grupo Contatos');
  const first = $$(document, '.palette__item')[0];
  assert.ok(first);
  key(input, 'Enter');
  assert.equal($(document, '.palette'), null, 'fechou ao escolher');
  assert.match(location.hash, /^#\/(contacts\?c=|deal\?id=|inbox\?c=)/);

  // negócio por título
  const deal = store.state.deals[0];
  openPalette();
  type($(document, '.palette__input'), deal.title.split(' ')[0].toLowerCase());
  const dealItem = $$(document, '.palette__item').find((b) => b.textContent.includes(deal.title));
  assert.ok(dealItem, 'achou o negócio pelo título');
  dealItem.click();
  assert.equal(location.hash, `#/deal?id=${deal.id}`);
});

test('busca global: setas mudam o item ativo e Esc fecha; sem resultado mostra aviso', async () => {
  openPalette();
  const input = $(document, '.palette__input');
  type(input, 'a');
  const n = $$(document, '.palette__item').length;
  assert.ok(n > 1);
  assert.equal($$(document, '.palette__item.is-active').length, 1);
  assert.equal($$(document, '.palette__item')[0].classList.contains('is-active'), true);
  key(input, 'ArrowDown');
  assert.equal($$(document, '.palette__item')[1].classList.contains('is-active'), true);
  key(input, 'ArrowUp');
  key(input, 'ArrowUp');
  assert.equal($$(document, '.palette__item')[n - 1].classList.contains('is-active'), true, 'volta pelo fim');
  type(input, 'zzzzqqqq');
  assert.match(text($(document, '.palette__empty')), /Nada encontrado/);
  fire(document, 'keydown', { key: 'Escape' });
  assert.equal($(document, '.palette'), null);
  closePalette();
});

test('busca global: tarefa abre o painel; "Nova tarefa" e "Novo contato" criam de qualquer tela; recentes aparecem', async () => {
  const me = admin();
  store.update((s) => s.tasks.push({ id: 't_search', title: 'Revisar contrato do fornecedor', status: 'todo', priority: 'normal', dueAt: null, dueHasTime: false, ownerId: me.id, teamId: null, createdBy: me.id, dealId: null, contactId: null, checklist: [], completedAt: null, createdAt: 1, updatedAt: 1, sharedWith: [] }));
  openPalette();
  type($(document, '.palette__input'), 'contrato fornecedor');
  $$(document, '.palette__item').find((b) => b.textContent.includes('Revisar contrato')).click();
  assert.ok($(document, '.tasks-panel'), 'a tarefa abriu no painel');
  $(document, '.tasks-close').click();

  openPalette();
  type($(document, '.palette__input'), 'nova tarefa');
  $$(document, '.palette__item').find((b) => /Novo: Tarefa/.test(b.textContent)).click();
  assert.ok($(document, '.tasks-panel'), 'comando abre o painel de nova tarefa');
  assert.equal($(document, '.tasks-panel__title').textContent, 'Nova tarefa');
  $(document, '.tasks-close').click();

  openPalette();
  type($(document, '.palette__input'), 'novo contato');
  $$(document, '.palette__item').find((b) => /Novo: Contato/.test(b.textContent)).click();
  assert.ok($(document, '.contacts-dialog'), 'abre o formulário de contato');
  $(document, '.contacts-dialog .btn--quiet').click();

  openPalette();
  assert.match(text($(document, '.palette__list')), /Abertos recentemente/);
  assert.match(text($(document, '.palette__list')), /Revisar contrato do fornecedor/, 'a tarefa aberta aparece nos recentes');
  closePalette();
});

test('busca global respeita permissão: Somente leitura vê o que o perfil lê, mas não tem comandos de criar nem telas sem acesso', async () => {
  const keep = store.state.currentUserId;
  try {
    as('role_viewer');
    const { entries } = currentEntries();
    assert.ok(!entries.some((e) => e.type === 'command' && e.command.action), 'sem ações de criar');
    assert.ok(entries.some((e) => e.type === 'contact' || e.type === 'deal'), 'continua vendo o que o perfil permite');
    assert.ok(!entries.some((e) => e.id === 'go:instances'), 'não oferece ir para tela sem permissão');
    // o Financeiro não lê tarefas: não pode aparecer nenhuma na busca
    as('role_finance');
    assert.ok(!currentEntries().entries.some((e) => e.type === 'task'), 'sem tarefas para quem não pode ler');
  } finally {
    store.state.currentUserId = keep;
  }
});

test('barra superior: caminho, busca, "+ Novo" com os itens certos e avisos', async () => {
  let toggled = 0;
  let went = null;
  const bar = renderTopbar({ crumbs: [{ label: 'Negócios', href: '#/pipeline' }, { label: 'Negócio' }], onToggleSidebar: () => toggled++, navigate: (id) => (went = id) });
  document.body.append(bar);
  assert.match(text($(bar, '.topbar__crumbs')), /Negócios.*Negócio/);
  assert.equal($(bar, '.topbar__crumbs a').getAttribute('href'), '#/pipeline');
  assert.equal($(bar, '.topbar__here').getAttribute('aria-current'), 'page');
  $(bar, '.topbar__toggle').click();
  assert.equal(toggled, 1);
  $(bar, '.topbar__search').click();
  assert.ok($(document, '.palette'));
  closePalette();

  $(bar, '.topbar__new').click();
  const items = $$(document, '.menu__item');
  assert.deepEqual(items.map((b) => b.querySelector('.menu__label').textContent), ['Negócio', 'Contato', 'Tarefa']);
  assert.ok(items.every((b) => !b.disabled), 'administrador cria os três');
  items[2].click();
  assert.ok($(document, '.tasks-panel'));
  $(document, '.tasks-close').click();
  closeMenu();

  // avisos: tarefa atrasada soma no sino e abre Tarefas
  const me = admin();
  store.update((s) => s.tasks.push({ id: 't_late', title: 'Atrasada', status: 'todo', priority: 'normal', dueAt: Date.now() - 3 * 86400000, dueHasTime: false, ownerId: me.id, teamId: null, createdBy: me.id, dealId: null, contactId: null, checklist: [], completedAt: null, createdAt: 1, updatedAt: 1, sharedWith: [] }));
  const a = attention();
  assert.ok(a.overdue >= 1 && a.badge >= 1);
  const bar2 = renderTopbar({ crumbs: [{ label: 'Início' }], onToggleSidebar() {}, navigate: (id) => (went = id) });
  document.body.append(bar2);
  assert.ok($(bar2, '.topbar__badge'), 'sino com contador');
  $(bar2, '.topbar__bell').click();
  const bellItems = $$(document, '.menu__item');
  const taskItem = bellItems.find((b) => /tarefa/.test(b.textContent));
  assert.ok(taskItem, 'avisa de tarefas');
  taskItem.click();
  assert.equal(went, 'tasks');
  bar.remove();
  bar2.remove();
});

test('barra superior: perfil sem permissão de criar vê os itens desabilitados com o motivo', async () => {
  const keep = store.state.currentUserId;
  as('role_viewer');
  const bar = renderTopbar({ crumbs: [{ label: 'Início' }], onToggleSidebar() {}, navigate() {} });
  document.body.append(bar);
  $(bar, '.topbar__new').click();
  const items = $$(document, '.menu__item');
  assert.equal(items.length, 3);
  assert.ok(items.every((b) => b.disabled && /Seu perfil não permite/.test(b.getAttribute('title'))));
  closeMenu();
  bar.remove();
  store.state.currentUserId = keep;
});

test('conversa na busca: abre a Inbox já na conversa (pedido registrado no store)', async () => {
  const conv = store.state.conversations.find((c) => c.id);
  runEntry({ type: 'conversation', id: conv.id, title: 'x' });
  assert.equal(store.state.ui.inboxConversationId, conv.id);
  assert.equal(location.hash, `#/inbox?c=${conv.id}`);
  delete store.state.ui.inboxConversationId;
});
