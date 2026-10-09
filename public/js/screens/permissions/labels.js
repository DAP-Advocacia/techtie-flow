// Dicionários pt-BR e formatadores de texto da tela de Permissões.
// O catálogo (shared/permissions/catalog.js) fala a língua do motor (ids em
// inglês); a UI fala a do cliente. Tudo que vira texto para a pessoa passa
// por aqui, então renomear um rótulo é mudar um lugar só.
import { ENTITIES, ACTIONS, SCOPES } from '/shared/permissions/index.js';

/** Seções da matriz (ordem e agrupamento definidos pela especificação da tela). */
export const SECTIONS = [
  { id: 'rel', label: 'Relacionamento', entities: ['contact', 'company', 'deal', 'proposal', 'task'] },
  { id: 'atend', label: 'Atendimento', entities: ['conversation', 'call', 'ai_agent'] },
  { id: 'conf', label: 'Configuração', entities: ['pipeline', 'product', 'automation', 'instance', 'report'] },
  { id: 'adm', label: 'Administração', entities: ['user', 'role', 'tenant_settings', 'billing', 'audit_log', 'api_key'] },
];

/** label = título da linha; noun = como aparece no meio de uma frase. */
export const ENTITY_LABELS = {
  contact: { label: 'Contatos', noun: 'contatos' },
  company: { label: 'Empresas', noun: 'empresas' },
  deal: { label: 'Negócios', noun: 'negócios' },
  proposal: { label: 'Propostas', noun: 'propostas' },
  task: { label: 'Tarefas', noun: 'tarefas' },
  conversation: { label: 'Conversas', noun: 'conversas' },
  call: { label: 'Chamadas', noun: 'chamadas' },
  ai_agent: { label: 'Agente de IA', noun: 'o agente de IA' },
  pipeline: { label: 'Pipelines', noun: 'pipelines' },
  product: { label: 'Produtos', noun: 'produtos' },
  automation: { label: 'Automações', noun: 'automações' },
  instance: { label: 'Instâncias WhatsApp', noun: 'instâncias de WhatsApp' },
  report: { label: 'Relatórios', noun: 'relatórios' },
  user: { label: 'Usuários', noun: 'usuários' },
  role: { label: 'Perfis de acesso', noun: 'perfis de acesso' },
  tenant_settings: { label: 'Config. da empresa', noun: 'as configurações da empresa' },
  billing: { label: 'Faturamento', noun: 'o faturamento' },
  audit_log: { label: 'Auditoria', noun: 'a auditoria' },
  api_key: { label: 'Chaves de API', noun: 'chaves de API' },
};
export const entityLabel = (e) => (e === '*' ? 'Todas as entidades' : ENTITY_LABELS[e]?.label || e);
export const entityNoun = (e) => (e === '*' ? 'tudo' : ENTITY_LABELS[e]?.noun || e);

/** label = nome completo; short = cabeçalho de coluna. */
export const ACTION_LABELS = {
  read: { label: 'Visualizar', short: 'Ver' },
  create: { label: 'Criar', short: 'Criar' },
  update: { label: 'Editar', short: 'Editar' },
  delete: { label: 'Excluir', short: 'Excluir' },
  export: { label: 'Exportar', short: 'Exportar' },
  import: { label: 'Importar', short: 'Importar' },
  transfer: { label: 'Transferir', short: 'Transferir' },
  move: { label: 'Mover de etapa', short: 'Mover' },
  approve: { label: 'Aprovar', short: 'Aprovar' },
  send_message: { label: 'Enviar mensagem', short: 'Mensagem' },
  note: { label: 'Nota interna', short: 'Nota' },
  resolve: { label: 'Resolver', short: 'Resolver' },
  supervise: { label: 'Supervisionar', short: 'Supervisionar' },
  send: { label: 'Enviar', short: 'Enviar' },
  publish: { label: 'Publicar', short: 'Publicar' },
  listen: { label: 'Ouvir gravação', short: 'Ouvir' },
  connect: { label: 'Conectar', short: 'Conectar' },
  assign: { label: 'Atribuir perfil', short: 'Atribuir' },
  manage: { label: 'Gerenciar', short: 'Gerenciar' },
};
export const actionLabel = (a) => (a === '*' ? 'Todas as ações' : ACTION_LABELS[a]?.label || a);
export const actionShort = (a) => ACTION_LABELS[a]?.short || a;
export const isSensitive = (a) => !!ACTIONS[a]?.sensitive;

/** Ações que existem em alguma das entidades dadas, na ordem do catálogo de ações. */
export function actionsOf(entityNames) {
  const used = new Set(entityNames.flatMap((e) => ENTITIES[e].actions));
  return Object.keys(ACTIONS).filter((a) => used.has(a));
}

// ---------- escopos ----------
export const SCOPE_LABELS = {
  none: { label: 'Nenhum', short: 'Nenhum', hint: 'Sem acesso' },
  own: { label: 'Somente os próprios', short: 'Próprios', hint: 'Apenas registros em que a pessoa é a responsável' },
  team: { label: 'Equipe', short: 'Equipe', hint: 'Os próprios e os da(s) equipe(s) da pessoa' },
  team_tree: { label: 'Equipe e subequipes', short: 'Equipe+sub', hint: 'Os da equipe e de todas as subequipes abaixo dela' },
  tenant: { label: 'Todos', short: 'Todos', hint: 'Todos os registros da empresa' },
};
export const scopeLabel = (s) => SCOPE_LABELS[s]?.label || s;
export const scopeShort = (s) => SCOPE_LABELS[s]?.short || s;
/** 0..4 — usado para a intensidade visual (barras e tom de fundo). */
export const scopeLevel = (s) => Math.max(0, SCOPES.indexOf(s));

// ---------- campos restringíveis ----------
export const FIELD_LABELS = {
  'contact.phone': 'Telefone',
  'contact.email': 'E-mail',
  'contact.document': 'Documento (CPF/CNPJ)',
  'company.document': 'Documento (CNPJ)',
  'deal.value': 'Valor do negócio',
  'deal.items': 'Itens do negócio',
  'deal.discount': 'Desconto',
  'conversation.phone': 'Telefone do contato',
  'proposal.discount': 'Desconto',
};
export const fieldLabel = (entity, field) => FIELD_LABELS[`${entity}.${field}`] || field;
export const FIELD_ACCESS_LABELS = { write: 'Normal', readonly: 'Somente leitura', hidden: 'Oculto' };

// ---------- condições ----------
export const OP_LABELS = {
  eq: 'é igual a',
  ne: 'é diferente de',
  in: 'está entre',
  nin: 'não está entre',
  lt: 'é menor que',
  lte: 'é no máximo',
  gt: 'é maior que',
  gte: 'é no mínimo',
  isNull: 'está vazio',
  notNull: 'está preenchido',
};
export const ATTR_LABELS = {
  ownerId: 'Responsável',
  teamId: 'Equipe do registro',
  assigneeId: 'Responsável pela conversa',
  stageId: 'Etapa',
  pipelineId: 'Pipeline',
  instanceId: 'Instância',
  value: 'Valor (R$)',
  status: 'Status',
  source: 'Origem',
  discountPct: 'Desconto (%)',
  direction: 'Direção',
};
export const CTX_LABELS = {
  discountPct: 'Desconto da operação (%)',
  rowCount: 'Nº de linhas exportadas',
  fromStageId: 'Etapa de origem',
  toStageId: 'Etapa de destino',
  fromStageKind: 'Tipo da etapa de origem',
  toStageKind: 'Tipo da etapa de destino',
};
export const conditionFieldLabel = (field) => (field.startsWith('ctx.') ? CTX_LABELS[field.slice(4)] || field : ATTR_LABELS[field] || field);
export const REF_LABELS = { '$user.id': 'o próprio usuário', '$user.teamIds': 'as equipes do usuário' };
/** Valores conhecidos de campos enumerados (rótulo de cada um). */
export const ENUMS = {
  status: { open: 'Em aberto', won: 'Ganho', lost: 'Perdido' },
  stageKind: { open: 'Em andamento', won: 'Ganho', lost: 'Perdido' },
};
/** Qual enumeração (ou fonte de ids) cada campo usa; null = valor livre. */
export function enumFor(field, entityName) {
  const key = field.startsWith('ctx.') ? field.slice(4) : field;
  if (key === 'toStageKind' || key === 'fromStageKind') return { kind: 'enum', values: ENUMS.stageKind };
  if (key === 'status' && entityName === 'deal') return { kind: 'enum', values: ENUMS.status };
  if (key === 'stageId' || key === 'toStageId' || key === 'fromStageId') return { kind: 'source', source: 'stage' };
  if (key === 'pipelineId') return { kind: 'source', source: 'pipeline' };
  if (key === 'instanceId') return { kind: 'source', source: 'instance' };
  return null;
}

/** Resolve ids do store para nomes (ids soltos viram o próprio id, nunca quebram). */
export function makeNamer(state) {
  const stages = new Map(state.pipelines.flatMap((p) => p.stages.map((s) => [s.id, `${p.name} › ${s.name}`])));
  const by = (list) => new Map(list.map((x) => [x.id, x.name]));
  const pipelines = by(state.pipelines);
  const instances = by(state.instances);
  const teams = by(state.teams);
  const users = by(state.users);
  const roles = by(state.roles);
  return {
    stage: (id) => stages.get(id) || id,
    pipeline: (id) => pipelines.get(id) || id,
    instance: (id) => instances.get(id) || id,
    team: (id) => teams.get(id) || id,
    user: (id) => users.get(id) || id,
    role: (id) => roles.get(id) || id,
  };
}

const fmtNum = (n) => (typeof n === 'number' ? new Intl.NumberFormat('pt-BR').format(n) : String(n));

function valueText(c, entityName, ns) {
  if (c.ref) return REF_LABELS[c.ref] || c.ref;
  const vals = Array.isArray(c.value) ? c.value : [c.value];
  const en = enumFor(c.field, entityName);
  const one = (v) => {
    if (en?.kind === 'enum') return en.values[v] || String(v);
    if (en?.kind === 'source') return ns?.[en.source]?.(v) ?? String(v);
    if (c.field.endsWith('discountPct')) return `${fmtNum(v)}%`;
    if (typeof v === 'number') return fmtNum(v);
    return String(v);
  };
  return vals.map(one).join(' ou ');
}

/** "Desconto da operação (%) é no máximo 15%" */
export function describeCondition(c, entityName, ns) {
  const base = `${conditionFieldLabel(c.field)} ${OP_LABELS[c.op] || c.op}`;
  return c.op === 'isNull' || c.op === 'notNull' ? base : `${base} ${valueText(c, entityName, ns)}`;
}

const joinList = (items) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} e ${items[items.length - 1]}`);
const actionsText = (actions) => (actions.includes('*') ? 'todas as ações' : joinList(actions.map(actionLabel)));

/** "Atendente pode Exportar contatos — Equipe · quando …" */
export function describeGrant(who, g, ns) {
  const conds = (g.conditions || []).map((c) => describeCondition(c, g.entity, ns));
  const appr = (g.approval?.when || []).map((c) => describeCondition(c, g.entity, ns));
  const head = g.entity === '*' && g.actions.includes('*') ? `${who} pode tudo` : `${who} pode ${actionsText(g.actions)} ${g.entity === '*' ? 'em tudo' : entityNoun(g.entity)}`;
  return [`${head} — ${scopeLabel(g.scope)}`, conds.length ? `quando ${conds.join(' e ')}` : '', appr.length ? `exige aprovação quando ${appr.join(' e ')}` : g.approval ? 'sempre exige aprovação' : ''].filter(Boolean).join(' · ');
}

export function describeDeny(who, d, ns) {
  const conds = (d.conditions || []).map((c) => describeCondition(c, d.entity, ns));
  const head = d.entity === '*' && d.actions.includes('*') ? `${who} não pode nada` : `${who} não pode ${actionsText(d.actions)} ${d.entity === '*' ? 'em nenhum recurso' : entityNoun(d.entity)}`;
  return conds.length ? `${head} · quando ${conds.join(' e ')}` : head;
}

const accessText = (a) => FIELD_ACCESS_LABELS[a] || a;
const fieldsMap = (list) => new Map((list || []).map((f) => [`${f.entity}.${f.field}`, f.access]));

/** Uma linha de diffRoles em português. `who` = nome do perfil. */
export function describeChange(change, who, ns) {
  const verb = change.type === 'added' ? 'Adicionou' : change.type === 'removed' ? 'Removeu' : 'Alterou';
  if (change.kind === 'grants') return `${verb}: ${describeGrant(who, change.rule, ns)}`;
  if (change.kind === 'denies') return `${verb} negação: ${describeDeny(who, change.rule, ns)}`;
  if (change.kind === 'description') return 'Alterou a descrição do perfil';
  if (change.kind === 'name') return `Renomeou: "${change.before ?? ''}" → "${change.after ?? ''}"`;
  if (change.kind === 'partitions') {
    const out = [];
    for (const key of ['pipelineId', 'instanceId']) {
      const b = change.before?.[key] ?? 'all';
      const a = change.after?.[key] ?? 'all';
      if (JSON.stringify(a) === JSON.stringify(b)) continue;
      const src = key === 'pipelineId' ? 'pipeline' : 'instance';
      const fmt = (v) => (v === 'all' ? 'todos' : v.length ? v.map((id) => ns?.[src]?.(id) ?? id).join(', ') : 'nenhum');
      out.push(`${key === 'pipelineId' ? 'Pipelines' : 'Instâncias'}: ${fmt(b)} → ${fmt(a)}`);
    }
    return `Recortes — ${out.join('; ') || 'alterados'}`;
  }
  if (change.kind === 'fields') {
    const b = fieldsMap(change.before);
    const a = fieldsMap(change.after);
    const keys = new Set([...a.keys(), ...b.keys()]);
    const out = [];
    for (const k of keys) {
      if (a.get(k) === b.get(k)) continue;
      const [entity, field] = k.split('.');
      out.push(`${fieldLabel(entity, field)} (${entityNoun(entity)}): ${accessText(b.get(k) || 'write')} → ${accessText(a.get(k) || 'write')}`);
    }
    return `Campos — ${out.join('; ') || 'alterados'}`;
  }
  return `${verb}: ${change.kind}`;
}

// ---------- auditoria ----------
export const AUDIT_LABELS = {
  'role.create': 'Perfil criado',
  'role.update': 'Perfil alterado',
  'role.delete': 'Perfil excluído',
  'role.assign': 'Perfis atribuídos',
  'user.invite': 'Usuário convidado',
  'user.suspend': 'Usuário suspenso',
  'user.reactivate': 'Usuário reativado',
  'user.teams': 'Equipes alteradas',
  'policy.update': 'Política alterada',
};
export const auditLabel = (a) => AUDIT_LABELS[a] || a;

export const STATUS_LABELS = { active: 'Ativo', invited: 'Convidado', suspended: 'Suspenso' };

// ---------- utilidades ----------
/** Id legível para perfil novo: "Atendente Sênior" -> "atendente_senior". */
export function slug(text) {
  return (
    String(text || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 28) || 'perfil'
  );
}

const rtf = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' });
export function relTime(ts, now = Date.now()) {
  const s = Math.round((ts - now) / 1000);
  const abs = Math.abs(s);
  if (abs < 45) return 'agora';
  if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(s / 86400), 'day');
  return rtf.format(Math.round(s / (86400 * 30)), 'month');
}
export const fmtDateTime = (ts) => new Date(ts).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
