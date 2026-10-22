// #/deal?id=… — Página do negócio (estilo "registro" do Salesforce): destaque com os dados principais e ações,
// Path com as etapas (clique move), e abas Detalhes · Atividade · Proposta · Relacionados.
// Tudo respeita o motor: o negócio só abre se a pessoa pode lê-lo; cada ação pergunta de novo ao motor.
import { h, icon, avatar, replaceChildren, fmtBRL, timeAgo } from '../ui.js';
import { visible, fieldLevel, mask } from '../access.js';
import { hashParam, linkTo } from '../router.js';
import { ensureScreenCss } from '../css.js';
import * as live from '../live.js';
import { renderPanel, renderShareBlock } from './pipeline/panel.js';
import { renderPath } from './pipeline/path.js';
import { createDealController, sending } from './pipeline/controller.js';
import * as P from './pipeline/perm.js';
import * as A from './pipeline/actions.js';
import { tasksBlock } from './tasks/mini.js';
import { tasksOfDeal } from './tasks/actions.js';

const TABS = [
  { id: 'details', label: 'Detalhes' },
  { id: 'activity', label: 'Atividade' },
  { id: 'proposal', label: 'Proposta' },
  { id: 'related', label: 'Relacionados' },
];
const HIDDEN = '•••';
const pad2 = (n) => String(n).padStart(2, '0');
const fmtDate = (ms) => (ms ? `${pad2(new Date(ms).getDate())}/${pad2(new Date(ms).getMonth() + 1)}/${new Date(ms).getFullYear()}` : '—');
const fmtDay = (iso) => (iso ? iso.split('-').reverse().join('/') : '—'); // 'YYYY-MM-DD' → 'DD/MM/YYYY'
const STATUS = { open: 'Aberto', won: 'Ganho', lost: 'Perdido' };

export default {
  mount(el, { store, navigate }) {
    ensureScreenCss('pipeline');
    const dealId = hashParam('id');
    let tab = TABS.some((t) => t.id === hashParam('tab')) ? hashParam('tab') : 'details';
    let activity = null; // [{ id, kind, text, at }] | null (carregando) | 'erro'
    let activitySig = '';
    let alive = true;
    let activityLoading = false;
    const root = h('div', { class: 'page deal' });
    el.append(root);
    const ctl = createDealController({ root, navigate, rerender: () => draw() });

    const dealNow = () => (P.visibleDeals().find((d) => d.id === dealId) ? store.deal(dealId) : null);

    async function loadActivity(deal) {
      if (activityLoading) return;
      activityLoading = true;
      activitySig = signature(deal);
      activity = null;
      try {
        if (live.enabled) activity = await live.dealActivity(deal.id);
        else activity = ((store.state.timeline || {})[deal.contactId] || []).map((e, i) => ({ id: `tl${i}`, kind: 'event', text: e.who ? `${e.who}: ${e.text}` : e.text, at: e.at }));
      } catch {
        activity = 'erro';
      }
      activityLoading = false;
      if (alive && tab === 'activity') draw();
    }
    const signature = (d) => [d.stageId, d.ownerId, d.value, d.title, d.proposalSentAt, d.expectedClose, (d.items || []).length, A.itemsOf(d).length, tasksOfDeal(d.id).map((t) => `${t.id}${t.status}`).join(',')].join('|');

    const field = (label, value, { wide = false } = {}) => h('div', { class: 'deal-field' + (wide ? ' deal-field--wide' : '') }, h('dt', { class: 'label' }, label), h('dd', null, value ?? '—'));

    function draw() {
      if (!alive) return;
      const deal = dealNow();
      if (!deal) {
        replaceChildren(root, h('div', { class: 'empty card deal-missing' }, h('div', { class: 'section-title gold' }, 'Negócio não encontrado'), h('div', null, 'Ele não existe mais ou o seu perfil não pode vê-lo.'), h('a', { class: 'btn btn--primary', href: '#/pipeline' }, 'Voltar para Negócios')));
        return;
      }
      const pipeline = store.pipeline(deal.pipelineId);
      const stage = store.stage(deal.stageId);
      const contact = deal.contactId ? store.contact(deal.contactId) : null;
      const mc = contact ? mask('contact', contact) : null;
      const owner = store.userById(deal.ownerId);
      const lv = P.fieldLevels();
      const valueText = lv.value === 'hidden' ? HIDDEN : fmtBRL(deal.value);
      const kind = stage?.kind || 'open';
      const items = A.itemsOf(deal);
      const canEdit = P.canEditDeal(deal);
      const sendDec = P.sendDecision(deal);
      const finals = (pipeline?.stages || []).filter((s) => s.kind === 'won' || s.kind === 'lost');

      // ---------------- destaque (cabeçalho do registro) ----------------
      const highlights = h(
        'section',
        { class: 'card deal-head' },
        h(
          'div',
          { class: 'deal-head__top' },
          h('div', { class: 'deal-head__id' }, h('span', { class: 'eyebrow' }, `NEGÓCIO · ${pipeline?.name || 'Funil'}`.toUpperCase()), h('h1', { class: 'deal-head__title' }, deal.title), h('div', { class: 'deal-head__sub' }, contact ? h('a', { href: linkTo('contacts', { c: contact.id }) }, mc?.name || contact.name) : h('span', { class: 'muted' }, 'Sem contato'), contact?.company ? h('span', { class: 'muted' }, ` · ${contact.company}`) : null)),
          h(
            'div',
            { class: 'deal-head__actions' },
            canEdit ? h('button', { class: 'btn btn--ghost', type: 'button', 'data-focus': 'edit', onclick: () => ctl.editDeal(deal) }, 'Editar') : null,
            h('button', { class: 'btn btn--primary', type: 'button', disabled: !items.length || sendDec.effect !== 'allow' || sending.has(deal.id), title: !items.length ? 'Adicione produtos na aba Proposta' : sendDec.effect !== 'allow' ? P.reasonOf(sendDec, 'enviar a proposta') : '', onclick: () => ctl.send(deal) }, sending.has(deal.id) ? 'Enviando…' : 'Enviar proposta')
          )
        ),
        h(
          'dl',
          { class: 'deal-facts' },
          field('Valor', valueText),
          field('Responsável', owner ? h('span', { class: 'deal-owner' }, avatar(owner.name, { small: true }), owner.name) : 'Sem responsável'),
          field('Etapa', h('span', { class: `deal-stage deal-stage--${kind}` }, stage?.name || '—')),
          field('Previsão de fechamento', fmtDay(deal.expectedClose)),
          field('Na etapa há', deal.stageChangedAt ? timeAgo(deal.stageChangedAt) : '—'),
          field('Criado em', fmtDate(deal.createdAt))
        )
      );

      // ---------------- Path ----------------
      const path = h('section', { class: 'card deal-path' }, renderPath({ pipeline, deal, onMove: (st) => ctl.requestMove(deal.id, st.id) }));

      // ---------------- abas ----------------
      const tabs = h(
        'div',
        { class: 'deal-tabs', role: 'tablist', 'aria-label': 'Seções do negócio' },
        ...TABS.map((t) =>
          h(
            'button',
            {
              class: 'deal-tab' + (t.id === tab ? ' is-active' : ''),
              type: 'button',
              role: 'tab',
              'aria-selected': String(t.id === tab),
              'data-tab': t.id,
              onclick: () => {
                tab = t.id;
                if (t.id === 'activity' && (activity === null || activitySig !== signature(deal))) loadActivity(deal);
                draw();
              },
            },
            t.label,
            t.id === 'proposal' && items.length ? h('span', { class: 'deal-tab__n' }, items.length) : null
          )
        )
      );

      let body;
      if (tab === 'details') body = detailsTab(deal, { pipeline, stage, owner, mc, lv, kind, canEdit, finals });
      else if (tab === 'activity') body = activityTab(deal);
      else if (tab === 'proposal') body = proposalTab(deal);
      else body = relatedTab(deal, contact, mc);

      replaceChildren(root, highlights, path, tabs, h('div', { class: 'deal-body', role: 'tabpanel' }, body));
    }

    // ---------------- Detalhes ----------------
    function detailsTab(deal, { pipeline, stage, owner, mc, lv, kind, canEdit, finals }) {
      const team = deal.teamId ? store.state.teams.find((t) => t.id === deal.teamId) : null;
      const finishBtns = finals.map((st) => {
        const dec = P.moveDecision(deal, st);
        const here = st.id === deal.stageId;
        const ok = dec.effect === 'allow' && !here;
        return h('button', { class: 'btn btn--quiet' + (st.kind === 'won' ? ' deal-won' : ' deal-lost'), type: 'button', disabled: !ok, title: here ? `Já está em ${st.name}` : dec.effect === 'allow' ? '' : dec.effect === 'approval' ? 'Requer aprovação de um gestor.' : P.reasonOf(dec, 'mover este negócio'), onclick: () => ctl.requestMove(deal.id, st.id) }, st.kind === 'won' ? 'Marcar ganho' : 'Marcar perdido');
      });
      const del = P.deleteDecision(deal);
      return h(
        'div',
        { class: 'deal-details' },
        h(
          'dl',
          { class: 'card deal-grid' },
          field('Negócio', deal.title),
          field('Funil', pipeline?.name || '—'),
          field('Etapa', stage?.name || '—'),
          field('Situação', STATUS[kind] || 'Aberto'),
          field('Valor', lv.value === 'hidden' ? HIDDEN : fmtBRL(deal.value)),
          field('Responsável', owner?.name || 'Sem responsável'),
          field('Equipe', team?.name || '—'),
          field('Previsão de fechamento', fmtDay(deal.expectedClose)),
          field('Criado em', fmtDate(deal.createdAt)),
          field('Na etapa desde', fmtDate(deal.stageChangedAt)),
          field('Última proposta enviada', deal.proposalSentAt ? fmtDate(deal.proposalSentAt) : '—'),
          field('Contato', mc ? `${mc.name}${mc.company ? ` · ${mc.company}` : ''}` : '—')
        ),
        h('div', { class: 'deal-actions' }, ...finishBtns, canEdit ? h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => ctl.editDeal(deal) }, 'Editar dados') : null, del.effect === 'allow' ? h('button', { class: 'btn btn--quiet deal-danger', type: 'button', 'data-focus': 'delete', onclick: () => ctl.confirmDelete(deal, { onDeleted: () => navigate('pipeline') }) }, 'Excluir negócio') : null)
      );
    }

    // ---------------- Atividade ----------------
    function activityTab(deal) {
      if (activity === null) {
        loadActivity(deal);
        return h('div', { class: 'card deal-activity' }, h('p', { class: 'muted' }, 'Carregando atividade…'));
      }
      if (activity === 'erro') return h('div', { class: 'card deal-activity' }, h('p', { class: 'muted' }, 'Não foi possível carregar a atividade agora.'), h('button', { class: 'btn btn--quiet', type: 'button', onclick: () => loadActivity(deal).then(draw) }, 'Tentar de novo'));
      return h(
        'div',
        { class: 'card deal-activity' },
        activity.length
          ? h('ol', { class: 'deal-timeline' }, ...activity.map((a) => h('li', { class: `deal-timeline__item deal-timeline__item--${a.kind}` }, h('span', { class: 'deal-timeline__dot', 'aria-hidden': 'true' }), h('div', null, h('div', { class: 'deal-timeline__text' }, a.text), h('time', { title: new Date(a.at).toLocaleString('pt-BR') }, `há ${timeAgo(a.at)}`)))))
          : h('p', { class: 'muted' }, 'Ainda não há atividade registrada neste negócio.')
      );
    }

    // ---------------- Proposta ----------------
    function proposalTab(deal) {
      const host = h('div', { class: 'pipeline-panel deal-proposal' });
      renderPanel(host, {
        deal,
        compact: true,
        sending: sending.has(deal.id),
        onAddProduct: () => ctl.addProduct(deal),
        onRemoveItem: (i) => ctl.removeItem(deal, i),
        onSend: () => ctl.send(deal),
        onOpenChat: () => ctl.openChat(deal),
        onFinish: (st) => ctl.requestMove(deal.id, st.id),
        onDelete: () => ctl.confirmDelete(deal, { onDeleted: () => navigate('pipeline') }),
        onShare: (t) => ctl.share(deal, t),
        onUnshare: (t) => ctl.unshare(deal, t),
      });
      return host;
    }

    // ---------------- Relacionados ----------------
    function relatedTab(deal, contact, mc) {
      const convs = visible('conversation', store.state.conversations).filter((c) => c.contactId === deal.contactId);
      const phoneHidden = fieldLevel('contact', 'phone') === 'hidden';
      const emailHidden = fieldLevel('contact', 'email') === 'hidden';
      return h(
        'div',
        { class: 'deal-related' },
        h('div', { class: 'deal-related__col' }, tasksBlock({ tasks: visible('task', tasksOfDeal(deal.id)), defaults: { dealId: deal.id, contactId: deal.contactId }, limit: 20, title: 'Tarefas do negócio' }), renderShareBlock(deal, { onShare: (t) => ctl.share(deal, t), onUnshare: (t) => ctl.unshare(deal, t) })),
        h(
          'div',
          { class: 'deal-related__col' },
          h(
            'section',
            { class: 'card deal-contact' },
            h('span', { class: 'label' }, 'Contato'),
            contact
              ? h('div', { class: 'deal-contact__body' }, h('div', { class: 'deal-contact__name' }, avatar(mc?.name || contact.name), h('div', null, h('a', { href: linkTo('contacts', { c: contact.id }) }, mc?.name || contact.name), contact.company ? h('div', { class: 'muted' }, contact.company) : null)), h('dl', { class: 'deal-contact__kv' }, field('Telefone', phoneHidden ? HIDDEN : mc?.phone || '—'), field('E-mail', emailHidden ? HIDDEN : mc?.email || '—')))
              : h('p', { class: 'muted' }, 'Este negócio não tem contato vinculado.')
          ),
          h(
            'section',
            { class: 'card deal-convs' },
            h('span', { class: 'label' }, `Conversas${convs.length ? ` (${convs.length})` : ''}`),
            convs.length
              ? h('ul', { class: 'deal-convs__list' }, ...convs.map((cv) => h('li', null, h('button', { class: 'deal-conv', type: 'button', onclick: () => A.pointInboxTo(cv.id) && navigate('inbox') }, h('span', { class: 'deal-conv__msg' }, cv.lastMessage || 'Sem mensagens'), h('span', { class: 'deal-conv__meta muted' }, [store.instance(cv.instanceId)?.name, cv.unread ? `${cv.unread} não lida${cv.unread > 1 ? 's' : ''}` : null].filter(Boolean).join(' · '))))))
              : h('p', { class: 'muted' }, 'Nenhuma conversa visível para você com este contato.')
          )
        )
      );
    }

    draw();
    const unsub = store.subscribe(() => {
      const deal = dealNow();
      if (deal && tab === 'activity' && activity !== null && activitySig !== signature(deal)) loadActivity(deal); // algo mudou: atualiza o feed
      draw();
    });
    return () => {
      alive = false;
      unsub();
    };
  },
};

