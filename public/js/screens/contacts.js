// #/contacts — Contatos: lista com busca + ficha (negócios e conversas do contato).
// Só mostra o que o motor deixa ler (visible) e respeita campos ocultos do perfil (telefone/e-mail).
// Celular: a ficha abre em tela cheia (botão voltar); computador: lista à esquerda, ficha à direita.
import { h, icon, replaceChildren, avatar, fmtBRL, fmtInt, timeAgo, toast } from '../ui.js';
import { canAccess, visible, fieldLevel, mask, decide, audit } from '../access.js';
import * as live from '../live.js';
import { pointInboxTo } from './pipeline/actions.js';

const PAGE = 60;
const HIDDEN = '••• oculto';
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const digits = (s) => String(s || '').replace(/\D/g, '');

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Diálogo simples (sobreposição + cartão). Devolve { close }. Esc e clique fora fecham. */
function openDialog({ title, eyebrow, content }) {
  const prev = document.activeElement;
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    prev?.focus?.();
  };
  const onKey = (e) => e.key === 'Escape' && close();
  const overlay = h('div', { class: 'contacts-overlay', onmousedown: (e) => e.target === overlay && close() }, h('div', { class: 'contacts-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, eyebrow ? h('div', { class: 'eyebrow' }, eyebrow) : null, h('h2', { class: 'contacts-dialog__title' }, title), content));
  document.body.append(overlay);
  document.addEventListener('keydown', onKey, true);
  overlay.querySelector('[data-autofocus]')?.focus();
  return { close };
}

export default {
  mount(el, { store, navigate }) {
    let query = '';
    let limit = PAGE;
    let selectedId = null;
    let timer = null;

    const meRow = () => ({ ownerId: store.state.currentUserId, teamId: store.user()?.teamIds?.[0] ?? null });
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

    /** Formulário de contato (novo ou edição). Em operação espera o servidor; no protótipo grava local. */
    function openForm(contact) {
      const editing = !!contact;
      const phoneHidden = editing && fieldLevel('contact', 'phone') === 'hidden';
      const emailHidden = editing && fieldLevel('contact', 'email') === 'hidden';
      const f = {
        name: h('input', { class: 'input', type: 'text', maxlength: '200', value: contact?.name || '', 'data-autofocus': true, autocomplete: 'off' }),
        company: h('input', { class: 'input', type: 'text', maxlength: '200', value: contact?.company || '', autocomplete: 'off' }),
        phone: h('input', { class: 'input', type: 'tel', inputmode: 'tel', value: phoneHidden ? '' : contact?.phone || '', placeholder: '+55 11 99999-9999', disabled: phoneHidden, autocomplete: 'off' }),
        email: h('input', { class: 'input', type: 'email', value: emailHidden ? '' : contact?.email || '', placeholder: 'nome@empresa.com.br', disabled: emailHidden, autocomplete: 'off' }),
      };
      const error = h('span', { class: 'field-error', role: 'alert' });
      const save = h('button', { class: 'btn btn--primary', type: 'submit' }, editing ? 'Salvar' : 'Criar contato');
      const cancel = h('button', { class: 'btn btn--quiet', type: 'button' }, 'Cancelar');
      const dlg = openDialog({
        eyebrow: 'CONTATO',
        title: editing ? 'Editar contato' : 'Novo contato',
        content: h(
          'form',
          {
            class: 'contacts-form',
            novalidate: true,
            onsubmit: async (e) => {
              e.preventDefault();
              error.textContent = '';
              const name = f.name.value.trim();
              const phoneDigits = f.phone.value.replace(/\D/g, '');
              const email = f.email.value.trim();
              if (!name) return (error.textContent = 'Informe o nome.');
              if (phoneDigits && !/^[0-9]{8,15}$/.test(phoneDigits)) return (error.textContent = 'Telefone inválido: use de 8 a 15 dígitos (com DDD).');
              if (email && !EMAIL.test(email)) return (error.textContent = 'E-mail inválido.');
              save.disabled = true;
              try {
                const body = { name, company: f.company.value.trim() };
                if (!phoneHidden) body.phone = phoneDigits;
                if (!emailHidden) body.email = email;
                const saved = live.enabled ? (editing ? await live.updateContact(contact.id, body) : await live.createContact(body)) : saveLocal(contact, body);
                selectedId = saved.id;
                dlg.close();
                setView('detail');
                draw();
                toast(editing ? 'Contato atualizado' : 'Contato criado');
              } catch (err) {
                error.textContent = err.message || 'Não foi possível salvar.';
                save.disabled = false;
              }
            },
          },
          h('label', { class: 'field' }, 'Nome', f.name),
          h('label', { class: 'field' }, 'Empresa', f.company),
          h('label', { class: 'field' }, 'Telefone (WhatsApp)', f.phone),
          h('label', { class: 'field' }, 'E-mail', f.email),
          error,
          h('div', { class: 'contacts-form__actions' }, cancel, save)
        ),
      });
      cancel.addEventListener('click', () => dlg.close());
    }

    /** Protótipo (sem servidor): grava só no navegador. */
    function saveLocal(contact, body) {
      let out;
      store.update((s) => {
        const phone = body.phone ? `+${body.phone}` : '';
        if (contact) {
          out = s.contacts.find((c) => c.id === contact.id);
          Object.assign(out, { name: body.name, company: body.company, ...(body.phone !== undefined ? { phone } : {}), ...(body.email !== undefined ? { email: body.email } : {}) });
        } else {
          out = { id: `c_${Date.now().toString(36)}`, name: body.name, company: body.company, phone, email: body.email || '', ownerId: s.currentUserId, source: 'manual', tags: [] };
          s.contacts.push(out);
        }
      });
      audit(contact ? 'contact.update' : 'contact.create', out.id, `Contato "${out.name}" ${contact ? 'alterado' : 'criado'}`);
      return out;
    }

    function confirmDelete(contact) {
      const ok = h('button', { class: 'btn btn--primary', type: 'button' }, 'Excluir contato');
      const cancel = h('button', { class: 'btn btn--quiet', type: 'button', 'data-autofocus': true }, 'Cancelar');
      const error = h('span', { class: 'field-error', role: 'alert' });
      const dlg = openDialog({ eyebrow: 'AÇÃO SEM VOLTA', title: 'Excluir este contato?', content: h('div', { class: 'contacts-form' }, h('p', { class: 'muted' }, `“${contact.name}” será removido. Contatos com conversas ou negócios não podem ser excluídos, para não perder o histórico.`), error, h('div', { class: 'contacts-form__actions' }, cancel, ok)) });
      cancel.addEventListener('click', () => dlg.close());
      ok.addEventListener('click', async () => {
        ok.disabled = true;
        try {
          if (live.enabled) await live.deleteContact(contact.id);
          else {
            if (store.state.deals.some((d) => d.contactId === contact.id) || store.state.conversations.some((cv) => cv.contactId === contact.id)) throw new Error('Este contato tem negócios ou conversas e não pode ser excluído.');
            store.update((s) => (s.contacts = s.contacts.filter((c) => c.id !== contact.id)));
            audit('contact.delete', contact.id, `Contato "${contact.name}" excluído`);
          }
          dlg.close();
          selectedId = null;
          setView('list');
          draw();
          toast('Contato excluído');
        } catch (err) {
          error.textContent = err.message || 'Não foi possível excluir.';
          ok.disabled = false;
        }
      });
    }

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
                  ...deals.map((d) => h('li', null, h('a', { class: 'contacts-mini__row', href: '#/pipeline' }, h('span', { class: 'contacts-mini__main truncate' }, d.title), h('span', { class: 'contacts-mini__sub' }, [store.stage(d.stageId)?.name, valueHidden ? null : fmtBRL(d.value)].filter(Boolean).join(' · ')))))
                )
              : h('p', { class: 'muted' }, 'Nenhum negócio visível para você.')
          ),
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

    newBtn.hidden = decide('contact', 'create', meRow()).effect !== 'allow';
    draw();
    const unsub = store.subscribe(draw);
    return () => {
      clearTimeout(timer);
      unsub();
    };
  },
};
