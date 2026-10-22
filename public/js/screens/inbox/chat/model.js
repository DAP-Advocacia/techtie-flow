// Chat interno — modelo PURO (sem DOM, sem store). Testado em Node (test/api/chat-model.test.mjs).
// Sala: { id, kind: 'dm'|'group', name, members: [userId], lastAt, lastBody, lastAuthorId, unread?, reads? }
// `reads` ({ userId: ms }) existe só no protótipo (sem servidor); em operação o servidor já manda `unread` pronto.

const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Chave única da conversa direta entre duas pessoas (a mesma nas duas pontas). */
export const dmKey = (a, b) => [a, b].sort().join(':');

/** A outra pessoa de uma conversa direta. */
export const peerOf = (room, meId) => (room.kind === 'dm' ? room.members.find((u) => u !== meId) || null : null);

export const roomTitle = (room, meId, nameOf) => (room.kind === 'group' ? room.name || 'Grupo' : nameOf(peerOf(room, meId)) || 'Pessoa removida');

/** "Você: ok" / "Ana: ok" (em grupo) / "ok" (conversa direta, da outra pessoa). */
export function previewOf(room, meId, nameOf) {
  if (!room.lastBody) return room.kind === 'group' ? 'Grupo criado' : 'Nenhuma mensagem ainda';
  if (room.lastAuthorId === meId) return `Você: ${room.lastBody}`;
  if (room.kind === 'group') return `${String(nameOf(room.lastAuthorId) || '').split(/\s+/)[0] || 'Alguém'}: ${room.lastBody}`;
  return room.lastBody;
}

/** Não lidas da sala para `meId`. Em operação o servidor manda `unread`; no protótipo conta pela marca de leitura. */
export function unreadOf(room, meId, messages = []) {
  if (!room.reads) return Number(room.unread) || 0;
  const seen = room.reads[meId] || 0;
  return messages.filter((m) => m.at > seen && m.authorId !== meId).length;
}

/** Mais recente primeiro; sala sem mensagem vai para o fim, por nome. */
export function sortRooms(rooms, titleOf = (r) => r.name || '') {
  return [...rooms].sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0) || fold(titleOf(a)).localeCompare(fold(titleOf(b)), 'pt-BR'));
}

export const matchRoom = (title, q) => {
  const t = fold(q).trim();
  return !t || fold(title).includes(t);
};

const startOfDay = (t) => new Date(new Date(t).getFullYear(), new Date(t).getMonth(), new Date(t).getDate()).getTime();

/** "Hoje" · "Ontem" · "12 de outubro" (com o ano se não for o corrente). */
export function dayLabel(ts, now = Date.now()) {
  const diff = Math.round((startOfDay(now) - startOfDay(ts)) / 86400000);
  if (diff === 0) return 'Hoje';
  if (diff === 1) return 'Ontem';
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', ...(sameYear ? {} : { year: 'numeric' }) });
}

const CLUSTER_MS = 5 * 60 * 1000;

/**
 * Mensagens em ordem com separador de dia e agrupamento: mensagens seguidas da mesma pessoa (até 5 min) formam um bloco
 * — `first` mostra o nome/hora, `last` fecha o bloco.
 * @returns {Array<{ type: 'day', label } | { type: 'msg', msg, first, last }>}
 */
export function groupMessages(messages, now = Date.now()) {
  const out = [];
  let prev = null;
  for (const m of messages) {
    const newDay = !prev || startOfDay(prev.at) !== startOfDay(m.at);
    if (newDay) out.push({ type: 'day', label: dayLabel(m.at, now) });
    const first = newDay || prev.authorId !== m.authorId || m.at - prev.at > CLUSTER_MS;
    if (!first) out[out.length - 1].last = false;
    out.push({ type: 'msg', msg: m, first, last: true });
    prev = m;
  }
  // `last` do item anterior só vale se o próximo abre outro bloco
  for (let i = 0; i < out.length - 1; i++) if (out[i].type === 'msg' && out[i + 1].type === 'msg') out[i].last = out[i + 1].first;
  for (let i = 0; i < out.length - 1; i++) if (out[i].type === 'msg' && out[i + 1].type === 'day') out[i].last = true;
  return out;
}

export const MAX_GROUP = 50;

/** Mensagem do primeiro problema ao criar um grupo ('' se estiver certo). `others` = pessoas além de quem cria. */
export function validateGroup(name, others) {
  const n = String(name ?? '').trim().replace(/\s+/g, ' ');
  if (!n) return 'Dê um nome ao grupo.';
  if (n.length > 80) return 'O nome do grupo passa de 80 caracteres.';
  if (!others.length) return 'Escolha pelo menos mais uma pessoa.';
  if (others.length + 1 > MAX_GROUP) return `O grupo pode ter no máximo ${MAX_GROUP} pessoas.`;
  return '';
}

/** Texto do rascunho pronto para enviar: tira espaços das pontas e normaliza quebras. '' se vazio. */
export const cleanDraft = (s) => String(s ?? '').replace(/\r\n/g, '\n').trim();
