// Utilidades de UI da tela de Permissões.
import { h } from '../../ui.js';

/**
 * Executa `render()` (que refaz a árvore dentro de `root`) sem a pessoa perceber:
 * devolve o foco ao controle que o tinha (marcado com data-fk, com cursor/seleção
 * de campos de texto) e restaura a rolagem da página e de contêineres
 * marcados com data-scroll. É o que permite re-renderizar por mudança do store
 * sem interromper quem está digitando ou navegando por teclado.
 */
export function keepUi(root, render) {
  const active = document.activeElement;
  const inside = active && active !== document.body && root.contains(active);
  const fk = inside ? active.dataset?.fk : null;
  const sel = inside && fk && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
  const scrolls = [...root.querySelectorAll('[data-scroll]')].map((el) => [el.dataset.scroll, el.scrollLeft, el.scrollTop]);
  const page = root.closest('.page');
  const pageTop = page ? page.scrollTop : 0;

  render();

  if (page) page.scrollTop = pageTop;
  for (const [k, left, top] of scrolls) {
    const el = root.querySelector(`[data-scroll="${CSS.escape(k)}"]`);
    if (el) {
      el.scrollLeft = left;
      el.scrollTop = top;
    }
  }
  if (fk) {
    const el = root.querySelector(`[data-fk="${CSS.escape(fk)}"]`);
    if (el && el !== document.activeElement) {
      el.focus({ preventScroll: true });
      if (sel && typeof el.setSelectionRange === 'function') {
        try {
          el.setSelectionRange(sel[0], sel[1]);
        } catch {
          /* tipos de input sem seleção (number/email): sem problema */
        }
      }
    }
  }
}

let uid = 0;
export const nextId = (prefix = 'perm') => `${prefix}-${++uid}`;

/** <select> rotulado. options: [{ value, label, disabled?, group? }]. */
export function selectEl({ options, value, label, fk, onChange, disabled = false, cls = '', id, describedBy }) {
  const groups = new Map();
  const nodes = [];
  for (const o of options) {
    const opt = h('option', { value: o.value, selected: o.value === value, disabled: o.disabled }, o.label);
    if (o.group) {
      if (!groups.has(o.group)) {
        const g = h('optgroup', { label: o.group });
        groups.set(o.group, g);
        nodes.push(g);
      }
      groups.get(o.group).append(opt);
    } else nodes.push(opt);
  }
  const el = h('select', { class: `select ${cls}`.trim(), 'aria-label': label, 'data-fk': fk, disabled, id, 'aria-describedby': describedBy, onchange: (e) => onChange?.(e.target.value, e) }, nodes);
  el.value = value ?? '';
  return el;
}

/** Texto só para leitores de tela. */
export const sr = (text) => h('span', { class: 'perm-sr' }, text);

/** Linha de campo com rótulo visível, erro e dica. */
export function field(label, control, { error, hint, id } = {}) {
  const errId = error ? `${id || nextId('err')}-err` : null;
  return h('div', { class: 'perm-field' }, h('label', { class: 'perm-field__label', for: id }, label), control, error ? h('div', { class: 'field-error', id: errId, role: 'alert' }, error) : null, hint ? h('div', { class: 'perm-hint' }, hint) : null);
}

export const ICON = {
  plus: 'M12 5v14M5 12h14',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  copy: 'M9 9h11v11H9zM5 15V4h11',
  close: 'M6 6l12 12M18 6L6 18',
  check: 'M5 12l5 5 9-10',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
};
