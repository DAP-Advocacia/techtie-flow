// Bloco compacto de tarefas para colocar dentro de outras telas (negócio, contato, conversa, início):
// as abertas por prazo, marcar como feita na hora, abrir o painel e criar uma nova já vinculada.
import { h, icon } from '../../ui.js';
import { ensureTasksCss } from './css.js';
import { openTaskPanel } from './panel.js';
import * as A from './actions.js';
import { isOpen, compareTasks, dueLabel } from './model.js';

const CHECK = 'M5 12.5l4.5 4.5L19 7';

/**
 * @param tasks     tarefas JÁ filtradas pelo que o usuário pode ver
 * @param defaults  vínculo da tarefa nova ({ dealId, contactId })
 * @param empty     texto quando não há nenhuma
 */
export function tasksBlock({ tasks, defaults = {}, title = 'Tarefas', limit = 5, empty = 'Nenhuma tarefa ainda.' }) {
  ensureTasksCss();
  const open = tasks.filter(isOpen).sort(compareTasks);
  const done = tasks.length - open.length;
  const shown = open.slice(0, limit);
  const li = (t) => {
    const dl = dueLabel(t);
    return h(
      'li',
      null,
      h(
        'div',
        { class: 'tasks-row' },
        h('button', { class: 'tasks-check-btn', type: 'button', role: 'checkbox', 'aria-checked': 'false', 'aria-label': `Concluir: ${t.title}`, disabled: !A.can('update', t), onclick: () => A.toggleDone(t.id) }, icon(CHECK, 14)),
        h('button', { class: 'tasks-row__main', type: 'button', onclick: () => openTaskPanel({ taskId: t.id }) }, h('span', { class: 'tasks-row__title' }, t.title), t.dueAt ? h('span', { class: 'tasks-row__meta' }, h('span', { class: `tasks-chip tasks-chip--due tasks-chip--${dl.tone}` }, dl.text)) : null)
      )
    );
  };
  return h(
    'section',
    { class: 'tasks-mini', 'aria-label': title },
    h('div', { class: 'tasks-mini__head' }, h('span', { class: 'label' }, `${title}${open.length ? ` (${open.length})` : ''}`), A.canCreate() ? h('button', { class: 'btn btn--quiet btn--sm', type: 'button', onclick: () => openTaskPanel({ defaults }) }, '+ Tarefa') : null),
    shown.length ? h('ul', { class: 'tasks-mini__list' }, ...shown.map(li)) : h('p', { class: 'tasks-hint' }, tasks.length ? 'Tudo feito por aqui.' : empty),
    open.length > limit ? h('a', { class: 'tasks-hint', href: '#/tasks' }, `+${open.length - limit} em Tarefas`) : null,
    done && shown.length ? h('p', { class: 'tasks-hint' }, `${done} concluída${done > 1 ? 's' : ''}`) : null
  );
}
