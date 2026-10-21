// Telas de Tarefas executadas num DOM simulado (sem navegador): criar rápido, concluir, painel (editar, checklist,
// delegar, comentar), criar pelo painel já vinculado, quadro com arrastar, blocos em Início/Contatos e permissões.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, fire, tick, $, $$, text } from './dom-env.mjs';

installDom();
const { store } = await import('../../public/js/store.js');
const tasksScreen = (await import('../../public/js/screens/tasks.js')).default;
const homeScreen = (await import('../../public/js/screens/home.js')).default;
const contactsScreen = (await import('../../public/js/screens/contacts.js')).default;
const { openTaskPanel } = await import('../../public/js/screens/tasks/panel.js');
const A = await import('../../public/js/screens/tasks/actions.js');
const { access } = { access: await import('../../public/js/access.js') };

const root = () => document.getElementById('app');
const mount = async (screen, route = 'x') => {
  root().replaceChildren();
  const host = document.createElement('div');
  root().append(host);
  const cleanup = await screen.mount(host, { store, navigate: (id) => (globalThis.__nav = id), route });
  return { host, cleanup };
};
const panelEl = () => document.querySelector('.tasks-panel');
const closePanel = () => $(document, '.tasks-close')?.click();
let me;
let other;

before(() => {
  // uma pessoa com perfil que cria/delega/compartilha tarefas (a primeira ativa que não seja robô) + uma colega
  const admin = store.state.users.find((u) => !u.isBot && u.status === 'active' && (u.roleIds || []).includes('role_admin')) || store.state.users.find((u) => !u.isBot && u.status === 'active');
  store.state.currentUserId = admin.id;
  me = admin;
  other = store.state.users.find((u) => !u.isBot && u.status === 'active' && u.id !== admin.id);
  store.state.tasks = [];
  access.audit; // garante o módulo carregado
});

test('tela Tarefas vazia: orienta a criar e mostra o campo de criar rápido', async () => {
  const { host, cleanup } = await mount(tasksScreen);
  assert.match(text($(host, '.tasks-empty')), /Nenhuma tarefa por aqui/);
  assert.ok($(host, '.tasks-quick-input'));
  assert.ok($$(host, '.tasks-tab').length >= 1);
  cleanup();
});

test('criar rápido: "ligar para a Carla amanhã 10h !alta" vira tarefa com prazo e prioridade, e aparece na lista', async () => {
  const { host, cleanup } = await mount(tasksScreen);
  const input = $(host, '.tasks-quick-input');
  input.value = 'Ligar para a Carla amanhã 10h !alta';
  fire(input, 'input');
  const preview = text($(host, '.tasks-quick-preview'));
  assert.match(preview, /Ligar para a Carla/);
  assert.match(preview, /Amanhã 10:00/);
  assert.match(preview, /alta/);
  fire(input, 'keydown', { key: 'Enter', isComposing: false });
  await tick(20);
  assert.equal(store.state.tasks.length, 1);
  const t = store.state.tasks[0];
  assert.equal(t.title, 'Ligar para a Carla');
  assert.equal(t.priority, 'high');
  assert.equal(t.dueHasTime, true);
  assert.equal(t.ownerId, me.id);
  assert.equal(input.value, '', 'o campo limpa');
  assert.equal($$(host, '.tasks-row').length, 1);
  assert.match(text($(host, '.tasks-row')), /Ligar para a Carla/);
  assert.match(text($(host, '.tasks-row')), /Amanhã 10:00/);
  assert.ok($(host, '.tasks-flag--high'), 'bandeira de prioridade alta');
  assert.match(text($(host, '.tasks-group--next7 .tasks-group__label')), /Próximos 7 dias/);
  // título vazio / só espaços não cria
  input.value = '   ';
  fire(input, 'keydown', { key: 'Enter' });
  await tick(10);
  assert.equal(store.state.tasks.length, 1);
  cleanup();
});

test('concluir na lista: marca como feita, vai para "Concluídas" (recolhido) e pode reabrir', async () => {
  const { host, cleanup } = await mount(tasksScreen);
  $(host, '.tasks-check-btn').click();
  await tick(10);
  assert.equal(store.state.tasks[0].status, 'done');
  assert.ok(store.state.tasks[0].completedAt);
  assert.equal($$(host, '.tasks-row').length, 0, 'concluídas ficam recolhidas');
  $(host, '.tasks-group--done .tasks-group__head').click();
  await tick(10);
  assert.equal($$(host, '.tasks-row.is-done').length, 1);
  $(host, '.tasks-row.is-done .tasks-check-btn').click();
  await tick(10);
  assert.equal(store.state.tasks[0].status, 'todo');
  assert.equal(store.state.tasks[0].completedAt, null);
  cleanup();
});

test('painel: abre pela lista, edita título, prioridade, prazo (atalho), descrição e checklist com salvamento imediato', async () => {
  const { host, cleanup } = await mount(tasksScreen);
  $(host, '.tasks-row__main').click();
  const p = panelEl();
  assert.ok(p, 'o painel abriu');
  const title = $(p, '.tasks-title');
  assert.equal(title.value, 'Ligar para a Carla');
  title.value = 'Ligar para a Carla (fornecedor)';
  fire(title, 'blur');
  assert.equal(store.state.tasks[0].title, 'Ligar para a Carla (fornecedor)');
  title.value = '   ';
  fire(title, 'blur');
  assert.equal(title.value, 'Ligar para a Carla (fornecedor)', 'título vazio volta ao anterior');
  $$(p, '.tasks-prio').find((b) => b.dataset.prio === 'urgent').click();
  assert.equal(store.state.tasks[0].priority, 'urgent');
  $$(p, '.tasks-chipbtn').find((b) => /Hoje/.test(b.textContent)).click();
  const today = new Date();
  assert.equal(new Date(store.state.tasks[0].dueAt).getDate(), today.getDate(), 'atalho "Hoje" define o prazo');
  $$(p, '.tasks-chipbtn').find((b) => /Sem prazo/.test(b.textContent)).click();
  assert.equal(store.state.tasks[0].dueAt, null);
  const desc = $(p, 'textarea[aria-label="Descrição"]');
  desc.value = 'Pedir prazo e desconto';
  fire(desc, 'blur');
  assert.equal(store.state.tasks[0].description, 'Pedir prazo e desconto');
  // checklist
  const add = $(p, 'input[aria-label="Novo item do checklist"]');
  add.value = 'Levantar CNPJ';
  fire(add, 'keydown', { key: 'Enter' });
  add.value = 'Anotar proposta';
  fire(add, 'keydown', { key: 'Enter' });
  assert.deepEqual(store.state.tasks[0].checklist.map((i) => i.text), ['Levantar CNPJ', 'Anotar proposta']);
  const first = $(panelEl(), '.tasks-check__row input[type="checkbox"]');
  first.checked = true;
  fire(first, 'change');
  assert.equal(store.state.tasks[0].checklist[0].done, true);
  assert.match(text($(panelEl(), '.tasks-check__bar')) + $(panelEl(), '.tasks-check__bar').getAttribute('aria-label'), /1 de 2/);
  closePanel();
  assert.equal(panelEl(), null, 'fechou');
  await tick(20);
  assert.match(text($(host, '.tasks-row')), /1\/2/, 'a lista mostra o progresso do checklist');
  cleanup();
});

test('painel: delegar para outra pessoa, comentar e ver o histórico', async () => {
  const { cleanup } = await mount(tasksScreen);
  openTaskPanel({ taskId: store.state.tasks[0].id });
  const p = panelEl();
  const owner = $(p, 'select[aria-label="Responsável"]');
  assert.equal(owner.disabled, false, 'este perfil pode delegar');
  owner.value = other.id;
  fire(owner, 'change');
  await tick(20);
  assert.equal(store.state.tasks[0].ownerId, other.id);
  assert.ok((store.state.taskComments[store.state.tasks[0].id] || []).some((c) => c.kind === 'event' && /delegou/.test(c.text)), 'o histórico registra a delegação');
  const box = $(panelEl(), 'textarea[aria-label="Comentário"]');
  box.value = 'Combinado com o fornecedor';
  $$(panelEl(), 'button').find((b) => b.textContent.trim() === 'Comentar').click();
  await tick(30);
  assert.match(text($(panelEl(), '.tasks-timeline')), /Combinado com o fornecedor/);
  assert.match(text($(panelEl(), '.tasks-timeline')), /delegou a tarefa para/);
  closePanel();
  cleanup();
});

test('criar pelo painel já vinculado a um negócio (e o contato do negócio vem junto)', async () => {
  const deal = store.state.deals[0];
  assert.ok(deal, 'o protótipo traz negócios');
  openTaskPanel({ defaults: { dealId: deal.id, contactId: deal.contactId } });
  const p = panelEl();
  assert.equal($(p, 'select[aria-label="Negócio vinculado"]').value, deal.id);
  const create = $$(p, 'button').find((b) => /Criar tarefa/.test(b.textContent));
  create.click();
  await tick(10);
  assert.equal(store.state.tasks.length, 1, 'sem título não cria');
  assert.ok(panelEl(), 'o painel continua aberto');
  const title = $(panelEl(), '.tasks-title');
  title.value = 'Enviar contrato revisado';
  create.click();
  await tick(20);
  const t = store.state.tasks.find((x) => x.title === 'Enviar contrato revisado');
  assert.ok(t);
  assert.equal(t.dealId, deal.id);
  assert.equal(t.contactId, deal.contactId);
  assert.equal(panelEl(), null, 'fechou ao criar');
});

test('quadro: arrastar o cartão para outra coluna muda o status', async () => {
  const { host, cleanup } = await mount(tasksScreen);
  $(host, '.tasks-mode--board').click();
  await tick(10);
  assert.equal($$(host, '.tasks-col').length, 4);
  const card = $$(host, '.tasks-card').find((c) => /Enviar contrato revisado/.test(c.textContent));
  assert.ok(card);
  const dt = { effectAllowed: '', setData() {} };
  fire(card, 'dragstart', { dataTransfer: dt });
  const target = $(host, '.tasks-col--waiting');
  fire(target, 'dragover', { dataTransfer: dt });
  fire(target, 'drop', { dataTransfer: dt });
  await tick(10);
  assert.equal(store.state.tasks.find((x) => x.title === 'Enviar contrato revisado').status, 'waiting');
  $(host, '.tasks-mode[data-mode="list"]').click();
  await tick(10);
  assert.equal($$(host, '.tasks-col').length, 0);
  cleanup();
});

test('visões: a tarefa delegada some de "Minhas" e aparece em "Delegadas por mim"; filtro por título', async () => {
  const { host, cleanup } = await mount(tasksScreen);
  const tabLabels = $$(host, '.tasks-tab').map((b) => b.textContent);
  assert.ok(tabLabels.some((t) => /Minhas/.test(t)));
  assert.ok(tabLabels.some((t) => /Delegadas por mim/.test(t)), 'há tarefa que eu criei e passei adiante');
  assert.ok(!$$(host, '.tasks-row__title').some((e) => /Ligar para a Carla/.test(e.textContent)), 'a delegada não está em Minhas');
  $$(host, '.tasks-tab').find((b) => /Delegadas por mim/.test(b.textContent)).click();
  await tick(10);
  assert.ok($$(host, '.tasks-row__title').some((e) => /Ligar para a Carla/.test(e.textContent)));
  $$(host, '.tasks-tab').find((b) => /Minhas/.test(b.textContent)).click();
  const search = $(host, '.tasks-search');
  search.value = 'contrato';
  fire(search, 'input');
  await tick(10);
  assert.deepEqual($$(host, '.tasks-row__title').map((e) => e.textContent), ['Enviar contrato revisado']);
  search.value = 'zzz';
  fire(search, 'input');
  await tick(10);
  assert.match(text($(host, '.tasks-empty')), /Nada nesta visão|Nenhuma tarefa/);
  cleanup();
});

test('Início: mostra as tarefas de hoje/atrasadas e o atalho para Tarefas', async () => {
  const day = new Date();
  A.allTasks().find((t) => t.title === 'Enviar contrato revisado');
  store.update((s) => {
    const t = s.tasks.find((x) => x.title === 'Enviar contrato revisado');
    t.ownerId = me.id;
    t.status = 'todo';
    t.dueAt = new Date(day.getFullYear(), day.getMonth(), day.getDate() - 1, 12).getTime(); // ontem: atrasada
    t.dueHasTime = false;
  });
  const { host, cleanup } = await mount(homeScreen);
  assert.match(text(host), /tarefas para hoje · 1 atrasada/);
  assert.match(text($(host, '.tasks-mini')), /Enviar contrato revisado/);
  assert.ok($$(host, 'a.home-tile').some((a) => a.getAttribute('href') === '#/tasks'));
  // concluir direto pelo Início
  $(host, '.tasks-mini .tasks-check-btn').click();
  await tick(10);
  assert.equal(store.state.tasks.find((x) => x.title === 'Enviar contrato revisado').status, 'done');
  cleanup();
});

test('Contatos: a ficha mostra as tarefas do contato e o botão de criar uma nova já com o contato', async () => {
  const contact = store.state.contacts[0];
  store.update((s) => s.tasks.push({ id: 't_c', title: 'Retornar para o contato', status: 'todo', priority: 'normal', dueAt: null, dueHasTime: false, ownerId: me.id, teamId: null, createdBy: me.id, dealId: null, contactId: contact.id, checklist: [], completedAt: null, createdAt: 1, updatedAt: 1, sharedWith: [] }));
  const { host, cleanup } = await mount(contactsScreen);
  $$(host, '.contacts-item').find((b) => b.textContent.includes(contact.name)).click();
  await tick(10);
  const block = $(host, '.tasks-mini');
  assert.ok(block, 'bloco de tarefas na ficha');
  assert.match(text(block), /Retornar para o contato/);
  $$(block, 'button').find((b) => /\+ Tarefa/.test(b.textContent)).click();
  assert.equal($(panelEl(), 'select[aria-label="Contato vinculado"]').value, contact.id, 'o contato já vem preenchido');
  closePanel();
  cleanup();
});

test('permissões: sem permissão de criar, a tela não oferece criar e o motor barra a ação; leitura não edita', async () => {
  // perfil só leitura: "Somente leitura"
  const viewer = store.state.users.find((u) => !u.isBot && u.status === 'active' && (u.roleIds || []).includes('role_viewer'));
  assert.ok(viewer, 'o protótipo traz um usuário com perfil de leitura');
  const keep = store.state.currentUserId;
  store.state.currentUserId = viewer.id;
  assert.equal(A.canCreate(), false);
  const r = await A.createTask({ title: 'Não deveria criar' });
  assert.equal(r.ok, false);
  assert.ok(r.decision, 'barrada pelo motor');
  const t = store.state.tasks[0];
  assert.equal(A.patchTask(t.id, { title: 'invasão' }).ok, false);
  assert.notEqual(store.state.tasks[0].title, 'invasão');
  const { host, cleanup } = await mount(tasksScreen);
  assert.equal($(host, '.tasks-new').hidden, true, 'botão "Nova tarefa" escondido');
  assert.equal($(host, '.tasks-quick-input').disabled, true);
  cleanup();
  store.state.currentUserId = keep;
});
