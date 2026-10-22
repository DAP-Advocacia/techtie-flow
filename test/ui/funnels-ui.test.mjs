// Funis configuráveis no DOM simulado: lista, renomear, etapas (nome, tipo, probabilidade, ordem), motivos de perda,
// travas com negócios, e o motivo obrigatório ao perder um negócio. Perfis: Admin, Gestor (edita mas não cria/apaga) e Atendente.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, fire, tick, waitFor, $, $$, text } from './dom-env.mjs';

installDom();
const { store } = await import('../../public/js/store.js');
const funnelsScreen = (await import('../../public/js/screens/funnels.js')).default;
const A = await import('../../public/js/screens/funnels/actions.js');
const PA = await import('../../public/js/screens/pipeline/actions.js');
const { openConfirmMove } = await import('../../public/js/screens/pipeline/confirm-move.js');

const asUser = (id) => (store.state.currentUserId = id);
const snapshot = JSON.parse(JSON.stringify({ pipelines: store.state.pipelines, deals: store.state.deals, lossReasons: store.state.lossReasons, auditLog: store.state.auditLog }));
const restore = () =>
  store.update((s) => {
    s.pipelines = JSON.parse(JSON.stringify(snapshot.pipelines));
    s.deals = JSON.parse(JSON.stringify(snapshot.deals));
    s.lossReasons = JSON.parse(JSON.stringify(snapshot.lossReasons));
  });
const click = (el) => fire(el, 'click');
const typeIn = (input, value) => {
  input.value = value;
  fire(input, 'input');
};
const pick = (sel, value) => {
  sel.value = value;
  fire(sel, 'change');
};

async function mountFunnels() {
  document.getElementById('app').replaceChildren();
  location.hash = '#/funnels';
  const host = document.createElement('div');
  document.getElementById('app').append(host);
  const cleanup = await funnelsScreen.mount(host, { store, navigate: () => {} });
  return { host, cleanup };
}
const fk = (host, key) => $(host, `[data-fk="${key}"]`);
const rows = (host) => $$(host, '.funnels-stage');
const stageNames = (host) => rows(host).map((r) => $(r, '.funnels-stage__name').value);
const dialog = () => document.querySelector('.contacts-dialog');
const dialogBtn = (label) => [...dialog().querySelectorAll('button')].find((b) => text(b).includes(label));
const sel = (id) => click($(document, `[data-fk="pipe:${id}"]`));

test('Funis: lista os funis, mostra as etapas do escolhido e trava probabilidade de etapa ganha/perdida', async () => {
  restore();
  asUser('u_marina');
  const { host, cleanup } = await mountFunnels();
  const items = $$(host, '.funnels-item');
  assert.equal(items.length, store.state.pipelines.length);
  assert.match(text(items[0]), /etapas · \d+ neg/);
  const first = store.state.pipelines[0];
  assert.equal(stageNames(host).length, first.stages.length);
  assert.equal(fk(host, 'name').value, first.name);
  click(items.find((i) => /Comercial/.test(text(i))));
  assert.deepEqual(stageNames(host), ['Proposta', 'Negociação', 'Fechamento', 'Perdido']);
  const probs = rows(host).map((r) => [$(r, '.funnels-stage__prob').value, $(r, '.funnels-stage__prob').hasAttribute('disabled')]);
  assert.deepEqual(probs, [['50', false], ['75', false], ['100', true], ['0', true]], 'ganho = 100 e perdido = 0, travados');
  assert.equal(fk(host, 'save-stages').hasAttribute('disabled'), true, 'nada para salvar ainda');
  cleanup();
});

test('Funis: renomear, com aviso de nome repetido', async () => {
  restore();
  asUser('u_marina');
  const { host, cleanup } = await mountFunnels();
  sel('p_comercial');
  typeIn(fk(host, 'name'), 'sdr · vendas'); // não colide: o outro funil se chama "Vendas · SDR"
  click(fk(host, 'rename'));
  await waitFor(() => store.pipeline('p_comercial').name === 'sdr · vendas');
  await tick(20);
  typeIn(fk(host, 'name'), 'VENDAS · SDR');
  click(fk(host, 'rename'));
  await waitFor(() => /Já existe um funil/.test(text(host)));
  assert.equal(store.pipeline('p_comercial').name, 'sdr · vendas', 'nome repetido não grava');
  await tick(20);
  typeIn(fk(host, 'name'), 'Comercial');
  click(fk(host, 'rename'));
  await waitFor(() => store.pipeline('p_comercial').name === 'Comercial');
  assert.ok(store.state.auditLog.some((e) => e.action === 'pipeline.update'));
  cleanup();
});

test('Funis: editar etapas — nome, probabilidade, ordem, nova etapa; descartar volta ao salvo; salvar grava e audita', async () => {
  restore();
  asUser('u_marina');
  const { host, cleanup } = await mountFunnels();
  sel('p_sdr'); // Novo lead, Qualificação, Reunião, Ganho (sem etapa perdida)
  assert.equal(stageNames(host).length, 4);
  typeIn($(rows(host)[0], '.funnels-stage__name'), 'Lead novo');
  assert.equal(fk(host, 'save-stages').hasAttribute('disabled'), false, 'digitar liga o salvar');
  assert.equal(fk(host, 'discard-stages').hidden, false);
  click(fk(host, 'discard-stages'));
  assert.equal(stageNames(host)[0], 'Novo lead', 'descartar volta ao salvo');
  assert.equal(fk(host, 'save-stages').hasAttribute('disabled'), true);

  // sem etapa perdida: o servidor (e a tela) exigem uma
  typeIn($(rows(host)[0], '.funnels-stage__name'), 'Lead novo');
  click(fk(host, 'save-stages'));
  await waitFor(() => /etapa perdida/.test(text($(host, '.funnels-main'))));
  assert.equal(store.pipeline('p_sdr').stages[0].name, 'Novo lead', 'inválido não grava');

  // acrescenta a perdida, muda a ordem e a probabilidade
  click(fk(host, 'add-stage'));
  assert.equal(rows(host).length, 5);
  const created = rows(host)[3];
  typeIn($(created, '.funnels-stage__name'), 'Proposta enviada');
  pick($(created, '.funnels-stage__kind'), 'open');
  typeIn($(created, '.funnels-stage__prob'), '80');
  click(fk(host, 'add-stage'));
  const last = rows(host)[4];
  typeIn($(last, '.funnels-stage__name'), 'Perdido');
  pick($(last, '.funnels-stage__kind'), 'lost');
  assert.equal($(rows(host)[4], '.funnels-stage__prob').value, '0', 'perdida vira 0%');
  assert.equal($(rows(host)[4], '.funnels-stage__prob').hasAttribute('disabled'), true);
  click(fk(host, 'd4')); // a perdida desce para depois do Ganho
  click(fk(host, 'u3')); // e "Proposta enviada" sobe uma casa
  assert.deepEqual(stageNames(host), ['Lead novo', 'Qualificação', 'Proposta enviada', 'Reunião', 'Ganho', 'Perdido']);
  click(fk(host, 'save-stages'));
  await waitFor(() => store.pipeline('p_sdr').stages.length === 6);
  const saved = store.pipeline('p_sdr').stages;
  assert.deepEqual(saved.map((s) => [s.name, s.kind, s.probability]), [['Lead novo', 'open', 15], ['Qualificação', 'open', 35], ['Proposta enviada', 'open', 80], ['Reunião', 'open', 60], ['Ganho', 'won', 100], ['Perdido', 'lost', 0]]);
  assert.equal(saved[0].id, 's_novo', 'etapa que já existia mantém o id');
  assert.ok(saved[2].id && saved[2].id !== 's_novo', 'etapa nova ganhou id');
  assert.ok(store.state.auditLog.some((e) => e.action === 'pipeline.stages'));
  assert.equal(fk(host, 'save-stages').hasAttribute('disabled'), true, 'depois de salvar não há o que salvar');
  cleanup();
});

test('Funis: etapa com negócio não se remove nem muda de tipo; probabilidade e nome mudam à vontade', async () => {
  restore();
  asUser('u_marina');
  const { host, cleanup } = await mountFunnels();
  sel('p_comercial');
  const proposta = rows(host)[0]; // tem o negócio d1
  assert.equal($(proposta, '.funnels-x').hasAttribute('disabled'), true);
  assert.match($(proposta, '.funnels-x').getAttribute('title'), /mova antes de remover/);
  assert.equal($(proposta, '.funnels-stage__kind').hasAttribute('disabled'), true);
  assert.match(text($(proposta, '.funnels-stage__n')), /1 negócio/);
  typeIn($(proposta, '.funnels-stage__prob'), '55');
  typeIn($(proposta, '.funnels-stage__name'), 'Proposta comercial');
  click(fk(host, 'save-stages'));
  await waitFor(() => store.pipeline('p_comercial').stages[0].name === 'Proposta comercial');
  assert.equal(store.pipeline('p_comercial').stages[0].probability, 55);
  assert.equal(store.state.deals.find((d) => d.id === 'd1').stageId, 's_proposta', 'o negócio continua na etapa');
  // pela ação (sem a tela): também recusa
  const r = await A.saveStages('p_comercial', A.draftOf(store.pipeline('p_comercial')).filter((s) => s.id !== 's_proposta'));
  assert.equal(r.ok, false);
  assert.match(r.error, /“Proposta comercial” tem 1 negócio/);
  cleanup();
});

test('Funis: novo funil nasce com as etapas padrão e já fica selecionado; nome repetido avisa', async () => {
  restore();
  asUser('u_marina');
  const { host, cleanup } = await mountFunnels();
  click(fk(host, 'new'));
  assert.ok(dialog());
  const input = $(dialog(), 'input');
  input.value = 'comercial';
  fire($(dialog(), 'form'), 'submit');
  await waitFor(() => /Já existe um funil/.test(text(dialog())));
  input.value = 'Parcerias';
  fire($(dialog(), 'form'), 'submit');
  await waitFor(() => !dialog());
  const created = store.state.pipelines.find((p) => p.name === 'Parcerias');
  assert.ok(created);
  assert.deepEqual(created.stages.map((s) => [s.name, s.kind, s.probability]), [['Novo', 'open', 25], ['Qualificação', 'open', 50], ['Proposta', 'open', 75], ['Ganho', 'won', 100], ['Perdido', 'lost', 0]]);
  assert.equal(fk(host, 'name').value, 'Parcerias', 'o novo funil fica aberto para editar');
  cleanup();
});

test('Funis: excluir — com negócio não; vazio sim (com confirmação); a empresa mantém ao menos um', async () => {
  restore();
  asUser('u_marina');
  const { host, cleanup } = await mountFunnels();
  sel('p_comercial');
  assert.match(text($(host, '.funnels-card--danger')), /tem \d+ negócio/);
  click(fk(host, 'delete'));
  click(dialogBtn('Excluir funil'));
  await waitFor(() => /tem \d+ negócio/.test(text(dialog())));
  assert.ok(store.pipeline('p_comercial'), 'não excluiu');
  click(dialogBtn('Cancelar'));
  // um funil vazio: o Pós-venda do protótipo não tem negócios
  sel('p_posvenda');
  click(fk(host, 'delete'));
  click(dialogBtn('Excluir funil'));
  await waitFor(() => !store.pipeline('p_posvenda'));
  await waitFor(() => !dialog());
  // sobra só o último: a ação recusa apagar o único funil
  store.update((s) => (s.pipelines = s.pipelines.filter((p) => p.id === 'p_sdr').map((p) => ({ ...p }))));
  store.update((s) => (s.deals = []));
  const r = await A.deletePipeline('p_sdr');
  assert.equal(r.ok, false);
  assert.match(r.error, /pelo menos um funil/);
  cleanup();
});

test('Funis: motivos de perda — sugerir, editar, salvar; repetido avisa; vazio libera o motivo livre', async () => {
  restore();
  asUser('u_marina');
  const { host, cleanup } = await mountFunnels();
  assert.deepEqual(store.state.lossReasons, []);
  assert.match(text($(host, '[aria-label="Motivos de perda"]')), /Nenhum motivo cadastrado/);
  click(fk(host, 'suggest'));
  const inputs = () => $$(host, '.funnels-reason .input');
  assert.ok(inputs().length >= 6);
  assert.equal(inputs()[0].value, 'Preço acima do orçamento');
  typeIn(inputs()[0], 'Preço');
  typeIn(inputs()[1], 'preço'); // repetido
  click(fk(host, 'save-reasons'));
  await waitFor(() => /repetidos/.test(text($(host, '[aria-label="Motivos de perda"]'))));
  await tick(20);
  assert.deepEqual(store.state.lossReasons, [], 'repetido não grava');
  typeIn(inputs()[1], 'Escolheu concorrente');
  click(fk(host, 'save-reasons'));
  await waitFor(() => store.state.lossReasons.length > 0);
  await tick(20);
  assert.equal(store.state.lossReasons[0].name, 'Preço');
  assert.ok(store.state.lossReasons.some((r) => r.name === 'Escolheu concorrente'));
  assert.ok(store.state.auditLog.some((e) => e.action === 'pipeline.loss_reasons'));
  // apagar todos
  while (inputs().length) click($(host, '.funnels-reason .funnels-x'));
  click(fk(host, 'save-reasons'));
  await waitFor(() => store.state.lossReasons.length === 0);
  cleanup();
});

test('Perder negócio: com motivos cadastrados é obrigatório e precisa ser um deles; sem lista é opcional', async () => {
  restore();
  asUser('u_marina');
  // sem lista: opcional (comportamento de sempre)
  const open = () => store.state.deals.find((d) => d.id === 'd3');
  assert.equal(PA.moveDeal('d3', 's_perdido', { reason: '' }).ok, true);
  assert.equal(open().stageId, 's_perdido');
  assert.equal(PA.moveDeal('d3', 's_negoc').ok, true);
  assert.equal(open().lostReason, undefined, 'reabrir limpa o motivo');

  store.update((s) => (s.lossReasons = [{ id: 'a', name: 'Preço' }, { id: 'b', name: 'Sem resposta' }]));
  const r1 = PA.moveDeal('d3', 's_perdido', { reason: '' });
  assert.equal(r1.ok, false);
  assert.equal(r1.error, 'Informe o motivo da perda.');
  assert.equal(PA.moveDeal('d3', 's_perdido', { reason: 'Porque sim' }).ok, false, 'fora da lista');
  assert.equal(open().stageId, 's_negoc', 'nada mudou');
  assert.equal(PA.moveDeal('d3', 's_perdido', { reason: ' Preço ' }).ok, true);
  assert.equal(open().lostReason, 'Preço');
  assert.equal(PA.moveDeal('d3', 's_fechamento').ok, true, 'ganho não pede motivo');

  // o diálogo de confirmação: select obrigatório
  let got = null;
  const dealD1 = store.state.deals.find((d) => d.id === 'd1');
  const lostStage = store.stage('s_perdido');
  openConfirmMove({ deal: dealD1, stage: lostStage, onConfirm: (reason) => (got = reason) });
  const modal = document.querySelector('[role="dialog"]');
  const select = modal.querySelector('select');
  assert.ok(select, 'com lista: escolher o motivo');
  const confirmBtn = [...modal.querySelectorAll('button')].find((b) => /Marcar como perdido/.test(text(b)));
  assert.equal(confirmBtn.hasAttribute('disabled'), true, 'sem escolher, não confirma');
  select.value = 'Sem resposta';
  fire(select, 'change');
  assert.equal(confirmBtn.hasAttribute('disabled'), false);
  click(confirmBtn);
  assert.equal(got, 'Sem resposta');
  store.update((s) => (s.lossReasons = []));
  openConfirmMove({ deal: dealD1, stage: lostStage, onConfirm: () => {} });
  const m2 = [...document.querySelectorAll('[role="dialog"]')].at(-1);
  assert.ok(m2.querySelector('textarea') && !m2.querySelector('select'), 'sem lista: texto livre opcional');
  click([...m2.querySelectorAll('button')].find((b) => /Cancelar/.test(text(b))));
  restore();
});

test('Funis: permissões — o Gestor edita funis mas não cria nem apaga; o Atendente não altera nada', async () => {
  restore();
  asUser('u_carla'); // Gestor: pipeline read + update
  const manager = await mountFunnels();
  assert.equal(fk(manager.host, 'new').hasAttribute('disabled'), true, 'sem permissão de criar');
  sel('p_comercial');
  assert.equal(fk(manager.host, 'delete').hasAttribute('disabled'), true, 'sem permissão de excluir');
  assert.equal(fk(manager.host, 'rename').hasAttribute('disabled'), false, 'pode renomear');
  assert.equal(fk(manager.host, 'add-stage').hasAttribute('disabled'), false);
  assert.equal((await A.createPipeline('Do gestor')).ok, false);
  assert.equal((await A.deletePipeline('p_posvenda')).ok, false);
  assert.equal((await A.renamePipeline('p_posvenda', 'Renomeado pelo gestor')).ok, true);
  manager.cleanup();

  asUser('u_pedro'); // Atendente: só lê funis
  const agent = await mountFunnels();
  assert.equal(fk(agent.host, 'new').hasAttribute('disabled'), true);
  assert.equal(fk(agent.host, 'rename').hasAttribute('disabled'), true);
  assert.equal(fk(agent.host, 'add-stage').hasAttribute('disabled'), true);
  assert.equal(fk(agent.host, 'save-reasons').hasAttribute('disabled'), true);
  const before = JSON.stringify(store.state.pipelines);
  assert.equal((await A.saveStages('p_comercial', A.draftOf(store.pipeline('p_comercial')))).ok, false);
  assert.equal((await A.renamePipeline('p_comercial', 'Invasão')).ok, false);
  assert.equal((await A.saveLossReasons(['A'])).ok, false);
  assert.equal(JSON.stringify(store.state.pipelines), before, 'nada mudou');
  agent.cleanup();
  asUser('u_marina');
  restore();
});
