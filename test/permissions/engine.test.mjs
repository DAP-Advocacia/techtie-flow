// Testes unitários do motor (engine.js + createContext), regra por regra.
// Fixtures determinísticas: ver ORG/subjectOf/roleOf em support.mjs.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  decide,
  can,
  canOrRequest,
  explain,
  filterFor,
  toPredicate,
  expandTeams,
  effectiveRoles,
  fieldAccess,
  maskRow,
  canWriteField,
  effectiveMatrix,
  createContext,
  SYSTEM_ROLES,
  ENTITIES,
  ACTIONS,
} from '../../shared/permissions/index.js';
import { ORG, subjectOf, ctxOf, roleOf } from './support.mjs';

// atalhos ---------------------------------------------------------------------
const ME = 'me';
const OTHER = 'other';
const deal = (o = {}) => ({ id: 'd1', tenantId: 'A', ownerId: OTHER, teamId: 'T2', pipelineId: 'p1', stageId: 's1', status: 'open', value: 100, ...o });
const conv = (o = {}) => ({ id: 'c1', tenantId: 'A', assigneeId: OTHER, ownerId: undefined, teamId: 'T2', instanceId: 'i1', status: 'open', ...o });
const grant = (entity, actions, scope, extra = {}) => ({ entity, actions, scope, ...extra });
/** Contexto com um único perfil de tenant `r1` com os grants dados. */
const withGrants = (grants, { subject = {}, role = {}, org = ORG, policy = {} } = {}) => {
  const r = roleOf('r1', grants, role);
  return ctxOf(subjectOf(ME, ['r1'], subject), { tenantRoles: [r], org, policy });
};
const eff = (ctx, entity, action, row, context) => decide(ctx, entity, action, row, context).effect;

describe('escopos', () => {
  test('none: nunca dá acesso, mesmo no próprio registro', () => {
    const ctx = withGrants([grant('deal', ['read'], 'none')]);
    const d = decide(ctx, 'deal', 'read', deal({ ownerId: ME }));
    assert.deepEqual([d.effect, d.reason], ['deny', 'no_grant']);
  });

  test('own: só o registro do próprio usuário (null/ausente/outro negam)', () => {
    const ctx = withGrants([grant('deal', ['read'], 'own')]);
    assert.equal(eff(ctx, 'deal', 'read', deal({ ownerId: ME })), 'allow');
    assert.equal(eff(ctx, 'deal', 'read', deal({ ownerId: OTHER })), 'deny');
    assert.equal(eff(ctx, 'deal', 'read', deal({ ownerId: null })), 'deny');
    assert.equal(eff(ctx, 'deal', 'read', deal({ ownerId: undefined })), 'deny');
    // estar na equipe NÃO basta para 'own'
    assert.equal(eff(ctx, 'deal', 'read', deal({ ownerId: OTHER, teamId: 'T1' })), 'deny');
  });

  test('own em conversa usa assigneeId (ownerField do catálogo), não ownerId', () => {
    const ctx = withGrants([grant('conversation', ['read'], 'own')]);
    assert.equal(eff(ctx, 'conversation', 'read', conv({ assigneeId: ME })), 'allow');
    assert.equal(eff(ctx, 'conversation', 'read', conv({ assigneeId: OTHER, ownerId: ME })), 'deny');
  });

  test('team: próprio OU equipe do usuário; NÃO inclui subequipes nem equipe-pai', () => {
    const ctx = withGrants([grant('deal', ['read'], 'team')]);
    assert.equal(eff(ctx, 'deal', 'read', deal({ teamId: 'T1' })), 'allow');
    assert.equal(eff(ctx, 'deal', 'read', deal({ teamId: 'T1a' })), 'deny', 'subequipe não conta em "team"');
    assert.equal(eff(ctx, 'deal', 'read', deal({ teamId: 'T2' })), 'deny');
    assert.equal(eff(ctx, 'deal', 'read', deal({ teamId: null })), 'deny');
    assert.equal(eff(ctx, 'deal', 'read', deal({ teamId: 'T2', ownerId: ME })), 'allow', 'o próprio sempre entra');
    const sub = withGrants([grant('deal', ['read'], 'team')], { subject: { teamIds: ['T1a'] } });
    assert.equal(eff(sub, 'deal', 'read', deal({ teamId: 'T1' })), 'deny', 'equipe-pai não é "da equipe" de quem está na filha');
  });

  test('team: usuário em várias equipes; usuário sem equipe só vê o próprio', () => {
    const multi = withGrants([grant('deal', ['read'], 'team')], { subject: { teamIds: ['T2', 'T1'] } });
    assert.equal(eff(multi, 'deal', 'read', deal({ teamId: 'T1' })), 'allow');
    assert.equal(eff(multi, 'deal', 'read', deal({ teamId: 'T2' })), 'allow');
    const none = withGrants([grant('deal', ['read'], 'team')], { subject: { teamIds: [] } });
    assert.equal(eff(none, 'deal', 'read', deal({ teamId: 'T1' })), 'deny');
    assert.equal(eff(none, 'deal', 'read', deal({ ownerId: ME })), 'allow');
  });

  test('team_tree: equipe, subequipes e sub-subequipes; nunca ancestrais nem irmãs', () => {
    const ctx = withGrants([grant('deal', ['read'], 'team_tree')]);
    for (const t of ['T1', 'T1a', 'T1a1']) assert.equal(eff(ctx, 'deal', 'read', deal({ teamId: t })), 'allow', t);
    for (const t of ['T2', 'T2a', 'T9', null]) assert.equal(eff(ctx, 'deal', 'read', deal({ teamId: t })), 'deny', String(t));
    const filha = withGrants([grant('deal', ['read'], 'team_tree')], { subject: { teamIds: ['T1a'] } });
    assert.equal(eff(filha, 'deal', 'read', deal({ teamId: 'T1' })), 'deny', 'ancestral não entra');
    assert.equal(eff(filha, 'deal', 'read', deal({ teamId: 'T1a1' })), 'allow');
  });

  test('team_tree com CICLO no organograma termina e inclui os dois lados', () => {
    const ciclo = { teams: [{ id: 'T1', parentId: 'T2' }, { id: 'T2', parentId: 'T1' }, { id: 'T3', parentId: 'T3' }, { id: 'T9' }] };
    const ctx = withGrants([grant('deal', ['read'], 'team_tree')], { org: ciclo });
    assert.equal(eff(ctx, 'deal', 'read', deal({ teamId: 'T1' })), 'allow');
    assert.equal(eff(ctx, 'deal', 'read', deal({ teamId: 'T2' })), 'allow');
    assert.equal(eff(ctx, 'deal', 'read', deal({ teamId: 'T9' })), 'deny');
    const auto = withGrants([grant('deal', ['read'], 'team_tree')], { org: ciclo, subject: { teamIds: ['T3'] } });
    assert.equal(eff(auto, 'deal', 'read', deal({ teamId: 'T3' })), 'allow', 'auto-referência');
    assert.deepEqual(expandTeams(ciclo, ['T1']).sort(), ['T1', 'T2']);
    assert.deepEqual(expandTeams(ciclo, ['T3']), ['T3']);
  });

  test('expandTeams: sem org/sem equipes/ids desconhecidos/duplicados', () => {
    assert.deepEqual(expandTeams(undefined, ['T1']), ['T1']);
    assert.deepEqual(expandTeams({ teams: [] }, []), []);
    assert.deepEqual(expandTeams(ORG, undefined), []);
    assert.deepEqual(expandTeams(ORG, ['X']), ['X'], 'equipe fora do organograma vale por si só');
    assert.deepEqual(expandTeams(ORG, ['T1', 'T1', 'T1a']).sort(), ['T1', 'T1a', 'T1a1']);
    assert.deepEqual(expandTeams(ORG, ['T1']).sort(), ['T1', 'T1a', 'T1a1']);
    assert.deepEqual(expandTeams(ORG, ['T2']).sort(), ['T2', 'T2a']);
  });

  test('tenant: qualquer registro do tenant, inclusive sem dono e sem equipe', () => {
    const ctx = withGrants([grant('deal', ['read'], 'tenant')]);
    assert.equal(eff(ctx, 'deal', 'read', deal({ ownerId: null, teamId: null })), 'allow');
    assert.equal(eff(ctx, 'deal', 'read', {}), 'deny', 'registro vazio não tem tenantId');
  });

  test('escopo de equipe/dono em entidade de CONFIGURAÇÃO (sem dono) não dá nada', () => {
    for (const scope of ['own', 'team', 'team_tree']) {
      const ctx = withGrants([grant('product', ['read'], scope)]);
      assert.equal(eff(ctx, 'product', 'read', { id: 'x', tenantId: 'A', ownerId: ME, teamId: 'T1' }), 'deny', scope);
    }
  });

  test('escopo desconhecido não dá acesso (falha fechado)', () => {
    for (const scope of ['all', 'global', '', undefined, null, 'TENANT']) {
      const ctx = withGrants([{ entity: 'deal', actions: ['read'], scope }]);
      assert.equal(eff(ctx, 'deal', 'read', deal({ ownerId: ME })), 'deny', String(scope));
    }
  });
});

describe('condições', () => {
  const cond = (field, op, value, extra = {}) => withGrants([grant('deal', ['read'], 'tenant', { conditions: [{ field, op, value, ...extra }] })]);

  // [op, valorDaCondição, valorDaLinha, esperado]  — semântica DOIS-valorada
  const TABLE = [
    ['eq', 100, 100, true],
    ['eq', 100, 99, false],
    ['eq', 100, null, false],
    ['eq', 100, undefined, false],
    ['eq', null, null, false], // eq com valor nulo nunca casa (use isNull)
    ['ne', 100, 99, true],
    ['ne', 100, 100, false],
    ['ne', 100, null, true], // null à esquerda: ne = true
    ['ne', null, null, false], // IS DISTINCT FROM: null vs null não é distinto (igual ao SQL)
    ['ne', null, 5, true],
    ['in', [1, 100], 100, true],
    ['in', [1, 2], 100, false],
    ['in', [1, 2], null, false],
    ['in', [], 100, false],
    ['nin', [1, 2], 100, true],
    ['nin', [100], 100, false],
    ['nin', [1, 2], null, true], // null à esquerda: nin = true
    ['nin', [], null, true],
    ['lt', 101, 100, true],
    ['lt', 100, 100, false],
    ['lt', 100, null, false],
    ['lt', null, 5, false], // comparação ordenada com valor nulo é falsa (como no SQL)
    ['lte', 100, 100, true],
    ['lte', 99, 100, false],
    ['lte', 100, null, false],
    ['lte', null, 0, false],
    ['gt', 99, 100, true],
    ['gt', 100, 100, false],
    ['gt', 0, null, false],
    ['gt', null, 5, false],
    ['gte', 100, 100, true],
    ['gte', 101, 100, false],
    ['gte', 0, null, false],
    ['gte', null, 0, false],
  ];
  for (const [op, v, left, expected] of TABLE) {
    test(`operador ${op} ${JSON.stringify(v)} contra ${left === undefined ? 'AUSENTE' : JSON.stringify(left)} => ${expected}`, () => {
      const ctx = cond('value', op, v);
      const row = deal({ value: left });
      assert.equal(eff(ctx, 'deal', 'read', row), expected ? 'allow' : 'deny');
      // a lista (filtro) tem que dar a MESMA resposta
      assert.equal(toPredicate(filterFor(ctx, 'deal', 'read').expr)(row), expected);
    });
  }

  test('isNull / notNull (null e ausente contam como nulo)', () => {
    const isNull = cond('assigneeId', 'isNull');
    const notNull = cond('ownerId', 'notNull');
    assert.equal(eff(withGrants([grant('conversation', ['read'], 'tenant', { conditions: [{ field: 'assigneeId', op: 'isNull' }] })]), 'conversation', 'read', conv({ assigneeId: null })), 'allow');
    assert.equal(eff(withGrants([grant('conversation', ['read'], 'tenant', { conditions: [{ field: 'assigneeId', op: 'isNull' }] })]), 'conversation', 'read', conv({ assigneeId: undefined })), 'allow');
    assert.equal(eff(withGrants([grant('conversation', ['read'], 'tenant', { conditions: [{ field: 'assigneeId', op: 'isNull' }] })]), 'conversation', 'read', conv({ assigneeId: OTHER })), 'deny');
    assert.equal(eff(notNull, 'deal', 'read', deal({ ownerId: null })), 'deny');
    assert.equal(eff(notNull, 'deal', 'read', deal({ ownerId: OTHER })), 'allow');
    void isNull;
  });

  test('condições se compõem com E (todas precisam valer)', () => {
    const ctx = withGrants([
      grant('deal', ['read'], 'tenant', {
        conditions: [
          { field: 'status', op: 'eq', value: 'open' },
          { field: 'value', op: 'lt', value: 1000 },
          { field: 'pipelineId', op: 'in', value: ['p1', 'p2'] },
        ],
      }),
    ]);
    assert.equal(eff(ctx, 'deal', 'read', deal()), 'allow');
    assert.equal(eff(ctx, 'deal', 'read', deal({ status: 'won' })), 'deny');
    assert.equal(eff(ctx, 'deal', 'read', deal({ value: 1000 })), 'deny');
    assert.equal(eff(ctx, 'deal', 'read', deal({ pipelineId: 'p3' })), 'deny');
  });

  test('referências: $user.id e $user.teamIds', () => {
    const own = withGrants([grant('deal', ['read'], 'tenant', { conditions: [{ field: 'ownerId', op: 'eq', ref: '$user.id' }] })]);
    assert.equal(eff(own, 'deal', 'read', deal({ ownerId: ME })), 'allow');
    assert.equal(eff(own, 'deal', 'read', deal({ ownerId: OTHER })), 'deny');
    const mine = withGrants([grant('deal', ['read'], 'tenant', { conditions: [{ field: 'teamId', op: 'in', ref: '$user.teamIds' }] })], { subject: { teamIds: ['T1', 'T2a'] } });
    assert.equal(eff(mine, 'deal', 'read', deal({ teamId: 'T2a' })), 'allow');
    assert.equal(eff(mine, 'deal', 'read', deal({ teamId: 'T2' })), 'deny');
    const notMine = withGrants([grant('deal', ['read'], 'tenant', { conditions: [{ field: 'teamId', op: 'nin', ref: '$user.teamIds' }] })]);
    assert.equal(eff(notMine, 'deal', 'read', deal({ teamId: 'T1' })), 'deny');
    assert.equal(eff(notMine, 'deal', 'read', deal({ teamId: 'T2' })), 'allow');
    assert.equal(eff(notMine, 'deal', 'read', deal({ teamId: null })), 'allow', 'nin com null à esquerda é true');
  });

  test('referência é resolvida na COMPILAÇÃO: trocar de usuário muda o resultado', () => {
    const roles = [roleOf('r1', [grant('deal', ['read'], 'tenant', { conditions: [{ field: 'ownerId', op: 'eq', ref: '$user.id' }] })])];
    const a = ctxOf(subjectOf('ana', ['r1']), { tenantRoles: roles });
    const b = ctxOf(subjectOf('bia', ['r1']), { tenantRoles: roles });
    const row = deal({ ownerId: 'ana' });
    assert.equal(eff(a, 'deal', 'read', row), 'allow');
    assert.equal(eff(b, 'deal', 'read', row), 'deny');
  });

  test('atributo inexistente na condição de GRANT: o grant não vale (falha fechado)', () => {
    const ctx = withGrants([grant('deal', ['read'], 'tenant', { conditions: [{ field: 'campoQueNaoExiste', op: 'isNull' }] })]);
    assert.equal(eff(ctx, 'deal', 'read', deal()), 'deny');
  });

  test('condição com ctx.* em grant: precisa do contexto e do valor certo', () => {
    const ctx = withGrants([grant('deal', ['approve'], 'tenant', { conditions: [{ field: 'ctx.discountPct', op: 'lte', value: 10 }] })]);
    assert.equal(eff(ctx, 'deal', 'approve', deal(), { discountPct: 10 }), 'allow');
    assert.equal(eff(ctx, 'deal', 'approve', deal(), { discountPct: 10.01 }), 'deny');
    assert.equal(eff(ctx, 'deal', 'approve', deal(), { discountPct: 0 }), 'allow');
    assert.equal(eff(ctx, 'deal', 'approve', deal(), { discountPct: -5 }), 'deny', 'número negativo é inválido no contexto => desconhecido');
    assert.equal(eff(ctx, 'deal', 'approve', deal(), {}), 'deny', 'chave ausente');
    assert.equal(eff(ctx, 'deal', 'approve', deal(), { discountPct: undefined }), 'deny');
    assert.equal(eff(ctx, 'deal', 'approve', deal(), { discountPct: null }), 'deny', 'null não é <= 10');
    assert.equal(eff(ctx, 'deal', 'approve', deal()), 'deny', 'sem contexto');
    assert.equal(eff(ctx, 'deal', 'approve', deal(), null), 'deny');
    assert.equal(eff(ctx, 'deal', 'approve', deal(), 'discountPct'), 'deny', 'contexto que não é objeto');
  });

  test('ctx herdado de Object.prototype não conta (ctx.constructor)', () => {
    const ctx = withGrants([grant('deal', ['approve'], 'tenant', { conditions: [{ field: 'ctx.constructor', op: 'notNull' }] })]);
    assert.equal(eff(ctx, 'deal', 'approve', deal(), {}), 'deny');
  });
});

describe('partições (pipelineId / instanceId)', () => {
  const part = (partitions, grants = [grant('deal', ['read', 'update'], 'tenant')]) => withGrants(grants, { role: { partitions } });

  test('lista de pipelines restringe só deals daquele pipeline; null/ausente nega', () => {
    const ctx = part({ pipelineId: ['p1'] });
    assert.equal(eff(ctx, 'deal', 'read', deal({ pipelineId: 'p1' })), 'allow');
    assert.equal(eff(ctx, 'deal', 'read', deal({ pipelineId: 'p2' })), 'deny');
    assert.equal(eff(ctx, 'deal', 'read', deal({ pipelineId: null })), 'deny');
    assert.equal(eff(ctx, 'deal', 'read', deal({ pipelineId: undefined })), 'deny');
  });

  test("'all', ausente e a chave da OUTRA partição não restringem", () => {
    for (const p of [{ pipelineId: 'all' }, {}, { instanceId: ['i9'] }]) {
      assert.equal(eff(part(p), 'deal', 'read', deal({ pipelineId: 'qualquer' })), 'allow', JSON.stringify(p));
    }
  });

  test('lista vazia = nenhum pipeline; valores não-lista corrompidos também = nenhum', () => {
    for (const v of [[], null, '', 'p1', 0, {}]) {
      assert.equal(eff(part({ pipelineId: v }), 'deal', 'read', deal({ pipelineId: 'p1' })), 'deny', JSON.stringify(v));
    }
  });

  test('instanceId restringe conversas e chamadas; não afeta contato', () => {
    const ctx = withGrants(
      [grant('conversation', ['read'], 'tenant'), grant('call', ['read'], 'tenant'), grant('contact', ['read'], 'tenant')],
      { role: { partitions: { instanceId: ['i1'] } } }
    );
    assert.equal(eff(ctx, 'conversation', 'read', conv({ instanceId: 'i1' })), 'allow');
    assert.equal(eff(ctx, 'conversation', 'read', conv({ instanceId: 'i2' })), 'deny');
    assert.equal(eff(ctx, 'call', 'read', { id: 'k', tenantId: 'A', instanceId: 'i2' }), 'deny');
    assert.equal(eff(ctx, 'call', 'read', { id: 'k', tenantId: 'A', instanceId: 'i1' }), 'allow');
    assert.equal(eff(ctx, 'contact', 'read', { id: 'c', tenantId: 'A' }), 'allow');
  });

  test('partição vale POR PERFIL: um perfil sem partição soma e libera o resto', () => {
    const restrito = roleOf('r1', [grant('deal', ['read'], 'tenant')], { partitions: { pipelineId: ['p1'] } });
    const livre = roleOf('r2', [grant('deal', ['read'], 'own')]);
    const ctx = ctxOf(subjectOf(ME, ['r1', 'r2']), { tenantRoles: [restrito, livre] });
    assert.equal(eff(ctx, 'deal', 'read', deal({ pipelineId: 'p2' })), 'deny');
    assert.equal(eff(ctx, 'deal', 'read', deal({ pipelineId: 'p2', ownerId: ME })), 'allow', 'o grant own do outro perfil não tem partição');
  });

  test('grants individuais (overrides do usuário) não sofrem partição de perfil', () => {
    const r = roleOf('r1', [], { partitions: { pipelineId: [] } });
    const ctx = ctxOf(subjectOf(ME, ['r1'], { overrides: { grants: [grant('deal', ['read'], 'tenant')] } }), { tenantRoles: [r] });
    assert.equal(eff(ctx, 'deal', 'read', deal({ pipelineId: 'p9' })), 'allow');
  });

  test('a lista (filtro) respeita a partição igual a decide()', () => {
    const ctx = part({ pipelineId: ['p1', 'p3'] });
    const p = toPredicate(filterFor(ctx, 'deal', 'read').expr);
    for (const pipelineId of ['p1', 'p2', 'p3', null]) assert.equal(p(deal({ pipelineId })), eff(ctx, 'deal', 'read', deal({ pipelineId })) === 'allow');
  });
});

describe('compartilhamento por registro', () => {
  const semPerfil = (extra = {}) => ctxOf(subjectOf(ME, [], extra));
  const shareUser = (level, id = ME) => ({ type: 'user', id, level });
  const shareTeam = (level, id) => ({ type: 'team', id, level });

  test('share read com o usuário: lê, mas não edita nem apaga', () => {
    const ctx = semPerfil();
    const row = deal({ sharedWith: [shareUser('read')] });
    assert.equal(eff(ctx, 'deal', 'read', row), 'allow');
    assert.equal(eff(ctx, 'deal', 'update', row), 'deny');
    assert.equal(eff(ctx, 'deal', 'delete', row), 'deny');
    assert.equal(eff(ctx, 'deal', 'export', row), 'deny');
  });

  test('share edit: lê e edita; continua sem apagar/exportar/transferir', () => {
    const ctx = semPerfil();
    const row = deal({ sharedWith: [shareUser('edit')] });
    assert.equal(eff(ctx, 'deal', 'read', row), 'allow');
    assert.equal(eff(ctx, 'deal', 'update', row), 'allow');
    for (const a of ['delete', 'export', 'transfer', 'move', 'approve', 'create', 'import']) assert.equal(eff(ctx, 'deal', a, row), 'deny', a);
  });

  test('share com OUTRO usuário, com nível desconhecido ou de tipo desconhecido não vale', () => {
    const ctx = semPerfil();
    assert.equal(eff(ctx, 'deal', 'read', deal({ sharedWith: [shareUser('read', OTHER)] })), 'deny');
    assert.equal(eff(ctx, 'deal', 'read', deal({ sharedWith: [shareUser('admin')] })), 'deny');
    assert.equal(eff(ctx, 'deal', 'read', deal({ sharedWith: [{ type: 'role', id: ME, level: 'read' }] })), 'deny');
    assert.equal(eff(ctx, 'deal', 'read', deal({ sharedWith: 'me' })), 'deny');
    assert.equal(eff(ctx, 'deal', 'read', deal({ sharedWith: [null, undefined, 7, {}] })), 'deny');
  });

  test('share com a equipe do usuário (exatamente; nunca por hierarquia)', () => {
    const ctx = semPerfil();
    assert.equal(eff(ctx, 'deal', 'read', deal({ sharedWith: [shareTeam('read', 'T1')] })), 'allow');
    assert.equal(eff(ctx, 'deal', 'read', deal({ sharedWith: [shareTeam('read', 'T2')] })), 'deny');
    assert.equal(eff(ctx, 'deal', 'update', deal({ sharedWith: [shareTeam('read', 'T1')] })), 'deny');
    assert.equal(eff(ctx, 'deal', 'update', deal({ sharedWith: [shareTeam('edit', 'T1')] })), 'allow');
    // share com a SUBequipe NÃO alcança quem está só na equipe-pai (expandir para cima vazaria dados)
    assert.equal(eff(ctx, 'deal', 'read', deal({ sharedWith: [shareTeam('read', 'T1a')] })), 'deny');
    // e nunca o contrário: share com a equipe-pai não alcança quem está só na filha
    const filha = semPerfil({ teamIds: ['T1a'] });
    assert.equal(eff(filha, 'deal', 'read', deal({ sharedWith: [shareTeam('read', 'T1')] })), 'deny');
  });

  test('só entidades "shareable": tarefa não aceita share; contato e empresa aceitam', () => {
    const ctx = semPerfil();
    assert.equal(eff(ctx, 'task', 'read', { id: 't', tenantId: 'A', sharedWith: [shareUser('edit')] }), 'deny');
    assert.equal(eff(ctx, 'contact', 'read', { id: 'c', tenantId: 'A', sharedWith: [shareUser('read')] }), 'allow');
    assert.equal(eff(ctx, 'company', 'update', { id: 'c', tenantId: 'A', sharedWith: [shareUser('edit')] }), 'allow');
    assert.equal(eff(ctx, 'conversation', 'read', conv({ sharedWith: [shareUser('edit')] })), 'deny');
  });

  test('share NUNCA atravessa tenant nem vence deny (nem usuário inativo)', () => {
    const row = deal({ sharedWith: [shareUser('edit')] });
    assert.equal(eff(semPerfil(), 'deal', 'read', { ...row, tenantId: 'B' }), 'deny');
    assert.equal(eff(semPerfil({ status: 'suspended' }), 'deal', 'read', row), 'deny');
    const comDeny = ctxOf(subjectOf(ME, [], { overrides: { denies: [{ entity: 'deal', actions: ['read'] }] } }));
    assert.equal(eff(comDeny, 'deal', 'read', row), 'deny');
    assert.equal(decide(comDeny, 'deal', 'read', row).reason, 'denied');
  });

  test('COMPORTAMENTO ATUAL: share ignora a partição de pipeline do perfil (ver questoesDeDesign)', () => {
    const r = roleOf('r1', [grant('deal', ['read'], 'tenant')], { partitions: { pipelineId: ['p1'] } });
    const ctx = ctxOf(subjectOf(ME, ['r1']), { tenantRoles: [r] });
    assert.equal(eff(ctx, 'deal', 'read', deal({ pipelineId: 'p2' })), 'deny');
    assert.equal(eff(ctx, 'deal', 'read', deal({ pipelineId: 'p2', sharedWith: [shareUser('read')] })), 'allow');
  });

  test('a lista (filtro) também aplica o share', () => {
    const ctx = semPerfil();
    const p = toPredicate(filterFor(ctx, 'deal', 'read').expr);
    assert.equal(p(deal({ sharedWith: [shareUser('read')] })), true);
    assert.equal(p(deal()), false);
  });
});

describe('aprovação', () => {
  const agent = (when) => withGrants([grant('proposal', ['update'], 'own', { approval: { when } })]);
  const prop = (o = {}) => ({ id: 'p', tenantId: 'A', ownerId: ME, ...o });

  test('when com ctx: abaixo do limite = allow; acima = approval; borda exata não exige', () => {
    const ctx = agent([{ field: 'ctx.discountPct', op: 'gt', value: 5 }]);
    assert.equal(eff(ctx, 'proposal', 'update', prop(), { discountPct: 3 }), 'allow');
    assert.equal(eff(ctx, 'proposal', 'update', prop(), { discountPct: 5 }), 'allow');
    assert.equal(eff(ctx, 'proposal', 'update', prop(), { discountPct: 5.01 }), 'approval');
    assert.equal(eff(ctx, 'proposal', 'update', prop(), { discountPct: 8 }), 'approval');
    const d = decide(ctx, 'proposal', 'update', prop(), { discountPct: 8 });
    assert.equal(d.reason, 'needs_approval');
    assert.deepEqual(d.matched, ['perfil:r1#0']);
  });

  test('ctx AUSENTE (nenhum/{}/chave undefined/null) => exige aprovação (nunca allow direto)', () => {
    const ctx = agent([{ field: 'ctx.discountPct', op: 'gt', value: 5 }]);
    for (const c of [undefined, null, {}, { discountPct: undefined }, 'x', 42, []]) assert.equal(eff(ctx, 'proposal', 'update', prop(), c), 'approval', JSON.stringify(c));
  });

  test('can() só vale para allow direto; canOrRequest() inclui aprovação', () => {
    const ctx = agent([{ field: 'ctx.discountPct', op: 'gt', value: 5 }]);
    assert.equal(can(ctx, 'proposal', 'update', prop(), { discountPct: 8 }), false);
    assert.equal(canOrRequest(ctx, 'proposal', 'update', prop(), { discountPct: 8 }), true);
    assert.equal(can(ctx, 'proposal', 'update', prop(), { discountPct: 1 }), true);
    assert.equal(canOrRequest(ctx, 'proposal', 'update', prop({ ownerId: OTHER }), { discountPct: 1 }), false, 'sem grant continua negado');
  });

  test('approval.when vazio = SEMPRE exige aprovação', () => {
    const ctx = agent([]);
    assert.equal(eff(ctx, 'proposal', 'update', prop(), { discountPct: 0 }), 'approval');
  });

  test('outro grant direto (outro perfil) dispensa a aprovação — permissões somam', () => {
    const a = roleOf('r1', [grant('proposal', ['update'], 'own', { approval: { when: [{ field: 'ctx.discountPct', op: 'gt', value: 5 }] } })]);
    const b = roleOf('r2', [grant('proposal', ['update'], 'own')]);
    const ctx = ctxOf(subjectOf(ME, ['r1', 'r2']), { tenantRoles: [a, b] });
    const d = decide(ctx, 'proposal', 'update', prop(), { discountPct: 50 });
    assert.equal(d.effect, 'allow');
    assert.deepEqual(d.matched, ['perfil:r2#0'], 'só o ramo direto é reportado');
  });

  test('dois perfis com aprovação: approval lista os dois ramos; um liberado e outro não => allow', () => {
    const a = roleOf('r1', [grant('proposal', ['update'], 'own', { approval: { when: [{ field: 'ctx.discountPct', op: 'gt', value: 5 }] } })]);
    const b = roleOf('r2', [grant('proposal', ['update'], 'own', { approval: { when: [{ field: 'ctx.discountPct', op: 'gt', value: 20 }] } })]);
    const ctx = ctxOf(subjectOf(ME, ['r1', 'r2']), { tenantRoles: [a, b] });
    assert.equal(eff(ctx, 'proposal', 'update', prop(), { discountPct: 10 }), 'allow', 'r2 só exige acima de 20');
    const d = decide(ctx, 'proposal', 'update', prop(), { discountPct: 30 });
    assert.equal(d.effect, 'approval');
    assert.deepEqual(d.matched, ['perfil:r1#0', 'perfil:r2#0']);
  });

  test('aprovação nunca contorna deny, tenant, escopo nem usuário inativo', () => {
    const ctx = withGrants([grant('proposal', ['update'], 'own', { approval: { when: [] } })], { subject: { overrides: { denies: [{ entity: 'proposal', actions: ['update'] }] } } });
    assert.equal(eff(ctx, 'proposal', 'update', prop()), 'deny');
    const c2 = agent([]);
    assert.equal(eff(c2, 'proposal', 'update', prop({ tenantId: 'B' })), 'deny');
    assert.equal(eff(c2, 'proposal', 'update', prop({ ownerId: OTHER })), 'deny');
    assert.equal(eff(withGrants([grant('proposal', ['update'], 'own', { approval: { when: [] } })], { subject: { status: 'suspended' } }), 'proposal', 'update', prop()), 'deny');
  });

  test('approval.when sobre atributo do registro e atributo inexistente (desconhecido = exige)', () => {
    const ctx = agent([{ field: 'status', op: 'eq', value: 'sent' }]);
    assert.equal(eff(ctx, 'proposal', 'update', prop({ status: 'draft' })), 'allow');
    assert.equal(eff(ctx, 'proposal', 'update', prop({ status: 'sent' })), 'approval');
    const bogus = agent([{ field: 'naoExiste', op: 'eq', value: 1 }]);
    assert.equal(eff(bogus, 'proposal', 'update', prop()), 'approval');
  });

  test('a lista mostra linhas com aprovação (effect !== deny) e não as negadas', () => {
    const ctx = agent([{ field: 'ctx.discountPct', op: 'gt', value: 5 }]);
    const p = toPredicate(filterFor(ctx, 'proposal', 'update').expr);
    assert.equal(p(prop()), true);
    assert.equal(p(prop({ ownerId: OTHER })), false);
  });
});

describe('denies', () => {
  const ctxWith = (deny, grants = [grant('deal', ['*'], 'tenant')], subject = {}) => withGrants(grants, { subject, role: { denies: [deny] } });

  test("deny '*' em entidade e em ação: tudo vira negado, mesmo com grant '*'", () => {
    const ctx = ctxWith({ entity: '*', actions: ['*'] }, [{ entity: '*', actions: ['*'], scope: 'tenant' }]);
    for (const [entity, e] of Object.entries(ENTITIES)) for (const a of e.actions) assert.equal(eff(ctx, entity, a, { id: 'x', tenantId: 'A', ownerId: ME }), 'deny', `${entity}.${a}`);
  });

  test('deny de uma ação não afeta as outras nem outras entidades', () => {
    const ctx = ctxWith({ entity: 'deal', actions: ['delete'] }, [{ entity: '*', actions: ['*'], scope: 'tenant' }]);
    assert.equal(eff(ctx, 'deal', 'delete', deal()), 'deny');
    assert.equal(eff(ctx, 'deal', 'update', deal()), 'allow');
    assert.equal(eff(ctx, 'contact', 'delete', { id: 'c', tenantId: 'A' }), 'allow');
    assert.equal(decide(ctx, 'deal', 'delete', deal()).reason, 'denied');
    assert.deepEqual(decide(ctx, 'deal', 'delete', deal()).matched, ['perfil:r1:nega#0']);
  });

  test('deny com ctx.toStageKind: só nega os tipos listados; ctx ausente/ indefinido nega', () => {
    const ctx = ctxWith({ entity: 'deal', actions: ['move'], conditions: [{ field: 'ctx.toStageKind', op: 'in', value: ['won', 'lost'] }] });
    assert.equal(eff(ctx, 'deal', 'move', deal(), { toStageKind: 'open' }), 'allow');
    assert.equal(eff(ctx, 'deal', 'move', deal(), { toStageKind: 'won' }), 'deny');
    assert.equal(eff(ctx, 'deal', 'move', deal(), { toStageKind: 'lost' }), 'deny');
    for (const c of [undefined, null, {}, { toStageKind: undefined }, { fromStageKind: 'open' }, 'won']) assert.equal(eff(ctx, 'deal', 'move', deal(), c), 'deny', JSON.stringify(c));
    // a lista (sem contexto) trata como desconhecido => nega
    assert.equal(toPredicate(filterFor(ctx, 'deal', 'move').expr)(deal()), false);
  });

  test('ctx com valor null é DESCONHECIDO (lado seguro: o deny se aplica)', () => {
    const ctx = ctxWith({ entity: 'deal', actions: ['move'], conditions: [{ field: 'ctx.toStageKind', op: 'in', value: ['won', 'lost'] }] });
    assert.equal(eff(ctx, 'deal', 'move', deal(), { toStageKind: null }), 'deny');
  });

  test('deny condicionado a atributo do registro (valor de campo)', () => {
    const ctx = ctxWith({ entity: 'deal', actions: ['update'], conditions: [{ field: 'status', op: 'in', value: ['won', 'lost'] }] });
    assert.equal(eff(ctx, 'deal', 'update', deal({ status: 'open' })), 'allow');
    assert.equal(eff(ctx, 'deal', 'update', deal({ status: 'won' })), 'deny');
  });

  test('deny com atributo inexistente se aplica (no deny, desconhecido = verdadeiro)', () => {
    const ctx = ctxWith({ entity: 'deal', actions: ['update'], conditions: [{ field: 'campoFantasma', op: 'eq', value: 1 }] });
    assert.equal(eff(ctx, 'deal', 'update', deal()), 'deny');
  });

  test('deny em override do usuário e em outro perfil vencem o grant do primeiro', () => {
    const base = roleOf('r1', [grant('deal', ['*'], 'tenant')]);
    const restrito = roleOf('r2', [], { denies: [{ entity: 'deal', actions: ['delete'] }] });
    const c1 = ctxOf(subjectOf(ME, ['r1', 'r2']), { tenantRoles: [base, restrito] });
    assert.equal(eff(c1, 'deal', 'delete', deal()), 'deny');
    const c2 = ctxOf(subjectOf(ME, ['r1'], { overrides: { denies: [{ entity: 'deal', actions: ['delete'] }] } }), { tenantRoles: [base] });
    assert.equal(eff(c2, 'deal', 'delete', deal()), 'deny');
    assert.deepEqual(decide(c2, 'deal', 'delete', deal()).matched, ['usuario:nega#0']);
  });

  test('deny de perfil de OUTRO tenant é ignorado (e o perfil inteiro também)', () => {
    const base = roleOf('r1', [grant('deal', ['*'], 'tenant')]);
    const estranho = roleOf('rx', [], { tenantId: 'B', denies: [{ entity: '*', actions: ['*'] }] });
    const ctx = ctxOf(subjectOf(ME, ['r1', 'rx']), { tenantRoles: [base, estranho] });
    assert.equal(eff(ctx, 'deal', 'read', deal()), 'allow');
  });

  test('Admin + perfil com deny: deny vence (Admin não é imune)', () => {
    const r = roleOf('r1', [], { denies: [{ entity: 'billing', actions: ['*'] }] });
    const ctx = ctxOf(subjectOf(ME, ['role_admin', 'r1']), { tenantRoles: [r] });
    assert.equal(eff(ctx, 'billing', 'read', { id: 'b', tenantId: 'A' }), 'deny');
    assert.equal(eff(ctx, 'deal', 'read', deal()), 'allow');
  });

  test('Viewer (deny export *) tira o export de quem também é Admin', () => {
    const ctx = ctxOf(subjectOf(ME, ['role_admin', 'role_viewer']));
    assert.equal(eff(ctx, 'deal', 'export', deal()), 'deny');
    assert.equal(eff(ctx, 'report', 'export', { id: 'r', tenantId: 'A' }), 'deny');
    assert.equal(eff(ctx, 'deal', 'update', deal()), 'allow');
  });
});

describe('campos: fieldAccess / maskRow / canWriteField', () => {
  const f = (entity, field, access) => ({ entity, field, access });
  const mk = (fieldsA, fieldsB, overrides) => {
    const a = roleOf('r1', [grant('contact', ['*'], 'tenant')], { fields: fieldsA });
    const b = roleOf('r2', [], { fields: fieldsB });
    return ctxOf(subjectOf(ME, ['r1', 'r2'], overrides ? { overrides } : {}), { tenantRoles: [a, b] });
  };

  test('o mais restritivo entre os perfis vence (hidden > readonly > livre), em qualquer ordem', () => {
    assert.deepEqual(fieldAccess(mk([f('contact', 'phone', 'readonly')], [f('contact', 'phone', 'hidden')]), 'contact'), { phone: 'hidden' });
    assert.deepEqual(fieldAccess(mk([f('contact', 'phone', 'hidden')], [f('contact', 'phone', 'readonly')]), 'contact'), { phone: 'hidden' });
    assert.deepEqual(fieldAccess(mk([f('contact', 'phone', 'readonly')], []), 'contact'), { phone: 'readonly' });
    assert.deepEqual(fieldAccess(mk([], []), 'contact'), {});
  });

  test('Admin + perfil restritivo = campo oculto (restrição vence permissão)', () => {
    const r = roleOf('r1', [], { fields: [f('contact', 'phone', 'hidden')] });
    const ctx = ctxOf(subjectOf(ME, ['role_admin', 'r1']), { tenantRoles: [r] });
    assert.deepEqual(fieldAccess(ctx, 'contact'), { phone: 'hidden' });
    assert.equal('phone' in maskRow(ctx, 'contact', { id: 'c', phone: '1', email: 'e' }), false);
  });

  test('maskRow remove só os OCULTOS, preserva readonly e não muta a linha original', () => {
    const ctx = mk([f('contact', 'phone', 'hidden'), f('contact', 'email', 'readonly')], []);
    const row = { id: 'c', phone: '1', email: 'e', document: 'd', nome: 'x' };
    const m = maskRow(ctx, 'contact', row);
    assert.deepEqual(m, { id: 'c', email: 'e', document: 'd', nome: 'x' });
    assert.equal(row.phone, '1', 'linha original intacta');
    assert.notEqual(m, row);
  });

  test("restrição com entidade '*' vale para toda entidade que tenha o campo; campo inexistente é ignorado", () => {
    const ctx = mk([f('*', 'phone', 'hidden'), f('contact', 'inventado', 'hidden')], []);
    assert.deepEqual(fieldAccess(ctx, 'contact'), { phone: 'hidden' });
    assert.deepEqual(fieldAccess(ctx, 'conversation'), { phone: 'hidden' });
    assert.deepEqual(fieldAccess(ctx, 'deal'), {});
  });

  test('restrições do próprio usuário (overrides.fields) somam às do perfil', () => {
    const ctx = mk([f('contact', 'phone', 'readonly')], [], { fields: [f('contact', 'email', 'hidden'), f('contact', 'phone', 'hidden')] });
    assert.deepEqual(fieldAccess(ctx, 'contact'), { phone: 'hidden', email: 'hidden' });
    const wild = mk([], [], { fields: [f('*', 'document', 'hidden')] });
    assert.deepEqual(fieldAccess(wild, 'contact'), { document: 'hidden' }, "override com entidade '*' também vale");
  });

  test('access desconhecido vira hidden (falha fechado); "write" explícito não restringe', () => {
    for (const access of ['HIDDEN', 'none', 'ro', '', undefined, null, 5]) {
      assert.deepEqual(fieldAccess(mk([f('contact', 'phone', access)], []), 'contact'), { phone: 'hidden' }, String(access));
    }
    assert.deepEqual(fieldAccess(mk([f('contact', 'phone', 'write')], []), 'contact'), {});
  });

  test('canWriteField: precisa de update E campo livre', () => {
    const ctx = mk([f('contact', 'phone', 'readonly'), f('contact', 'email', 'hidden')], []);
    const row = { id: 'c', tenantId: 'A' };
    assert.equal(canWriteField(ctx, 'contact', 'phone', row), false);
    assert.equal(canWriteField(ctx, 'contact', 'email', row), false);
    assert.equal(canWriteField(ctx, 'contact', 'document', row), true);
    assert.equal(canWriteField(ctx, 'contact', 'document', { ...row, tenantId: 'B' }), false);
    assert.equal(canWriteField(ctxOf(subjectOf(ME, ['role_viewer'])), 'contact', 'document', row), false, 'sem update');
  });

  test('perfil de OUTRO tenant não restringe campos (é ignorado por inteiro)', () => {
    const r = roleOf('rx', [], { tenantId: 'B', fields: [f('contact', 'phone', 'hidden')] });
    assert.deepEqual(fieldAccess(ctxOf(subjectOf(ME, ['rx']), { tenantRoles: [r] }), 'contact'), {});
  });

  test('Financeiro (perfil de sistema) não vê telefone de contato, vê e-mail', () => {
    const ctx = ctxOf(subjectOf(ME, ['role_finance']));
    assert.deepEqual(maskRow(ctx, 'contact', { id: 'c', phone: '119', email: 'a@b' }), { id: 'c', email: 'a@b' });
  });
});

describe('estado do usuário, MFA e identidade', () => {
  const row = deal({ ownerId: ME });
  test('suspenso, convidado e status inválido: tudo negado com subject_inactive', () => {
    for (const status of ['suspended', 'invited', 'deleted', 'ACTIVE', 'Active', '', undefined, null, true, 1]) {
      const ctx = ctxOf(subjectOf(ME, ['role_admin'], { status }));
      for (const [entity, e] of Object.entries(ENTITIES)) {
        for (const a of e.actions) {
          const d = decide(ctx, entity, a, { id: 'x', tenantId: 'A', ownerId: ME });
          assert.equal(d.effect, 'deny', `${String(status)} ${entity}.${a}`);
          assert.equal(d.reason, 'subject_inactive');
        }
      }
      assert.equal(filterFor(ctx, 'deal', 'read').blocked, 'subject_inactive');
      assert.equal(toPredicate(filterFor(ctx, 'deal', 'read').expr)(row), false);
    }
  });

  test('subject ausente ou ctx vazio: nega sem lançar', () => {
    assert.equal(decide({ roles: new Map() }, 'deal', 'read', row).reason, 'subject_inactive');
    assert.equal(decide({ subject: null }, 'deal', 'read', row).effect, 'deny');
    assert.equal(decide(undefined, 'deal', 'read', row).effect, 'deny');
    assert.equal(decide({}, 'deal', 'read', row).effect, 'deny');
  });

  test('matriz efetiva de usuário inativo é toda "none"', () => {
    const m = effectiveMatrix(ctxOf(subjectOf(ME, ['role_admin'], { status: 'suspended' })));
    for (const e of Object.values(m)) for (const cell of Object.values(e)) assert.equal(cell.scope, 'none');
  });

  const SENSITIVE = Object.entries(ENTITIES).flatMap(([entity, e]) => e.actions.filter((a) => ACTIONS[a].sensitive).map((a) => [entity, a]));
  const NORMAL = Object.entries(ENTITIES).flatMap(([entity, e]) => e.actions.filter((a) => !ACTIONS[a].sensitive).map((a) => [entity, a]));

  test('catálogo tem ações sensíveis e normais para exercitar o MFA', () => {
    assert.ok(SENSITIVE.length > 10 && NORMAL.length > 30);
  });

  test('requireMfaForSensitive: ação sensível SEM mfa => mfa_required, mesmo para Admin', () => {
    const ctx = ctxOf(subjectOf(ME, ['role_admin'], { mfa: false }), { policy: { requireMfaForSensitive: true } });
    for (const [entity, a] of SENSITIVE) {
      const d = decide(ctx, entity, a, { id: 'x', tenantId: 'A' });
      assert.deepEqual([d.effect, d.reason], ['deny', 'mfa_required'], `${entity}.${a}`);
      assert.equal(filterFor(ctx, entity, a).blocked, 'mfa_required');
    }
    for (const [entity, a] of NORMAL) assert.equal(eff(ctx, entity, a, { id: 'x', tenantId: 'A' }), 'allow', `${entity}.${a} não é sensível`);
  });

  test('com mfa=true (qualquer política) ou política explicitamente desligada: sensível liberado', () => {
    const rowx = { id: 'x', tenantId: 'A' };
    const comMfa = ctxOf(subjectOf(ME, ['role_admin'], { mfa: true }), { policy: { requireMfaForSensitive: true } });
    const semPolitica = ctxOf(subjectOf(ME, ['role_admin'], { mfa: true }), { policy: {} });
    // política AUSENTE com mfa=false: nega (falha fechado)
    for (const [entity, a] of SENSITIVE) assert.equal(eff(ctxOf(subjectOf(ME, ['role_admin'], { mfa: false }), { policy: {} }), entity, a, { id: 'x', tenantId: 'A' }), 'deny', `${entity}.${a} sem política e sem mfa`);
    const desligada = ctxOf(subjectOf(ME, ['role_admin'], { mfa: undefined }), { policy: { requireMfaForSensitive: false } });
    for (const [entity, a] of SENSITIVE) for (const c of [comMfa, semPolitica, desligada]) assert.equal(eff(c, entity, a, rowx), 'allow', `${entity}.${a}`);
  });

  test('mfa truthy-mas-não-true: só o valor verdadeiro conta (0, "", null, undefined negam)', () => {
    for (const mfa of [0, '', null, undefined, false]) {
      const ctx = ctxOf(subjectOf(ME, ['role_admin'], { mfa }), { policy: { requireMfaForSensitive: true } });
      assert.equal(eff(ctx, 'deal', 'delete', { id: 'x', tenantId: 'A' }), 'deny', String(mfa));
    }
  });
});

describe('perfis de outro tenant, createContext e identidade de perfil', () => {
  test('perfil de outro tenant referenciado pelo usuário é ignorado por inteiro', () => {
    const r = roleOf('rx', [grant('*', ['*'], 'tenant')], { tenantId: 'B' });
    // direto no motor (sem passar pelo filtro do createContext)
    const ctx = { subject: subjectOf(ME, ['rx']), roles: new Map([['rx', r]]), org: ORG, policy: {} };
    assert.deepEqual(effectiveRoles(ctx), []);
    assert.equal(eff(ctx, 'deal', 'read', deal({ ownerId: ME })), 'deny');
    // roles como objeto simples também
    assert.equal(eff({ ...ctx, roles: { rx: r } }, 'deal', 'read', deal({ ownerId: ME })), 'deny');
  });

  test('perfil de sistema (tenantId null) vale para qualquer tenant', () => {
    const ctx = ctxOf(subjectOf(ME, ['role_admin'], { tenantId: 'Z' }));
    assert.equal(eff(ctx, 'deal', 'read', deal({ tenantId: 'Z' })), 'allow');
    assert.equal(eff(ctx, 'deal', 'read', deal({ tenantId: 'A' })), 'deny');
  });

  test('createContext RECUSA: id de perfil de sistema, system:true, outro tenant, sem tenant', () => {
    const admin = ctxOf(subjectOf(ME, ['role_admin']));
    const base = { grants: [grant('*', ['*'], 'tenant')], denies: [], partitions: {}, fields: [] };
    const roles = [
      { id: 'role_viewer', name: 'falso viewer', tenantId: 'A', system: false, ...base, denies: [{ entity: '*', actions: ['*'] }] }, // reaproveita id
      { id: 'sys', name: 's', tenantId: 'A', system: true, ...base },
      { id: 'b', name: 'b', tenantId: 'B', system: false, ...base },
      { id: 'nulo', name: 'n', tenantId: null, system: false, ...base },
      { id: 'semtenant', name: 'n', system: false, ...base },
      null,
      undefined,
      'texto',
    ];
    const ctx = ctxOf(subjectOf(ME, ['role_viewer', 'sys', 'b', 'nulo', 'semtenant']), { tenantRoles: roles });
    for (const id of ['sys', 'b', 'nulo', 'semtenant']) assert.equal(ctx.roles.has(id), false, id);
    // role_viewer continua sendo o de sistema (deny de export, nada de grants '*')
    assert.equal(ctx.roles.get('role_viewer'), SYSTEM_ROLES.find((r) => r.id === 'role_viewer'));
    assert.equal(eff(ctx, 'deal', 'update', deal({ ownerId: ME })), 'deny');
    void admin;
  });

  test('createContext aceita perfil válido do mesmo tenant; duplicata de id: o primeiro vence', () => {
    const r1 = roleOf('custom', [grant('deal', ['read'], 'tenant')]);
    const r2 = roleOf('custom', [grant('deal', ['*'], 'tenant')]);
    const ctx = ctxOf(subjectOf(ME, ['custom']), { tenantRoles: [r1, r2] });
    assert.equal(ctx.roles.get('custom'), r1);
    assert.equal(eff(ctx, 'deal', 'delete', deal()), 'deny');
  });

  test('createContext tolera tenantRoles não-lista e subject sem tenant', () => {
    assert.doesNotThrow(() => createContext({ subject: { id: 'x', tenantId: 'A' }, tenantRoles: undefined }));
    assert.doesNotThrow(() => createContext({ subject: { id: 'x', tenantId: 'A' }, tenantRoles: 'x' }));
    const c = createContext({ subject: { id: 'x', status: 'active' }, tenantRoles: [roleOf('r', [grant('*', ['*'], 'tenant')], { tenantId: undefined })] });
    assert.equal(c.roles.has('r'), false);
  });

  test('perfis de sistema são imutáveis em profundidade (um tenant não altera o Admin de todos)', () => {
    const admin = ctxOf(subjectOf(ME, ['role_admin'])).roles.get('role_admin');
    assert.throws(() => admin.grants.push({ entity: 'x' }), TypeError);
    assert.throws(() => (admin.grants[0].scope = 'none'), TypeError);
    assert.throws(() => (admin.name = 'x'), TypeError);
    assert.throws(() => SYSTEM_ROLES.push({}), TypeError);
    const viewer = SYSTEM_ROLES.find((r) => r.id === 'role_viewer');
    assert.throws(() => viewer.denies.pop(), TypeError);
    assert.throws(() => viewer.grants[0].actions.push('update'), TypeError);
  });
});

describe('entidade/ação desconhecida e explicações', () => {
  const ctx = ctxOf(subjectOf(ME, ['role_admin']));
  test('entidade ou ação desconhecida ou fora do catálogo da entidade => unknown_action', () => {
    const cases = [
      ['naoExiste', 'read'],
      ['deal', 'naoExiste'],
      ['contact', 'approve'], // ação existe no catálogo, mas não nesta entidade
      ['deal', '*'],
      ['deal', undefined],
      [undefined, 'read'],
      [null, 'read'],
      ['', 'read'],
      [123, 'read'],
      [{}, 'read'],
      [['deal'], 'read'],
      ['DEAL', 'read'],
      ['deal ', 'read'],
    ];
    for (const [e, a] of cases) {
      const d = decide(ctx, e, a, deal());
      assert.deepEqual([d.effect, d.reason], ['deny', 'unknown_action'], `${String(e)}.${String(a)}`);
      if (a !== undefined) assert.equal(filterFor(ctx, e, a).blocked, 'unknown_action'); // filterFor(…, undefined) usa o padrão 'read'
    }
  });

  test('nomes herdados de Object.prototype NÃO são entidades, ações nem atributos (antes lançava TypeError)', () => {
    for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', 'prototype']) {
      assert.doesNotThrow(() => decide(ctx, name, 'read', deal()), name);
      assert.equal(decide(ctx, name, 'read', deal()).reason, 'unknown_action', name);
      assert.equal(decide(ctx, 'deal', name, deal()).reason, 'unknown_action', name);
      assert.deepEqual(fieldAccess(ctx, name), {});
      assert.equal(Object.hasOwn(ENTITIES, name), false);
      assert.equal(Object.hasOwn(ACTIONS, name), false);
    }
  });

  test('explain: ramo a ramo (escopo / partição / condição) e negações', () => {
    const r = roleOf('r1', [grant('deal', ['read'], 'own'), grant('deal', ['read'], 'tenant', { conditions: [{ field: 'status', op: 'eq', value: 'won' }] }), grant('deal', ['read'], 'tenant')], {
      partitions: { pipelineId: ['p9'] },
      denies: [{ entity: 'deal', actions: ['read'], conditions: [{ field: 'value', op: 'gt', value: 1000 }] }],
    });
    const c = ctxOf(subjectOf(ME, ['r1']), { tenantRoles: [r] });
    const ex = explain(c, 'deal', 'read', deal({ ownerId: ME, pipelineId: 'p1', value: 10 }));
    assert.equal(ex.effect, 'deny');
    assert.equal(ex.reason, 'no_grant');
    assert.deepEqual(
      ex.branches.map((b) => [b.source, b.matched, b.failedAt]),
      [
        ['perfil:r1#0', false, 'particao'],
        ['perfil:r1#1', false, 'particao'],
        ['perfil:r1#2', false, 'particao'],
        ['compartilhamento', false, 'escopo'],
      ]
    );
    assert.deepEqual(ex.denies.map((d) => [d.source, d.applies]), [['perfil:r1:nega#0', false]]);
    const ok = explain(c, 'deal', 'read', deal({ ownerId: ME, pipelineId: 'p9', value: 10 }));
    assert.equal(ok.effect, 'allow');
    assert.equal(explain(c, 'deal', 'read', deal({ pipelineId: 'p9', value: 5000 })).reason, 'denied');
    assert.equal(explain(c, 'deal', 'read', deal({ tenantId: 'B' })).reason, 'tenant_mismatch');
    assert.equal(explain(c, 'inexistente', 'read', deal()).reason, 'unknown_action');
  });

  test('registro nulo/ausente nunca dá allow', () => {
    for (const row of [null, undefined, {}, [], 'x', 0, false]) assert.equal(eff(ctx, 'deal', 'read', row), 'deny', JSON.stringify(row));
  });

  test('tenantId do registro com tipo trocado/parecido nunca casa (comparação estrita)', () => {
    for (const t of ['a', 'A ', ' A', 'AA', 0, false, ['A'], { toString: () => 'A' }, 'A\u0000', 1]) assert.equal(eff(ctx, 'deal', 'read', deal({ tenantId: t })), 'deny', JSON.stringify(t));
  });
});
