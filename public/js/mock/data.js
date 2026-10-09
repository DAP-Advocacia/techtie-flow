// Dados fictícios do protótipo — fonte ÚNICA para todas as telas, então um
// contato/negócio/instância tem o mesmo id e os mesmos números em qualquer
// lugar. Formato espelha as entidades sugeridas em
// docs/design-handoff/README.md (multi-tenant: tudo pertence a um tenant).
// Valores monetários em reais (number), datas em epoch ms.

import { SYSTEM_ROLES, cloneRole } from '/shared/permissions/roles.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function createMockData(now = Date.now()) {
  const ago = (ms) => now - ms;

  const tenant = {
    id: 't_acme',
    name: 'Acme Ltda',
    // segment/teamSize/defaultPipelineId/onboarded: preenchidos pelo onboarding.
    // brand.domainStatus: 'verified' | 'pending' (verificação de CNAME em Configurações).
    segment: 'Tecnologia',
    teamSize: '2-10',
    defaultPipelineId: null,
    onboarded: true,
    // política de segurança do tenant (consumida pelo motor de permissões)
    policy: { requireMfaForSensitive: false },
    brand: { productName: 'TechTie Flow', domain: 'crm.acme.com.br', domainStatus: 'verified', accent: 'gold', logo: null },
  };

  // Perfis: os de fábrica (imutáveis, ver shared/permissions/roles.js) + perfis do tenant (clones editáveis).
  const roles = [
    ...SYSTEM_ROLES.map((r) => JSON.parse(JSON.stringify(r))),
    {
      ...cloneRole(SYSTEM_ROLES.find((r) => r.id === 'role_agent'), { id: 'role_t_jr_sdr', name: 'Atendente · só Vendas SDR', tenantId: 't_acme' }),
      description: 'Atendente restrito ao funil Vendas · SDR e ao número Comercial; não vê o valor dos negócios.',
      partitions: { pipelineId: ['p_sdr'], instanceId: ['i_comercial'] },
      fields: [{ entity: 'deal', field: 'value', access: 'hidden' }],
    },
  ];

  // status: 'active' | 'invited' | 'suspended'. mfa: autenticação em dois fatores ativa.
  const users = [
    { id: 'u_marina', tenantId: 't_acme', name: 'Marina Alves', email: 'marina@acme.com.br', roleIds: ['role_admin'], teamIds: ['tm_comercial'], status: 'active', mfa: true },
    { id: 'u_carla', tenantId: 't_acme', name: 'Carla Souza', email: 'carla@acme.com.br', roleIds: ['role_manager'], teamIds: ['tm_comercial'], status: 'active', mfa: true },
    { id: 'u_rafael', tenantId: 't_acme', name: 'Rafael Lima', email: 'rafael@acme.com.br', roleIds: ['role_sdr'], teamIds: ['tm_sdr'], status: 'active', mfa: false },
    { id: 'u_pedro', tenantId: 't_acme', name: 'Pedro Nunes', email: 'pedro@acme.com.br', roleIds: ['role_agent'], teamIds: ['tm_comercial'], status: 'active', mfa: false },
    { id: 'u_julia', tenantId: 't_acme', name: 'Júlia Ramos', email: 'julia@acme.com.br', roleIds: ['role_finance'], teamIds: [], status: 'active', mfa: true },
    { id: 'u_lucas', tenantId: 't_acme', name: 'Lucas Prado', email: 'lucas@acme.com.br', roleIds: ['role_viewer'], teamIds: ['tm_cs'], status: 'active', mfa: false },
    { id: 'u_bia', tenantId: 't_acme', name: 'Bia Martins', email: 'bia@acme.com.br', roleIds: ['role_agent'], teamIds: ['tm_cs'], status: 'invited', mfa: false },
    { id: 'u_ia', tenantId: 't_acme', name: 'Agente de IA', email: null, roleIds: [], teamIds: [], status: 'active', isBot: true },
  ];

  // Organograma: SDR é subequipe do Comercial (quem tem escopo "equipe e subequipes" no Comercial vê o SDR).
  const teams = [
    { id: 'tm_sdr', name: 'Equipe SDR', parentId: 'tm_comercial', members: 3, pipelineId: 'p_sdr' },
    { id: 'tm_comercial', name: 'Equipe Comercial', parentId: null, members: 4, pipelineId: 'p_comercial' },
    { id: 'tm_cs', name: 'Customer Success', parentId: null, members: 2, pipelineId: 'p_posvenda' },
  ];

  // `accent` é um token de cor CSS (var(--...)) ou hex — usado na borda da coluna.
  const pipelines = [
    {
      id: 'p_sdr',
      name: 'Vendas · SDR',
      teamId: 'tm_sdr',
      stages: [
        { id: 's_novo', name: 'Novo lead', accent: '#6e6353' },
        { id: 's_qualif', name: 'Qualificação', accent: 'var(--ins)' },
        { id: 's_reuniao', name: 'Reunião', accent: 'var(--acc)' },
        { id: 's_ganho_sdr', name: 'Ganho', accent: 'var(--green)', kind: 'won' },
      ],
    },
    {
      id: 'p_comercial',
      name: 'Comercial',
      teamId: 'tm_comercial',
      stages: [
        { id: 's_proposta', name: 'Proposta', accent: 'var(--acc)' },
        { id: 's_negoc', name: 'Negociação', accent: 'var(--acc)' },
        { id: 's_fechamento', name: 'Fechamento', accent: 'var(--green)', kind: 'won' },
        { id: 's_perdido', name: 'Perdido', accent: 'var(--red)', kind: 'lost' },
      ],
    },
    {
      id: 'p_posvenda',
      name: 'Pós-venda',
      teamId: 'tm_cs',
      stages: [
        { id: 's_onboarding', name: 'Onboarding', accent: 'var(--ins)' },
        { id: 's_ativo', name: 'Ativo', accent: 'var(--green)' },
        { id: 's_renovacao', name: 'Renovação', accent: 'var(--acc)' },
      ],
    },
  ];

  const products = [
    { id: 'pr_plano', name: 'TechTie Flow — plano Business', unit: 'usuário/mês', price: 190 },
    { id: 'pr_omie', name: 'Integração Omie', unit: 'projeto', price: 5000 },
    { id: 'pr_onboard', name: 'Onboarding e treinamento', unit: 'sessão', price: 1000 },
    { id: 'pr_bi', name: 'Dashboards de BI', unit: 'painel', price: 6000 },
    { id: 'pr_suporte', name: 'Suporte mensal', unit: 'mês', price: 500 },
  ];

  const contacts = [
    { id: 'c_carlos', name: 'Carlos Menezes', company: 'Menezes Engenharia', phone: '+55 11 98765-4321', email: 'carlos@menezes.eng.br', ownerId: 'u_marina', source: 'Landing page', tags: ['Quente', 'Integração ERP'] },
    { id: 'c_patricia', name: 'Patrícia Duarte', company: 'Duarte Odontologia', phone: '+55 21 99123-0099', email: 'patricia@duarteodonto.com', ownerId: 'u_rafael', source: 'Indicação', tags: ['Clínica'] },
    { id: 'c_aurora', name: 'Grupo Aurora', company: 'Aurora Distribuidora', phone: '+55 31 98877-1122', email: 'ti@aurora.com.br', ownerId: 'u_marina', source: 'Campanha', tags: ['Enterprise'] },
    { id: 'c_bruno', name: 'Bruno Tavares', company: 'Tavares & Filhos', phone: '+55 41 99555-7788', email: 'bruno@tavares.com', ownerId: 'u_rafael', source: 'Site', tags: [] },
    { id: 'c_lopes', name: 'Helena Lopes', company: 'Lopes Contábil', phone: '+55 11 97766-5544', email: 'helena@lopescontabil.com.br', ownerId: 'u_marina', source: 'Evento', tags: ['Contabilidade'] },
    { id: 'c_nina', name: 'Nina Prado', company: 'Prado Seguros', phone: '+55 11 97711-2233', email: 'nina@pradoseguros.com.br', ownerId: 'u_pedro', source: 'Indicação', tags: ['Seguros'] },
    { id: 'c_vieira', name: 'Otávio Vieira', company: 'Vieira Logística', phone: '+55 19 98123-4455', email: 'otavio@vieiralog.com.br', ownerId: 'u_rafael', source: 'Outbound', tags: ['Integração ERP'] },
  ];

  const deals = [
    { id: 'd1', title: 'Implantação CRM + WhatsApp', contactId: 'c_carlos', pipelineId: 'p_comercial', stageId: 's_proposta', value: 18400, ownerId: 'u_marina', createdAt: ago(3 * DAY), stageChangedAt: ago(4 * HOUR), lastMessage: 'Consegue me mandar a proposta hoje?',
      items: [
        { productId: 'pr_plano', name: 'TechTie Flow — plano Business', qty: 5, unitPrice: 190, note: '5 usuários × 12 meses', total: 11400 },
        { productId: 'pr_omie', name: 'Integração Omie', qty: 1, unitPrice: 5000, note: 'Projeto único', total: 5000 },
        { productId: 'pr_onboard', name: 'Onboarding e treinamento', qty: 2, unitPrice: 1000, note: '2 sessões', total: 2000 },
      ] },
    { id: 'd2', title: 'Agente de IA p/ agendamento', contactId: 'c_patricia', pipelineId: 'p_sdr', stageId: 's_qualif', value: 6900, ownerId: 'u_rafael', createdAt: ago(2 * HOUR), stageChangedAt: ago(2 * HOUR), lastMessage: 'Bom dia! Vi o vídeo de vocês', items: [] },
    { id: 'd3', title: 'Dashboards de BI', contactId: 'c_aurora', pipelineId: 'p_comercial', stageId: 's_negoc', value: 42000, ownerId: 'u_marina', createdAt: ago(9 * DAY), stageChangedAt: ago(1 * DAY), lastMessage: 'Vamos fechar na sexta, ok?',
      items: [
        { productId: 'pr_bi', name: 'Dashboards de BI', qty: 6, unitPrice: 6000, note: '6 painéis', total: 36000 },
        { productId: 'pr_suporte', name: 'Suporte mensal', qty: 12, unitPrice: 500, note: '12 meses', total: 6000 },
      ] },
    { id: 'd4', title: 'Site institucional', contactId: 'c_bruno', pipelineId: 'p_sdr', stageId: 's_novo', value: 4200, ownerId: 'u_rafael', createdAt: ago(1 * DAY), stageChangedAt: ago(1 * DAY), lastMessage: 'Obrigado pelo retorno!', items: [] },
    { id: 'd5', title: 'Automação de cobrança', contactId: 'c_lopes', pipelineId: 'p_sdr', stageId: 's_reuniao', value: 9800, ownerId: 'u_marina', createdAt: ago(5 * DAY), stageChangedAt: ago(3 * DAY), lastMessage: '', items: [] },
    { id: 'd7', title: 'Plataforma de atendimento', contactId: 'c_nina', pipelineId: 'p_comercial', stageId: 's_negoc', value: 27500, ownerId: 'u_pedro', createdAt: ago(6 * DAY), stageChangedAt: ago(2 * DAY), lastMessage: 'Pode ser na quinta?', items: [] },
    { id: 'd6', title: 'Integração Omie', contactId: 'c_vieira', pipelineId: 'p_comercial', stageId: 's_negoc', value: 12500, ownerId: 'u_rafael', createdAt: ago(12 * DAY), stageChangedAt: ago(5 * DAY), lastMessage: '', items: [] },
  ];

  // status: 'open' (com alguém) | 'queue' (sem responsável) | 'resolved'
  const conversations = [
    { id: 'cv1', contactId: 'c_carlos', instanceId: 'i_comercial', assigneeId: 'u_marina', status: 'open', unread: 2, dealId: 'd1', lastMessageAt: ago(18 * MIN) },
    { id: 'cv2', contactId: 'c_patricia', instanceId: 'i_comercial', assigneeId: 'u_rafael', status: 'open', unread: 1, dealId: 'd2', lastMessageAt: ago(62 * MIN) },
    { id: 'cv3', contactId: 'c_aurora', instanceId: 'i_comercial', assigneeId: 'u_marina', status: 'open', unread: 0, dealId: 'd3', lastMessageAt: ago(26 * HOUR) },
    { id: 'cv4', contactId: 'c_bruno', instanceId: 'i_suporte', assigneeId: null, status: 'queue', unread: 0, dealId: 'd4', lastMessageAt: ago(27 * HOUR) },
    { id: 'cv6', contactId: 'c_nina', instanceId: 'i_comercial', assigneeId: 'u_pedro', status: 'open', unread: 1, dealId: 'd7', lastMessageAt: ago(95 * MIN) },
    { id: 'cv5', contactId: 'c_lopes', instanceId: 'i_comercial', assigneeId: null, status: 'queue', unread: 3, dealId: 'd5', lastMessageAt: ago(40 * MIN) },
  ];

  // type: 'in' | 'out' | 'note' (nota interna, só a equipe vê) | 'ai_insight' (sugestão da IA)
  //       | 'system' (evento de conversa: transferência, resolução, reabertura — escrito pelo Inbox)
  // ai_insight: `text` = análise interna; `reply` = texto pronto para mandar ao lead ("Usar resposta");
  //             `followUp: true` quando virou follow-up.
  // out: `status` 'sent' | 'delivered' (✓ / ✓✓).
  const messages = {
    cv1: [
      { id: 'm1', type: 'in', text: 'Olá! Vi que vocês fazem integração com ERP. Como funciona?', at: ago(81 * MIN) },
      { id: 'm2', type: 'out', text: 'Oi, Carlos! Integramos via API e fazemos o mapeamento dos campos com vocês. Qual ERP usam?', at: ago(78 * MIN), authorId: 'u_marina' },
      { id: 'm3', type: 'in', text: 'Usamos o Omie. Consegue me mandar a proposta hoje?', at: ago(60 * MIN) },
      { id: 'm4', type: 'ai_insight', topic: 'Intenção de compra', text: 'Lead com alta intenção. Sugestão: confirmar escopo (CRM + WhatsApp + Omie) e enviar proposta ainda hoje.', reply: 'Perfeito, Carlos! Vou fechar o escopo (CRM + WhatsApp + integração com o Omie) e te envio a proposta ainda hoje. Pode ser?', at: ago(59 * MIN) },
      { id: 'm5', type: 'note', text: 'Desconto de até 8% autorizado pela Marina se fechar esta semana.', at: ago(55 * MIN), authorId: 'u_marina' },
    ],
    cv2: [
      { id: 'm6', type: 'in', text: 'Bom dia! Vi o vídeo de vocês e fiquei interessada no agente para agendamento.', at: ago(62 * MIN) },
    ],
    cv3: [
      { id: 'm7', type: 'out', text: 'Enviei o contrato revisado por e-mail, Grupo Aurora.', at: ago(27 * HOUR), authorId: 'u_marina' },
      { id: 'm8', type: 'in', text: 'Vamos fechar na sexta, ok?', at: ago(26 * HOUR) },
    ],
    cv4: [
      { id: 'm9', type: 'out', text: 'Oi, Bruno! Retornando sobre o site institucional.', at: ago(28 * HOUR), authorId: 'u_rafael' },
      { id: 'm10', type: 'in', text: 'Obrigado pelo retorno!', at: ago(27 * HOUR) },
    ],
    cv6: [
      { id: 'm13', type: 'out', text: 'Oi, Nina! Conseguiu avaliar a proposta?', at: ago(110 * MIN), authorId: 'u_pedro' },
      { id: 'm14', type: 'in', text: 'Pode ser na quinta?', at: ago(95 * MIN) },
    ],
    cv5: [
      { id: 'm11', type: 'in', text: 'Boa tarde, quero entender como funciona a automação de cobrança.', at: ago(44 * MIN) },
      { id: 'm12', type: 'in', text: 'Vocês integram com boleto?', at: ago(40 * MIN) },
    ],
  };

  const timeline = {
    c_carlos: [
      { text: 'Negócio movido para Proposta', who: 'Marina', at: ago(7 * HOUR) },
      { text: 'Reunião de descoberta', who: '', at: ago(1 * DAY + 2 * HOUR) },
      { text: 'Lead criado via formulário', who: '', at: ago(3 * DAY) },
    ],
    c_patricia: [{ text: 'Primeira mensagem recebida', who: '', at: ago(62 * MIN) }],
    c_aurora: [{ text: 'Contrato enviado', who: 'Marina', at: ago(1 * DAY) }],
    c_bruno: [{ text: 'Lead criado', who: '', at: ago(1 * DAY) }],
    c_lopes: [{ text: 'Primeira mensagem recebida', who: '', at: ago(44 * MIN) }],
    c_nina: [{ text: 'Proposta enviada', who: 'Pedro', at: ago(2 * DAY) }],
    c_vieira: [{ text: 'Lead criado (outbound)', who: 'Rafael', at: ago(12 * DAY) }],
  };

  // status: 'connected' | 'disconnected' | 'queued' | 'connecting'
  // channel: 'baileys' (QR, risco de ban) | 'cloud_api' (oficial, Embedded Signup)
  const instances = [
    { id: 'i_comercial', name: 'Comercial', phone: '+55 11 4000-1010', ownerName: 'Marina Alves', channel: 'baileys', status: 'connected', conversations: 312, messagesToday: 1480, aiActive: true },
    { id: 'i_suporte', name: 'Suporte', phone: '+55 11 4000-2020', ownerName: 'Rafael Lima', channel: 'cloud_api', status: 'connected', conversations: 188, messagesToday: 960, aiActive: false },
    { id: 'i_posvenda', name: 'Pós-venda', phone: '+55 11 4000-3030', ownerName: 'Equipe CS', channel: 'baileys', status: 'disconnected', conversations: 74, messagesToday: 0, aiActive: false },
  ];

  const agent = {
    instanceId: 'i_comercial',
    enabled: true,
    prompt:
      'Você é a assistente virtual da Acme. Responda de forma cordial e objetiva, em português. Qualifique o lead (necessidade, prazo, orçamento) antes de oferecer proposta. Nunca invente preços: consulte a base de conhecimento.',
    handoffRules: ['Lead pede para falar com uma pessoa', 'Negociação de desconto acima de 5%', 'Confiança da resposta abaixo de 70%'],
    knowledgeDocs: [
      { id: 'k1', name: 'Catálogo de Integrações.pdf', chunks: 42, status: 'ready' },
      { id: 'k2', name: 'Tabela de preços 2026.xlsx', chunks: 18, status: 'ready' },
      { id: 'k3', name: 'FAQ comercial.docx', chunks: null, status: 'processing' },
    ],
    testChat: [
      { from: 'lead', text: 'Vocês fazem integração com ERP?' },
      { from: 'ai', text: 'Fazemos sim! Integramos via API com os principais ERPs. Qual sistema vocês usam hoje?', source: 'Catálogo de Integrações.pdf' },
    ],
  };

  // Nó: { id, kind: 'trigger'|'condition'|'action', title, desc }
  const automations = [
    {
      id: 'a1', name: 'Boas-vindas a novo lead', status: 'active', runs: 1200,
      nodes: [
        { id: 'n1', kind: 'trigger', title: 'Nova mensagem', desc: 'Contato novo na instância Comercial' },
        { id: 'n2', kind: 'condition', title: 'Horário comercial?', desc: 'Seg–Sex, 08h–18h' },
        { id: 'n3', kind: 'action', title: 'Agente de IA responde', desc: 'Qualifica o lead' },
        { id: 'n4', kind: 'action', title: 'Criar negócio', desc: 'Pipeline Vendas · SDR → Novo lead' },
      ],
    },
    {
      id: 'a2', name: 'Follow-up 24h sem resposta', status: 'active', runs: 340,
      nodes: [
        { id: 'n1', kind: 'trigger', title: 'Sem resposta do lead', desc: 'Há 24h após nossa última mensagem' },
        { id: 'n2', kind: 'condition', title: 'Negócio aberto?', desc: 'Etapa diferente de Ganho/Perdido' },
        { id: 'n3', kind: 'action', title: 'Enviar mensagem', desc: 'Modelo: Follow-up gentil' },
      ],
    },
    {
      id: 'a3', name: 'Proposta enviada → lembrete', status: 'draft', runs: 0,
      nodes: [
        { id: 'n1', kind: 'trigger', title: 'Negócio movido', desc: 'Para a etapa Proposta' },
        { id: 'n2', kind: 'action', title: 'Criar tarefa', desc: 'Lembrar o responsável em 2 dias' },
      ],
    },
  ];

  const dashboard = {
    // um conjunto por período — a tela troca entre eles
    periods: {
      today: { label: 'Hoje', kpis: { leads: 46, active: 236, conversion: 17.2, revenue: 18400 }, deltas: { leads: 8, active: 4, conversion: -0.6, revenue: 12 } },
      week: { label: '7 dias', kpis: { leads: 318, active: 236, conversion: 18.0, revenue: 74200 }, deltas: { leads: 10, active: 4, conversion: -0.4, revenue: 17 } },
      month: { label: '30 dias', kpis: { leads: 1284, active: 236, conversion: 18.4, revenue: 312000 }, deltas: { leads: 12, active: 4, conversion: -1.2, revenue: 21 } },
    },
    conversationsPerDay: [40, 62, 55, 78, 70, 90, 48, 66, 84, 72, 95, 60],
    funnel: [
      { name: 'Novo lead', n: 1284 },
      { name: 'Qualificado', n: 742 },
      { name: 'Proposta', n: 361 },
      { name: 'Negociação', n: 212 },
      { name: 'Ganho', n: 236 },
    ],
    team: [
      { name: 'Marina Alves', conversations: 148, firstResponse: '2m 10s', won: 31, revenue: 142000 },
      { name: 'Rafael Lima', conversations: 121, firstResponse: '3m 02s', won: 24, revenue: 98000 },
      { name: 'Agente de IA', conversations: 402, firstResponse: '8s', won: 12, revenue: 72000 },
    ],
  };

  const messageTemplates = [
    { id: 'mt1', name: 'Enviar proposta', text: 'Olá! Segue a proposta conforme conversamos. Qualquer dúvida, estou à disposição.' },
    { id: 'mt2', name: 'Follow-up gentil', text: 'Oi! Passando para saber se conseguiu analisar nossa proposta. Posso ajudar em algo?' },
    { id: 'mt3', name: 'Agendar reunião', text: 'Podemos marcar uma conversa rápida de 20 minutos? Me diga o melhor horário.' },
  ];

  // Log de auditoria (mais recente primeiro). Eventos de permissão seguem o formato de shared/permissions/validate.js (auditEvent).
  const auditLog = [
    { id: 'ev3', at: ago(3 * HOUR), actorId: 'u_marina', action: 'role.assign', target: 'u_pedro', detail: 'Perfil Atendente atribuído a Pedro Nunes' },
    { id: 'ev2', at: ago(1 * DAY), actorId: 'u_marina', action: 'role.create', target: 'role_t_jr_sdr', detail: 'Perfil "Atendente · só Vendas SDR" criado a partir de Atendente' },
    { id: 'ev1', at: ago(2 * DAY), actorId: 'u_marina', action: 'user.invite', target: 'u_bia', detail: 'Convite enviado a bia@acme.com.br' },
  ];

  return {
    auditLog, tenant, roles, users, teams, pipelines, products, contacts, deals,
    conversations, messages, timeline, instances, agent, automations, dashboard, messageTemplates,
    // usuário logado no protótipo
    currentUserId: 'u_marina',
  };
}
