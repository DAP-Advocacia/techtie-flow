// Meu perfil (DOM simulado): dados da própria pessoa, edição de nome/cargo/telefone/sobre, validação e o que é só leitura.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, fire, tick, waitFor, $, $$, text } from './dom-env.mjs';

installDom();
const { store } = await import('../../public/js/store.js');
const profileScreen = (await import('../../public/js/screens/profile.js')).default;
const { saveProfile } = await import('../../public/js/screens/profile.js');

const asUser = (id) => (store.state.currentUserId = id);
const snapshot = JSON.parse(JSON.stringify(store.state.users));
const restore = () => store.update((s) => (s.users = JSON.parse(JSON.stringify(snapshot))));

async function mountProfile() {
  document.getElementById('app').replaceChildren();
  location.hash = '#/profile';
  const host = document.createElement('div');
  document.getElementById('app').append(host);
  const cleanup = await profileScreen.mount(host, { store, navigate: () => {} });
  return { host, cleanup };
}
const f = (host, key) => $(host, `[data-field="${key}"]`);
const type = (host, key, v) => {
  f(host, key).value = v;
  fire(f(host, key), 'input');
};
const save = (host) => $(host, '[data-act="save"]');

test('Perfil: mostra os dados da própria pessoa (e-mail, perfil, equipe, empresa) e os campos editáveis', async () => {
  restore();
  asUser('u_carla');
  const { host, cleanup } = await mountProfile();
  const card = text($(host, '[aria-label="Resumo"]'));
  assert.match(card, /Carla Souza/);
  assert.match(card, /carla@acme\.com\.br/);
  assert.match(card, /Gestor/);
  assert.match(card, /Acme Ltda/);
  assert.match(card, /Ativada/, 'verificação em duas etapas da Carla');
  assert.equal(f(host, 'name').value, 'Carla Souza');
  assert.equal(f(host, 'jobTitle').value, 'Gerente de vendas');
  assert.equal(f(host, 'email'), null, 'e-mail não é campo editável');
  assert.equal(save(host).hasAttribute('disabled'), true, 'nada para salvar ainda');
  assert.equal($(host, '[data-act="discard"]').hidden, true);
  cleanup();
});

test('Perfil: editar e salvar muda nome, cargo, telefone e sobre; o resto continua igual; fica na auditoria', async () => {
  restore();
  asUser('u_carla');
  const { host, cleanup } = await mountProfile();
  type(host, 'name', '  Carla   Souza Lima ');
  type(host, 'jobTitle', 'Diretora de vendas');
  type(host, 'phone', '+55 (11) 97777-6666');
  type(host, 'bio', 'Cuido do time comercial.\nFale comigo para metas.');
  assert.equal(save(host).hasAttribute('disabled'), false);
  assert.equal($(host, '[data-act="discard"]').hidden, false);
  assert.match(text($(host, '.profile-count')), /^48\/300/);
  fire($(host, '.profile-form'), 'submit');
  await waitFor(() => store.userById('u_carla').name === 'Carla Souza Lima');
  const u = store.userById('u_carla');
  assert.deepEqual([u.name, u.jobTitle, u.phone, u.bio], ['Carla Souza Lima', 'Diretora de vendas', '+55 (11) 97777-6666', 'Cuido do time comercial.\nFale comigo para metas.']);
  assert.deepEqual(u.roleIds, snapshot.find((x) => x.id === 'u_carla').roleIds, 'perfil de acesso intacto');
  assert.equal(u.email, 'carla@acme.com.br');
  assert.ok(store.state.auditLog.some((e) => e.action === 'profile.update' && e.target === 'u_carla'));
  await tick(10);
  assert.match(text($(host, '.profile-saved')), /Dados atualizados/);
  assert.equal(save(host).hasAttribute('disabled'), true, 'depois de salvar não há o que salvar');
  assert.match(text($(host, '.profile-hero')), /Carla Souza Lima/);
  cleanup();
});

test('Perfil: dado inválido não salva e avisa no campo; descartar volta ao salvo', async () => {
  restore();
  asUser('u_carla');
  const { host, cleanup } = await mountProfile();
  type(host, 'name', '   ');
  fire($(host, '.profile-form'), 'submit');
  await waitFor(() => /Informe o seu nome/.test(text(host)));
  assert.equal(store.userById('u_carla').name, 'Carla Souza', 'nada gravado');
  type(host, 'name', 'Carla Souza');
  type(host, 'phone', 'abc');
  fire($(host, '.profile-form'), 'submit');
  await waitFor(() => /Telefone inválido/.test(text(host)));
  click($(host, '[data-act="discard"]'));
  assert.equal(f(host, 'phone').value, '');
  assert.ok(!/Telefone inválido/.test(text(host)));
  cleanup();
});
const click = (el) => fire(el, 'click');

test('Perfil: cada pessoa edita só o PRÓPRIO — a tela sempre usa o usuário logado; sem mudança não grava', async () => {
  restore();
  asUser('u_pedro');
  const { host, cleanup } = await mountProfile();
  assert.equal(f(host, 'name').value, 'Pedro Nunes');
  type(host, 'jobTitle', 'Consultor sênior');
  fire($(host, '.profile-form'), 'submit');
  await waitFor(() => store.userById('u_pedro').jobTitle === 'Consultor sênior');
  assert.equal(store.userById('u_carla').jobTitle, 'Gerente de vendas', 'o perfil da Carla não mudou');
  cleanup();
  // salvar sem mudar nada não toca no estado
  const before = JSON.stringify(store.state.users);
  const r = await saveProfile(store, { name: 'Pedro Nunes', jobTitle: 'Consultor sênior', phone: '', bio: '' });
  assert.deepEqual(r, { ok: true, unchanged: true });
  assert.equal(JSON.stringify(store.state.users), before);
  // e a ação recusa dado inválido mesmo sem passar pela tela
  assert.equal((await saveProfile(store, { name: '' })).ok, false);
  asUser('u_marina');
  restore();
});
