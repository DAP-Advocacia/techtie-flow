// Seletor de funil em LISTA SUSPENSA (como no Bitrix): um botão com o funil atual e, ao abrir, a lista com a contagem de
// negócios de cada um e busca (a partir de 6 funis). Escala para empresas com muitos funis, onde abas/pílulas não cabem.
// Teclado: Enter/Espaço/↓ abre; ↑ ↓ percorrem; Enter escolhe; Esc fecha e devolve o foco; clicar fora fecha.
import { h, icon, replaceChildren } from '../../ui.js';

const CARET = 'M6 9l6 6 6-6';
const CHECK = 'M5 12l5 5L20 7';
const SEARCH_FROM = 6;
const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
let seq = 0;

/** @param label nome acessível da lista · @param onPick(id) chamado ao escolher outro funil */
export function createPicker({ label = 'Funil', onPick }) {
  const uid = `picker-${++seq}`;
  let items = []; // [{ id, name, sub }]
  let selectedId = null;
  let open = false;
  let active = -1; // índice (na lista filtrada) do item em destaque
  let shown = [];

  const nameEl = h('span', { class: 'picker__name truncate' });
  const subEl = h('span', { class: 'picker__sub' });
  const btn = h('button', { class: 'picker__btn', type: 'button', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-controls': `${uid}-list`, 'aria-label': `${label}: escolher`, 'data-focus': 'picker' }, h('span', { class: 'picker__text' }, h('span', { class: 'picker__eyebrow' }, label.toUpperCase()), nameEl), subEl, icon(CARET, 18));
  const search = h('input', { class: 'input picker__search', type: 'search', placeholder: 'Buscar funil', 'aria-label': 'Buscar funil', autocomplete: 'off', 'aria-controls': `${uid}-list` });
  const list = h('ul', { class: 'picker__list', role: 'listbox', id: `${uid}-list`, 'aria-label': label, tabindex: '-1' });
  const pop = h('div', { class: 'picker__pop', hidden: true }, search, list);
  const el = h('div', { class: 'picker' }, btn, pop);

  const filtered = () => {
    const q = fold(search.value).trim();
    return q ? items.filter((i) => fold(i.name).includes(q)) : items;
  };

  function drawList() {
    shown = filtered();
    if (active >= shown.length) active = shown.length - 1;
    const focusTarget = search.hidden ? list : search;
    focusTarget.setAttribute('aria-activedescendant', active >= 0 ? `${uid}-o${active}` : '');
    replaceChildren(
      list,
      ...shown.map((it, i) =>
        h(
          'li',
          {
            class: 'picker__item' + (i === active ? ' is-active' : '') + (it.id === selectedId ? ' is-selected' : ''),
            role: 'option',
            id: `${uid}-o${i}`,
            'aria-selected': String(it.id === selectedId),
            'data-pipe': it.id,
            onmousemove: () => i !== active && ((active = i), mark()),
            onclick: () => pick(it.id),
          },
          h('span', { class: 'picker__item-main' }, h('span', { class: 'picker__item-name truncate' }, it.name), it.sub ? h('span', { class: 'picker__item-sub' }, it.sub) : null),
          it.id === selectedId ? icon(CHECK, 16) : null
        )
      ),
      shown.length ? null : h('li', { class: 'picker__none', role: 'presentation' }, 'Nenhum funil com esse nome.')
    );
    list.querySelector('.is-active')?.scrollIntoView?.({ block: 'nearest' });
  }
  /** só move o destaque (sem refazer a lista: o mouse passa por cima o tempo todo) */
  function mark() {
    [...list.children].forEach((li, i) => li.classList.toggle('is-active', i === active));
    (search.hidden ? list : search).setAttribute('aria-activedescendant', active >= 0 ? `${uid}-o${active}` : '');
    list.querySelector('.is-active')?.scrollIntoView?.({ block: 'nearest' });
  }

  function pick(id) {
    close(true);
    if (id !== selectedId) onPick?.(id);
  }

  const onDocDown = (e) => !el.contains(e.target) && close(false);

  function openPop() {
    if (open || !items.length) return;
    open = true;
    search.value = '';
    search.hidden = items.length < SEARCH_FROM;
    active = Math.max(0, items.findIndex((i) => i.id === selectedId));
    pop.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    drawList();
    document.addEventListener('mousedown', onDocDown, true);
    (search.hidden ? list : search).focus();
  }
  function close(restoreFocus) {
    if (!open) return;
    open = false;
    pop.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', onDocDown, true);
    if (restoreFocus) btn.focus();
  }

  btn.addEventListener('click', () => (open ? close(true) : openPop()));
  btn.addEventListener('keydown', (e) => {
    if (['ArrowDown', 'ArrowUp'].includes(e.key)) {
      e.preventDefault();
      openPop();
    }
  });
  const onKeys = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!shown.length) return;
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length;
      mark();
    } else if (e.key === 'Home' || e.key === 'End') {
      if (e.target === search) return; // no campo de busca, Home/End movem o cursor
      e.preventDefault();
      active = e.key === 'Home' ? 0 : shown.length - 1;
      mark();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (shown[active]) pick(shown[active].id);
    } else if (e.key === 'Tab') close(false);
  };
  search.addEventListener('keydown', onKeys);
  list.addEventListener('keydown', onKeys);
  search.addEventListener('input', () => {
    active = 0;
    drawList();
  });

  return {
    el,
    /** items: [{ id, name, sub }] · selectedId: funil mostrado no botão */
    update({ items: next, selectedId: sel }) {
      items = next || [];
      selectedId = sel;
      const cur = items.find((i) => i.id === sel);
      nameEl.textContent = cur?.name || 'Sem funil';
      subEl.textContent = cur?.sub || '';
      btn.disabled = !items.length;
      if (open) drawList();
    },
    close: () => close(false),
    get isOpen() {
      return open;
    },
  };
}
