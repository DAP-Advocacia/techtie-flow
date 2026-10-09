// Coluna esquerda: busca, abas e lista de conversas. A lista é reconciliada
// por id (cada <li> é criado uma vez e só atualizado), assim trocar de conversa
// não zera o scroll nem tira o foco do teclado.
import { h, icon, avatar, fmtListTime, replaceChildren } from '../../ui.js';
import { lastChatMessage, readableDealOf } from './actions.js';

const TABS = [
  { id: 'mine', label: 'Meus' },
  { id: 'queue', label: 'Fila' },
  { id: 'all', label: 'Todos' },
];

export function createList({ store, onSelect, onTab, onQuery }) {
  const items = new Map(); // convId -> { li, refs }

  const search = h('input', {
    class: 'input inbox-search__input',
    type: 'search',
    placeholder: 'Buscar conversa ou contato…',
    'aria-label': 'Buscar conversa ou contato',
    autocomplete: 'off',
    oninput: (e) => onQuery(e.target.value),
    onkeydown: (e) => {
      if (e.key === 'Escape' && search.value) {
        search.value = '';
        onQuery('');
      }
    },
  });

  const tabButtons = new Map();
  const tablist = h(
    'div',
    {
      class: 'inbox-tabs',
      role: 'tablist',
      'aria-label': 'Filtrar conversas',
      onkeydown: (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        const i = TABS.findIndex((t) => tabButtons.get(t.id).btn === document.activeElement);
        if (i < 0) return;
        const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length].id;
        onTab(next);
        tabButtons.get(next).btn.focus();
      },
    },
    TABS.map((t) => {
      const count = h('span', { class: 'inbox-tabs__count num' });
      const btn = h('button', { class: 'pill', type: 'button', role: 'tab', onclick: () => onTab(t.id) }, t.label, count);
      tabButtons.set(t.id, { btn, count });
      return btn;
    })
  );

  const ul = h('ul', { class: 'inbox-list', 'aria-label': 'Conversas' });
  const empty = h('div', { class: 'empty inbox-list__empty', hidden: true });
  const scroller = h('div', { class: 'inbox-list__scroll' }, ul, empty);

  const el = h(
    'section',
    { class: 'inbox-col inbox-col--list', 'aria-label': 'Lista de conversas' },
    h('div', { class: 'inbox-list-head' }, h('h1', { class: 'section-title inbox-title' }, 'Inbox'), h('div', { class: 'inbox-search' }, icon('M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-4.3-4.3', 16), search), tablist),
    scroller
  );

  function buildItem(conv) {
    const refs = {
      name: h('span', { class: 'inbox-item__name truncate' }),
      time: h('span', { class: 'inbox-item__time num' }),
      last: h('span', { class: 'inbox-item__last truncate' }),
      unread: h('span', { class: 'inbox-item__unread num' }),
      stage: h('span', { class: 'inbox-item__stage truncate' }),
      avatarSlot: h('span', { class: 'inbox-item__avatar' }),
    };
    const btn = h(
      'button',
      { class: 'inbox-item', type: 'button', onclick: () => onSelect(conv.id) },
      refs.avatarSlot,
      h('span', { class: 'inbox-item__body' }, h('span', { class: 'inbox-item__row' }, refs.name, refs.time), h('span', { class: 'inbox-item__row' }, refs.last, refs.unread), refs.stage)
    );
    refs.btn = btn;
    return { li: h('li', { class: 'inbox-list__li' }, btn), refs };
  }

  function patchItem({ refs }, conv, selected) {
    const s = store.state;
    const contact = store.contact(conv.contactId);
    const last = lastChatMessage(s, conv.id);
    const deal = readableDealOf(store, conv); // etapa do negócio só se o motor deixa ler o negócio
    const name = contact?.name || 'Contato removido';

    if (refs.avatarName !== name) {
      refs.avatarName = name;
      refs.avatarSlot.replaceChildren(avatar(name));
    }
    refs.name.textContent = name;
    refs.time.textContent = conv.lastMessageAt ? fmtListTime(conv.lastMessageAt) : '';
    refs.last.textContent = last ? (last.type === 'out' ? `Você: ${last.text}` : last.text) : 'Sem mensagens ainda';
    refs.last.classList.toggle('is-empty', !last);
    refs.unread.textContent = conv.unread || '';
    refs.unread.hidden = !conv.unread;
    // resolvida só aparece em "Todos": sinaliza no lugar da etapa pra não confundir com aberta
    refs.stage.textContent = [conv.status === 'resolved' ? 'RESOLVIDA' : '', (store.stage(deal?.stageId)?.name || '').toUpperCase()].filter(Boolean).join(' · ');
    refs.stage.hidden = !refs.stage.textContent;
    refs.btn.classList.toggle('is-active', selected);
    refs.btn.classList.toggle('is-unread', !!conv.unread);
    refs.btn.classList.toggle('is-resolved', conv.status === 'resolved');
    if (selected) refs.btn.setAttribute('aria-current', 'true');
    else refs.btn.removeAttribute('aria-current');
    refs.btn.setAttribute('aria-label', `${name}${conv.unread ? `, ${conv.unread} não lidas` : ''}`);
  }

  function render({ tab, query, selectedId, convs, counts }) {
    if (search.value !== query) search.value = query;
    for (const t of TABS) {
      const { btn, count } = tabButtons.get(t.id);
      btn.setAttribute('aria-selected', String(t.id === tab));
      btn.tabIndex = t.id === tab ? 0 : -1;
      count.textContent = counts[t.id];
    }

    const wanted = new Set(convs.map((c) => c.id));
    for (const [id] of items) if (!wanted.has(id)) items.delete(id);

    const ordered = convs.map((conv) => {
      let it = items.get(conv.id);
      if (!it) items.set(conv.id, (it = buildItem(conv)));
      patchItem(it, conv, conv.id === selectedId);
      return it.li;
    });
    // só mexe no DOM se a ordem/composição mudou (mover nó derrubaria o foco)
    const same = ul.children.length === ordered.length && ordered.every((li, i) => ul.children[i] === li);
    if (!same) ul.replaceChildren(...ordered);

    empty.hidden = convs.length > 0;
    if (!convs.length) {
      const q = query.trim();
      // vazio por permissão (nada no escopo do perfil) é diferente de vazio por filtro/busca/aba
      const msg = counts.total === 0 ? 'Nenhuma conversa disponível para o seu perfil.' : q ? `Nenhuma conversa encontrada para “${q}”.` : tab === 'mine' ? 'Nenhuma conversa com você agora.' : tab === 'queue' ? 'A fila está vazia.' : 'Nenhuma conversa neste filtro.';
      replaceChildren(empty, h('div', null, msg), counts.total === 0 ? h('div', { class: 'muted inbox-list__scope' }, 'O que aparece no Inbox depende do seu perfil de acesso. Fale com um administrador se faltar algo.') : null, q ? h('button', { class: 'btn btn--quiet btn--sm', type: 'button', onclick: () => onQuery('') }, 'Limpar busca') : null);
    }
  }

  return { el, render };
}
