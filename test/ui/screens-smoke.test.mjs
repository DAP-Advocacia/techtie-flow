// Fumaça das telas no DOM simulado: cada tela monta, desenha algo, reage a uma mudança do store e limpa sem erro.
// Roda no protótipo (dados fictícios) com o administrador, e as telas de dia a dia também com perfil limitado.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, tick, $, $$, text } from './dom-env.mjs';

installDom();
const { store } = await import('../../public/js/store.js');
const SCREENS = ['home', 'inbox', 'pipeline', 'contacts', 'tasks', 'dashboard', 'agent', 'automations', 'instances', 'users', 'settings', 'permissions'];
const load = async (id) => (await import(`../../public/js/screens/${id}.js`)).default;
const errors = [];

before(() => {
  // erros assíncronos dentro das telas (timers, promessas) também reprovam o teste
  process.on('unhandledRejection', (e) => errors.push(e));
  const admin = store.state.users.find((u) => (u.roleIds || []).includes('role_admin'));
  store.state.currentUserId = admin.id;
});

async function mountScreen(id) {
  document.getElementById('app').replaceChildren();
  const host = document.createElement('div');
  host.dataset.screen = id;
  document.getElementById('app').append(host);
  const screen = await load(id);
  const cleanup = await screen.mount(host, { store, navigate: () => {}, route: { id } });
  return { host, cleanup };
}

for (const id of SCREENS) {
  test(`tela "${id}": monta, desenha, reage ao store e limpa (administrador)`, async () => {
    const { host, cleanup } = await mountScreen(id);
    assert.ok(host.children.length > 0, 'desenhou algo');
    assert.ok(text(host).length > 20, 'tem conteúdo de verdade');
    store.update((s) => {
      s.ui = { ...(s.ui || {}), tick: Date.now() };
    }); // uma mudança qualquer: as telas assinam o store e redesenham
    await tick(30);
    assert.ok(host.children.length > 0, 'continua desenhada depois da mudança');
    if (typeof cleanup === 'function') cleanup();
    await tick(30);
  });
}

test('telas de dia a dia também montam com perfil limitado (Atendente) e leitura (Somente leitura)', async () => {
  for (const role of ['role_agent', 'role_viewer', 'role_finance', 'role_sdr', 'role_manager']) {
    const user = store.state.users.find((u) => (u.roleIds || []).includes(role) && !u.isBot);
    store.state.currentUserId = user.id;
    for (const id of ['home', 'inbox', 'pipeline', 'contacts', 'tasks', 'dashboard', 'agent', 'instances']) {
      const { host, cleanup } = await mountScreen(id);
      assert.ok(host.children.length > 0, `${id} com ${role}`);
      if (typeof cleanup === 'function') cleanup();
    }
  }
  store.state.currentUserId = store.state.users.find((u) => (u.roleIds || []).includes('role_admin')).id;
});

test('login e onboarding montam (o login novo, com a logo, e o formulário responde)', async () => {
  for (const id of ['login', 'onboarding']) {
    const { host, cleanup } = await mountScreen(id);
    assert.ok(host.children.length > 0, id);
    if (id === 'login') {
      assert.ok($(host, '.login-brand__name'), 'nome da marca');
      assert.ok($(host, '.tt-mark img'), 'logo oficial');
      assert.ok($(host, 'input[type="email"]') && $(host, 'input[type="password"]'));
    }
    if (typeof cleanup === 'function') cleanup();
  }
});

test('sem erros assíncronos escapando das telas', async () => {
  await tick(50);
  assert.deepEqual(errors.map((e) => String(e?.stack || e).split('\n')[0]), []);
  assert.equal($$(document, '.tasks-overlay').length, 0, 'nenhum painel esquecido aberto');
});
