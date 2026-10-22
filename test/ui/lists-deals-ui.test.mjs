// Negócios em lista (modo Lista do #/pipeline) no DOM simulado: alternador, visões de fábrica, filtros, abrir o negócio,
// ações em massa (mover, mudar responsável, excluir) e permissões (valor oculto não vira coluna; cada um só age no que o motor deixa).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, fire, $, $$, text } from './dom-env.mjs';

installDom();
const { store } = await import('../../public/js/store.js');
const pipelineScreen = (await import('../../public/js/screens/pipeline.js')).default;
const { visible, canAccess } = await import('../../public/js/access.js');

const DAY = 86400000;
const asUser = (id) => (store.state.currentUserId = id);
const initialDeals = JSON.parse(JSON.stringify(store.state.deals));
const initialUsers = JSON.parse(JSON.stringify(store.state.users));
const restore = () => {
  store.update((s) => {
    s.deals = JSON.parse(JSON.stringify(initialDeals));
    s.users = JSON.parse(JSON.stringify(initialUsers));
  });
  localStorage.removeItem('ttf:pipeline:mode');
  localStorage.removeItem('ttf:views:deals');
};
const patchDeal = (id, patch) => store.update((s) => Object.assign(s.deals.find((d) => d.id === id), patch));
const dealById = (id) => store.state.deals.find((d) => d.id === id);

async function mountPipeline() {
  document.getElementById('app').replaceChildren();
  location.hash = '#/pipeline';
  const host = document.createElement('div');
  document.getElementById('app').append(host);
  const cleanup = await pipelineScreen.mount(host, { store, navigate: () => {} });
  return { host, cleanup };
}
const PL = '.pipeline-list';
const click = (el) => fire(el, 'click');
const pick = (sel, value) => {
  sel.value = value;
  fire(sel, 'change');
};
const prows = (host) => $$(host, `${PL} .lt-row`);
const ptitles = (host) => prows(host).map((r) => text($(r, '.lt-td--main')));
const pheads = (host) => $$(host, `${PL} .lt-th`).map((th) => text(th).replace(/[↑↓]/g, '').trim());
const pviews = (host) => $(host, `${PL} .lt-views`);
const goList = (host) => click($(host, '[data-mode="list"]'));
const openFilters = (host) => click($(host, `${PL} [data-focus="panel:filters"]`));
const openPanelBtn = (host, name) => click($(host, `${PL} [data-focus="panel:${name}"]`));
const panelOf = (host) => $(host, `${PL} .lt-panel`);
const check = (row, on = true) => {
  const cb = $(row, '.lt-check');
  cb.checked = on;
  fire(cb, 'change');
};
const rowOf = (host, title) => prows(host).find((r) => text(r).includes(title));
const lastToast = () => text([...document.querySelectorAll('.toast')].at(-1));
const dialog = () => document.querySelector('.contacts-dialog');
const dialogBtn = (label) => [...dialog().querySelectorAll('button')].find((b) => text(b).includes(label));
const bar = (host) => $(host, `${PL} .lt-bulk`);

test('Negócios: o alternador troca o quadro pela lista (e lembra); visão padrão = Em aberto, só do funil escolhido', async () => {
  restore();
  asUser('u_marina');
  const { host, cleanup } = await mountPipeline();
  assert.equal($(host, '.pipeline').dataset.mode, 'board');
  goList(host);
  assert.equal($(host, '.pipeline').dataset.mode, 'list');
  assert.equal(localStorage.getItem('ttf:pipeline:mode'), 'list');
  assert.deepEqual(pheads(host).slice(1), ['Negócio', 'Contato', 'Etapa', 'Valor', 'Responsável', 'Previsão de fechamento', 'Criado em']);
  assert.equal(ptitles(host).length, 4, 'Comercial tem 4 negócios em aberto');
  assert.equal(ptitles(host)[0], 'Implantação CRM + WhatsApp', 'mais novo primeiro');
  assert.match(text($(host, `${PL} .lt-count`)), /4 negócios/);
  assert.match(text($(host, `${PL} .lt-count`)), /Soma R\$\s?100\.400/);
  assert.match(text($(host, `${PL} .lt-count`)), /ponderada R\$\s?70\.700/, 'valor × probabilidade da etapa');
  openPanelBtn(host, 'columns');
  assert.ok(/Valor ponderado/.test(text(panelOf(host))) && /Probabilidade/.test(text(panelOf(host))), 'colunas de probabilidade e valor ponderado disponíveis');
  openPanelBtn(host, 'columns');
  assert.match(text(rowOf(host, 'Implantação')), /Carlos Menezes/, 'contato aparece pelo nome');
  assert.match(text(rowOf(host, 'Implantação')), /Marina Alves/);
  assert.equal($(rowOf(host, 'Implantação'), 'a.lt-link').getAttribute('href'), '#/deal?id=d1');
  cleanup();
  const again = await mountPipeline();
  assert.equal($(again.host, '.pipeline').dataset.mode, 'list', 'a escolha é lembrada');
  click($(again.host, '[data-mode="board"]'));
  assert.equal($(again.host, '.pipeline').dataset.mode, 'board');
  again.cleanup();
});

test('Negócios (lista): visões de fábrica — ganhos, fechando este mês, parados, meus, sem tarefa', async () => {
  restore();
  asUser('u_marina');
  const today = new Date();
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  patchDeal('d6', { stageId: 's_fechamento' }); // ganho
  patchDeal('d3', { expectedClose: iso });
  patchDeal('d7', { stageChangedAt: Date.now() - 10 * DAY });
  const { host, cleanup } = await mountPipeline();
  goList(host);
  const labels = [...pviews(host).querySelectorAll('option')].map((o) => text(o));
  assert.deepEqual(labels.slice(0, 5), ['Em aberto', 'Todos os negócios', 'Meus em aberto', 'Fechando este mês', 'Parados há 7+ dias']);
  const view = (id) => pick(pviews(host), id);
  view('open');
  assert.deepEqual(ptitles(host).sort(), ['Dashboards de BI', 'Implantação CRM + WhatsApp', 'Plataforma de atendimento']);
  view('all');
  assert.equal(ptitles(host).length, 4);
  assert.match(text(rowOf(host, 'Integração Omie')), /Ganho/, 'situação');
  view('won');
  assert.deepEqual(ptitles(host), ['Integração Omie']);
  view('closing');
  assert.deepEqual(ptitles(host), ['Dashboards de BI']);
  view('stale');
  assert.deepEqual(ptitles(host), ['Plataforma de atendimento']);
  view('mine');
  assert.deepEqual(ptitles(host).sort(), ['Dashboards de BI', 'Implantação CRM + WhatsApp'], 'só os da Marina em aberto');
  view('notask');
  const withTask = new Set(visible('task', store.state.tasks || []).filter((t) => t.dealId && t.status !== 'done').map((t) => t.dealId));
  assert.deepEqual(ptitles(host).sort(), ['d1', 'd3', 'd7'].filter((id) => !withTask.has(id)).map((id) => dealById(id).title).sort());
  view('lost');
  assert.equal(prows(host).length, 0);
  assert.match(text($(host, `${PL} .lt-empty`)), /Nenhum resultado/);
  cleanup();
});

test('Negócios (lista): clicar na linha abre a página do negócio; cada funil guarda a própria lista', async () => {
  restore();
  asUser('u_marina');
  const { host, cleanup } = await mountPipeline();
  goList(host);
  pick(pviews(host), 'open'); // a lista lembra a visão da vez anterior
  click(rowOf(host, 'Dashboards de BI'));
  assert.equal(location.hash, '#/deal?id=d3');
  const pill = (name) => $$(host, '.pills [role="tab"]').find((b) => text(b) === name);
  click(pill('Vendas · SDR'));
  pick(pviews(host), 'open');
  assert.deepEqual(ptitles(host).sort(), ['Agente de IA p/ agendamento', 'Automação de cobrança', 'Site institucional']);
  openFilters(host);
  pick($(panelOf(host), '[data-focus="f-col"]'), 'stage');
  const stageNames = [...$(panelOf(host), '[data-focus="f-val"]').querySelectorAll('option')].map((o) => text(o));
  assert.ok(stageNames.includes('Qualificação') && !stageNames.includes('Negociação'), `etapas do funil SDR: ${stageNames}`);
  click(pill('Comercial'));
  assert.equal(ptitles(host).length, 4, 'voltou ao funil Comercial');
  cleanup();
});

test('Negócios (lista): filtros do negócio — etapa, valor — somam e a ordenação por valor funciona', async () => {
  restore();
  asUser('u_marina');
  const { host, cleanup } = await mountPipeline();
  goList(host);
  pick(pviews(host), 'open');
  openFilters(host);
  pick($(panelOf(host), '[data-focus="f-col"]'), 'stage');
  pick($(panelOf(host), '[data-focus="f-val"]'), 's_negoc');
  fire($(panelOf(host), 'form.lt-filter'), 'submit');
  assert.deepEqual(ptitles(host).sort(), ['Dashboards de BI', 'Integração Omie', 'Plataforma de atendimento']);
  assert.match(text($(host, `${PL} .lt-chips`)), /Etapa é Negociação/);
  pick($(panelOf(host), '[data-focus="f-col"]'), 'value');
  pick($(panelOf(host), '[data-focus="f-op"]'), 'gt');
  $(panelOf(host), '[data-focus="f-val"]').value = '20.000';
  fire($(panelOf(host), '[data-focus="f-val"]'), 'input');
  fire($(panelOf(host), 'form.lt-filter'), 'submit');
  assert.deepEqual(ptitles(host).sort(), ['Dashboards de BI', 'Plataforma de atendimento']);
  click($(host, `${PL} [data-focus="sort:value"]`));
  assert.equal(ptitles(host)[0], 'Plataforma de atendimento', 'valor crescente: 27.500 antes de 42.000');
  click($(host, `${PL} [data-focus="sort:value"]`));
  assert.equal(ptitles(host)[0], 'Dashboards de BI', 'decrescente');
  cleanup();
});

test('Negócios (lista): ações em massa — responsável, etapa (final pede confirmação) e exclusão', async () => {
  restore();
  asUser('u_marina');
  const { host, cleanup } = await mountPipeline();
  goList(host);
  pick(pviews(host), 'open');
  assert.equal(bar(host).hidden, true, 'sem seleção, sem barra');

  // selecionar 2 → barra com a contagem
  check(rowOf(host, 'Implantação'));
  check(rowOf(host, 'Dashboards'));
  assert.equal(bar(host).hidden, false);
  assert.match(text(bar(host)), /2 selecionados/);

  // mudar responsável
  pick($(bar(host), '[data-bulk="owner"]'), 'u_carla');
  assert.equal(dealById('d1').ownerId, 'u_carla');
  assert.equal(dealById('d3').ownerId, 'u_carla');
  assert.match(lastToast(), /2 negócios agora com Carla Souza/);
  assert.equal(bar(host).hidden, true, 'seleção limpa depois da ação');
  assert.match(text(rowOf(host, 'Implantação')), /Carla Souza/, 'a tabela já mostra o novo responsável');

  // mover para etapa aberta: o que já está lá fica de fora
  check(rowOf(host, 'Implantação')); // Proposta
  check(rowOf(host, 'Dashboards')); // já em Negociação
  pick($(bar(host), '[data-bulk="move"]'), 's_negoc');
  assert.equal(dealById('d1').stageId, 's_negoc');
  assert.match(lastToast(), /1 negócio movido para Negociação\. 1 não pôde ser alterado/);

  // etapa final: pede confirmação e só então move
  check(rowOf(host, 'Dashboards'));
  check(rowOf(host, 'Plataforma'));
  pick($(bar(host), '[data-bulk="move"]'), 's_fechamento');
  assert.ok(dialog(), 'confirmação');
  assert.match(text(dialog()), /Mover 2 negócios para Fechamento\?/);
  assert.equal(dealById('d3').stageId, 's_negoc', 'ainda não moveu');
  click(dialogBtn('Cancelar'));
  assert.equal(dialog(), null);
  assert.equal(dealById('d3').stageId, 's_negoc', 'cancelar não move');
  pick($(bar(host), '[data-bulk="move"]'), 's_fechamento');
  click(dialogBtn('Mover para Fechamento'));
  assert.equal(dealById('d3').stageId, 's_fechamento');
  assert.equal(dealById('d7').stageId, 's_fechamento');
  assert.match(lastToast(), /2 negócios movidos para Fechamento/);
  assert.equal(prows(host).filter((r) => /Dashboards|Plataforma/.test(text(r))).length, 0, 'saíram de "Em aberto"');

  // excluir: vê os ganhos, seleciona e confirma
  pick(pviews(host), 'won');
  assert.equal(prows(host).length, 2);
  check(rowOf(host, 'Dashboards'));
  click($(bar(host), '[data-bulk="delete"]'));
  assert.match(text(dialog()), /Excluir 1 negócio\?/);
  click(dialogBtn('Excluir'));
  assert.equal(dealById('d3'), undefined);
  assert.ok(dealById('d7'));
  assert.match(lastToast(), /1 negócio excluído/);
  assert.equal(prows(host).length, 1);
  cleanup();
});

test('Negócios (lista): selecionar todos marca todos os resultados do filtro e desmarcar limpa', async () => {
  restore();
  asUser('u_marina');
  const { host, cleanup } = await mountPipeline();
  goList(host);
  pick(pviews(host), 'open');
  const all = $(host, `${PL} [data-focus="sel-all"]`);
  all.checked = true;
  fire(all, 'change');
  assert.match(text(bar(host)), /4 selecionados/);
  assert.equal($$(host, `${PL} .lt-row.is-selected`).length, 4);
  const again = $(host, `${PL} [data-focus="sel-all"]`);
  again.checked = false;
  fire(again, 'change');
  assert.equal(bar(host).hidden, true);
  // uma seleção some quando o negócio sai da lista (filtro novo)
  check(rowOf(host, 'Implantação'));
  openFilters(host);
  pick($(panelOf(host), '[data-focus="f-col"]'), 'title');
  $(panelOf(host), '[data-focus="f-val"]').value = 'Dashboards';
  fire($(panelOf(host), '[data-focus="f-val"]'), 'input');
  fire($(panelOf(host), 'form.lt-filter'), 'submit');
  assert.equal(bar(host).hidden, true, 'a seleção só vale para o que está na lista');
  cleanup();
});

test('Negócios (lista): o SDR só age no que o motor deixa — sem botões que não tem, e Ganho continua negado em massa', async () => {
  restore();
  asUser('u_rafael');
  const { host, cleanup } = await mountPipeline();
  goList(host);
  pick(pviews(host), 'open');
  const mine = visible('deal', store.state.deals);
  assert.ok(mine.length > 0 && mine.length < store.state.deals.length, 'premissa: Rafael vê só parte dos negócios');
  assert.ok(prows(host).length > 0);
  const all = $(host, `${PL} [data-focus="sel-all"]`);
  all.checked = true;
  fire(all, 'change');
  assert.equal(!!$(bar(host), '[data-bulk="owner"]'), canAccess('deal', 'transfer'), 'responsável só aparece se o motor deixa transferir');
  assert.equal(!!$(bar(host), '[data-bulk="delete"]'), canAccess('deal', 'delete'), 'excluir só aparece se o motor deixa excluir');
  const before = JSON.stringify(store.state.deals.map((d) => [d.id, d.stageId]));
  pick($(bar(host), '[data-bulk="move"]'), 's_ganho_sdr');
  assert.equal(dialog(), null, 'sem confirmação: ninguém pode ir para Ganho');
  assert.match(lastToast(), /Nada foi alterado/);
  assert.equal(JSON.stringify(store.state.deals.map((d) => [d.id, d.stageId])), before);
  cleanup();
});

test('Negócios (lista): perfil sem valor não ganha coluna nem filtro de valor nem soma', async () => {
  restore();
  // Pedro ganha o perfil "Atendente · só Vendas SDR" (valor oculto) e um negócio no funil SDR
  store.update((s) => {
    s.users.find((u) => u.id === 'u_pedro').roleIds = ['role_t_jr_sdr'];
    s.deals.find((d) => d.id === 'd2').ownerId = 'u_pedro';
  });
  asUser('u_pedro');
  const { host, cleanup } = await mountPipeline();
  goList(host);
  assert.equal(ptitles(host).length > 0, true, `Pedro vê o negócio dele: ${ptitles(host)}`);
  const hs = pheads(host).join('|');
  assert.ok(!/Valor/.test(hs), hs);
  assert.ok(!/Soma/.test(text($(host, `${PL} .lt-count`))), 'sem soma de valores');
  openFilters(host);
  const cols = [...panelOf(host).querySelectorAll('[data-focus="f-col"] option')].map((o) => o.getAttribute('value'));
  assert.ok(!cols.includes('value'), 'não dá para filtrar pelo valor oculto');
  openPanelBtn(host, 'columns');
  assert.ok(!/Valor/.test(text(panelOf(host))), 'nem escolher a coluna');
  cleanup();
  restore();
  asUser('u_marina');
});

test('transferDeal: o motor decide — fora do escopo, usuário inexistente, robô ou inativo são recusados e nada muda', async () => {
  restore();
  const A = await import('../../public/js/screens/pipeline/actions.js');
  asUser('u_rafael'); // SDR: d1 (Comercial, da Marina) não é dele
  assert.equal(A.transferDeal('d1', 'u_pedro').ok, false);
  assert.equal(dealById('d1').ownerId, 'u_marina');
  asUser('u_marina');
  assert.equal(A.transferDeal('d1', 'u_inexistente').ok, false, 'usuário que não existe');
  assert.equal(A.transferDeal('d1', 'u_ia').ok, false, 'robô não é responsável');
  assert.equal(A.transferDeal('d1', 'u_bia').ok, false, 'convidada (ainda não ativa)');
  assert.equal(dealById('d1').ownerId, 'u_marina');
  const r = A.transferDeal('d1', 'u_carla');
  assert.equal(r.ok, true);
  assert.equal(dealById('d1').ownerId, 'u_carla');
  assert.equal(dealById('d1').teamId, 'tm_comercial', 'a equipe acompanha o novo responsável');
  assert.ok(store.state.auditLog.some((e) => e.action === 'deal.transfer' && e.target === 'd1'));
  restore();
});
