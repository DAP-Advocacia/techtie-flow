// Seletor de funil em lista suspensa (Negócios): abre, escolhe, busca (com muitos funis), teclado, Esc e clique fora.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, fire, $, $$, text } from './dom-env.mjs';

installDom();
const { store } = await import('../../public/js/store.js');
const pipelineScreen = (await import('../../public/js/screens/pipeline.js')).default;

const snapshot = JSON.parse(JSON.stringify(store.state.pipelines));
const restore = () => store.update((s) => (s.pipelines = JSON.parse(JSON.stringify(snapshot))));
const click = (el) => fire(el, 'click');
const key = (el, k) => fire(el, 'keydown', { key: k });

async function mountPipeline() {
  document.getElementById('app').replaceChildren();
  location.hash = '#/pipeline';
  localStorage.removeItem('ttf:pipeline:mode');
  const host = document.createElement('div');
  document.getElementById('app').append(host);
  const cleanup = await pipelineScreen.mount(host, { store, navigate: () => {} });
  return { host, cleanup };
}
const btn = (host) => $(host, '.picker__btn');
const pop = (host) => $(host, '.picker__pop');
const options = (host) => $$(host, '.picker__item');
const colNames = (host) => $$(host, '.pipeline-col__name').map((c) => text(c));

test('Funil: o botão mostra o funil atual com a contagem; abrir lista todos; escolher troca o quadro e fecha', async () => {
  restore();
  store.state.currentUserId = 'u_marina';
  const { host, cleanup } = await mountPipeline();
  assert.ok(!$(host, '.pills [role="tab"]'), 'não há mais pílulas de funil');
  assert.equal(pop(host).hidden, true);
  const first = text(btn(host));
  assert.match(first, /FUNIL/);
  assert.match(first, /\d+ negócio/);
  assert.equal(btn(host).getAttribute('aria-expanded'), 'false');
  click(btn(host));
  assert.equal(pop(host).hidden, false);
  assert.equal(btn(host).getAttribute('aria-expanded'), 'true');
  const names = options(host).map((o) => text($(o, '.picker__item-name')));
  assert.ok(names.includes('Comercial') && names.includes('Vendas · SDR'));
  assert.equal(options(host).filter((o) => o.getAttribute('aria-selected') === 'true').length, 1, 'um funil selecionado');
  assert.equal($(host, '.picker__search').hidden, true, 'com poucos funis não precisa de busca');
  const before = colNames(host).join('|');
  const other = options(host).find((o) => o.getAttribute('aria-selected') !== 'true');
  click(other);
  assert.equal(pop(host).hidden, true, 'fecha ao escolher');
  assert.notEqual(colNames(host).join('|'), before, 'o quadro mostra as etapas do outro funil');
  assert.match(text(btn(host)), new RegExp(text($(other, '.picker__item-name'))));
  cleanup();
});

test('Funil: Esc fecha e devolve o foco; clicar fora fecha; setas e Enter escolhem', async () => {
  restore();
  store.state.currentUserId = 'u_marina';
  const { host, cleanup } = await mountPipeline();
  click(btn(host));
  key($(host, '.picker__list'), 'Escape');
  assert.equal(pop(host).hidden, true);
  click(btn(host));
  fire(document.body, 'mousedown');
  assert.equal(pop(host).hidden, true, 'clique fora fecha');
  // teclado: ↓ no botão abre; ↓ move o destaque; Enter escolhe
  key(btn(host), 'ArrowDown');
  assert.equal(pop(host).hidden, false);
  const list = $(host, '.picker__list');
  const startIdx = options(host).findIndex((o) => o.classList.contains('is-active'));
  key(list, 'ArrowDown');
  const idx = options(host).findIndex((o) => o.classList.contains('is-active'));
  assert.equal(idx, (startIdx + 1) % options(host).length);
  const target = text($(options(host)[idx], '.picker__item-name'));
  key(list, 'Enter');
  assert.equal(pop(host).hidden, true);
  assert.match(text(btn(host)), new RegExp(target));
  cleanup();
});

test('Funil: com muitos funis aparece a busca (sem acento) e filtra a lista; sem resultado avisa', async () => {
  restore();
  store.state.currentUserId = 'u_marina';
  store.update((s) => {
    for (let i = 1; i <= 6; i++) s.pipelines.push({ id: `p_x${i}`, name: i === 3 ? 'Pós-venda Premium' : `Funil extra ${i}`, teamId: null, stages: [{ id: `sx${i}a`, name: 'Início', kind: 'open', probability: 50 }, { id: `sx${i}b`, name: 'Ganho', kind: 'won', probability: 100 }] });
  });
  // funis só aparecem se o usuário puder ler negócios neles: Admin lê todos
  const { host, cleanup } = await mountPipeline();
  click(btn(host));
  assert.ok(options(host).length >= 8);
  const search = $(host, '.picker__search');
  assert.equal(search.hidden, false, 'a partir de 6 funis a busca aparece');
  search.value = 'PÓS-VENDA prem'; // sem diferenciar caixa nem acento
  fire(search, 'input');
  assert.deepEqual(options(host).map((o) => text($(o, '.picker__item-name'))), ['Pós-venda Premium']);
  search.value = 'zzz';
  fire(search, 'input');
  assert.equal(options(host).length, 0);
  assert.match(text($(host, '.picker__none')), /Nenhum funil/);
  search.value = 'extra 4';
  fire(search, 'input');
  key(search, 'Enter');
  assert.match(text(btn(host)), /Funil extra 4/);
  cleanup();
  restore();
});
