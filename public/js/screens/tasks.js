// #/tasks — Tarefas: "Minhas tarefas" agrupadas por prazo (Atrasadas, Hoje, Próximos 7 dias…), criar rápido
// ("ligar para a Carla amanhã 10h !alta"), visões (minhas, delegadas, compartilhadas, equipe, todas) e quadro por
// status. Clicar abre o painel da tarefa. Tudo calculado sobre o que o motor deixa o usuário ver.
import { h, icon, replaceChildren, toast, avatar } from '../ui.js';
import { visible } from '../access.js';
import { ensureTasksCss } from './tasks/css.js';
import { openTaskPanel } from './tasks/panel.js';
import * as A from './tasks/actions.js';
import { VIEWS, viewTasks, viewCounts, groupTasks, boardColumns, dueLabel, parseQuickAdd, checklistProgress, priorityLabel } from './tasks/model.js';
import { isMobile } from '../mobile.js';

const CHECK = 'M5 12.5l4.5 4.5L19 7';
const FLAG = 'M5 21V4h11l-1.5 4L16 12H5';
const LIST = 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01';
const BOARD = 'M4 4h6v16H4zM14 4h6v10h-6z';

const store$ = (k, fallback) => {
  try {
    return localStorage.getItem(k) || fallback;
  } catch {
    return fallback;
  }
};
const save$ = (k, v) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* sem armazenamento: só não lembra */
  }
};

export default {
  mount(el, { store }) {
    ensureTasksCss();
    const ctx = () => ({ userId: store.state.currentUserId, teamIds: store.user()?.teamIds || [] });
    let view = store$('ttf:tasks:view', 'mine');
    let mode = store$('ttf:tasks:mode', 'list');
    let query = '';
    let showDone = false;
    let raf = 0;

    // ------------------------------------------------------------ criar rápido
    const quickInput = h('input', { class: 'input tasks-quick-input', type: 'text', maxlength: '500', placeholder: 'Nova tarefa — ex.: ligar para a Carla amanhã 10h !alta', 'aria-label': 'Criar tarefa rápida', autocomplete: 'off' });
    const quickPreview = h('div', { class: 'tasks-quick-preview', 'aria-live': 'polite' });
    const quickHint = h('div', { class: 'tasks-quick-hint' }, 'Enter cria. Entendo: hoje, amanhã, sexta, dia 25, 10h, !alta, !urgente');
    quickInput.addEventListener('input', () => {
      const text = quickInput.value.trim();
      if (!text) return replaceChildren(quickPreview);
      const p = parseQuickAdd(text);
      const due = p.dueAt ? dueLabel({ dueAt: p.dueAt, dueHasTime: p.dueHasTime, status: 'todo' }) : null;
      replaceChildren(quickPreview, h('span', { class: 'tasks-pv' }, 'Tarefa: ', h('b', null, p.title)), due ? h('span', { class: 'tasks-pv' }, `Prazo: ${due.text}`) : null, p.priority !== 'normal' ? h('span', { class: 'tasks-pv tasks-pv--prio' }, `Prioridade: ${priorityLabel(p.priority).toLowerCase()}`) : null);
    });
    quickInput.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      e.preventDefault();
      const text = quickInput.value.trim();
      if (!text) return;
      const p = parseQuickAdd(text);
      quickInput.disabled = true;
      const r = await A.createTask({ title: p.title, dueAt: p.dueAt, dueHasTime: p.dueHasTime, priority: p.priority });
      quickInput.disabled = false;
      if (!r.ok) {
        toast(r.error || 'Seu perfil não permite criar tarefas.');
        return quickInput.focus();
      }
      quickInput.value = '';
      replaceChildren(quickPreview);
      view = 'mine';
      draw();
      toast('Tarefa criada');
      quickInput.focus();
    });

    // ------------------------------------------------------------ barra: visões, modo, busca
    const tabs = h('div', { class: 'tasks-tabs', role: 'tablist', 'aria-label': 'Visões' });
    const modeBtns = [
      h('button', { class: 'tasks-mode', type: 'button', 'data-mode': 'list', title: 'Lista', 'aria-label': 'Ver em lista', onclick: () => setMode('list') }, icon(LIST, 18)),
      h('button', { class: 'tasks-mode tasks-mode--board', type: 'button', 'data-mode': 'board', title: 'Quadro', 'aria-label': 'Ver em quadro', onclick: () => setMode('board') }, icon(BOARD, 18)),
    ];
    const search = h('input', { class: 'input tasks-search', type: 'search', placeholder: 'Filtrar por título', 'aria-label': 'Filtrar tarefas', autocomplete: 'off' });
    search.addEventListener('input', () => {
      query = search.value;
      draw();
    });
    const newBtn = h('button', { class: 'btn btn--primary tasks-new', type: 'button', onclick: () => openTaskPanel({ onClose: () => draw() }) }, '+ Nova tarefa');
    const listHost = h('div', { class: 'tasks-list' });
    const setMode = (m) => {
      mode = m;
      save$('ttf:tasks:mode', m);
      draw();
    };

    // ------------------------------------------------------------ desenho
    const mineVisible = () => visible('task', A.allTasks());
    const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

    function chip(label, cls) {
      return h('span', { class: `tasks-chip${cls ? ` ${cls}` : ''}` }, label);
    }
    function row(t) {
      const dl = dueLabel(t);
      const deal = t.dealId ? store.deal(t.dealId) : null;
      const contact = !deal && t.contactId ? store.contact(t.contactId) : null;
      const prog = checklistProgress(t);
      const owner = t.ownerId !== ctx().userId ? store.userById(t.ownerId) : null;
      const canDo = A.can('update', t);
      return h(
        'div',
        { class: 'tasks-row' + (t.status === 'done' ? ' is-done' : ''), 'data-id': t.id },
        h('button', { class: 'tasks-check-btn', type: 'button', role: 'checkbox', 'aria-checked': String(t.status === 'done'), 'aria-label': t.status === 'done' ? `Reabrir: ${t.title}` : `Concluir: ${t.title}`, disabled: !canDo, onclick: (e) => { e.stopPropagation(); const r = A.toggleDone(t.id); if (r.ok === false) toast('Seu perfil não permite alterar esta tarefa.'); } }, icon(CHECK, 14)),
        h(
          'button',
          { class: 'tasks-row__main', type: 'button', onclick: () => openTaskPanel({ taskId: t.id }) },
          h('span', { class: 'tasks-row__title' }, t.title),
          h(
            'span',
            { class: 'tasks-row__meta' },
            t.priority !== 'normal' ? h('span', { class: `tasks-flag tasks-flag--${t.priority}`, title: `Prioridade ${priorityLabel(t.priority).toLowerCase()}` }, icon(FLAG, 13)) : null,
            t.status === 'waiting' ? chip('Aguardando', 'tasks-chip--wait') : t.status === 'doing' ? chip('Em andamento', 'tasks-chip--doing') : null,
            deal ? chip(deal.title, 'tasks-chip--link') : t.dealId ? chip('Negócio restrito', 'tasks-chip--link') : null,
            contact ? chip(contact.name, 'tasks-chip--link') : null,
            prog.total ? chip(`${prog.done}/${prog.total}`, 'tasks-chip--check') : null,
            t.dueAt ? chip(dl.text, `tasks-chip--due tasks-chip--${dl.tone}`) : null,
            (t.sharedWith || []).length ? chip('Compartilhada', 'tasks-chip--share') : null
          )
        ),
        owner ? h('span', { class: 'tasks-row__owner', title: `Responsável: ${owner.name}` }, avatar(owner.name, { small: true })) : null
      );
    }

    function drawList(tasks) {
      const groups = groupTasks(tasks);
      if (!groups.length) {
        return replaceChildren(
          listHost,
          h('div', { class: 'tasks-empty' }, h('div', { class: 'tasks-empty__title' }, view === 'mine' ? 'Nenhuma tarefa por aqui' : 'Nada nesta visão'), h('p', null, view === 'mine' ? 'Escreva no campo acima — ex.: “enviar proposta amanhã 10h” — e pressione Enter.' : 'Quando houver tarefas que combinem com esta visão, elas aparecem aqui.'))
        );
      }
      replaceChildren(
        listHost,
        ...groups.map((g) => {
          const collapsed = g.key === 'done' && !showDone;
          return h(
            'section',
            { class: `tasks-group tasks-group--${g.key}` },
            h('button', { class: 'tasks-group__head', type: 'button', 'aria-expanded': String(!collapsed), onclick: g.key === 'done' ? () => { showDone = !showDone; draw(); } : null, disabled: g.key !== 'done' }, h('span', { class: 'tasks-group__label' }, g.label), h('span', { class: 'tasks-group__count' }, g.tasks.length), g.key === 'done' ? h('span', { class: 'tasks-group__toggle' }, collapsed ? 'mostrar' : 'ocultar') : null),
            collapsed ? null : h('div', { class: 'tasks-group__rows' }, ...g.tasks.map(row))
          );
        })
      );
    }

    // ---- quadro: arrastar entre colunas muda o status (computador)
    let dragId = null;
    function card(t) {
      const dl = dueLabel(t);
      const prog = checklistProgress(t);
      const owner = store.userById(t.ownerId);
      const c = h(
        'article',
        { class: 'tasks-card' + (t.status === 'done' ? ' is-done' : ''), draggable: A.can('update', t) ? 'true' : 'false', tabindex: '0', onclick: () => openTaskPanel({ taskId: t.id }), onkeydown: (e) => (e.key === 'Enter' ? openTaskPanel({ taskId: t.id }) : null) },
        h('div', { class: 'tasks-card__title' }, t.title),
        h('div', { class: 'tasks-row__meta' }, t.priority !== 'normal' ? h('span', { class: `tasks-flag tasks-flag--${t.priority}` }, icon(FLAG, 13)) : null, t.dueAt ? chip(dl.text, `tasks-chip--due tasks-chip--${dl.tone}`) : null, prog.total ? chip(`${prog.done}/${prog.total}`, 'tasks-chip--check') : null, owner ? h('span', { class: 'tasks-card__owner', title: owner.name }, avatar(owner.name, { small: true })) : null)
      );
      c.addEventListener('dragstart', (e) => {
        dragId = t.id;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', t.id);
        requestAnimationFrame(() => c.classList.add('is-dragging'));
      });
      c.addEventListener('dragend', () => {
        dragId = null;
        c.classList.remove('is-dragging');
        listHost.querySelectorAll('.is-over').forEach((n) => n.classList.remove('is-over'));
      });
      return c;
    }
    function drawBoard(tasks) {
      replaceChildren(
        listHost,
        h(
          'div',
          { class: 'tasks-board' },
          ...boardColumns(tasks).map((col) => {
            const body = h('div', { class: 'tasks-col__body' }, ...col.tasks.map(card), col.tasks.length ? null : h('div', { class: 'tasks-col__empty' }, 'Solte uma tarefa aqui'));
            const section = h('section', { class: `tasks-col tasks-col--${col.id}`, 'data-status': col.id }, h('header', { class: 'tasks-col__head' }, h('span', null, col.label), h('span', { class: 'tasks-group__count' }, col.tasks.length)), body);
            section.addEventListener('dragover', (e) => {
              if (!dragId) return;
              e.preventDefault();
              section.classList.add('is-over');
            });
            section.addEventListener('dragleave', (e) => !section.contains(e.relatedTarget) && section.classList.remove('is-over'));
            section.addEventListener('drop', (e) => {
              e.preventDefault();
              section.classList.remove('is-over');
              const id = dragId;
              dragId = null;
              const t = A.allTasks().find((x) => x.id === id);
              if (t && t.status !== col.id) {
                const r = A.setStatus(id, col.id);
                if (r.ok === false) toast('Seu perfil não permite alterar esta tarefa.');
              }
            });
            return section;
          })
        )
      );
    }

    function draw() {
      const all = mineVisible();
      const c = ctx();
      const counts = viewCounts(all, c);
      // abas sem nenhuma tarefa (de qualquer status) somem, menos "Minhas"; a atual nunca some
      const present = (id) => id === 'mine' || id === view || viewTasks(all, id, c).length > 0;
      if (!present(view)) view = 'mine';
      replaceChildren(
        tabs,
        ...VIEWS.filter((v) => present(v.id)).map((v) =>
          h('button', { class: 'tasks-tab' + (v.id === view ? ' is-active' : ''), type: 'button', role: 'tab', 'aria-selected': String(v.id === view), onclick: () => { view = v.id; save$('ttf:tasks:view', v.id); draw(); } }, v.label, counts[v.id] ? h('span', { class: 'tasks-tab__n' }, counts[v.id]) : null)
        )
      );
      for (const b of modeBtns) b.classList.toggle('is-active', b.dataset.mode === mode);
      const q = norm(query.trim());
      const tasks = viewTasks(all, view, c).filter((t) => !q || norm(t.title).includes(q));
      // o quadro é de computador (arrastar); no celular a lista é o único modo
      if (mode === 'board' && !isMobile()) drawBoard(tasks);
      else drawList(tasks);
      el.dataset.mode = mode;
      newBtn.hidden = !A.canCreate();
      quickInput.disabled = !A.canCreate();
      if (!A.canCreate()) quickInput.placeholder = 'Seu perfil não permite criar tarefas';
    }

    replaceChildren(
      el,
      h(
        'div',
        { class: 'page tasks' },
        h('header', { class: 'page-header' }, h('div', { class: 'grow' }, h('div', { class: 'eyebrow' }, 'PRODUTIVIDADE'), h('h1', { class: 'page-title' }, 'TAREFAS')), newBtn),
        h('div', { class: 'tasks-quick-wrap' }, quickInput, quickPreview, quickHint),
        h('div', { class: 'tasks-toolbar' }, tabs, h('div', { class: 'tasks-toolbar__right' }, search, h('div', { class: 'tasks-modes' }, ...modeBtns))),
        listHost
      )
    );
    draw();
    // chegou tarefa nova / alguém delegou: o store avisa (agrupa vários avisos num só desenho)
    const unsub = store.subscribe(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(draw);
    });
    return () => {
      cancelAnimationFrame(raf);
      unsub();
    };
  },
};

