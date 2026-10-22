// Negócios em lista (tabela): colunas, contexto (contatos/tarefas visíveis) e visões de fábrica. Só descreve — a tabela é lists/table.js.
// Valor oculto no perfil NÃO vira coluna (ordenar/filtrar por ele vazaria o número escondido). Contato só aparece se o usuário o lê.
import { h } from '../../ui.js';
import { store } from '../../store.js';
import { canAccess, visible, fieldLevel } from '../../access.js';
import { parseDay } from '../../lists/model.js';
import { isOpen } from '../tasks/model.js';
import { kindOf } from './perm.js';
import { weightedValue } from '../funnels/model.js';

const DAY = 86400000;
const fmtDate = (t) => new Date(t).toLocaleDateString('pt-BR');
const startOfDay = (t) => new Date(new Date(t).getFullYear(), new Date(t).getMonth(), new Date(t).getDate()).getTime();

/** Contatos legíveis e tarefas abertas por negócio — só do que o usuário pode ver. */
export function dealCtx() {
  const s = store.state;
  const contacts = new Map(visible('contact', s.contacts).map((c) => [c.id, c]));
  const nextTask = new Map();
  const openTasks = new Map();
  if (canAccess('task', 'read')) {
    for (const t of visible('task', s.tasks || [])) {
      if (!t.dealId || !isOpen(t)) continue;
      openTasks.set(t.dealId, (openTasks.get(t.dealId) || 0) + 1);
      if (t.dueAt && (!nextTask.has(t.dealId) || t.dueAt < nextTask.get(t.dealId))) nextTask.set(t.dealId, t.dueAt);
    }
  }
  const users = s.users.filter((u) => !u.isBot && u.status === 'active');
  return { contacts, nextTask, openTasks, users, userName: (id) => store.userById(id)?.name || '' };
}

const statusOf = (d) => kindOf(store.stage(d.stageId));
const lateDate = (t, open) => h('span', { class: open && startOfDay(t) < startOfDay(Date.now()) ? 'lt-late' : null }, fmtDate(t));

export function dealColumns(pipeline) {
  const stages = pipeline?.stages || [];
  const valueOk = fieldLevel('deal', 'value') !== 'hidden';
  const tasksOk = canAccess('task', 'read');
  return [
    { id: 'title', label: 'Negócio', type: 'text', get: (d) => d.title, search: true, visible: true },
    { id: 'contact', label: 'Contato', type: 'text', get: (d, ctx) => ctx.contacts.get(d.contactId)?.name || '', search: true, visible: true },
    { id: 'company', label: 'Empresa', type: 'text', get: (d, ctx) => ctx.contacts.get(d.contactId)?.company || '', search: true },
    {
      id: 'stage',
      label: 'Etapa',
      type: 'enum',
      get: (d) => d.stageId,
      sortValue: (d) => stages.findIndex((st) => st.id === d.stageId),
      options: () => stages.map((st) => ({ value: st.id, label: st.name })),
      cell: (d) => {
        const st = stages.find((x) => x.id === d.stageId);
        return h('span', { class: `lt-pill${st?.kind === 'won' ? ' lt-pill--won' : st?.kind === 'lost' ? ' lt-pill--lost' : ''}` }, st?.name || '—');
      },
      visible: true,
    },
    valueOk && { id: 'value', label: 'Valor', type: 'money', get: (d) => (Number.isFinite(Number(d.value)) ? Number(d.value) : null), align: 'right', visible: true },
    {
      id: 'owner',
      label: 'Responsável',
      type: 'enum',
      get: (d) => d.ownerId || null,
      sortValue: (d, ctx) => ctx.userName(d.ownerId),
      options: (ctx) => ctx.users.map((u) => ({ value: u.id, label: u.name })),
      cell: (d, ctx) => ctx.userName(d.ownerId) || 'Sem responsável',
      visible: true,
    },
    { id: 'expectedClose', label: 'Previsão de fechamento', type: 'date', get: (d) => (d.expectedClose ? parseDay(d.expectedClose) : null), cell: (d) => (d.expectedClose && !Number.isNaN(parseDay(d.expectedClose)) ? lateDate(parseDay(d.expectedClose), statusOf(d) === 'open') : '—'), visible: true },
    { id: 'probability', label: 'Probabilidade', type: 'number', get: (d) => { const p = Number(store.stage(d.stageId)?.probability); return Number.isFinite(p) ? p : null; }, cell: (d) => { const p = Number(store.stage(d.stageId)?.probability); return Number.isFinite(p) ? `${p}%` : '—'; }, align: 'right' },
    valueOk && { id: 'weighted', label: 'Valor ponderado', type: 'money', get: (d) => weightedValue(d.value, store.stage(d.stageId)?.probability), align: 'right' },
    { id: 'daysInStage', label: 'Dias na etapa', type: 'number', get: (d) => (d.stageChangedAt ? Math.max(0, Math.floor((Date.now() - d.stageChangedAt) / DAY)) : null), align: 'right' },
    {
      id: 'status',
      label: 'Situação',
      type: 'enum',
      get: (d) => statusOf(d),
      options: () => [{ value: 'open', label: 'Em aberto' }, { value: 'won', label: 'Ganho' }, { value: 'lost', label: 'Perdido' }],
      cell: (d) => ({ open: 'Em aberto', won: 'Ganho', lost: 'Perdido' })[statusOf(d)] || '—',
    },
    { id: 'createdAt', label: 'Criado em', type: 'date', get: (d) => d.createdAt || null },
    { id: 'proposalSentAt', label: 'Proposta enviada', type: 'date', get: (d) => d.proposalSentAt || null },
    tasksOk && { id: 'nextTask', label: 'Próxima tarefa', type: 'date', get: (d, ctx) => ctx.nextTask.get(d.id) ?? null, cell: (d, ctx) => (ctx.nextTask.get(d.id) ? lateDate(ctx.nextTask.get(d.id), true) : '—') },
    tasksOk && { id: 'openTasks', label: 'Tarefas abertas', type: 'number', get: (d, ctx) => ctx.openTasks.get(d.id) || 0, align: 'right' },
  ].filter(Boolean);
}

/** Visões de fábrica ("Em aberto" é a padrão). As de tarefa só existem para quem pode ler tarefas. */
export function dealViews(userId) {
  const base = ['title', 'contact', 'stage', 'value', 'owner', 'expectedClose', 'createdAt'];
  const open = { col: 'status', op: 'is', value: 'open' };
  const v = (id, name, columns, filters, sort) => ({ id, name, state: { columns, sort: sort || null, filters, q: '' } });
  const views = [
    v('open', 'Em aberto', base, [open], { col: 'createdAt', dir: 'desc' }),
    v('all', 'Todos os negócios', [...base.slice(0, 5), 'status', 'createdAt'], [], { col: 'createdAt', dir: 'desc' }),
    v('mine', 'Meus em aberto', base, [open, { col: 'owner', op: 'is', value: userId }], { col: 'createdAt', dir: 'desc' }),
    v('closing', 'Fechando este mês', ['title', 'contact', 'stage', 'value', 'weighted', 'owner', 'expectedClose'], [open, { col: 'expectedClose', op: 'thisMonth' }], { col: 'expectedClose', dir: 'asc' }),
    v('stale', 'Parados há 7+ dias', ['title', 'contact', 'stage', 'value', 'owner', 'daysInStage'], [open, { col: 'daysInStage', op: 'gt', value: 6 }], { col: 'daysInStage', dir: 'desc' }),
  ];
  if (canAccess('task', 'read')) views.push(v('notask', 'Sem tarefa em aberto', ['title', 'contact', 'stage', 'value', 'owner', 'openTasks'], [open, { col: 'openTasks', op: 'eq', value: 0 }], { col: 'createdAt', dir: 'desc' }));
  views.push(
    v('won', 'Ganhos', ['title', 'contact', 'value', 'owner', 'createdAt', 'daysInStage'], [{ col: 'status', op: 'is', value: 'won' }], { col: 'daysInStage', dir: 'asc' }),
    v('lost', 'Perdidos', ['title', 'contact', 'value', 'owner', 'createdAt', 'daysInStage'], [{ col: 'status', op: 'is', value: 'lost' }], { col: 'daysInStage', dir: 'asc' })
  );
  return views;
}
