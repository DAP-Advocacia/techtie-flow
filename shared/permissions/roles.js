// Perfis de fábrica (modelos). São DADOS, no mesmo formato que o tenant usa para
// criar perfis próprios: um perfil personalizado é um clone deste objeto com
// ajustes. Perfis de sistema são imutáveis (validate.js) — para mudar, clone.
//
// Formato do perfil:
//   {
//     id, tenantId (null = sistema), name, description, system,
//     grants:  [{ entity|'*', actions:[…]|['*'], scope, conditions?, approval?:{when:[…]} }],
//     denies:  [{ entity|'*', actions:[…]|['*'], conditions? }],   // vencem tudo
//     partitions: { pipelineId?: 'all'|[ids], instanceId?: 'all'|[ids] },
//     fields:  [{ entity, field, access:'hidden'|'readonly' }],    // restrições (vencem)
//   }
const g = (entity, actions, scope, extra = {}) => ({ entity, actions, scope, ...extra });

const CRM = ['contact', 'company', 'deal', 'proposal', 'task', 'call', 'conversation'];

export const SYSTEM_ROLES = [
  {
    id: 'role_admin',
    name: 'Admin',
    description: 'Tudo, incluindo faturamento, usuários e perfis.',
    grants: [g('*', ['*'], 'tenant')],
    denies: [],
    partitions: {},
    fields: [],
  },
  {
    id: 'role_manager',
    name: 'Gestor',
    description: 'Vê e gerencia toda a sua equipe (e subequipes), relatórios e aprova descontos até 15%.',
    grants: [
      g('contact', ['read', 'create', 'update', 'delete', 'export', 'import', 'transfer'], 'team_tree'),
      g('company', ['read', 'create', 'update', 'delete', 'export', 'import', 'transfer'], 'team_tree'),
      g('deal', ['read', 'create', 'update', 'delete', 'export', 'import', 'transfer', 'move'], 'team_tree'),
      g('deal', ['approve'], 'team_tree', { conditions: [{ field: 'ctx.discountPct', op: 'lte', value: 15 }] }),
      g('proposal', ['read', 'create', 'update', 'delete', 'send'], 'team_tree'),
      g('proposal', ['approve'], 'team_tree', { conditions: [{ field: 'ctx.discountPct', op: 'lte', value: 15 }] }),
      g('task', ['read', 'create', 'update', 'delete'], 'team_tree'),
      g('call', ['read', 'create', 'listen', 'export'], 'team_tree'),
      g('conversation', ['read', 'send_message', 'note', 'transfer', 'resolve', 'supervise', 'export'], 'team_tree'),
      // fila: conversa sem responsável é de todos que atendem
      g('conversation', ['read', 'send_message', 'note', 'transfer', 'resolve'], 'tenant', { conditions: [{ field: 'assigneeId', op: 'isNull' }] }),
      g('report', ['read', 'create', 'export'], 'tenant'),
      g('product', ['read', 'create', 'update'], 'tenant'),
      g('pipeline', ['read', 'update'], 'tenant'),
      g('automation', ['read', 'create', 'update'], 'tenant'),
      g('instance', ['read'], 'tenant'),
      g('ai_agent', ['read'], 'tenant'),
      g('user', ['read'], 'tenant'),
      g('role', ['read'], 'tenant'),
      g('contact', ['share'], 'team_tree'),
      g('deal', ['share'], 'team_tree'),
    ],
    // Segregação de funções: quem pediu a aprovação não a concede. Se o servidor esquecer de informar
    // `requesterId`, o contexto é desconhecido e a negação VALE (falha fechado).
    denies: [{ entity: '*', actions: ['approve'], conditions: [{ field: 'ctx.requesterId', op: 'eq', ref: '$user.id' }] }],
    partitions: {},
    fields: [],
  },
  {
    id: 'role_agent',
    name: 'Atendente',
    description: 'Só os próprios negócios e conversas (mais a fila de atendimento).',
    grants: [
      g('contact', ['read', 'create', 'update'], 'team'),
      g('company', ['read', 'create', 'update'], 'team'),
      g('deal', ['read', 'create', 'update', 'move', 'share'], 'own'),
      g('proposal', ['read'], 'own'),
      // desconto acima de 5% exige aprovação em QUALQUER caminho (criar, enviar, alterar) — antes só o update
      // pedia, e o atendente criava/enviava proposta com 40% sem aprovação.
      g('proposal', ['create', 'send'], 'own', { approval: { when: [{ field: 'ctx.discountPct', op: 'gt', value: 5 }] } }),
      // desconto acima de 5% só com aprovação de um gestor
      g('proposal', ['update'], 'own', { approval: { when: [{ field: 'ctx.discountPct', op: 'gt', value: 5 }] } }),
      g('task', ['read', 'create', 'update'], 'own'),
      g('call', ['read', 'create'], 'own'),
      g('conversation', ['read', 'send_message', 'note', 'transfer', 'resolve'], 'own'),
      g('conversation', ['read', 'send_message', 'note', 'transfer', 'resolve'], 'tenant', { conditions: [{ field: 'assigneeId', op: 'isNull' }] }),
      g('product', ['read'], 'tenant'),
      g('pipeline', ['read'], 'tenant'),
      g('instance', ['read'], 'tenant'),
    ],
    denies: [],
    partitions: {},
    fields: [],
  },
  {
    id: 'role_sdr',
    name: 'SDR',
    description: 'Qualifica leads; não move negócios para Ganho/Perdido (isso é do comercial).',
    grants: [
      g('contact', ['read', 'create', 'update'], 'team'),
      g('company', ['read', 'create', 'update'], 'team'),
      g('deal', ['read', 'create', 'update', 'move'], 'own'),
      g('task', ['read', 'create', 'update'], 'own'),
      g('conversation', ['read', 'send_message', 'note', 'transfer', 'resolve'], 'own'),
      g('conversation', ['read', 'send_message', 'note', 'transfer', 'resolve'], 'tenant', { conditions: [{ field: 'assigneeId', op: 'isNull' }] }),
      g('product', ['read'], 'tenant'),
      g('pipeline', ['read'], 'tenant'),
      g('instance', ['read'], 'tenant'),
    ],
    denies: [{ entity: 'deal', actions: ['move'], conditions: [{ field: 'ctx.toStageKind', op: 'in', value: ['won', 'lost'] }] }],
    partitions: {},
    fields: [],
  },
  {
    id: 'role_finance',
    name: 'Financeiro',
    description: 'Faturamento, propostas e relatórios; não atende conversas.',
    grants: [
      g('deal', ['read', 'export'], 'tenant'),
      g('proposal', ['read'], 'tenant'),
      g('contact', ['read'], 'tenant'),
      g('company', ['read'], 'tenant'),
      g('report', ['read', 'export'], 'tenant'),
      g('billing', ['read', 'update'], 'tenant'),
      g('product', ['read', 'create', 'update'], 'tenant'),
    ],
    denies: [],
    partitions: {},
    fields: [{ entity: 'contact', field: 'phone', access: 'hidden' }],
  },
  {
    id: 'role_viewer',
    name: 'Somente leitura',
    description: 'Consulta dados, sem alterar nem exportar nada.',
    grants: [...CRM.filter((e) => e !== 'call').map((e) => g(e, ['read'], 'tenant')), g('report', ['read'], 'tenant'), g('pipeline', ['read'], 'tenant')],
    denies: [{ entity: '*', actions: ['export'] }],
    partitions: {},
    fields: [],
  },
].map((r) => ({ tenantId: null, system: true, ...r }));

// CORREÇÃO: os perfis de sistema são UM objeto compartilhado por TODOS os tenants
// (systemRoleMap devolve as mesmas referências). Qualquer código que mutasse
// ctx.roles.get('role_admin').grants/denies mudaria as permissões de todos os
// tenants até o processo reiniciar. Congelados em profundidade: mutar lança TypeError
// (módulos ESM são strict); para customizar, use cloneRole().
const deepFreeze = (o) => {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
};
deepFreeze(SYSTEM_ROLES);

/** Mapa id -> perfil de sistema (para montar o contexto do motor). */
export const systemRoleMap = () => new Map(SYSTEM_ROLES.map((r) => [r.id, r]));

/** Clona um perfil como perfil do tenant (editável). */
export function cloneRole(role, { id, name, tenantId }) {
  const copy = JSON.parse(JSON.stringify(role));
  return { ...copy, id, name, tenantId, system: false };
}
