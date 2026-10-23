// Lógica pura do modo operação do front (sem navegador): mapeamento da API para o estado das telas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyBootstrap, mergeConversation, appendMessage, upsertInstance, replaceById } from '../../public/js/live-state.js';

const data = () => ({
  tenant: { id: 't1', name: 'Empresa', policy: { requireMfaForSensitive: false } },
  currentUserId: 'u1',
  users: [{ id: 'u1', name: 'Ana', roleIds: ['role_agent'], teamIds: [] }],
  roles: [], teams: [], pipelines: [], contacts: [{ id: 'c1' }], deals: [],
  conversations: [{ id: 'cv1', contactId: 'c1', unread: 1, dealId: null }],
  instances: [{ id: 'i1', name: 'Comercial', status: 'connected', phone: '5511' }],
  permissions: { deal: {} },
});

test('applyBootstrap troca os dados reais, preserva o que o servidor não manda e completa a instância', () => {
  const s = { tenant: { brand: { productName: 'TechTie Flow' } }, messages: { x: [1] }, timeline: { y: [] }, agent: { enabled: true } };
  applyBootstrap(s, data());
  assert.equal(s.tenant.brand.productName, 'TechTie Flow');
  assert.equal(s.tenant.brand.domain, '', 'o domínio de demonstração não vaza para a operação real');
  assert.equal(s.tenant.name, 'Empresa');
  assert.equal(s.currentUserId, 'u1');
  assert.deepEqual(s.messages, {}, 'mensagens recarregadas por conversa');
  assert.deepEqual(s.agent, { enabled: true, testChat: [] }, 'a conversa de teste de demonstração some');
  assert.deepEqual([s.automations, s.auditLog], [[], []], 'fluxos e auditoria inventados não aparecem');
  assert.equal(s.instances[0].aiActive, false);
  assert.equal(s.session.loggedIn, true);
  const s2 = { tenant: {}, messages: { x: [1] }, timeline: {} };
  applyBootstrap(s2, data(), { keepMessages: true });
  assert.deepEqual(s2.messages, { x: [1] }, 'atualização incremental mantém as mensagens abertas');
});

test('mergeConversation: atualiza sem perder o vínculo com o negócio; conversa nova entra no topo', () => {
  const s = { conversations: [{ id: 'a', unread: 0, dealId: 'd1' }] };
  assert.equal(mergeConversation(s, { id: 'a', unread: 3 }), false);
  assert.deepEqual(s.conversations[0], { id: 'a', unread: 3, dealId: 'd1' });
  assert.equal(mergeConversation(s, { id: 'b', unread: 1 }), true);
  assert.equal(s.conversations[0].id, 'b');
  assert.equal(s.conversations[0].dealId, null);
});

test('appendMessage: só em conversa já carregada e sem duplicar pelo id', () => {
  const s = { messages: { a: [{ id: 'm1' }] } };
  assert.equal(appendMessage(s, 'a', { id: 'm1' }), false);
  assert.equal(appendMessage(s, 'a', { id: 'm2' }), true);
  assert.equal(appendMessage(s, 'zzz', { id: 'm3' }), false, 'conversa não carregada vem completa ao abrir');
  assert.equal(s.messages.a.length, 2);
});

test('upsertInstance e replaceById', () => {
  const s = { instances: [{ id: 'i1', status: 'queued', name: 'X' }] };
  upsertInstance(s, { id: 'i1', status: 'connected' });
  assert.equal(s.instances[0].name, 'X');
  assert.equal(s.instances[0].status, 'connected');
  upsertInstance(s, { id: 'i2', status: 'qr' });
  assert.equal(s.instances.length, 2);
  const list = [{ id: 'local', title: 'a' }];
  replaceById(list, 'local', { id: 'srv', title: 'a' });
  assert.deepEqual(list, [{ id: 'srv', title: 'a' }]);
  replaceById(list, 'nao-existe', { id: 'novo' });
  assert.equal(list.length, 2);
});
