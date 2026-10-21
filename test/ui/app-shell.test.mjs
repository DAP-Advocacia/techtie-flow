// O app inteiro (app.js) no DOM simulado: casca com menu lateral, barra superior, abas do celular, roteamento por hash,
// breadcrumb, menu recolhido (preferência guardada) e o atalho global Ctrl+K.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, fire, tick, waitFor, $, $$, text } from './dom-env.mjs';

installDom();
let store;

before(async () => {
  globalThis.window.__TTF__ = { live: false };
  ({ store } = await import('../../public/js/store.js'));
  store.state.session = { loggedIn: true };
  store.state.currentUserId = store.state.users.find((u) => (u.roleIds || []).includes('role_admin')).id;
  location.hash = '#/home';
  await import('../../public/js/app.js'); // sobe o app (monta a rota atual)
  await waitFor(() => $(document, '.screen') && $(document, '.screen').children.length > 0);
});

// navega e ESPERA a tela certa montar (o roteador importa o módulo da tela de forma assíncrona)
const go = async (hash) => {
  location.hash = hash;
  fire(window, 'hashchange');
  const id = hash.replace(/^#\/?/, '').split(/[/?]/)[0];
  await waitFor(() => {
    const sc = $(document, '.screen');
    return sc && sc.dataset.screen === id && sc.children.length > 0;
  });
};

test('casca: menu lateral, barra superior e abas do celular estão na tela do Início', async () => {
  assert.ok($(document, '.sidebar'), 'menu lateral');
  assert.ok($(document, '.topbar'), 'barra superior');
  assert.ok($(document, '.tabbar'), 'abas do celular (escondidas por CSS no computador)');
  assert.ok($(document, '.mobilebar'), 'barra do celular');
  assert.ok($(document, '.home'), 'a tela Início montou');
  assert.match(text($(document, '.topbar__crumbs')), /Início/);
  const items = $$(document, '.sidebar .nav-item').map((a) => a.getAttribute('href'));
  for (const id of ['home', 'inbox', 'pipeline', 'contacts', 'tasks', 'dashboard']) assert.ok(items.includes(`#/${id}`), `menu tem ${id}`);
  assert.ok($(document, '.sidebar .nav-item.is-active[href="#/home"]'));
});

test('navegar pelo hash troca a tela, o caminho da página e o item ativo (menu e abas)', async () => {
  await go('#/tasks');
  assert.ok($(document, '.tasks'), 'tela Tarefas');
  assert.match(text($(document, '.topbar__crumbs')), /Tarefas/);
  assert.ok($(document, '.sidebar .nav-item.is-active[href="#/tasks"]'));
  assert.ok($(document, '.tabbar__item.is-active[href="#/tasks"]'));
  await go('#/contacts?c=' + store.state.contacts[0].id);
  assert.ok($(document, '.contacts'));
  assert.equal($(document, '.contacts').dataset.mview, 'detail', 'o link com ?c= abre a ficha do contato');
  await go('#/pipeline');
  assert.ok($(document, '.pipeline'));
});

test('abas do celular: Início, Inbox, Negócios, Contatos e Tarefas (o Dashboard fica no menu)', async () => {
  const tabs = $$(document, '.tabbar__item').map((a) => a.getAttribute('href'));
  assert.deepEqual(tabs, ['#/home', '#/inbox', '#/pipeline', '#/contacts', '#/tasks']);
});

test('telas só de computador: no celular mostram o aviso (e o menu marca "computador")', async () => {
  globalThis.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  window.matchMedia = globalThis.matchMedia;
  try {
    await go('#/permissions');
    assert.ok($(document, '.desktop-only'), 'aviso no lugar da tela');
    assert.match(text($(document, '.desktop-only')), /Permissões é no computador/);
    assert.equal($(document, '.sidebar .nav-item[href="#/permissions"]').getAttribute('data-desktop'), 'true');
  } finally {
    globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    window.matchMedia = globalThis.matchMedia;
  }
  await go('#/permissions');
  assert.ok($(document, '.perm, .permissions, [data-screen="permissions"]') || !$(document, '.desktop-only'), 'no computador a tela abre');
});

test('menu lateral recolhido: alterna, lembra a escolha e a classe vai para a casca', async () => {
  await go('#/home');
  assert.equal($(document, '.app').classList.contains('is-collapsed'), false);
  $(document, '.topbar__toggle').click();
  assert.equal($(document, '.app').classList.contains('is-collapsed'), true);
  assert.equal(localStorage.getItem('ttf:sidebar'), 'collapsed');
  await go('#/tasks'); // a casca é refeita: a escolha continua
  assert.equal($(document, '.app').classList.contains('is-collapsed'), true, 'continua recolhido depois de navegar');
  $(document, '.topbar__toggle').click();
  assert.equal(localStorage.getItem('ttf:sidebar'), 'open');
});

test('atalho global: Ctrl+K e "/" abrem a busca nas telas com menu; "/" digitando num campo não', async () => {
  await go('#/home');
  fire(document, 'keydown', { key: 'k', ctrlKey: true });
  assert.ok($(document, '.palette'), 'Ctrl+K abre');
  fire(document, 'keydown', { key: 'Escape' });
  assert.equal($(document, '.palette'), null);
  fire(document, 'keydown', { key: '/' });
  assert.ok($(document, '.palette'), '"/" abre');
  fire(document, 'keydown', { key: 'Escape' });
  const input = document.createElement('input');
  document.body.append(input);
  fire(input, 'keydown', { key: '/' });
  assert.equal($(document, '.palette'), null, 'digitando "/" num campo não abre a busca');
  input.remove();
});

test('login não tem casca nem atalho de busca', async () => {
  store.state.session = { loggedIn: false };
  await go('#/login');
  assert.ok($(document, '.login'));
  assert.equal($(document, '.sidebar'), null);
  assert.equal($(document, '.topbar'), null);
  fire(document, 'keydown', { key: 'k', ctrlKey: true });
  assert.equal($(document, '.palette'), null);
  store.state.session = { loggedIn: true };
});
