// MODO OPERAÇÃO do front: conversa com a API real (login, dados, WhatsApp, tempo real).
// Ligado por `window.__TTF__.live === true` (public/config.js; o servidor local liga sozinho
// quando tem banco). Desligado, nada aqui roda e o protótipo segue 100% com dados fictícios.
//
// Estratégia: as telas continuam mutando o store (otimista) como no protótipo; cada ação que
// importa chama a API logo depois. Se o servidor recusar, a tela volta ao estado real
// (re-hidrata) e mostra o motivo. As decisões são do MESMO motor de permissões dos dois lados.
import { store } from './store.js';
import { toast } from './ui.js';
import { applyBootstrap, mergeConversation, appendMessage, upsertInstance, replaceById } from './live-state.js';

const CFG = (typeof window !== 'undefined' && window.__TTF__) || {};
export const enabled = CFG.live === true;
const base = String(CFG.apiUrl || '').replace(/\/$/, '');
const TOKEN_KEY = 'ttf:token';

const storage = {
  get() {
    try {
      return sessionStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set(v) {
    try {
      sessionStorage.setItem(TOKEN_KEY, v);
    } catch {
      /* sem armazenamento: a sessão vale só até recarregar */
    }
  },
  del() {
    try {
      sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      /* ignora */
    }
  },
};

// Token na sessionStorage (some ao fechar a aba). Troca por cookie httpOnly quando o app e a API
// estiverem no mesmo site (subdomínios do mesmo domínio) — ver docs/piloto.md.
let token = enabled ? storage.get() : null;
export const hasToken = () => !!token;
export const isLive = () => enabled;

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function request(path, { method = 'GET', body, auth = true } = {}) {
  let res;
  try {
    res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(auth && token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, 'Sem conexão com o servidor.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && auth) expireSession();
    throw new ApiError(res.status, data.error || 'Erro inesperado.');
  }
  return data;
}

function expireSession() {
  token = null;
  storage.del();
  closeWs();
  store.update((s) => {
    s.session = { ...(s.session || {}), loggedIn: false };
  });
  if (location.hash !== '#/login') location.hash = '#/login';
}

// ------------------------------------------------------------------ sessão
export async function login(email, password) {
  const r = await request('/api/auth/login', { method: 'POST', body: { email, password }, auth: false });
  token = r.token;
  storage.set(token);
  return r.user;
}

export async function acceptInvite(inviteToken, password) {
  await request('/api/auth/accept-invite', { method: 'POST', body: { token: inviteToken, password }, auth: false });
}

export function logout() {
  expireSession();
}

/** Carrega o estado (já filtrado pelo motor no servidor) e liga o tempo real. */
export async function hydrate({ keepMessages = false } = {}) {
  const data = await request('/api/bootstrap');
  store.update((s) => applyBootstrap(s, data, { keepMessages }));
  if (!ws) connectWs();
}

let hydrateTimer = null;
const hydrateSoon = () => {
  clearTimeout(hydrateTimer);
  hydrateTimer = setTimeout(() => hydrate({ keepMessages: true }).catch(() => {}), 300);
};

// ------------------------------------------------------------------ tempo real
let ws = null;
let wsTimer = null;
let wsTry = 0;
let wsWasUp = false;
let viewing = null;
const instanceListeners = new Set();

function closeWs() {
  clearTimeout(wsTimer);
  wsTimer = null;
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }
  wsWasUp = false;
}

async function connectWs() {
  if (!enabled || !token || ws) return;
  let ticket;
  try {
    ticket = (await request('/api/ws-ticket', { method: 'POST' })).ticket;
  } catch {
    return scheduleWs();
  }
  const origin = base || location.origin;
  ws = new WebSocket(`${origin.replace(/^http/, 'ws')}/ws?ticket=${encodeURIComponent(ticket)}`);
  ws.onopen = () => {
    wsTry = 0;
    if (wsWasUp) hydrateSoon(); // reconectou: recupera o que perdeu
    wsWasUp = true;
  };
  ws.onmessage = (e) => {
    try {
      onEvent(JSON.parse(e.data));
    } catch {
      /* evento malformado: ignora */
    }
  };
  ws.onclose = () => {
    ws = null;
    if (token) scheduleWs();
  };
}
function scheduleWs() {
  clearTimeout(wsTimer);
  wsTimer = setTimeout(connectWs, Math.min(30000, 1000 * 2 ** wsTry++));
}

function onEvent(ev) {
  if (ev.type === 'message') {
    let needsRefresh = false;
    store.update((s) => {
      const isNew = mergeConversation(s, ev.conversation);
      if (isNew && !s.contacts.some((c) => c.id === ev.conversation.contactId)) needsRefresh = true; // contato novo
      // a mensagem que EU enviei já volta pela resposta do POST: não duplica
      if (ev.message && ev.message.authorId !== s.currentUserId) appendMessage(s, ev.conversation.id, { id: ev.message.id, type: ev.message.direction === 'out' ? 'out' : 'in', kind: ev.message.kind, text: ev.message.body || '', mediaUrl: ev.message.mediaUrl, at: ev.message.at, status: 'delivered' });
    });
    if (needsRefresh) hydrateSoon();
    if (viewing === ev.conversation.id && ev.message?.direction === 'in') markRead(viewing);
  } else if (ev.type === 'instance') {
    store.update((s) => upsertInstance(s, ev.instance));
    for (const fn of [...instanceListeners]) fn(ev);
  }
}

/** Quem está olhando qual conversa (para marcar como lida quando chega mensagem nova). */
export const setViewing = (id) => {
  viewing = id;
};
const loaded = new Set();
export async function loadMessages(convId) {
  if (!enabled || !convId || loaded.has(convId)) return;
  loaded.add(convId);
  try {
    const r = await request(`/api/conversations/${convId}/messages`);
    store.update((s) => {
      s.messages[convId] = r.messages;
    });
  } catch (e) {
    loaded.delete(convId);
    toast(e.message);
  }
}
export const onInstanceEvent = (fn) => {
  instanceListeners.add(fn);
  return () => instanceListeners.delete(fn);
};

// ------------------------------------------------------------------ ações (chamadas DEPOIS da mudança otimista)
async function sync(run, fail) {
  try {
    return await run();
  } catch (e) {
    toast(e.message || 'Não foi possível concluir a ação.');
    fail?.();
    hydrate({ keepMessages: true }).catch(() => {}); // volta ao estado real do servidor
    return null;
  }
}

export function markRead(convId) {
  return request(`/api/conversations/${convId}/read`, { method: 'POST' }).catch(() => {});
}

export const sendMessage = (convId, type, text, local) =>
  sync(
    async () => {
      const r = await request(`/api/conversations/${convId}/messages`, { method: 'POST', body: { text, kind: type === 'note' ? 'note' : 'text' } });
      store.update((s) => {
        replaceById((s.messages[convId] ||= []), local.id, r.message);
        mergeConversation(s, r.conversation);
      });
      return r;
    },
    () => store.update((s) => (s.messages[convId] = (s.messages[convId] || []).filter((m) => m.id !== local.id)))
  );

export const patchConversation = (convId, body) => sync(() => request(`/api/conversations/${convId}`, { method: 'PATCH', body }).then((r) => store.update((s) => mergeConversation(s, r.conversation))));

export const moveDeal = (dealId, stageId) => sync(() => request(`/api/deals/${dealId}`, { method: 'PATCH', body: { stageId } }).then((r) => store.update((s) => replaceById(s.deals, dealId, r.deal))));

/** Cria no servidor o negócio criado localmente (e o contato novo, se houver). */
export const createDeal = (local, newContact) =>
  sync(async () => {
    let contactId = local.contactId;
    if (newContact) {
      const c = await request('/api/contacts', { method: 'POST', body: { name: newContact.name, phone: newContact.phone, email: newContact.email } });
      contactId = c.contact.id;
      store.update((s) => replaceById(s.contacts, newContact.id || local.contactId, c.contact));
    }
    const r = await request('/api/deals', { method: 'POST', body: { title: local.title, contactId: contactId || undefined, pipelineId: local.pipelineId, stageId: local.stageId, value: local.value, ownerId: local.ownerId } });
    store.update((s) => replaceById(s.deals, local.id, r.deal));
  });

export const invite = (form) => request('/api/users/invite', { method: 'POST', body: form }).then(async (r) => (await hydrate({ keepMessages: true }), r));
export const setUserRoles = (userId, roleIds) => request(`/api/users/${userId}/roles`, { method: 'POST', body: { roleIds } }).then(() => hydrate({ keepMessages: true }));
export const setUserTeams = (userId, teamIds) => request(`/api/users/${userId}/teams`, { method: 'POST', body: { teamIds } }).then(() => hydrate({ keepMessages: true }));
/** Cria/edita um perfil do tenant no servidor (que valida pelo motor e recusa escalonamento). */
export async function saveRole(role, { isNew, clonedFrom }) {
  const payload = { name: role.name, description: role.description || '', definition: { grants: role.grants, denies: role.denies, partitions: role.partitions || {}, fields: role.fields || [] } };
  const r = isNew ? await request('/api/roles', { method: 'POST', body: { ...payload, clonedFrom } }) : await request(`/api/roles/${role.id}`, { method: 'PATCH', body: payload });
  // o perfil JÁ está salvo no servidor: se a atualização da tela falhar, não é falha de salvar
  await hydrate({ keepMessages: true }).catch((e) => console.error('[perfil] salvo, mas a tela não atualizou:', e));
  return r.role;
}
export const deleteRole = (roleId) => request(`/api/roles/${roleId}`, { method: 'DELETE' }).then(() => hydrate({ keepMessages: true }));
export const setUserStatus = (userId, status) => request(`/api/users/${userId}`, { method: 'PATCH', body: { status } }).then(() => hydrate({ keepMessages: true }));

export const createInstance = (name) => request('/api/instances', { method: 'POST', body: { name } }).then((r) => (store.update((s) => upsertInstance(s, r.instance)), r.instance));
export const connectInstance = (id) => request(`/api/instances/${id}/connect`, { method: 'POST' });
export const instanceState = (id) => request(`/api/instances/${id}/qr`);
/** Remove o número no servidor (encerra a sessão e apaga as credenciais). `withConversations`: leva as conversas junto. */
export const deleteInstance = (id, withConversations = false) => request(`/api/instances/${id}${withConversations ? '?withConversations=1' : ''}`, { method: 'DELETE' }).then(() => hydrate({ keepMessages: true }));
export const disconnectInstance = (id) => request(`/api/instances/${id}/disconnect`, { method: 'POST' });
