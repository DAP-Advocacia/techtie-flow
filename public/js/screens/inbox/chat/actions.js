// Ações do chat interno. Em operação (live) o servidor decide e guarda; no protótipo grava só no navegador.
// Qualquer pessoa ATIVA da empresa conversa com qualquer outra: o chat é entre pessoas, não passa pelo motor de permissões
// (o servidor só deixa ler a sala quem participa). Devolve { ok, room?, error? }.
import { store } from '../../../store.js';
import * as live from '../../../live.js';
import { dmKey, sortRooms, validateGroup, cleanDraft, unreadOf, roomTitle, MAX_GROUP } from './model.js';

const uid = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const me = () => store.state.currentUserId;
const fail = (error) => ({ ok: false, error });
const chat = () => (store.state.chat ||= { rooms: [], messages: {} });
const nameOf = (id) => store.userById(id)?.name || '';

/** Pessoas com quem se pode conversar: ativas, não robôs, não eu. */
export const people = () => store.state.users.filter((u) => !u.isBot && u.status === 'active' && u.id !== me());

/** Salas em que eu participo, mais recente primeiro (no protótipo o store tem as salas de todo mundo). */
export const myRooms = () => sortRooms(chat().rooms.filter((r) => (r.members || []).includes(me())), (r) => roomTitle(r, me(), nameOf));
export const messagesOf = (roomId) => chat().messages[roomId] || [];
export const unreadFor = (room) => unreadOf(room, me(), messagesOf(room.id));
export const totalUnread = () => myRooms().reduce((n, r) => n + unreadFor(r), 0);

const wrap = async (fn) => {
  try {
    return await fn();
  } catch (e) {
    return fail(e.message || 'Não foi possível concluir.');
  }
};

export function openDm(userId) {
  if (!people().some((u) => u.id === userId)) return Promise.resolve(fail('Só dá para conversar com pessoas ativas da empresa.'));
  return wrap(async () => {
    if (live.enabled) return { ok: true, room: await live.openDm(userId) };
    const key = dmKey(me(), userId);
    let room = chat().rooms.find((r) => r.kind === 'dm' && dmKey(...r.members) === key);
    if (!room) {
      room = { id: uid('cr'), kind: 'dm', name: null, members: [me(), userId], createdBy: me(), lastAt: null, lastBody: '', lastAuthorId: null, reads: { [me()]: Date.now() } };
      store.update((s) => (s.chat ||= { rooms: [], messages: {} }).rooms.push(room));
    }
    return { ok: true, room };
  });
}

export function createGroup(name, userIds) {
  const others = [...new Set(userIds)].filter((id) => id !== me() && people().some((u) => u.id === id));
  const msg = validateGroup(name, others);
  if (msg) return Promise.resolve(fail(msg));
  const n = String(name).trim().replace(/\s+/g, ' ');
  return wrap(async () => {
    if (live.enabled) return { ok: true, room: await live.createGroup(n, others) };
    const room = { id: uid('cr'), kind: 'group', name: n, members: [me(), ...others], createdBy: me(), lastAt: null, lastBody: '', lastAuthorId: null, reads: { [me()]: Date.now() } };
    store.update((s) => (s.chat ||= { rooms: [], messages: {} }).rooms.push(room));
    return { ok: true, room };
  });
}

export function addMembers(roomId, userIds) {
  const room = chat().rooms.find((r) => r.id === roomId);
  if (!room || room.kind !== 'group' || !room.members.includes(me())) return Promise.resolve(fail('Só quem está no grupo pode convidar.'));
  const add = [...new Set(userIds)].filter((id) => !room.members.includes(id) && people().some((u) => u.id === id));
  if (!add.length) return Promise.resolve(fail('Escolha pessoas que ainda não estão no grupo.'));
  if (room.members.length + add.length > MAX_GROUP) return Promise.resolve(fail(`O grupo pode ter no máximo ${MAX_GROUP} pessoas.`));
  return wrap(async () => {
    if (live.enabled) return { ok: true, room: await live.addToGroup(roomId, add) };
    store.update(() => {
      room.members.push(...add);
      for (const u of add) room.reads = { ...(room.reads || {}), [u]: 0 };
    });
    return { ok: true, room };
  });
}

export function send(roomId, text) {
  const body = cleanDraft(text);
  const room = chat().rooms.find((r) => r.id === roomId);
  if (!room || !room.members.includes(me())) return Promise.resolve(fail('Conversa não encontrada.'));
  if (!body) return Promise.resolve(fail('Escreva a mensagem.'));
  if (body.length > 4000) return Promise.resolve(fail('Mensagem muito longa (até 4000 caracteres).'));
  return wrap(async () => {
    if (live.enabled) return { ok: true, message: await live.sendChat(roomId, body) };
    const message = { id: uid('cm'), roomId, authorId: me(), body, at: Date.now() };
    store.update((s) => {
      const c = (s.chat ||= { rooms: [], messages: {} });
      (c.messages[roomId] ||= []).push(message);
      Object.assign(room, { lastAt: message.at, lastBody: body.slice(0, 200), lastAuthorId: me(), reads: { ...(room.reads || {}), [me()]: message.at } });
    });
    return { ok: true, message };
  });
}

/** Marca a sala como lida para mim. */
export function markRead(roomId) {
  const room = chat().rooms.find((r) => r.id === roomId);
  if (!room || unreadFor(room) === 0) return;
  if (live.enabled) {
    live.markChatRead(roomId);
    return;
  }
  store.update(() => {
    room.reads = { ...(room.reads || {}), [me()]: Date.now() };
  });
}

/** Abre a sala: em operação carrega as mensagens do servidor. */
export const load = (roomId) => (live.enabled ? live.loadChatMessages(roomId).catch(() => {}) : Promise.resolve());
export const setViewing = (roomId) => live.setChatViewing(roomId);
