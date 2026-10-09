// Diálogo modal e popover acessíveis, locais da tela de Permissões (o shell não
// oferece um modal compartilhado). Modal: role=dialog, aria-modal, Esc fecha,
// Tab fica preso dentro e o foco volta ao gatilho. Popover: painel ancorado a um
// botão, fecha com Esc/clique fora e devolve o foco.
import { h } from '../../ui.js';

const stack = [];
let seq = 0;
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function onKeydown(e) {
  const top = stack[stack.length - 1];
  if (!top) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    if (!top.locked) top.close();
    return;
  }
  if (e.key !== 'Tab') return;
  const items = [...top.dialog.querySelectorAll(FOCUSABLE)].filter((x) => x.offsetParent !== null);
  if (!items.length) {
    e.preventDefault();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const inside = top.dialog.contains(document.activeElement);
  if (e.shiftKey && (document.activeElement === first || !inside)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
    e.preventDefault();
    first.focus();
  }
}

/**
 * openDialog({ eyebrow, title, content, footer, width, onClose, danger })
 * Devolve { close, el } — `el` é o <div role=dialog> (para atualizar o conteúdo).
 */
export function openDialog({ eyebrow, title, content, footer, width = 560, onClose, danger = false }) {
  const prevFocus = document.activeElement;
  const titleId = `perm-dlg-title-${++seq}`;
  const body = h('div', { class: 'perm-dialog__body' }, content);
  const foot = h('div', { class: 'perm-dialog__foot' }, footer);
  const dialog = h(
    'div',
    { class: 'perm-dialog' + (danger ? ' perm-dialog--danger' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, style: { width: `min(${width}px, calc(100vw - 32px))` } },
    h('div', { class: 'perm-dialog__head' }, eyebrow ? h('div', { class: 'label' }, eyebrow) : null, h('h2', { class: 'perm-dialog__title', id: titleId }, title)),
    body,
    footer ? foot : null
  );
  const entry = { dialog, locked: false, close };
  // mousedown (não click): soltar uma seleção de texto fora do diálogo não deve fechá-lo.
  const overlay = h('div', { class: 'perm-overlay', onmousedown: (e) => { if (e.target === overlay && !entry.locked) close(); } }, dialog);

  function close() {
    const i = stack.indexOf(entry);
    if (i === -1) return;
    stack.splice(i, 1);
    overlay.remove();
    if (!stack.length) document.removeEventListener('keydown', onKeydown, true);
    if (prevFocus && prevFocus !== document.body && prevFocus.isConnected) prevFocus.focus();
    onClose?.();
  }

  stack.push(entry);
  if (stack.length === 1) document.addEventListener('keydown', onKeydown, true);
  document.body.append(overlay);
  (dialog.querySelector('[data-autofocus]') || dialog.querySelector(FOCUSABLE))?.focus();
  return { close, el: dialog, body, foot };
}

/** Fecha todos os diálogos (limpeza ao sair da tela). */
export function closeAllDialogs() {
  [...stack].reverse().forEach((d) => d.close());
}

/**
 * confirmDialog({ title, message, confirmLabel, cancelLabel, danger, extra, third })
 * Promise<boolean> (ou o id de `third` = { label, id } quando houver uma 3ª opção).
 */
export function confirmDialog({ eyebrow, title, message, confirmLabel = 'Confirmar', cancelLabel = 'Cancelar', danger = false, extra = null, third = null }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      dlg.close();
      resolve(v);
    };
    const dlg = openDialog({
      eyebrow,
      title,
      danger,
      width: 480,
      content: [h('p', { class: 'perm-dialog__text' }, message), extra],
      footer: [
        h('button', { class: 'btn btn--quiet', type: 'button', onclick: () => finish(false) }, cancelLabel),
        third ? h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => finish(third.id) }, third.label) : null,
        h('button', { class: 'btn btn--primary' + (danger ? ' perm-btn--danger' : ''), type: 'button', 'data-autofocus': true, onclick: () => finish(true) }, confirmLabel),
      ],
      onClose: () => finish(false),
    });
  });
}

// ---------------------------------------------------------------------------
// Popover
// ---------------------------------------------------------------------------
let openPop = null;

/** Fecha o popover aberto (se houver). */
export function closePopover() {
  openPop?.close();
}

/**
 * openPopover(anchor, { label, content, width, onClose }) — painel abaixo do
 * `anchor` (position: fixed, reposiciona se não couber). Esc/clique fora fecham.
 */
export function openPopover(anchor, { label, content, width = 320, onClose }) {
  closePopover();
  const panel = h('div', { class: 'perm-pop', role: 'dialog', 'aria-label': label, style: { width: `${width}px` } }, content);
  const place = () => {
    const r = anchor.getBoundingClientRect();
    const left = Math.max(12, Math.min(r.left, window.innerWidth - width - 12));
    panel.style.left = `${left}px`;
    const below = r.bottom + 6;
    const fits = below + panel.offsetHeight <= window.innerHeight - 12;
    panel.style.top = `${fits ? below : Math.max(12, r.top - 6 - panel.offsetHeight)}px`;
  };
  const onDocDown = (e) => {
    if (!panel.contains(e.target) && !anchor.contains(e.target)) close();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  function close() {
    if (openPop !== api) return;
    openPop = null;
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', place);
    panel.remove();
    if (anchor.isConnected) anchor.focus();
    onClose?.();
  }
  const api = { close, el: panel, place };
  openPop = api;
  document.body.append(panel);
  place();
  document.addEventListener('mousedown', onDocDown, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', place);
  (panel.querySelector('[data-autofocus]') || panel.querySelector(FOCUSABLE))?.focus();
  return api;
}
