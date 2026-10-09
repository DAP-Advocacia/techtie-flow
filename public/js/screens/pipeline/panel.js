// Painel direito: proposta do negócio selecionado + ações + compartilhamento.
// Cada controle reflete uma decisão do motor (perm.js); negado = desabilitado COM o motivo
// (title + texto visível). Campos ocultos pelo perfil nunca entram no DOM.
import { store } from '../../store.js';
import { h, icon, fmtBRL, fmtListTime, replaceChildren } from '../../ui.js';
import { itemsOf, sumItems } from './actions.js';
import * as P from './perm.js';

const DOC_ICON = 'M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8zM14 3v5h5M9 13h6M9 17h4';
const CLOSE_ICON = 'M18 6L6 18M6 6l12 12';
const MASK = '•••';
const LEVEL_NAME = { read: 'Leitura', edit: 'Edição' };

// Cada dica aparece uma vez por render (várias ações bloqueadas pelo mesmo motivo não repetem o texto).
let shown = new Set();
const hint = (text, tone) => {
  if (!text || shown.has(text)) return null;
  shown.add(text);
  return h('div', { class: 'pipeline-hint' + (tone ? ` is-${tone}` : ''), role: tone === 'warn' ? 'note' : null }, text);
};

/** Estado vazio (sem negócio selecionado / sem acesso). */
export function renderPanelEmpty(host, message) {
  replaceChildren(
    host,
    h('div', null, h('div', { class: 'label' }, 'Proposta'), h('div', { class: 'pipeline-panel__title' }, 'Nenhum negócio')),
    h('div', { class: 'empty pipeline-panel__empty' }, icon(DOC_ICON, 28), h('div', null, message || 'Selecione um cartão no quadro para ver e montar a proposta.'))
  );
}

export function renderPanel(host, { deal, sending, onAddProduct, onRemoveItem, onSend, onOpenChat, onFinish, onDelete, onShare, onUnshare, emptyMessage }) {
  if (!deal) return renderPanelEmpty(host, emptyMessage);
  shown = new Set();

  const contact = store.contact(deal.contactId);
  const stage = store.stage(deal.stageId);
  const pipeline = store.pipeline(deal.pipelineId);
  const items = itemsOf(deal);
  const lv = P.fieldLevels();
  const hidePrices = P.pricesHidden(lv);
  const money = (n) => (hidePrices ? MASK : fmtBRL(n));

  // --- decisões do motor ---
  const readProposal = P.proposalReadDecision(deal);
  const itemsHidden = lv.items === 'hidden' || readProposal.effect === 'deny';
  const edit = P.editDecision(deal);
  const send = P.sendDecision(deal);
  const chat = P.chatFor(deal);
  const del = P.deleteDecision(deal);
  const share = P.shareDecision(deal);
  const editBlocked = edit.effect === 'deny';
  const editApproval = edit.effect === 'approval';
  const sendBlocked = send.effect === 'deny';

  // --- itens da proposta ---
  const priceCell = (it) => h('span', { class: 'num pipeline-items__price' + (hidePrices ? ' is-hidden' : ''), 'aria-label': hidePrices ? 'Preço oculto' : null }, money(it.total));
  const itemsBox = itemsHidden
    ? h(
        'div',
        { class: 'pipeline-noitems' },
        icon(DOC_ICON, 26),
        h('strong', null, lv.items === 'hidden' ? 'Itens da proposta ocultos' : 'Sem acesso à proposta'),
        h('span', { class: 'muted' }, lv.items === 'hidden' ? 'Seu perfil não vê os itens desta proposta.' : P.reasonOf(readProposal, 'ver propostas')),
        lv.value === 'hidden' ? null : h('span', { class: 'pipeline-noitems__est' }, 'Valor estimado ', h('b', { class: 'num' }, fmtBRL(deal.value)))
      )
    : items.length
      ? h(
          'div',
          { class: 'pipeline-items' },
          ...items.map((it, i) =>
            h(
              'div',
              { class: 'pipeline-items__row' },
              h(
                'div',
                { class: 'pipeline-items__info' },
                h('span', null, it.name),
                h('span', { class: 'pipeline-items__note' }, it.note || (hidePrices ? `${it.qty} ×` : `${it.qty} × ${fmtBRL(it.unitPrice)}`), it.discountPct && lv.discount !== 'hidden' ? ` · desconto ${it.discountPct}%` : '')
              ),
              priceCell(it),
              h(
                'button',
                {
                  class: 'pipeline-items__remove',
                  type: 'button',
                  disabled: sending || editBlocked,
                  'aria-label': `Remover ${it.name}`,
                  title: editBlocked ? P.reasonOf(edit, 'editar a proposta') : 'Remover',
                  'data-focus': `remove:${i}`,
                  onclick: () => onRemoveItem(i),
                },
                icon(CLOSE_ICON, 14)
              )
            )
          ),
          h('div', { class: 'pipeline-items__total' }, h('span', { class: 'pipeline-items__total-label' }, 'TOTAL'), h('span', { class: 'pipeline-items__total-value num' + (hidePrices ? ' is-hidden' : ''), 'aria-label': hidePrices ? 'Total oculto' : null }, money(sumItems(deal))))
        )
      : h(
          'div',
          { class: 'pipeline-noitems' },
          icon(DOC_ICON, 26),
          h('strong', null, 'Nenhum produto na proposta'),
          h('span', { class: 'muted' }, 'Adicione produtos para montar a proposta e enviá-la pelo WhatsApp.'),
          lv.value === 'hidden' ? null : h('span', { class: 'pipeline-noitems__est' }, 'Valor estimado ', h('b', { class: 'num' }, fmtBRL(deal.value)))
        );

  // --- ações principais ---
  const addHint = editBlocked ? P.reasonOf(edit, 'editar a proposta') : editApproval ? 'Esta proposta tem desconto acima do limite do seu perfil: alterá-la precisa de aprovação de um gestor.' : lv.value === 'readonly' ? 'Valores travados pelo seu perfil.' : '';
  const chatHint = !chat.conv ? 'Este contato ainda não tem conversa' : chat.decision.effect !== 'allow' ? P.reasonOf(chat.decision, 'ler a conversa deste contato') : null;
  const sendHint = sendBlocked ? P.reasonOf(send, 'enviar a proposta') : '';

  // Ganho / Perdido (atalhos para a regra de mover) e Excluir.
  const finals = (pipeline?.stages || []).filter((s) => s.kind === 'won' || s.kind === 'lost');
  const finishBtns = finals.map((st) => {
    const dec = P.moveDecision(deal, st);
    const here = st.id === deal.stageId;
    const ok = dec.effect === 'allow' && !here;
    const why = here ? `Já está em ${st.name}` : dec.effect === 'allow' ? null : dec.effect === 'approval' ? 'Requer aprovação de um gestor.' : P.reasonOf(dec, 'mover este negócio');
    return h(
      'button',
      { class: 'btn btn--quiet btn--sm pipeline-actions__btn' + (st.kind === 'won' ? ' is-won' : ' is-lost'), type: 'button', disabled: !ok, title: why, 'data-focus': `finish:${st.kind}`, onclick: () => onFinish(st) },
      st.kind === 'won' ? 'Marcar ganho' : 'Marcar perdido'
    );
  });
  const delBtn = h('button', { class: 'btn btn--quiet btn--sm pipeline-actions__btn is-danger', type: 'button', disabled: del.effect !== 'allow', title: del.effect === 'allow' ? null : P.reasonOf(del, 'excluir negócios'), 'data-focus': 'delete', onclick: onDelete }, 'Excluir');
  const blockedReasons = [...new Set([...finals.map((st) => P.moveDecision(deal, st)).filter((d) => d.effect !== 'allow').map((d) => P.reasonOf(d, 'mover este negócio')), del.effect !== 'allow' ? P.reasonOf(del, 'excluir negócios') : null].filter(Boolean))];

  replaceChildren(
    host,
    h('div', null, h('div', { class: 'label' }, 'Proposta'), h('div', { class: 'pipeline-panel__title' }, deal.title), h('div', { class: 'muted' }, `${contact?.company || 'Sem empresa'} · ${stage?.name || '—'}`)),
    itemsBox,
    h('button', { class: 'pipeline-add', type: 'button', disabled: sending || editBlocked || itemsHidden, title: editBlocked ? P.reasonOf(edit, 'editar a proposta') : null, 'data-focus': 'add', onclick: onAddProduct }, '+ Adicionar produto'),
    hint(addHint, editApproval ? 'warn' : null),
    h(
      'button',
      // aria-disabled (e não disabled) durante o envio: o botão não perde o foco do teclado.
      { class: 'btn btn--primary btn--block', type: 'button', disabled: !items.length || sendBlocked, title: sendHint || null, 'aria-disabled': sending ? 'true' : null, 'aria-busy': sending ? 'true' : null, 'data-focus': 'send', onclick: onSend },
      sending ? 'Enviando…' : 'Enviar proposta (WhatsApp)'
    ),
    sendHint && sendHint !== addHint ? hint(sendHint) : null,
    deal.proposalSentAt ? h('div', { class: 'pipeline-panel__sent' }, `Última proposta enviada · ${fmtListTime(deal.proposalSentAt)}`) : null,
    h('button', { class: 'btn btn--quiet btn--block', type: 'button', 'data-focus': 'chat', disabled: !chat.conv || chat.decision.effect !== 'allow', title: chatHint, onclick: onOpenChat }, 'Abrir conversa'),
    chat.conv && chat.decision.effect !== 'allow' ? hint(chatHint) : null,
    h('div', { class: 'pipeline-actions', role: 'group', 'aria-label': 'Ações do negócio' }, ...finishBtns, delBtn),
    hint(blockedReasons.filter((t) => !shown.has(t)).join(' ')),
    shareBlock(deal, share, { onShare, onUnshare })
  );
}

// ---------------------------------------------------------------------------
// Compartilhamento por registro
// ---------------------------------------------------------------------------

function shareBlock(deal, decision, { onShare, onUnshare }) {
  const s = store.state;
  const canShare = decision.effect === 'allow';
  const owner = store.userById(deal.ownerId);
  const entries = (Array.isArray(deal.sharedWith) ? deal.sharedWith : []).map((g) => ({
    ...g,
    name: g.type === 'user' ? s.users.find((u) => u.id === g.id)?.name : s.teams.find((t) => t.id === g.id)?.name,
  }));

  const rows = [
    h('li', { class: 'pipeline-share__row' }, h('span', { class: 'pipeline-share__who' }, owner?.name || 'Sem responsável'), h('span', { class: 'pipeline-share__lvl' }, 'Responsável')),
    ...entries.map((g) =>
      h(
        'li',
        { class: 'pipeline-share__row' },
        h('span', { class: 'pipeline-share__who' }, g.name || g.id),
        h('span', { class: 'pipeline-share__lvl' }, `${g.type === 'team' ? 'Equipe · ' : ''}${LEVEL_NAME[g.level] || g.level}`),
        canShare
          ? h('button', { class: 'pipeline-items__remove', type: 'button', 'aria-label': `Remover acesso de ${g.name || g.id}`, title: 'Remover acesso', 'data-focus': `unshare:${g.type}:${g.id}`, onclick: () => onUnshare(g) }, icon(CLOSE_ICON, 14))
          : null
      )
    ),
  ];

  let form = null;
  if (canShare) {
    const taken = new Set(entries.map((g) => `${g.type}:${g.id}`));
    const users = s.users.filter((u) => !u.isBot && u.status === 'active' && u.id !== deal.ownerId && !taken.has(`user:${u.id}`));
    const teams = s.teams.filter((t) => !taken.has(`team:${t.id}`));
    const target = h(
      'select',
      { class: 'select', 'aria-label': 'Compartilhar com', 'data-focus': 'share-target' },
      h('option', { value: '' }, 'Compartilhar com…'),
      users.length ? h('optgroup', { label: 'Usuários' }, ...users.map((u) => h('option', { value: `user:${u.id}` }, u.name))) : null,
      teams.length ? h('optgroup', { label: 'Equipes' }, ...teams.map((t) => h('option', { value: `team:${t.id}` }, t.name))) : null
    );
    const level = h('select', { class: 'select', 'aria-label': 'Nível de acesso' }, h('option', { value: 'read' }, 'Leitura'), h('option', { value: 'edit' }, 'Edição'));
    const addBtn = h('button', { class: 'btn btn--quiet btn--sm', type: 'submit', disabled: true, 'data-focus': 'share-add' }, 'Compartilhar');
    target.addEventListener('change', () => {
      addBtn.disabled = !target.value;
    });
    form = h(
      'form',
      {
        class: 'pipeline-share__form',
        onsubmit: (e) => {
          e.preventDefault();
          const [type, id] = target.value.split(':');
          if (!type || !id) return;
          onShare({ type, id, level: level.value });
        },
      },
      target,
      h('div', { class: 'pipeline-share__formrow' }, level, addBtn)
    );
  }

  return h(
    'section',
    { class: 'pipeline-share', 'aria-label': 'Compartilhamento do negócio' },
    h('div', { class: 'label' }, 'Quem tem acesso'),
    h('ul', { class: 'pipeline-share__list' }, ...rows),
    form,
    hint(canShare ? 'Além do responsável, quem o perfil já permite ver (equipe, administração) também acessa.' : 'Só quem pode editar ou transferir o negócio o compartilha.')
  );
}
