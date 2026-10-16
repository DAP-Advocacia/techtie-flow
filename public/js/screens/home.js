// #/home — Início: o que importa agora (resumo) + atalhos rápidos + conversas para responder.
// Tudo calculado sobre o que o motor de permissões deixa o usuário ver (visible/canAccess/fieldLevel);
// os números e atalhos de uma área sem permissão simplesmente não aparecem.
import { h, icon, ICONS, replaceChildren, fmtBRL, fmtInt, timeAgo, avatar } from '../ui.js';
import { canAccess, visible, fieldLevel } from '../access.js';
import { pointInboxTo } from './pipeline/actions.js';
import { greeting, summarizeHome, replyNow } from './home/model.js';
import { isMobile } from '../mobile.js';

const SHORTCUTS = [
  { id: 'inbox', label: 'Inbox', hint: 'Atender no WhatsApp', require: ['conversation', 'read'] },
  { id: 'pipeline', label: 'Negócios', hint: 'Funil de vendas', require: ['deal', 'read'] },
  { id: 'contacts', label: 'Contatos', hint: 'Buscar e abrir conversa', require: ['contact', 'read'] },
  { id: 'dashboard', label: 'Dashboard', hint: 'Números do time', require: ['report', 'read'] },
  { id: 'agent', label: 'Agente de IA', hint: 'Respostas automáticas', require: ['ai_agent', 'read'] },
  { id: 'instances', label: 'Números', hint: 'WhatsApp conectados', require: ['instance', 'read'] },
];
const DESKTOP = [
  { id: 'automations', label: 'Automações', require: ['automation', 'read'] },
  { id: 'users', label: 'Usuários', require: ['user', 'read'] },
  { id: 'settings', label: 'Configurações', require: ['tenant_settings', 'read'] },
  { id: 'permissions', label: 'Permissões', require: ['role', 'read'] },
];
const ok = (r) => !r.require || canAccess(r.require[0], r.require[1]);

export default {
  mount(el, { store, navigate }) {
    const root = h('div', { class: 'page home' });
    el.append(root);

    const stat = (href, value, label, tone) =>
      h('a', { class: 'home-stat' + (tone ? ` home-stat--${tone}` : ''), href }, h('span', { class: 'home-stat__value num' }, value), h('span', { class: 'home-stat__label' }, label));

    function draw() {
      const s = store.state;
      const me = store.user();
      const canChat = canAccess('conversation', 'read');
      const canDeals = canAccess('deal', 'read');
      const canContacts = canAccess('contact', 'read');
      const convs = canChat ? visible('conversation', s.conversations) : [];
      const deals = canDeals ? visible('deal', s.deals) : [];
      const contacts = canContacts ? visible('contact', s.contacts) : [];
      const sum = summarizeHome({ conversations: convs, deals, stageKind: (id) => store.stage(id)?.kind, meId: s.currentUserId, valueHidden: fieldLevel('deal', 'value') === 'hidden' });

      const first = (me?.name || '').split(' ')[0] || 'bem-vindo';
      const today = new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });

      const stats = [
        canChat ? stat('#/inbox', fmtInt(sum.unread), sum.unread === 1 ? 'mensagem não lida' : 'mensagens não lidas', sum.unread ? 'hot' : '') : null,
        canChat ? stat('#/inbox', fmtInt(sum.queue), sum.queue === 1 ? 'conversa na fila' : 'conversas na fila') : null,
        canDeals ? stat('#/pipeline', fmtInt(sum.openDeals), sum.openValue == null ? 'negócios abertos' : `negócios abertos · ${fmtBRL(sum.openValue)}`) : null,
        canContacts ? stat('#/contacts', fmtInt(contacts.length), contacts.length === 1 ? 'contato' : 'contatos') : null,
      ].filter(Boolean);

      const shortcuts = SHORTCUTS.filter(ok).map((r) =>
        h('a', { class: 'home-tile', href: `#/${r.id}` }, h('span', { class: 'home-tile__icon' }, icon(ICONS[r.id], 22)), h('span', { class: 'home-tile__label' }, r.label), h('span', { class: 'home-tile__hint' }, r.hint))
      );
      const desktop = DESKTOP.filter(ok);

      const pending = replyNow(convs, 5);
      const openChat = (c) => {
        if (pointInboxTo(c.id)) navigate('inbox');
      };

      replaceChildren(
        root,
        h('header', { class: 'home-hero' }, h('div', { class: 'eyebrow' }, today.toUpperCase()), h('h1', { class: 'home-hero__title' }, `${greeting()}, `, h('span', { class: 'home-hero__name' }, first))),
        stats.length ? h('section', { class: 'home-stats', 'aria-label': 'Resumo' }, ...stats) : null,
        h(
          'section',
          { class: 'home-section' },
          h('h2', { class: 'home-section__title' }, 'Atalhos'),
          shortcuts.length ? h('div', { class: 'home-tiles' }, ...shortcuts) : h('p', { class: 'muted' }, 'Seu perfil ainda não tem telas liberadas. Fale com o administrador.')
        ),
        canChat
          ? h(
              'section',
              { class: 'home-section' },
              h('h2', { class: 'home-section__title' }, 'Para responder agora'),
              pending.length
                ? h(
                    'ul',
                    { class: 'home-replies' },
                    ...pending.map((c) => {
                      const contact = store.contact(c.contactId);
                      const name = contact?.name || 'Contato';
                      return h(
                        'li',
                        null,
                        h(
                          'button',
                          { class: 'home-reply', type: 'button', onclick: () => openChat(c) },
                          avatar(name),
                          h('span', { class: 'home-reply__text' }, h('span', { class: 'home-reply__name truncate' }, name), h('span', { class: 'home-reply__msg truncate' }, c.lastMessage || 'Nova conversa')),
                          h('span', { class: 'home-reply__side' }, h('span', { class: 'home-reply__time' }, timeAgo(c.lastMessageAt || c.lastAt || Date.now())), h('span', { class: 'badge' }, c.unread))
                        )
                      );
                    })
                  )
                : h('p', { class: 'home-empty' }, 'Nenhuma mensagem esperando resposta. Tudo em dia.')
            )
          : null,
        desktop.length
          ? h(
              'p',
              { class: 'home-note' },
              icon(ICONS.desktop, 16),
              isMobile()
                ? h('span', null, `${desktop.map((r) => r.label).join(', ')} ficam no computador.`)
                : h('span', null, 'Também disponíveis: ', ...desktop.flatMap((r, i) => [i ? ' · ' : '', h('a', { href: `#/${r.id}` }, r.label)]))
            )
          : null
      );
    }

    draw();
    return store.subscribe(draw); // tempo real: mensagens novas atualizam os números
  },
};
