// Camada SIMPLES do editor de perfil: "Em resumo" (o que o perfil permite, em português, calculado das
// regras reais) e "Ajustes rápidos" (os poucos controles que mais se usam). Edita o MESMO rascunho que a
// matriz/regras avançadas (ed.role) — nada aqui cria um segundo modelo, então o que for feito na matriz
// aparece no resumo e vice-versa. Quem precisa de detalhe abre o "Modo avançado".
import { h, toggle } from '../../ui.js';
import { simpleCells, advancedCells, rebuildSimple } from './model.js';
import { fieldLabel } from './labels.js';

// Registros "de alguém" (têm dono/equipe): é neles que o ALCANCE (só dele / equipe / tudo) faz sentido.
export const RECORDS = ['contact', 'company', 'deal', 'proposal', 'task', 'call', 'conversation'];
export const DELETABLE = ['contact', 'company', 'deal', 'proposal', 'task'];
export const EXPORTABLE = ['contact', 'company', 'deal', 'conversation', 'call'];
export const ATTEND = ['send_message', 'note', 'transfer', 'resolve'];
export const OWN_NUMBER = ['read', 'create', 'update', 'connect', 'delete'];

const REACH = [
  { scope: 'own', label: 'Só o que é dele(a)', hint: 'Negócios, contatos e conversas em que a pessoa é a responsável.' },
  { scope: 'team', label: 'Equipe', hint: 'O que é dela e da(s) equipe(s) a que pertence.' },
  { scope: 'team_tree', label: 'Equipe e subequipes', hint: 'O que é da equipe e de tudo que está abaixo dela no organograma.' },
  { scope: 'tenant', label: 'Tudo da empresa', hint: 'Dados de todas as equipes. Use com cuidado.' },
];
const REACH_TEXT = { own: 'só o que é dele(a)', team: 'o que é da equipe', team_tree: 'o que é da equipe e subequipes', tenant: 'tudo da empresa' };

const key = (e, a) => `${e}.${a}`;

/** Edita as células "simples" do rascunho e reescreve os grants (mantendo os avançados). */
function editCells(role, fn) {
  const cells = simpleCells(role);
  fn(cells);
  rebuildSimple(role, cells);
}

/** Alcance atual dos registros: o escopo, se TODOS concordam; null se for misto/sem nada. */
export function currentReach(role) {
  const cells = simpleCells(role);
  const seen = new Set();
  for (const [k, scope] of cells) if (RECORDS.includes(k.split('.')[0]) && scope !== 'none') seen.add(scope);
  return seen.size === 1 ? [...seen][0] : null;
}

/** Muda o alcance de TODOS os registros que o perfil já alcança (não liga nada que estava desligado). */
export function setReach(role, scope) {
  editCells(role, (cells) => {
    for (const k of [...cells.keys()]) if (RECORDS.includes(k.split('.')[0])) cells.set(k, scope);
  });
}

const anyCell = (cells, entities, action) => entities.some((e) => cells.has(key(e, action)));

/** Liga/desliga uma ação em várias entidades, usando o alcance de leitura de cada uma (ou o atual). */
export function setAction(role, entities, action, on) {
  const reach = currentReach(role);
  editCells(role, (cells) => {
    for (const e of entities) {
      const k = key(e, action);
      if (!on) cells.delete(k);
      else cells.set(k, cells.get(key(e, 'read')) || reach || 'own');
    }
  });
}

/**
 * "Atender" (responder, anotar, transferir, resolver) inclui a regra da FILA, que é uma regra com condição
 * (sem responsável + status fila). Ligar/desligar o interruptor precisa tratar essa regra também, senão a
 * pessoa continua respondendo na fila com o interruptor desligado.
 */
export function setAttend(role, on) {
  for (const a of ATTEND) setAction(role, ['conversation'], a, on);
  for (const g of role.grants || []) {
    const isQueue = g.entity === 'conversation' && (g.conditions || []).some((c) => c.field === 'assigneeId' && c.op === 'isNull');
    if (!isQueue) continue;
    const rest = (g.actions || []).filter((a) => !ATTEND.includes(a));
    g.actions = on ? [...new Set([...rest, ...ATTEND])] : rest;
  }
  // grant da fila que ficou sem ações não deve sobrar vazio
  role.grants = (role.grants || []).filter((g) => (g.actions || []).length);
}

/** "Número próprio": ler, criar, renomear e conectar SÓ os números dele (os da empresa ficam de fora). */
export function setOwnNumber(role, on) {
  editCells(role, (cells) => {
    for (const a of OWN_NUMBER) {
      if (on) cells.set(key('instance', a), 'own');
      else cells.delete(key('instance', a));
    }
  });
}
export const hasOwnNumber = (role) => {
  const cells = simpleCells(role);
  return OWN_NUMBER.every((a) => cells.has(key('instance', a)));
};

/** O perfil consegue responder conversas (por regra simples OU pela fila)? */
export const canAttend = (role) => {
  const k = key('conversation', 'send_message');
  return simpleCells(role).has(k) || advancedCells(role).has(k);
};

const hasQueueGrant = (role) => (role.grants || []).some((g) => (g.entity === 'conversation' || g.entity === '*') && (g.conditions || []).some((c) => c.field === 'assigneeId' && c.op === 'isNull'));

// ---------------------------------------------------------------------------
// Resumo em português
// ---------------------------------------------------------------------------

/** [{ area, text, none }] — calculado das regras reais do rascunho. */
export function summarize(role, state) {
  const cells = simpleCells(role);
  const adv = advancedCells(role);
  const has = (e, a) => cells.has(key(e, a)) || adv.has(key(e, a));
  const reach = (e) => REACH_TEXT[cells.get(key(e, 'read'))];
  const list = (pairs) => pairs.filter(([e, a]) => has(e, a)).map(([, , label]) => label);
  const rows = [];
  const push = (area, text) => rows.push({ area, text: text || 'Sem acesso', none: !text });

  // Conversas
  const queue = hasQueueGrant(role);
  const convRead = reach('conversation');
  if (convRead || queue || adv.has(key('conversation', 'read'))) {
    const parts = [convRead ? `vê ${convRead}` : null, queue ? `${convRead ? 'e ' : 'vê '}a fila de atendimento` : null].filter(Boolean);
    const acts = list([['conversation', 'send_message', 'responde'], ['conversation', 'transfer', 'transfere'], ['conversation', 'resolve', 'resolve']]);
    push('Conversas', `${parts.join(' ') || 'tem regras próprias'}${acts.length ? ` · ${acts.join(', ')}` : ' · só leitura'}`);
  } else push('Conversas');

  const record = (area, entity, extras) => {
    const r = reach(entity);
    if (!r && !adv.has(key(entity, 'read'))) return push(area);
    const acts = list(extras.map(([a, label]) => [entity, a, label]));
    push(area, `vê ${r || 'com regras próprias'}${acts.length ? ` · ${acts.join(', ')}` : ' · só leitura'}`);
  };
  record('Negócios', 'deal', [['create', 'cria'], ['update', 'edita'], ['move', 'move de etapa'], ['transfer', 'transfere'], ['delete', 'exclui'], ['approve', 'aprova descontos']]);
  record('Contatos', 'contact', [['create', 'cria'], ['update', 'edita'], ['delete', 'exclui'], ['import', 'importa']]);
  record('Propostas', 'proposal', [['create', 'cria'], ['update', 'edita'], ['send', 'envia'], ['approve', 'aprova']]);

  const exports = EXPORTABLE.filter((e) => has(e, 'export')).length || has('report', 'export');
  push('Relatórios', has('report', 'read') ? `vê relatórios e dashboard${exports ? ' · exporta dados' : ''}` : exports ? 'exporta dados' : '');

  const wa = list([['instance', 'connect', 'conecta e desconecta'], ['instance', 'create', 'cria números'], ['instance', 'update', 'edita']]);
  // o número tem responsável: "só o dele" = números pessoais; "tudo" = também os da empresa
  const NUMBERS = { own: 'só os números dele(a)', team: 'os números da equipe', team_tree: 'os números da equipe e subequipes', tenant: 'todos os números, inclusive os da empresa' };
  push('Números de WhatsApp', has('instance', 'read') ? `vê ${NUMBERS[cells.get(key('instance', 'read'))] || 'os números'}${wa.length ? ` · ${wa.join(', ')}` : ''}` : '');

  const admin = list([['user', 'update', 'gerencia usuários'], ['role', 'assign', 'atribui perfis'], ['role', 'update', 'edita perfis'], ['tenant_settings', 'update', 'altera configurações'], ['billing', 'read', 'vê o faturamento'], ['audit_log', 'read', 'vê a auditoria']]);
  push('Administração', admin.join(', '));

  // Limites e travas
  const limits = [];
  const parts = role.partitions || {};
  const names = (key2, source) => (Array.isArray(parts[key2]) ? parts[key2].map((id) => source.find((x) => x.id === id)?.name || 'removido').join(', ') || 'nenhum' : null);
  const inst = names('instanceId', state.instances || []);
  const pipe = names('pipelineId', state.pipelines || []);
  if (inst !== null) limits.push(`só os números: ${inst}`);
  if (pipe !== null) limits.push(`só os funis: ${pipe}`);
  const hidden = (role.fields || []).filter((f) => f.access === 'hidden').map((f) => fieldLabel(f.entity, f.field).toLowerCase());
  if (hidden.length) limits.push(`não vê: ${[...new Set(hidden)].join(', ')}`);
  const nAdv = (role.grants || []).filter((g) => (g.conditions || []).length || g.approval).length;
  const nDeny = (role.denies || []).length;
  if (nAdv || nDeny) limits.push([nAdv ? `${nAdv} regra(s) avançada(s)` : null, nDeny ? `${nDeny} trava(s)` : null].filter(Boolean).join(' e '));
  rows.push({ area: 'Limites', text: limits.length ? limits.join(' · ') : 'Nenhum limite extra (todos os números e funis, todos os campos)', none: false, limits: true });
  return rows;
}

const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export function summarySection(ed) {
  const rows = summarize(ed.role, ed.state);
  return h(
    'dl',
    { class: 'perm-summary' },
    rows.flatMap((r) => [h('dt', { class: 'perm-summary__area' }, r.area), h('dd', { class: 'perm-summary__text' + (r.none ? ' is-none' : '') + (r.limits ? ' is-limits' : '') }, capital(r.text))])
  );
}

// ---------------------------------------------------------------------------
// Ajustes rápidos
// ---------------------------------------------------------------------------

export function quickSection(ed) {
  const { role } = ed;
  const cells = simpleCells(role);
  const reach = currentReach(role);
  const refresh = () => ed.refresh(['quick', 'summary', 'matrix', 'adv']);

  const row = (title, hint, control) => h('div', { class: 'perm-quick__row' }, h('div', { class: 'perm-quick__text' }, h('div', { class: 'perm-quick__title' }, title), h('p', { class: 'perm-hint' }, hint)), h('div', { class: 'perm-quick__control' }, control));
  const sw = (on, label, apply) => toggle(on, (next) => { apply(next); refresh(); }, label);

  const seg = h(
    'div',
    { class: 'pills perm-seg', role: 'radiogroup', 'aria-label': 'Alcance dos dados' },
    REACH.map((o) =>
      h('button', { class: 'pill' + (reach === o.scope ? ' is-active' : ''), type: 'button', role: 'radio', 'aria-checked': String(reach === o.scope), title: o.hint, 'data-fk': `reach:${o.scope}`, onclick: () => { setReach(role, o.scope); refresh(); } }, o.label)
    )
  );
  const reachHint = reach ? REACH.find((o) => o.scope === reach).hint : 'Os recursos têm alcances diferentes. Escolha um para igualar todos.';

  return h(
    'div',
    { class: 'perm-quick' },
    row('Até onde a pessoa enxerga', reachHint, seg),
    row('Pode responder e atender conversas', 'Responder, anotar, transferir e resolver. Desligado: só lê as conversas.', sw(canAttend(role), 'Atender conversas', (on) => setAttend(role, on))),
    row('Pode ter número de WhatsApp próprio', 'Criar, conectar, renomear e remover o número dele, e receber as conversas dele. Só enxerga os números dele, não os da empresa.', sw(hasOwnNumber(role), 'Número próprio', (on) => setOwnNumber(role, on))),
    row('Pode excluir registros', 'Apagar contatos, empresas, negócios, propostas e tarefas.', sw(anyCell(cells, DELETABLE, 'delete'), 'Excluir registros', (on) => setAction(role, DELETABLE, 'delete', on))),
    row('Pode exportar dados', 'Baixar listas de contatos, negócios, conversas e chamadas. É uma ação sensível: ligue só para quem precisa.', sw(anyCell(cells, EXPORTABLE, 'export'), 'Exportar dados', (on) => { setAction(role, EXPORTABLE, 'export', on); if (!on) editCells(role, (c) => c.delete(key('report', 'export'))); })),
    row('Pode ver relatórios e dashboard', 'Números e gráficos de toda a empresa.', sw(cells.has(key('report', 'read')), 'Ver relatórios', (on) => editCells(role, (c) => { for (const a of ['read', 'create', 'export']) { if (on && a === 'read') c.set(key('report', a), 'tenant'); else if (!on) c.delete(key('report', a)); } })))
  );
}
