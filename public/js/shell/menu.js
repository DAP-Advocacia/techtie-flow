// Menu suspenso simples ancorado num botão: fecha ao clicar fora, Esc ou escolher. Teclado: setas e Enter.
import { h } from '../ui.js';

let current = null;

export function closeMenu() {
  current?.close();
}

/**
 * @param anchor  botão que abriu
 * @param items   [{ label, hint?, onSelect, disabled?, reason?, icon? }] ou { divider: true }
 * @param align   'left' | 'right' (alinhamento do menu em relação ao botão)
 */
export function openMenu(anchor, items, { align = 'left', className = '' } = {}) {
  closeMenu();
  const prevFocus = document.activeElement;
  const list = h(
    'div',
    { class: `menu ${className}`.trim(), role: 'menu' },
    items.map((it) =>
      it.divider
        ? h('div', { class: 'menu__sep', role: 'separator' })
        : h(
            'button',
            {
              class: 'menu__item' + (it.disabled ? ' is-disabled' : ''),
              type: 'button',
              role: 'menuitem',
              disabled: !!it.disabled,
              title: it.disabled && it.reason ? it.reason : null,
              onclick: () => {
                close();
                it.onSelect?.();
              },
            },
            it.icon ? h('span', { class: 'menu__icon' }, it.icon) : null,
            h('span', { class: 'menu__label' }, it.label),
            it.hint ? h('span', { class: 'menu__hint' }, it.hint) : null
          )
    )
  );
  // posição: logo abaixo do botão, sem sair da tela
  const r = anchor.getBoundingClientRect?.() || { left: 0, right: 0, bottom: 0 };
  list.style.position = 'fixed';
  list.style.top = `${Math.round(r.bottom + 6)}px`;
  if (align === 'right') list.style.right = `${Math.max(8, Math.round((window.innerWidth || 1200) - r.right))}px`;
  else list.style.left = `${Math.max(8, Math.round(r.left))}px`;
  document.body.append(list);
  anchor.setAttribute?.('aria-expanded', 'true');

  const onDown = (e) => !list.contains(e.target) && !anchor.contains?.(e.target) && close();
  const onKey = (e) => {
    const btns = [...list.querySelectorAll('button:not(:disabled)')];
    const i = btns.indexOf(document.activeElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      btns[(i + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length]?.focus();
    }
  };
  setTimeout(() => document.addEventListener('mousedown', onDown, true), 0);
  document.addEventListener('keydown', onKey, true);
  list.querySelector('button:not(:disabled)')?.focus();

  function close() {
    if (!current || current.list !== list) return;
    list.remove();
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    anchor.setAttribute?.('aria-expanded', 'false');
    current = null;
    prevFocus?.focus?.();
  }
  current = { list, close };
  return { close };
}
