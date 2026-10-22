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
  loadChatRooms().catch(() => {}); // chat interno: salas e não lidas
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
      if (ev.message && ev.message.authorId !== s.currentUserId) appendMessage(s, ev.conversation.id, { id: ev.message.id, type: ev.message.direction === 'out' ? 'out' : 'in', kind: ev.message.kind, byAi: !!ev.message.byAi, text: ev.message.body || '', mediaUrl: ev.message.mediaUrl, at: ev.message.at, status: 'delivered' });
    });
    if (needsRefresh) hydrateSoon();
    if (viewing === ev.conversation.id && ev.message?.direction === 'in') markRead(viewing);
  } else if (ev.type === 'tasks') {
    hydrateSoon(); // alguém criou, delegou ou compartilhou uma tarefa comigo
  } else if (ev.type === 'directory') {
    hydrateSoon(); // alguém mudou o nome/cargo no perfil
  } else if (ev.type === 'chat') {
    onChatEvent(ev);
  } else if (ev.type === 'pipelines') {
    hydrateSoon(); // alguém mudou funis, etapas ou motivos de perda
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

export const moveDeal = (dealId, stageId, lostReason) => sync(() => request(`/api/deals/${dealId}`, { method: 'PATCH', body: { stageId, ...(lostReason ? { lostReason } : {}) } }).then((r) => store.update((s) => replaceById(s.deals, dealId, r.deal))));

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

// ---- negócios: proposta, compartilhar, excluir (o servidor é a fonte do valor: preço vem do catálogo) ----
export const updateDeal = (dealId, body) => sync(() => request(`/api/deals/${dealId}`, { method: 'PATCH', body }).then((r) => store.update((s) => replaceById(s.deals, dealId, r.deal))));
/** Grava os itens da proposta (só produto + quantidade; nome, preço e total o servidor calcula). */
export const saveItems = (dealId, items) => updateDeal(dealId, { items: items.map((i) => ({ productId: i.productId, qty: i.qty })) });
export const deleteDeal = (dealId) => sync(() => request(`/api/deals/${dealId}`, { method: 'DELETE' }));
const setShared = (dealId, sharedWith) => store.update((s) => { const d = s.deals.find((x) => x.id === dealId); if (d) d.sharedWith = sharedWith; });
export const shareDeal = (dealId, target) => sync(() => request(`/api/deals/${dealId}/shares`, { method: 'POST', body: target }).then((r) => setShared(dealId, r.sharedWith)));
export const unshareDeal = (dealId, { type, id }) => sync(() => request(`/api/deals/${dealId}/shares/${type}/${id}`, { method: 'DELETE' }).then((r) => setShared(dealId, r.sharedWith)));
/** Envia a proposta por WhatsApp (servidor monta o texto e posta na conversa do contato). Devolve { result, … } ou null. */
export const sendProposal = (dealId) =>
  sync(async () => {
    const r = await request(`/api/deals/${dealId}/proposal/send`, { method: 'POST' });
    store.update((s) => {
      replaceById(s.deals, dealId, r.deal);
      if (r.conversation) mergeConversation(s, r.conversation);
      if (r.message && r.conversation) appendMessage(s, r.conversation.id, r.message);
    });
    return r;
  });

/** Números reais do Dashboard (calculados no banco, dentro do que o perfil pode ver). */
export async function loadDashboard() {
  const r = await request('/api/dashboard');
  store.update((s) => {
    s.dashboardApi = r.periods;
    s.dashboard = { ...(s.dashboard || {}), periods: Object.fromEntries(Object.entries(r.periods).map(([k, p]) => [k, { label: p.label }])) };
  });
}

// ---- Agente de IA (a chave da OpenAI fica só no servidor) ----
export const saveAgent = ({ prompt, handoffRules }) => request('/api/ai-agent', { method: 'PUT', body: { prompt, handoffRules } });
export const uploadAgentDoc = (name, base64) => request('/api/ai-agent/docs', { method: 'POST', body: { name, base64 } }).then((r) => r.doc);
export const deleteAgentDoc = (id) => request(`/api/ai-agent/docs/${id}`, { method: 'DELETE' });
/** Chat de teste: devolve { kind: 'ai' | 'handoff', text, source?, rule?, reason? } (OpenAI de verdade, sem enviar ao WhatsApp). */
export const testAgent = (messages) => request('/api/ai-agent/test', { method: 'POST', body: { messages } });

// ---- tarefas (criar espera o servidor; o resto é otimista com volta ao estado real se falhar) ----
const putTask = (t) => store.update((s) => { const i = (s.tasks ||= []).findIndex((x) => x.id === t.id); if (i >= 0) s.tasks[i] = { ...s.tasks[i], ...t }; else s.tasks.push(t); });
export const createTask = (body) => request('/api/tasks', { method: 'POST', body }).then((r) => (putTask(r.task), r.task));
export const updateTask = (id, body) => sync(() => request(`/api/tasks/${id}`, { method: 'PATCH', body }).then((r) => putTask(r.task)));
export const delegateTask = (id, ownerId) => request(`/api/tasks/${id}/delegate`, { method: 'POST', body: { ownerId } }).then((r) => (putTask(r.task), hydrate({ keepMessages: true }).catch(() => {}), r.task));
export const deleteTask = (id) => sync(() => request(`/api/tasks/${id}`, { method: 'DELETE' }));
export const shareTask = (id, target) => request(`/api/tasks/${id}/shares`, { method: 'POST', body: target }).then((r) => (store.update((s) => { const t = (s.tasks || []).find((x) => x.id === id); if (t) t.sharedWith = r.sharedWith; }), r.sharedWith));
export const unshareTask = (id, { type, id: subjectId }) => request(`/api/tasks/${id}/shares/${type}/${subjectId}`, { method: 'DELETE' }).then((r) => (store.update((s) => { const t = (s.tasks || []).find((x) => x.id === id); if (t) t.sharedWith = r.sharedWith; }), r.sharedWith));
export const loadTaskComments = (id) => request(`/api/tasks/${id}/comments`).then((r) => r.comments);
export const addTaskComment = (id, text) => request(`/api/tasks/${id}/comments`, { method: 'POST', body: { text } }).then((r) => r.comment);

/** Linha do tempo real do negócio (auditoria + tarefas ligadas). */
export const dealActivity = (id) => request(`/api/deals/${id}/activity`).then((r) => r.activity);

// ---- contatos (esperam o servidor: não há ID provisório) ----
export const createContact = (body) =>
  request('/api/contacts', { method: 'POST', body }).then((r) => {
    store.update((s) => { if (!s.contacts.some((c) => c.id === r.contact.id)) s.contacts.push(r.contact); });
    return r.contact;
  });
export const updateContact = (id, body) => request(`/api/contacts/${id}`, { method: 'PATCH', body }).then((r) => (store.update((s) => replaceById(s.contacts, id, r.contact)), r.contact));
export const deleteContact = (id) => request(`/api/contacts/${id}`, { method: 'DELETE' }).then(() => store.update((s) => { s.contacts = s.contacts.filter((c) => c.id !== id); }));

// ---- funis configuráveis (esperam o servidor: os IDs são dele) ----
const putPipeline = (p) =>
  store.update((s) => {
    const i = s.pipelines.findIndex((x) => x.id === p.id);
    if (i === -1) s.pipelines.push(p);
    else s.pipelines[i] = { ...s.pipelines[i], ...p };
  });
export const createPipeline = (body) => request('/api/pipelines', { method: 'POST', body }).then((r) => (putPipeline(r.pipeline), r.pipeline));
export const renamePipeline = (id, name) => request(`/api/pipelines/${id}`, { method: 'PATCH', body: { name } }).then((r) => (putPipeline(r.pipeline), r.pipeline));
export const savePipelineStages = (id, stages) => request(`/api/pipelines/${id}/stages`, { method: 'PUT', body: { stages } }).then((r) => (putPipeline(r.pipeline), r.pipeline));
export const deletePipeline = (id) => request(`/api/pipelines/${id}`, { method: 'DELETE' }).then(() => store.update((s) => { s.pipelines = s.pipelines.filter((p) => p.id !== id); }));
export const saveLossReasons = (reasons) => request('/api/loss-reasons', { method: 'PUT', body: { reasons } }).then((r) => (store.update((s) => { s.lossReasons = r.lossReasons; }), r.lossReasons));

// ---- chat interno (conversa direta e grupos) ----
const chatOf = (s) => (s.chat ||= { rooms: [], messages: {} });
const putRoom = (s, room) => {
  const c = chatOf(s);
  const i = c.rooms.findIndex((r) => r.id === room.id);
  if (i === -1) c.rooms.push(room);
  else c.rooms[i] = { ...c.rooms[i], ...room };
  c.rooms.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
};
/** Põe a mensagem na sala (sem duplicar) e atualiza a prévia. */
function appendChat(s, m) {
  const c = chatOf(s);
  const list = (c.messages[m.roomId] ||= []);
  if (!list.some((x) => x.id === m.id)) list.push(m);
  const room = c.rooms.find((r) => r.id === m.roomId);
  if (room && (m.at || 0) >= (room.lastAt || 0)) Object.assign(room, { lastAt: m.at, lastBody: m.body.slice(0, 200), lastAuthorId: m.authorId });
  return room;
}
let chatViewing = null;
export const setChatViewing = (id) => {
  chatViewing = id;
};
export async function loadChatRooms() {
  const r = await request('/api/chat/rooms');
  store.update((s) => {
    chatOf(s).rooms = r.rooms;
  });
}
export const openDm = (userId) => request('/api/chat/rooms', { method: 'POST', body: { userId } }).then((r) => (store.update((s) => putRoom(s, r.room)), r.room));
export const createGroup = (name, userIds) => request('/api/chat/rooms', { method: 'POST', body: { name, userIds } }).then((r) => (store.update((s) => putRoom(s, r.room)), r.room));
export const addToGroup = (roomId, userIds) => request(`/api/chat/rooms/${roomId}/members`, { method: 'POST', body: { userIds } }).then((r) => (store.update((s) => putRoom(s, r.room)), r.room));
export async function loadChatMessages(roomId) {
  const r = await request(`/api/chat/rooms/${roomId}/messages`);
  store.update((s) => {
    chatOf(s).messages[roomId] = r.messages;
  });
}
export const sendChat = (roomId, body) => request(`/api/chat/rooms/${roomId}/messages`, { method: 'POST', body: { body } }).then((r) => (store.update((s) => appendChat(s, r.message)), r.message));
export function markChatRead(roomId) {
  store.update((s) => {
    const room = chatOf(s).rooms.find((r) => r.id === roomId);
    if (room) room.unread = 0;
  });
  return request(`/api/chat/rooms/${roomId}/read`, { method: 'POST' }).catch(() => {});
}
function onChatEvent(ev) {
  if (ev.kind === 'room') {
    loadChatRooms().catch(() => {});
    return;
  }
  const m = ev.message;
  if (!m) return;
  const mine = m.authorId === store.state.currentUserId;
  const known = store.state.chat?.rooms?.some((r) => r.id === m.roomId);
  store.update((s) => {
    const room = appendChat(s, m);
    if (room && !mine && chatViewing !== m.roomId) room.unread = (room.unread || 0) + 1;
  });
  if (!known) loadChatRooms().catch(() => {});
  if (!mine && chatViewing === m.roomId) markChatRead(m.roomId);
}

// ---- perfil (o próprio) ----
export const saveProfile = (body) => request('/api/me', { method: 'PATCH', body }).then((r) => (store.update((s) => Object.assign(s.users.find((u) => u.id === r.me.id) || {}, r.me)), r.me));

// ---- meta de receita do mês (Início) ----
export const setGoal = (monthlyRevenue) => request('/api/tenant/goals', { method: 'PATCH', body: { monthlyRevenue } }).then((r) => (store.update((s) => { s.tenant.goals = r.goals; }), r.goals));

// ---- produtos (catálogo das propostas) ----
export const createProduct = (body) => request('/api/products', { method: 'POST', body }).then((r) => (store.update((s) => { (s.products ||= []).push(r.product); }), r.product));
export const archiveProduct = (id) => request(`/api/products/${id}`, { method: 'PATCH', body: { active: false } }).then(() => store.update((s) => { s.products = (s.products || []).filter((p) => p.id !== id); }));

// ---- números: renomear, trocar responsável, ligar a IA ----
export const patchInstance = (id, body) => request(`/api/instances/${id}`, { method: 'PATCH', body }).then((r) => (store.update((s) => upsertInstance(s, r.instance)), r.instance));

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
