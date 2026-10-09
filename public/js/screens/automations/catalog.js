// Catálogo de tipos de nó das Automações: defaults, texto do cartão (título/desc)
// e validação. Fica separado da UI para o roteiro de "Testar"/"Publicar" e o
// editor falarem a mesma língua sobre o que é um nó completo.

export const KIND_META = {
  trigger: { label: 'Gatilho', tag: 'GATILHO', color: 'var(--acc)' },
  condition: { label: 'Condição', tag: 'CONDIÇÃO', color: 'var(--ins)' },
  action: { label: 'Ação', tag: 'AÇÃO', color: 'var(--green)' },
};

export const DAY_OPTIONS = ['Seg–Sex', 'Seg–Sáb', 'Todos os dias'];
export const AI_GOALS = ['Qualifica o lead', 'Tira dúvidas sobre produtos', 'Agenda uma reunião', 'Responde fora do horário'];
export const FIELD_OPTIONS = [
  { value: 'source', label: 'Origem' },
  { value: 'tag', label: 'Tag' },
  { value: 'company', label: 'Empresa' },
  { value: 'owner', label: 'Responsável' },
];
export const OPERATOR_OPTIONS = [
  { value: 'eq', label: 'é igual a' },
  { value: 'contains', label: 'contém' },
  { value: 'neq', label: 'é diferente de' },
];

const clean = (v) => String(v ?? '').trim();
const byId = (arr, id) => (arr || []).find((x) => x.id === id);
const short = (s, n = 56) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
// '08:00' -> '08h', '08:30' -> '08h30'
const hLabel = (t) => {
  const [hh = '', mm = '00'] = String(t || '').split(':');
  return mm === '00' ? `${hh}h` : `${hh}h${mm}`;
};

// ---- opções vindas do estado compartilhado (instâncias, pipelines, ...) ----
export const instanceOptions = (s) => [{ value: '', label: 'Qualquer instância' }, ...s.instances.map((i) => ({ value: i.id, label: i.name }))];
export const pipelineOptions = (s) => s.pipelines.map((p) => ({ value: p.id, label: p.name }));
export const stageOptions = (s, pipelineId) => (byId(s.pipelines, pipelineId)?.stages || []).map((st) => ({ value: st.id, label: st.name }));
export const templateOptions = (s) => s.messageTemplates.map((t) => ({ value: t.id, label: t.name }));
export const ownerOptions = (s) => [{ value: 'round_robin', label: 'Rodízio da equipe' }, ...s.users.filter((u) => !u.isBot).map((u) => ({ value: u.id, label: u.name }))];

const instName = (s, id) => byId(s.instances, id)?.name;
const stageName = (s, pid, sid) => byId(byId(s.pipelines, pid)?.stages, sid)?.name;

const firstPipeline = (s) => s.pipelines[0];

// ---- definição dos tipos ----
// defaults(s): parâmetros iniciais · describe(p, s): texto do cartão · issues(p, s): { campo: mensagem }
export const TYPES = {
  new_message: {
    kind: 'trigger',
    label: 'Nova mensagem',
    defaults: (s) => ({ instanceId: s.instances[0]?.id || '', scope: 'new' }),
    describe: (p, s) => `${p.scope === 'any' ? 'Qualquer contato' : 'Contato novo'} ${instName(s, p.instanceId) ? `na instância ${instName(s, p.instanceId)}` : 'em qualquer instância'}`,
  },
  no_reply: {
    kind: 'trigger',
    label: 'Sem resposta do lead',
    defaults: () => ({ hours: 24, instanceId: '' }),
    describe: (p, s) => `Há ${p.hours}h após nossa última mensagem${instName(s, p.instanceId) ? ` · ${instName(s, p.instanceId)}` : ''}`,
    issues: (p) => (Number.isInteger(p.hours) && p.hours >= 1 && p.hours <= 720 ? {} : { hours: 'Informe de 1 a 720 horas' }),
  },
  deal_moved: {
    kind: 'trigger',
    label: 'Negócio movido',
    defaults: (s) => ({ pipelineId: firstPipeline(s)?.id || '', stageId: firstPipeline(s)?.stages[0]?.id || '' }),
    describe: (p, s) => `Para a etapa ${stageName(s, p.pipelineId, p.stageId) || '—'}`,
    issues: (p) => (p.stageId ? {} : { stageId: 'Escolha a etapa' }),
  },
  tag_added: {
    kind: 'trigger',
    label: 'Tag adicionada',
    defaults: () => ({ tag: '' }),
    describe: (p) => `Tag "${clean(p.tag) || '—'}" aplicada ao contato`,
    issues: (p) => (clean(p.tag) ? {} : { tag: 'Informe a tag' }),
  },

  business_hours: {
    kind: 'condition',
    label: 'Horário comercial?',
    defaults: () => ({ days: 'Seg–Sex', from: '08:00', to: '18:00' }),
    describe: (p) => `${p.days}, ${hLabel(p.from)}–${hLabel(p.to)}`,
    issues: (p) => (!p.from || !p.to ? { to: 'Informe o horário' } : p.from >= p.to ? { to: 'O fim deve ser depois do início' } : {}),
  },
  contact_field: {
    kind: 'condition',
    label: 'Campo do contato',
    defaults: () => ({ field: 'source', operator: 'eq', value: '' }),
    describe: (p) => `${FIELD_OPTIONS.find((f) => f.value === p.field)?.label || 'Campo'} ${OPERATOR_OPTIONS.find((o) => o.value === p.operator)?.label || ''} "${clean(p.value) || '—'}"`,
    issues: (p) => (clean(p.value) ? {} : { value: 'Informe o valor' }),
  },
  deal_open: {
    kind: 'condition',
    label: 'Negócio aberto?',
    defaults: () => ({}),
    describe: () => 'Etapa diferente de Ganho/Perdido',
  },

  ai_reply: {
    kind: 'action',
    label: 'Agente de IA responde',
    defaults: () => ({ goal: AI_GOALS[0] }),
    describe: (p) => p.goal,
  },
  send_message: {
    kind: 'action',
    label: 'Enviar mensagem',
    defaults: (s) => ({ mode: 'template', templateId: s.messageTemplates[0]?.id || '', text: '' }),
    describe: (p, s) => (p.mode === 'template' ? `Modelo: ${byId(s.messageTemplates, p.templateId)?.name || '—'}` : `"${short(clean(p.text) || '—')}"`),
    issues: (p) => (p.mode === 'template' ? (p.templateId ? {} : { templateId: 'Escolha o modelo' }) : clean(p.text) ? {} : { text: 'Escreva a mensagem' }),
  },
  create_deal: {
    kind: 'action',
    label: 'Criar negócio',
    defaults: (s) => ({ pipelineId: firstPipeline(s)?.id || '', stageId: firstPipeline(s)?.stages[0]?.id || '' }),
    describe: (p, s) => `Pipeline ${byId(s.pipelines, p.pipelineId)?.name || '—'} → ${stageName(s, p.pipelineId, p.stageId) || '—'}`,
    issues: (p) => (p.pipelineId && p.stageId ? {} : { stageId: 'Escolha pipeline e etapa' }),
  },
  assign_owner: {
    kind: 'action',
    label: 'Atribuir responsável',
    defaults: () => ({ userId: 'round_robin' }),
    describe: (p, s) => (p.userId === 'round_robin' ? 'Rodízio da equipe' : `Responsável: ${byId(s.users, p.userId)?.name || '—'}`),
  },
  add_tag: {
    kind: 'action',
    label: 'Adicionar tag',
    defaults: () => ({ tag: '' }),
    describe: (p) => `Tag: ${clean(p.tag) || '—'}`,
    issues: (p) => (clean(p.tag) ? {} : { tag: 'Informe a tag' }),
  },
  create_task: {
    kind: 'action',
    label: 'Criar tarefa',
    defaults: () => ({ text: 'Lembrar o responsável', days: 2 }),
    describe: (p) => `${clean(p.text) || '—'} em ${p.days} ${p.days === 1 ? 'dia' : 'dias'}`,
    issues: (p) => ({ ...(clean(p.text) ? {} : { text: 'Descreva a tarefa' }), ...(Number.isInteger(p.days) && p.days >= 1 && p.days <= 90 ? {} : { days: 'Informe de 1 a 90 dias' }) }),
  },
};

export const typesOf = (kind) => Object.entries(TYPES).filter(([, d]) => d.kind === kind).map(([id, d]) => ({ id, label: d.label }));

/** Nó vazio de gatilho — todo fluxo novo nasce assim. */
export const emptyTrigger = () => ({ id: newId(), kind: 'trigger', type: null, title: 'Escolher gatilho', desc: 'Defina quando o fluxo começa', params: {} });

let seq = 0;
export const newId = () => `n${Date.now().toString(36)}${(seq++).toString(36)}`;

export function createNode(typeId, s) {
  const def = TYPES[typeId];
  const node = { id: newId(), kind: def.kind, type: typeId, params: def.defaults(s) };
  return refresh(node, s);
}

/** Reescreve title/desc a partir do tipo + parâmetros (usado em toda edição). */
export function refresh(node, s) {
  const def = TYPES[node.type];
  if (!def) return node;
  reconcile(node, s);
  node.title = def.label;
  node.desc = def.describe(node.params, s);
  return node;
}

// Etapa tem que pertencer ao pipeline escolhido; troca de pipeline reposiciona.
function reconcile(node, s) {
  const p = node.params;
  if ('pipelineId' in p && 'stageId' in p) {
    const stages = byId(s.pipelines, p.pipelineId)?.stages || [];
    if (!stages.some((st) => st.id === p.stageId)) p.stageId = stages[0]?.id || '';
  }
}

export function nodeIssues(node, s) {
  if (!node.type) return { type: 'Escolha o tipo de gatilho' };
  return TYPES[node.type]?.issues?.(node.params, s) || {};
}

/** Lista de problemas que impedem testar/publicar o fluxo. */
export function flowIssues(flow, s) {
  const out = [];
  const trigger = flow.nodes[0];
  if (!trigger || trigger.kind !== 'trigger' || !trigger.type) out.push('Defina um gatilho para o fluxo começar.');
  if (!flow.nodes.some((n) => n.kind === 'action')) out.push('Adicione pelo menos uma ação.');
  for (const n of flow.nodes) {
    if (n.type && Object.keys(nodeIssues(n, s)).length) out.push(`"${n.title}" está incompleto.`);
  }
  return out;
}

/**
 * Nós do mock vêm só com title/desc. Deduz tipo e parâmetros a partir do texto
 * (sem reescrever título/desc originais) para o editor funcionar neles.
 */
export function normalizeNode(node, s) {
  if (node.params && (node.type || node.kind === 'trigger')) return;
  const d = clean(node.desc);
  const inPipe = () => s.pipelines.find((p) => d.includes(p.name)) || firstPipeline(s);
  const inStage = (p) => p?.stages.find((st) => d.includes(st.name))?.id || p?.stages[0]?.id || '';
  const hit = (arr, key = 'name') => arr.find((x) => d.includes(x[key]));
  const map = {
    'Nova mensagem': ['new_message', () => ({ instanceId: hit(s.instances)?.id || '', scope: /novo/i.test(d) ? 'new' : 'any' })],
    'Sem resposta do lead': ['no_reply', () => ({ hours: Number(d.match(/(\d+)\s*h/)?.[1]) || 24, instanceId: '' })],
    'Negócio movido': ['deal_moved', () => { const p = s.pipelines.find((x) => x.stages.some((st) => d.includes(st.name))) || firstPipeline(s); return { pipelineId: p?.id || '', stageId: inStage(p) }; }],
    'Horário comercial?': ['business_hours', () => {
      const m = d.match(/(\d{1,2})h\s*[–-]\s*(\d{1,2})h/);
      const hh = (x, fallback) => `${(x || fallback).padStart(2, '0')}:00`;
      return { days: DAY_OPTIONS.find((x) => d.includes(x)) || 'Seg–Sex', from: hh(m?.[1], '08'), to: hh(m?.[2], '18') };
    }],
    'Negócio aberto?': ['deal_open', () => ({})],
    'Agente de IA responde': ['ai_reply', () => ({ goal: d || AI_GOALS[0] })],
    'Enviar mensagem': ['send_message', () => ({ mode: 'template', templateId: hit(s.messageTemplates)?.id || s.messageTemplates[0]?.id || '', text: '' })],
    'Criar negócio': ['create_deal', () => { const p = inPipe(); return { pipelineId: p?.id || '', stageId: inStage(p) }; }],
    'Criar tarefa': ['create_task', () => ({ text: d.replace(/\s+em\s+\d+\s+dias?$/i, '') || 'Lembrar o responsável', days: Number(d.match(/(\d+)\s+dias?/)?.[1]) || 2 })],
  };
  const hitDef = map[node.title];
  if (!hitDef) {
    // Título desconhecido: mantém o texto, mas deixa editar escolhendo um tipo.
    node.type = null;
    node.params = {};
    return;
  }
  node.type = hitDef[0];
  node.params = hitDef[1]();
}
