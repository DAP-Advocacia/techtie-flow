// Ações de tarefa no front. Em operação o servidor é a fonte da verdade (permissão, histórico, ID, delegação);
// aqui a tela responde na hora (otimista) e, se o servidor recusar, `live.sync` avisa e volta ao estado real.
// No protótipo (sem servidor) tudo vale só no navegador. Toda ação RE-VERIFICA a permissão no motor.
import { store } from '../../store.js';
import { decide, audit } from '../../access.js';
import * as live from '../../live.js';
import { burst } from '../../fx.js';

const uid = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const me = () => store.state.currentUserId;
const myTeam = () => store.user()?.teamIds?.[0] ?? null;
const find = (id) => (store.state.tasks || []).find((t) => t.id === id);
const denied = (decision) => ({ ok: false, decision });
export const allTasks = () => store.state.tasks || [];

/** Pode o usuário atual fazer `action` nesta tarefa? (task = registro; sem registro = pergunta "em tese") */
export const can = (action, task) => decide('task', action, task || { ownerId: me(), teamId: myTeam(), createdBy: me() }).effect === 'allow';
export const canCreate = () => can('create');
/** Pode passar a tarefa para outra pessoa? (criar já delegando também exige isso) */
export const canDelegate = (task) => can('transfer', task);

/**
 * Cria a tarefa. Em operação ESPERA o servidor (o ID é dele). Devolve { ok, task } ou { ok:false, error|decision }.
 * input: { title, description?, dueAt?, dueHasTime?, priority?, status?, ownerId?, dealId?, contactId?, checklist? }
 */
export async function createTask(input) {
  const title = String(input.title || '').trim();
  if (!title) return { ok: false, error: 'Informe o título da tarefa.' };
  if (title.length > 500) return { ok: false, error: 'O título pode ter até 500 caracteres.' };
  const row = { ownerId: me(), teamId: myTeam(), createdBy: me() };
  const dec = decide('task', 'create', row);
  if (dec.effect !== 'allow') return denied(dec);
  if (input.ownerId && input.ownerId !== me() && !canDelegate(row)) return { ok: false, error: 'Seu perfil não permite criar tarefa para outra pessoa.' };
  const body = { ...input, title };
  if (live.enabled) {
    try {
      return { ok: true, task: await live.createTask(body) };
    } catch (e) {
      return { ok: false, error: e.message || 'Não foi possível criar a tarefa.' };
    }
  }
  const owner = input.ownerId ? store.userById(input.ownerId) : store.user();
  const now = Date.now();
  const task = {
    id: uid('t'),
    title,
    description: input.description || '',
    status: input.status || 'todo',
    priority: input.priority || 'normal',
    dueAt: input.dueAt ?? null,
    dueHasTime: !!(input.dueAt && input.dueHasTime),
    ownerId: owner?.id || me(),
    teamId: owner?.teamIds?.[0] ?? null,
    createdBy: me(),
    dealId: input.dealId || null,
    contactId: input.contactId || (input.dealId ? store.deal(input.dealId)?.contactId : null) || null,
    checklist: (input.checklist || []).map((i, n) => ({ id: i.id || `i${n}`, text: i.text, done: !!i.done })),
    completedAt: input.status === 'done' ? now : null,
    createdAt: now,
    updatedAt: now,
    sharedWith: [],
  };
  store.update((s) => {
    (s.tasks ||= []).push(task);
  });
  audit('task.create', task.id, `Tarefa "${title}" criada`);
  return { ok: true, task };
}

/** Altera campos da tarefa (título, descrição, prazo, prioridade, status, checklist, vínculos). */
export function patchTask(id, patch) {
  const t = find(id);
  if (!t) return { ok: false, error: 'Tarefa não encontrada.' };
  const dec = decide('task', 'update', t);
  if (dec.effect !== 'allow') return denied(dec);
  const wasDone = t.status === 'done';
  if (patch.title !== undefined && !String(patch.title).trim()) return { ok: false, error: 'O título não pode ficar vazio.' };
  const now = Date.now();
  store.update((s) => {
    const x = s.tasks.find((y) => y.id === id);
    if (!x) return;
    Object.assign(x, patch, { updatedAt: now });
    if (patch.status !== undefined) x.completedAt = patch.status === 'done' ? now : null;
    if (patch.dueAt === null) x.dueHasTime = false;
  });
  if (patch.status === 'done' && !wasDone) burst(); // tarefa feita: brilho
  if (live.enabled) live.updateTask(id, patch);
  else audit('task.update', id, `Tarefa "${t.title}" alterada`);
  return { ok: true };
}

export const setStatus = (id, status) => patchTask(id, { status });
/** Marca como feita (ou reabre). */
export function toggleDone(id) {
  const t = find(id);
  return t ? setStatus(id, t.status === 'done' ? 'todo' : 'done') : { ok: false };
}

/** Passa a tarefa para outra pessoa (ou assume). Espera o servidor. */
export async function delegate(id, ownerId) {
  const t = find(id);
  if (!t) return { ok: false, error: 'Tarefa não encontrada.' };
  const dec = decide('task', 'transfer', t);
  if (dec.effect !== 'allow') return denied(dec);
  if (live.enabled) {
    try {
      return { ok: true, task: await live.delegateTask(id, ownerId) };
    } catch (e) {
      return { ok: false, error: e.message || 'Não foi possível delegar.' };
    }
  }
  const to = store.userById(ownerId);
  if (!to) return { ok: false, error: 'Pessoa não encontrada.' };
  store.update((s) => {
    const x = s.tasks.find((y) => y.id === id);
    if (x) Object.assign(x, { ownerId, teamId: to.teamIds?.[0] ?? null, updatedAt: Date.now() });
    (s.taskComments ||= {})[id] = [...(s.taskComments[id] || []), { id: uid('e'), authorId: me(), kind: 'event', text: `${store.user()?.name} delegou a tarefa para ${to.name}`, at: Date.now() }];
  });
  audit('task.delegate', id, `Tarefa "${t.title}" delegada para ${to.name}`);
  return { ok: true };
}

export async function share(id, target) {
  const t = find(id);
  if (!t) return { ok: false, error: 'Tarefa não encontrada.' };
  const dec = decide('task', 'share', t);
  if (dec.effect !== 'allow') return denied(dec);
  if (live.enabled) {
    try {
      await live.shareTask(id, target);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message || 'Não foi possível compartilhar.' };
    }
  }
  store.update((s) => {
    const x = s.tasks.find((y) => y.id === id);
    if (x) x.sharedWith = [...(x.sharedWith || []).filter((g) => !(g.type === target.type && g.id === target.id)), { type: target.type, id: target.id, level: target.level }];
  });
  return { ok: true };
}

export async function unshare(id, target) {
  const t = find(id);
  if (!t || decide('task', 'share', t).effect !== 'allow') return { ok: false };
  if (live.enabled) {
    try {
      await live.unshareTask(id, target);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
  store.update((s) => {
    const x = s.tasks.find((y) => y.id === id);
    if (x) x.sharedWith = (x.sharedWith || []).filter((g) => !(g.type === target.type && g.id === target.id));
  });
  return { ok: true };
}

export function removeTask(id) {
  const t = find(id);
  if (!t) return { ok: false };
  const dec = decide('task', 'delete', t);
  if (dec.effect !== 'allow') return denied(dec);
  store.update((s) => {
    s.tasks = s.tasks.filter((x) => x.id !== id);
  });
  if (live.enabled) live.deleteTask(id);
  else audit('task.delete', id, `Tarefa "${t.title}" excluída`);
  return { ok: true };
}

// ---- comentários e histórico ----
export async function loadComments(id) {
  if (live.enabled) return live.loadTaskComments(id);
  return (store.state.taskComments || {})[id] || [];
}
export async function addComment(id, text) {
  const body = String(text || '').trim();
  if (!body) return null;
  if (live.enabled) return live.addTaskComment(id, body);
  const c = { id: uid('c'), authorId: me(), kind: 'comment', text: body, at: Date.now() };
  store.update((s) => {
    (s.taskComments ||= {})[id] = [...(s.taskComments[id] || []), c];
  });
  return c;
}

// ---- consultas usadas por outras telas (negócio, contato, conversa, início) ----
export const tasksOfDeal = (dealId) => allTasks().filter((t) => t.dealId === dealId);
export const tasksOfContact = (contactId) => allTasks().filter((t) => t.contactId === contactId);
