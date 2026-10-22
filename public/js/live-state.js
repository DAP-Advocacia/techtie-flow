// Mapeamento PURO entre as respostas da API e o estado que as telas já usam (mesmo formato do
// mock). Sem rede, sem DOM, sem imports: é testado em Node (test/api/live-state.test.mjs).
// As telas continuam lendo store.state como no protótipo; só a ORIGEM dos dados muda.

/** Aplica o /api/bootstrap em `s`. `keepMessages`: preserva mensagens já carregadas (atualização incremental). */
export function applyBootstrap(s, d, { keepMessages = false } = {}) {
  s.tenant = { ...s.tenant, id: d.tenant.id, name: d.tenant.name, policy: d.tenant.policy || {}, goals: d.tenant.goals || {} };
  s.currentUserId = d.currentUserId;
  s.users = d.users;
  s.roles = d.roles;
  s.teams = d.teams;
  s.pipelines = d.pipelines;
  s.contacts = d.contacts;
  s.deals = d.deals;
  s.products = d.products || [];
  s.tasks = d.tasks || [];
  // Agente de IA: configuração salva no servidor (o que é só da tela — instância escolhida, chat de teste — fica)
  if (d.agent) s.agent = { ...(s.agent || {}), ...d.agent };
  s.conversations = d.conversations;
  s.instances = d.instances.map((i) => ({ ownerName: '', conversations: 0, messagesToday: 0, aiActive: false, ...i }));
  if (!keepMessages) {
    s.messages = {};
    s.timeline = {};
  }
  s.auditLog = s.auditLog || [];
  s.session = { ...(s.session || {}), loggedIn: true };
  s.permissions = d.permissions;
  return s;
}

/** Mescla uma conversa vinda do servidor (mantém o que o servidor não manda, ex.: dealId). */
export function mergeConversation(s, conv) {
  const i = s.conversations.findIndex((c) => c.id === conv.id);
  if (i >= 0) s.conversations[i] = { ...s.conversations[i], ...conv };
  else s.conversations.unshift({ dealId: null, ...conv });
  return i < 0; // true = conversa nova (talvez o contato também seja novo)
}

/** Acrescenta a mensagem se a conversa já foi carregada e ela ainda não está lá (dedupe por id). */
export function appendMessage(s, convId, msg) {
  const list = s.messages?.[convId];
  if (!list) return false; // não carregada: virá completa quando a conversa for aberta
  if (list.some((m) => m.id === msg.id)) return false;
  list.push(msg);
  return true;
}

/** Cria ou atualiza o número (instância) com o estado novo. */
export function upsertInstance(s, inst) {
  const i = s.instances.findIndex((x) => x.id === inst.id);
  if (i >= 0) s.instances[i] = { ...s.instances[i], ...inst };
  else s.instances.push({ ownerName: '', conversations: 0, messagesToday: 0, aiActive: false, ...inst });
}

/** Troca o registro local (id provisório) pelo que o servidor devolveu. */
export function replaceById(list, localId, serverRow) {
  const i = list.findIndex((x) => x.id === localId);
  if (i >= 0) list[i] = { ...list[i], ...serverRow };
  else list.push(serverRow);
}
