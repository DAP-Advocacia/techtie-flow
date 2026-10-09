// Modal acessível mínimo (role=dialog, Esc fecha, Tab preso dentro, foco volta
// ao gatilho). Local à tela porque o shell não oferece um modal compartilhado.
import { h } from '../../ui.js';

const stack = [];
let seq = 0;

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function onKeydown(e) {
  const top = stack[stack.length - 1];
  if (!top) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    if (!top.locked) top.close();
    return;
  }
  if (e.key === 'Tab') {
    const items = [...top.dialog.querySelectorAll(FOCUSABLE)].filter((x) => x.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || !top.dialog.contains(document.activeElement))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (document.activeElement === last || !top.dialog.contains(document.activeElement))) {
      e.preventDefault();
      first.focus();
    }
  }
}

/**
 * openModal({ eyebrow, title, content, footer, width, onClose })
 * `restoreFocus()` indica onde devolver o foco se o gatilho original sumiu do DOM (ex.: item de menu já fechado).
 * Devolve { close, setLocked } — `locked` impede fechar (Esc/clique fora) durante uma ação em andamento.
 */
export function openModal({ eyebrow, title, content, footer, width = 480, onClose, restoreFocus }) {
  const prevFocus = document.activeElement;
  const titleId = `pipeline-modal-title-${++seq}`;
  const dialog = h(
    'div',
    { class: 'pipeline-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, style: { width: `min(${width}px, calc(100vw - 32px))` } },
    h('div', { class: 'pipeline-modal__head' }, eyebrow ? h('div', { class: 'label' }, eyebrow) : null, h('h2', { class: 'pipeline-modal__title', id: titleId }, title)),
    h('div', { class: 'pipeline-modal__body' }, content),
    footer ? h('div', { class: 'pipeline-modal__foot' }, footer) : null
  );
  const entry = { dialog, locked: false, close };
  // mousedown (não click): selecionar texto dentro do input e soltar fora não deve fechar.
  const overlay = h('div', { class: 'pipeline-overlay', onmousedown: (e) => { if (e.target === overlay && !entry.locked) close(); } }, dialog);

  function close() {
    const i = stack.indexOf(entry);
    if (i === -1) return;
    stack.splice(i, 1);
    overlay.remove();
    if (!stack.length) document.removeEventListener('keydown', onKeydown, true);
    const back = prevFocus && prevFocus !== document.body && prevFocus.isConnected ? prevFocus : restoreFocus?.();
    back?.focus();
    onClose?.();
  }

  stack.push(entry);
  if (stack.length === 1) document.addEventListener('keydown', onKeydown, true);
  document.body.append(overlay);
  (dialog.querySelector('[data-autofocus]') || dialog.querySelector(FOCUSABLE))?.focus();

  return {
    close,
    setLocked(v) {
      entry.locked = !!v;
    },
  };
}

/** Fecha todos (limpeza ao sair da tela). */
export function closeAllModals() {
  [...stack].reverse().forEach((m) => m.close());
}
