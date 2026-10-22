// Contatos em tabela: colunas, contexto (totais por contato) e visões de fábrica. Só descreve — a tabela é lists/table.js.
// Campos ocultos do perfil (telefone, e-mail) NÃO viram coluna: ordenar/filtrar por eles vazaria o valor escondido.
import { store } from '../../store.js';
import { canAccess, visible, fieldLevel } from '../../access.js';
import { isOpen } from '../tasks/model.js';

const count = (map, key) => map.set(key, (map.get(key) || 0) + 1);

/** Totais por contato, só do que o usuário pode ler (negócios e tarefas visíveis), mais a lista de pessoas. */
export function contactCtx() {
  const s = store.state;
  const deals = new Map();
  const openDeals = new Map();
  const tasks = new Map();
  if (canAccess('deal', 'read')) {
    for (const d of visible('deal', s.deals)) {
      if (!d.contactId) continue;
      count(deals, d.contactId);
      if ((store.stage(d.stageId)?.kind || 'open') === 'open') count(openDeals, d.contactId);
    }
  }
  if (canAccess('task', 'read')) {
    for (const t of visible('task', s.tasks || [])) if (t.contactId && isOpen(t)) count(tasks, t.contactId);
  }
  const users = s.users.filter((u) => !u.isBot && u.status !== 'inactive');
  return { users, deals, openDeals, tasks, me: s.currentUserId, userName: (id) => store.userById(id)?.name || '' };
}

export function contactColumns() {
  const phoneHidden = fieldLevel('contact', 'phone') === 'hidden';
  const emailHidden = fieldLevel('contact', 'email') === 'hidden';
  const dealsOk = canAccess('deal', 'read');
  const tasksOk = canAccess('task', 'read');
  return [
    { id: 'name', label: 'Nome', type: 'text', get: (c) => c.name, search: true, visible: true },
    { id: 'company', label: 'Empresa', type: 'text', get: (c) => c.company, search: true, visible: true },
    !phoneHidden && { id: 'phone', label: 'Telefone', type: 'text', get: (c) => c.phone, search: true, visible: true },
    !emailHidden && { id: 'email', label: 'E-mail', type: 'text', get: (c) => c.email, search: true, visible: true },
    {
      id: 'owner',
      label: 'Responsável',
      type: 'enum',
      get: (c) => c.ownerId || null,
      sortValue: (c, ctx) => ctx.userName(c.ownerId),
      options: (ctx) => ctx.users.map((u) => ({ value: u.id, label: u.name })),
      cell: (c, ctx) => ctx.userName(c.ownerId) || 'Sem responsável',
      visible: true,
    },
    { id: 'source', label: 'Origem', type: 'text', get: (c) => c.source },
    { id: 'createdAt', label: 'Criado em', type: 'date', get: (c) => c.createdAt || null },
    dealsOk && { id: 'deals', label: 'Negócios', type: 'number', get: (c, ctx) => ctx.deals.get(c.id) || 0, align: 'right' },
    dealsOk && { id: 'openDeals', label: 'Negócios abertos', type: 'number', get: (c, ctx) => ctx.openDeals.get(c.id) || 0, align: 'right' },
    tasksOk && { id: 'tasks', label: 'Tarefas abertas', type: 'number', get: (c, ctx) => ctx.tasks.get(c.id) || 0, align: 'right' },
  ].filter(Boolean);
}

/** Visões de fábrica. As que dependem de negócios só existem para quem pode ler negócios. */
export function contactViews(userId) {
  const base = ['name', 'company', 'phone', 'email', 'owner'];
  const byName = { col: 'name', dir: 'asc' };
  const views = [
    { id: 'all', name: 'Todos os contatos', state: { columns: [...base, 'createdAt'], sort: byName, filters: [], q: '' } },
    { id: 'mine', name: 'Meus contatos', state: { columns: base, sort: byName, filters: [{ col: 'owner', op: 'is', value: userId }], q: '' } },
    { id: 'noowner', name: 'Sem responsável', state: { columns: base, sort: byName, filters: [{ col: 'owner', op: 'empty' }], q: '' } },
    { id: 'recent', name: 'Criados nos últimos 30 dias', state: { columns: [...base, 'createdAt'], sort: { col: 'createdAt', dir: 'desc' }, filters: [{ col: 'createdAt', op: 'last30' }], q: '' } },
  ];
  if (canAccess('deal', 'read')) {
    views.splice(
      3,
      0,
      { id: 'withdeal', name: 'Com negócio aberto', state: { columns: ['name', 'company', 'owner', 'openDeals'], sort: byName, filters: [{ col: 'openDeals', op: 'gt', value: 0 }], q: '' } },
      { id: 'nodeal', name: 'Sem negócio', state: { columns: ['name', 'company', 'owner', 'deals'], sort: byName, filters: [{ col: 'deals', op: 'eq', value: 0 }], q: '' } }
    );
  }
  return views;
}
