// Quadro Kanban: colunas por etapa + cartões com drag-and-drop HTML5.
// Só recebe negócios JÁ filtrados pelo motor (`deals`) e decide arrastar/soltar perguntando
// ao motor a cada destino (perm.moveDecision): coluna negada não aceita o drop.
import { store } from '../../store.js';
import { h, icon, avatar, fmtBRL, timeAgo, replaceChildren } from '../../ui.js';
import { dealsInStage } from './actions.js';
import { moveDecision, previewAllowed, reasonOf } from './perm.js';

const MOVE_ICON = 'M5 12h14M13 6l6 6-6 6';
const MASK = '•••';

// O dataTransfer não é legível em dragover (só no drop), então guardamos o id aqui.
let dragId = null;
let dragHost = null;

export function clearDrag() {
  dragId = null;
  if (dragHost) {
    dragHost.classList.remove('is-dragging');
    dragHost.querySelectorAll('.is-over, .is-dragging-card, .is-blocked').forEach((n) => n.classList.remove('is-over', 'is-dragging-card', 'is-blocked'));
    dragHost.querySelectorAll('[data-block]').forEach((n) => n.removeAttribute('data-block'));
  }
  dragHost = null;
}

/** Rola o quadro quando o cursor chega perto da borda durante o arraste. */
export function autoScroll(e, host) {
  if (!dragId) return;
  const r = host.getBoundingClientRect();
  const edge = 70;
  if (e.clientX < r.left + edge) host.scrollLeft -= 18;
  else if (e.clientX > r.right - edge) host.scrollLeft += 18;
  if (e.clientY < r.top + 50) host.scrollTop -= 14;
  else if (e.clientY > r.bottom - 50) host.scrollTop += 14;
}

/** Marca as colunas que NÃO aceitam o negócio arrastado (motivo no rótulo). */
function markBlocked(host, dealId) {
  const deal = store.deal(dealId);
  if (!deal) return;
  host.querySelectorAll('.pipeline-col').forEach((col) => {
    if (col.dataset.stageId === deal.stageId) return;
    const dec = moveDecision(deal, store.stage(col.dataset.stageId));
    if (dec.effect === 'allow') return;
    col.classList.add('is-blocked');
    col.querySelector('.pipeline-col__list')?.setAttribute('data-block', `${dec.effect === 'approval' ? 'Requer aprovação' : 'Bloqueado'} · ${reasonOf(dec, 'mover este negócio')}`);
  });
}

function card(d, { stages, selected, hideValue, onSelect, onOpenMenu }) {
  const contact = store.contact(d.contactId);
  const owner = store.userById(d.ownerId);
  const age = timeAgo(d.stageChangedAt || d.createdAt || Date.now());
  const movable = stages.some((st) => st.id !== d.stageId && moveDecision(d, st).effect === 'allow');
  const preview = d.lastMessage && previewAllowed(d) ? d.lastMessage : '';
  const moveBtn = h(
    'button',
    {
      class: 'pipeline-card__move',
      type: 'button',
      'aria-label': `Mover “${d.title}” para…`,
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
      'data-focus': `move:${d.id}`,
      onclick: (e) => {
        e.stopPropagation();
        onOpenMenu(d, moveBtn);
      },
    },
    icon(MOVE_ICON, 14)
  );
  const el = h(
    'article',
    {
      class: 'pipeline-card' + (selected ? ' is-selected' : '') + (movable ? '' : ' is-fixed'),
      draggable: movable ? 'true' : 'false',
      tabindex: '0',
      'aria-current': selected ? 'true' : null,
      'aria-label': `${d.title}. ${contact?.company || 'Sem empresa'}.${hideValue ? '' : ` ${fmtBRL(d.value)}.`} Tempo nesta etapa: ${age}.${preview ? ` Última mensagem: ${preview}` : ''}`,
      'data-deal-id': d.id,
      'data-focus': `card:${d.id}`,
      onclick: () => onSelect(d.id),
      onkeydown: (e) => {
        if (e.target !== el) return; // teclas dentro do botão "mover" são dele
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(d.id);
        } else if (e.key.toLowerCase() === 'm' && !e.ctrlKey && !e.altKey && !e.metaKey) {
          e.preventDefault();
          onOpenMenu(d, moveBtn, el);
        }
      },
      ondragstart: (e) => {
        if (!movable) {
          e.preventDefault();
          return;
        }
        dragId = d.id;
        dragHost = el.closest('.pipeline-board');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', d.id);
        // Adia a classe: aplicar no mesmo tick escurece também a imagem do arraste.
        requestAnimationFrame(() => {
          if (dragId !== d.id) return;
          el.classList.add('is-dragging-card');
          dragHost?.classList.add('is-dragging');
          markBlocked(dragHost, d.id);
        });
      },
      ondragend: clearDrag,
    },
    h('div', { class: 'pipeline-card__top' }, h('span', { class: 'pipeline-card__title' }, d.title), owner ? avatar(owner.name, { small: true }) : avatar('?', { small: true })),
    h('span', { class: 'pipeline-card__company' }, contact?.company || 'Sem empresa'),
    h(
      'div',
      { class: 'pipeline-card__row' },
      hideValue ? h('span', { class: 'pipeline-card__value pipeline-card__value--hidden num', 'aria-label': 'Valor oculto' }, MASK) : h('span', { class: 'pipeline-card__value num' }, fmtBRL(d.value)),
      moveBtn,
      h('span', { class: 'pipeline-card__age', title: 'Tempo nesta etapa' }, age)
    ),
    preview ? h('div', { class: 'pipeline-card__wa' }, h('span', { 'aria-hidden': 'true' }, '●'), h('span', { class: 'pipeline-card__wa-text' }, preview)) : null
  );
  return el;
}

function column(stage, { stages, deals, selectedId, hideValue, canMoveAny, onSelect, onMove, onOpenMenu }) {
  const inStage = dealsInStage(stage.id, deals);
  const total = inStage.reduce((n, d) => n + (Number(d.value) || 0), 0);
  const list = h(
    'div',
    { class: 'pipeline-col__list' },
    ...inStage.map((d) => card(d, { stages, selected: d.id === selectedId, hideValue, onSelect, onOpenMenu })),
    inStage.length ? null : h('div', { class: 'pipeline-col__empty' }, canMoveAny ? 'Solte um negócio aqui' : 'Nenhum negócio')
  );
  const col = h(
    'section',
    {
      class: 'pipeline-col',
      'aria-label': `Etapa ${stage.name}`,
      'data-stage-id': stage.id,
      ondragover: (e) => {
        if (!dragId) return;
        const d = store.deal(dragId);
        if (!d || d.stageId === stage.id) return; // soltar na própria coluna não faz nada: cursor "proibido"
        // Coluna negada pelo motor (ou que só aceitaria com aprovação): NÃO aceita o drop.
        if (moveDecision(d, stage).effect !== 'allow') {
          e.dataTransfer.dropEffect = 'none';
          return;
        }
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        col.classList.add('is-over');
      },
      ondragleave: (e) => {
        if (!col.contains(e.relatedTarget)) col.classList.remove('is-over');
      },
      ondrop: (e) => {
        if (!dragId) return;
        e.preventDefault();
        const id = dragId;
        // Limpa já: o re-render troca o nó de origem e o dragend pode nunca chegar.
        clearDrag();
        const d = store.deal(id);
        // onMove re-consulta o motor (toast com o motivo se negado): o drop não é confiável por si só.
        if (d && d.stageId !== stage.id) onMove(id, stage.id);
      },
    },
    h(
      'div',
      { class: 'pipeline-col__head', style: { borderBottomColor: stage.accent } },
      h('span', { class: 'pipeline-col__name' }, stage.name, ' ', h('span', { class: 'pipeline-col__count' }, inStage.length)),
      hideValue ? h('span', { class: 'pipeline-col__total pipeline-col__total--hidden num', 'aria-label': 'Total oculto' }, MASK) : h('span', { class: 'pipeline-col__total num' }, fmtBRL(total))
    ),
    list
  );
  return col;
}

export function renderBoard(host, { pipeline, deals, selectedId, levels, onSelect, onMove, onOpenMenu }) {
  const stages = pipeline?.stages || [];
  const hideValue = levels?.value === 'hidden';
  // O usuário consegue mover ALGUM negócio visível? (muda o texto das colunas vazias)
  const canMoveAny = deals.some((d) => d.pipelineId === pipeline?.id && stages.some((st) => st.id !== d.stageId && moveDecision(d, st).effect === 'allow'));
  replaceChildren(
    host,
    ...stages.map((st) => column(st, { stages, deals, selectedId, hideValue, canMoveAny, onSelect, onMove, onOpenMenu })),
    stages.length ? null : h('div', { class: 'empty', style: { flex: '1' } }, 'Este pipeline ainda não tem etapas.')
  );
}
