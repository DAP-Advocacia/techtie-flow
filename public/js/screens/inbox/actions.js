// Regras de negócio da Inbox: seleção/ordenação da lista e mutações de
// conversa. Tudo que muda dado passa por store.update, para sidebar (badge de
// não lidas) e outras telas enxergarem na hora.
//
// Permissões: a lista parte SEMPRE de visibleConvs() (o que o motor deixa ler) e
// cada mutação reconfere com o motor antes de gravar (o backend faria o mesmo:
// a tela esconde/desabilita, mas quem garante é a regra no momento de agir).
import { can, decide, denyMessage } from '../../access.js';
import { canReadDeal, maskedContact, transferTargets, visibleConvs } from './perm.js';

/** minúsculas e sem acento: 'Patrícia' casa com 'patricia'. */
export const norm = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

const digits = (s) => String(s || '').replace(/\D/g, '');

export const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';

let seq = 0;
const newId = () => `m_${Date.now().toString(36)}${(seq++).toString(36)}`;

export const messagesOf = (state, convId) => state.messages[convId] || [];

/** Última mensagem "de conversa" (in/out): nota interna e sugestão da IA não vão pro preview. */
export function lastChatMessage(state, convId) {
  const list = messagesOf(state, convId);
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].type === 'in' || list[i].type === 'out') return list[i];
  }
  return null;
}

/** Negócio vinculado à conversa, SEM checar permissão (uso interno; a tela usa readableDealOf). */
export function dealOf(store, conv) {
  const s = store.state;
  return (conv.dealId && store.deal(conv.dealId)) || s.deals.find((d) => d.contactId === conv.contactId) || null;
}

/** Negócio vinculado só se o usuário pode lê-lo; senão null. */
export function readableDealOf(store, conv) {
  const deal = dealOf(store, conv);
  return deal && canReadDeal(deal) ? deal : null;
}

/**
 * Lista da aba atual, mais recente primeiro. `Meus` e `Fila` escondem resolvidas; `Todos` mostra tudo.
 * Parte de visibleConvs: busca, abas e contagens nunca enxergam o que o motor nega. A busca usa o
 * contato MASCARADO (campo oculto não casa) para não virar oráculo de dados.
 */
export function visibleConversations(store, { tab, query }) {
  const s = store.state;
  const q = norm(query).trim();
  const qDigits = digits(query);
  return visibleConvs(store)
    .filter((c) => inTab(s, c, tab))
    .filter((c) => {
      if (!q) return true;
      const contact = maskedContact(store.contact(c.contactId));
      const last = lastChatMessage(s, c.id);
      if ([contact?.name, contact?.company, contact?.email, contact?.phone, last?.text].some((v) => norm(v).includes(q))) return true;
      // telefone: casa pelos dígitos ("98765" acha "+55 11 98765-4321"), só se o campo não está oculto
      return qDigits.length >= 3 && !!contact?.phone && digits(contact.phone).includes(qDigits);
    })
    .sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0));
}

function inTab(state, c, tab) {
  if (tab === 'all') return true;
  if (c.status === 'resolved') return false;
  if (tab === 'mine') return c.assigneeId === state.currentUserId;
  return c.status === 'queue' || !c.assigneeId;
}

/** Contagens das abas (e total visível) — só sobre o que o usuário pode ler. */
export function tabCounts(store) {
  const s = store.state;
  const vis = visibleConvs(store);
  const count = (tab) => vis.filter((c) => inTab(s, c, tab)).length;
  return { mine: count('mine'), queue: count('queue'), all: count('all'), total: vis.length };
}

function timelinePush(state, contactId, text) {
  const me = state.users.find((u) => u.id === state.currentUserId);
  // a linha do tempo do contato é do mais novo pro mais antigo
  (state.timeline[contactId] ||= []).unshift({ text, who: firstName(me?.name), at: Date.now() });
}

function systemMessage(state, convId, text) {
  (state.messages[convId] ||= []).push({ id: newId(), type: 'system', text, at: Date.now() });
}

const reopenStatus = (conv) => (conv.assigneeId ? 'open' : 'queue');
const findConv = (store, convId) => store.state.conversations.find((c) => c.id === convId);
const deny = (d) => ({ ok: false, msg: denyMessage(d) });

/**
 * Abrir a conversa = lida — mas só para quem atende: o responsável (ou a fila, se a pessoa pode
 * responder). Supervisor/leitor não zera a não lida de quem está atendendo.
 */
export function canMarkRead(store, conv) {
  const mine = conv.assigneeId === store.state.currentUserId;
  return (mine || !conv.assigneeId) && can('conversation', 'send_message', conv);
}

export function markRead(store, convId) {
  const conv = findConv(store, convId);
  if (!conv || !conv.unread || !canMarkRead(store, conv)) return;
  store.update(() => {
    conv.unread = 0;
  });
}

/**
 * Resposta ao lead ('out') ou nota interna ('note'). Responder reabre e, se estava na fila, assume
 * (só se o motor permitir transferir a conversa para mim e eu continuar podendo atendê-la).
 * Devolve { ok:true, msg, claimed, supervisedOf } ou { ok:false, msg } (texto do motivo).
 */
export function sendMessage(store, convId, type, text) {
  const body = text.trim();
  if (!body) return { ok: false, msg: '' };
  const conv = findConv(store, convId);
  if (!conv) return { ok: false, msg: 'Conversa não encontrada.' };
  const d = decide('conversation', type === 'out' ? 'send_message' : 'note', conv);
  if (d.effect !== 'allow') return deny(d);

  const me = store.state.currentUserId;
  const supervisedOf = conv.assigneeId && conv.assigneeId !== me ? conv.assigneeId : null;
  let msg = null;
  let claimed = false;
  store.update((s) => {
    msg = { id: newId(), type, text: body, at: Date.now(), authorId: s.currentUserId };
    (s.messages[convId] ||= []).push(msg);
    if (type !== 'out') return; // nota não mexe em ordem da lista nem em status
    msg.status = 'sent';
    conv.lastMessageAt = msg.at;
    conv.unread = 0;
    if (!conv.assigneeId) {
      const asMine = { ...conv, assigneeId: s.currentUserId, teamId: undefined };
      if (can('conversation', 'transfer', conv) && can('conversation', 'send_message', asMine)) {
        conv.assigneeId = s.currentUserId;
        claimed = true;
        timelinePush(s, conv.contactId, 'Conversa assumida');
      }
    }
    conv.status = reopenStatus(conv);
    // prévia denormalizada do negócio: efeito do envio (derivado), não uma edição do usuário no negócio
    const deal = s.deals.find((x) => x.id === conv.dealId);
    if (deal) deal.lastMessage = body;
  });
  return { ok: true, msg, claimed, supervisedOf };
}

/** Mensagem do lead (evento externo, sem checagem de usuário). Só soma não lida se ninguém estiver olhando a conversa. */
export function receiveMessage(store, convId, text, { viewing }) {
  store.update((s) => {
    const conv = s.conversations.find((c) => c.id === convId);
    if (!conv) return;
    const at = Date.now();
    (s.messages[convId] ||= []).push({ id: newId(), type: 'in', text, at });
    conv.lastMessageAt = at;
    if (!viewing) conv.unread = (conv.unread || 0) + 1;
    if (conv.status === 'resolved') conv.status = reopenStatus(conv);
    const deal = s.deals.find((d) => d.id === conv.dealId);
    if (deal) deal.lastMessage = text;
  });
}

export function markDelivered(store, convId, msgId) {
  const msg = messagesOf(store.state, convId).find((m) => m.id === msgId);
  if (!msg || msg.status === 'delivered') return;
  store.update(() => {
    msg.status = 'delivered';
  });
}

/**
 * userId = null devolve para a fila. Confere no motor: eu posso transferir ESTA conversa e o destino
 * está entre os destinos válidos (ativo e capaz de ler/responder lá).
 * Devolve { ok, msg?, leaves? } — leaves: a conversa saiu da minha lista.
 */
export function transfer(store, convId, userId) {
  const conv = findConv(store, convId);
  if (!conv) return { ok: false, msg: 'Conversa não encontrada.' };
  const d = decide('conversation', 'transfer', conv);
  if (d.effect !== 'allow') return deny(d);
  if (userId && !transferTargets(store, conv).some((t) => t.user.id === userId)) return { ok: false, msg: 'Este usuário não pode receber a conversa.' };
  store.update((s) => {
    const target = userId && s.users.find((u) => u.id === userId);
    conv.assigneeId = target ? target.id : null;
    // transferir não reabre: conversa resolvida continua resolvida (reabrir é ação explícita)
    if (conv.status !== 'resolved') conv.status = reopenStatus(conv);
    const text = target ? `Conversa transferida para ${firstName(target.name)}` : 'Conversa devolvida para a fila';
    timelinePush(s, conv.contactId, text);
    systemMessage(s, convId, text);
  });
  return { ok: true, leaves: !can('conversation', 'read', conv) };
}

export function resolve(store, convId) {
  const conv = findConv(store, convId);
  if (!conv) return { ok: false, msg: 'Conversa não encontrada.' };
  const d = decide('conversation', 'resolve', conv);
  if (d.effect !== 'allow') return deny(d);
  store.update((s) => {
    conv.status = 'resolved';
    timelinePush(s, conv.contactId, 'Conversa resolvida');
    systemMessage(s, convId, 'Conversa resolvida');
  });
  return { ok: true };
}

export function reopen(store, convId) {
  const conv = findConv(store, convId);
  if (!conv) return { ok: false, msg: 'Conversa não encontrada.' };
  const d = decide('conversation', 'resolve', conv);
  if (d.effect !== 'allow') return deny(d);
  store.update((s) => {
    conv.status = reopenStatus(conv);
    timelinePush(s, conv.contactId, 'Conversa reaberta');
    systemMessage(s, convId, 'Conversa reaberta');
  });
  return { ok: true };
}

/** "Virar follow-up": registra a sugestão como nota interna e marca a sugestão como aproveitada. */
export function insightToFollowUp(store, convId, insightId) {
  const conv = findConv(store, convId);
  if (!conv) return { ok: false, msg: 'Conversa não encontrada.' };
  const d = decide('conversation', 'note', conv);
  if (d.effect !== 'allow') return deny(d);
  store.update((s) => {
    const insight = messagesOf(s, convId).find((m) => m.id === insightId);
    if (!insight || insight.followUp) return;
    insight.followUp = true;
    (s.messages[convId] ||= []).push({ id: newId(), type: 'note', text: `Follow-up: ${insight.text}`, at: Date.now(), authorId: s.currentUserId });
  });
  return { ok: true };
}
