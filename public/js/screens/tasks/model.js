// Modelo PURO das tarefas (sem DOM, sem store): agrupar por prazo, filtrar por visão, formatar prazo e entender o
// "criar rápido" em português ("ligar para a Carla amanhã 10h !alta"). Testado em Node (test/api/tasks-model.test.mjs).
// Datas em HORA LOCAL do navegador. Tarefa só com data (sem hora) é guardada ao MEIO-DIA local: nenhum fuso a empurra
// para o dia vizinho, e ela só é "atrasada" quando o dia termina.

export const STATUSES = [
  { id: 'todo', label: 'A fazer' },
  { id: 'doing', label: 'Em andamento' },
  { id: 'waiting', label: 'Aguardando' },
  { id: 'done', label: 'Feita' },
];
export const PRIORITIES = [
  { id: 'normal', label: 'Normal' },
  { id: 'high', label: 'Alta' },
  { id: 'urgent', label: 'Urgente' },
];
export const statusLabel = (id) => STATUSES.find((s) => s.id === id)?.label || id;
export const priorityLabel = (id) => PRIORITIES.find((p) => p.id === id)?.label || id;
const PRIORITY_RANK = { urgent: 3, high: 2, normal: 1 };

const DAY = 86400000;
export const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const addDays = (dayStart, n) => new Date(new Date(dayStart).getFullYear(), new Date(dayStart).getMonth(), new Date(dayStart).getDate() + n).getTime();
const pad2 = (n) => String(n).padStart(2, '0');
const WEEKDAY_SHORT = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

/** Combina um dia (ms de 00:00 local) com hora/minuto; sem hora = meio-dia. */
export const dueFrom = (dayStart, hour, minute) => {
  const d = new Date(dayStart);
  return hour == null ? new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0).getTime() : new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, minute || 0).getTime();
};

// ---------------------------------------------------------------------------------------------
// Prazo
// ---------------------------------------------------------------------------------------------

/** { text, tone } — tone: overdue | today | soon | later | none */
export function dueLabel(task, now = new Date()) {
  if (!task.dueAt) return { text: 'Sem prazo', tone: 'none' };
  const due = new Date(task.dueAt);
  const today = startOfDay(now);
  const dueDay = startOfDay(due);
  const diff = Math.round((dueDay - today) / DAY);
  const time = task.dueHasTime ? ` ${pad2(due.getHours())}:${pad2(due.getMinutes())}` : '';
  const open = task.status !== 'done';
  if (diff < 0) return { text: open ? `Atrasada · ${-diff === 1 ? 'ontem' : `há ${-diff} dias`}` : `${pad2(due.getDate())}/${pad2(due.getMonth() + 1)}`, tone: open ? 'overdue' : 'none' };
  if (diff === 0) return { text: `Hoje${time}`, tone: open && task.dueHasTime && due.getTime() < now.getTime() ? 'overdue' : 'today' };
  if (diff === 1) return { text: `Amanhã${time}`, tone: 'soon' };
  if (diff <= 6) return { text: `${WEEKDAY_SHORT[due.getDay()]} ${pad2(due.getDate())}/${pad2(due.getMonth() + 1)}${time}`, tone: 'soon' };
  const year = due.getFullYear() === now.getFullYear() ? '' : `/${due.getFullYear()}`;
  return { text: `${pad2(due.getDate())}/${pad2(due.getMonth() + 1)}${year}${time}`, tone: 'later' };
}

export const isOpen = (t) => t.status !== 'done';

/** Resumo para o Início: minhas tarefas abertas atrasadas ou de hoje (a lista, em ordem) e as contagens. */
export function todaySummary(tasks, userId, now = new Date()) {
  const today = startOfDay(now);
  const mine = tasks.filter((t) => t.ownerId === userId && t.status !== 'done' && t.dueAt && startOfDay(new Date(t.dueAt)) <= today);
  const overdue = mine.filter((t) => startOfDay(new Date(t.dueAt)) < today || (t.dueHasTime && t.dueAt < now.getTime())).length;
  return { list: mine.sort(compareTasks), total: mine.length, overdue };
}
export const isOverdue = (t, now = new Date()) => isOpen(t) && !!t.dueAt && (t.dueHasTime ? t.dueAt < now.getTime() && startOfDay(new Date(t.dueAt)) <= startOfDay(now) : startOfDay(new Date(t.dueAt)) < startOfDay(now));

/** Ordem: prazo (mais perto primeiro; sem prazo por último), prioridade, mais antiga. */
export function compareTasks(a, b) {
  const da = a.dueAt ?? Infinity;
  const db = b.dueAt ?? Infinity;
  if (da !== db) return da - db;
  const pr = (PRIORITY_RANK[b.priority] || 1) - (PRIORITY_RANK[a.priority] || 1);
  if (pr) return pr;
  return (a.createdAt || 0) - (b.createdAt || 0);
}

export const GROUPS = [
  { key: 'overdue', label: 'Atrasadas' },
  { key: 'today', label: 'Hoje' },
  { key: 'next7', label: 'Próximos 7 dias' },
  { key: 'later', label: 'Depois' },
  { key: 'nodue', label: 'Sem prazo' },
  { key: 'done', label: 'Concluídas' },
];

/** Grupos no estilo "Minhas tarefas" (só os que têm tarefa). Concluídas: as 20 mais recentes. */
export function groupTasks(tasks, now = new Date()) {
  const today = startOfDay(now);
  const buckets = Object.fromEntries(GROUPS.map((g) => [g.key, []]));
  for (const t of tasks) {
    if (!isOpen(t)) {
      buckets.done.push(t);
      continue;
    }
    if (!t.dueAt) buckets.nodue.push(t);
    else {
      const diff = Math.round((startOfDay(new Date(t.dueAt)) - today) / DAY);
      buckets[diff < 0 ? 'overdue' : diff === 0 ? 'today' : diff <= 7 ? 'next7' : 'later'].push(t);
    }
  }
  for (const k of Object.keys(buckets)) {
    if (k === 'done') buckets.done.sort((a, b) => (b.completedAt || b.updatedAt || 0) - (a.completedAt || a.updatedAt || 0));
    else buckets[k].sort(compareTasks);
  }
  buckets.done = buckets.done.slice(0, 20);
  return GROUPS.map((g) => ({ ...g, tasks: buckets[g.key] })).filter((g) => g.tasks.length);
}

// ---------------------------------------------------------------------------------------------
// Visões (abas) — "de quem" a tarefa é em relação a mim
// ---------------------------------------------------------------------------------------------

export const VIEWS = [
  { id: 'mine', label: 'Minhas' },
  { id: 'delegated', label: 'Delegadas por mim' },
  { id: 'shared', label: 'Compartilhadas comigo' },
  { id: 'team', label: 'Equipe' },
  { id: 'all', label: 'Todas' },
];

const isSharedWithMe = (t, userId, teamIds) => (t.sharedWith || []).some((g) => (g.type === 'user' && g.id === userId) || (g.type === 'team' && teamIds.includes(g.id)));

export function inView(t, view, { userId, teamIds = [] }) {
  switch (view) {
    case 'mine':
      return t.ownerId === userId;
    case 'delegated':
      return t.createdBy === userId && t.ownerId !== userId;
    case 'shared':
      return t.ownerId !== userId && isSharedWithMe(t, userId, teamIds);
    case 'team':
      return t.ownerId !== userId && !!t.teamId && teamIds.includes(t.teamId);
    default:
      return true;
  }
}
export const viewTasks = (tasks, view, ctx) => tasks.filter((t) => inView(t, view, ctx));
/** Quantas tarefas ABERTAS há em cada visão (para o número nas abas). */
export const viewCounts = (tasks, ctx) => Object.fromEntries(VIEWS.map((v) => [v.id, tasks.filter((t) => isOpen(t) && inView(t, v.id, ctx)).length]));

export const checklistProgress = (t) => {
  const list = Array.isArray(t.checklist) ? t.checklist : [];
  return { done: list.filter((i) => i.done).length, total: list.length };
};

/** Quadro (Kanban): colunas por status, na ordem de prazo. Feitas: as 15 mais recentes. */
export function boardColumns(tasks) {
  return STATUSES.map((s) => {
    const list = tasks.filter((t) => t.status === s.id);
    return { ...s, tasks: s.id === 'done' ? list.sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0)).slice(0, 15) : list.sort(compareTasks) };
  });
}

// ---------------------------------------------------------------------------------------------
// "Criar rápido": entende data, hora e prioridade escritas no título
// ---------------------------------------------------------------------------------------------

// minúscula e sem acento, MESMO comprimento (cada caractere vira o seu "caractere base"): os índices valem no original
const fold = (s) =>
  String(s)
    .split('')
    .map((ch) => ((ch.normalize('NFD')[0] || ch).toLowerCase()[0] || ch))
    .join('');
const WEEKDAYS = { domingo: 0, segunda: 1, terca: 2, quarta: 3, quinta: 4, sexta: 5, sabado: 6 };
const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate();

/**
 * "ligar para a Carla amanhã 10h !alta" → { title: 'ligar para a Carla', dueAt, dueHasTime: true, priority: 'high' }
 * Entende: hoje · amanhã · depois de amanhã · em/daqui a N dias · semana que vem · segunda…domingo (-feira) ·
 *          dia 25 · 25/10 · 25/10/2026 · 10h · 10h30 · 14:30 · às 9 · !alta · !urgente · !normal.
 * Sem data mas com hora: hoje (ou amanhã, se a hora já passou). Se nada for entendido, devolve o texto como título.
 */
export function parseQuickAdd(input, now = new Date()) {
  const original = String(input ?? '');
  let n = fold(original);
  const cuts = [];
  const cut = (m) => {
    cuts.push([m.index, m.index + m[0].length]);
    n = n.slice(0, m.index) + ' '.repeat(m[0].length) + n.slice(m.index + m[0].length); // não casa duas vezes
  };
  const take = (re) => {
    const m = re.exec(n);
    if (m) cut(m);
    return m;
  };
  const today = startOfDay(now);

  let priority = 'normal';
  const p = take(/(^|\s)!(urgente|alta|normal)(?=\s|$)/);
  if (p) priority = { urgente: 'urgent', alta: 'high', normal: 'normal' }[p[2]];

  let day = null;
  let m;
  if ((m = take(/\bdepois de amanha\b/))) day = addDays(today, 2);
  else if ((m = take(/\bamanha\b/))) day = addDays(today, 1);
  else if ((m = take(/\bhoje\b/))) day = today;
  else if ((m = take(/\b(?:daqui a|em)\s+(\d{1,3})\s+dias?\b/))) day = addDays(today, Number(m[1]));
  else if ((m = take(/\b(?:semana que vem|proxima semana)\b/))) day = addDays(today, ((8 - new Date(today).getDay()) % 7) || 7); // próxima segunda
  else if ((m = take(/\b(?:proxim[oa]\s+)?(domingo|segunda|terca|quarta|quinta|sexta|sabado)(?:-feira)?\b/))) {
    const diff = (WEEKDAYS[m[1]] - new Date(today).getDay() + 7) % 7;
    day = addDays(today, diff === 0 ? 7 : diff);
  } else if ((m = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(n))) {
    const dd = Number(m[1]);
    const mm = Number(m[2]);
    let yy = m[3] ? Number(m[3]) : now.getFullYear();
    if (yy < 100) yy += 2000;
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= daysInMonth(yy, mm - 1)) {
      cut(m);
      day = new Date(yy, mm - 1, dd).getTime();
      if (!m[3] && day < today) day = new Date(yy + 1, mm - 1, dd).getTime(); // sem ano e já passou: ano que vem
    }
  } else if ((m = /\bdia\s+(\d{1,2})\b/.exec(n))) {
    const dd = Number(m[1]);
    const cur = new Date(today);
    let y = cur.getFullYear();
    let mo = cur.getMonth();
    if (dd >= 1 && dd <= 31) {
      if (dd < cur.getDate()) mo += 1; // o dia deste mês já passou: mês que vem
      const d = new Date(y, mo, 1);
      y = d.getFullYear();
      mo = d.getMonth();
      if (dd <= daysInMonth(y, mo)) {
        cut(m);
        day = new Date(y, mo, dd).getTime();
      }
    }
  }

  let hour = null;
  let minute = 0;
  const t1 = /\b(?:as\s+)?(\d{1,2})(?:h|:)(\d{2})?(?![\d/])/.exec(n);
  if (t1 && Number(t1[1]) <= 23 && Number(t1[2] || 0) <= 59) {
    cut(t1);
    hour = Number(t1[1]);
    minute = t1[2] ? Number(t1[2]) : 0;
  } else {
    // "às 9" (com crase: "as 2 propostas" é artigo, não horário)
    const t2 = /\bas\s+(\d{1,2})\b(?!\/)/.exec(n);
    if (t2 && original.slice(t2.index, t2.index + 2).toLowerCase() === 'às' && Number(t2[1]) <= 23) {
      cut(t2);
      hour = Number(t2[1]);
    }
  }

  let dueAt = null;
  let dueHasTime = false;
  if (day != null) {
    dueAt = dueFrom(day, hour, minute);
    dueHasTime = hour != null;
  } else if (hour != null) {
    dueAt = dueFrom(today, hour, minute);
    if (dueAt < now.getTime()) dueAt = dueFrom(addDays(today, 1), hour, minute); // a hora de hoje já passou: amanhã
    dueHasTime = true;
  }

  let title = original;
  for (const [s, e] of cuts.sort((a, b) => b[0] - a[0])) title = title.slice(0, s) + ' '.repeat(e - s) + title.slice(e);
  title = title.replace(/\s+/g, ' ').replace(/\s+([,.;:])/g, '$1').replace(/[\s,;:-]+$/g, '').replace(/^[\s,;:-]+/g, '').trim();
  // tira conectivo solto no fim ("ligar para a Carla para")
  title = title.replace(/\s+(para|pra|até|ate|em|no|na|às|as|a|de|do|da)$/i, '').trim();
  return { title: title || original.trim(), dueAt, dueHasTime, priority };
}
