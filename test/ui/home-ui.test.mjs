// Início no DOM simulado: "Fechando este mês" (previsão de fechamento) e meta de receita do mês, com permissões por perfil
// e o atalho "Ver todos" que abre a lista de Negócios já na visão certa.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, fire, $, $$, text } from './dom-env.mjs';

installDom();
const { store } = await import('../../public/js/store.js');
const homeScreen = (await import('../../public/js/screens/home.js')).default;
const pipelineScreen = (await import('../../public/js/screens/pipeline.js')).default;

const asUser = (id) => (store.state.currentUserId = id);
const click = (el) => fire(el, 'click');
const initial = JSON.parse(JSON.stringify({ deals: store.state.deals, users: store.state.users, tenant: store.state.tenant }));
const restore = () =>
  store.update((s) => {
    s.deals = JSON.parse(JSON.stringify(initial.deals));
    s.users = JSON.parse(JSON.stringify(initial.users));
    s.tenant = JSON.parse(JSON.stringify(initial.tenant));
  });
const patchDeal = (id, patch) => store.update((s) => Object.assign(s.deals.find((d) => d.id === id), patch));

const now = new Date();
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const thisMonthDay = (day) => iso(new Date(now.getFullYear(), now.getMonth(), day));
const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
const nextMonthDay = iso(new Date(now.getFullYear(), now.getMonth() + 1, 5));

async function mountHome() {
  document.getElementById('app').replaceChildren();
  location.hash = '#/home';
  const host = document.createElement('div');
  document.getElementById('app').append(host);
  const cleanup = await homeScreen.mount(host, { store, navigate: () => {} });
  return { host, cleanup };
}
const closingRows = (host) => $$(host, '.home-closing__row');
const dialog = () => document.querySelector('.contacts-dialog');

test('Início: "Fechando este mês" lista só negócios abertos com previsão neste mês, do mais próximo ao mais distante', async () => {
  restore();
  asUser('u_marina');
  patchDeal('d1', { expectedClose: thisMonthDay(lastDay) }); // último dia do mês
  patchDeal('d3', { expectedClose: thisMonthDay(1) }); // dia 1 (atrasado, se hoje não for dia 1)
  patchDeal('d7', { expectedClose: nextMonthDay }); // mês seguinte: fora
  patchDeal('d6', { expectedClose: thisMonthDay(15), stageId: 's_fechamento' }); // ganho: fora
  const { host, cleanup } = await mountHome();
  const card = $(host, '.home-closing');
  assert.ok(card, 'cartão presente');
  const titles = closingRows(host).map((r) => text($(r, '.home-closing__title')));
  assert.deepEqual(titles, ['Dashboards de BI', 'Implantação CRM + WhatsApp'], 'ordem pela data; ganho e mês seguinte ficam de fora');
  assert.match(text($(card, '.home-card__sum')), /2 negócios · R\$\s?60\.400/);
  assert.equal($(card, '.home-card__link').getAttribute('href'), '#/pipeline?view=closing');
  assert.equal(closingRows(host)[0].getAttribute('href'), '#/deal?id=d3');
  if (now.getDate() > 1) {
    assert.match(text(closingRows(host)[0]), /venceu 01\//, 'previsão que já passou aparece como vencida');
    assert.ok($(closingRows(host)[0], '.is-late'));
    assert.match(text($(card, '.home-card__sum')), /1 com previsão vencida/);
  }
  cleanup();
});

test('Início: sem negócio com previsão no mês, o cartão explica como preencher', async () => {
  restore();
  asUser('u_marina');
  const { host, cleanup } = await mountHome();
  assert.equal(closingRows(host).length, 0);
  assert.match(text($(host, '.home-closing')), /Nenhum negócio com previsão de fechamento neste mês/);
  assert.equal($(host, '.home-closing .home-card__link'), null, 'sem "Ver todos" quando não há nada');
  cleanup();
});

test('Início: meta do mês — soma os ganhos do mês, mostra % e o que falta; o admin altera e remove', async () => {
  restore();
  asUser('u_marina');
  patchDeal('d6', { stageId: 's_fechamento', stageChangedAt: Date.now() }); // R$ 12.500 ganhos agora
  patchDeal('d3', { stageId: 's_fechamento', stageChangedAt: Date.now() - 80 * 86400000 }); // ganho há meses: não conta
  const { host, cleanup } = await mountHome();
  const goal = () => $(host, '.home-goal');
  assert.match(text(goal()), /R\$\s?12\.500\s+de R\$\s?120\.000/);
  assert.match(text(goal()), /10% da meta/);
  assert.match(text(goal()), /faltam R\$\s?107\.500/);
  assert.equal($(goal(), '[role="progressbar"]').getAttribute('aria-valuenow'), '10');
  assert.equal($(goal(), '.home-goal__fill').style.width, '10%');

  // alterar a meta
  click($(goal(), '[data-focus="goal-edit"]'));
  assert.ok(dialog(), 'diálogo da meta');
  const input = $(dialog(), 'input');
  assert.equal(input.value, '120000');
  input.value = 'abc';
  fire($(dialog(), 'form'), 'submit');
  assert.match(text($(dialog(), '.field-error')), /valor em reais/);
  input.value = '50.000';
  fire($(dialog(), 'form'), 'submit');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(dialog(), null, 'fechou ao salvar');
  assert.equal(store.state.tenant.goals.monthlyRevenue, 50000);
  assert.match(text(goal()), /de R\$\s?50\.000/);
  assert.match(text(goal()), /25% da meta/);
  assert.ok(store.state.auditLog.some((e) => e.action === 'tenant.goals'));

  // meta batida
  patchDeal('d1', { stageId: 's_fechamento', stageChangedAt: Date.now() });
  patchDeal('d7', { stageId: 's_fechamento', stageChangedAt: Date.now() }); // 12.500 + 18.400 + 27.500 = 58.400 ≥ 50.000
  assert.match(text(goal()), /Meta batida/);
  assert.ok($(goal(), '.home-goal__fill.is-done'));

  // remover (campo em branco)
  click($(goal(), '[data-focus="goal-edit"]'));
  $(dialog(), 'input').value = '';
  fire($(dialog(), 'form'), 'submit');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(store.state.tenant.goals.monthlyRevenue, null);
  assert.match(text(goal()), /ganhos neste mês/);
  const set = $(goal(), '[data-focus="goal-set"]');
  assert.ok(set, 'admin vê o botão de definir');
  click(set);
  $(dialog(), 'input').value = '80000';
  fire($(dialog(), 'form'), 'submit');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(store.state.tenant.goals.monthlyRevenue, 80000);
  cleanup();
});

test('Início: quem não altera configurações vê a meta mas sem botões; o escopo parcial e o valor oculto não veem a meta', async () => {
  restore();
  // somente leitura: lê tudo do tenant, mas não altera configurações
  asUser('u_lucas');
  const viewer = await mountHome();
  assert.ok($(viewer.host, '.home-goal'), 'Somente leitura lê todos os negócios: vê a meta da empresa');
  assert.equal($(viewer.host, '[data-focus="goal-edit"]'), null);
  assert.equal($(viewer.host, '[data-focus="goal-set"]'), null);
  viewer.cleanup();
  store.update((s) => (s.tenant.goals = { monthlyRevenue: null }));
  const viewer2 = await mountHome();
  assert.match(text($(viewer2.host, '.home-goal')), /A meta do mês ainda não foi definida/);
  assert.equal($(viewer2.host, '.home-goal__set'), null, 'sem permissão: sem botão de definir');
  viewer2.cleanup();
  restore();

  // gestor (equipe e subequipes): vê o "Fechando este mês" do que lê, mas não a meta da empresa
  asUser('u_carla');
  const manager = await mountHome();
  assert.equal($(manager.host, '.home-goal'), null);
  assert.ok($(manager.host, '.home-closing'));
  manager.cleanup();

  // valor oculto (perfil "só Vendas SDR"): nem meta, nem valores no "Fechando este mês"
  store.update((s) => {
    s.users.find((u) => u.id === 'u_pedro').roleIds = ['role_t_jr_sdr'];
    s.deals.find((d) => d.id === 'd2').ownerId = 'u_pedro';
    Object.assign(s.deals.find((d) => d.id === 'd2'), { expectedClose: thisMonthDay(lastDay) });
  });
  asUser('u_pedro');
  const sdr = await mountHome();
  assert.equal($(sdr.host, '.home-goal'), null, 'valor oculto: sem meta');
  const rows = closingRows(sdr.host);
  assert.ok(rows.length >= 1, 'o negócio dele aparece');
  assert.equal($(sdr.host, '.home-closing__value'), null, 'sem valores');
  assert.ok(!/R\$/.test(text($(sdr.host, '.home-closing'))));
  sdr.cleanup();
  restore();
  asUser('u_marina');
});

test('Início: "Ver todos" abre Negócios em lista, na visão "Fechando este mês"', async () => {
  restore();
  asUser('u_marina');
  patchDeal('d3', { expectedClose: thisMonthDay(lastDay) });
  patchDeal('d1', { expectedClose: nextMonthDay });
  localStorage.removeItem('ttf:pipeline:mode');
  document.getElementById('app').replaceChildren();
  location.hash = '#/pipeline?view=closing';
  const host = document.createElement('div');
  document.getElementById('app').append(host);
  const cleanup = await pipelineScreen.mount(host, { store, navigate: () => {} });
  assert.equal($(host, '.pipeline').dataset.mode, 'list');
  assert.equal($(host, '.pipeline-list .lt-views').value, 'closing');
  const titles = $$(host, '.pipeline-list .lt-row').map((r) => text($(r, '.lt-td--main')));
  assert.deepEqual(titles, ['Dashboards de BI']);
  assert.equal(localStorage.getItem('ttf:pipeline:mode'), null, 'a preferência salva do usuário não muda');
  cleanup();
  restore();
});
