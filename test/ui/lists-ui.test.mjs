// Listas em tabela no DOM simulado: Contatos (modo Tabela) e Negócios (modo Lista) — colunas, ordenação, busca, filtros,
// visões salvas, seleção/ações em massa e permissões (campo oculto não vira coluna; o usuário só vê o que o motor deixa).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, fire, waitFor, $, $$, text } from './dom-env.mjs';

installDom();
const { store } = await import('../../public/js/store.js');
const contactsScreen = (await import('../../public/js/screens/contacts.js')).default;
const { visible } = await import('../../public/js/access.js');

const asUser = (id) => (store.state.currentUserId = id);
const reset = () => {
  localStorage.removeItem('ttf:contacts:mode');
  localStorage.removeItem('ttf:views:contacts');
};

async function mountContacts() {
  document.getElementById('app').replaceChildren();
  location.hash = '#/contacts';
  const host = document.createElement('div');
  document.getElementById('app').append(host);
  const cleanup = await contactsScreen.mount(host, { store, navigate: () => {} });
  return { host, cleanup };
}
const T = '.contacts-tablecol';
const rows = (host) => $$(host, `${T} .lt-row`);
const names = (host) => rows(host).map((r) => text($(r, '.lt-td--main')));
const heads = (host) => $$(host, `${T} .lt-th`).map((th) => text(th));
const click = (el) => fire(el, 'click');
const pick = (sel, value) => {
  sel.value = value;
  fire(sel, 'change');
};
const countText = (host) => text($(host, `${T} .lt-count`));
const openPanel = (host, name) => click($(host, `${T} [data-focus="panel:${name}"]`));
const panel = (host) => $(host, `${T} .lt-panel`);

before(() => {
  reset();
  asUser('u_marina'); // Admin: enxerga todos os contatos
});

test('Contatos: o alternador troca para Tabela (e lembra), com as colunas padrão e todos os contatos visíveis', async () => {
  const { host, cleanup } = await mountContacts();
  assert.equal($(host, '.contacts').dataset.mode, 'list');
  click($(host, '[data-mode="table"]'));
  assert.equal($(host, '.contacts').dataset.mode, 'table');
  assert.equal(localStorage.getItem('ttf:contacts:mode'), 'table');
  const total = visible('contact', store.state.contacts).length;
  assert.equal(rows(host).length, total);
  assert.deepEqual(heads(host).map((t) => t.replace(/[↑↓]/g, '').trim()), ['Nome', 'Empresa', 'Telefone', 'E-mail', 'Responsável', 'Criado em']);
  assert.match(countText(host), new RegExp(`${total} contatos`));
  assert.match(text($(host, `${T} .lt-views`)), /Todos os contatos/);
  const first = rows(host)[0];
  assert.match(text(first), /Bruno Tavares/, 'visão de fábrica ordena pelo nome');
  assert.match(text(first), /Rafael Lima/, 'responsável aparece pelo nome');
  cleanup();

  const again = await mountContacts();
  assert.equal($(again.host, '.contacts').dataset.mode, 'table', 'a escolha é lembrada');
  click($(again.host, '[data-mode="list"]'));
  assert.equal($(again.host, '.contacts').dataset.mode, 'list');
  again.cleanup();
});

test('Contatos (tabela): clicar no cabeçalho ordena (crescente → decrescente → sem ordem) e marca aria-sort', async () => {
  const { host, cleanup } = await mountContacts();
  click($(host, '[data-mode="table"]'));
  const sortBtn = () => $(host, `${T} [data-focus="sort:name"]`);
  assert.equal($(host, `${T} th[aria-sort="ascending"]`) !== null, true, 'a visão de fábrica já ordena por nome');
  click(sortBtn());
  assert.match(names(host)[0], /Patrícia Duarte/, 'decrescente');
  assert.match(text($(host, `${T} th[aria-sort="descending"]`)), /Nome/);
  click(sortBtn());
  assert.equal($(host, `${T} th[aria-sort="ascending"]`), null, 'sem ordem: nenhuma coluna marcada');
  click($(host, `${T} [data-focus="sort:company"]`));
  assert.match(names(host)[0], /Grupo Aurora/, 'por empresa (Aurora Distribuidora vem primeiro)');
  cleanup();
});

test('Contatos (tabela): a busca da tabela acha por nome, empresa, telefone ou e-mail e ignora acento', async () => {
  const { host, cleanup } = await mountContacts();
  click($(host, '[data-mode="table"]'));
  const search = $(host, `${T} .lt-search`);
  search.value = 'patricia';
  fire(search, 'input');
  await waitFor(() => rows(host).length === 1);
  assert.match(names(host)[0], /Patrícia Duarte/);
  search.value = 'aurora.com.br';
  fire(search, 'input');
  await waitFor(() => names(host).join().includes('Grupo Aurora') && rows(host).length === 1);
  search.value = 'zzzz';
  fire(search, 'input');
  await waitFor(() => rows(host).length === 0);
  assert.match(text($(host, `${T} .lt-empty`)), /Nenhum resultado/);
  search.value = '';
  fire(search, 'input');
  await waitFor(() => rows(host).length > 1);
  cleanup();
});

test('Contatos (tabela): filtro por coluna vira chip, soma com outros, valida o valor e se remove pelo ×', async () => {
  const { host, cleanup } = await mountContacts();
  click($(host, '[data-mode="table"]'));
  const total = rows(host).length;
  openPanel(host, 'filters');
  assert.equal(panel(host).hidden, false);
  // enum: Responsável é Marina
  pick($(panel(host), '[data-focus="f-col"]'), 'owner');
  pick($(panel(host), '[data-focus="f-val"]'), 'u_marina');
  fire($(panel(host), 'form.lt-filter'), 'submit');
  const mine = store.state.contacts.filter((c) => c.ownerId === 'u_marina').length;
  assert.equal(rows(host).length, mine);
  assert.match(text($(host, `${T} .lt-chips`)), /Responsável é Marina Alves/);
  assert.match(text($(host, `${T} [data-focus="panel:filters"]`)), /Filtros \(1\)/);
  // texto: Origem contém "campanha" (soma com o anterior: Grupo Aurora é da Marina e veio de Campanha)
  pick($(panel(host), '[data-focus="f-col"]'), 'source');
  $(panel(host), '[data-focus="f-val"]').value = 'campanha';
  fire($(panel(host), '[data-focus="f-val"]'), 'input');
  fire($(panel(host), 'form.lt-filter'), 'submit');
  assert.deepEqual(names(host), ['Grupo Aurora']);
  assert.equal($$(host, `${T} .lt-chip`).length, 2);
  // número com valor inválido: avisa e não adiciona
  pick($(panel(host), '[data-focus="f-col"]'), 'deals');
  pick($(panel(host), '[data-focus="f-op"]'), 'gt');
  $(panel(host), '[data-focus="f-val"]').value = 'abc';
  fire($(panel(host), '[data-focus="f-val"]'), 'input');
  fire($(panel(host), 'form.lt-filter'), 'submit');
  assert.match(text($(panel(host), '.field-error')), /números válidos/);
  assert.equal($$(host, `${T} .lt-chip`).length, 2);
  // remover os dois chips
  click($(host, `${T} .lt-chip__x`));
  click($(host, `${T} .lt-chip__x`));
  assert.equal(rows(host).length, total);
  assert.equal($(host, `${T} .lt-chips`).hidden, true);
  cleanup();
});

test('Contatos (tabela): visões de fábrica, salvar a minha, lembrar ao voltar e apagar só as minhas', async () => {
  const { host, cleanup } = await mountContacts();
  click($(host, '[data-mode="table"]'));
  const views = () => $(host, `${T} .lt-views`);
  const labels = () => $$(views(), 'option').map((o) => text(o));
  assert.ok(['Todos os contatos', 'Meus contatos', 'Sem responsável', 'Com negócio aberto', 'Sem negócio', 'Criados nos últimos 30 dias'].every((l) => labels().includes(l)), labels().join('|'));
  pick(views(), 'mine');
  assert.equal(rows(host).length, store.state.contacts.filter((c) => c.ownerId === 'u_marina').length, 'Meus contatos: só os da Marina');
  pick(views(), 'noowner');
  assert.equal(rows(host).length, store.state.contacts.filter((c) => !c.ownerId).length);
  pick(views(), 'recent');
  assert.equal(rows(host).length, store.state.contacts.filter((c) => Date.now() - c.createdAt < 30 * 86400000).length, 'últimos 30 dias');
  assert.match(names(host)[0], /Bruno Tavares/, 'o mais novo primeiro (2 dias)');
  assert.equal($(host, `${T} .lt-modified`).hidden, true);

  // salvar uma visão própria: Origem contém "indic"
  pick(views(), 'all');
  openPanel(host, 'filters');
  pick($(panel(host), '[data-focus="f-col"]'), 'source');
  $(panel(host), '[data-focus="f-val"]').value = 'indic';
  fire($(panel(host), '[data-focus="f-val"]'), 'input');
  fire($(panel(host), 'form.lt-filter'), 'submit');
  const indicated = rows(host).length;
  assert.ok(indicated >= 2);
  assert.equal($(host, `${T} .lt-modified`).hidden, false, 'filtro novo = visão alterada');
  openPanel(host, 'save');
  fire($(panel(host), 'form'), 'submit');
  assert.match(text($(panel(host), '.field-error')), /nome/i, 'sem nome não salva');
  $(panel(host), '[data-focus="view-name"]').value = 'Indicações';
  fire($(panel(host), 'form'), 'submit');
  assert.ok(labels().includes('Indicações (minha)'));
  assert.equal($(host, `${T} .lt-modified`).hidden, true, 'recém-salva: igual ao salvo');
  assert.equal(panel(host).hidden, true, 'o painel fecha ao salvar');
  assert.equal($(host, `${T} [data-focus="panel:save"]`).getAttribute('aria-expanded'), 'false');
  cleanup();

  // voltando à tela: continua na visão salva, com as mesmas linhas
  const again = await mountContacts();
  assert.equal(rows(again.host).length, indicated);
  assert.match(text($(again.host, `${T} .lt-chips`)), /Origem contém indic/);
  // sair da visão e apagar a minha: a de fábrica não tem botão de apagar
  const sel = $(again.host, `${T} .lt-views`);
  const deleteBtn = [...$$(again.host, `${T} .lt-btn`)].find((b) => /Apagar/.test(text(b)));
  assert.equal(deleteBtn.hidden, false);
  click(deleteBtn);
  assert.ok(!$$(sel, 'option').some((o) => /Indicações/.test(text(o))));
  assert.equal(deleteBtn.hidden, true, 'visão de fábrica não se apaga');
  assert.equal(rows(again.host).length, store.state.contacts.length, 'voltou para "Todos os contatos"');
  again.cleanup();
});

test('Contatos (tabela): escolher colunas — a 1ª fica sempre; esconder some do cabeçalho e das linhas', async () => {
  const { host, cleanup } = await mountContacts();
  click($(host, '[data-mode="table"]'));
  openPanel(host, 'columns');
  const boxes = $$(panel(host), 'input[type="checkbox"]');
  assert.equal(boxes[0].hasAttribute('disabled'), true, 'o nome identifica o contato');
  const company = $(panel(host), '[data-focus="col:company"]');
  company.checked = false;
  fire(company, 'change');
  assert.ok(!heads(host).some((t) => /Empresa/.test(t)));
  const extra = $(panel(host), '[data-focus="col:source"]');
  extra.checked = true;
  fire(extra, 'change');
  assert.ok(heads(host).some((t) => /Origem/.test(t)), 'coluna extra aparece');
  assert.equal($(host, `${T} .lt-modified`).hidden, false);
  click($(host, `${T} .lt-modified`)); // restaurar a visão
  assert.ok(heads(host).some((t) => /Empresa/.test(t)));
  cleanup();
});

test('Contatos (tabela): clicar na linha abre a ficha no lugar da tabela e "Contatos" volta', async () => {
  const { host, cleanup } = await mountContacts();
  click($(host, '[data-mode="table"]'));
  const row = rows(host).find((r) => /Carlos Menezes/.test(text(r)));
  click(row);
  assert.equal($(host, '.contacts').dataset.mview, 'detail');
  assert.equal(text($(host, '.contacts-who__name')), 'Carlos Menezes');
  click($(host, '.contacts-back'));
  assert.equal($(host, '.contacts').dataset.mview, 'list');
  cleanup();
});

test('Contatos (tabela): perfil sem telefone não ganha coluna de telefone (ordenar/filtrar vazaria o valor) e vê só o que o motor deixa', async () => {
  asUser('u_julia'); // Financeiro: lê contatos do tenant, telefone oculto
  const { host, cleanup } = await mountContacts();
  click($(host, '[data-mode="table"]'));
  const hs = heads(host).join('|');
  assert.ok(!/Telefone/.test(hs), hs);
  assert.ok(/E-mail/.test(hs));
  const shownNames = names(host);
  assert.equal(shownNames.length, visible('contact', store.state.contacts).length);
  assert.ok(!/\+55/.test(text($(host, `${T} .lt-table`))), 'nenhum telefone na tabela');
  openPanel(host, 'filters');
  const cols = $$(panel(host), '[data-focus="f-col"] option').map((o) => o.getAttribute('value'));
  assert.ok(!cols.includes('phone'), 'não dá para filtrar pelo telefone oculto');
  cleanup();

  // um atendente só enxerga os próprios contatos; outro usuário não herda o estado do anterior
  asUser('u_pedro');
  const pedro = await mountContacts();
  click($(pedro.host, '[data-mode="table"]'));
  const mineOnly = visible('contact', store.state.contacts);
  assert.equal(rows(pedro.host).length, mineOnly.length);
  assert.ok(mineOnly.length < store.state.contacts.length, 'a premissa do teste: Pedro não vê todos');
  assert.equal($$(pedro.host, `${T} .lt-chip`).length, 0, 'sem filtros herdados da Júlia');
  pedro.cleanup();
  asUser('u_marina');
});
