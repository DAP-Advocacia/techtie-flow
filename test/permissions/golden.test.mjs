// MATRIZ DOURADA dos 6 perfis de sistema.
// As tabelas abaixo foram escritas À MÃO a partir do que cada perfil DEVE poder
// (não são geradas pelo motor). Se este arquivo falhar depois de uma mudança em
// roles.js, alguém alterou o poder de um perfil de sistema: confirme que foi de
// propósito, atualize a tabela E avise quem usa esses perfis (são os modelos de todos os tenants).
//
// Colunas de cada linha (na ordem):  A=Admin  G=Gestor  T=Atendente  S=SDR  F=Financeiro  V=Somente leitura
//   a = allow direto   p = precisa de aprovação (approval)   d = negado
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { decide, effectiveMatrix, fieldAccess, maskRow, SYSTEM_ROLES, ENTITIES } from '../../shared/permissions/index.js';
import { ctxOf, subjectOf } from './support.mjs';

const ROLE_IDS = ['role_admin', 'role_manager', 'role_agent', 'role_sdr', 'role_finance', 'role_viewer'];
const COLS = 'AGTSFV';
const EFFECT = { a: 'allow', p: 'approval', d: 'deny' };
const ME = 'me';

// organograma: me está em T1; T1a é subequipe; T1a1 é sub-subequipe; T2 é outra árvore
const ORG = { teams: [{ id: 'T1' }, { id: 'T1a', parentId: 'T1' }, { id: 'T1a1', parentId: 'T1a' }, { id: 'T2' }] };
const ctxs = Object.fromEntries(ROLE_IDS.map((id) => [id, ctxOf(subjectOf(ME, [id]), { org: ORG })]));

// registros ----------------------------------------------------------------
const base = (o) => ({ id: 'r1', tenantId: 'A', ...o });
const ROWS = {
  own: base({ ownerId: ME, teamId: 'T1' }),
  team: base({ ownerId: 'other', teamId: 'T1' }),
  sub: base({ ownerId: 'other', teamId: 'T1a' }),
  subsub: base({ ownerId: 'other', teamId: 'T1a1' }),
  other: base({ ownerId: 'other', teamId: 'T2' }),
  noTeam: base({ ownerId: 'other', teamId: null }),
  foreign: base({ tenantId: 'B', ownerId: ME, teamId: 'T1' }),
  // conversas: o "dono" é o assigneeId
  cOwn: base({ assigneeId: ME, teamId: 'T1' }),
  cQueue: base({ assigneeId: null, teamId: null }),
  cQueueT2: base({ assigneeId: null, teamId: 'T2' }),
  cTeam: base({ assigneeId: 'other', teamId: 'T1' }),
  cSub: base({ assigneeId: 'other', teamId: 'T1a' }),
  cOther: base({ assigneeId: 'other', teamId: 'T2' }),
  cForeign: base({ tenantId: 'B', assigneeId: null, teamId: null }),
  cfg: base({}), // entidades de configuração (produto, usuário, faturamento…)
};

// [descrição, entidade, ação, registro, contexto, 'AGTSFV']
const GOLDEN = [
  // ---- negócios: leitura ----
  ['deal próprio', 'deal', 'read', 'own', undefined, 'aaaaaa'],
  ['deal da equipe', 'deal', 'read', 'team', undefined, 'aaddaa'],
  ['deal da subequipe', 'deal', 'read', 'sub', undefined, 'aaddaa'],
  ['deal da sub-subequipe', 'deal', 'read', 'subsub', undefined, 'aaddaa'],
  ['deal de outra equipe', 'deal', 'read', 'other', undefined, 'adddaa'],
  ['deal sem equipe de outro dono', 'deal', 'read', 'noTeam', undefined, 'adddaa'],
  ['deal de OUTRO TENANT', 'deal', 'read', 'foreign', undefined, 'dddddd'],
  // ---- negócios: escrita ----
  ['atualizar deal próprio', 'deal', 'update', 'own', undefined, 'aaaadd'],
  ['atualizar deal da equipe', 'deal', 'update', 'team', undefined, 'aadddd'],
  ['atualizar deal da subequipe', 'deal', 'update', 'sub', undefined, 'aadddd'],
  ['atualizar deal de outra equipe', 'deal', 'update', 'other', undefined, 'addddd'],
  ['atualizar deal de outro tenant', 'deal', 'update', 'foreign', undefined, 'dddddd'],
  ['criar deal próprio', 'deal', 'create', 'own', undefined, 'aaaadd'],
  ['criar deal da equipe', 'deal', 'create', 'team', undefined, 'aadddd'],
  ['apagar deal próprio', 'deal', 'delete', 'own', undefined, 'aadddd'],
  ['apagar deal da subequipe', 'deal', 'delete', 'sub', undefined, 'aadddd'],
  ['apagar deal de outra equipe', 'deal', 'delete', 'other', undefined, 'addddd'],
  ['exportar deal próprio', 'deal', 'export', 'own', undefined, 'aaddad'],
  ['exportar deal da subequipe', 'deal', 'export', 'sub', undefined, 'aaddad'],
  ['exportar deal de outra equipe', 'deal', 'export', 'other', undefined, 'adddad'],
  ['importar deal', 'deal', 'import', 'own', undefined, 'aadddd'],
  ['transferir deal próprio', 'deal', 'transfer', 'own', undefined, 'aadddd'],
  ['transferir deal da subequipe', 'deal', 'transfer', 'sub', undefined, 'aadddd'],
  ['transferir deal de outra equipe', 'deal', 'transfer', 'other', undefined, 'addddd'],
  // ---- mover negócio (SDR não leva a Ganho/Perdido) ----
  ['mover deal próprio para etapa aberta', 'deal', 'move', 'own', { toStageKind: 'open' }, 'aaaadd'],
  ['SDR move para GANHO', 'deal', 'move', 'own', { toStageKind: 'won' }, 'aaaddd'],
  ['SDR move para PERDIDO', 'deal', 'move', 'own', { toStageKind: 'lost' }, 'aaaddd'],
  ['mover sem contexto (SDR nega: desconhecido)', 'deal', 'move', 'own', undefined, 'aaaddd'],
  ['mover com toStageKind indefinido', 'deal', 'move', 'own', { toStageKind: undefined }, 'aaaddd'],
  ['mover com outro tipo de contexto', 'deal', 'move', 'own', { fromStageKind: 'open' }, 'aaaddd'],
  ['mover deal da equipe (aberta)', 'deal', 'move', 'team', { toStageKind: 'open' }, 'aadddd'],
  ['mover deal da subequipe (aberta)', 'deal', 'move', 'sub', { toStageKind: 'open' }, 'aadddd'],
  ['mover deal de outra equipe', 'deal', 'move', 'other', { toStageKind: 'open' }, 'addddd'],
  ['mover deal de outro tenant', 'deal', 'move', 'foreign', { toStageKind: 'open' }, 'dddddd'],
  // ---- aprovar desconto em deal (Gestor até 15%) ----
  ['Gestor aprova deal com 10%', 'deal', 'approve', 'own', { requesterId: 'req', discountPct: 10 }, 'aadddd'],
  ['Gestor aprova deal com 15% (limite)', 'deal', 'approve', 'own', { requesterId: 'req', discountPct: 15 }, 'aadddd'],
  ['Gestor NÃO aprova deal com 15,5%', 'deal', 'approve', 'own', { requesterId: 'req', discountPct: 15.5 }, 'addddd'],
  ['Gestor NÃO aprova deal com 20%', 'deal', 'approve', 'own', { requesterId: 'req', discountPct: 20 }, 'addddd'],
  ['aprovar deal sem contexto', 'deal', 'approve', 'own', undefined, 'addddd'],
  ['Gestor aprova deal da subequipe 10%', 'deal', 'approve', 'sub', { requesterId: 'req', discountPct: 10 }, 'aadddd'],
  ['Gestor não aprova deal de outra equipe', 'deal', 'approve', 'other', { requesterId: 'req', discountPct: 10 }, 'addddd'],
  // ---- propostas ----
  ['ler proposta própria', 'proposal', 'read', 'own', undefined, 'aaadaa'],
  ['ler proposta da equipe', 'proposal', 'read', 'team', undefined, 'aaddaa'],
  ['ler proposta de outra equipe', 'proposal', 'read', 'other', undefined, 'adddaa'],
  ['ler proposta de outro tenant', 'proposal', 'read', 'foreign', undefined, 'dddddd'],
  ['criar proposta própria (sem contexto de desconto => exige aprovação do Atendente)', 'proposal', 'create', 'own', undefined, 'aapddd'],
  ['enviar proposta própria (sem contexto de desconto => exige aprovação do Atendente)', 'proposal', 'send', 'own', undefined, 'aapddd'],
  ['enviar proposta da equipe', 'proposal', 'send', 'team', undefined, 'aadddd'],
  ['apagar proposta própria', 'proposal', 'delete', 'own', undefined, 'aadddd'],
  ['Atendente edita proposta com desconto 3%', 'proposal', 'update', 'own', { discountPct: 3 }, 'aaaddd'],
  ['Atendente edita proposta com desconto 5% (limite)', 'proposal', 'update', 'own', { discountPct: 5 }, 'aaaddd'],
  ['Atendente edita proposta com desconto 5,01%', 'proposal', 'update', 'own', { discountPct: 5.01 }, 'aapddd'],
  ['Atendente edita proposta com desconto 8%', 'proposal', 'update', 'own', { discountPct: 8 }, 'aapddd'],
  ['editar proposta sem contexto (exige aprovação)', 'proposal', 'update', 'own', undefined, 'aapddd'],
  ['Atendente edita proposta da equipe 3%', 'proposal', 'update', 'team', { discountPct: 3 }, 'aadddd'],
  ['Atendente edita proposta de outra equipe', 'proposal', 'update', 'other', { discountPct: 3 }, 'addddd'],
  ['Gestor aprova proposta com 10%', 'proposal', 'approve', 'own', { requesterId: 'req', discountPct: 10 }, 'aadddd'],
  ['Gestor aprova proposta com 15%', 'proposal', 'approve', 'own', { requesterId: 'req', discountPct: 15 }, 'aadddd'],
  ['Gestor NÃO aprova proposta com 20% (só o Admin)', 'proposal', 'approve', 'own', { requesterId: 'req', discountPct: 20 }, 'addddd'],
  ['aprovar proposta sem contexto (só o Admin: sem requesterId a negação de auto-aprovação vale)', 'proposal', 'approve', 'own', undefined, 'addddd'],
  ['Financeiro NÃO aprova desconto (alçada comercial); Admin sim', 'proposal', 'approve', 'other', { discountPct: 20 }, 'addddd'],
  ['aprovar proposta de outro tenant', 'proposal', 'approve', 'foreign', { discountPct: 1 }, 'dddddd'],
  // ---- contatos (Financeiro e Viewer só leem; telefone oculto está na tabela de campos) ----
  ['ler contato próprio', 'contact', 'read', 'own', undefined, 'aaaaaa'],
  ['ler contato da equipe', 'contact', 'read', 'team', undefined, 'aaaaaa'],
  ['ler contato da subequipe (Atendente/SDR: "team" não inclui subequipe)', 'contact', 'read', 'sub', undefined, 'aaddaa'],
  ['ler contato de outra equipe', 'contact', 'read', 'other', undefined, 'adddaa'],
  ['ler contato de outro tenant', 'contact', 'read', 'foreign', undefined, 'dddddd'],
  ['criar contato da equipe', 'contact', 'create', 'team', undefined, 'aaaadd'],
  ['atualizar contato da equipe', 'contact', 'update', 'team', undefined, 'aaaadd'],
  ['atualizar contato da subequipe', 'contact', 'update', 'sub', undefined, 'aadddd'],
  ['atualizar contato de outra equipe', 'contact', 'update', 'other', undefined, 'addddd'],
  ['apagar contato próprio', 'contact', 'delete', 'own', undefined, 'aadddd'],
  ['apagar contato de outra equipe', 'contact', 'delete', 'other', undefined, 'addddd'],
  ['exportar contato da equipe', 'contact', 'export', 'team', undefined, 'aadddd'],
  ['importar contato', 'contact', 'import', 'team', undefined, 'aadddd'],
  ['transferir contato da subequipe', 'contact', 'transfer', 'sub', undefined, 'aadddd'],
  ['ler empresa da equipe', 'company', 'read', 'team', undefined, 'aaaaaa'],
  ['atualizar empresa da equipe', 'company', 'update', 'team', undefined, 'aaaadd'],
  ['apagar empresa da equipe', 'company', 'delete', 'team', undefined, 'aadddd'],
  ['exportar empresa da equipe', 'company', 'export', 'team', undefined, 'aadddd'],
  // ---- conversas ----
  ['ler conversa atribuída a mim', 'conversation', 'read', 'cOwn', undefined, 'aaaada'],
  ['ler conversa NA FILA (sem responsável)', 'conversation', 'read', 'cQueue', undefined, 'aaaada'],
  ['ler conversa na fila de outra equipe', 'conversation', 'read', 'cQueueT2', undefined, 'aaaada'],
  ['ler conversa de colega da equipe', 'conversation', 'read', 'cTeam', undefined, 'aaddda'],
  ['ler conversa de colega da subequipe', 'conversation', 'read', 'cSub', undefined, 'aaddda'],
  ['ler conversa de outra equipe', 'conversation', 'read', 'cOther', undefined, 'adddda'],
  ['ler conversa de outro tenant (mesmo na fila)', 'conversation', 'read', 'cForeign', undefined, 'dddddd'],
  ['responder conversa minha', 'conversation', 'send_message', 'cOwn', undefined, 'aaaadd'],
  ['responder conversa da fila', 'conversation', 'send_message', 'cQueue', undefined, 'aaaadd'],
  ['responder conversa de colega da equipe', 'conversation', 'send_message', 'cTeam', undefined, 'aadddd'],
  ['responder conversa de outra equipe', 'conversation', 'send_message', 'cOther', undefined, 'addddd'],
  ['nota em conversa da fila', 'conversation', 'note', 'cQueue', undefined, 'aaaadd'],
  ['transferir conversa da fila', 'conversation', 'transfer', 'cQueue', undefined, 'aaaadd'],
  ['resolver conversa da fila', 'conversation', 'resolve', 'cQueue', undefined, 'aaaadd'],
  ['resolver conversa de outra equipe', 'conversation', 'resolve', 'cOther', undefined, 'addddd'],
  ['supervisionar conversa de colega', 'conversation', 'supervise', 'cTeam', undefined, 'aadddd'],
  ['supervisionar conversa da subequipe', 'conversation', 'supervise', 'cSub', undefined, 'aadddd'],
  ['supervisionar conversa de outra equipe', 'conversation', 'supervise', 'cOther', undefined, 'addddd'],
  ['supervisionar conversa da fila (sem equipe)', 'conversation', 'supervise', 'cQueue', undefined, 'addddd'],
  ['exportar conversa da equipe', 'conversation', 'export', 'cTeam', undefined, 'aadddd'],
  ['apagar conversa própria', 'conversation', 'delete', 'cOwn', undefined, 'addddd'],
  // ---- tarefas e chamadas ----
  ['ler tarefa própria', 'task', 'read', 'own', undefined, 'aaaada'],
  ['ler tarefa da equipe', 'task', 'read', 'team', undefined, 'aaddda'],
  ['criar tarefa própria', 'task', 'create', 'own', undefined, 'aaaadd'],
  ['atualizar tarefa da equipe', 'task', 'update', 'team', undefined, 'aadddd'],
  ['apagar tarefa própria', 'task', 'delete', 'own', undefined, 'aadddd'],
  ['ler chamada própria (Viewer não vê chamadas)', 'call', 'read', 'own', undefined, 'aaaddd'],
  ['ler chamada da equipe', 'call', 'read', 'team', undefined, 'aadddd'],
  ['criar chamada própria', 'call', 'create', 'own', undefined, 'aaaddd'],
  ['ouvir gravação de chamada própria', 'call', 'listen', 'own', undefined, 'aadddd'],
  ['ouvir gravação de chamada de outra equipe', 'call', 'listen', 'other', undefined, 'addddd'],
  ['exportar chamadas', 'call', 'export', 'own', undefined, 'aadddd'],
  // ---- somente leitura / exportação ----
  ['Viewer lê relatório', 'report', 'read', 'cfg', undefined, 'aaddaa'],
  ['relatório: criar', 'report', 'create', 'cfg', undefined, 'aadddd'],
  ['relatório: exportar (Viewer nunca exporta)', 'report', 'export', 'cfg', undefined, 'aaddad'],
  ['audit_log: ler', 'audit_log', 'read', 'cfg', undefined, 'addddd'],
  ['audit_log: exportar', 'audit_log', 'export', 'cfg', undefined, 'addddd'],
  // ---- configuração do tenant ----
  ['listar usuários', 'user', 'read', 'cfg', undefined, 'aadddd'],
  ['criar usuário', 'user', 'create', 'cfg', undefined, 'addddd'],
  ['atualizar usuário', 'user', 'update', 'cfg', undefined, 'addddd'],
  ['apagar usuário', 'user', 'delete', 'cfg', undefined, 'addddd'],
  ['ver perfis', 'role', 'read', 'cfg', undefined, 'aadddd'],
  ['criar perfil', 'role', 'create', 'cfg', undefined, 'addddd'],
  ['atribuir perfil', 'role', 'assign', 'cfg', undefined, 'addddd'],
  ['ler faturamento', 'billing', 'read', 'cfg', undefined, 'adddad'],
  ['alterar faturamento', 'billing', 'update', 'cfg', undefined, 'adddad'],
  ['ler produto', 'product', 'read', 'cfg', undefined, 'aaaaad'],
  ['criar produto', 'product', 'create', 'cfg', undefined, 'aaddad'],
  ['atualizar produto', 'product', 'update', 'cfg', undefined, 'aaddad'],
  ['apagar produto', 'product', 'delete', 'cfg', undefined, 'addddd'],
  ['ler pipeline', 'pipeline', 'read', 'cfg', undefined, 'aaaada'],
  ['atualizar pipeline', 'pipeline', 'update', 'cfg', undefined, 'aadddd'],
  ['criar pipeline', 'pipeline', 'create', 'cfg', undefined, 'addddd'],
  ['apagar pipeline', 'pipeline', 'delete', 'cfg', undefined, 'addddd'],
  ['ler automação', 'automation', 'read', 'cfg', undefined, 'aadddd'],
  ['atualizar automação', 'automation', 'update', 'cfg', undefined, 'aadddd'],
  ['publicar automação', 'automation', 'publish', 'cfg', undefined, 'addddd'],
  ['ler instância de WhatsApp', 'instance', 'read', 'cfg', undefined, 'aaaadd'],
  ['conectar instância', 'instance', 'connect', 'cfg', undefined, 'addddd'],
  ['criar instância', 'instance', 'create', 'cfg', undefined, 'addddd'],
  ['ler agente de IA', 'ai_agent', 'read', 'cfg', undefined, 'aadddd'],
  ['atualizar agente de IA', 'ai_agent', 'update', 'cfg', undefined, 'addddd'],
  ['ler configurações do tenant', 'tenant_settings', 'read', 'cfg', undefined, 'addddd'],
  ['atualizar configurações do tenant', 'tenant_settings', 'update', 'cfg', undefined, 'addddd'],
  ['ler chave de API', 'api_key', 'read', 'cfg', undefined, 'addddd'],
  ['criar chave de API', 'api_key', 'create', 'cfg', undefined, 'addddd'],
  ['configuração de OUTRO tenant', 'billing', 'read', 'cForeign', undefined, 'dddddd'],
];

describe('matriz dourada: decisões por perfil (tabela escrita à mão)', () => {
  test('a tabela é consistente (6 colunas, só a/p/d, sem linhas repetidas)', () => {
    const seen = new Set();
    for (const [desc, e, a, r, c, exp] of GOLDEN) {
      assert.match(exp, /^[apd]{6}$/, desc);
      assert.ok(ENTITIES[e].actions.includes(a), `${e}.${a} não existe no catálogo (${desc})`);
      assert.ok(r in ROWS, desc);
      const key = JSON.stringify([e, a, r, c]);
      assert.ok(!seen.has(key), `linha repetida: ${desc}`);
      seen.add(key);
    }
    assert.ok(GOLDEN.length >= 140, `tabela encolheu (${GOLDEN.length})`);
  });

  for (const [desc, entity, action, rowKey, context, expected] of GOLDEN) {
    test(`${desc}  [${entity}.${action} · ${rowKey}${context ? ' · ' + JSON.stringify(context) : ''}]  =>  ${expected}`, () => {
      const got = ROLE_IDS.map((id) => {
        const d = decide(ctxs[id], entity, action, ROWS[rowKey], context);
        return d.effect === 'allow' ? 'a' : d.effect === 'approval' ? 'p' : 'd';
      }).join('');
      const diff = [...expected].map((c, i) => (c === got[i] ? '' : `${COLS[i]}(${ROLE_IDS[i]}): esperado ${EFFECT[c]}, obtido ${EFFECT[got[i]]}`)).filter(Boolean);
      assert.equal(got, expected, `${desc}: ${diff.join('; ')}`);
    });
  }

  test('MFA obrigatório: nenhum perfil faz ação sensível sem mfa quando a política exige', () => {
    for (const id of ROLE_IDS) {
      const c = ctxOf(subjectOf(ME, [id], { mfa: false }), { org: ORG, policy: { requireMfaForSensitive: true } });
      for (const [desc, entity, action, rowKey, context] of GOLDEN) {
        if (!['delete', 'export', 'import', 'supervise', 'listen', 'assign', 'manage'].includes(action)) continue;
        const d = decide(c, entity, action, ROWS[rowKey], context);
        assert.equal(d.effect, 'deny', `${id} ${desc}`);
      }
    }
  });
});

describe('matriz dourada: campos', () => {
  test('só o Financeiro tem restrição de campo (contact.phone oculto); nenhum outro perfil restringe nada', () => {
    for (const id of ROLE_IDS) {
      for (const entity of Object.keys(ENTITIES)) {
        const expected = id === 'role_finance' && entity === 'contact' ? { phone: 'hidden' } : {};
        assert.deepEqual(fieldAccess(ctxs[id], entity), expected, `${id} ${entity}`);
      }
    }
  });

  test('Financeiro lê contato SEM telefone, mas com e-mail e documento', () => {
    const contato = { id: 'c1', tenantId: 'A', name: 'Maria', phone: '+5511999990000', email: 'm@x.com', document: '123' };
    const visto = maskRow(ctxs.role_finance, 'contact', contato);
    assert.equal(decide(ctxs.role_finance, 'contact', 'read', contato).effect, 'allow');
    assert.deepEqual(visto, { id: 'c1', tenantId: 'A', name: 'Maria', email: 'm@x.com', document: '123' });
    for (const id of ROLE_IDS.filter((x) => x !== 'role_finance')) assert.equal(maskRow(ctxs[id], 'contact', contato).phone, '+5511999990000', id);
  });

  test('Admin + Financeiro continua sem telefone (restrição vence o curinga do Admin)', () => {
    const c = ctxOf(subjectOf(ME, ['role_admin', 'role_finance']), { org: ORG });
    assert.deepEqual(fieldAccess(c, 'contact'), { phone: 'hidden' });
  });
});

// ---------------------------------------------------------------------------
// Resumo por perfil (effectiveMatrix): escopo máximo por entidade.ação, escrito à mão.
// Tudo que NÃO aparece abaixo tem que ser 'none'. Se alguém acrescentar OU retirar
// uma permissão de um perfil de sistema, este teste quebra.
// ---------------------------------------------------------------------------
const NONE = { scope: 'none', conditional: false, approval: false, denied: false };
const cell = (scope, extra = {}) => ({ scope, conditional: false, approval: false, denied: false, ...extra });
// [entidade, [ações], escopo, extras]
const rule = (entity, actions, scope, extra) => ({ entity, actions, scope, extra });

const MATRIX = {
  role_manager: [
    rule('contact', ['read', 'create', 'update', 'delete', 'export', 'import', 'transfer'], 'team_tree'),
    rule('company', ['read', 'create', 'update', 'delete', 'export', 'import', 'transfer'], 'team_tree'),
    rule('deal', ['read', 'create', 'update', 'delete', 'export', 'import', 'transfer', 'move'], 'team_tree'),
    // `denied`: a negação de auto-aprovação (ctx.requesterId == eu) se aplica a toda ação 'approve'
    rule('deal', ['approve'], 'team_tree', { conditional: true, denied: true }),
    rule('proposal', ['read', 'create', 'update', 'delete', 'send'], 'team_tree'),
    rule('proposal', ['approve'], 'team_tree', { conditional: true, denied: true }),
    rule('contact', ['share'], 'team_tree'),
    rule('deal', ['share'], 'team_tree'),
    rule('task', ['read', 'create', 'update', 'delete'], 'team_tree'),
    rule('call', ['read', 'create', 'listen', 'export'], 'team_tree'),
    rule('conversation', ['supervise', 'export'], 'team_tree'),
    // fila: o maior escopo é "tenant", mas só com a condição assigneeId isNull
    rule('conversation', ['read', 'send_message', 'note', 'transfer', 'resolve'], 'tenant', { conditional: true }),
    rule('report', ['read', 'create', 'export'], 'tenant'),
    rule('product', ['read', 'create', 'update'], 'tenant'),
    rule('pipeline', ['read', 'update'], 'tenant'),
    rule('automation', ['read', 'create', 'update'], 'tenant'),
    rule('instance', ['read'], 'tenant'),
    rule('ai_agent', ['read'], 'tenant'),
    rule('user', ['read'], 'tenant'),
    rule('role', ['read'], 'tenant'),
  ],
  role_agent: [
    rule('contact', ['read', 'create', 'update'], 'team'),
    rule('company', ['read', 'create', 'update'], 'team'),
    rule('deal', ['read', 'create', 'update', 'move', 'share'], 'own'),
    rule('proposal', ['read'], 'own'),
    // desconto > 5% exige aprovação em criar, enviar E alterar proposta
    rule('proposal', ['create', 'send', 'update'], 'own', { approval: true }),
    rule('task', ['read', 'create', 'update'], 'own'),
    rule('call', ['read', 'create'], 'own'),
    rule('conversation', ['read', 'send_message', 'note', 'transfer', 'resolve'], 'tenant', { conditional: true }),
    rule('product', ['read'], 'tenant'),
    rule('pipeline', ['read'], 'tenant'),
    rule('instance', ['read'], 'tenant'),
  ],
  role_sdr: [
    rule('contact', ['read', 'create', 'update'], 'team'),
    rule('company', ['read', 'create', 'update'], 'team'),
    rule('deal', ['read', 'create', 'update'], 'own'),
    rule('deal', ['move'], 'own', { denied: true }),
    rule('task', ['read', 'create', 'update'], 'own'),
    rule('conversation', ['read', 'send_message', 'note', 'transfer', 'resolve'], 'tenant', { conditional: true }),
    rule('product', ['read'], 'tenant'),
    rule('pipeline', ['read'], 'tenant'),
    rule('instance', ['read'], 'tenant'),
  ],
  role_finance: [
    rule('deal', ['read', 'export'], 'tenant'),
    rule('proposal', ['read'], 'tenant'),
    rule('contact', ['read'], 'tenant'),
    rule('company', ['read'], 'tenant'),
    rule('report', ['read', 'export'], 'tenant'),
    rule('billing', ['read', 'update'], 'tenant'),
    rule('product', ['read', 'create', 'update'], 'tenant'),
  ],
  role_viewer: [
    rule('contact', ['read'], 'tenant'),
    rule('company', ['read'], 'tenant'),
    rule('deal', ['read'], 'tenant'),
    rule('proposal', ['read'], 'tenant'),
    rule('task', ['read'], 'tenant'),
    rule('conversation', ['read'], 'tenant'),
    rule('report', ['read'], 'tenant'),
    rule('pipeline', ['read'], 'tenant'),
  ],
};
// Viewer: deny export em tudo => toda célula de export aparece com denied=true (mesmo sem grant)
const VIEWER_EXPORT_ENTITIES = ['contact', 'company', 'deal', 'conversation', 'call', 'report', 'audit_log'];

describe('matriz dourada: resumo por perfil (effectiveMatrix)', () => {
  test('o catálogo de entidades x ações não mudou (se mudar, revise as tabelas acima)', () => {
    const total = Object.values(ENTITIES).reduce((n, e) => n + e.actions.length, 0);
    assert.equal(Object.keys(ENTITIES).length, 19);
    assert.equal(total, 89, 'número de pares entidade.ação do catálogo');
  });

  test('Admin: escopo tenant incondicional em TODA entidade.ação, sem negação', () => {
    const m = effectiveMatrix(ctxs.role_admin);
    for (const [entity, e] of Object.entries(ENTITIES)) for (const a of e.actions) assert.deepEqual({ ...m[entity][a], shared: undefined }, { ...cell('tenant'), shared: undefined }, `${entity}.${a}`);
  });

  for (const id of Object.keys(MATRIX)) {
    test(`${id}: escopo, condicional, aprovação e negação batem com a tabela (o resto é "none")`, () => {
      const expected = new Map();
      for (const r of MATRIX[id]) for (const a of r.actions) expected.set(`${r.entity}.${a}`, cell(r.scope, r.extra));
      const m = effectiveMatrix(ctxs[id]);
      const problems = [];
      for (const [entity, e] of Object.entries(ENTITIES)) {
        for (const a of e.actions) {
          const want = { ...(expected.get(`${entity}.${a}`) ?? NONE) };
          if (id === 'role_viewer' && a === 'export' && VIEWER_EXPORT_ENTITIES.includes(entity)) want.denied = true;
          const { shared, ...got } = m[entity][a];
          void shared;
          if (JSON.stringify(got) !== JSON.stringify(want)) problems.push(`${entity}.${a}: esperado ${JSON.stringify(want)} obtido ${JSON.stringify(got)}`);
          expected.delete(`${entity}.${a}`);
        }
      }
      assert.deepEqual(problems, []);
      assert.equal(expected.size, 0, 'a tabela cita entidade.ação inexistente: ' + [...expected.keys()]);
    });
  }

  test('flag "shared" só aparece em read/update de entidades compartilháveis (contact, company, deal)', () => {
    const m = effectiveMatrix(ctxs.role_viewer);
    for (const [entity, e] of Object.entries(ENTITIES)) for (const a of e.actions) assert.equal(m[entity][a].shared, ['contact', 'company', 'deal'].includes(entity) && (a === 'read' || a === 'update'), `${entity}.${a}`);
  });
});

describe('matriz dourada: estrutura dos perfis de sistema', () => {
  test('exatamente 6 perfis, com id/nome/ordem esperados, de sistema e sem tenant', () => {
    assert.deepEqual(
      SYSTEM_ROLES.map((r) => [r.id, r.name, r.system, r.tenantId]),
      [
        ['role_admin', 'Admin', true, null],
        ['role_manager', 'Gestor', true, null],
        ['role_agent', 'Atendente', true, null],
        ['role_sdr', 'SDR', true, null],
        ['role_finance', 'Financeiro', true, null],
        ['role_viewer', 'Somente leitura', true, null],
      ]
    );
  });

  test('quantidade de grants/denies/campos por perfil', () => {
    const counts = Object.fromEntries(SYSTEM_ROLES.map((r) => [r.id, [r.grants.length, r.denies.length, r.fields.length, Object.keys(r.partitions).length]]));
    assert.deepEqual(counts, {
      role_admin: [1, 0, 0, 0],
      role_manager: [20, 1, 0, 0],
      role_agent: [13, 0, 0, 0],
      role_sdr: [9, 1, 0, 0],
      role_finance: [7, 0, 1, 0],
      role_viewer: [8, 1, 0, 0],
    });
  });

  test('regras sensíveis de cada perfil, literalmente', () => {
    const by = Object.fromEntries(SYSTEM_ROLES.map((r) => [r.id, r]));
    assert.deepEqual(by.role_admin.grants, [{ entity: '*', actions: ['*'], scope: 'tenant' }]);
    assert.deepEqual(by.role_sdr.denies, [{ entity: 'deal', actions: ['move'], conditions: [{ field: 'ctx.toStageKind', op: 'in', value: ['won', 'lost'] }] }]);
    assert.deepEqual(by.role_viewer.denies, [{ entity: '*', actions: ['export'] }]);
    assert.deepEqual(by.role_finance.fields, [{ entity: 'contact', field: 'phone', access: 'hidden' }]);
    const agentUpdate = by.role_agent.grants.find((g) => g.entity === 'proposal' && g.actions.includes('update'));
    assert.deepEqual(agentUpdate.approval, { when: [{ field: 'ctx.discountPct', op: 'gt', value: 5 }] });
    const approves = by.role_manager.grants.filter((g) => g.actions.includes('approve'));
    assert.equal(approves.length, 2);
    for (const g of approves) assert.deepEqual(g.conditions, [{ field: 'ctx.discountPct', op: 'lte', value: 15 }]);
  });

  test('NENHUM perfil exceto Admin recebe curinga, escopo tenant em dado de cliente sem condição ou delete amplo', () => {
    for (const r of SYSTEM_ROLES.filter((x) => x.id !== 'role_admin')) {
      for (const g of r.grants) {
        assert.notEqual(g.entity, '*', r.id);
        assert.ok(!g.actions.includes('*'), r.id);
      }
    }
    // apagar/exportar dados de cliente: só Admin (tenant) e Gestor (árvore de equipes); Financeiro só exporta deal
    for (const r of SYSTEM_ROLES.filter((x) => ['role_agent', 'role_sdr', 'role_viewer'].includes(x.id))) {
      for (const g of r.grants) for (const a of ['delete', 'export', 'import']) assert.ok(!g.actions.includes(a), `${r.id} ${g.entity} ${a}`);
    }
  });
});
