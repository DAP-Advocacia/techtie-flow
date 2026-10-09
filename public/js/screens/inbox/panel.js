// Coluna direita: dados do contato, tags, cartão do negócio e linha do tempo.
// Só redesenha quando o modelo de visualização muda.
// Permissões: campos ocultos pelo perfil viram "••• oculto" (o valor real nem entra no
// modelo de visualização); o negócio e a linha do tempo só aparecem se o motor deixa ler o negócio.
import { h, fmtBRL, timeAgo } from '../../ui.js';
import { canAccess } from '../../access.js';
import { dealOf } from './actions.js';
import { HIDDEN, HIDDEN_HINT, canReadDeal, isHidden, maskedContact } from './perm.js';

const ago = (ts) => {
  if (!ts) return '';
  const t = timeAgo(ts);
  return t === 'agora' ? 'agora' : `há ${t}`;
};

export function createPanel({ store, navigate }) {
  const el = h('aside', { class: 'inbox-col inbox-col--panel', 'aria-label': 'Detalhes do contato' });
  let key = '';

  function viewModel(conv) {
    const s = store.state;
    const contact = maskedContact(store.contact(conv.contactId)); // campos ocultos já removidos
    const rawDeal = dealOf(store, conv);
    const dealState = !rawDeal ? 'none' : canReadDeal(rawDeal) ? 'ok' : 'restricted';
    const deal = dealState === 'ok' ? rawDeal : null;
    const pipeline = deal && store.pipeline(deal.pipelineId);
    const assignee = conv.assigneeId && store.userById(conv.assigneeId);
    return {
      user: s.currentUserId,
      contact: contact || null,
      hidden: { phone: isHidden('contact', 'phone'), email: isHidden('contact', 'email'), value: isHidden('deal', 'value') },
      responsible: assignee ? assignee.name : 'Na fila · sem responsável',
      dealState,
      canOpenPipeline: canAccess('deal', 'read'),
      deal: deal ? { title: deal.title, value: isHidden('deal', 'value') ? null : deal.value, pipeline: pipeline?.name || '—', stage: store.stage(deal.stageId)?.name || '—' } : null,
      // o histórico do contato mistura eventos do negócio: só com permissão de ler o negócio vinculado
      timeline: dealState === 'restricted' ? [] : (s.timeline[conv.contactId] || []).map((e) => ({ text: e.text, who: e.who, at: e.at })),
    };
  }

  function render(conv) {
    if (!conv) {
      key = '';
      el.replaceChildren(h('div', { class: 'empty' }, h('div', null, 'Os dados do contato aparecem aqui.')));
      return;
    }
    const vm = viewModel(conv);
    const next = JSON.stringify(vm);
    if (next === key) return;
    key = next;

    const c = vm.contact;
    // <wbr> antes de '@' e '.', para e-mail longo quebrar em ponto natural e não no meio da palavra
    const breakable = (v) => (v ? String(v).split(/(?<=@)|(?=\.)/).flatMap((part, i) => (i ? [document.createElement('wbr'), part] : [part])) : '—');
    // campo oculto: texto fixo, sem o valor em title/aria (nada do dado real chega ao DOM)
    const hiddenValue = () => h('span', { class: 'inbox-hidden', title: HIDDEN_HINT, 'aria-label': 'Campo oculto pelo seu perfil' }, HIDDEN);
    const row = (label, value, { wrap = false, hidden = false } = {}) => [h('dt', { class: 'inbox-panel__k' }, label), h('dd', { class: 'inbox-panel__v' }, hidden ? hiddenValue() : wrap ? breakable(value) : value || '—')];

    el.replaceChildren(
      h('div', { class: 'inbox-panel__who' }, h('span', { class: 'label' }, 'Contato'), h('h2', { class: 'inbox-panel__name' }, c?.name || 'Contato removido'), h('span', { class: 'muted' }, c?.company || '')),
      h('dl', { class: 'inbox-panel__grid' }, row('Telefone', c?.phone, { hidden: vm.hidden.phone }), row('E-mail', c?.email, { wrap: true, hidden: vm.hidden.email }), row('Responsável', vm.responsible), row('Origem', c?.source)),
      h('div', { class: 'inbox-panel__tags' }, c?.tags?.length ? c.tags.map((t) => h('span', { class: 'chip' }, t)) : h('span', { class: 'muted inbox-panel__notags' }, 'Sem tags')),
      vm.dealState === 'ok'
        ? h(
            'div',
            { class: 'card card--flat inbox-deal' },
            h('span', { class: 'label' }, 'Negócio'),
            h('div', { class: 'inbox-deal__top' }, h('span', { class: 'inbox-deal__title' }, vm.deal.title), vm.hidden.value ? h('span', { class: 'inbox-deal__value num' }, hiddenValue()) : h('span', { class: 'inbox-deal__value num' }, fmtBRL(vm.deal.value))),
            h('div', { class: 'inbox-deal__meta' }, h('span', null, `Pipeline: ${vm.deal.pipeline}`), h('span', { class: 'inbox-deal__stage' }, vm.deal.stage)),
            vm.canOpenPipeline ? h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => navigate('pipeline') }, 'Abrir no pipeline') : null
          )
        : vm.dealState === 'restricted'
          ? h('div', { class: 'card card--flat card--dashed inbox-deal inbox-deal--none' }, h('span', { class: 'label' }, 'Negócio'), h('span', { class: 'muted' }, 'Negócio e histórico indisponíveis para o seu perfil de acesso.'))
          : h('div', { class: 'card card--flat card--dashed inbox-deal inbox-deal--none' }, h('span', { class: 'label' }, 'Negócio'), h('span', { class: 'muted' }, 'Nenhum negócio vinculado a esta conversa.')),
      vm.dealState === 'restricted'
        ? null
        : h(
            'div',
            { class: 'inbox-timeline' },
            h('span', { class: 'label' }, 'Linha do tempo'),
            vm.timeline.length
              ? h(
                  'ol',
                  { class: 'inbox-timeline__list' },
                  vm.timeline.map((e) => h('li', { class: 'inbox-timeline__item' }, h('span', { class: 'inbox-timeline__dot', 'aria-hidden': 'true' }), h('div', { class: 'inbox-timeline__body' }, h('span', null, e.text), h('span', { class: 'inbox-timeline__when' }, [e.who, ago(e.at)].filter(Boolean).join(' · ')))))
                )
              : h('span', { class: 'muted' }, 'Sem eventos ainda.')
          )
    );
  }

  return { el, render };
}
