// Catálogo declarativo de permissões — ÚNICA fonte de verdade do que existe
// para ser autorizado. O motor (engine.js), a validação (validate.js), o
// compilador SQL (expr.js) e a tela de Permissões leem daqui; adicionar uma
// entidade ou ação nova = acrescentar um registro aqui, sem tocar no motor.
//
// Vocabulário:
//   entidade  — tipo de recurso (deal, contact, conversation…)
//   ação      — o que se faz com ele (read, update, export…)
//   escopo    — "de quem": none < own < team < team_tree < tenant (cada um contém o anterior)
//   atributo  — propriedade do registro usável em condições e no filtro SQL (ownerId, stageId…)
//   campo     — dado do registro que pode ser ocultado/travado por perfil (deal.value, contact.phone…)
//   partição  — chave que recorta dados por configuração (pipelineId, instanceId)

// Dicionários SEM protótipo: ENTITIES['constructor'] / ['__proto__'] / ['toString']
// devolviam funções/objetos herdados de Object.prototype (truthy). Resultado: uma
// entidade "desconhecida" vinda da URL (ex.: /api/__proto__) fazia decide() LANÇAR
// em vez de negar, e um atributo chamado 'constructor' passava como "atributo
// válido" em condições e no toSql. Sem protótipo, chave inexistente = undefined.
const dict = (obj) => Object.assign(Object.create(null), obj);

/** Do mais restrito ao mais amplo. A ordem importa: scopeRank() compara amplitude. */
export const SCOPES = ['none', 'own', 'team', 'team_tree', 'tenant'];
export const scopeRank = (scope) => SCOPES.indexOf(scope);

/**
 * Ações conhecidas. `sensitive`: exige MFA quando a política do tenant pede
 * (requireMfaForSensitive) e entra nos alertas de auditoria.
 * `ctx`: atributos de CONTEXTO da operação que condições podem usar via
 * "ctx.<nome>" (ex.: mover negócio para uma etapa — ctx.toStageKind).
 */
export const ACTIONS = dict({
  read: {},
  create: { ctx: ['discountPct'] },
  update: { ctx: ['discountPct'] },
  delete: { sensitive: true },
  export: { sensitive: true, ctx: ['rowCount'] },
  import: { sensitive: true },
  transfer: {}, // reatribuir responsável
  move: { ctx: ['fromStageId', 'toStageId', 'fromStageKind', 'toStageKind'] },
  // requesterId = quem pediu a aprovação (o servidor preenche): permite negar auto-aprovação.
  approve: { ctx: ['discountPct', 'requesterId'] },
  share: {}, // criar/remover compartilhamento de UM registro (a UI de compartilhar exige isto)
  send_message: {},
  note: {},
  resolve: {},
  supervise: { sensitive: true }, // entrar/acompanhar conversa de outro usuário
  send: { ctx: ['discountPct'] },
  publish: {},
  listen: { sensitive: true }, // ouvir gravação de chamada
  connect: {}, // parear/reconectar instância
  assign: { sensitive: true }, // atribuir perfil a usuário
  manage: { sensitive: true },
});

// Tipos de atributo (viram casts no SQL): uuid | text | numeric | boolean
const record = (extra) => ({
  ownerField: 'ownerId',
  teamField: 'teamId',
  scopes: SCOPES,
  shareable: false,
  partitions: {},
  fields: [],
  ...extra,
  partitions: dict(extra.partitions || {}),
  attrs: dict({ id: 'uuid', tenantId: 'uuid', ownerId: 'uuid', teamId: 'uuid', ...extra.attrs }),
});

// Entidades de configuração do tenant: sem dono, só "nenhum" ou "todos".
const config = (extra) => ({
  ownerField: null,
  teamField: null,
  scopes: ['none', 'tenant'],
  shareable: false,
  partitions: {},
  fields: [],
  ...extra,
  partitions: dict(extra.partitions || {}),
  attrs: dict({ id: 'uuid', tenantId: 'uuid', ...extra.attrs }),
});

export const ENTITIES = dict({
  contact: record({
    table: 'contacts',
    actions: ['read', 'create', 'update', 'delete', 'export', 'import', 'transfer', 'share'],
    shareable: true,
    attrs: { source: 'text', status: 'text' },
    fields: ['phone', 'email', 'document'],
  }),
  company: record({
    table: 'companies',
    actions: ['read', 'create', 'update', 'delete', 'export', 'import', 'transfer', 'share'],
    shareable: true,
    attrs: { status: 'text' },
    fields: ['document'],
  }),
  deal: record({
    table: 'deals',
    actions: ['read', 'create', 'update', 'delete', 'export', 'import', 'transfer', 'move', 'approve', 'share'],
    shareable: true,
    partitions: { pipelineId: 'pipelineId' },
    // status = 'open' | 'won' | 'lost' (denormalizado do tipo da etapa, para filtrar sem join)
    attrs: { pipelineId: 'uuid', stageId: 'uuid', value: 'numeric', status: 'text' },
    fields: ['value', 'items', 'discount'],
  }),
  conversation: record({
    table: 'conversations',
    ownerField: 'assigneeId', // o "responsável" da conversa é o atendente atribuído
    actions: ['read', 'send_message', 'note', 'transfer', 'resolve', 'supervise', 'export', 'delete'],
    partitions: { instanceId: 'instanceId' },
    attrs: { assigneeId: 'uuid', instanceId: 'uuid', status: 'text' },
    fields: ['phone'],
  }),
  proposal: record({
    table: 'proposals',
    actions: ['read', 'create', 'update', 'delete', 'send', 'approve'],
    attrs: { status: 'text', discountPct: 'numeric' },
    fields: ['discount'],
  }),
  task: record({
    table: 'tasks',
    actions: ['read', 'create', 'update', 'delete'],
    attrs: { status: 'text' },
  }),
  call: record({
    table: 'calls',
    actions: ['read', 'create', 'listen', 'export'],
    partitions: { instanceId: 'instanceId' },
    attrs: { instanceId: 'uuid', direction: 'text' },
  }),
  product: config({ table: 'products', actions: ['read', 'create', 'update', 'delete'] }),
  pipeline: config({ table: 'pipelines', actions: ['read', 'create', 'update', 'delete'] }),
  automation: config({ table: 'automations', actions: ['read', 'create', 'update', 'delete', 'publish'] }),
  instance: config({ table: 'instances', actions: ['read', 'create', 'update', 'delete', 'connect'] }),
  ai_agent: config({ table: 'ai_agents', actions: ['read', 'update'] }),
  report: config({ table: 'reports', actions: ['read', 'create', 'export'] }),
  user: config({ table: 'users', actions: ['read', 'create', 'update', 'delete'] }),
  role: config({ table: 'roles', actions: ['read', 'create', 'update', 'delete', 'assign'] }),
  tenant_settings: config({ table: 'tenant_settings', actions: ['read', 'update'] }),
  billing: config({ table: 'billing', actions: ['read', 'update'] }),
  audit_log: config({ table: 'audit_log', actions: ['read', 'export'] }),
  api_key: config({ table: 'api_keys', actions: ['read', 'create', 'delete'] }),
});

/**
 * Atributos que `update` NÃO pode alterar sozinho. Sem isto, quem tem `update` mexia em dono, etapa,
 * funil ou tenant por PATCH e anulava `transfer`, `move`, as negações e as partições (o motor só
 * olhava o registro ANTES da alteração).
 *  - IMMUTABLE: nunca mudam por PATCH.
 *  - CONTROLLED: só mudam se o usuário também puder a ação controladora (`transfer` para dono/equipe,
 *    `move` para etapa/status/funil).
 */
export const IMMUTABLE_ATTRS = ['id', 'tenantId', 'createdAt'];
export const CONTROLLED_ATTRS = { ownerId: 'transfer', assigneeId: 'transfer', teamId: 'transfer', stageId: 'move', status: 'move', pipelineId: 'move', instanceId: 'transfer' };

/** Chaves de partição conhecidas e a entidade que "é dona" da lista de valores. */
export const PARTITIONS = dict({
  pipelineId: { label: 'Pipelines', source: 'pipeline' },
  instanceId: { label: 'Instâncias de WhatsApp', source: 'instance' },
});

/** Operadores de condição. Todos devolvem booleano estrito (null nunca vira "desconhecido"). */
export const OPERATORS = ['eq', 'ne', 'in', 'nin', 'lt', 'lte', 'gt', 'gte', 'isNull', 'notNull'];

/** Referências ao usuário que condições podem usar em vez de um valor fixo. */
export const REFS = ['$user.id', '$user.teamIds'];

export const catalog = Object.freeze({ scopes: SCOPES, actions: ACTIONS, entities: ENTITIES, partitions: PARTITIONS });

/** snake_case de um atributo camelCase (ownerId -> owner_id) — nome da coluna no Postgres. */
export const columnOf = (attr) => attr.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
