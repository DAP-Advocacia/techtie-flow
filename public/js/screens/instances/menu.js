// Menu "⋯" do cartão. Posicionado com position:fixed a partir do botão (a área
// da página rola e cortaria um menu absoluto nos cartões da última linha) e
// invertido para cima quando não cabe embaixo.
import { h, toast } from '../../ui.js';
import { createHints } from '../_ops/perm.js';

let current = null;

export function closeMenu({ restoreFocus = false } = {}) {
  if (!current) return;
  const { el, anchor, off } = current;
  current = null;
  off();
  el.remove();
  anchor.setAttribute('aria-expanded', 'false');
  if (restoreFocus && anchor.isConnected) anchor.focus();
}

/**
 * items: [{ label, danger, onSelect, locked? }]. Fecha antes de rodar onSelect.
 * `locked` (texto do motivo): item visível porém desabilitado (aria-disabled + dica), não executa.
 */
export function openMenu(anchor, items) {
  const wasOpen = current?.anchor === anchor;
  closeMenu();
  if (wasOpen) return; // clicar de novo no gatilho fecha

  const el = h('div', { class: 'instances-menu', role: 'menu', 'aria-label': 'Ações da instância' });
  const hints = createHints();
  const buttons = items.map((it) => {
    const btn = h(
      'button',
      {
        type: 'button',
        role: 'menuitem',
        class: 'instances-menu__item' + (it.danger ? ' is-danger' : ''),
        onclick: () => {
          if (it.locked) {
            toast(it.locked); // continua focável (leitor de tela ouve o motivo), mas não executa
            return;
          }
          closeMenu({ restoreFocus: true });
          it.onSelect();
        },
      },
      it.label
    );
    if (it.locked) hints.lockSoft(btn, { ok: false, msg: it.locked });
    return btn;
  });
  el.append(...buttons, hints.host);
  document.body.append(el);

  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  const hgt = el.offsetHeight;
  const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
  const below = r.bottom + 6;
  const top = below + hgt > window.innerHeight - 8 ? Math.max(8, r.top - hgt - 6) : below;
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  anchor.setAttribute('aria-expanded', 'true');

  const onDown = (e) => {
    if (!el.contains(e.target) && !anchor.contains(e.target)) closeMenu();
  };
  const onKey = (e) => {
    const i = buttons.indexOf(document.activeElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      closeMenu({ restoreFocus: true });
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      buttons[(i + 1) % buttons.length].focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      buttons[(i - 1 + buttons.length) % buttons.length].focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      buttons[0].focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      buttons[buttons.length - 1].focus();
    } else if (e.key === 'Tab') {
      closeMenu();
    }
  };
  const onAway = () => closeMenu();
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('scroll', onAway, true);
  window.addEventListener('resize', onAway);
  const off = () => {
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', onAway, true);
    window.removeEventListener('resize', onAway);
  };
  current = { el, anchor, off };
  buttons[0]?.focus();
}
