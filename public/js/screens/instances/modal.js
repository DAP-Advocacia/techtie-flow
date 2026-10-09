// Modal acessível da tela: role=dialog, foco preso, Esc e clique fora fecham,
// foco volta ao gatilho. Suporta pilha (um diálogo aberto de dentro de outro):
// só o do topo reage ao Esc/Tab. O resto do app fica `inert` enquanto aberto.
import { h, icon } from '../../ui.js';
import { ICON } from './channels.js';

const stack = [];
let seq = 0;
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

const focusables = (root) => [...root.querySelectorAll(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);

function setInert(on) {
  const app = document.getElementById('app');
  if (!app) return;
  if (on) app.setAttribute('inert', '');
  else app.removeAttribute('inert');
}

function onKey(e) {
  const top = stack[stack.length - 1];
  if (!top) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    top.close();
    return;
  }
  if (e.key !== 'Tab') return;
  const items = focusables(top.dialog);
  if (!items.length) {
    e.preventDefault();
    top.dialog.focus();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (!top.dialog.contains(active)) {
    e.preventDefault();
    first.focus();
  } else if (e.shiftKey && (active === first || active === top.dialog)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

/**
 * openModal({ title, eyebrow, size: 'sm'|'md'|'lg', returnFocus, onClose })
 * `returnFocus()` devolve o elemento a focar ao fechar (o gatilho original pode
 * ter sido recriado por um re-render). `canClose()` pode devolver false para
 * ignorar Esc/X/clique fora (ação em andamento); `close({ force: true })` ignora
 * a trava (saída da tela). Devolve { body, foot, dialog, setTitle, close, focus }.
 */
export function openModal({ title = '', eyebrow = '', size = 'md', returnFocus, onClose, canClose } = {}) {
  const opener = document.activeElement;
  const titleId = `instances-modal-title-${++seq}`;
  const eyebrowEl = h('div', { class: 'eyebrow' }, eyebrow);
  const titleEl = h('h2', { class: 'instances-modal__title', id: titleId }, title);
  const body = h('div', { class: 'instances-modal__body' });
  const foot = h('div', { class: 'instances-modal__foot' });
  const api = {
    body,
    foot,
    isOpen: true,
    setTitle(t, e = '') {
      titleEl.textContent = t;
      eyebrowEl.textContent = e;
      eyebrowEl.hidden = !e;
    },
    /** Foca `el`; sem `el`, garante que o foco continue dentro do diálogo. */
    focus(el) {
      if (el) el.focus();
      else if (!dialog.contains(document.activeElement)) dialog.focus();
    },
    close({ force = false } = {}) {
      if (!api.isOpen) return;
      if (!force && canClose && !canClose()) return;
      api.isOpen = false;
      const i = stack.indexOf(entry);
      if (i >= 0) stack.splice(i, 1);
      overlay.remove();
      if (!stack.length) {
        document.removeEventListener('keydown', onKey, true);
        setInert(false);
      }
      try {
        onClose?.();
      } finally {
        const target = returnFocus?.() || opener;
        if (target?.isConnected) target.focus();
      }
    },
  };
  const closeBtn = h('button', { class: 'instances-modal__x', type: 'button', 'aria-label': 'Fechar', onclick: () => api.close() }, icon(ICON.x, 16));
  const dialog = h(
    'div',
    { class: `instances-modal instances-modal--${size}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' },
    h('header', { class: 'instances-modal__head' }, h('div', { class: 'instances-modal__titles' }, eyebrowEl, titleEl), closeBtn),
    body,
    foot
  );
  eyebrowEl.hidden = !eyebrow;
  // mousedown (não click): arrastar para selecionar texto e soltar fora não fecha.
  const overlay = h('div', { class: 'instances-overlay', onmousedown: (e) => e.target === overlay && api.close() }, dialog);
  const entry = { dialog, close: api.close };

  if (!stack.length) {
    document.addEventListener('keydown', onKey, true);
    setInert(true);
  }
  stack.push(entry);
  document.body.append(overlay);
  dialog.focus();
  return api;
}

/** Fecha todos os modais (saída da tela). */
export function closeAllModals() {
  for (const e of [...stack].reverse()) e.close({ force: true });
}
