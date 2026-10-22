// Chat interno na aba Inbox (DOM simulado): alternar Atendimento/Chat, salas só dos participantes, não lidas, enviar,
// conversa direta única, grupos, convidar e quem não atende clientes (só chat).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, fire, tick, waitFor, $, $$, text } from './dom-env.mjs';

installDom();
const { store } = await import('../../public/js/store.js');
const inboxScreen = (await import('../../public/js/screens/inbox.js')).default;
const { canAccess } = await import('../../public/js/access.js');

const click = (el) => fire(el, 'click');
const asUser = (id) => (store.state.currentUserId = id);
const snapshot = JSON.parse(JSON.stringify(store.state.chat));
const restore = () => store.update((s) => (s.chat = JSON.parse(JSON.stringify(snapshot))));

async function mountInbox(hash = '#/inbox') {
  document.getElementById('app').replaceChildren();
  location.hash = hash;
  const host = document.createElement('div');
  document.getElementById('app').append(host);
  const cleanup = await inboxScreen.mount(host, { store, navigate: () => {} });
  return { host, cleanup };
}
const mode = (host, id) => $(host, `.inbox-mode[data-mode="${id}"]`);
const rooms = (host) => $$(host, '.chat-room');
const roomTitles = (host) => rooms(host).map((r) => text($(r, '.chat-room__title')));
const room = (host, title) => rooms(host).find((r) => text($(r, '.chat-room__title')) === title);
const msgs = (host) => $$(host, '.chat-msg');
const dialog = () => document.querySelector('.contacts-dialog');
const typeAndSend = async (host, body) => {
  const input = $(host, '.chat-input');
  input.value = body;
  fire(input, 'input');
  fire($(host, '.chat-composer'), 'submit');
  await tick(10);
};

test('Inbox: alternar entre Atendimento e Chat interno; o chat mostra só as salas de quem participa', async () => {
  restore();
  asUser('u_marina');
  const { host, cleanup } = await mountInbox();
  assert.ok(mode(host, 'service') && mode(host, 'chat'));
  assert.equal(mode(host, 'service').getAttribute('aria-selected'), 'true');
  assert.equal($(host, '.inbox-pane:not([hidden]) .inbox') !== null, true, 'abre no atendimento');
  assert.match(text(mode(host, 'chat')), /Chat interno\s*1/, 'badge: 1 não lida (Carla)');
  click(mode(host, 'chat'));
  assert.equal(mode(host, 'chat').getAttribute('aria-selected'), 'true');
  assert.equal($(host, '.chat').closest('.inbox-pane').hidden, false);
  assert.equal($(host, '.inbox').closest('.inbox-pane').hidden, true);
  assert.deepEqual(roomTitles(host).sort(), ['Carla Souza', 'Time comercial'], 'a conversa Pedro × Rafael não aparece para a Marina');
  click(mode(host, 'service'));
  assert.equal($(host, '.chat').closest('.inbox-pane').hidden, true);
  cleanup();
});

test('Chat: abrir a sala mostra as mensagens e marca como lida; prévia e badge somem', async () => {
  restore();
  asUser('u_marina');
  const { host, cleanup } = await mountInbox('#/inbox?view=chat');
  assert.equal($(host, '.chat').closest('.inbox-pane').hidden, false, '?view=chat abre direto no chat');
  const carla = room(host, 'Carla Souza');
  assert.ok($(carla, '.badge'), 'tem não lida');
  assert.match(text($(carla, '.chat-room__preview')), /proposta do Grupo Aurora/);
  click(carla);
  assert.equal(msgs(host).length, 3);
  assert.ok($(host, '.chat-day'), 'separador de dia');
  assert.equal($$(host, '.chat-msg--mine').length, 1, 'uma mensagem minha');
  assert.equal($(host, '.chat').dataset.mview, 'thread');
  await waitFor(() => !$(room(host, 'Carla Souza'), '.badge'));
  assert.doesNotMatch(text(mode(host, 'chat')), /\d/, 'badge do chat zerou');
  // em grupo o nome de quem escreveu aparece
  click(room(host, 'Time comercial'));
  assert.match(text($(host, '.chat-thread')), /Carla Souza/);
  assert.match(text($(host, '.chat-thread__sub')), /4 pessoas/);
  click($(host, '.chat-back'));
  assert.equal($(host, '.chat').dataset.mview, 'list');
  cleanup();
});

test('Chat: enviar mensagem (botão e Enter), rascunho limpo, prévia "Você:"; vazio não envia', async () => {
  restore();
  asUser('u_marina');
  const { host, cleanup } = await mountInbox('#/inbox?view=chat');
  click(room(host, 'Carla Souza'));
  const before = msgs(host).length;
  await typeAndSend(host, '   ');
  assert.equal(msgs(host).length, before, 'só espaços não envia');
  await typeAndSend(host, 'Olho agora mesmo!');
  assert.equal(msgs(host).length, before + 1);
  assert.match(text($$(host, '.chat-msg--mine').at(-1)), /Olho agora mesmo!/);
  assert.equal($(host, '.chat-input').value, '', 'limpou o campo');
  assert.match(text($(room(host, 'Carla Souza'), '.chat-room__preview')), /^Você: Olho agora mesmo!/);
  assert.equal(roomTitles(host)[0], 'Carla Souza', 'a sala com mensagem nova sobe');
  // Enter envia; Shift+Enter não
  const input = $(host, '.chat-input');
  input.value = 'Por Enter';
  fire(input, 'keydown', { key: 'Enter', shiftKey: true });
  await tick(10);
  assert.equal(msgs(host).length, before + 1, 'Shift+Enter só quebra a linha');
  fire(input, 'keydown', { key: 'Enter', shiftKey: false });
  await tick(10);
  assert.equal(msgs(host).length, before + 2);
  assert.equal(store.state.chat.messages.cr1.at(-1).body, 'Por Enter');
  cleanup();
});

test('Chat: nova conversa direta é única por par; busca de pessoas sem acento; busca de salas', async () => {
  restore();
  asUser('u_marina');
  const { host, cleanup } = await mountInbox('#/inbox?view=chat');
  const total = store.state.chat.rooms.length;
  click($(host, '.chat-new'));
  assert.ok(dialog());
  const names = $$(dialog(), '.chat-person__name').map((n) => text(n));
  assert.ok(!names.includes('Marina Alves'), 'eu não apareço');
  assert.ok(!names.includes('Agente de IA'), 'robô não é pessoa');
  assert.ok(!names.includes('Bia Martins'), 'convidada (ainda não ativa) não entra');
  assert.ok(names.includes('Pedro Nunes'));
  const q = $(dialog(), 'input[type="search"]');
  q.value = 'JULIA';
  fire(q, 'input');
  assert.deepEqual($$(dialog(), '.chat-person__name').map((n) => text(n)), ['Júlia Ramos'], 'sem acento nem caixa');
  q.value = 'pedro';
  fire(q, 'input');
  click($(dialog(), '.chat-person'));
  await waitFor(() => !dialog());
  assert.equal(store.state.chat.rooms.length, total + 1);
  assert.ok(room(host, 'Pedro Nunes'));
  assert.equal($(host, '.chat-thread__name').textContent, 'Pedro Nunes');
  assert.match(text($(host, '.chat-msgs')), /Comece a conversa com Pedro/);
  // abrir de novo a conversa com o Pedro não duplica
  click($(host, '.chat-new'));
  const q2 = $(dialog(), 'input[type="search"]');
  q2.value = 'pedro';
  fire(q2, 'input');
  click($(dialog(), '.chat-person'));
  await waitFor(() => !dialog());
  assert.equal(store.state.chat.rooms.length, total + 1, 'mesma sala');
  const s = $(host, '.chat-search');
  s.value = 'carla';
  fire(s, 'input');
  assert.deepEqual(roomTitles(host), ['Carla Souza']);
  s.value = 'zzz';
  fire(s, 'input');
  assert.match(text($(host, '.chat-rooms__none')), /Nenhuma conversa com esse nome/);
  cleanup();
});

test('Chat: criar grupo (nome e pessoas obrigatórios) e convidar mais gente depois', async () => {
  restore();
  asUser('u_marina');
  const { host, cleanup } = await mountInbox('#/inbox?view=chat');
  click($(host, '.chat-new'));
  click($(dialog(), '.pill[data-mode="group"]'));
  const submit = () => click([...dialog().querySelectorAll('button')].find((b) => /Criar grupo/.test(text(b))));
  submit();
  await waitFor(() => /nome ao grupo/i.test(text(dialog())));
  const gn = $(dialog(), 'input[aria-label="Nome do grupo"]');
  gn.value = 'Projeto Aurora';
  submit();
  await waitFor(() => /mais uma pessoa/.test(text(dialog())));
  click($(dialog(), '.chat-person[data-user="u_carla"]'));
  click($(dialog(), '.chat-person[data-user="u_pedro"]'));
  assert.match(text([...dialog().querySelectorAll('button')].find((b) => /Criar grupo/.test(text(b)))), /Criar grupo \(3\)/);
  submit();
  await waitFor(() => !dialog());
  const g = store.state.chat.rooms.find((r) => r.name === 'Projeto Aurora');
  assert.deepEqual([...g.members].sort(), ['u_carla', 'u_marina', 'u_pedro']);
  assert.equal($(host, '.chat-thread__name').textContent, 'Projeto Aurora');
  assert.match(text(host.querySelector('.chat-msgs')), /Grupo criado/);
  // convidar a Júlia (ativa); a Bia (convidada) nem aparece como opção
  click($(host, '.chat-add'));
  assert.ok(!$(dialog(), '.chat-person[data-user="u_bia"]'));
  assert.ok(!$(dialog(), '.chat-person[data-user="u_carla"]'), 'quem já está no grupo não aparece');
  click($(dialog(), '.chat-person[data-user="u_julia"]'));
  click([...dialog().querySelectorAll('button')].find((b) => /Adicionar/.test(text(b))));
  await waitFor(() => !dialog());
  assert.ok(g.members.includes('u_julia'));
  assert.match(text($(host, '.chat-thread__sub')), /4 pessoas/);
  cleanup();
});

test('Chat: cada pessoa só vê as próprias salas; quem não atende clientes vê só o chat', async () => {
  restore();
  asUser('u_pedro');
  const pedro = await mountInbox('#/inbox?view=chat');
  assert.deepEqual(roomTitles(pedro.host).sort(), ['Rafael Lima', 'Time comercial']);
  pedro.cleanup();
  asUser('u_julia'); // Financeiro
  const julia = await mountInbox();
  assert.deepEqual(roomTitles(julia.host), [], 'sem salas ainda');
  assert.match(text($(julia.host, '.chat-rooms__none')), /Nenhuma conversa ainda/);
  if (!canAccess('conversation', 'read')) {
    assert.ok(!$(julia.host, '.inbox-modes'), 'sem atendimento: nada para alternar');
    assert.equal($(julia.host, '.chat').closest('.inbox-pane').hidden, false, 'abre direto no chat');
  }
  julia.cleanup();
  asUser('u_marina');
});
