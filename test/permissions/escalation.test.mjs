// (f) checkNoEscalation: "ninguém dá o que não tem".
// Propriedade: se ok === true, um usuário que tenha APENAS o perfil candidato nunca
// obtém um allow que o ator (com todos os seus perfis e restrições) não obtém.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { checkNoEscalation, decide, ENTITIES, SCOPES, SYSTEM_ROLES, effectiveRoles, cloneRole, fieldAccess, maskRow } from '../../shared/permissions/index.js';
import { ORG, subjectOf, ctxOf, roleOf, fuzz, genCase, genRule, genRow, genContext, mkCtx, Rng, ENTITY_NAMES } from './support.mjs';

const ME = 'me';
const grant = (entity, actions, scope, extra = {}) => ({ entity, actions, scope, ...extra });
const cand = (grants, extra = {}) => ({ id: 'cand', name: 'cand', tenantId: 'A', system: false, grants, denies: [], partitions: {}, fields: [], ...extra });
const actorWith = (roleIds, { tenantRoles = [], subject = {} } = {}) => ctxOf(subjectOf(ME, roleIds, subject), { tenantRoles });
const clone = (x) => JSON.parse(JSON.stringify(x));

describe('checkNoEscalation: cenários', () => {
  test('Admin pode criar/atribuir qualquer perfil, inclusive clones de todos os perfis de sistema', () => {
    const admin = actorWith(['role_admin']);
    for (const r of SYSTEM_ROLES) {
      const r1 = checkNoEscalation(admin, cloneRole(r, { id: 'x', name: 'x', tenantId: 'A' }));
      assert.deepEqual(r1, { ok: true, violations: [] }, r.id);
    }
  });

  test('Gestor NÃO pode criar um perfil Admin nem dar permissão que não tem (e a lista de violações é útil)', () => {
    const gestor = actorWith(['role_manager']);
    const r = checkNoEscalation(gestor, cloneRole(SYSTEM_ROLES[0], { id: 'x', name: 'x', tenantId: 'A' }));
    assert.equal(r.ok, false);
    assert.ok(r.violations.length > 50);
    assert.ok(r.violations.some((v) => v.entity === 'billing' && v.action === 'read'));
    assert.ok(r.violations.some((v) => v.entity === 'role' && v.action === 'assign'));
    for (const v of r.violations) assert.deepEqual(Object.keys(v).sort(), ['action', 'entity', 'scope']);
  });

  test('Gestor pode repassar o que tem com escopo igual ou menor; não com escopo maior', () => {
    const gestor = actorWith(['role_manager']);
    assert.equal(checkNoEscalation(gestor, cand([grant('deal', ['read', 'update'], 'team_tree')])).ok, true);
    assert.equal(checkNoEscalation(gestor, cand([grant('deal', ['read'], 'team')])).ok, true);
    assert.equal(checkNoEscalation(gestor, cand([grant('deal', ['read'], 'own')])).ok, true);
    assert.equal(checkNoEscalation(gestor, cand([grant('deal', ['read'], 'tenant')])).ok, false);
    assert.equal(checkNoEscalation(gestor, cand([grant('billing', ['read'], 'tenant')])).ok, false);
    assert.equal(checkNoEscalation(gestor, cand([grant('deal', ['approve'], 'team_tree')])).ok, false, 'o approve do Gestor é condicional (<=15%): não cobre um approve livre');
    assert.equal(checkNoEscalation(gestor, cand([grant('deal', ['approve'], 'team_tree', { conditions: [{ field: 'ctx.discountPct', op: 'lte', value: 5 }] })])).ok, false, 'conservador: grant condicional do ator nunca cobre');
  });

  test('grant condicional/aprovado do ator nunca cobre; candidato condicional é mais estreito e passa', () => {
    const r = roleOf('r', [grant('deal', ['read'], 'tenant', { conditions: [{ field: 'status', op: 'eq', value: 'open' }] }), grant('deal', ['update'], 'tenant', { approval: { when: [] } }), grant('contact', ['read'], 'tenant')]);
    const a = actorWith(['r'], { tenantRoles: [r] });
    assert.equal(checkNoEscalation(a, cand([grant('deal', ['read'], 'tenant')])).ok, false);
    assert.equal(checkNoEscalation(a, cand([grant('deal', ['update'], 'own')])).ok, false);
    assert.equal(checkNoEscalation(a, cand([grant('contact', ['read'], 'tenant', { conditions: [{ field: 'status', op: 'eq', value: 'x' }] })])).ok, true);
    assert.equal(checkNoEscalation(a, cand([grant('contact', ['read'], 'tenant', { approval: { when: [] } })])).ok, true);
  });

  test("candidato 'none' e entidades/ações desconhecidas não geram violação (o motor as ignora)", () => {
    const a = actorWith(['role_agent']);
    assert.equal(checkNoEscalation(a, cand([grant('billing', ['*'], 'none')])).ok, true);
    assert.equal(checkNoEscalation(a, cand([grant('naoExiste', ['read'], 'tenant')])).ok, true);
    assert.equal(checkNoEscalation(a, cand([grant('deal', ['naoExiste'], 'tenant')])).ok, true);
    assert.equal(checkNoEscalation(a, cand([])).ok, true);
    assert.equal(checkNoEscalation(a, { id: 'x' }).ok, true, 'sem grants não escala');
  });

  test("curingas: candidato com entidade '*'/ação '*' só passa se o ator tiver tudo", () => {
    const admin = actorWith(['role_admin']);
    const gestor = actorWith(['role_manager']);
    assert.equal(checkNoEscalation(admin, cand([grant('*', ['*'], 'tenant')])).ok, true);
    assert.equal(checkNoEscalation(gestor, cand([grant('*', ['*'], 'tenant')])).ok, false);
    assert.equal(checkNoEscalation(gestor, cand([grant('deal', ['*'], 'team_tree')])).ok, false, 'deal.approve não é incondicional no Gestor');
    assert.equal(checkNoEscalation(gestor, cand([grant('task', ['*'], 'team_tree')])).ok, true);
    assert.equal(checkNoEscalation(gestor, cand([grant('*', ['read'], 'tenant')])).ok, false);
  });

  test('partições: o candidato não pode ser mais largo que a do ator', () => {
    const r = roleOf('r', [grant('deal', ['read'], 'tenant')], { partitions: { pipelineId: ['p1', 'p2'] } });
    const a = actorWith(['r'], { tenantRoles: [r] });
    const g = [grant('deal', ['read'], 'tenant')];
    assert.equal(checkNoEscalation(a, cand(g, { partitions: { pipelineId: ['p1'] } })).ok, true);
    assert.equal(checkNoEscalation(a, cand(g, { partitions: { pipelineId: ['p1', 'p2'] } })).ok, true);
    assert.equal(checkNoEscalation(a, cand(g, { partitions: { pipelineId: ['p1', 'p3'] } })).ok, false);
    assert.equal(checkNoEscalation(a, cand(g, { partitions: { pipelineId: 'all' } })).ok, false);
    assert.equal(checkNoEscalation(a, cand(g, { partitions: {} })).ok, false, 'ausente = todos');
    assert.equal(checkNoEscalation(a, cand(g, { partitions: { pipelineId: [] } })).ok, true);
    // entidade sem partição não é afetada
    const r2 = roleOf('r2', [grant('contact', ['read'], 'tenant')], { partitions: { pipelineId: ['p1'] } });
    assert.equal(checkNoEscalation(actorWith(['r2'], { tenantRoles: [r2] }), cand([grant('contact', ['read'], 'tenant')])).ok, true);
  });

  test('CORREÇÃO: partição do ator corrompida (null/string) é "nada" no motor e não pode virar "tudo" aqui; candidato corrompido não lança', () => {
    for (const bad of [null, '', 'p1', 0, {}]) {
      const r = roleOf('r', [grant('deal', ['read'], 'tenant')], { partitions: { pipelineId: bad } });
      const a = actorWith(['r'], { tenantRoles: [r] });
      // o motor: ator sem acesso nenhum; o candidato 'all' seria uma ampliação
      assert.equal(decide(a, 'deal', 'read', { id: 'd', tenantId: 'A', ownerId: ME, pipelineId: 'p1' }).effect, 'deny');
      assert.equal(checkNoEscalation(a, cand([grant('deal', ['read'], 'tenant')], { partitions: { pipelineId: 'all' } })).ok, false, JSON.stringify(bad));
      assert.equal(checkNoEscalation(a, cand([grant('deal', ['read'], 'tenant')], { partitions: { pipelineId: 'p1' } })).ok, true, 'candidato string = nada: não amplia');
    }
  });

  test('o grant que cobre vem de um perfil COM a partição certa (partição é por perfil)', () => {
    const livre = roleOf('livre', [grant('deal', ['read'], 'own')]); // sem partição, mas só "own"
    const larga = roleOf('larga', [grant('deal', ['read'], 'tenant')], { partitions: { pipelineId: ['p1'] } });
    const a = actorWith(['livre', 'larga'], { tenantRoles: [livre, larga] });
    assert.equal(checkNoEscalation(a, cand([grant('deal', ['read'], 'tenant')])).ok, false, 'tenant em todos os pipelines ninguém tem');
    assert.equal(checkNoEscalation(a, cand([grant('deal', ['read'], 'tenant')], { partitions: { pipelineId: ['p1'] } })).ok, true);
    assert.equal(checkNoEscalation(a, cand([grant('deal', ['read'], 'own')])).ok, true);
  });

  test('grants individuais (overrides) do ator contam como posse', () => {
    const a = actorWith([], { subject: { overrides: { grants: [grant('report', ['read'], 'tenant')] } } });
    assert.equal(checkNoEscalation(a, cand([grant('report', ['read'], 'tenant')])).ok, true);
    assert.equal(checkNoEscalation(a, cand([grant('report', ['export'], 'tenant')])).ok, false);
  });

  test('perfil de OUTRO tenant do ator não conta como posse', () => {
    const r = roleOf('rx', [grant('*', ['*'], 'tenant')], { tenantId: 'B' });
    const a = { subject: subjectOf(ME, ['rx']), roles: new Map([['rx', r]]), org: ORG, policy: {} };
    assert.equal(checkNoEscalation(a, cand([grant('deal', ['read'], 'own')])).ok, false);
  });

  test('CORREÇÃO: ator INATIVO (suspenso/convidado/sem status) não concede nada', () => {
    for (const status of ['suspended', 'invited', undefined, null, 'ACTIVE']) {
      const a = actorWith(['role_admin'], { subject: { status } });
      const r = checkNoEscalation(a, cand([grant('deal', ['read'], 'own')]));
      assert.equal(r.ok, false, String(status));
      assert.equal(r.violations[0].reason, 'subject_inactive');
    }
    assert.equal(checkNoEscalation(undefined, cand([])).ok, false);
    assert.equal(checkNoEscalation({}, cand([])).ok, false);
  });

  test('CORREÇÃO: negação do ator "lava" a permissão se ele puder dar o grant — agora conta', () => {
    // o ator tem export num perfil e uma NEGAÇÃO de export em outro: na prática NÃO exporta
    const dá = roleOf('da', [grant('contact', ['export', 'read'], 'tenant')]);
    const tira = roleOf('tira', [], { denies: [{ entity: 'contact', actions: ['export'] }] });
    const a = actorWith(['da', 'tira'], { tenantRoles: [dá, tira] });
    assert.equal(decide(a, 'contact', 'export', { id: 'c', tenantId: 'A' }).effect, 'deny');
    const r = checkNoEscalation(a, cand([grant('contact', ['export'], 'tenant')]));
    assert.equal(r.ok, false);
    assert.deepEqual(r.violations, [{ entity: 'contact', action: 'export', scope: 'tenant' }]);
    // o que a negação não toca continua repassável
    assert.equal(checkNoEscalation(a, cand([grant('contact', ['read'], 'tenant')])).ok, true);
    // se o candidato REPETE a mesma negação, o usuário dele também não exporta: sem escalonamento
    assert.equal(checkNoEscalation(a, cand([grant('contact', ['export'], 'tenant')], { denies: [{ entity: 'contact', actions: ['export'] }] })).ok, true);
    // negação parecida mas diferente (condições diferentes) não vale como espelho
    assert.equal(checkNoEscalation(a, cand([grant('contact', ['export'], 'tenant')], { denies: [{ entity: 'contact', actions: ['export'], conditions: [{ field: 'status', op: 'eq', value: 'x' }] }] })).ok, false);
    // negação do candidato em OUTRA ação não ajuda
    assert.equal(checkNoEscalation(a, cand([grant('contact', ['export'], 'tenant')], { denies: [{ entity: 'contact', actions: ['delete'] }] })).ok, false);
  });

  test('CORREÇÃO: Admin que também é Somente leitura não pode repassar export (deny export * do Viewer)', () => {
    const a = actorWith(['role_admin', 'role_viewer']);
    const r = checkNoEscalation(a, cand([grant('deal', ['export', 'read'], 'tenant')]));
    assert.equal(r.ok, false);
    assert.deepEqual(r.violations, [{ entity: 'deal', action: 'export', scope: 'tenant' }]);
    assert.equal(checkNoEscalation(a, cand([grant('deal', ['read', 'update'], 'tenant')])).ok, true);
  });

  test('CORREÇÃO: negação do ator MALFORMADA bloqueia o repasse (motor a trata como "nega tudo")', () => {
    const tira = roleOf('tira', [], { denies: [{ entity: 'contact' }] });
    const a = actorWith(['role_admin', 'tira'], { tenantRoles: [tira] });
    assert.equal(decide(a, 'contact', 'read', { id: 'c', tenantId: 'A' }).effect, 'deny');
    assert.equal(checkNoEscalation(a, cand([grant('deal', ['read'], 'own')])).ok, false);
  });

  test('SDR (deny de mover para Ganho) não consegue repassar "move" sem a mesma negação', () => {
    const sdr = actorWith(['role_sdr']);
    assert.equal(checkNoEscalation(sdr, cand([grant('deal', ['move'], 'own')])).ok, false);
    const mesmaNegacao = { entity: 'deal', actions: ['move'], conditions: [{ field: 'ctx.toStageKind', op: 'in', value: ['won', 'lost'] }] };
    assert.equal(checkNoEscalation(sdr, cand([grant('deal', ['move'], 'own')], { denies: [mesmaNegacao] })).ok, true);
  });

  test('negação e restrição de campo do CANDIDATO nunca são escalonamento', () => {
    const a = actorWith(['role_manager']);
    assert.equal(checkNoEscalation(a, cand([grant('deal', ['read'], 'team')], { denies: [{ entity: '*', actions: ['*'] }], fields: [{ entity: 'deal', field: 'value', access: 'hidden' }] })).ok, true);
  });

  test('candidato malformado é recusado (não lança)', () => {
    const a = actorWith(['role_admin']);
    for (const c of [null, undefined, 5, 'x', [], { grants: 'x' }, { grants: {} }, { grants: [null] }, { grants: [{ entity: 'deal', actions: 'read', scope: 'tenant' }] }, { grants: [{ entity: 'deal', actions: ['read'] }] }]) {
      const r = checkNoEscalation(a, c);
      assert.equal(r.ok, false, JSON.stringify(c));
      assert.ok(r.violations.length > 0);
    }
  });

  // Hoje restrições de CAMPO do ator não são propagadas: quem tem contact.phone oculto pode criar um
  // perfil que lê contatos com telefone. É questão de DESIGN (ver relatório) — registrado como todo.
  test('restrição de campo do ator deveria valer para o perfil que ele cria', { todo: 'design: propagar restrições de campo do ator para o candidato' }, () => {
    const a = actorWith(['role_admin', 'role_finance']);
    assert.deepEqual(fieldAccess(a, 'contact'), { phone: 'hidden' });
    const r = checkNoEscalation(a, cand([grant('contact', ['read'], 'tenant')]));
    const candUser = ctxOf(subjectOf(ME, ['cand']), { tenantRoles: [cand([grant('contact', ['read'], 'tenant')])] });
    const vazou = 'phone' in maskRow(candUser, 'contact', { phone: '1' });
    // desejável: ou recusa (ok=false) ou o candidato herda o campo oculto
    assert.ok(!r.ok || !vazou, 'o candidato vê o telefone que o ator não vê');
  });
});

// ---------------------------------------------------------------------------
// Fuzz: procura contraexemplos de "ok => sem ganho de acesso"
// ---------------------------------------------------------------------------
const rank = (s) => SCOPES.indexOf(s);

function genCandidate(rng, c) {
  const actorRoles = effectiveRoles(mkCtx(c));
  const pool = [...actorRoles.flatMap((r) => (Array.isArray(r.grants) ? r.grants : [])), ...(c.subject.overrides?.grants || [])].filter((g) => g && typeof g === 'object' && typeof g.entity === 'string' && Array.isArray(g.actions));
  const grants = [];
  const n = 1 + rng.int(3);
  for (let i = 0; i < n; i++) {
    if (pool.length && rng.bool(0.8)) {
      const g = clone(rng.pick(pool));
      const valid = g.entity === '*' ? ['tenant'] : ENTITIES[g.entity]?.scopes || [g.scope];
      if (rng.bool(0.5)) {
        const lower = valid.filter((s) => rank(s) < rank(g.scope));
        if (lower.length) g.scope = rng.pick(lower);
      }
      if (rng.bool(0.1)) g.scope = rng.pick(valid); // pode ampliar: tem que ser recusado
      if (rng.bool(0.3) && !g.actions.includes('*')) g.actions = rng.some(g.actions, 1, g.actions.length);
      if (rng.bool(0.15)) g.actions = ['*'];
      if (rng.bool(0.2)) g.entity = rng.bool(0.5) ? '*' : g.entity;
      if (rng.bool(0.2)) g.conditions = [...(g.conditions || []), { field: 'status', op: 'eq', value: 'open' }];
      if (rng.bool(0.1)) g.approval = { when: [] };
      grants.push(g);
    } else grants.push(genRule(rng, 'grants'));
  }
  const denies = [];
  if (rng.bool(0.3)) {
    const actorDenies = actorRoles.flatMap((r) => (Array.isArray(r.denies) ? r.denies : []));
    if (actorDenies.length && rng.bool(0.7)) denies.push(clone(rng.pick(actorDenies)));
    else denies.push(genRule(rng, 'denies'));
  }
  const partitions = {};
  const src = actorRoles.find((r) => r.partitions && Object.keys(r.partitions).length);
  if (src && rng.bool(0.7)) Object.assign(partitions, clone(src.partitions));
  if (rng.bool(0.15)) partitions.pipelineId = rng.some(['p1', 'p2', 'p3'], 0, 2);
  if (rng.bool(0.1)) partitions.instanceId = 'all';
  return { id: 'cand', name: 'cand', tenantId: 'A', system: false, grants, denies, partitions, fields: [] };
}

describe('checkNoEscalation: propriedade (fuzz)', () => {
  test('ok===true => usuário só-candidato nunca obtém allow que o ator não obtém', () => {
    const stats = { ok: 0, refused: 0, checks: 0, candAllows: 0 };
    fuzz('escalonamento', {
      seed: 6161,
      n: 9000,
      shrinkable: true,
      gen: (rng) => {
        const c = genCase(rng, { subjectTenant: 'A', sysP: 0.5, approvalP: 0.1, denyP: 0.3 });
        c.subject.status = 'active';
        c.policy = { requireMfaForSensitive: false };
        c.candidate = genCandidate(rng, c);
        // linhas e (entidade, ação) a testar, escolhidas aqui para ficarem no caso mínimo
        const ents = [...new Set([...c.candidate.grants.map((g) => g.entity).filter((e) => e !== '*' && ENTITIES[e]), ...Array.from({ length: 3 }, () => rng.pick(ENTITY_NAMES))])];
        c.probes = [];
        for (const e of ents) {
          for (const a of ENTITIES[e].actions) {
            if (rng.bool(0.6)) continue;
            for (let k = 0; k < 3; k++) c.probes.push({ entity: e, action: a, row: genRow(rng, e, { tenantId: 'A' }), context: genContext(rng, a) });
          }
        }
        return c;
      },
      check: (c) => {
        const actor = mkCtx(c);
        const res = checkNoEscalation(actor, c.candidate);
        if (!res.ok) {
          stats.refused++;
          return;
        }
        stats.ok++;
        const candUser = mkCtx({ ...c, subject: { ...c.subject, roleIds: ['cand'], overrides: undefined }, roles: [c.candidate] });
        for (const p of c.probes) {
          const dc = decide(candUser, p.entity, p.action, p.row, p.context);
          stats.checks++;
          if (dc.effect !== 'allow') continue;
          // acesso que vem SÓ de compartilhamento por registro não depende de perfil nenhum (e as negações
          // pessoais do ator não se transferem para outra pessoa): não é escalonamento por perfil.
          if (dc.matched.every((m) => m === 'compartilhamento')) continue;
          stats.candAllows++;
          const da = decide(actor, p.entity, p.action, p.row, p.context);
          assert.equal(da.effect, 'allow', `ESCALONAMENTO: ${p.entity}.${p.action} ator=${da.effect}/${da.reason} candidato=allow; matched=${dc.matched}`);
        }
      },
    });
    // o gerador precisa produzir aprovações E recusas, e o candidato precisa de fato obter allows
    assert.ok(stats.ok > 400, `poucos candidatos aprovados (${stats.ok})`);
    assert.ok(stats.refused > 400, `poucos candidatos recusados (${stats.refused})`);
    assert.ok(stats.candAllows > 1500, `candidato quase nunca obtém allow (${stats.candAllows}): o teste não prova nada`);
  });

  test('recusa é conservadora mas não absurda: o Admin sozinho nunca é recusado por candidato "normal"', () => {
    fuzz('admin-sempre-ok', {
      seed: 6262,
      n: 1500,
      shrinkable: false,
      gen: (rng) => {
        const rolePool = {
          subject: subjectOf(ME, ['role_admin']),
          candidate: { id: 'cand', name: 'cand', tenantId: 'A', system: false, grants: Array.from({ length: 1 + rng.int(4) }, () => genRule(rng, 'grants')), denies: [], partitions: rng.bool(0.3) ? { pipelineId: rng.some(['p1', 'p2'], 0, 2) } : {}, fields: [] },
        };
        return rolePool;
      },
      check: ({ subject, candidate }) => {
        const r = checkNoEscalation({ subject, roles: new Map(SYSTEM_ROLES.map((x) => [x.id, x])), org: ORG, policy: {} }, candidate);
        assert.equal(r.ok, true, JSON.stringify(r.violations.slice(0, 3)));
      },
    });
  });

  test('a recusa é monotônica no candidato: remover grants de um candidato aprovado mantém a aprovação', () => {
    fuzz('escalonamento-monotonia', {
      seed: 6363,
      n: 3000,
      gen: (rng) => {
        const c = genCase(rng, { subjectTenant: 'A', sysP: 0.5, denyP: 0.3 });
        c.subject.status = 'active';
        c.candidate = genCandidate(rng, c);
        c.drop = rng.int(Math.max(1, c.candidate.grants.length));
        return c;
      },
      check: (c) => {
        const actor = mkCtx(c);
        if (!checkNoEscalation(actor, c.candidate).ok) return;
        const smaller = clone(c.candidate);
        smaller.grants.splice(c.drop, 1);
        assert.equal(checkNoEscalation(actor, smaller).ok, true);
      },
    });
  });
});

test('Rng sanity', () => assert.ok(new Rng(1).int(5) >= 0));
