// Camada simples do editor de perfis (resumo em português + ajustes rápidos): lógica pura, sem navegador.
import { register } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';

register(new URL('./shared-loader.mjs', import.meta.url));
const { summarize, setReach, currentReach, setAction, setAttend, canAttend, setOwnNumber, hasOwnNumber, DELETABLE, EXPORTABLE } = await import('../../public/js/screens/permissions/simple.js');
const { SYSTEM_ROLES, validateRole } = await import('../../shared/permissions/index.js');

const state = { instances: [{ id: 'i1', name: 'Comercial' }, { id: 'i2', name: 'Suporte' }], pipelines: [{ id: 'p1', name: 'Vendas' }] };
const clone = (id) => ({ ...JSON.parse(JSON.stringify(SYSTEM_ROLES.find((r) => r.id === id))), id: 'role_t_x', system: false, tenantId: 't' });
const row = (rows, area) => rows.find((r) => r.area === area)?.text || '';
const valid = (role) => validateRole(role).map((e) => e.message);

test('resumo do Atendente: dele + fila, responde, sem relatórios nem administração', () => {
  const rows = summarize(clone('role_agent'), state);
  assert.match(row(rows, 'Conversas'), /só o que é dele\(a\)/);
  assert.match(row(rows, 'Conversas'), /a fila de atendimento/);
  assert.match(row(rows, 'Conversas'), /responde/);
  assert.match(row(rows, 'Negócios'), /só o que é dele\(a\)/);
  assert.match(row(rows, 'Negócios'), /move de etapa/);
  assert.equal(row(rows, 'Relatórios'), 'Sem acesso');
  assert.equal(row(rows, 'Administração'), 'Sem acesso');
  assert.match(row(rows, 'Limites'), /regra\(s\) avançada\(s\)/, 'fila e aprovação de desconto são regras avançadas');
});

test('resumo do Admin e do Somente leitura', () => {
  const admin = summarize({ ...clone('role_admin') }, state);
  assert.match(row(admin, 'Negócios'), /tudo da empresa/);
  assert.match(row(admin, 'Administração'), /gerencia usuários/);
  const viewer = summarize(clone('role_viewer'), state);
  assert.match(row(viewer, 'Negócios'), /só leitura/);
  assert.match(row(viewer, 'Conversas'), /só leitura/);
  assert.match(row(viewer, 'Limites'), /1 trava/);
});

test('alcance: iguala os registros, não liga o que estava desligado e não mexe em configuração nem na fila', () => {
  const role = clone('role_agent');
  assert.equal(currentReach(role), null, 'Atendente de fábrica é misto (contatos pela equipe, negócios só os dele)');
  setReach(role, 'team');
  assert.equal(currentReach(role), 'team');
  const rows = summarize(role, state);
  assert.match(row(rows, 'Negócios'), /o que é da equipe/);
  assert.doesNotMatch(row(rows, 'Negócios'), /exclui/, 'não ligou exclusão');
  assert.match(row(rows, 'Conversas'), /a fila de atendimento/, 'a fila (regra avançada) continua');
  assert.equal(role.grants.find((g) => g.entity === 'product')?.scope, 'tenant', 'config da empresa intacta');
  assert.deepEqual(valid(role), []);
  setReach(role, 'team_tree');
  assert.equal(currentReach(role), 'team_tree');
  assert.deepEqual(valid(role), []);
});

test('interruptores: excluir, exportar e atender ligam e desligam sem deixar resto', () => {
  const role = clone('role_agent');
  setAction(role, DELETABLE, 'delete', true);
  assert.match(row(summarize(role, state), 'Negócios'), /exclui/);
  assert.deepEqual(valid(role), []);
  setAction(role, DELETABLE, 'delete', false);
  assert.doesNotMatch(row(summarize(role, state), 'Negócios'), /exclui/);

  setAction(role, EXPORTABLE, 'export', true);
  assert.ok(role.grants.some((g) => g.actions.includes('export')));
  assert.deepEqual(valid(role), []);
  setAction(role, EXPORTABLE, 'export', false);
  assert.equal(role.grants.some((g) => g.actions.includes('export')), false);

  assert.equal(canAttend(role), true);
  setAttend(role, false);
  assert.equal(canAttend(role), false, 'desligou também a regra da fila');
  assert.doesNotMatch(row(summarize(role, state), 'Conversas'), /responde|transfere|resolve/);
  assert.match(row(summarize(role, state), 'Conversas'), /a fila de atendimento/, 'ainda VÊ a fila, só não atende');
  assert.deepEqual(valid(role), []);
  setAttend(role, true);
  assert.equal(canAttend(role), true);
  assert.match(row(summarize(role, state), 'Conversas'), /responde/);
  assert.deepEqual(valid(role), []);
});

test('limites aparecem no resumo: números, funis e campos escondidos', () => {
  const role = clone('role_agent');
  role.partitions = { instanceId: ['i1'], pipelineId: ['p1'] };
  role.fields = [{ entity: 'deal', field: 'value', access: 'hidden' }, { entity: 'contact', field: 'phone', access: 'hidden' }];
  const text = row(summarize(role, state), 'Limites');
  assert.match(text, /só os números: Comercial/);
  assert.match(text, /só os funis: Vendas/);
  assert.match(text, /não vê:/);
});

test('número próprio: liga ler/criar/renomear/conectar só do dono e desliga tudo de uma vez', () => {
  const role = clone('role_viewer');
  assert.equal(hasOwnNumber(role), false);
  setOwnNumber(role, true);
  assert.equal(hasOwnNumber(role), true);
  const inst = role.grants.filter((g) => g.entity === 'instance');
  assert.ok(inst.length && inst.every((g) => g.scope === 'own'));
  assert.deepEqual([...new Set(inst.flatMap((g) => g.actions))].sort(), ['connect', 'create', 'delete', 'read', 'update']);
  assert.deepEqual(valid(role), []);
  setOwnNumber(role, false);
  assert.equal(role.grants.some((g) => g.entity === 'instance'), false);
});
