// Regressão da revisão adversarial de segurança (ver docs/permissoes.md §11).
// Cada teste prende uma brecha que EXISTIU e foi fechada: se algum quebrar, a brecha voltou.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { decide, can, canWriteField, checkPatch, maskRow, checkNoEscalation, filterFor, toSql, createContext, SYSTEM_ROLES, ENTITIES } from '../../shared/permissions/index.js';
import { ctxOf, subjectOf } from './support.mjs';

const ME = 'me';
const prop = { id: 'p1', tenantId: 'A', ownerId: ME, teamId: 'T1' };
const deal = (o = {}) => ({ id: 'd1', tenantId: 'A', ownerId: ME, teamId: 'T1', pipelineId: 'p1', stageId: 's1', status: 'open', ...o });
const eff = (ctx, e, a, row, c) => decide(ctx, e, a, row, c).effect;

describe('desconto e aprovação', () => {
  test('Atendente: criar, enviar e alterar proposta com desconto > 5% exigem aprovação (não só o update)', () => {
    const ctx = ctxOf(subjectOf(ME, ['role_agent']));
    for (const action of ['create', 'send', 'update']) {
      assert.equal(eff(ctx, 'proposal', action, prop, { discountPct: 40 }), 'approval', action);
      assert.equal(eff(ctx, 'proposal', action, prop, { discountPct: 3 }), 'allow', action);
      assert.equal(eff(ctx, 'proposal', action, prop), 'approval', `${action} sem contexto de desconto`);
    }
  });

  test('null e número negativo no contexto são desconhecidos: não dispensam a aprovação', () => {
    const ctx = ctxOf(subjectOf(ME, ['role_agent']));
    for (const discountPct of [null, -1, -0.01, NaN, 'abc', true]) assert.equal(eff(ctx, 'proposal', 'update', prop, { discountPct }), 'approval', String(discountPct));
  });

  test('ninguém se auto-aprova: solicitante == aprovador nega; requesterId ausente também nega', () => {
    const mgr = ctxOf(subjectOf(ME, ['role_manager']));
    assert.equal(eff(mgr, 'proposal', 'approve', prop, { requesterId: 'outra-pessoa', discountPct: 10 }), 'allow');
    assert.equal(eff(mgr, 'proposal', 'approve', prop, { requesterId: ME, discountPct: 10 }), 'deny');
    assert.equal(eff(mgr, 'proposal', 'approve', prop, { discountPct: 10 }), 'deny');
  });

  test('Financeiro não aprova desconto (alçada comercial)', () => {
    assert.equal(eff(ctxOf(subjectOf(ME, ['role_finance'])), 'proposal', 'approve', prop, { requesterId: 'x', discountPct: 1 }), 'deny');
  });
});

describe('update não pode mexer em atributos de controle', () => {
  const agent = ctxOf(subjectOf(ME, ['role_agent']));
  test('canWriteField: tenantId/id imutáveis; dono e etapa só com transfer/move', () => {
    assert.equal(canWriteField(agent, 'deal', 'tenantId', deal()), false);
    assert.equal(canWriteField(agent, 'deal', 'id', deal()), false);
    assert.equal(canWriteField(agent, 'deal', 'ownerId', deal()), false, 'Atendente não tem transfer em deal');
    assert.equal(canWriteField(agent, 'deal', 'stageId', deal(), { fromStageKind: 'open', toStageKind: 'open' }), true, 'Atendente tem move');
    assert.equal(canWriteField(ctxOf(subjectOf(ME, ['role_sdr'])), 'deal', 'stageId', deal(), { toStageKind: 'won' }), false, 'SDR: negação de move vale também por PATCH');
  });

  test('checkPatch recusa imutável e controlado, aceita campo de dados e confere o registro RESULTANTE', () => {
    assert.equal(checkPatch(agent, 'deal', deal(), { title: 'novo' }).ok, true);
    assert.deepEqual(checkPatch(agent, 'deal', deal(), { tenantId: 'B' }).denied, [{ field: 'tenantId', reason: 'immutable' }]);
    assert.equal(checkPatch(agent, 'deal', deal(), { ownerId: 'outro' }).ok, false);
    assert.equal(checkPatch(agent, 'deal', deal(), null).ok, false);
    assert.equal(checkPatch(agent, 'bogus', deal(), { a: 1 }).ok, false);
  });
});

describe('compartilhamento e perfis', () => {
  test('compartilhar com a SUBequipe não alcança quem está só na equipe-pai', () => {
    const org = { teams: [{ id: 'root' }, { id: 'sub', parentId: 'root' }] };
    const ctx = ctxOf(subjectOf(ME, [], { teamIds: ['root'] }), { org });
    const row = deal({ ownerId: 'x', teamId: 'z', sharedWith: [{ type: 'team', id: 'sub', level: 'read' }] });
    assert.equal(eff(ctx, 'deal', 'read', row), 'deny');
    assert.equal(eff(ctxOf(subjectOf(ME, [], { teamIds: ['sub'] }), { org }), 'deal', 'read', row), 'allow');
  });

  test('perfil sem tenantId que não é de sistema NÃO vale (nem para outro tenant)', () => {
    const orfao = { id: 'orfao', name: 'x', tenantId: null, system: false, grants: [{ entity: 'contact', actions: ['export'], scope: 'tenant' }], denies: [], partitions: {}, fields: [] };
    const ctx = { subject: subjectOf(ME, ['orfao']), roles: new Map([['orfao', orfao]]), org: { teams: [] }, policy: { requireMfaForSensitive: false } };
    assert.equal(eff(ctx, 'contact', 'export', { id: 'c', tenantId: 'A' }), 'deny');
  });

  test('createContext recusa perfil de tenant sem dono, de sistema ou com id de sistema', () => {
    const base = { name: 'x', grants: [], denies: [], partitions: {}, fields: [] };
    const ctx = createContext({ subject: subjectOf(ME, []), tenantRoles: [{ ...base, id: 'a', tenantId: null }, { ...base, id: 'b', tenantId: 'A', system: true }, { ...base, id: 'role_admin', tenantId: 'A' }, { ...base, id: 'ok', tenantId: 'A' }] });
    assert.equal(ctx.roles.has('a'), false);
    assert.equal(ctx.roles.has('b'), false);
    assert.equal(ctx.roles.get('role_admin').system, true);
    assert.equal(ctx.roles.has('ok'), true);
  });

  test('ator suspenso não concede perfil', () => {
    const admin = ctxOf(subjectOf(ME, ['role_admin'], { status: 'suspended' }));
    assert.equal(checkNoEscalation(admin, SYSTEM_ROLES.find((r) => r.id === 'role_agent')).ok, false);
  });
});

describe('MFA falha-fechada e máscara', () => {
  test('política ausente exige MFA em ação sensível; só mfa === true vale; só false explícito desliga', () => {
    const row = { id: 'c', tenantId: 'A' };
    assert.equal(eff(ctxOf(subjectOf(ME, ['role_admin'], { mfa: false }), { policy: {} }), 'contact', 'delete', row), 'deny');
    assert.equal(eff(ctxOf(subjectOf(ME, ['role_admin'], { mfa: 'false' }), { policy: {} }), 'contact', 'delete', row), 'deny');
    assert.equal(eff(ctxOf(subjectOf(ME, ['role_admin'], { mfa: true }), { policy: {} }), 'contact', 'delete', row), 'allow');
    assert.equal(eff(ctxOf(subjectOf(ME, ['role_admin'], { mfa: false }), { policy: { requireMfaForSensitive: false } }), 'contact', 'delete', row), 'allow');
  });

  test('maskRow em entidade desconhecida ou linha inválida devolve vazio (nunca a linha inteira)', () => {
    const ctx = ctxOf(subjectOf(ME, ['role_admin']));
    assert.deepEqual(maskRow(ctx, 'bogus', { phone: '1' }), {});
    assert.deepEqual(maskRow(ctx, '__proto__', { phone: '1' }), {});
    assert.deepEqual(maskRow(ctx, 'contact', [1, 2]), {});
  });
});

describe('toSql', () => {
  const ctx = ctxOf(subjectOf(ME, ['role_manager']));
  const { expr, entity } = filterFor(ctx, 'deal');
  test('alias do EXISTS de compartilhamento não colide com alias reservado; startAt inválido lança', () => {
    assert.throws(() => toSql(expr, entity, { alias: 'shr_' }));
    for (const startAt of [0, -1, 1.5, '1', NaN]) assert.throws(() => toSql(expr, entity, { alias: 't', startAt }), /startAt/);
    const { sql } = toSql(expr, entity, { alias: 'rs' });
    assert.match(sql, /FROM resource_shares shr_ WHERE shr_\.tenant_id = rs\.tenant_id/);
  });
  test('a entidade deal expõe a ação share no catálogo', () => assert.ok(ENTITIES.deal.actions.includes('share')));
});
