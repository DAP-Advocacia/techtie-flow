// Coluna central: cabeçalho (com menu Transferir), bolhas e o slot do composer.
// Cabeçalho e mensagens só são redesenhados quando o que mostram muda (chave
// JSON), então o menu aberto e o scroll sobrevivem a atualizações do store.
// Botões de ação ficam DESABILITADOS (não somem) com o motivo do motor no title.
import { h, avatar, fmtTime, replaceChildren } from '../../ui.js';
import { firstName, messagesOf } from './actions.js';
import { HIDDEN, isHidden, maskedContact, staysVisibleInQueue, transferTargets } from './perm.js';

// Atributos de um botão bloqueado pelo motor: disabled + motivo em title e aria-label.
const gated = (label, verdict) => (verdict.ok ? {} : { disabled: true, title: verdict.msg, 'aria-label': `${label} — indisponível: ${verdict.msg}` });

function dayLabel(ts, now = Date.now()) {
  const start = (t) => {
    const d = new Date(t);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const diff = Math.round((start(now) - start(ts)) / 86400000);
  if (diff <= 0) return 'Hoje';
  if (diff === 1) return 'Ontem';
  return new Date(ts).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function createThread({ store, onTransfer, onResolve, onReopen, onUseReply, onFollowUp, footer }) {
  let menuOpen = false;
  let headerKey = '';
  let msgsKey = '';
  let lastConvId = null;
  let lastMsgId = null;
  let cleanupMenu = null;
  let current = { conv: null, typing: false, access: null, supervising: null }; // último render, para o menu se redesenhar sozinho

  const header = h('header', { class: 'inbox-thread__head' });
  const banner = h('div', { class: 'inbox-supervise', role: 'note', hidden: true });
  const scroller = h('div', { class: 'inbox-msgs', role: 'log', 'aria-label': 'Mensagens da conversa', tabindex: '0' });
  const emptyMsg = h('div', null, 'Selecione uma conversa para começar o atendimento.');
  const emptyState = h('div', { class: 'empty inbox-thread__empty', hidden: true }, h('div', { class: 'section-title gold' }, 'Inbox'), emptyMsg);
  const el = h('section', { class: 'inbox-col inbox-col--thread', 'aria-label': 'Conversa' }, header, banner, scroller, footer, emptyState);

  // ---------- menu Transferir ----------
  function closeMenu({ restoreFocus = false } = {}) {
    if (!menuOpen) return;
    menuOpen = false;
    cleanupMenu?.();
    cleanupMenu = null;
    if (current.conv && current.access) renderHeader(current.conv, current.typing, current.access);
    if (restoreFocus) header.querySelector('.inbox-transfer__btn')?.focus();
  }

  function openMenu() {
    if (!current.access?.transfer.ok) return; // o motor nega transferir esta conversa
    menuOpen = true;
    renderHeader(current.conv, current.typing, current.access);
    const menu = header.querySelector('.inbox-menu');
    const items = () => [...menu.querySelectorAll('[role="menuitem"]:not(:disabled)')];
    items()[0]?.focus();
    // clique fora e Esc fecham; setas navegam. Registrados no document, então a limpeza é obrigatória.
    const onDown = (e) => {
      if (!e.target.closest?.('.inbox-transfer')) closeMenu();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMenu({ restoreFocus: true });
      } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && document.activeElement?.closest?.('.inbox-transfer')) {
        // só navega se o foco ainda está no menu; no textarea as setas são do campo
        e.preventDefault();
        const list = items();
        if (!list.length) return;
        const i = list.indexOf(document.activeElement);
        const next = e.key === 'ArrowDown' ? (i + 1) % list.length : (i - 1 + list.length) % list.length;
        list[next].focus();
      }
    };
    // Tab/foco programático para fora do menu também fecha (sem restaurar o foco: ele já foi para outro lugar)
    const onFocusIn = (e) => {
      if (!e.target.closest?.('.inbox-transfer')) closeMenu();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    document.addEventListener('focusin', onFocusIn);
    cleanupMenu = () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('focusin', onFocusIn);
    };
  }

  // o menu some e o cabeçalho é redesenhado após a transferência: devolve o foco ao botão no fim
  function pick(userId) {
    closeMenu();
    onTransfer(userId);
    header.querySelector('.inbox-transfer__btn')?.focus();
  }

  // Destinos: só quem pode ler e responder a conversa no destino (o motor decide com o usuário do destino).
  function transferMenu(conv) {
    const s = store.state;
    const row = ({ user, current: isCurrent, staysVisible }) =>
      h(
        'button',
        {
          class: 'inbox-menu__item',
          type: 'button',
          role: 'menuitem',
          disabled: isCurrent,
          onclick: () => pick(user.id),
        },
        avatar(user.name, { small: true }),
        h(
          'span',
          { class: 'inbox-menu__text' },
          h('span', { class: 'truncate' }, user.id === s.currentUserId ? `${user.name} (você)` : user.name),
          h('small', null, user.isBot ? 'Agente de IA' : s.roles.filter((r) => (user.roleIds || []).includes(r.id)).map((r) => r.name).join(', ')),
          !isCurrent && !staysVisible ? h('small', { class: 'inbox-menu__warn' }, 'A conversa sairá da sua lista') : null
        ),
        isCurrent ? h('span', { class: 'inbox-menu__current' }, 'atual') : null
      );
    return h(
      'div',
      { class: 'inbox-menu', role: 'menu', 'aria-label': 'Transferir conversa para' },
      h('div', { class: 'label inbox-menu__title' }, 'Transferir para'),
      transferTargets(store, conv).map(row),
      h(
        'button',
        {
          class: 'inbox-menu__item',
          type: 'button',
          role: 'menuitem',
          disabled: !conv.assigneeId,
          onclick: () => pick(null),
        },
        h(
          'span',
          { class: 'inbox-menu__text' },
          h('span', null, 'Devolver para a fila'),
          h('small', null, 'Sem responsável'),
          conv.assigneeId && !staysVisibleInQueue(conv) ? h('small', { class: 'inbox-menu__warn' }, 'A conversa sairá da sua lista') : null
        )
      )
    );
  }

  // ---------- cabeçalho ----------
  function renderHeader(conv, typing, access) {
    const contact = maskedContact(store.contact(conv.contactId)); // já sem os campos ocultos pelo perfil
    const phoneHidden = isHidden('contact', 'phone');
    const instance = store.instance(conv.instanceId);
    const resolved = conv.status === 'resolved';
    const key = JSON.stringify([conv.id, conv.assigneeId, conv.status, contact?.name, contact?.phone, phoneHidden, instance?.name, typing, menuOpen, store.state.users.length, store.state.currentUserId, access.transfer.reason, access.resolve.reason]);
    if (key === headerKey) return;
    headerKey = key;

    const name = contact?.name || 'Contato removido';
    const phone = phoneHidden ? ` · ${HIDDEN}` : contact?.phone ? ` · ${contact.phone}` : '';
    const status = typing ? '● digitando…' : resolved ? `✓ resolvida${phone}` : `● online${phone}`;
    const stateBtn = resolved
      ? h('button', { class: 'btn btn--primary', type: 'button', onclick: onReopen, ...gated('Reabrir', access.resolve) }, 'Reabrir')
      : h('button', { class: 'btn btn--primary', type: 'button', onclick: onResolve, ...gated('Resolver', access.resolve) }, 'Resolver');
    replaceChildren(
      header,
      h('div', { class: 'inbox-thread__id' }, avatar(name), h('div', { class: 'inbox-thread__who' }, h('span', { class: 'inbox-thread__name truncate' }, name), h('span', { class: 'inbox-thread__status truncate' }, status))),
      h(
        'div',
        { class: 'inbox-thread__actions' },
        h('span', { class: 'inbox-thread__instance' }, `Instância: ${instance?.name || '—'}`),
        h(
          'div',
          { class: 'inbox-transfer' },
          h('button', { class: 'btn btn--ghost inbox-transfer__btn', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': String(menuOpen), onclick: () => (menuOpen ? closeMenu() : openMenu()), ...gated('Transferir', access.transfer) }, 'Transferir'),
          menuOpen ? transferMenu(conv) : null
        ),
        stateBtn
      )
    );
  }

  // ---------- mensagens ----------
  function bubble(m) {
    const time = m.at ? fmtTime(m.at) : '';
    const author = m.authorId ? firstName(store.userById(m.authorId)?.name) : '';
    const { access } = current;
    switch (m.type) {
      case 'in':
        return h('div', { class: 'inbox-msg inbox-msg--in' }, h('div', { class: 'inbox-msg__text' }, m.text), h('div', { class: 'inbox-msg__meta' }, time));
      case 'out':
        return h(
          'div',
          { class: 'inbox-msg inbox-msg--out' },
          h('div', { class: 'inbox-msg__text' }, m.text),
          h('div', { class: 'inbox-msg__meta' }, `${time} `, h('span', { class: 'inbox-msg__ticks', 'aria-label': m.status === 'sent' ? 'Enviada' : 'Entregue' }, m.status === 'sent' ? '✓' : '✓✓'))
        );
      case 'note':
        return h(
          'div',
          { class: 'inbox-msg inbox-msg--note' },
          h('div', { class: 'inbox-msg__tag' }, 'NOTA INTERNA · só a equipe vê'),
          h('div', { class: 'inbox-msg__text' }, m.text),
          h('div', { class: 'inbox-msg__meta' }, [author, time].filter(Boolean).join(' · '))
        );
      case 'ai_insight':
        return h(
          'div',
          { class: 'inbox-msg inbox-msg--insight' },
          h('div', { class: 'inbox-msg__tag' }, `SUGESTÃO DA IA${m.topic ? ` · ${m.topic.toUpperCase()}` : ''}`),
          h('div', { class: 'inbox-msg__text' }, m.text),
          h(
            'div',
            { class: 'inbox-msg__actions' },
            // "Usar resposta" depende de send_message; "Virar follow-up" de note
            h('button', { class: 'inbox-chip inbox-chip--ins', type: 'button', onclick: () => onUseReply(m.reply || m.text), ...gated('Usar resposta', access.send) }, 'Usar resposta'),
            h('button', { class: 'inbox-chip', type: 'button', onclick: () => onFollowUp(m.id), ...(m.followUp ? { disabled: true } : gated('Virar follow-up', access.note)) }, m.followUp ? 'Follow-up criado ✓' : 'Virar follow-up')
          )
        );
      case 'system':
        return h('div', { class: 'inbox-msg inbox-msg--system' }, m.text);
      default:
        return null;
    }
  }

  function renderMessages(conv, typing) {
    const list = messagesOf(store.state, conv.id);
    const key = JSON.stringify([conv.id, typing, current.access.send.ok, current.access.note.ok, list.map((m) => [m.id, m.status, m.followUp])]);
    if (key === msgsKey) return;
    msgsKey = key;

    const prevBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    const nodes = [];
    let day = null;
    for (const m of list) {
      if (m.at) {
        const label = dayLabel(m.at);
        if (label !== day) {
          day = label;
          nodes.push(h('div', { class: 'inbox-day' }, h('span', null, label)));
        }
      }
      nodes.push(bubble(m));
    }
    if (!list.length) nodes.push(h('div', { class: 'empty inbox-msgs__empty' }, h('div', null, 'Nenhuma mensagem ainda.'), h('div', null, 'Envie a primeira mensagem abaixo.')));
    if (typing) nodes.push(h('div', { class: 'inbox-msg inbox-msg--in inbox-msg--typing', 'aria-label': 'Digitando' }, h('span'), h('span'), h('span')));
    replaceChildren(scroller, nodes);

    const last = list[list.length - 1];
    const lastId = (last?.id || '') + (typing ? ':t' : '');
    const mine = !!last?.authorId && last.authorId === store.state.currentUserId;
    // troca de conversa e envio do próprio atendente vão ao fim; chegada de mensagem só se já estava lendo o fim
    if (conv.id !== lastConvId || (lastId !== lastMsgId && (prevBottom < 140 || mine || last?.type === 'system'))) scroller.scrollTop = scroller.scrollHeight;
    lastConvId = conv.id;
    lastMsgId = lastId;
  }

  /**
   * access: { send, note, transfer, resolve } (vereditos do motor para esta conversa).
   * supervising: { name, acts } quando a conversa é de outra pessoa e eu posso lê-la.
   */
  function render(conv, { typing, access, supervising, emptyText }) {
    emptyState.hidden = !!conv;
    if (!conv) emptyMsg.textContent = emptyText || 'Selecione uma conversa para começar o atendimento.';
    header.hidden = scroller.hidden = footer.hidden = !conv;
    current = { conv, typing, access, supervising };
    if (!conv) {
      banner.hidden = true;
      closeMenu();
      return;
    }
    // transferir deixou de ser permitido (perfil/atribuição mudou) com o menu aberto: fecha
    if (menuOpen && !access.transfer.ok) closeMenu();
    banner.hidden = !supervising;
    if (supervising) {
      banner.textContent = `Supervisionando · conversa de ${supervising.name}${supervising.acts ? ' · o que você enviar aqui fica registrado na auditoria' : ' · acompanhamento somente leitura'}`;
    }
    renderHeader(conv, typing, access);
    renderMessages(conv, typing);
  }

  /** Ao trocar de conversa: fecha o menu e descarta as chaves para redesenhar tudo. */
  function reset() {
    if (menuOpen) {
      menuOpen = false;
      cleanupMenu?.();
      cleanupMenu = null;
    }
    headerKey = msgsKey = '';
    lastConvId = null;
  }

  return {
    el,
    render,
    reset,
    destroy() {
      cleanupMenu?.();
      cleanupMenu = null;
    },
  };
}
