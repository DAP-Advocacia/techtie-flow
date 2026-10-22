// #/contacts — Contatos: lista com busca + ficha (negócios e conversas do contato).
// Só mostra o que o motor deixa ler (visible) e respeita campos ocultos do perfil (telefone/e-mail).
// Celular: a ficha abre em tela cheia (botão voltar); computador: lista à esquerda, ficha à direita.
import { h, icon, replaceChildren, avatar, fmtBRL, fmtInt, timeAgo, toast } from '../ui.js';
import { canAccess, visible, fieldLevel, mask, decide } from '../access.js';
import { hashParam } from '../router.js';
import { openContactForm, openDeleteContact, canCreateContact } from './contacts/form.js';
import * as live from '../live.js';
import { tasksBlock } from './tasks/mini.js';
import { tasksOfContact } from './tasks/actions.js';
import { pointInboxTo } from './pipeline/actions.js';

const PAGE = 60;
const HIDDEN = '••• oculto';
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const digits = (s) => String(s || '').replace(/\D/g, '');

export default {
  mount(el, { store, navigate }) {
    let query = '';
    let limit = PAGE;
    let selectedId = null;
    let timer = null;

    const newBtn = h('button', { class: 'btn btn--primary contacts-new', type: 'button', onclick: () => openForm(null) }, '+ Novo');
    const search = h('input', { class: 'input contacts-search__input', type: 'search', placeholder: 'Buscar por nome, telefone, e-mail ou empresa', autocomplete: 'off', 'aria-label': 'Buscar contatos' });
    const count = h('span', { class: 'contacts-count muted' });
    const listEl = h('ul', { class: 'contacts-list' });
    const more = h('button', { class: 'btn btn--ghost contacts-more', type: 'button', onclick: () => ((limit += PAGE), draw()) }, 'Mostrar mais');
    const detail = h('section', { class: 'contacts-detail', 'aria-label': 'Ficha do contato' });
    const root = h(
      'div',
      { class: 'contacts', 'data-mview': 'list' },
      h(
        'section',
        { class: 'contacts-col', 'aria-label': 'Lista de contatos' },
        h('header', { class: 'contacts-head' }, h('div', { class: 'contacts-head__row' }, h('div', null, h('div', { class: 'eyebrow' }, 'RELACIONAMENTO'), h('h1', { class: 'page-title' }, 'CONTATOS')), newBtn), count),
        h('div', { class: 'contacts-search' }, icon('M21 21l-4.3-4.3M17 10.5a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0z', 18), search),
        listEl,
        more
      ),
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

    /** Contatos que o usuário pode ler, já sem os campos ocultos, filtrados pela busca e em ordem alfabética. */
    function listed() {
      const q = norm(query.trim());
      const qd = digits(query);
      return visible('contact', store.state.contacts)
        .map((c) => mask('contact', c))
        .filter((c) => !q || norm(c.name).includes(q) || norm(c.company).includes(q) || norm(c.email).includes(q) || (qd.length >= 3 && digits(c.phone).includes(qd)))
        .sort((a, b) => norm(a.name).localeCompare(norm(b.name), 'pt-BR'));
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
      const row = (label, value) => h('div', { class: 'contacts-kv' }, h('dt', { class: 'label' }, label), h('dd', null, value));
      const phone = phoneHidden ? HIDDEN : c.phone || '—';

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
            decide('contact', 'update', c).effect === 'allow' ? h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => openForm(c) }, 'Editar') : null,
            decide('contact', 'delete', c).effect === 'allow' ? h('button', { class: 'btn btn--quiet', type: 'button', onclick: () => confirmDelete(c) }, 'Excluir') : null
          ),
          h(
            'dl',
            { class: 'contacts-kvs' },
            row('Telefone', phone),
            row('E-mail', emailHidden ? HIDDEN : c.email || '—'),
            row('Responsável', owner?.name || 'Sem responsável'),
            c.source ? row('Origem', c.source) : null
          ),
          h(
            'div',
            { class: 'contacts-block' },
            h('h3', { class: 'contacts-block__title' }, `Negócios (${deals.length})`),
            deals.length
              ? h(
                  'ul',
                  { class: 'contacts-mini' },
                  ...deals.map((d) => h('li', null, h('a', { class: 'contacts-mini__row', href: `#/deal?id=${d.id}` }, h('span', { class: 'contacts-mini__main truncate' }, d.title), h('span', { class: 'contacts-mini__sub' }, [store.stage(d.stageId)?.name, valueHidden ? null : fmtBRL(d.value)].filter(Boolean).join(' · ')))))
                )
              : h('p', { class: 'muted' }, 'Nenhum negócio visível para você.')
          ),
          tasksSection,
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
      const all = listed();
      count.textContent = `${fmtInt(all.length)} ${all.length === 1 ? 'contato' : 'contatos'}${query.trim() ? ' encontrados' : ''}`;
      replaceChildren(
        listEl,
        ...all.slice(0, limit).map((c) =>
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
              h('span', { class: 'contacts-item__text' }, h('span', { class: 'contacts-item__name truncate' }, c.name), h('span', { class: 'contacts-item__sub truncate' }, c.company || (fieldLevel('contact', 'phone') === 'hidden' ? HIDDEN : c.phone) || c.email || ''))
            )
          )
        ),
        all.length ? null : h('li', { class: 'contacts-none muted' }, query.trim() ? 'Nenhum contato com essa busca.' : 'Nenhum contato visível para você.')
      );
      more.hidden = all.length <= limit;
      drawDetail(all);
    }

    newBtn.hidden = !canCreateContact();
    const wanted = hashParam('c');
    if (wanted && visible('contact', store.state.contacts).some((c) => c.id === wanted)) {
      selectedId = wanted;
      setView('detail');
    }
    draw();
    const unsub = store.subscribe(draw);
    return () => {
      clearTimeout(timer);
      unsub();
    };
  },
};
