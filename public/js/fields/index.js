// Campos que trocam os do navegador: data dd/mm/aaaa, hora de 24 h e busca de contato.
// Cada um é um elemento com `.value` (ISO / HH:MM / id), `.disabled`, `.focus()` e evento `change` (borbulha), então entra no
// lugar de <input type="date">, <input type="time"> e <select> sem mexer no resto da tela.
import { h, icon, replaceChildren } from '../ui.js';
import { maskDate, maskTime, isoFromBr, brFromIso, cleanTime, searchContacts, prettyPhone, nameIsPhone } from './model.js';

const CAL = 'M7 3v3M17 3v3M4 8h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z';
const CLEAR = 'M18 6L6 18M6 6l12 12';
const emitChange = (el) => el.dispatchEvent(new Event('change', { bubbles: true }));

function defineValue(el, get, set) {
  Object.defineProperty(el, 'value', { get, set, configurable: true });
}

/** Data: o campo mostra dd/mm/aaaa; `.value` é 'aaaa-mm-dd' (ou '' se vazio/incompleto/inexistente). */
export function dateField({ value = '', label = 'Data', placeholder = 'dd/mm/aaaa', className = 'input' } = {}) {
  const text = h('input', { class: `${className} datefield__text`, type: 'text', inputmode: 'numeric', autocomplete: 'off', maxlength: '10', placeholder, 'aria-label': label });
  const picker = h('input', { class: 'datefield__native', type: 'date', tabindex: '-1', 'aria-hidden': 'true' });
  const open = h('button', { class: 'datefield__btn', type: 'button', 'aria-label': `Abrir calendário — ${label}`, tabindex: '-1' }, icon(CAL, 16));
  const root = h('span', { class: 'datefield' }, text, open, picker);
  let last = brFromIso(value) ? value.slice(0, 10) : '';
  text.value = brFromIso(last);

  const iso = () => isoFromBr(text.value);
  const sync = () => {
    const bad = text.value.length === 10 && !iso();
    if (bad) text.setAttribute('aria-invalid', 'true');
    else text.removeAttribute('aria-invalid');
  };
  const commit = () => {
    const v = iso();
    if (v === last) return;
    last = v;
    emitChange(root);
  };
  text.addEventListener('input', () => {
    text.value = maskDate(text.value);
    sync();
    if (iso() || !text.value) commit(); // completou uma data real (ou apagou tudo): avisa
  });
  text.addEventListener('change', (e) => {
    e.stopPropagation(); // o nosso `change` é o que vale
    sync();
    commit();
  });
  open.addEventListener('click', () => {
    picker.value = iso();
    try {
      picker.showPicker();
    } catch {
      picker.focus();
    }
  });
  picker.addEventListener('change', (e) => {
    e.stopPropagation();
    text.value = brFromIso(picker.value);
    sync();
    commit();
  });
  defineValue(
    root,
    () => iso(),
    (v) => {
      last = brFromIso(v) ? String(v).slice(0, 10) : '';
      text.value = brFromIso(last);
      sync();
    }
  );
  Object.defineProperty(root, 'disabled', { get: () => text.disabled, set: (v) => (text.disabled = open.disabled = !!v), configurable: true });
  root.focus = () => text.focus();
  return root;
}

/** Descritor original de `value` do <input> (o campo de hora troca o `value` do próprio elemento, então lê/escreve o texto cru por aqui). */
function rawValue(el) {
  let p = Object.getPrototypeOf(el);
  while (p) {
    const d = Object.getOwnPropertyDescriptor(p, 'value');
    if (d?.get && d?.set) return { get: () => d.get.call(el), set: (v) => d.set.call(el, v) };
    p = Object.getPrototypeOf(p);
  }
  throw new Error('input sem value');
}

/** Hora de 24 h: o campo mostra HH:MM; `.value` é 'HH:MM' (ou ''). */
export function timeField({ value = '', label = 'Hora', placeholder = 'hh:mm', className = 'input' } = {}) {
  const text = h('input', { class: `${className} timefield`, type: 'text', inputmode: 'numeric', autocomplete: 'off', maxlength: '5', placeholder, 'aria-label': label });
  const raw = rawValue(text);
  let last = cleanTime(value);
  raw.set(last);
  const commit = () => {
    const v = cleanTime(raw.get());
    if (v === last) return;
    last = v;
    emitChange(text);
  };
  text.addEventListener('input', () => {
    const masked = maskTime(raw.get());
    raw.set(masked);
    if (masked.length === 5 || !masked) commit();
    if (masked.length === 5 && !cleanTime(masked)) text.setAttribute('aria-invalid', 'true');
    else text.removeAttribute('aria-invalid');
  });
  text.addEventListener('change', (e) => {
    e.stopPropagation();
    const v = cleanTime(raw.get());
    if (v) raw.set(v); // '9:30' vira '09:30'
    commit();
  });
  defineValue(
    text,
    () => cleanTime(raw.get()),
    (v) => {
      last = cleanTime(v);
      raw.set(last);
    }
  );
  return text;
}

const NEW = '__new__';

/**
 * Busca de contato: digita nome, empresa, telefone ou e-mail e escolhe na lista (no máximo `limit` por vez), em vez de rolar centenas.
 * `.value` é o id do contato ('' = nenhum). `extra`: linhas fixas no topo, ex.: { value: '__new__', label: '+ Novo contato…' }.
 * @param {{ contacts: object[], value?: string, label?: string, placeholder?: string, none?: string|null, extra?: {value:string,label:string}[], limit?: number }} o
 */
export function contactField({ contacts = [], value = '', label = 'Contato', placeholder = 'Buscar por nome, telefone ou e-mail', none = null, extra = [], limit = 40 } = {}) {
  let list = contacts;
  let selected = value || '';
  let active = -1;
  let rows = []; // o que está na lista aberta: { value, label?, c? }
  const listId = `cf-${Math.random().toString(36).slice(2, 8)}`;

  const input = h('input', { class: 'input combo__input', type: 'text', role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': listId, autocomplete: 'off', placeholder, 'aria-label': label });
  const clear = h('button', { class: 'combo__clear', type: 'button', 'aria-label': 'Limpar contato', tabindex: '-1' }, icon(CLEAR, 14));
  const box = h('ul', { class: 'combo__list', id: listId, role: 'listbox', hidden: true });
  const root = h('div', { class: 'combo' }, input, clear, box);

  const byId = (id) => list.find((c) => c.id === id);
  const nameOf = (c) => (nameIsPhone(c) ? prettyPhone(c.name) : c.name);
  const labelOf = (id) => (id === NEW ? extra.find((x) => x.value === NEW)?.label || '' : byId(id) ? nameOf(byId(id)) : '');
  const showSelected = () => {
    input.value = labelOf(selected);
    clear.hidden = !selected || !none || input.disabled;
  };
  const isOpen = () => !box.hidden;
  const close = () => {
    box.hidden = true;
    active = -1;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  };
  const choose = (v) => {
    const changed = v !== selected;
    selected = v;
    showSelected();
    close();
    if (changed) emitChange(root);
  };
  const setActive = (i) => {
    active = rows.length ? (i + rows.length) % rows.length : -1;
    [...box.children].forEach((li, k) => {
      li.classList.toggle('is-active', k === active);
      li.setAttribute('aria-selected', String(k === active));
      if (k === active) {
        input.setAttribute('aria-activedescendant', li.id);
        li.scrollIntoView?.({ block: 'nearest' });
      }
    });
  };

  function draw(query) {
    const q = String(query ?? '').trim();
    const { items, total } = searchContacts(list, q, limit);
    const fixed = [];
    if (!q && none) fixed.push({ value: '', label: none });
    for (const x of extra) if (!q || x.label.toLowerCase().includes(q.toLowerCase())) fixed.push(x);
    rows = [...fixed, ...items.map((c) => ({ value: c.id, c }))];
    replaceChildren(
      box,
      rows.map((r, i) => {
        const li = h('li', { class: `combo__opt${r.value === selected && r.value ? ' is-selected' : ''}`, id: `${listId}-${i}`, role: 'option', 'aria-selected': 'false' });
        li.addEventListener('mousedown', (e) => {
          e.preventDefault(); // não tira o foco do campo antes de escolher
          choose(r.value);
        });
        if (r.c) {
          const sub = [r.c.company, prettyPhone(r.c.phone) && !nameIsPhone(r.c) ? prettyPhone(r.c.phone) : '', r.c.email].filter(Boolean).join(' · ');
          li.append(h('span', { class: 'combo__name' }, nameOf(r.c)), sub ? h('span', { class: 'combo__sub' }, sub) : null);
        } else li.append(h('span', { class: `combo__name${r.value ? ' combo__name--action' : ' combo__name--none'}` }, r.label));
        return li;
      }),
      !items.length && q ? h('li', { class: 'combo__empty', role: 'presentation' }, `Nenhum contato com “${q}”.`) : null,
      total > items.length ? h('li', { class: 'combo__more', role: 'presentation' }, `Mostrando ${items.length} de ${total} — continue digitando para filtrar.`) : null
    );
    box.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    setActive(rows.length && q ? 0 : -1);
  }

  input.addEventListener('focus', () => {
    if (input.disabled) return;
    input.select?.();
    draw('');
  });
  input.addEventListener('input', () => draw(input.value));
  input.addEventListener('blur', () => {
    close();
    showSelected(); // texto solto que não virou escolha volta ao contato escolhido
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!isOpen()) draw(input.value === labelOf(selected) ? '' : input.value);
      else setActive(active + (e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'Enter' && isOpen()) {
      e.preventDefault();
      e.stopPropagation(); // não envia o formulário
      if (active >= 0) choose(rows[active].value);
    } else if (e.key === 'Escape' && isOpen()) {
      e.stopPropagation(); // fecha só a lista, não o modal
      close();
      showSelected();
    }
  });
  clear.addEventListener('click', () => {
    choose('');
    input.focus();
  });

  defineValue(
    root,
    () => selected,
    (v) => {
      selected = v || '';
      showSelected();
    }
  );
  Object.defineProperty(root, 'disabled', {
    get: () => input.disabled,
    set: (v) => {
      input.disabled = !!v;
      showSelected();
    },
    configurable: true,
  });
  root.focus = () => input.focus();
  /** Troca a lista de contatos (ex.: depois de escolher um negócio). Mantém a escolha. */
  root.setContacts = (next) => {
    list = next;
    showSelected();
  };
  showSelected();
  return root;
}
