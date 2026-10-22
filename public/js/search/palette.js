// Busca global (Ctrl+K / ⌘K): acha negócios, contatos, conversas e tarefas, vai para uma tela ou cria algo.
// Só enxerga o que o motor deixa o usuário ver (visible/canAccess). Setas navegam, Enter abre, Esc fecha.
import { h, icon, ICONS, replaceChildren, fmtBRL } from '../ui.js';
import { store } from '../store.js';
import { visible, canAccess, fieldLevel } from '../access.js';
import { linkTo } from '../router.js';
import { openTaskPanel } from '../screens/tasks/panel.js';
import { pointInboxTo } from '../screens/pipeline/actions.js';
import { newActions } from '../shell/new.js';
import { GROUPS, buildEntries, commandEntries, searchEntries, makeRecents } from './model.js';

export const NAV_COMMANDS = [
  { id: 'home', label: 'Início', keywords: 'inicio home resumo' },
  { id: 'inbox', label: 'Inbox', keywords: 'conversas whatsapp mensagens atendimento', require: ['conversation', 'read'] },
  { id: 'pipeline', label: 'Negócios', keywords: 'funil pipeline vendas kanban', require: ['deal', 'read'] },
  { id: 'contacts', label: 'Contatos', keywords: 'clientes leads pessoas', require: ['contact', 'read'] },
  { id: 'tasks', label: 'Tarefas', keywords: 'atividades pendencias lembretes', require: ['task', 'read'] },
  { id: 'dashboard', label: 'Dashboard', keywords: 'numeros relatorios metricas', require: ['report', 'read'] },
  { id: 'agent', label: 'Agente de IA', keywords: 'ia robo automatico openai', require: ['ai_agent', 'read'] },
  { id: 'instances', label: 'Instâncias', keywords: 'numeros whatsapp qr conexao', require: ['instance', 'read'] },
  { id: 'funnels', label: 'Funis', keywords: 'etapas pipeline probabilidade motivos perda configurar funil', require: ['pipeline', 'update'] },
];

const recents = () => makeRecents(window.localStorage || globalThis.localStorage);
const ICON = { deal: ICONS.pipeline, contact: ICONS.contacts, conversation: ICONS.inbox, task: ICONS.tasks, command: 'M5 12h14M13 6l6 6-6 6' };

/** Entradas pesquisáveis a partir do que o usuário atual pode ver. */
export function currentEntries() {
  const s = store.state;
  const hideValue = fieldLevel('deal', 'value') === 'hidden';
  const contacts = canAccess('contact', 'read') ? visible('contact', s.contacts) : [];
  const byId = new Map(s.contacts.map((c) => [c.id, c]));
  const data = {
    contacts,
    deals: canAccess('deal', 'read') ? visible('deal', s.deals) : [],
    conversations: canAccess('conversation', 'read') ? visible('conversation', s.conversations) : [],
    tasks: canAccess('task', 'read') ? visible('task', s.tasks || []) : [],
    stageName: (id) => store.stage(id)?.name,
    contactById: (id) => byId.get(id),
    userName: (id) => store.userById(id)?.name,
    moneyOf: (d) => (hideValue || !d.value ? '' : fmtBRL(d.value)),
  };
  const routes = NAV_COMMANDS.filter((r) => !r.require || canAccess(r.require[0], r.require[1]));
  const actions = newActions().filter((a) => !a.disabled).map((a) => ({ id: `new:${a.id}`, label: `Novo: ${a.label}`, hint: 'Criar', keywords: a.keywords, run: a.run }));
  return { entries: [...commandEntries(routes, actions.map(({ run, ...rest }) => rest)), ...buildEntries(data)], actionRuns: Object.fromEntries(actions.map((a) => [a.id, a.run])) };
}

/** Abre o item escolhido. Devolve true se algo foi aberto. */
export function runEntry(entry, { actionRuns = {} } = {}) {
  if (!entry) return false;
  if (entry.type !== 'command') recents().push({ type: entry.type, id: entry.id });
  switch (entry.type) {
    case 'command':
      if (entry.command.go) location.hash = `#/${entry.command.go}`;
      else actionRuns[entry.command.action]?.();
      return true;
    case 'contact':
      location.hash = linkTo('contacts', { c: entry.id });
      return true;
    case 'deal':
      location.hash = linkTo('deal', { id: entry.id });
      return true;
    case 'conversation':
      if (pointInboxTo(entry.id)) location.hash = linkTo('inbox', { c: entry.id }); // hash diferente = a Inbox remonta e abre a conversa
      return true;
    case 'task':
      openTaskPanel({ taskId: entry.id });
      return true;
    default:
      return false;
  }
}

let open = null;
export function closePalette() {
  open?.close();
}

export function openPalette() {
  if (open) return open.focus();
  const prev = document.activeElement;
  let { entries, actionRuns } = currentEntries();
  let flat = [];
  let active = 0;

  const input = h('input', { class: 'palette__input', type: 'search', placeholder: 'Buscar negócios, contatos, conversas e tarefas…', 'aria-label': 'Busca global', autocomplete: 'off', spellcheck: 'false' });
  const list = h('div', { class: 'palette__list', role: 'listbox', id: 'palette-list' });
  const hints = h('div', { class: 'palette__foot' }, h('span', null, '↑↓ navegar'), h('span', null, 'Enter abrir'), h('span', null, 'Esc fechar'));
  const box = h('div', { class: 'palette', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Busca global' }, h('div', { class: 'palette__bar' }, icon('M21 21l-4.3-4.3M17 10.5a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0z', 18), input), list, hints);
  const overlay = h('div', { class: 'palette-overlay', onmousedown: (e) => e.target === overlay && close() }, box);

  const row = (e, i) =>
    h(
      'button',
      { class: 'palette__item' + (i === active ? ' is-active' : ''), type: 'button', role: 'option', 'aria-selected': String(i === active), id: `palette-item-${i}`, 'data-i': String(i), onmouseenter: () => setActive(i), onclick: () => choose(e) },
      h('span', { class: 'palette__icon', 'data-type': e.type }, icon(ICON[e.type] || ICON.command, 16)),
      h('span', { class: 'palette__text' }, h('span', { class: 'palette__title' }, e.title), e.subtitle ? h('span', { class: 'palette__sub' }, e.subtitle) : null)
    );

  function draw() {
    const q = input.value.trim();
    let groups;
    if (q) groups = searchEntries(entries, q);
    else {
      // sem busca: o que a pessoa abriu por último + atalhos
      const byKey = new Map(entries.filter((e) => e.type !== 'command').map((e) => [`${e.type}:${e.id}`, e]));
      const rec = recents().list().map((r) => byKey.get(`${r.type}:${r.id}`)).filter(Boolean);
      const cmds = entries.filter((e) => e.type === 'command').slice(0, 8);
      groups = [rec.length ? { type: 'recent', label: 'Abertos recentemente', items: rec } : null, { type: 'command', label: 'Ir para e criar', items: cmds }].filter(Boolean);
    }
    flat = groups.flatMap((g) => g.items);
    active = Math.min(active, Math.max(0, flat.length - 1));
    let i = 0;
    replaceChildren(
      list,
      flat.length ? null : h('div', { class: 'palette__empty' }, q ? `Nada encontrado para “${q}”.` : 'Digite para buscar.'),
      ...groups.map((g) => h('div', { class: 'palette__group' }, h('div', { class: 'palette__label' }, g.label), ...g.items.map((e) => row(e, i++))))
    );
    input.setAttribute('aria-activedescendant', flat.length ? `palette-item-${active}` : '');
  }
  function setActive(i) {
    if (i === active) return;
    active = i;
    for (const el of list.querySelectorAll('.palette__item')) {
      const on = Number(el.dataset.i) === active;
      el.classList.toggle('is-active', on);
      el.setAttribute('aria-selected', String(on));
      if (on) el.scrollIntoView?.({ block: 'nearest' });
    }
    input.setAttribute('aria-activedescendant', `palette-item-${active}`);
  }
  function choose(e) {
    close();
    runEntry(e, { actionRuns });
  }
  input.addEventListener('input', () => {
    active = 0;
    draw();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(flat.length ? (active + 1) % flat.length : 0);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(flat.length ? (active - 1 + flat.length) % flat.length : 0);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(flat[active]);
    }
  });
  const onKey = (e) => e.key === 'Escape' && (e.preventDefault(), close());
  document.addEventListener('keydown', onKey, true);
  // dados novos (mensagem, tarefa…) com a busca aberta
  const unsub = store.subscribe(() => {
    ({ entries, actionRuns } = currentEntries());
    draw();
  });

  function close() {
    if (!open) return;
    unsub();
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    document.body.classList.remove('palette-lock');
    open = null;
    prev?.focus?.();
  }

  document.body.append(overlay);
  document.body.classList.add('palette-lock');
  draw();
  input.focus();
  open = { close, focus: () => input.focus() };
  return open;
}

export { GROUPS };
