// CSV nas telas (DOM simulado): exportar a lista filtrada, assistente de importação (contatos e negócios) e permissões.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, fire, tick, waitFor, $, $$, text } from './dom-env.mjs';

installDom();
const { store } = await import('../../public/js/store.js');
const contactsScreen = (await import('../../public/js/screens/contacts.js')).default;
const pipelineScreen = (await import('../../public/js/screens/pipeline.js')).default;
const { openImport } = await import('../../public/js/screens/import/wizard.js');
const IA = await import('../../public/js/screens/import/actions.js');

const click = (el) => fire(el, 'click');
const pick = (sel, v) => {
  sel.value = v;
  fire(sel, 'change');
};
const asUser = (id) => (store.state.currentUserId = id);
const snap = JSON.parse(JSON.stringify({ contacts: store.state.contacts, deals: store.state.deals, auditLog: store.state.auditLog }));
const restore = () =>
  store.update((s) => {
    s.contacts = JSON.parse(JSON.stringify(snap.contacts));
    s.deals = JSON.parse(JSON.stringify(snap.deals));
  });

// captura o que seria baixado
let downloads = [];
URL.createObjectURL = (blob) => {
  downloads.push(blob);
  return 'blob:teste';
};
URL.revokeObjectURL = () => {};
const lastDownload = async () => {
  const blob = downloads.at(-1);
  const buf = new Uint8Array(await blob.arrayBuffer());
  return { bom: buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf, text: new TextDecoder().decode(buf).replace(/^﻿/, '') };
};

const dialog = () => document.querySelector('.contacts-dialog');
const dialogBtn = (label) => [...dialog().querySelectorAll('button')].find((b) => text(b).includes(label));
const mountScreen = async (screen, hash) => {
  document.getElementById('app').replaceChildren();
  location.hash = hash;
  const host = document.createElement('div');
  document.getElementById('app').append(host);
  const cleanup = await screen.mount(host, { store, navigate: () => {} });
  return { host, cleanup };
};

test('Exportar CSV (Contatos): baixa só o que está na tela (filtro e colunas), com BOM, ; e nome do responsável; registra na auditoria', async () => {
  restore();
  downloads = [];
  asUser('u_marina');
  localStorage.setItem('ttf:contacts:mode', 'table');
  const { host, cleanup } = await mountScreen(contactsScreen, '#/contacts');
  const btn = $(host, '.contacts-tablecol .lt-export');
  assert.equal(btn.hidden, false);
  click(btn);
  await waitFor(() => downloads.length === 1);
  let f = await lastDownload();
  assert.equal(f.bom, true, 'o Excel precisa do BOM');
  const lines = f.text.trim().split('\r\n');
  assert.equal(lines[0], 'Nome;Empresa;Telefone;E-mail;Responsável;Criado em');
  assert.equal(lines.length, 1 + store.state.contacts.length);
  assert.match(f.text, /Carlos Menezes;Menezes Engenharia;\+55 11 98765-4321;carlos@menezes\.eng\.br;Marina Alves;/);
  assert.ok(store.state.auditLog.some((e) => e.action === 'contact.export' && /Exportação em CSV de 7 contatos/.test(e.detail)));
  // com busca: só as linhas filtradas
  const search = $(host, '.contacts-tablecol .lt-search');
  search.value = 'lopes';
  fire(search, 'input');
  await waitFor(() => $$(host, '.contacts-tablecol .lt-row').length === 1);
  click($(host, '.contacts-tablecol .lt-export'));
  await waitFor(() => downloads.length === 2);
  f = await lastDownload();
  assert.equal(f.text.trim().split('\r\n').length, 2);
  assert.match(f.text, /Helena Lopes/);
  assert.ok(!/Carlos/.test(f.text));
  cleanup();
  localStorage.removeItem('ttf:contacts:mode');
});

test('Exportar: campo oculto não sai no arquivo; quem não pode exportar nem vê o botão', async () => {
  restore();
  downloads = [];
  localStorage.setItem('ttf:contacts:mode', 'table');
  asUser('u_pedro'); // Atendente: sem exportar
  const agent = await mountScreen(contactsScreen, '#/contacts');
  assert.equal($(agent.host, '.contacts-tablecol .lt-export').hidden, true);
  assert.equal(IA.canExport('contact', 1), false);
  assert.equal((await IA.logExport('contact', 1)).ok, false);
  agent.cleanup();
  asUser('u_marina');
  store.update((s) => {
    // perfil sem telefone: a coluna nem existe, então o telefone não pode sair no CSV
    s.users.find((u) => u.id === 'u_carla').roleIds = ['role_manager'];
  });
  const gestor = await (async () => {
    asUser('u_carla');
    return mountScreen(contactsScreen, '#/contacts');
  })();
  click($(gestor.host, '.contacts-tablecol .lt-export'));
  await waitFor(() => downloads.length === 1);
  assert.match((await lastDownload()).text.split('\r\n')[0], /^Nome;/);
  gestor.cleanup();
  asUser('u_julia'); // Financeiro: telefone oculto
  assert.equal(IA.canExport('contact', 1), false, 'Financeiro só lê contatos');
  asUser('u_marina');
  localStorage.removeItem('ttf:contacts:mode');
});

const CSV = 'Nome completo;Empresa;Celular;E-mail\r\nImportada A;Acme;(11) 98888-1111;a@csv.com\r\nImportado B;;+55 21 97777-2222;\r\n;Sem nome;11 91111-0000;\r\nTelefone ruim;;12;\r\nRepete A;;11988881111;\r\n';

test('Importar contatos: arquivo → colunas chutadas → conferência (o que entra e o que sai) → resultado; quem já existe é pulado na segunda vez', async () => {
  restore();
  asUser('u_marina');
  const before = store.state.contacts.length;
  let done = null;
  const w = openImport({ entity: 'contact', onDone: (r) => (done = r) });
  assert.match(text(dialog()), /Importar contatos de um CSV/);
  assert.ok(dialog().querySelector('input[type="file"]'));
  w.loadText('', 'vazio.csv');
  assert.match(text(dialog()), /não tem linhas/);
  w.loadText(CSV, 'planilha.csv');
  assert.match(text(dialog()), /planilha\.csv · 5 linhas/);
  const sel = (k) => dialog().querySelector(`select[data-field="${k}"]`);
  assert.equal(sel('name').value, '0', 'Nome completo → Nome');
  assert.equal(sel('phone').value, '2', 'Celular → Telefone');
  assert.equal(sel('email').value, '3');
  assert.equal(sel('company').value, '1');
  // sem a coluna obrigatória não segue
  pick(sel('name'), '');
  click(dialogBtn('Continuar'));
  assert.match(text(dialog()), /Ligue uma coluna ao campo Nome/);
  pick(sel('name'), '0');
  click(dialogBtn('Continuar'));
  assert.match(text(dialog()), /2 contatos prontos/);
  assert.match(text(dialog()), /3 linhas ficam de fora/);
  assert.match(text(dialog()), /Linha 4.*Sem nome/);
  assert.match(text(dialog()), /Linha 5.*Telefone inválido/);
  assert.match(text(dialog()), /Linha 6.*Telefone repetido no arquivo/);
  click(dialogBtn('Importar 2 contatos'));
  await waitFor(() => done);
  assert.equal(done.created, 2);
  assert.match(text(dialog()), /2 contatos importados/);
  assert.equal(store.state.contacts.length, before + 2);
  const a = store.state.contacts.find((c) => c.name === 'Importada A');
  assert.deepEqual([a.phone, a.email, a.company, a.source, a.ownerId], ['+5511988881111', 'a@csv.com', 'Acme', 'import', 'u_marina']);
  assert.ok(store.state.auditLog.some((e) => e.action === 'contact.import'));
  click(dialogBtn('Concluir'));
  assert.equal(dialog(), null);
  // de novo: os que já existem ficam de fora
  const w2 = openImport({ entity: 'contact' });
  w2.loadText(CSV, 'planilha.csv');
  click(dialogBtn('Continuar'));
  assert.match(text(dialog()), /0 contatos prontos/);
  assert.match(text(dialog()), /Já existe um contato com este telefone/);
  assert.equal(dialogBtn('Nada para importar').hasAttribute('disabled'), true);
  w2.close();
  restore();
});

test('Importar contatos: arquivo grande demais e quem não pode importar', async () => {
  restore();
  asUser('u_marina');
  const w = openImport({ entity: 'contact' });
  w.loadText('Nome\n' + Array.from({ length: 2001 }, (_, i) => `P${i}`).join('\n'), 'grande.csv');
  assert.match(text(dialog()), /limite é 2\.001|limite é 2\.000/);
  w.close();
  asUser('u_pedro'); // Atendente: nem o botão (na tela) nem a ação
  assert.equal(IA.canImport('contact'), false);
  const r = await IA.importContacts([{ line: 2, name: 'X' }]);
  assert.equal(r.ok, false);
  assert.match(r.error, /não permite importar/);
  asUser('u_marina');
  const mounted = await (async () => {
    localStorage.removeItem('ttf:contacts:mode');
    return mountScreen(contactsScreen, '#/contacts');
  })();
  assert.equal($(mounted.host, '.contacts-import').hidden, false, 'Admin vê o botão Importar CSV');
  mounted.cleanup();
});

test('Importar negócios: etapa por nome, valor em reais, previsão, responsável e contato casado ou criado; Negócios mostra o botão', async () => {
  restore();
  asUser('u_marina');
  const csv = 'Título;Contato;Telefone;Valor;Etapa;Previsão;Responsável\r\nCSV Um;Carlos Menezes;;R$ 2.500,00;negociação;31/12/2030;carla@acme.com.br\r\nCSV Dois;Contato Novo CSV;(21) 96666-5555;;;;\r\n;Sem título;;;;;\r\nCSV Etapa ruim;;;;Inexistente;;\r\n';
  const pipeline = store.pipeline('p_comercial');
  const { host, cleanup } = await mountScreen(pipelineScreen, '#/pipeline');
  assert.equal($(host, '.pipeline-import').hidden, false);
  let done = null;
  const w = openImport({ entity: 'deal', pipeline, onDone: (r) => (done = r) });
  assert.match(text(dialog()), /Importar negócios para Comercial/);
  w.loadText(csv, 'negocios.csv');
  const sel = (k) => dialog().querySelector(`select[data-field="${k}"]`);
  assert.equal(sel('title').value, '0');
  assert.equal(sel('value').value, '3');
  assert.equal(sel('stage').value, '4');
  assert.equal(sel('expectedClose').value, '5');
  assert.equal(sel('owner').value, '6');
  click(dialogBtn('Continuar'));
  assert.match(text(dialog()), /2 negócios prontos · 2 linhas ficam de fora/);
  assert.match(text(dialog()), /Etapa “Inexistente” não existe neste funil/);
  click(dialogBtn('Importar 2 negócios'));
  await waitFor(() => done);
  assert.equal(done.created, 2);
  assert.equal(done.contactsCreated, 1);
  const um = store.state.deals.find((d) => d.title === 'CSV Um');
  assert.equal(um.value, 2500);
  assert.equal(um.stageId, 's_negoc');
  assert.equal(um.ownerId, 'u_carla');
  assert.equal(um.expectedClose, '2030-12-31');
  assert.equal(um.contactId, 'c_carlos', 'casou pelo nome do contato');
  const dois = store.state.deals.find((d) => d.title === 'CSV Dois');
  assert.equal(dois.stageId, 's_proposta', 'sem etapa: a primeira em andamento');
  assert.equal(store.contact(dois.contactId).name, 'Contato Novo CSV');
  assert.ok(store.state.auditLog.some((e) => e.action === 'deal.import'));
  w.close();
  // quem só vê o próprio (Atendente) não tem importação de negócios
  asUser('u_pedro');
  assert.equal(IA.canImport('deal'), false);
  assert.equal((await IA.importDeals(pipeline, [{ line: 2, title: 'X' }])).ok, false);
  cleanup();
  asUser('u_marina');
  restore();
});
