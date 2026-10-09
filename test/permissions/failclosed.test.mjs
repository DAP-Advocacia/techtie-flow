// (e) FALHA FECHADO com entradas malformadas.
// Contrato: para entrada plausível de produção (dados corrompidos no banco, corpo de
// requisição mal-formado, campo que veio undefined/null/tipo trocado) o motor
//   - NUNCA lança exceção, e
//   - NUNCA permite além do que a política válida permitiria (negação/aprovação
//     corrompidas valem pelo lado seguro; permissão corrompida vale como ausente).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  decide,
  filterFor,
  toPredicate,
  toSql,
  fieldAccess,
  maskRow,
  canWriteField,
  explain,
  effectiveMatrix,
  expandTeams,
  effectiveRoles,
  checkNoEscalation,
  ENTITIES,
} from '../../shared/permissions/index.js';
import { ORG, subjectOf, ctxOf, roleOf, fuzz, genCase, mkCtx, Rng } from './support.mjs';

const ME = 'me';
const deal = (o = {}) => ({ id: 'd1', tenantId: 'A', ownerId: ME, teamId: 'T1', pipelineId: 'p1', status: 'open', value: 100, ...o });
const grant = (entity, actions, scope, extra = {}) => ({ entity, actions, scope, ...extra });
const withRole = (role, subject = {}) => ctxOf(subjectOf(ME, [role.id], subject), { tenantRoles: [role] });
const eff = (ctx, entity, action, row, context) => decide(ctx, entity, action, row, context).effect;

/** Roda tudo que a API pública faz e garante que nada lança. */
function exercise(ctx, entity, action, row, context) {
  decide(ctx, entity, action, row, context);
  explain(ctx, entity, action, row, context);
  const f = filterFor(ctx, entity, action);
  toPredicate(f.expr)(row);
  if (f.entity) toSql(f.expr, f.entity);
  fieldAccess(ctx, entity);
  maskRow(ctx, entity, row);
  canWriteField(ctx, entity, 'phone', row, context);
  effectiveMatrix(ctx);
  effectiveRoles(ctx);
}

describe('sujeito malformado', () => {
  const GARBAGE_ROLEIDS = [undefined, null, 5, 'role_admin', {}, true, [null], [undefined], [5], [{}], [['role_admin']], ['__proto__'], ['constructor'], ['toString'], ['hasOwnProperty'], new Set(['role_admin'])];
  test('roleIds com tipo errado: nunca lança; string/número/objeto NÃO viram lista de perfis', () => {
    for (const roleIds of GARBAGE_ROLEIDS) {
      const ctx = ctxOf(subjectOf(ME, roleIds));
      assert.doesNotThrow(() => exercise(ctx, 'deal', 'read', deal()), String(roleIds));
      const expected = roleIds instanceof Set ? 'allow' : 'deny'; // Set é uma lista legítima
      assert.equal(eff(ctx, 'deal', 'read', deal()), expected, `roleIds=${JSON.stringify(roleIds)}`);
    }
  });

  test('roles como OBJETO simples + roleIds herdados de Object.prototype não viram perfil', () => {
    for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      const ctx = { subject: subjectOf(ME, [id]), roles: {}, org: ORG, policy: {} };
      assert.deepEqual(effectiveRoles(ctx), [], id);
      assert.equal(eff(ctx, 'deal', 'read', deal()), 'deny');
    }
  });

  test('teamIds com tipo errado: nunca lança; string não é "lista de caracteres"', () => {
    const r = roleOf('r', [grant('deal', ['read'], 'team_tree')]);
    for (const teamIds of [undefined, null, 'T1', 5, {}, true, [null], [undefined], [{}], [['T1']]]) {
      const ctx = ctxOf(subjectOf(ME, ['r'], { teamIds }), { tenantRoles: [r] });
      assert.doesNotThrow(() => exercise(ctx, 'deal', 'read', deal({ ownerId: 'x', teamId: 'T1' })), JSON.stringify(teamIds));
      assert.equal(eff(ctx, 'deal', 'read', deal({ ownerId: 'x', teamId: 'T1' })), 'deny', JSON.stringify(teamIds));
      assert.equal(eff(ctx, 'deal', 'read', deal({ ownerId: 'x', teamId: 'T' })), 'deny', 'string "T1" não vira equipes "T" e "1"');
      assert.equal(eff(ctx, 'deal', 'read', deal({ ownerId: 'x', teamId: '1' })), 'deny');
    }
    assert.deepEqual(expandTeams(ORG, 'T1'), []);
    assert.deepEqual(expandTeams({ teams: 'x' }, ['T1']), ['T1']);
    assert.deepEqual(expandTeams({ teams: 5 }, ['T1']), ['T1']);
    assert.deepEqual(expandTeams({ teams: [null, undefined, 5, {}] }, ['T1']), ['T1']);
  });

  test('sem id: "own" nunca casa com registro sem dono, e share sem id não casa', () => {
    const r = roleOf('r', [grant('deal', ['read'], 'own')]);
    for (const id of [undefined, null, '']) {
      const ctx = ctxOf(subjectOf(id, ['r']), { tenantRoles: [r] });
      assert.equal(eff(ctx, 'deal', 'read', deal({ ownerId: undefined })), 'deny', String(id));
      assert.equal(eff(ctx, 'deal', 'read', deal({ ownerId: null })), 'deny', String(id));
    }
    const semId = ctxOf(subjectOf(undefined, []));
    assert.equal(eff(semId, 'deal', 'read', deal({ sharedWith: [{ type: 'user', level: 'read' }] })), 'deny');
    assert.equal(eff(semId, 'deal', 'read', deal({ sharedWith: [{ type: 'user', id: undefined, level: 'edit' }] })), 'deny');
  });

  test('sem tenantId (nem no usuário nem no registro): nunca permite', () => {
    for (const tenantId of [undefined, null, '']) {
      const ctx = { subject: { id: ME, status: 'active', roleIds: ['role_admin'], tenantId }, roles: ctxOf(subjectOf(ME, [])).roles, org: ORG, policy: {} };
      for (const rowTenant of [undefined, null, '', tenantId]) {
        if (rowTenant === '' && tenantId === '') continue; // '' === '' é um tenant (string vazia) — ver abaixo
        assert.equal(eff(ctx, 'deal', 'read', deal({ tenantId: rowTenant })), 'deny', `${String(tenantId)}/${String(rowTenant)}`);
      }
    }
  });

  test('subject.overrides malformado (grants/denies/fields com lixo) não lança e nega', () => {
    for (const overrides of [null, 5, 'x', [], { grants: 'x' }, { grants: {} }, { grants: [null, 5, 'x', {}, { entity: 'deal' }] }, { denies: [null] }, { fields: 'x' }]) {
      const ctx = ctxOf(subjectOf(ME, [], { overrides }));
      assert.doesNotThrow(() => exercise(ctx, 'deal', 'read', deal()), JSON.stringify(overrides));
      assert.equal(eff(ctx, 'deal', 'read', deal()), 'deny', JSON.stringify(overrides));
    }
  });
});

describe('ctx / org / policy / roles malformados', () => {
  test('roles ausente/nulo/vazio/de tipo errado: sem perfis => nega, sem lançar', () => {
    for (const roles of [undefined, null, {}, [], 'x', 5, new Map(), true]) {
      const ctx = { subject: subjectOf(ME, ['role_admin']), roles, org: ORG, policy: {} };
      assert.doesNotThrow(() => exercise(ctx, 'deal', 'read', deal()), String(roles));
      assert.equal(eff(ctx, 'deal', 'read', deal()), 'deny', String(roles));
    }
  });

  test('org malformado: nunca lança; team_tree degrada para as equipes do próprio usuário', () => {
    const r = roleOf('r', [grant('deal', ['read'], 'team_tree')]);
    for (const org of [undefined, null, 5, 'x', {}, { teams: null }, { teams: 'x' }, { teams: 5 }, { teams: {} }, { teams: [null, 5, {}, { id: 'T9', parentId: null }] }]) {
      const ctx = { ...ctxOf(subjectOf(ME, ['r']), { tenantRoles: [r] }), org };
      assert.doesNotThrow(() => exercise(ctx, 'deal', 'read', deal({ ownerId: 'x', teamId: 'T1' })), JSON.stringify(org));
      assert.equal(eff(ctx, 'deal', 'read', deal({ ownerId: 'x', teamId: 'T1' })), 'allow', 'a própria equipe sempre vale');
      assert.equal(eff(ctx, 'deal', 'read', deal({ ownerId: 'x', teamId: 'T1a' })), 'deny');
    }
  });

  test('policy malformado não liga nem desliga MFA por acidente; nunca lança', () => {
    for (const policy of [undefined, null, 5, 'x', [], { requireMfaForSensitive: 'false' }, { requireMfaForSensitive: 0 }]) {
      const ctx = { ...ctxOf(subjectOf(ME, ['role_admin'], { mfa: false })), policy };
      assert.doesNotThrow(() => exercise(ctx, 'deal', 'delete', deal()));
    }
    // string 'false' é truthy: tratada como "exige MFA" (lado seguro)
    const exige = { ...ctxOf(subjectOf(ME, ['role_admin'], { mfa: false })), policy: { requireMfaForSensitive: 'false' } };
    assert.equal(eff(exige, 'deal', 'delete', deal()), 'deny');
  });

  test('ctx inteiro ausente', () => {
    for (const ctx of [undefined, null, {}, { subject: undefined }, 5, 'x']) {
      assert.doesNotThrow(() => decide(ctx, 'deal', 'read', deal()), String(ctx));
      assert.equal(eff(ctx, 'deal', 'read', deal()), 'deny');
      assert.equal(filterFor(ctx, 'deal', 'read').blocked, 'subject_inactive');
      assert.deepEqual(fieldAccess(ctx, 'deal'), {});
    }
  });
});

describe('perfil/regra malformados: permissão corrompida = ausente', () => {
  const BAD_GRANT_LISTS = [undefined, null, 'x', 5, {}, true, [], [null], [undefined], [5], ['read'], [[]], [{}], [{ entity: 'deal' }], [{ actions: ['read'], scope: 'tenant' }], [{ entity: 5, actions: ['read'], scope: 'tenant' }]];
  test('grants inválidos: nunca lança e nunca permite', () => {
    for (const grants of BAD_GRANT_LISTS) {
      const r = { ...roleOf('r', []), grants };
      const ctx = withRole(r);
      assert.doesNotThrow(() => exercise(ctx, 'deal', 'read', deal()), JSON.stringify(grants));
      assert.equal(eff(ctx, 'deal', 'read', deal()), 'deny', JSON.stringify(grants));
    }
  });

  test('actions como STRING não vaza por substring ("readonly".includes("read")) e actions ausente não lança', () => {
    for (const actions of ['read', 'readonly', 'read,update', '*', undefined, null, 5, {}, { 0: 'read', length: 1 }]) {
      const r = roleOf('r', [{ entity: 'deal', actions, scope: 'tenant' }]);
      const ctx = withRole(r);
      assert.doesNotThrow(() => exercise(ctx, 'deal', 'read', deal()));
      assert.equal(eff(ctx, 'deal', 'read', deal()), 'deny', JSON.stringify(actions));
    }
  });

  test('perfil sem grants/denies/fields/partitions (campos ausentes ou nulos): nada a conceder, nada a quebrar', () => {
    for (const r of [{ id: 'r', tenantId: 'A' }, { id: 'r', tenantId: 'A', grants: null, denies: null, fields: null, partitions: null }, { id: 'r', tenantId: 'A', partitions: 'x' }]) {
      const ctx = withRole(r);
      assert.doesNotThrow(() => exercise(ctx, 'deal', 'read', deal()));
      assert.equal(eff(ctx, 'deal', 'read', deal()), 'deny');
    }
  });

  const BAD_DENY_LISTS = [
    [null],
    [undefined],
    [5],
    ['deal'],
    [{}],
    [{ entity: 'deal' }], // sem actions
    [{ actions: ['read'] }], // sem entity
    [{ entity: 'deal', actions: 'read' }], // actions não é lista
    [{ entity: 5, actions: ['read'] }],
    'read', // lista que não é lista
    {},
    5,
    true,
  ];
  test('NEGAÇÃO corrompida vale como "nega tudo" (antes era ignorada e liberava o acesso)', () => {
    for (const denies of BAD_DENY_LISTS) {
      const r = roleOf('r', [grant('*', ['*'], 'tenant')], { denies });
      const ctx = withRole(r);
      assert.doesNotThrow(() => exercise(ctx, 'deal', 'read', deal()), JSON.stringify(denies));
      assert.equal(eff(ctx, 'deal', 'read', deal()), 'deny', JSON.stringify(denies));
      assert.equal(toPredicate(filterFor(ctx, 'deal', 'read').expr)(deal()), false, 'a lista também nega');
    }
    // denies vazio/ausente/nulo NÃO é corrupção
    for (const denies of [undefined, null, []]) assert.equal(eff(withRole(roleOf('r', [grant('*', ['*'], 'tenant')], { denies })), 'deal', 'read', deal()), 'allow');
  });

  test('negação corrompida no override do usuário também nega', () => {
    const ctx = ctxOf(subjectOf(ME, ['role_admin'], { overrides: { denies: [{ entity: 'deal' }] } }));
    assert.equal(eff(ctx, 'deal', 'read', deal()), 'deny');
  });

  // condições corrompidas: [rótulo, condição]
  const BAD_CONDITIONS = [
    ['nula', null],
    ['string', 'ownerId'],
    ['sem field', { op: 'eq', value: 1 }],
    ['field não-string', { field: 5, op: 'eq', value: 1 }],
    ['sem op', { field: 'status', value: 'open' }],
    ['op desconhecido', { field: 'status', op: 'like', value: 'open' }],
    ['op __proto__', { field: 'status', op: '__proto__', value: 'open' }],
    ['op constructor', { field: 'status', op: 'constructor', value: 'open' }],
    ['eq sem valor', { field: 'status', op: 'eq' }],
    ['ne sem valor', { field: 'status', op: 'ne' }],
    ['lt sem valor', { field: 'value', op: 'lt' }],
    ['in com escalar', { field: 'status', op: 'in', value: 'open' }],
    ['nin com escalar', { field: 'status', op: 'nin', value: 'open' }],
    ['in sem valor', { field: 'status', op: 'in' }],
    ['eq com array', { field: 'status', op: 'eq', value: ['open'] }],
    ['eq com objeto', { field: 'status', op: 'eq', value: { a: 1 } }],
    ['ref desconhecida', { field: 'ownerId', op: 'eq', ref: '$user.admin' }],
    ['ref $user.id em in', { field: 'ownerId', op: 'in', ref: '$user.id' }],
    ['ref $user.teamIds em eq', { field: 'ownerId', op: 'eq', ref: '$user.teamIds' }],
    ['atributo inexistente', { field: 'naoExiste', op: 'isNull' }],
    ['atributo de protótipo', { field: 'constructor', op: 'notNull' }],
    ['atributo __proto__', { field: '__proto__', op: 'notNull' }],
    ['atributo toString', { field: 'toString', op: 'notNull' }],
  ];
  const wrap = (c) => c; // condição única

  test('GRANT com condição corrompida não vale (nunca lança)', () => {
    for (const [label, cond] of BAD_CONDITIONS) {
      const ctx = withRole(roleOf('r', [grant('deal', ['read'], 'tenant', { conditions: [wrap(cond)] })]));
      assert.doesNotThrow(() => exercise(ctx, 'deal', 'read', deal()), label);
      assert.equal(eff(ctx, 'deal', 'read', deal()), 'deny', label);
    }
  });

  test('DENY com condição corrompida SE APLICA (antes: op/valor ruim deixava a negação inerte ou lançava)', () => {
    for (const [label, cond] of BAD_CONDITIONS) {
      const ctx = withRole(roleOf('r', [grant('*', ['*'], 'tenant')], { denies: [{ entity: 'deal', actions: ['read'], conditions: [wrap(cond)] }] }));
      assert.doesNotThrow(() => exercise(ctx, 'deal', 'read', deal()), label);
      assert.equal(eff(ctx, 'deal', 'read', deal()), 'deny', label);
      assert.equal(toPredicate(filterFor(ctx, 'deal', 'read').expr)(deal()), false, `${label} (lista)`);
    }
  });

  test('APROVAÇÃO com condição corrompida EXIGE aprovação (nunca allow direto)', () => {
    for (const [label, cond] of BAD_CONDITIONS) {
      const ctx = withRole(roleOf('r', [grant('deal', ['update'], 'tenant', { approval: { when: [wrap(cond)] } })]));
      assert.doesNotThrow(() => exercise(ctx, 'deal', 'update', deal()), label);
      assert.equal(eff(ctx, 'deal', 'update', deal()), 'approval', label);
    }
  });

  test('"lista" de condições que não é lista: grant não vale, deny aplica, aprovação exige', () => {
    for (const conditions of ['x', 5, {}, { 0: { field: 'status', op: 'eq', value: 'open' }, length: 1 }, true]) {
      assert.equal(eff(withRole(roleOf('r', [grant('deal', ['read'], 'tenant', { conditions })])), 'deal', 'read', deal()), 'deny', 'grant ' + JSON.stringify(conditions));
      assert.equal(eff(withRole(roleOf('r', [grant('*', ['*'], 'tenant')], { denies: [{ entity: 'deal', actions: ['read'], conditions }] })), 'deal', 'read', deal()), 'deny', 'deny ' + JSON.stringify(conditions));
      assert.equal(eff(withRole(roleOf('r', [grant('deal', ['read'], 'tenant', { approval: { when: conditions } })])), 'deal', 'read', deal()), 'approval', 'approval ' + JSON.stringify(conditions));
    }
  });

  test('condição válida vizinha de uma corrompida: a corrompida derruba o grant (E de todas)', () => {
    const ctx = withRole(roleOf('r', [grant('deal', ['read'], 'tenant', { conditions: [{ field: 'status', op: 'eq', value: 'open' }, { field: 'status', op: 'like', value: 'o' }] })]));
    assert.equal(eff(ctx, 'deal', 'read', deal()), 'deny');
  });

  test('restrição de campo corrompida oculta os campos da entidade (falha fechado)', () => {
    for (const fields of [[null], [5], ['phone'], [{}], [{ entity: 'contact' }], [{ field: 'phone' }], [{ entity: 5, field: 'phone', access: 'hidden' }], 'phone', {}, 5]) {
      const r = roleOf('r', [grant('contact', ['*'], 'tenant')], { fields });
      const ctx = withRole(r);
      assert.doesNotThrow(() => exercise(ctx, 'contact', 'read', { id: 'c', tenantId: 'A' }), JSON.stringify(fields));
      assert.deepEqual(fieldAccess(ctx, 'contact'), { phone: 'hidden', email: 'hidden', document: 'hidden' }, JSON.stringify(fields));
    }
    for (const fields of [undefined, null, []]) assert.deepEqual(fieldAccess(withRole(roleOf('r', [], { fields })), 'contact'), {});
  });

  test('partições corrompidas: nunca lança e só restringem', () => {
    for (const partitions of [undefined, null, 5, 'x', [], { pipelineId: null }, { pipelineId: 'p1' }, { pipelineId: 5 }, { pipelineId: {} }, { pipelineId: [null] }, { pipelineId: [{}] }, { __proto__: { pipelineId: 'all' } }]) {
      const r = roleOf('r', [grant('deal', ['read'], 'tenant')], { partitions });
      const ctx = withRole(r);
      assert.doesNotThrow(() => exercise(ctx, 'deal', 'read', deal()), JSON.stringify(partitions));
      const e = eff(ctx, 'deal', 'read', deal({ pipelineId: 'p1' }));
      // sem restrição: partitions ausente/nulo ou sem a chave. Tudo o mais (lista ruim, tipo errado) restringe.
      const livre = partitions === undefined || partitions === null || (typeof partitions === 'object' && !Array.isArray(partitions) && !Object.hasOwn(partitions, 'pipelineId'));
      assert.equal(e, livre ? 'allow' : 'deny', JSON.stringify(partitions));
    }
  });
});

describe('APROVAÇÃO e deny com valores de contexto do tipo errado (corpo de requisição hostil)', () => {
  const agent = ctxOf(subjectOf(ME, ['role_agent']));
  const sdr = ctxOf(subjectOf(ME, ['role_sdr']));
  const mgr = ctxOf(subjectOf(ME, ['role_manager']));
  const prop = { id: 'p', tenantId: 'A', ownerId: ME, teamId: 'T1' };

  test('desconto não numérico NÃO dispensa a aprovação do Atendente ("8%", NaN, array, objeto, booleano)', () => {
    for (const discountPct of ['8%', '8', 'abc', '', NaN, [8], [], {}, { valueOf: () => 8 }, true, false, 8n, () => 8]) {
      assert.equal(eff(agent, 'proposal', 'update', prop, { discountPct }), 'approval', `discountPct=${typeof discountPct === 'bigint' ? '8n' : typeof discountPct === 'function' ? 'fn' : JSON.stringify(discountPct)}`);
    }
    // e os numéricos legítimos continuam funcionando
    assert.equal(eff(agent, 'proposal', 'update', prop, { discountPct: 5 }), 'allow');
    assert.equal(eff(agent, 'proposal', 'update', prop, { discountPct: -3 }), 'approval', 'negativo é inválido => exige aprovação');
    assert.equal(eff(agent, 'proposal', 'update', prop, { discountPct: Infinity }), 'approval');
  });

  test('Gestor só aprova com desconto numérico válido <= 15 (string "9", NaN, array: negado)', () => {
    for (const discountPct of ['9', '9%', NaN, [9], {}, true, null, undefined]) {
      assert.equal(eff(mgr, 'deal', 'approve', deal(), { requesterId: 'req', discountPct }), 'deny', JSON.stringify(discountPct));
      assert.equal(eff(mgr, 'proposal', 'approve', prop, { requesterId: 'req', discountPct }), 'deny', JSON.stringify(discountPct));
    }
    assert.equal(eff(mgr, 'deal', 'approve', deal(), { requesterId: 'req', discountPct: 9 }), 'allow');
    // ninguém se auto-aprova: o solicitante é o próprio Gestor => negado; sem requesterId também
    assert.equal(eff(mgr, 'deal', 'approve', deal(), { requesterId: ME, discountPct: 9 }), 'deny');
    assert.equal(eff(mgr, 'deal', 'approve', deal(), { discountPct: 9 }), 'deny');
  });

  test('SDR não consegue mover para Ganho disfarçando o tipo da etapa (array, objeto, número, maiúsculas)', () => {
    for (const toStageKind of [['won'], { kind: 'won' }, 5, true, NaN, () => 'won', ['open', 'won']]) {
      assert.equal(eff(sdr, 'deal', 'move', deal(), { toStageKind }), 'deny', JSON.stringify(toStageKind));
    }
    // texto diferente (inclusive "Won") não casa com 'won' => não é Ganho => permitido; é decisão do app normalizar
    assert.equal(eff(sdr, 'deal', 'move', deal(), { toStageKind: 'open' }), 'allow');
    assert.equal(eff(sdr, 'deal', 'move', deal(), { toStageKind: 'won' }), 'deny');
  });

  test('contexto que não é objeto (string/número/array/função) é tratado como ausente', () => {
    for (const context of ['won', 5, ['won'], () => ({}), true, Symbol.iterator]) {
      assert.equal(eff(sdr, 'deal', 'move', deal(), context), 'deny', String(typeof context));
      assert.equal(eff(agent, 'proposal', 'update', prop, context), 'approval', String(typeof context));
    }
  });

  test('chave do contexto só conta se for PRÓPRIA (não herdada de protótipo)', () => {
    const herdado = Object.create({ toStageKind: 'open' });
    assert.equal(eff(sdr, 'deal', 'move', deal(), herdado), 'deny');
  });
});

describe('registro malformado', () => {
  test('row que não é objeto, ou com tipos trocados, nunca lança e nega o que depende do atributo', () => {
    const ctx = withRole(roleOf('r', [grant('deal', ['read'], 'team')]));
    for (const row of [null, undefined, 0, 1, '', 'x', true, [], [1], () => 1, Symbol.iterator]) {
      assert.doesNotThrow(() => exercise(ctx, 'deal', 'read', row), String(typeof row));
      assert.equal(eff(ctx, 'deal', 'read', row), 'deny');
    }
    const tipos = [{ ownerId: [ME] }, { ownerId: { toString: () => ME } }, { ownerId: new String(ME) }, { ownerId: 0 }, { ownerId: true }, { teamId: ['T1'] }, { teamId: { id: 'T1' } }, { sharedWith: { 0: {}, length: 1 } }];
    for (const o of tipos) {
      const row = deal({ ownerId: 'x', teamId: 'T9', ...o });
      assert.doesNotThrow(() => exercise(ctx, 'deal', 'read', row));
      assert.equal(eff(ctx, 'deal', 'read', row), 'deny', JSON.stringify(o));
    }
  });

  test('entradas pouco prováveis mas possíveis: registro com getter que lança é problema do chamador (documentado), mas objeto congelado e protótipo nulo funcionam', () => {
    const ctx = ctxOf(subjectOf(ME, ['role_agent']));
    assert.equal(eff(ctx, 'deal', 'read', Object.freeze(deal())), 'allow');
    const sp = Object.assign(Object.create(null), deal());
    assert.equal(eff(ctx, 'deal', 'read', sp), 'allow');
  });
});

describe('fuzz de mutação: nenhuma entrada deformada lança exceção nem fura o tenant', () => {
  const GARBAGE = [undefined, null, 0, 1, -1, NaN, Infinity, '', 'x', 'read', '*', 'deal', 'tenant', 'active', true, false, [], [null], ['*'], ['read'], [[]], {}, { a: 1 }, { t: 'true' }, '__proto__', 'constructor', 'toString', ' '];

  function pathsOf(obj, prefix = [], out = []) {
    if (obj && typeof obj === 'object') {
      for (const k of Object.keys(obj)) {
        out.push([...prefix, k]);
        pathsOf(obj[k], [...prefix, k], out);
      }
    }
    return out;
  }
  function setPath(root, path, value, del) {
    let o = root;
    for (const k of path.slice(0, -1)) o = o[k];
    const last = path[path.length - 1];
    if (del) {
      if (Array.isArray(o)) o.splice(Number(last), 1);
      else delete o[last];
    } else o[last] = typeof value === 'object' && value !== null ? JSON.parse(JSON.stringify(value)) : value;
  }

  test('1-3 mutações aleatórias em QUALQUER campo do caso: API pública não lança; tenant alheio nunca passa', () => {
    let mutated = 0;
    fuzz('mutacao', {
      seed: 5151,
      n: 7000,
      shrinkable: false,
      gen: (rng) => {
        const c = genCase(rng, { approvalP: 0.3, sysP: 0.4 });
        const copy = JSON.parse(JSON.stringify(c));
        const hits = 1 + rng.int(3);
        const log = [];
        for (let i = 0; i < hits; i++) {
          const paths = pathsOf(copy);
          if (!paths.length) break;
          const p = rng.pick(paths);
          const del = rng.bool(0.25);
          const v = rng.pick(GARBAGE);
          try {
            setPath(copy, p, v, del);
            log.push([p.join('.'), del ? '<del>' : v]);
            mutated++;
          } catch {
            /* caminho já removido por mutação anterior */
          }
        }
        copy.__log = log;
        return copy;
      },
      check: (c) => {
        const ctx = mkCtx(c);
        const entity = c.entity;
        const action = c.action;
        try {
          exercise(ctx, entity, action, c.row, c.context);
          const d = decide(ctx, entity, action, c.row, c.context);
          assert.ok(['allow', 'deny', 'approval'].includes(d.effect));
          assert.ok(typeof d.reason === 'string');
          assert.ok(Array.isArray(d.matched));
          // isolamento de tenant NUNCA depende de a entrada estar bem formada
          const rowTenant = c.row && typeof c.row === 'object' ? c.row.tenantId : undefined;
          if (d.effect !== 'deny') assert.ok(rowTenant !== undefined && rowTenant !== null && rowTenant === c.subject?.tenantId, 'permitiu com tenant diferente');
          // e usuário que não está ativo nunca passa
          if (d.effect !== 'deny') assert.equal(c.subject?.status, 'active');
          // lista e objeto concordam mesmo com lixo
          if (action !== undefined) assert.equal(toPredicate(filterFor(ctx, entity, action).expr)(c.row), decide(ctx, entity, action, c.row, undefined).effect !== 'deny'); // filterFor(…, undefined) usa o padrão 'read'
        } catch (e) {
          e.message = `${e.message}\n  mutações: ${JSON.stringify(c.__log)}`;
          throw e;
        }
      },
    });
    assert.ok(mutated > 10000);
  });

  test('checkNoEscalation com ator/candidato deformados não lança (e recusa o que é lixo)', () => {
    const GARBAGE_CAND = [undefined, null, 5, 'x', [], {}, { grants: 'x' }, { grants: {} }, { grants: [null] }, { grants: [5] }, { grants: [{}] }, { grants: [{ entity: 'deal' }] }, { grants: [{ entity: 'deal', actions: 'read', scope: 'tenant' }] }, { grants: [{ entity: 'deal', actions: ['read'] }] }, { grants: [{ entity: 'deal', actions: ['read'], scope: 'tenant' }], partitions: 'x' }, { grants: [{ entity: 'deal', actions: ['read'], scope: 'tenant' }], partitions: { pipelineId: 'p1' } }];
    const actors = [undefined, null, {}, { subject: null }, ctxOf(subjectOf(ME, ['role_admin'])), ctxOf(subjectOf(ME, ['role_admin'], { overrides: 5 })), { subject: subjectOf(ME, ['x']), roles: 5 }];
    for (const a of actors) for (const cand of GARBAGE_CAND) assert.doesNotThrow(() => checkNoEscalation(a, cand), `${JSON.stringify(cand)}`);
    // lixo nunca é aceito
    const admin = ctxOf(subjectOf(ME, ['role_admin']));
    for (const cand of [undefined, null, 5, 'x', [], { grants: 'x' }, { grants: [null] }, { grants: [{}] }, { grants: [{ entity: 'deal', actions: 'read', scope: 'tenant' }] }]) {
      assert.equal(checkNoEscalation(admin, cand).ok, false, JSON.stringify(cand));
    }
  });
});

test('Rng é determinístico e cobre o intervalo (sanidade do gerador)', () => {
  const r = new Rng(7);
  const seen = new Set();
  for (let i = 0; i < 1000; i++) seen.add(r.int(10));
  assert.equal(seen.size, 10);
  assert.ok(Object.keys(ENTITIES).length > 0);
});
