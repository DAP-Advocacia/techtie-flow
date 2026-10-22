// Página do negócio (#/deal?id=…) no DOM simulado: destaque, Path (clique move, etapa final confirma), abas
// (Detalhes, Atividade, Proposta, Relacionados), edição com previsão de fechamento, exclusão e permissões.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, fire, tick, waitFor, $, $$, text } from './dom-env.mjs';

installDom();
const { store } = await import('../../public/js/store.js');
const dealScreen = (await import('../../public/js/screens/deal.js')).default;
const { pathSteps } = await import('../../public/js/screens/pipeline/path.js');
const P = await import('../../public/js/screens/pipeline/perm.js');

const asRole = (role) => (store.state.currentUserId = store.state.users.find((u) => (u.roleIds || []).includes(role) && !u.isBot).id);
let navigated = null;

async function mountDeal(id) {
  document.getElementById('app').replaceChildren();
  location.hash = `#/deal?id=${id}`;
  const host = document.createElement('div');
  document.getElementById('app').append(host);
  const cleanup = await dealScreen.mount(host, { store, navigate: (to) => (navigated = to), route: { id: 'deal' } });
  return { host, cleanup };
}
const tab = (host, id) => $(host, `.deal-tab[data-tab="${id}"]`);
let deal;
let title0; // `deal` é o objeto do estado (muda ao editar): guarda o título original

before(() => {
  asRole('role_admin');
  // um negócio aberto, com contato e itens, numa etapa que NÃO é a primeira nem final
  deal = store.state.deals.find((d) => !(store.stage(d.stageId)?.kind) && d.contactId); // etapa aberta (no protótipo `kind` fica indefinido)
  title0 = deal.title;
  store.update((s) => {
    const d = s.deals.find((x) => x.id === deal.id);
    d.items = [{ productId: 'p1', name: 'Plano Pro', qty: 2, unitPrice: 500, note: '2 × mês', total: 1000 }];
    d.value = 1000;
    d.expectedClose = '2026-12-31';
    s.tasks = [];
    s.timeline = { ...(s.timeline || {}), [d.contactId]: [{ text: 'Negócio criado em Qualificação', who: 'Marina', at: Date.now() - 86400000 }, { text: 'Proposta enviada por WhatsApp', who: 'Marina', at: Date.now() - 3600000 }] };
  });
});

test('negócio inexistente (ou sem acesso): mensagem clara e volta para Negócios', async () => {
  const { host, cleanup } = await mountDeal('nao-existe');
  assert.match(text($(host, '.deal-missing')), /Negócio não encontrado/);
  assert.equal($(host, '.deal-missing a').getAttribute('href'), '#/pipeline');
  cleanup();
});

test('destaque: título, funil, contato, valor, responsável, etapa, previsão e ações; Path com todas as etapas', async () => {
  const { host, cleanup } = await mountDeal(deal.id);
  const pipeline = store.pipeline(deal.pipelineId);
  assert.equal($(host, '.deal-head__title').textContent, deal.title);
  assert.match(text($(host, '.deal-head .eyebrow')), new RegExp(pipeline.name.toUpperCase()));
  assert.match(text($(host, '.deal-facts')), /R\$\s?1\.000/);
  assert.match(text($(host, '.deal-facts')), /31\/12\/2026/, 'previsão de fechamento formatada');
  assert.match(text($(host, '.deal-facts')), new RegExp(store.stage(deal.stageId).name));
  assert.equal($$(host, '.path__step').length, pipeline.stages.length);
  const cur = $$(host, '.path__item--current');
  assert.equal(cur.length, 1);
  assert.match(cur[0].textContent, new RegExp(store.stage(deal.stageId).name));
  assert.ok($$(host, '.path__item--done').length >= 0);
  assert.ok($(host, '.deal-head__actions button[data-focus="edit"]'), 'Editar');
  assert.match(text($(host, '.deal-head__actions')), /Enviar proposta/);
  assert.equal($(host, '.deal-head__sub a').getAttribute('href'), `#/contacts?c=${deal.contactId}`);
  cleanup();
});

test('Path: etapas anteriores marcadas como feitas e cada estado correto (função pura)', () => {
  const pipeline = { stages: [{ id: 'a', kind: 'open' }, { id: 'b', kind: 'open' }, { id: 'c', kind: 'open' }, { id: 'w', kind: 'won' }, { id: 'l', kind: 'lost' }] };
  assert.deepEqual(pathSteps(pipeline, { stageId: 'c' }).map((s) => s.state), ['done', 'done', 'current', 'todo', 'todo']);
  assert.deepEqual(pathSteps(pipeline, { stageId: 'w' }).map((s) => s.state), ['done', 'done', 'done', 'current', 'todo'], 'ganho: as abertas anteriores ficam feitas, perdido não');
  assert.deepEqual(pathSteps(pipeline, { stageId: 'a' }).map((s) => s.state), ['current', 'todo', 'todo', 'todo', 'todo']);
  assert.deepEqual(pathSteps(pipeline, { stageId: 'zzz' }).map((s) => s.state), ['todo', 'todo', 'todo', 'todo', 'todo'], 'etapa desconhecida: nenhuma atual');
  assert.deepEqual(pathSteps(null, { stageId: 'a' }), []);
});

test('Path: clicar numa etapa aberta move o negócio (e a página se atualiza); etapa final pede confirmação', async () => {
  const { host, cleanup } = await mountDeal(deal.id);
  const pipeline = store.pipeline(deal.pipelineId);
  const open = pipeline.stages.filter((s) => !s.kind);
  const target = open.find((s) => s.id !== deal.stageId);
  $(host, `.path__step[data-stage="${target.id}"]`).click();
  await tick(30);
  assert.equal(store.deal(deal.id).stageId, target.id, 'moveu');
  assert.match(text($(host, '.path__item--current')), new RegExp(target.name), 'o Path acompanha');
  assert.match(text($(host, '.deal-facts')), new RegExp(target.name));

  const won = pipeline.stages.find((s) => s.kind === 'won');
  $(host, `.path__step[data-stage="${won.id}"]`).click();
  const confirmBtn = await waitFor(() => $$(document, '.pipeline-modal button').find((b) => /Marcar como ganho/.test(b.textContent)));
  assert.equal(store.deal(deal.id).stageId, target.id, 'ainda não moveu: falta confirmar');
  confirmBtn.click();
  await tick(30);
  assert.equal(store.deal(deal.id).stageId, won.id, 'ganho depois de confirmar');
  assert.match(text($(host, '.deal-stage')), new RegExp(won.name));
  assert.ok($(host, '.path__item--won.path__item--current'));
  // volta para uma etapa aberta (deixa o estado como estava para os próximos testes)
  const back = open[0];
  $(host, `.path__step[data-stage="${back.id}"]`).click();
  await tick(30);
  assert.equal(store.deal(deal.id).stageId, back.id);
  cleanup();
});

test('abas: Detalhes (campos), Atividade (linha do tempo), Proposta (itens) e Relacionados (tarefas, contato, conversas, acesso)', async () => {
  const { host, cleanup } = await mountDeal(deal.id);
  assert.match(text($(host, '.deal-grid')), /Previsão de fechamento/);
  assert.match(text($(host, '.deal-grid')), /Situação.*Aberto/);

  tab(host, 'activity').click();
  await waitFor(() => $(host, '.deal-timeline'));
  assert.match(text($(host, '.deal-timeline')), /Negócio criado em Qualificação/);
  assert.match(text($(host, '.deal-timeline')), /Proposta enviada por WhatsApp/);

  tab(host, 'proposal').click();
  assert.match(text($(host, '.deal-proposal')), /Plano Pro/);
  assert.match(text($(host, '.deal-proposal')), /R\$\s?1\.000/);
  assert.ok($(host, '.deal-proposal .pipeline-add'), 'adicionar produto');
  assert.equal($(host, '.deal-proposal .pipeline-panel__title'), null, 'sem cabeçalho duplicado no modo compacto');
  assert.equal($(host, '.deal-proposal .tasks-mini'), null, 'tarefas ficam na aba Relacionados');

  tab(host, 'related').click();
  assert.ok($(host, '.tasks-mini'), 'bloco de tarefas');
  assert.ok($(host, '.pipeline-share'), 'bloco de acesso');
  assert.ok($(host, '.deal-contact'), 'contato');
  assert.match(text($(host, '.deal-contact')), new RegExp(store.contact(deal.contactId).name.split(' ')[0]));
  assert.ok($(host, '.deal-convs'));
  cleanup();
});

test('tarefa criada na aba Relacionados já nasce ligada ao negócio e ao contato', async () => {
  const { host, cleanup } = await mountDeal(deal.id);
  tab(host, 'related').click();
  const add = $$($(host, '.tasks-mini'), 'button').find((b) => /\+ Tarefa/.test(b.textContent));
  add.click();
  const panel = $(document, '.tasks-panel');
  assert.equal($(panel, 'select[aria-label="Negócio vinculado"]').value, deal.id);
  assert.equal($(panel, 'select[aria-label="Contato vinculado"]').value, deal.contactId);
  const title = $(panel, '.tasks-title');
  title.value = 'Combinar assinatura';
  $$(panel, 'button').find((b) => /Criar tarefa/.test(b.textContent)).click();
  await waitFor(() => (store.state.tasks || []).find((t) => t.title === 'Combinar assinatura'));
  const t = store.state.tasks.find((x) => x.title === 'Combinar assinatura');
  assert.equal(t.dealId, deal.id);
  await tick(40);
  assert.match(text($(host, '.tasks-mini')), /Combinar assinatura/, 'a aba mostra a tarefa nova');
  cleanup();
});

test('editar: título, valor e previsão de fechamento; a página mostra o novo', async () => {
  const { host, cleanup } = await mountDeal(deal.id);
  $(host, '.deal-head__actions button[data-focus="edit"]').click();
  const modal = await waitFor(() => $(document, '.pipeline-modal'));
  const date = $(modal, 'input[type="date"]');
  assert.equal(date.value, '2026-12-31');
  const title = $(modal, 'input[type="text"]');
  title.value = `${title0} (editado)`;
  date.value = '2027-01-20';
  fire($(modal, 'form'), 'submit'); // linkedom não dispara o envio do formulário ao clicar no botão
  await tick(40);
  assert.equal(store.deal(deal.id).title, `${title0} (editado)`);
  assert.equal(store.deal(deal.id).expectedClose, '2027-01-20');
  assert.match(text($(host, '.deal-facts')), /20\/01\/2027/);
  // limpar a previsão
  $(host, '.deal-head__actions button[data-focus="edit"]').click();
  const modal2 = await waitFor(() => $(document, '.pipeline-modal'));
  $(modal2, 'input[type="date"]').value = '';
  fire($(modal2, 'form'), 'submit');
  await tick(40);
  assert.equal(store.deal(deal.id).expectedClose, null);
  assert.match(text($(host, '.deal-facts')), /Previsão de fechamento\s*—/);
  cleanup();
});

test('permissões: perfil só de leitura vê a página, mas sem Editar/Excluir e com o Path travado (com motivo)', async () => {
  const keep = store.state.currentUserId;
  try {
    asRole('role_viewer');
    const { host, cleanup } = await mountDeal(deal.id);
    assert.ok($(host, '.deal-head'), 'o perfil lê o negócio');
    assert.equal($(host, '.deal-head__actions button[data-focus="edit"]'), null, 'sem Editar');
    const steps = $$(host, '.path__step').filter((b) => !b.disabled);
    assert.ok(steps.length > 0 && steps.every((b) => b.getAttribute('aria-disabled') === 'true' && /permiss|perfil|Requer/i.test(b.getAttribute('title'))), 'etapas travadas com o motivo');
    const before = store.deal(deal.id).stageId;
    steps[0].click();
    await tick(30);
    assert.equal(store.deal(deal.id).stageId, before, 'clique em etapa travada não move');
    assert.equal($$(host, '.deal-danger').length, 0, 'sem Excluir');
    cleanup();
  } finally {
    store.state.currentUserId = keep;
  }
});

test('excluir: confirma, remove e volta para Negócios', async () => {
  const victim = store.state.deals.find((d) => d.id !== deal.id && P.deleteDecision(d).effect === 'allow');
  const { host, cleanup } = await mountDeal(victim.id);
  const del = $(host, '.deal-danger');
  assert.ok(del, 'o administrador pode excluir');
  del.click();
  const confirmBtn = await waitFor(() => $$(document, '.pipeline-modal button').find((b) => /Excluir negócio/.test(b.textContent)));
  navigated = null;
  confirmBtn.click();
  await tick(40);
  assert.ok(!store.state.deals.some((d) => d.id === victim.id), 'saiu do estado');
  assert.equal(navigated, 'pipeline', 'volta para a lista de negócios');
  assert.match(text($(host, '.deal-missing')), /Negócio não encontrado/);
  cleanup();
});
