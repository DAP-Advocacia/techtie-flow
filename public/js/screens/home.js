// #/home — Início: o que importa agora (resumo, tarefas de hoje, negócios fechando no mês, meta do mês) + atalhos + conversas.
// Tudo calculado sobre o que o motor de permissões deixa o usuário ver (visible/canAccess/fieldLevel);
// os números e atalhos de uma área sem permissão simplesmente não aparecem.
import { h, icon, ICONS, replaceChildren, fmtBRL, fmtInt, timeAgo, avatar } from '../ui.js';
import { store as appStore } from '../store.js';
import { canAccess, visible, fieldLevel, matrixFor } from '../access.js';
import { pointInboxTo } from './pipeline/actions.js';
import { greeting, summarizeHome, replyNow, closingThisMonth, monthGoal } from './home/model.js';
import { canSetGoal, openGoalDialog } from './home/goal.js';
import { isMobile } from '../mobile.js';
import { tasksBlock } from './tasks/mini.js';
import { allTasks } from './tasks/actions.js';
import { todaySummary } from './tasks/model.js';

const SHORTCUTS = [
  { id: 'inbox', label: 'Inbox', hint: 'Atender no WhatsApp', require: ['conversation', 'read'] },
  { id: 'pipeline', label: 'Negócios', hint: 'Funil de vendas', require: ['deal', 'read'] },
  { id: 'contacts', label: 'Contatos', hint: 'Buscar e abrir conversa', require: ['contact', 'read'] },
  { id: 'tasks', label: 'Tarefas', hint: 'Seu dia, por prazo', require: ['task', 'read'] },
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

const fmtDay = (t) => new Date(t).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
const plural = (n, one, many) => `${fmtInt(n)} ${n === 1 ? one : many}`;

/** Negócios abertos com previsão de fechamento neste mês (do mais próximo ao mais distante). */
function closingCard(c, valueHidden) {
  const sub = [plural(c.count, 'negócio', 'negócios'), valueHidden || c.total == null ? null : fmtBRL(c.total), valueHidden || !c.weighted ? null : `previsão ponderada ${fmtBRL(c.weighted)}`, c.late ? `${c.late} com previsão vencida` : null].filter(Boolean).join(' · ');
  return h(
    'section',
    { class: 'home-card home-closing', 'aria-label': 'Fechando este mês' },
    h('div', { class: 'home-card__head' }, h('h2', { class: 'home-section__title' }, 'Fechando este mês'), c.count ? h('a', { class: 'home-card__link', href: '#/pipeline?view=closing' }, 'Ver todos') : null),
    c.count
      ? [
          h('p', { class: 'home-card__sum' }, sub),
          h(
            'ul',
            { class: 'home-closing__list' },
            ...c.rows.slice(0, 6).map(({ deal, at, late }) => {
              const st = appStore.stage(deal.stageId)?.name;
              const company = appStore.contact(deal.contactId)?.company;
              return h(
                'li',
                null,
                h(
                  'a',
                  { class: 'home-closing__row', href: `#/deal?id=${deal.id}` },
                  h('span', { class: 'home-closing__main' }, h('span', { class: 'home-closing__title truncate' }, deal.title), h('span', { class: 'home-closing__sub truncate' }, [company, st].filter(Boolean).join(' · '))),
                  h('span', { class: 'home-closing__side' }, valueHidden ? null : h('span', { class: 'home-closing__value num' }, fmtBRL(deal.value)), h('span', { class: 'home-closing__date' + (late ? ' is-late' : '') }, late ? `venceu ${fmtDay(at)}` : fmtDay(at)))
                )
              );
            })
          ),
        ]
      : h('p', { class: 'home-empty' }, 'Nenhum negócio com previsão de fechamento neste mês. Informe a previsão ao editar o negócio.'),
    c.overdueBefore ? h('p', { class: 'home-card__note' }, `${plural(c.overdueBefore, 'negócio aberto tem', 'negócios abertos têm')} previsão de meses anteriores.`) : null
  );
}

/** Meta de receita do mês: o ganho do mês contra a meta, o que falta e o ritmo. */
function goalCard(g) {
  const pct = g.pct == null ? null : Math.round(g.pct * 100);
  const set = () => openGoalDialog();
  const edit = canSetGoal();
  return h(
    'section',
    { class: 'home-card home-goal', 'aria-label': 'Meta do mês' },
    h('div', { class: 'home-card__head' }, h('h2', { class: 'home-section__title' }, 'Meta do mês'), edit && g.goal ? h('button', { class: 'home-card__link', type: 'button', 'data-focus': 'goal-edit', onclick: set }, 'Alterar') : null),
    g.goal
      ? [
          h('p', { class: 'home-goal__value' }, h('span', { class: 'num' }, fmtBRL(g.won)), h('span', { class: 'muted' }, ` de ${fmtBRL(g.goal)}`)),
          h(
            'div',
            { class: 'home-goal__bar', role: 'progressbar', 'aria-label': 'Progresso da meta', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.min(pct, 100)) },
            h('span', { class: 'home-goal__fill' + (g.remaining === 0 ? ' is-done' : g.onTrack ? '' : ' is-behind'), style: { width: `${Math.min(100, Math.max(0, pct))}%` } })
          ),
          h(
            'p',
            { class: 'home-goal__meta' },
            h('span', null, `${pct}% da meta`),
            g.remaining === 0 ? h('span', { class: 'home-goal__chip is-done' }, 'Meta batida') : h('span', { class: 'home-goal__chip' + (g.onTrack ? '' : ' is-behind') }, g.onTrack ? 'No ritmo' : 'Abaixo do ritmo'),
            h('span', { class: 'muted' }, [g.remaining ? `faltam ${fmtBRL(g.remaining)}` : null, g.daysLeft ? `${plural(g.daysLeft, 'dia', 'dias')} no mês` : 'último dia do mês'].filter(Boolean).join(' · '))
          ),
        ]
      : [
          h('p', { class: 'home-goal__value' }, h('span', { class: 'num' }, fmtBRL(g.won)), h('span', { class: 'muted' }, ' ganhos neste mês')),
          edit ? h('button', { class: 'btn btn--ghost btn--sm home-goal__set', type: 'button', 'data-focus': 'goal-set', onclick: set }, 'Definir meta do mês') : h('p', { class: 'home-empty' }, 'A meta do mês ainda não foi definida.'),
        ]
  );
}

/** Conversas com mensagem esperando resposta. */
function repliesCard(pending, openChat) {
  return h(
    'section',
    { class: 'home-section' },
    h('h2', { class: 'home-section__title' }, 'Para responder agora'),
    pending.length
      ? h(
          'ul',
          { class: 'home-replies' },
          ...pending.map((c) => {
            const contact = appStore.contact(c.contactId);
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
  );
}

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
      const valueHidden = fieldLevel('deal', 'value') === 'hidden';
      const stageKind = (id) => store.stage(id)?.kind;
      const sum = summarizeHome({ conversations: convs, deals, stageKind, meId: s.currentUserId, valueHidden });

      // "Fechando este mês" (previsão de fechamento) e meta do mês. A meta é da EMPRESA: só aparece para quem lê os negócios
      // de todo o tenant (senão o ganho parcial do perfil pareceria atraso em relação à meta) e que enxerga os valores.
      const closing = canDeals ? closingThisMonth({ deals, stageKind, probability: (id) => store.stage(id)?.probability, valueHidden }) : null;
      const dealRead = canDeals ? matrixFor()?.deal?.read : null;
      const goal = canDeals && !valueHidden && dealRead?.scope === 'tenant' && !dealRead.conditional ? monthGoal({ deals, stageKind, goal: s.tenant?.goals?.monthlyRevenue }) : null;

      const tsum = canAccess('task', 'read') ? todaySummary(visible('task', allTasks()), s.currentUserId) : null;
      const first = (me?.name || '').split(' ')[0] || 'bem-vindo';
      const today = new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });

      const stats = [
        canChat ? stat('#/inbox', fmtInt(sum.unread), sum.unread === 1 ? 'mensagem não lida' : 'mensagens não lidas', sum.unread ? 'hot' : '') : null,
        canChat ? stat('#/inbox', fmtInt(sum.queue), sum.queue === 1 ? 'conversa na fila' : 'conversas na fila') : null,
        canDeals ? stat('#/pipeline', fmtInt(sum.openDeals), sum.openValue == null ? 'negócios abertos' : `negócios abertos · ${fmtBRL(sum.openValue)}`) : null,
        canContacts ? stat('#/contacts', fmtInt(contacts.length), contacts.length === 1 ? 'contato' : 'contatos') : null,
        tsum ? stat('#/tasks', fmtInt(tsum.total), tsum.overdue ? `tarefas para hoje · ${tsum.overdue} atrasada${tsum.overdue > 1 ? 's' : ''}` : 'tarefas para hoje', tsum.overdue ? 'hot' : '') : null,
      ].filter(Boolean);

      const shortcuts = SHORTCUTS.filter(ok).map((r) =>
        h('a', { class: 'home-tile', href: `#/${r.id}` }, h('span', { class: 'home-tile__icon' }, icon(ICONS[r.id], 22)), h('span', { class: 'home-tile__label' }, r.label), h('span', { class: 'home-tile__hint' }, r.hint))
      );
      const desktop = DESKTOP.filter(ok);

      const pending = replyNow(convs, 5);
      const openChat = (c) => {
        if (pointInboxTo(c.id)) navigate('inbox');
      };

      const main = [tsum ? h('section', { class: 'home-section' }, tasksBlock({ tasks: tsum.list, title: 'Para hoje', limit: 6, empty: 'Nenhuma tarefa para hoje.' })) : null, closing ? closingCard(closing, valueHidden) : null].filter(Boolean);
      const aside = [goal ? goalCard(goal) : null, canChat ? repliesCard(pending, openChat) : null].filter(Boolean);

      replaceChildren(
        root,
        h('header', { class: 'home-hero' }, h('div', { class: 'eyebrow' }, today.toUpperCase()), h('h1', { class: 'home-hero__title' }, `${greeting()}, `, h('span', { class: 'home-hero__name' }, first))),
        stats.length ? h('section', { class: 'home-stats', 'aria-label': 'Resumo' }, ...stats) : null,
        main.length || aside.length ? h('div', { class: 'home-grid' + (main.length && aside.length ? '' : ' home-grid--single') }, main.length ? h('div', { class: 'home-col' }, ...main) : null, aside.length ? h('div', { class: 'home-col' }, ...aside) : null) : null,
        h(
          'section',
          { class: 'home-section' },
          h('h2', { class: 'home-section__title' }, 'Atalhos'),
          shortcuts.length ? h('div', { class: 'home-tiles' }, ...shortcuts) : h('p', { class: 'muted' }, 'Seu perfil ainda não tem telas liberadas. Fale com o administrador.')
        ),
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
