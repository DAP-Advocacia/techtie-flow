// Barra superior (computador): recolher o menu, caminho da página, busca global (Ctrl+K), "+ Novo" e avisos.
import { h, icon, avatar } from '../ui.js';
import { totalUnread as chatUnread } from '../screens/inbox/chat/actions.js';
import { store } from '../store.js';
import { visible, canAccess } from '../access.js';
import { openMenu } from './menu.js';
import { newActions } from './new.js';
import { openPalette } from '../search/palette.js';
import { todaySummary } from '../screens/tasks/model.js';

const MENU = 'M4 6h16M4 12h16M4 18h16';
const SEARCH = 'M21 21l-4.3-4.3M17 10.5a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0z';
const BELL = 'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0';
const PLUS = 'M12 5v14M5 12h14';

const isMac = () => /mac|iphone|ipad/i.test(globalThis.navigator?.platform || globalThis.navigator?.userAgent || '');

/** O que pede atenção agora: mensagens não lidas, conversas na fila e tarefas atrasadas/de hoje. */
export function attention() {
  const s = store.state;
  const convs = canAccess('conversation', 'read') ? visible('conversation', s.conversations) : [];
  const unread = convs.reduce((n, c) => n + (Number(c.unread) || 0), 0);
  const queue = convs.filter((c) => c.status === 'queue').length;
  const tasks = canAccess('task', 'read') ? todaySummary(visible('task', s.tasks || []), s.currentUserId) : { total: 0, overdue: 0 };
  const chat = chatUnread();
  return { unread, queue, chat, tasksToday: tasks.total, overdue: tasks.overdue, badge: unread + chat + tasks.overdue };
}

/**
 * @param crumbs [{ label, href? }]  caminho da página (o último é a página atual)
 * @param onToggleSidebar  recolhe/expande o menu lateral
 */
export function renderTopbar({ crumbs = [], onToggleSidebar, navigate }) {
  const toggle = h('button', { class: 'topbar__btn topbar__toggle', type: 'button', 'aria-label': 'Recolher ou expandir o menu', title: 'Recolher/expandir o menu', onclick: onToggleSidebar }, icon(MENU, 20));
  const trail = h(
    'nav',
    { class: 'topbar__crumbs', 'aria-label': 'Você está em' },
    ...crumbs.flatMap((c, i) => [i ? h('span', { class: 'topbar__sep', 'aria-hidden': 'true' }, '›') : null, c.href && i < crumbs.length - 1 ? h('a', { href: c.href }, c.label) : h('span', { class: 'topbar__here', 'aria-current': i === crumbs.length - 1 ? 'page' : null }, c.label)])
  );
  const search = h('button', { class: 'topbar__search', type: 'button', 'aria-label': 'Busca global', onclick: () => openPalette() }, icon(SEARCH, 17), h('span', { class: 'topbar__search-text' }, 'Buscar negócios, contatos, conversas…'), h('kbd', { class: 'topbar__kbd' }, isMac() ? '⌘ K' : 'Ctrl K'));
  const create = h('button', { class: 'btn btn--primary topbar__new', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, icon(PLUS, 16), ' Novo');
  create.addEventListener('click', () =>
    openMenu(
      create,
      newActions().map((a) => ({ label: a.label, hint: a.hint, disabled: a.disabled, reason: a.reason, onSelect: a.run })),
      { align: 'right' }
    )
  );
  const a = attention();
  const bell = h('button', { class: 'topbar__btn topbar__bell', type: 'button', 'aria-label': a.badge ? `Avisos: ${a.badge} pendentes` : 'Avisos', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, icon(BELL, 20), a.badge ? h('span', { class: 'topbar__badge' }, a.badge > 99 ? '99+' : a.badge) : null);
  bell.addEventListener('click', () => {
    const now = attention();
    const items = [];
    if (now.unread) items.push({ label: `${now.unread} ${now.unread === 1 ? 'mensagem não lida' : 'mensagens não lidas'}`, hint: now.queue ? `${now.queue} na fila` : '', onSelect: () => navigate('inbox') });
    else if (now.queue) items.push({ label: `${now.queue} ${now.queue === 1 ? 'conversa na fila' : 'conversas na fila'}`, onSelect: () => navigate('inbox') });
    if (now.chat) items.push({ label: `${now.chat} ${now.chat === 1 ? 'mensagem no chat interno' : 'mensagens no chat interno'}`, onSelect: () => (location.hash = '#/inbox?view=chat') });
    if (now.tasksToday) items.push({ label: `${now.tasksToday} ${now.tasksToday === 1 ? 'tarefa para hoje' : 'tarefas para hoje'}`, hint: now.overdue ? `${now.overdue} atrasada${now.overdue > 1 ? 's' : ''}` : '', onSelect: () => navigate('tasks') });
    if (!items.length) items.push({ label: 'Tudo em dia', disabled: true });
    openMenu(bell, items, { align: 'right' });
  });
  const me = store.user();
  const profile = h('a', { class: 'topbar__me', href: '#/profile', 'aria-label': 'Meu perfil', title: me ? `${me.name} · Meu perfil` : 'Meu perfil' }, avatar(me?.name || '?', { small: true }));
  return h('header', { class: 'topbar' }, toggle, trail, h('div', { class: 'topbar__grow' }), search, create, bell, profile);
}

