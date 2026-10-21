// Painel da tarefa (gaveta à direita; tela cheia no celular): criar, editar, checklist, delegar, compartilhar,
// comentários e histórico. Tarefa existente salva CADA campo ao sair dele (sem botão "salvar"); a nova tem "Criar".
// O que a pessoa não pode fazer (editar, delegar, compartilhar, excluir) fica desabilitado, com o motivo.
import { h, icon, replaceChildren, toast, avatar } from '../../ui.js';
import { store } from '../../store.js';
import { visible } from '../../access.js';
import { ensureTasksCss } from './css.js';
import * as A from './actions.js';
import { STATUSES, PRIORITIES, dueFrom, startOfDay, dueLabel, checklistProgress } from './model.js';

const CLOSE = 'M18 6L6 18M6 6l12 12';
const TRASH = 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6';
const uid = () => `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const pad2 = (n) => String(n).padStart(2, '0');
const when = (at) => new Date(at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const dateValue = (ms) => (ms ? `${new Date(ms).getFullYear()}-${pad2(new Date(ms).getMonth() + 1)}-${pad2(new Date(ms).getDate())}` : '');
const timeValue = (t) => (t.dueAt && t.dueHasTime ? `${pad2(new Date(t.dueAt).getHours())}:${pad2(new Date(t.dueAt).getMinutes())}` : '');

let openPanel = null; // só um painel por vez

/**
 * @param taskId  tarefa existente (edição) — ou null para criar
 * @param defaults  { dealId, contactId, ownerId, title, dueAt, dueHasTime, priority } para a criação
 * @param onClose  chamado ao fechar ({ created? })
 */
export function openTaskPanel({ taskId = null, defaults = {}, onClose } = {}) {
  ensureTasksCss();
  openPanel?.close();
  const prevFocus = document.activeElement;
  const editing = !!taskId;
  let alive = true;
  let seenUpdated = null;
  let confirmDelete = false;

  const task = () => (taskId ? A.allTasks().find((t) => t.id === taskId) : null);
  // rascunho da tarefa nova (na edição, os campos leem/gravam a tarefa de verdade)
  const draft = { title: defaults.title || '', description: '', dueAt: defaults.dueAt ?? null, dueHasTime: !!defaults.dueHasTime, priority: defaults.priority || 'normal', ownerId: defaults.ownerId || store.state.currentUserId, dealId: defaults.dealId || null, contactId: defaults.contactId || null, checklist: [] };
  const val = (k) => (editing ? task()?.[k] : draft[k]);
  const writable = () => (editing ? !!task() && A.can('update', task()) : A.canCreate());
  const why = () => (editing && task() && !A.can('update', task()) ? 'Você só pode ler esta tarefa.' : '');

  // grava um campo (edição: imediato; criação: no rascunho)
  function put(patch) {
    if (!editing) return Object.assign(draft, patch);
    const r = A.patchTask(taskId, patch);
    if (!r.ok) {
      toast(r.error || 'Seu perfil não permite alterar esta tarefa.');
      refresh();
    }
    return r;
  }

  // ------------------------------------------------------------------ campos
  const titleInput = h('input', { class: 'input tasks-title', type: 'text', maxlength: '500', placeholder: 'O que precisa ser feito?', 'aria-label': 'Título da tarefa', value: val('title') || '' });
  titleInput.addEventListener('blur', () => {
    const v = titleInput.value.trim();
    if (!editing) return put({ title: v });
    if (!v) {
      titleInput.value = task()?.title || '';
      return;
    }
    if (v !== task()?.title) put({ title: v });
  });
  titleInput.addEventListener('keydown', (e) => e.key === 'Enter' && titleInput.blur());

  const statusSel = h('select', { class: 'select', 'aria-label': 'Status' }, STATUSES.map((s) => h('option', { value: s.id }, s.label)));
  statusSel.addEventListener('change', () => put({ status: statusSel.value }));

  const prioBtns = PRIORITIES.map((p) => h('button', { class: 'tasks-prio', type: 'button', 'data-prio': p.id, role: 'radio', onclick: () => { put({ priority: p.id }); syncPrio(); } }, p.label));
  const prio = h('div', { class: 'tasks-seg', role: 'radiogroup', 'aria-label': 'Prioridade' }, prioBtns);
  function syncPrio() {
    const cur = val('priority') || 'normal';
    for (const b of prioBtns) {
      b.classList.toggle('is-active', b.dataset.prio === cur);
      b.setAttribute('aria-checked', String(b.dataset.prio === cur));
    }
  }

  const dateInput = h('input', { class: 'input', type: 'date', 'aria-label': 'Data do prazo', value: dateValue(val('dueAt')) });
  const timeInput = h('input', { class: 'input', type: 'time', 'aria-label': 'Hora do prazo', value: timeValue({ dueAt: val('dueAt'), dueHasTime: val('dueHasTime') }) });
  function commitDue() {
    let day = dateInput.value;
    const time = timeInput.value;
    if (!day && time) {
      day = dateValue(Date.now());
      dateInput.value = day;
    }
    if (!day) {
      put({ dueAt: null, dueHasTime: false });
      timeInput.value = '';
      return;
    }
    const [y, m, d] = day.split('-').map(Number);
    const [hh, mm] = time ? time.split(':').map(Number) : [null, 0];
    put({ dueAt: dueFrom(new Date(y, m - 1, d).getTime(), hh, mm), dueHasTime: !!time });
  }
  dateInput.addEventListener('change', commitDue);
  timeInput.addEventListener('change', commitDue);
  const quick = (label, fn) => h('button', { class: 'tasks-chipbtn', type: 'button', onclick: () => { fn(); commitDue(); } }, label);
  const dayBtn = (n) => () => (dateInput.value = dateValue(new Date(new Date(startOfDay(new Date())).getFullYear(), new Date().getMonth(), new Date().getDate() + n, 12).getTime()));
  const nextMonday = () => { const t = new Date(); const add = ((8 - t.getDay()) % 7) || 7; dateInput.value = dateValue(new Date(t.getFullYear(), t.getMonth(), t.getDate() + add, 12).getTime()); };
  const quickRow = h('div', { class: 'tasks-quick' }, quick('Hoje', dayBtn(0)), quick('Amanhã', dayBtn(1)), quick('Segunda', nextMonday), quick('Sem prazo', () => { dateInput.value = ''; timeInput.value = ''; }));

  const users = () => store.state.users.filter((u) => !u.isBot && u.status === 'active');
  const ownerSel = h('select', { class: 'select', 'aria-label': 'Responsável' });
  function fillOwner() {
    const cur = val('ownerId');
    const list = users();
    if (cur && !list.some((u) => u.id === cur)) list.push(store.userById(cur) || { id: cur, name: 'Usuário' });
    replaceChildren(ownerSel, ...list.map((u) => h('option', { value: u.id, selected: u.id === cur }, u.id === store.state.currentUserId ? `${u.name} (eu)` : u.name)));
    ownerSel.value = cur;
  }
  ownerSel.addEventListener('change', async () => {
    const to = ownerSel.value;
    if (!editing) return put({ ownerId: to });
    ownerSel.disabled = true;
    const r = await A.delegate(taskId, to);
    ownerSel.disabled = false;
    if (!r.ok) {
      toast(r.error || 'Seu perfil não permite delegar esta tarefa.');
      fillOwner();
    } else toast(to === store.state.currentUserId ? 'Você assumiu a tarefa' : `Tarefa delegada para ${store.userById(to)?.name || 'a pessoa'}`);
  });

  const dealSel = h('select', { class: 'select', 'aria-label': 'Negócio vinculado' });
  const contactSel = h('select', { class: 'select', 'aria-label': 'Contato vinculado' });
  function fillLinks() {
    const deals = visible('deal', store.state.deals).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 300);
    const contacts = visible('contact', store.state.contacts).sort((a, b) => String(a.name).localeCompare(String(b.name), 'pt-BR')).slice(0, 500);
    const dCur = val('dealId');
    const cCur = val('contactId');
    if (dCur && !deals.some((d) => d.id === dCur)) deals.unshift(store.deal(dCur) || { id: dCur, title: 'Negócio (sem acesso)' });
    if (cCur && !contacts.some((c) => c.id === cCur)) contacts.unshift(store.contact(cCur) || { id: cCur, name: 'Contato (sem acesso)' });
    replaceChildren(dealSel, h('option', { value: '' }, '— Nenhum —'), ...deals.map((d) => h('option', { value: d.id }, d.title)));
    replaceChildren(contactSel, h('option', { value: '' }, '— Nenhum —'), ...contacts.map((c) => h('option', { value: c.id }, c.company ? `${c.name} · ${c.company}` : c.name)));
    dealSel.value = dCur || '';
    contactSel.value = cCur || '';
  }
  dealSel.addEventListener('change', () => {
    const id = dealSel.value || null;
    const patch = { dealId: id };
    if (id && !contactSel.value) patch.contactId = store.deal(id)?.contactId || null; // o contato do negócio vem junto
    put(patch);
    fillLinks();
  });
  contactSel.addEventListener('change', () => put({ contactId: contactSel.value || null }));

  const descArea = h('textarea', { class: 'textarea', rows: '3', maxlength: '10000', placeholder: 'Detalhes, links, o que o cliente pediu…', 'aria-label': 'Descrição' });
  descArea.value = val('description') || '';
  descArea.addEventListener('blur', () => {
    if (!editing) return put({ description: descArea.value });
    if (descArea.value !== (task()?.description || '')) put({ description: descArea.value });
  });

  // ------------------------------------------------------------------ checklist
  const checkHost = h('div', { class: 'tasks-check' });
  const checkAdd = h('input', { class: 'input', type: 'text', maxlength: '300', placeholder: 'Adicionar item e pressionar Enter', 'aria-label': 'Novo item do checklist' });
  const list = () => (editing ? task()?.checklist || [] : draft.checklist);
  const setList = (next) => {
    put({ checklist: next });
    drawChecklist();
  };
  checkAdd.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const text = checkAdd.value.trim();
    if (!text) return;
    checkAdd.value = '';
    setList([...list(), { id: uid(), text, done: false }]);
    checkAdd.focus();
  });
  function drawChecklist() {
    const l = list();
    const ro = !writable();
    const { done, total } = checklistProgress({ checklist: l });
    replaceChildren(
      checkHost,
      total ? h('div', { class: 'tasks-check__bar', 'aria-label': `${done} de ${total} itens` }, h('i', { style: `width:${Math.round((done / total) * 100)}%` })) : null,
      ...l.map((it) =>
        h(
          'div',
          { class: 'tasks-check__row' + (it.done ? ' is-done' : '') },
          h('input', { type: 'checkbox', checked: it.done, disabled: ro, 'aria-label': `Concluir: ${it.text}`, onchange: (e) => setList(list().map((x) => (x.id === it.id ? { ...x, done: e.target.checked } : x))) }),
          h('input', { class: 'tasks-check__text', type: 'text', value: it.text, maxlength: '300', readonly: ro, 'aria-label': 'Texto do item', onchange: (e) => (e.target.value.trim() ? setList(list().map((x) => (x.id === it.id ? { ...x, text: e.target.value.trim() } : x))) : setList(list().filter((x) => x.id !== it.id))) }),
          ro ? null : h('button', { class: 'tasks-iconbtn', type: 'button', 'aria-label': `Remover item: ${it.text}`, onclick: () => setList(list().filter((x) => x.id !== it.id)) }, icon(CLOSE, 14))
        )
      )
    );
  }

  // ------------------------------------------------------------------ compartilhar (só edição)
  const shareHost = h('div', { class: 'tasks-block' });
  function drawShare() {
    const t = task();
    if (!t) return replaceChildren(shareHost);
    const can = A.can('share', t);
    const s = store.state;
    const entries = (t.sharedWith || []).map((g) => ({ ...g, name: g.type === 'user' ? s.users.find((u) => u.id === g.id)?.name : s.teams.find((x) => x.id === g.id)?.name }));
    const taken = new Set(entries.map((g) => `${g.type}:${g.id}`));
    const target = h('select', { class: 'select', 'aria-label': 'Compartilhar com' }, h('option', { value: '' }, 'Compartilhar com…'), h('optgroup', { label: 'Pessoas' }, ...users().filter((u) => u.id !== t.ownerId && !taken.has(`user:${u.id}`)).map((u) => h('option', { value: `user:${u.id}` }, u.name))), s.teams.some((x) => !taken.has(`team:${x.id}`)) ? h('optgroup', { label: 'Equipes' }, ...s.teams.filter((x) => !taken.has(`team:${x.id}`)).map((x) => h('option', { value: `team:${x.id}` }, x.name))) : null);
    const level = h('select', { class: 'select', 'aria-label': 'Nível de acesso' }, h('option', { value: 'read' }, 'Só ver'), h('option', { value: 'edit' }, 'Pode editar'));
    replaceChildren(
      shareHost,
      h('div', { class: 'tasks-label' }, 'Quem tem acesso'),
      h(
        'ul',
        { class: 'tasks-people' },
        h('li', null, avatar(s.users.find((u) => u.id === t.ownerId)?.name || '?', { small: true }), h('span', null, s.users.find((u) => u.id === t.ownerId)?.name || 'Sem responsável'), h('em', null, 'Responsável')),
        ...entries.map((g) =>
          h(
            'li',
            null,
            avatar(g.name || '?', { small: true }),
            h('span', null, `${g.type === 'team' ? 'Equipe · ' : ''}${g.name || g.id}`),
            h('em', null, g.level === 'edit' ? 'Pode editar' : 'Só ver'),
            can ? h('button', { class: 'tasks-iconbtn', type: 'button', 'aria-label': `Remover acesso de ${g.name || g.id}`, onclick: async () => { const r = await A.unshare(taskId, { type: g.type, id: g.id }); if (!r.ok) toast(r.error || 'Não foi possível remover.'); } }, icon(CLOSE, 14)) : null
          )
        )
      ),
      can
        ? h('form', { class: 'tasks-shareform', onsubmit: async (e) => { e.preventDefault(); const [type, id] = target.value.split(':'); if (!type) return; const r = await A.share(taskId, { type, id, level: level.value }); if (!r.ok) toast(r.error || 'Não foi possível compartilhar.'); } }, target, level, h('button', { class: 'btn btn--quiet btn--sm', type: 'submit' }, 'Compartilhar'))
        : h('p', { class: 'tasks-hint' }, 'Só quem pode compartilhar a tarefa (o responsável ou a gestão) altera os acessos.')
    );
  }

  // ------------------------------------------------------------------ comentários e histórico (só edição)
  const timelineHost = h('div', { class: 'tasks-block' });
  let comments = [];
  async function loadTimeline() {
    if (!editing) return;
    try {
      comments = await A.loadComments(taskId);
    } catch {
      comments = [];
    }
    if (alive) drawTimeline();
  }
  const commentInput = h('textarea', { class: 'textarea', rows: '2', maxlength: '5000', placeholder: 'Escreva um comentário…', 'aria-label': 'Comentário' });
  const commentBtn = h('button', { class: 'btn btn--primary btn--sm', type: 'button' }, 'Comentar');
  commentBtn.addEventListener('click', async () => {
    const text = commentInput.value.trim();
    if (!text) return;
    commentBtn.disabled = true;
    try {
      await A.addComment(taskId, text);
      commentInput.value = '';
      await loadTimeline();
    } catch (e) {
      toast(e.message || 'Não foi possível comentar.');
    }
    commentBtn.disabled = false;
  });
  function drawTimeline() {
    replaceChildren(
      timelineHost,
      h('div', { class: 'tasks-label' }, 'Atividade'),
      comments.length
        ? h(
            'ul',
            { class: 'tasks-timeline' },
            ...comments.map((c) =>
              h(
                'li',
                { class: c.kind === 'event' ? 'is-event' : 'is-comment' },
                c.kind === 'event' ? h('span', { class: 'tasks-dot' }) : avatar(store.userById(c.authorId)?.name || '?', { small: true }),
                h('div', null, c.kind === 'event' ? h('span', { class: 'tasks-event' }, c.text) : h('div', { class: 'tasks-comment' }, h('strong', null, store.userById(c.authorId)?.name || 'Alguém'), h('p', null, c.text)), h('time', null, when(c.at)))
              )
            )
          )
        : h('p', { class: 'tasks-hint' }, 'Nada por aqui ainda.'),
      h('div', { class: 'tasks-commentbox' }, commentInput, commentBtn)
    );
  }

  // ------------------------------------------------------------------ montagem
  const closeBtn = h('button', { class: 'tasks-iconbtn tasks-close', type: 'button', 'aria-label': 'Fechar', onclick: () => close() }, icon(CLOSE, 20));
  const headTitle = h('h2', { class: 'tasks-panel__title' });
  const dueChip = h('span', { class: 'tasks-due' });
  const note = h('p', { class: 'tasks-hint tasks-note', role: 'status' });
  const footer = h('footer', { class: 'tasks-panel__foot' });
  const body = h(
    'div',
    { class: 'tasks-panel__body' },
    titleInput,
    note,
    h('div', { class: 'tasks-grid' }, editing ? h('label', { class: 'tasks-field' }, h('span', { class: 'tasks-label' }, 'Status'), statusSel) : null, h('div', { class: 'tasks-field' }, h('span', { class: 'tasks-label' }, 'Prioridade'), prio)),
    h('div', { class: 'tasks-field' }, h('span', { class: 'tasks-label' }, 'Prazo ', dueChip), h('div', { class: 'tasks-grid tasks-grid--due' }, dateInput, timeInput), quickRow),
    h('label', { class: 'tasks-field' }, h('span', { class: 'tasks-label' }, 'Responsável'), ownerSel),
    h('div', { class: 'tasks-grid' }, h('label', { class: 'tasks-field' }, h('span', { class: 'tasks-label' }, 'Negócio'), dealSel), h('label', { class: 'tasks-field' }, h('span', { class: 'tasks-label' }, 'Contato'), contactSel)),
    h('label', { class: 'tasks-field' }, h('span', { class: 'tasks-label' }, 'Descrição'), descArea),
    h('div', { class: 'tasks-field' }, h('span', { class: 'tasks-label' }, 'Checklist'), checkHost, checkAdd),
    editing ? shareHost : null,
    editing ? timelineHost : null
  );
  const panel = h('aside', { class: 'tasks-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': editing ? 'Detalhes da tarefa' : 'Nova tarefa' }, h('header', { class: 'tasks-panel__head' }, headTitle, closeBtn), body, footer);
  const overlay = h('div', { class: 'tasks-overlay', onmousedown: (e) => e.target === overlay && close() }, panel);

  function drawFooter() {
    const t = task();
    if (!editing) {
      const create = h('button', { class: 'btn btn--primary', type: 'button' }, 'Criar tarefa');
      create.addEventListener('click', async () => {
        draft.title = titleInput.value.trim();
        if (!draft.title) {
          toast('Dê um título à tarefa.');
          return titleInput.focus();
        }
        create.disabled = true;
        const r = await A.createTask({ ...draft, ownerId: draft.ownerId });
        if (!r.ok) {
          create.disabled = false;
          toast(r.error || 'Seu perfil não permite criar tarefas.');
          return;
        }
        toast('Tarefa criada');
        close({ created: r.task });
      });
      replaceChildren(footer, h('button', { class: 'btn btn--quiet', type: 'button', onclick: () => close() }, 'Cancelar'), create);
      return;
    }
    const canDel = !!t && A.can('delete', t);
    replaceChildren(
      footer,
      canDel
        ? confirmDelete
          ? h('button', { class: 'btn btn--danger', type: 'button', onclick: () => { const r = A.removeTask(taskId); if (r.ok) { toast('Tarefa excluída'); close(); } else toast('Seu perfil não permite excluir.'); } }, 'Confirmar exclusão')
          : h('button', { class: 'btn btn--quiet', type: 'button', onclick: () => { confirmDelete = true; drawFooter(); setTimeout(() => { confirmDelete = false; if (alive) drawFooter(); }, 4000); } }, icon(TRASH, 16), ' Excluir')
        : h('span'),
      h('button', { class: 'btn btn--quiet', type: 'button', onclick: () => close() }, 'Fechar')
    );
  }

  /** Redesenha o que muda por fora (status, responsável, compartilhamento, leitura/edição) sem roubar o foco. */
  function refresh() {
    if (!alive) return;
    if (editing) {
      const t = task();
      if (!t) {
        toast('Esta tarefa não está mais disponível para você.');
        return close();
      }
      if (document.activeElement !== statusSel) statusSel.value = t.status;
      if (document.activeElement !== ownerSel) fillOwner();
      if (document.activeElement !== titleInput) titleInput.value = t.title;
      const ds = dueLabel(t);
      dueChip.textContent = t.dueAt ? `· ${ds.text}` : '';
      dueChip.className = `tasks-due tasks-due--${ds.tone}`;
      headTitle.textContent = t.status === 'done' ? 'Tarefa feita' : 'Tarefa';
      if (seenUpdated !== null && t.updatedAt !== seenUpdated) loadTimeline();
      seenUpdated = t.updatedAt;
      drawShare();
    } else {
      headTitle.textContent = 'Nova tarefa';
    }
    syncPrio();
    drawChecklist();
    const ro = !writable();
    for (const el of [titleInput, statusSel, dateInput, timeInput, descArea, checkAdd]) el.disabled = ro;
    for (const b of [...prioBtns, ...quickRow.children]) b.disabled = ro;
    dealSel.disabled = contactSel.disabled = ro;
    ownerSel.disabled = editing ? !A.canDelegate(task()) : !A.canDelegate();
    ownerSel.title = ownerSel.disabled ? 'Seu perfil não permite passar tarefas para outra pessoa.' : '';
    note.textContent = why();
    note.hidden = !note.textContent;
    drawFooter();
  }

  const unsub = store.subscribe(refresh);
  const onKey = (e) => e.key === 'Escape' && close();
  document.addEventListener('keydown', onKey, true);

  function close(result) {
    if (!alive) return;
    alive = false;
    unsub();
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    document.body.classList.remove('tasks-lock');
    if (openPanel?.overlay === overlay) openPanel = null;
    prevFocus?.focus?.();
    onClose?.(result || {});
  }

  fillOwner();
  fillLinks();
  document.body.append(overlay);
  document.body.classList.add('tasks-lock');
  refresh();
  if (editing) loadTimeline();
  else titleInput.focus();
  openPanel = { close, overlay };
  return { close };
}
