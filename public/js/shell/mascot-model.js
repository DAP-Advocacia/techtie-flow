// Mascote "Flow" — fase 1: falas prontas, sem chamar IA. Lógica pura (testada em Node); a tela é fina.
// Humores: happy | think | wow | confused | sleep | love | laugh | sad (cada um vira uma expressão no desenho).
// O bate-papo é por palavras-chave (sem IA): reage e responde só o que sabe; o resto ele admite que não entendeu.

export const MASCOT_NAME = 'Flow';

/** Dicas por tela: { mood, text }. Telas sem dica usam `fallback`. */
const TIPS = {
  home: [
    { mood: 'happy', text: 'Este é o seu ponto de partida: os atalhos levam direto ao que você mais usa.' },
    { mood: 'wow', text: 'Aperte Ctrl+K em qualquer tela para buscar contatos, negócios e telas.' },
  ],
  inbox: [
    { mood: 'happy', text: 'As conversas ficam aqui. Dá para transferir para outra pessoa e deixar notas internas.' },
    { mood: 'think', text: 'Nota interna não vai para o cliente: use para combinar o próximo passo com a equipe.' },
  ],
  pipeline: [
    { mood: 'wow', text: 'Arraste um negócio entre as etapas para avançar o funil.' },
    { mood: 'think', text: 'Negócio parado há muito tempo? Abra e registre a próxima ação ou crie uma tarefa.' },
  ],
  contacts: [
    { mood: 'happy', text: 'Você pode importar e exportar contatos em CSV pelo botão no topo da lista.' },
    { mood: 'think', text: 'Antes de cadastrar, busque pelo nome ou telefone para não duplicar.' },
  ],
  deal: [{ mood: 'happy', text: 'Aqui está o negócio inteiro: etapas, histórico e tarefas. Marque Ganho ou Perdido ao concluir.' }],
  tasks: [{ mood: 'wow', text: 'Tarefas com prazo aparecem primeiro. Concluir uma limpa a sua fila!' }],
  dashboard: [{ mood: 'think', text: 'Estes números vêm dos seus dados reais. Se algo parecer estranho, confira os filtros.' }],
  automations: [{ mood: 'confused', text: 'Por enquanto esta tela é só uma pré-visualização: as automações ainda não rodam no servidor.' }],
  agent: [{ mood: 'think', text: 'O agente de IA responde clientes. Revise as instruções com calma: elas definem o tom das respostas.' }],
  funnels: [{ mood: 'happy', text: 'Cada funil tem as suas etapas. Dá para criar quantos precisar.' }],
  instances: [{ mood: 'think', text: 'Cada instância é um número de WhatsApp conectado. Leia o QR code com o celular para conectar.' }],
  users: [{ mood: 'happy', text: 'Convide pessoas por aqui e defina o perfil de cada uma.' }],
  permissions: [{ mood: 'think', text: 'Mudar um perfil afeta todo mundo que o usa. Veja a aba de auditoria depois.' }],
  settings: [{ mood: 'happy', text: 'Marca, cor de destaque e preferências da empresa ficam aqui.' }],
  profile: [{ mood: 'happy', text: 'Este é o seu perfil. Mantenha o nome e a foto em dia para a equipe te reconhecer.' }],
};

const FALLBACK = [{ mood: 'happy', text: 'Estou por aqui! Clique em mim quando quiser uma dica.' }];

export function tipsFor(routeId) {
  return TIPS[routeId] || FALLBACK;
}

/** Saudação conforme a hora (0-23). */
export function greeting(hour, firstName) {
  const part = hour < 5 ? 'Boa madrugada' : hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';
  return firstName ? `${part}, ${firstName}!` : `${part}!`;
}

/** Humor do cantinho fechado: dorme de madrugada, senão feliz. */
export function idleMood(hour) {
  return hour < 5 ? 'sleep' : 'happy';
}

/** Próxima dica em rodízio; `i` é o contador atual. */
export function nextTip(routeId, i) {
  const list = tipsFor(routeId);
  return list[((i % list.length) + list.length) % list.length];
}

/** Minúsculas e sem acento, para casar palavras-chave. */
export function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/** Direção do olhar: do centro do mascote (cx, cy) até o cursor (mx, my), limitada a [-1, 1] em cada eixo. */
export function lookVector(cx, cy, mx, my, reach = 260) {
  const clamp = (v) => Math.max(-1, Math.min(1, v));
  return { x: clamp((mx - cx) / reach), y: clamp((my - cy) / reach) };
}

const JOKES = [
  'Por que o CRM foi ao psicólogo? Porque tinha muitos contatos mal resolvidos.',
  'O que o lead disse para o funil? "Calma, estou só passando de etapa!"',
  'Reunião que poderia ter sido um e-mail: a maior vilã da produtividade.',
];

/** Assunto citado -> tela cujas dicas respondem (as dicas dela já são curtas e certas). */
const TOPICS = [
  [/\b(tarefa|prazo|lembrete)/, 'tasks'],
  [/\b(negocio|funil|pipeline|etapa|kanban)/, 'pipeline'],
  [/\b(csv|importar|exportar)/, 'contacts'],
  [/\b(contato|cliente|lead)/, 'contacts'],
  [/\b(conversa|whatsapp|mensagem|inbox)/, 'inbox'],
  [/\b(automac|robo)/, 'automations'],
  [/\b(dashboard|numero|relatorio|grafico)/, 'dashboard'],
  [/\b(agente|ia)\b/, 'agent'],
  [/\b(permiss|perfil de acesso|acesso)/, 'permissions'],
  [/\b(instancia|qr)/, 'instances'],
];

const INTENTS = [
  { re: /\b(nao gostei|feio|odeio|chato|horrivel|burro|inutil|pessimo)\b/, mood: 'sad', text: () => 'Poxa... vou tentar melhorar. Me diz o que não ajudou?' },
  { re: /\b(kkk+|haha+|hehe+|rs ?rs+)/, mood: 'laugh', text: () => 'Hehe! Adoro quando a conversa fica leve.' },
  { re: /\b(obrigad[oa]|valeu|brigad[oa]|thanks)/, mood: 'love', text: () => 'Imagina! Fico muito feliz em ajudar.' },
  { re: /\b(parabens|legal|lindo|fofo|bonito|gostei|amei|incrivel|show)/, mood: 'love', text: () => 'Aaah, obrigado! Você também é demais.' },
  { re: /\b(piada|engracad|me faz rir|conta algo)/, mood: 'laugh', text: ({ n }) => JOKES[n % JOKES.length] },
  { re: /\b(tchau|ate mais|ate logo|flw|falou)\b/, mood: 'happy', text: () => 'Até mais! Se precisar, é só me chamar aqui no cantinho.' },
  {
    re: /\b(quem e voce|quem eh voce|seu nome|como se chama|o que voce faz|o que voce sabe|pra que serve)/,
    mood: 'happy',
    text: () => `Sou o ${MASCOT_NAME}, o mascote do TechTie Flow! Por enquanto dou dicas sobre as telas e converso um pouquinho. Em breve vou entender pedidos em português e executar comandos.`,
  },
  { re: /\b(oi|ola|opa|hey|hello|e ai|bom dia|boa tarde|boa noite)\b/, mood: 'happy', text: () => 'Oi! Tudo bem? Posso dar uma dica desta tela, contar uma piada ou explicar o que eu faço.' },
];

/** Resposta do mascote a uma mensagem: { mood, text }. `n` rotaciona as variações (piadas). */
export function reply(text, { routeId, n = 0 } = {}) {
  const t = norm(text);
  for (const it of INTENTS) if (it.re.test(t)) return { mood: it.mood, text: it.text({ n }) };
  if (/\b(dica|ajuda|ajudar|socorro|help|como (eu )?(uso|faco|funciona))/.test(t)) {
    const tip = nextTip(routeId, n);
    return { mood: tip.mood, text: tip.text };
  }
  for (const [re, screen] of TOPICS) {
    if (re.test(t)) {
      const tip = nextTip(screen, n);
      return { mood: tip.mood, text: tip.text };
    }
  }
  return { mood: 'confused', text: 'Hmm, essa eu ainda não entendi. Por enquanto sei dar dicas das telas, contar piadas e bater papo. Tente "dica" ou "piada"!' };
}
