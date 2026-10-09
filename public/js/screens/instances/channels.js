// Constantes e helpers puros da tela de Instâncias: textos dos canais,
// metadados de status, ícones locais e validações. Sem estado próprio.
import { h, icon } from '../../ui.js';

/** Paths de ícone (24px, traço) usados só nesta tela. */
export const ICON = {
  qr: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h3v3h-3zM20 14v3M14 20h3M20 20v1',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM9 12l2 2 4-4',
  check: 'M5 12l5 5L20 7',
  x: 'M6 6l12 12M18 6L6 18',
  warn: 'M12 3l10 18H2zM12 10v5M12 18h.01',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  plus: 'M12 5v14M5 12h14',
  back: 'M15 6l-6 6 6 6',
};

/**
 * Textos dos dois canais. Honestos de propósito: o cliente decide com os
 * custos e riscos reais na mesa (ver docs/whatsapp-gateway-licoes-herdadas.md).
 */
export const CHANNELS = {
  baileys: {
    label: 'WhatsApp não-oficial (QR)',
    short: 'Não-oficial · QR',
    icon: ICON.qr,
    tag: 'Grátis',
    help: 'Conecta lendo um QR Code, sem custo por mensagem. Como é não-oficial (Baileys), o WhatsApp pode restringir ou banir o número do cliente a qualquer momento.',
    pros: ['Grátis: sem custo por mensagem', 'Conecta em minutos lendo um QR Code', 'Usa o número que o cliente já tem'],
    cons: ['Não-oficial: o WhatsApp pode restringir ou banir o número', 'Pode cair se o celular ficar offline ou outro aparelho assumir a sessão', 'Sem templates oficiais nem selo de conta verificada'],
    risk: 'Risco de banimento: o WhatsApp pode bloquear o número do cliente a qualquer momento, sem aviso. Não dá para eliminar esse risco no sistema, só reduzi-lo (por exemplo, evitando disparos em massa).',
  },
  cloud_api: {
    label: 'API oficial (Meta)',
    short: 'API oficial · Meta',
    icon: ICON.shield,
    tag: 'Cobrança por mensagem',
    help: 'API oficial da Meta (Cloud API): sem risco de banimento por automação. A Meta cobra por mensagem entregue e o login é feito com a conta Meta Business.',
    pros: ['Oficial: sem risco de banimento por usar o CRM', 'Estável e feita para volume e várias pessoas atendendo', 'Templates aprovados e selo de conta verificada (opcional)'],
    cons: ['Cobrança por mensagem entregue, direto pela Meta', 'Exige conta Meta Business e verificação da empresa', 'O número costuma ficar dedicado à API; fora da janela de 24h só com templates aprovados'],
    risk: null,
  },
};

/** Status do cartão: rótulo + classe de cor (verde/vermelho/champagne). */
export const STATUS = {
  connected: { label: 'Conectada', cls: 'status--ok' },
  disconnected: { label: 'Desconectada', cls: 'status--err' },
  queued: { label: 'Aguardando vaga na fila', cls: 'status--warn', busy: true },
  connecting: { label: 'Conectando', cls: 'status--warn', busy: true },
  attention: { label: 'Precisa de atenção', cls: 'status--warn' },
};
export const statusMeta = (s) => STATUS[s] || STATUS.disconnected;

/** Motivos de "precisa de atenção": só ação manual, sem loop de reconexão. */
export const ATTENTION = {
  forbidden: {
    title: 'Número restrito pelo WhatsApp (403)',
    text: 'A reconexão automática foi pausada: insistir prolonga o bloqueio. Aguarde o fim da restrição ou, se o número foi banido, remova esta instância.',
  },
  connectionReplaced: {
    title: 'Sessão substituída por outro aparelho (440)',
    text: 'Outro dispositivo assumiu esta sessão. Reconecte somente se você controla o número.',
  },
  badSession: {
    title: 'Sessão corrompida (500)',
    text: 'As credenciais salvas não são mais válidas. É preciso ler um novo QR Code.',
  },
};

/** Números fictícios que a Meta "devolve" no Embedded Signup simulado. */
export const META_NUMBERS = [
  { phone: '+55 11 3004-7788', label: 'Acme Atendimento', verified: true },
  { phone: '+55 11 3004-7790', label: 'Acme Vendas', verified: true },
  { phone: '+55 21 4004-1122', label: 'Acme Rio', verified: false },
];

/**
 * Selo do canal com ajuda. A explicação aparece em hover E foco (o selo é um
 * <button> só para ser alcançável por teclado) e fica ligada por aria-describedby.
 */
let tipSeq = 0;
export function channelBadge(channelKey) {
  const c = CHANNELS[channelKey] || CHANNELS.baileys;
  const id = `instances-tip-${++tipSeq}`;
  return h(
    'span',
    { class: 'instances-tip' },
    h('button', { type: 'button', class: 'chip instances-chip', 'aria-describedby': id }, icon(c.icon, 14), h('span', null, c.label), h('span', { class: 'instances-chip__q', 'aria-hidden': 'true' }, '?')),
    h('span', { class: 'instances-tip__pop', role: 'tooltip', id }, c.help)
  );
}

// ---- validações e geradores ----

/** Limite único: o maxlength dos inputs e a validação usam o mesmo valor. */
export const NAME_MAX = 30;

/** Devolve a mensagem de erro do nome (ou '' se válido). */
export function nameError(name, instances, exceptId = null) {
  const n = String(name || '').trim();
  if (!n) return 'Dê um nome à instância.';
  if (n.length < 2) return 'Use pelo menos 2 caracteres.';
  if (n.length > NAME_MAX) return `Use no máximo ${NAME_MAX} caracteres.`;
  const dup = instances.some((i) => i.id !== exceptId && i.name.trim().toLowerCase() === n.toLowerCase());
  return dup ? 'Já existe uma instância com esse nome.' : '';
}

/** Opções do select de responsável: pessoas, equipes e o valor atual (se for outro). */
export function ownerOptions(state, current = '') {
  const names = [...state.users.filter((u) => !u.isBot).map((u) => u.name), ...state.teams.map((t) => t.name)];
  if (current && !names.includes(current)) names.push(current);
  return [...new Set(names)];
}

function hash(str) {
  let x = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    x ^= str.charCodeAt(i);
    x = Math.imul(x, 16777619);
  }
  return x >>> 0;
}

/** Telefone fictício determinístico a partir do nome (sem colidir com os existentes). */
export function generatePhone(name, instances) {
  const taken = new Set(instances.map((i) => i.phone));
  const ddds = ['11', '21', '31', '41', '19'];
  for (let salt = 0; salt < 50; salt++) {
    const n = hash(`${name}:${salt}`);
    const a = String(1000 + (n % 9000));
    const b = String(1000 + (Math.floor(n / 9000) % 9000));
    const phone = `+55 ${ddds[n % ddds.length]} 9${a}-${b}`;
    if (!taken.has(phone)) return phone;
  }
  return '+55 11 90000-0000';
}
