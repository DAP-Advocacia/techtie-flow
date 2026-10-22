// Chat interno (aba da Inbox): conversas diretas e grupos entre as pessoas da empresa. Só quem participa da sala a vê.
// Lista de salas à esquerda, conversa à direita (celular: uma coluna por vez). A parte de dados está em chat/actions.js e
// as regras puras (títulos, não lidas, agrupamento) em chat/model.js.
import { h, icon, ICONS, replaceChildren, avatar, fmtListTime, fmtTime, toast } from '../../ui.js';
import { openDialog } from '../contacts/form.js';
import * as A from './chat/actions.js';
import { roomTitle, previewOf, peerOf, matchRoom, groupMessages, cleanDraft, MAX_GROUP } from './chat/model.js';

const SEND = 'M4 12l16-8-6 16-3-7z';
const PLUS = 'M12 5v14M5 12h14';
const BACK = 'M15 5l-7 7 7 7';

export function createChat({ store }) {
  const meId = () => store.state.currentUserId;
  const nameOf = (id) => store.userById(id)?.name || '';
  let selectedId = null;
  let query = '';
  let active = false; // a aba do chat está à vista (só então marca como lida)
  let lastSig = '';
  let stick = true; // a conversa acompanha as mensagens novas (se a pessoa não subiu para ler o histórico)

  // ---------------------------------------------------------------- esqueleto fixo (o rascunho não se perde ao redesenhar)
  const search = h('input', { class: 'input chat-search', type: 'search', placeholder: 'Buscar conversa ou pessoa', autocomplete: 'off', 'aria-label': 'Buscar conversa' });
  const newBtn = h('button', { class: 'btn btn--primary btn--sm chat-new', type: 'button', onclick: () => openNew() }, icon(PLUS, 14), 'Nova conversa');
  const listEl = h('ul', { class: 'chat-rooms', 'aria-label': 'Conversas' });
  const headEl = h('header', { class: 'chat-thread__head' });
  const msgsEl = h('div', { class: 'chat-msgs', role: 'log', 'aria-live': 'polite', 'aria-label': 'Mensagens' });
  const input = h('textarea', { class: 'textarea chat-input', rows: '1', maxlength: '4000', placeholder: 'Escreva uma mensagem…', 'aria-label': 'Mensagem' });
  const sendBtn = h('button', { class: 'btn btn--primary chat-send', type: 'submit', 'aria-label': 'Enviar mensagem' }, icon(SEND, 18));
  const composer = h('form', { class: 'chat-composer', novalidate: true }, input, sendBtn);
  const empty = h('div', { class: 'empty chat-empty' }, h('div', null, 'Escolha uma conversa ou comece uma nova.'));
  const threadEl = h('section', { class: 'chat-thread', 'aria-label': 'Conversa' }, headEl, msgsEl, composer, empty);
  const el = h(
    'div',
    { class: 'chat', 'data-mview': 'list' },
    h('section', { class: 'chat-col', 'aria-label': 'Lista de conversas' }, h('div', { class: 'chat-col__head' }, h('h2', { class: 'chat-title' }, 'Equipe'), newBtn), h('div', { class: 'chat-searchwrap' }, search), listEl),
    threadEl
  );
  const setView = (v) => (el.dataset.mview = v);

  search.addEventListener('input', () => {
    query = search.value;
    draw();
  });
  msgsEl.addEventListener('scroll', () => {
    stick = msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight < 80;
  });
  const grow = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight || 0, 140)}px`;
  };
  input.addEventListener('input', grow);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      composer.requestSubmit ? composer.requestSubmit() : submit();
    }
  });
  composer.addEventListener('submit', (e) => {
    e.preventDefault();
    submit();
  });

  async function submit() {
    const body = cleanDraft(input.value);
    if (!selectedId || !body) return;
    sendBtn.disabled = true;
    const r = await A.send(selectedId, body);
    sendBtn.disabled = false;
    if (!r.ok) {
      toast(r.error);
      return;
    }
    input.value = '';
    grow();
    stick = true;
    draw();
    input.focus();
  }

  // ---------------------------------------------------------------- nova conversa / grupo / convidar
  function openNew() {
    let mode = 'dm';
    const people = A.people();
    const q = h('input', { class: 'input', type: 'search', placeholder: 'Buscar pessoa', autocomplete: 'off', 'aria-label': 'Buscar pessoa', 'data-autofocus': true });
    const groupName = h('input', { class: 'input', type: 'text', maxlength: '80', placeholder: 'Nome do grupo (ex.: Time comercial)', 'aria-label': 'Nome do grupo' });
    const err = h('span', { class: 'field-error', role: 'alert' });
    const chosen = new Set();
    const rows = h('ul', { class: 'chat-people' });
    const submitGroup = h('button', { class: 'btn btn--primary', type: 'button', hidden: true }, 'Criar grupo');
    const seg = ['dm', 'group'].map((id) => h('button', { class: 'pill', type: 'button', 'data-mode': id, onclick: () => ((mode = id), paint()) }, id === 'dm' ? 'Conversa direta' : 'Grupo'));
    const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    function paint() {
      err.textContent = '';
      seg.forEach((b) => b.classList.toggle('is-active', b.dataset.mode === mode));
      groupName.hidden = mode !== 'group';
      submitGroup.hidden = mode !== 'group';
      submitGroup.textContent = chosen.size ? `Criar grupo (${chosen.size + 1})` : 'Criar grupo';
      const term = fold(q.value).trim();
      const list = people.filter((u) => !term || fold(u.name).includes(term) || fold(u.jobTitle).includes(term));
      replaceChildren(
        rows,
        ...list.map((u) =>
          h(
            'li',
            null,
            h(
              'button',
              {
                class: 'chat-person' + (chosen.has(u.id) ? ' is-on' : ''),
                type: 'button',
                'data-user': u.id,
                'aria-pressed': mode === 'group' ? String(chosen.has(u.id)) : null,
                onclick: async () => {
                  if (mode === 'group') {
                    chosen.has(u.id) ? chosen.delete(u.id) : chosen.add(u.id);
                    paint();
                    return;
                  }
                  const r = await A.openDm(u.id);
                  if (!r.ok) {
                    err.textContent = r.error;
                    return;
                  }
                  dlg.close();
                  select(r.room.id, { focus: true });
                },
              },
              avatar(u.name),
              h('span', { class: 'chat-person__text' }, h('span', { class: 'chat-person__name truncate' }, u.name), u.jobTitle ? h('span', { class: 'chat-person__sub truncate' }, u.jobTitle) : null),
              mode === 'group' ? h('span', { class: 'chat-person__check', 'aria-hidden': 'true' }, chosen.has(u.id) ? '✓' : '') : null
            )
          )
        ),
        list.length ? null : h('li', { class: 'muted chat-people__none' }, people.length ? 'Ninguém com esse nome.' : 'Ainda não há outras pessoas ativas na empresa.')
      );
    }
    q.addEventListener('input', paint);
    submitGroup.addEventListener('click', async () => {
      submitGroup.disabled = true;
      const r = await A.createGroup(groupName.value, [...chosen]);
      submitGroup.disabled = false;
      if (!r.ok) {
        err.textContent = r.error;
        return;
      }
      dlg.close();
      select(r.room.id, { focus: true });
      toast('Grupo criado');
    });
    const cancel = h('button', { class: 'btn btn--quiet', type: 'button', onclick: () => dlg.close() }, 'Fechar');
    const dlg = openDialog({ eyebrow: 'EQUIPE', title: 'Nova conversa', content: h('div', { class: 'contacts-form chat-new-dialog' }, h('div', { class: 'pills' }, ...seg), groupName, q, rows, err, h('div', { class: 'contacts-form__actions' }, cancel, submitGroup)) });
    paint();
  }

  function openInvite(room) {
    const people = A.people().filter((u) => !room.members.includes(u.id));
    const chosen = new Set();
    const err = h('span', { class: 'field-error', role: 'alert' });
    const ok = h('button', { class: 'btn btn--primary', type: 'button', disabled: true }, 'Adicionar');
    const rows = h('ul', { class: 'chat-people' });
    const paint = () => {
      ok.disabled = !chosen.size;
      replaceChildren(
        rows,
        ...people.map((u) => h('li', null, h('button', { class: 'chat-person' + (chosen.has(u.id) ? ' is-on' : ''), type: 'button', 'data-user': u.id, 'aria-pressed': String(chosen.has(u.id)), onclick: () => (chosen.has(u.id) ? chosen.delete(u.id) : chosen.add(u.id), paint()) }, avatar(u.name), h('span', { class: 'chat-person__text' }, h('span', { class: 'chat-person__name truncate' }, u.name), u.jobTitle ? h('span', { class: 'chat-person__sub truncate' }, u.jobTitle) : null), h('span', { class: 'chat-person__check', 'aria-hidden': 'true' }, chosen.has(u.id) ? '✓' : '')))),
        people.length ? null : h('li', { class: 'muted chat-people__none' }, 'Todas as pessoas da empresa já estão no grupo.')
      );
    };
    ok.addEventListener('click', async () => {
      ok.disabled = true;
      const r = await A.addMembers(room.id, [...chosen]);
      if (!r.ok) {
        err.textContent = r.error;
        ok.disabled = false;
        return;
      }
      dlg.close();
      toast('Pessoas adicionadas ao grupo');
    });
    const dlg = openDialog({ eyebrow: room.name, title: 'Adicionar ao grupo', content: h('div', { class: 'contacts-form chat-new-dialog' }, rows, err, h('div', { class: 'contacts-form__actions' }, h('button', { class: 'btn btn--quiet', type: 'button', onclick: () => dlg.close() }, 'Cancelar'), ok)) });
    paint();
  }

  // ---------------------------------------------------------------- seleção e desenho
  function select(id, { focus = false } = {}) {
    if (!A.myRooms().some((r) => r.id === id)) return;
    selectedId = id;
    stick = true;
    lastSig = '';
    setView('thread');
    A.load(id);
    A.setViewing(active ? id : null);
    draw();
    if (focus) input.focus();
  }

  const roomAvatar = (room) => {
    const peer = peerOf(room, meId());
    return room.kind === 'dm' ? avatar(nameOf(peer) || '?') : h('div', { class: 'avatar chat-group-avatar', title: room.name }, icon(ICONS.users, 18));
  };

  function drawList(rooms) {
    const term = query.trim();
    const shown = rooms.filter((r) => matchRoom(roomTitle(r, meId(), nameOf), term));
    replaceChildren(
      listEl,
      ...shown.map((r) => {
        const n = A.unreadFor(r);
        return h(
          'li',
          null,
          h(
            'button',
            { class: 'chat-room' + (r.id === selectedId ? ' is-active' : '') + (n ? ' is-unread' : ''), type: 'button', 'data-room': r.id, onclick: () => select(r.id, { focus: !matchMedia('(max-width: 820px)').matches }) },
            roomAvatar(r),
            h('span', { class: 'chat-room__text' }, h('span', { class: 'chat-room__title truncate' }, roomTitle(r, meId(), nameOf)), h('span', { class: 'chat-room__preview truncate' }, previewOf(r, meId(), nameOf))),
            h('span', { class: 'chat-room__side' }, r.lastAt ? h('span', { class: 'chat-room__time' }, fmtListTime(r.lastAt)) : null, n ? h('span', { class: 'badge', 'aria-label': `${n} não lidas` }, n) : null)
          )
        );
      }),
      shown.length ? null : h('li', { class: 'chat-rooms__none muted' }, rooms.length ? 'Nenhuma conversa com esse nome.' : 'Nenhuma conversa ainda. Comece uma com “Nova conversa”.')
    );
  }

  function drawThread(room) {
    const me = meId();
    const sub = room.kind === 'group' ? `${room.members.length} pessoas · ${room.members.slice(0, 4).map((u) => nameOf(u).split(' ')[0]).join(', ')}${room.members.length > 4 ? '…' : ''}` : store.userById(peerOf(room, me))?.jobTitle || '';
    replaceChildren(
      headEl,
      h('button', { class: 'chat-back', type: 'button', 'aria-label': 'Voltar para as conversas', onclick: () => setView('list') }, icon(BACK, 22)),
      roomAvatar(room),
      h('div', { class: 'chat-thread__who' }, h('h3', { class: 'chat-thread__name truncate' }, roomTitle(room, me, nameOf)), sub ? h('span', { class: 'chat-thread__sub truncate' }, sub) : null),
      room.kind === 'group' && room.members.length < MAX_GROUP ? h('button', { class: 'btn btn--quiet btn--sm chat-add', type: 'button', onclick: () => openInvite(room) }, '+ Pessoa') : null
    );
    const items = groupMessages(A.messagesOf(room.id));
    replaceChildren(
      msgsEl,
      ...(items.length ? items : [h('div', { class: 'chat-first muted' }, room.kind === 'group' ? 'Grupo criado. Diga olá!' : `Comece a conversa com ${roomTitle(room, me, nameOf).split(' ')[0]}.`)]).map((it) => {
        if (it.type === 'day') return h('div', { class: 'chat-day', role: 'separator' }, h('span', null, it.label));
        if (it.msg === undefined) return it;
        const mine = it.msg.authorId === me;
        return h(
          'div',
          { class: 'chat-msg' + (mine ? ' chat-msg--mine' : '') + (it.first ? ' is-first' : '') + (it.last ? ' is-last' : ''), 'data-msg': it.msg.id },
          !mine && room.kind === 'group' && it.first ? h('span', { class: 'chat-msg__who' }, nameOf(it.msg.authorId) || 'Pessoa removida') : null,
          h('div', { class: 'chat-msg__bubble' }, h('span', { class: 'chat-msg__text' }, it.msg.body)),
          it.last ? h('span', { class: 'chat-msg__time' }, fmtTime(it.msg.at)) : null
        );
      })
    );
    if (stick) msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  function draw() {
    const rooms = A.myRooms();
    if (selectedId && !rooms.some((r) => r.id === selectedId)) selectedId = null;
    drawList(rooms);
    const room = rooms.find((r) => r.id === selectedId) || null;
    threadEl.classList.toggle('has-room', !!room);
    empty.hidden = !!room;
    headEl.hidden = msgsEl.hidden = composer.hidden = !room;
    if (!room) return;
    const msgs = A.messagesOf(room.id);
    const sig = [room.id, room.name, room.members.join(','), msgs.length, msgs.at(-1)?.id, Object.values(store.state.users).length].join('|');
    if (sig !== lastSig) {
      lastSig = sig;
      drawThread(room);
    }
    if (active && A.unreadFor(room) > 0) A.markRead(room.id);
  }

  const unsub = store.subscribe(draw);
  draw();

  return {
    el,
    /** A aba do chat foi mostrada/escondida: só marca como lida e recebe tempo real quando está à vista. */
    setActive(on) {
      active = on;
      A.setViewing(on ? selectedId : null);
      if (on) draw();
    },
    /** Abre (ou cria) a conversa direta com uma pessoa — usado por atalhos de outras telas. */
    async openWith(userId) {
      const r = await A.openDm(userId);
      if (r.ok) select(r.room.id);
      return r;
    },
    destroy() {
      unsub();
      A.setViewing(null);
    },
  };
}
