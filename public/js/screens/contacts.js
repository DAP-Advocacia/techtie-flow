// #/contacts — Contatos: lista com busca + ficha (negócios e conversas do contato), ou tabela com colunas, filtros e visões.
// Só mostra o que o motor deixa ler (visible) e respeita campos ocultos do perfil (telefone/e-mail).
// Celular: a ficha abre em tela cheia (botão voltar) e só existe o modo lista; computador: lista à esquerda, ficha à direita
// — ou, no modo Tabela, a tabela ocupa a tela e a ficha abre no lugar dela (com botão voltar).
import { h, icon, replaceChildren, avatar, fmtBRL, fmtInt, timeAgo, toast } from '../ui.js';
import { canAccess, visible, fieldLevel, mask, decide } from '../access.js';
import { hashParam, linkTo } from '../router.js';
import { isMobile } from '../mobile.js';
import { ensureScreenCss } from '../css.js';
import { openContactForm, openDeleteContact, canCreateContact } from './contacts/form.js';
import { contactColumns, contactCtx, contactViews } from './contacts/table.js';
import { createTable } from '../lists/table.js';
import { tasksBlock } from './tasks/mini.js';
import { tasksOfContact } from './tasks/actions.js';
import { pointInboxTo } from './pipeline/actions.js';
import { dealTarget } from '../shell/new.js';
import { openNewDeal } from './pipeline/new-deal.js';

const PAGE = 60;
const HIDDEN = '••• oculto';
const MODE_KEY = 'ttf:contacts:mode';
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const digits = (s) => String(s || '').replace(/\D/g, '');

function savedMode() {
  try {
    return localStorage.getItem(MODE_KEY) === 'table' ? 'table' : 'list';
  } catch {
    return 'list';
  }
}

const PREFS_KEY = 'ttf:contacts:list';
const DAY = 86400000;
/** Filtros rápidos da lista (as mesmas ideias das visões da tabela). `needs` = só para quem lê negócios. */
const QUICK = [
  { id: 'all', label: 'Todos', test: () => true },
  { id: 'mine', label: 'Meus', test: (c, ctx) => c.ownerId === ctx.me },
  { id: 'noowner', label: 'Sem responsável', test: (c) => !c.ownerId },
  { id: 'withdeal', label: 'Com negócio aberto', needs: 'deal', test: (c, ctx) => (ctx.openDeals.get(c.id) || 0) > 0 },
  { id: 'recent', label: 'Novos (30 dias)', test: (c) => !!c.createdAt && Date.now() - c.createdAt < 30 * DAY },
];
const SORTS = [
  { id: 'name', label: 'Nome (A–Z)', key: (c) => norm(c.name) },
  { id: 'company', label: 'Empresa (A–Z)', key: (c) => norm(c.company) || '~' },
  { id: 'recent', label: 'Mais recentes', key: (c) => -(c.createdAt || 0) },
];
function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    return { quick: QUICK.some((q) => q.id === p.quick) ? p.quick : 'all', sort: SORTS.some((x) => x.id === p.sort) ? p.sort : 'name' };
  } catch {
    return { quick: 'all', sort: 'name' };
  }
}
const letterOf = (c, sortId) => {
  const base = sortId === 'company' ? c.company : c.name;
  const ch = norm(base).trim()[0] || '#';
  return /[a-z]/.test(ch) ? ch.toUpperCase() : '#';
};
const copy = async (value, what) => {
  try {
    await navigator.clipboard.writeText(String(value));
    toast(`${what} copiado`);
  } catch {
    toast('Não foi possível copiar neste navegador.');
  }
};
const fmtDate = (t) => new Date(t).toLocaleDateString('pt-BR');

export default {
  mount(el, { store, navigate }) {
    ensureScreenCss('lists');
    let query = '';
    let limit = PAGE;
    let selectedId = null;
    let timer = null;
    let mode = savedMode();
    let ctxCache = null;
    let prefs = loadPrefs();
    const getCtx = () => (ctxCache ||= contactCtx());
    const effectiveMode = () => (isMobile() ? 'list' : mode);

    const newBtns = [];
    const modeBtns = [];
    const newBtn = () => {
      const b = h('button', { class: 'btn btn--primary contacts-new', type: 'button', onclick: () => openForm(null) }, '+ Novo');
      newBtns.push(b);
      return b;
    };
    /** Alternador Lista | Tabela (escondido no celular: lá só existe a lista). */
    const modeToggle = () => {
      const pill = (id, label) => {
        const b = h('button', { class: 'pill', type: 'button', 'data-mode': id, 'aria-pressed': 'false', onclick: () => setMode(id) }, label);
        modeBtns.push(b);
        return b;
      };
      return h('div', { class: 'pills lt-mode', role: 'group', 'aria-label': 'Forma de ver os contatos' }, pill('list', 'Lista'), pill('table', 'Tabela'));
    };
    const head = (extra) => h('header', { class: 'contacts-head' }, h('div', { class: 'contacts-head__row' }, h('div', null, h('div', { class: 'eyebrow' }, 'RELACIONAMENTO'), h('h1', { class: 'page-title' }, 'CONTATOS')), h('div', { class: 'contacts-head__tools' }, modeToggle(), newBtn())), extra);

    const search = h('input', { class: 'input contacts-search__input', type: 'search', placeholder: 'Buscar por nome, telefone, e-mail ou empresa', autocomplete: 'off', 'aria-label': 'Buscar contatos' });
    const count = h('span', { class: 'contacts-count muted', role: 'status' });
    const quickEl = h('div', { class: 'contacts-quick', role: 'group', 'aria-label': 'Filtros rápidos' });
    const sortSel = h('select', { class: 'select contacts-sort', 'aria-label': 'Ordenar contatos' }, ...SORTS.map((x) => h('option', { value: x.id, selected: x.id === prefs.sort }, x.label)));
    sortSel.addEventListener('change', () => {
      prefs = { ...prefs, sort: sortSel.value };
      savePrefs();
      limit = PAGE;
      draw();
    });
    const savePrefs = () => {
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
      } catch {
        /* sem armazenamento: só não lembra */
      }
    };
    const listEl = h('ul', { class: 'contacts-list' });
    const more = h('button', { class: 'btn btn--ghost contacts-more', type: 'button', onclick: () => ((limit += PAGE), draw()) }, 'Mostrar mais');
    const detail = h('section', { class: 'contacts-detail', 'aria-label': 'Ficha do contato' });

    // Tabela (computador): colunas, filtros e visões — as linhas são os contatos que o motor deixa ler, sem campos ocultos.
    const table = createTable({
      id: 'contacts',
      scope: store.state.currentUserId,
      columns: () => contactColumns(),
      ctx: getCtx,
      getRows: () => visibleMasked(),
      builtins: contactViews(store.state.currentUserId),
      noun: ['contato', 'contatos'],
      emptyText: 'Nenhum contato visível para você.',
      searchPlaceholder: 'Buscar por nome, empresa, telefone ou e-mail',
      onOpen: (c) => {
        selectedId = c.id;
        setView('detail');
        draw();
      },
    });

    const root = h(
      'div',
      { class: 'contacts', 'data-mview': 'list', 'data-mode': effectiveMode() },
      h('section', { class: 'contacts-col', 'aria-label': 'Lista de contatos' }, head(null), h('div', { class: 'contacts-search' }, icon('M21 21l-4.3-4.3M17 10.5a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0z', 18), search), quickEl, h('div', { class: 'contacts-meta' }, count, sortSel), listEl, more),
      h('section', { class: 'contacts-tablecol', 'aria-label': 'Contatos em tabela' }, head(null), table.el),
      detail
    );
    el.append(root);

    search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        query = search.value;
        limit = PAGE;
        draw();
      }, 150);
    });

    const setView = (v) => (root.dataset.mview = v);
    function setMode(m) {
      mode = m;
      try {
        localStorage.setItem(MODE_KEY, m);
      } catch {
        /* sem armazenamento: só não lembra */
      }
      setView('list');
      draw();
    }
    const openForm = (contact) =>
      openContactForm({
        contact,
        onSaved: (saved) => {
          selectedId = saved.id;
          setView('detail');
          draw();
        },
      });
    const confirmDelete = (contact) =>
      openDeleteContact({
        contact,
        onDeleted: () => {
          selectedId = null;
          setView('list');
          draw();
        },
      });

    /** Contatos que o usuário pode ler, já sem os campos ocultos. */
    function visibleMasked() {
      return visible('contact', store.state.contacts).map((c) => mask('contact', c));
    }

    const quickOk = (q) => !q.needs || canAccess(q.needs, 'read');
    const matchesSearch = (c) => {
      const q = norm(query.trim());
      const qd = digits(query);
      return !q || norm(c.name).includes(q) || norm(c.company).includes(q) || norm(c.email).includes(q) || (qd.length >= 3 && digits(c.phone).includes(qd));
    };

    /** Os mesmos, filtrados pela busca, pelo filtro rápido e na ordem escolhida. */
    function listed(all) {
      const ctx = getCtx();
      const quick = QUICK.find((q) => q.id === prefs.quick && quickOk(q)) || QUICK[0];
      const sort = SORTS.find((x) => x.id === prefs.sort) || SORTS[0];
      return all
        .filter((c) => matchesSearch(c) && quick.test(c, ctx))
        .sort((x, y) => {
          const a = sort.key(x);
          const b = sort.key(y);
          return (typeof a === 'number' ? a - b : String(a).localeCompare(String(b), 'pt-BR')) || norm(x.name).localeCompare(norm(y.name), 'pt-BR');
        });
    }

    function drawDetail(all) {
      const c = all.find((x) => x.id === selectedId) || null;
      if (!c) {
        replaceChildren(detail, h('div', { class: 'empty contacts-empty' }, h('div', null, 'Selecione um contato para ver os detalhes.')));
        return;
      }
      const s = store.state;
      const phoneHidden = fieldLevel('contact', 'phone') === 'hidden';
      const emailHidden = fieldLevel('contact', 'email') === 'hidden';
      const valueHidden = fieldLevel('deal', 'value') === 'hidden';
      const owner = c.ownerId ? store.userById(c.ownerId) : null;
      const deals = canAccess('deal', 'read') ? visible('deal', s.deals).filter((d) => d.contactId === c.id) : [];
      const convs = canAccess('conversation', 'read') ? visible('conversation', s.conversations).filter((cv) => cv.contactId === c.id) : [];
      const tasksSection = canAccess('task', 'read') ? tasksBlock({ tasks: visible('task', tasksOfContact(c.id)), defaults: { contactId: c.id } }) : null;
      const copyBtn = (value, what) => (value ? h('button', { class: 'contacts-copy', type: 'button', 'aria-label': `Copiar ${what}`, title: `Copiar ${what}`, onclick: () => copy(value, what) }, 'Copiar') : null);
      const row = (label, value, extra) => h('div', { class: 'contacts-kv' }, h('dt', { class: 'label' }, label), h('dd', null, h('span', { class: 'contacts-kv__value' }, value), extra));
      const phone = phoneHidden ? HIDDEN : c.phone || '—';
      const dealPipeline = dealTarget();
      const history = (store.state.timeline?.[c.id] || []).slice(0, 8);
      const newDeal = () => {
        ensureScreenCss('pipeline');
        openNewDeal({
          pipeline: dealPipeline,
          contactId: c.id,
          onCreated: (deal) => {
            toast('Negócio criado');
            location.hash = linkTo('deal', { id: deal.id });
          },
        });
      };

      replaceChildren(
        detail,
        h(
          'div',
          { class: 'contacts-detail__inner' },
          h('button', { class: 'contacts-back', type: 'button', 'aria-label': 'Voltar para a lista', onclick: () => setView('list') }, icon('M15 5l-7 7 7 7', 22), h('span', null, 'Contatos')),
          h('div', { class: 'contacts-who' }, avatar(c.name), h('div', { class: 'contacts-who__text' }, h('h2', { class: 'contacts-who__name' }, c.name), c.company ? h('span', { class: 'muted' }, c.company) : null)),
          h(
            'div',
            { class: 'contacts-actions' },
            convs.length ? h('button', { class: 'btn btn--primary', type: 'button', onclick: () => pointInboxTo(convs[0].id) && navigate('inbox') }, 'Abrir conversa') : null,
            !phoneHidden && c.phone ? h('a', { class: 'btn btn--ghost', href: `tel:${c.phone}` }, 'Ligar') : null,
            !emailHidden && c.email ? h('a', { class: 'btn btn--ghost', href: `mailto:${c.email}` }, 'E-mail') : null,
            decide('contact', 'update', c).effect === 'allow' ? h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => openForm(c) }, 'Editar') : null,
            decide('contact', 'delete', c).effect === 'allow' ? h('button', { class: 'btn btn--quiet', type: 'button', onclick: () => confirmDelete(c) }, 'Excluir') : null
          ),
          h(
            'dl',
            { class: 'contacts-kvs' },
            row('Telefone', phone, phoneHidden ? null : copyBtn(c.phone, 'telefone')),
            row('E-mail', emailHidden ? HIDDEN : c.email || '—', emailHidden ? null : copyBtn(c.email, 'e-mail')),
            row('Responsável', owner?.name || 'Sem responsável'),
            c.source ? row('Origem', c.source) : null,
            c.createdAt ? row('Cadastrado em', fmtDate(c.createdAt)) : null,
            (c.tags || []).length ? row('Etiquetas', h('span', { class: 'contacts-tags' }, ...c.tags.map((t) => h('span', { class: 'chip' }, t)))) : null
          ),
          h(
            'div',
            { class: 'contacts-block' },
            h('div', { class: 'contacts-block__head' }, h('h3', { class: 'contacts-block__title' }, `Negócios (${deals.length})`), dealPipeline ? h('button', { class: 'contacts-block__add', type: 'button', onclick: newDeal }, '+ Negócio') : null),
            deals.length
              ? h(
                  'ul',
                  { class: 'contacts-mini' },
                  ...deals.map((d) => h('li', null, h('a', { class: 'contacts-mini__row', href: `#/deal?id=${d.id}` }, h('span', { class: 'contacts-mini__main truncate' }, d.title), h('span', { class: 'contacts-mini__sub' }, [store.stage(d.stageId)?.name, valueHidden ? null : fmtBRL(d.value)].filter(Boolean).join(' · ')))))
                )
              : h('p', { class: 'muted' }, 'Nenhum negócio visível para você.')
          ),
          tasksSection,
          history.length
            ? h(
                'div',
                { class: 'contacts-block' },
                h('h3', { class: 'contacts-block__title' }, 'Atividade'),
                h('ul', { class: 'contacts-history' }, ...history.map((e) => h('li', null, h('span', { class: 'contacts-history__text' }, e.text), h('span', { class: 'contacts-history__time' }, [e.who, `há ${timeAgo(e.at)}`].filter(Boolean).join(' · ')))))
              )
            : null,
          convs.length
            ? h(
                'div',
                { class: 'contacts-block' },
                h('h3', { class: 'contacts-block__title' }, `Conversas (${convs.length})`),
                h(
                  'ul',
                  { class: 'contacts-mini' },
                  ...convs.map((cv) =>
                    h(
                      'li',
                      null,
                      h(
                        'button',
                        { class: 'contacts-mini__row', type: 'button', onclick: () => pointInboxTo(cv.id) && navigate('inbox') },
                        h('span', { class: 'contacts-mini__main truncate' }, cv.lastMessage || 'Sem mensagens'),
                        h('span', { class: 'contacts-mini__sub' }, [store.instance(cv.instanceId)?.name, cv.lastMessageAt ? `há ${timeAgo(cv.lastMessageAt)}` : null].filter(Boolean).join(' · '))
                      )
                    )
                  )
                )
              )
            : null
        )
      );
    }

    function draw() {
      const m = effectiveMode();
      root.dataset.mode = m;
      for (const b of modeBtns) {
        const on = b.dataset.mode === m;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-pressed', String(on));
      }
      const everyone = visibleMasked();
      if (m === 'table') {
        table.redraw();
      } else {
        const all = listed(everyone);
        const ctx = getCtx();
        count.textContent = `${fmtInt(all.length)} ${all.length === 1 ? 'contato' : 'contatos'}${query.trim() || prefs.quick !== 'all' ? ' encontrados' : ''}`;
        // filtros rápidos com a contagem (respeitando a busca digitada)
        const base = everyone.filter(matchesSearch);
        const quickNow = QUICK.find((q) => q.id === prefs.quick && quickOk(q))?.id || 'all';
        replaceChildren(
          quickEl,
          ...QUICK.filter(quickOk).map((q) =>
            h(
              'button',
              {
                class: 'contacts-chip' + (q.id === quickNow ? ' is-active' : ''),
                type: 'button',
                'data-quick': q.id,
                'aria-pressed': String(q.id === quickNow),
                onclick: () => {
                  prefs = { ...prefs, quick: q.id };
                  savePrefs();
                  limit = PAGE;
                  draw();
                },
              },
              q.label,
              h('span', { class: 'contacts-chip__n' }, fmtInt(base.filter((c) => q.test(c, ctx)).length))
            )
          )
        );
        sortSel.value = prefs.sort;
        const letters = prefs.sort !== 'recent';
        let lastLetter = '';
        const items = [];
        for (const c of all.slice(0, limit)) {
          if (letters) {
            const l = letterOf(c, prefs.sort);
            if (l !== lastLetter) {
              lastLetter = l;
              items.push(h('li', { class: 'contacts-letter', 'aria-hidden': 'true' }, l));
            }
          }
          const owner = c.ownerId ? store.userById(c.ownerId) : null;
          const open = ctx.openDeals.get(c.id) || 0;
          items.push(
            h(
              'li',
              null,
              h(
                'button',
                {
                  class: 'contacts-item' + (c.id === selectedId ? ' is-active' : ''),
                  type: 'button',
                  onclick: () => {
                    selectedId = c.id;
                    setView('detail');
                    draw();
                  },
                },
                avatar(c.name),
                h('span', { class: 'contacts-item__text' }, h('span', { class: 'contacts-item__name truncate' }, c.name), h('span', { class: 'contacts-item__sub truncate' }, c.company || (fieldLevel('contact', 'phone') === 'hidden' ? HIDDEN : c.phone) || c.email || '')),
                h('span', { class: 'contacts-item__meta' }, open ? h('span', { class: 'contacts-item__deals', title: `${open} ${open === 1 ? 'negócio aberto' : 'negócios abertos'}` }, `${open} ${open === 1 ? 'negócio' : 'negócios'}`) : null, owner ? avatar(owner.name, { small: true }) : null)
              )
            )
          );
        }
        replaceChildren(listEl, ...items, all.length ? null : h('li', { class: 'contacts-none muted' }, query.trim() || prefs.quick !== 'all' ? 'Nenhum contato com esse filtro.' : 'Nenhum contato visível para você.'));
        more.hidden = all.length <= limit;
      }
      drawDetail(everyone);
    }

    for (const b of newBtns) b.hidden = !canCreateContact();
    const wanted = hashParam('c');
    if (wanted && visible('contact', store.state.contacts).some((c) => c.id === wanted)) {
      selectedId = wanted;
      setView('detail');
    }
    draw();
    const unsub = store.subscribe(() => {
      ctxCache = null; // os totais por contato (negócios, tarefas) mudam com o estado
      draw();
    });
    return () => {
      clearTimeout(timer);
      table.destroy();
      unsub();
    };
  },
};
