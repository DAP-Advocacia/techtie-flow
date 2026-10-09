// Tela "Instâncias WhatsApp": um cartão por número + cartão tracejado para
// conectar outro. Estados reais herdados do gateway (docs/whatsapp-gateway-
// licoes-herdadas.md): conectada, desconectada, fila de pareamento, conectando
// e "precisa de atenção" (ban/sessão substituída: só ação manual).
import { h, icon, replaceChildren, toast, fmtInt } from '../ui.js';
import { ATTENTION, ICON, channelBadge, statusMeta } from './instances/channels.js';
import { seedInstances, removeInstance, updateInstance, conversationsUsing, usageNotes } from './instances/actions.js';
import { openMenu, closeMenu } from './instances/menu.js';
import { closeAllModals } from './instances/modal.js';
import { openAssign, openConfirm, openManage, openRename } from './instances/dialogs.js';
import { openConnectFlow } from './instances/connect-flow.js';
import { check, blocked, createHints, banner, anyOk } from './_ops/perm.js';

export default {
  mount(el, { store }) {
    seedInstances();

    let highlightId = null;
    let highlightTimer = null;

    // Permissões (motor). Ler as instâncias basta para ver cartões e métricas; cada ação de escrita
    // tem a sua: criar, conectar/reconectar/desconectar, renomear/vincular e remover.
    // Calculadas a cada desenho (o cache do adaptador cai a cada mudança do store).
    const hints = createHints();
    const C = {
      create: () => check('instance', 'create'),
      connect: () => check('instance', 'connect'),
      update: () => check('instance', 'update'),
      remove: () => check('instance', 'delete'),
    };
    const bannerEl = banner(false);

    // O gatilho de um modal some no re-render do grid: devolvemos o foco por seletor.
    const sel = (id, key) => `[data-inst="${CSS.escape(id)}"] [data-focus="${key}"]`;
    const refocus = (id, key) => () => el.querySelector(sel(id, key)) || el.querySelector('.instances-new');

    // ---------------------------------------------------------------- ações
    const connectNew = () =>
      !blocked(C.create()) &&
      openConnectFlow({
        returnFocus: (newId) => (newId ? refocus(newId, 'primary')() : el.querySelector('.instances-new')),
        onFinish: flash,
      });

    const reconnect = (inst) =>
      !blocked(C.connect()) &&
      openConnectFlow({ instance: inst, returnFocus: () => refocus(inst.id, 'primary')(), onFinish: flash });

    /** Destaca por 2s o cartão que acabou de ser conectado. */
    function flash(id) {
      highlightId = id;
      draw();
      clearTimeout(highlightTimer);
      highlightTimer = setTimeout(() => {
        highlightId = null;
        draw();
      }, 2200);
    }

    const disconnect = (inst, returnFocus) =>
      !blocked(C.connect()) &&
      openConfirm({
        title: `Desconectar ${inst.name}?`,
        eyebrow: 'Desconectar número',
        message:
          inst.channel === 'baileys'
            ? 'A sessão será encerrada e o número para de receber mensagens. As conversas ficam salvas; para voltar, será preciso ler um novo QR Code.'
            : 'O número para de receber mensagens por aqui até você reconectar pela Meta Business. As conversas ficam salvas.',
        confirmLabel: 'Desconectar',
        busyLabel: 'Desconectando…',
        danger: true,
        returnFocus,
        onConfirm: () => {
          const done = updateInstance(
            inst.id,
            (i) => {
              i.status = 'disconnected';
              delete i.attentionReason;
            },
            { action: 'connect', event: 'instance.disconnect', detail: `Instância "${inst.name}" desconectada` }
          );
          if (done) toast(`${inst.name} desconectada`);
          else blocked(C.connect());
        },
      });

    const remove = (inst, returnFocus) => {
      if (blocked(C.remove())) return null;
      const used = conversationsUsing(inst.id);
      const others = usageNotes(inst.id);
      const reasons = [];
      if (used) reasons.push(`Há ${used} ${used === 1 ? 'conversa' : 'conversas'} na Inbox usando este número. Para não perder o histórico, transfira-as para outra instância antes de remover.`);
      if (others.length) reasons.push(`Antes de remover: ${others.join('; ')}.`);
      return openConfirm({
        title: `Remover ${inst.name}?`,
        eyebrow: 'Remover número',
        message: `${inst.name} (${inst.phone || 'sem número'}) sai da lista e as credenciais da sessão são apagadas. Esta ação não pode ser desfeita.`,
        confirmLabel: 'Remover',
        busyLabel: 'Removendo…',
        danger: true,
        returnFocus,
        blockedReason: reasons.join(' '),
        onConfirm: () => {
          if (removeInstance(inst.id)) toast(`${inst.name} removida`);
          else blocked(C.remove());
        },
      });
    };

    const manage = (inst) => {
      const back = refocus(inst.id, 'primary');
      // Ao voltar de um diálogo filho, reabre o painel já com os dados novos.
      const reopen = () => manage(inst);
      const m = openManage(inst, {
        returnFocus: back,
        onRename: () => (m.close(), openRename(inst, { returnFocus: back, onDone: reopen })),
        onAssign: () => (m.close(), openAssign(inst, { returnFocus: back, onDone: reopen })),
        onDisconnect: () => (m.close(), disconnect(inst, back)),
      });
    };

    const openCardMenu = (inst, anchor) => {
      const back = refocus(inst.id, 'menu');
      const items = menuItems(inst, back);
      openMenu(anchor, items);
    };

    // Itens do menu ⋯ com o bloqueio de cada um vindo do motor (`locked` = motivo).
    const menuItems = (inst, back) => {
      const u = C.update();
      const c = C.connect();
      const d = C.remove();
      const items = [
        { label: 'Renomear', locked: u.ok ? '' : u.msg, onSelect: () => openRename(inst, { returnFocus: back }) },
        { label: 'Vincular responsável', locked: u.ok ? '' : u.msg, onSelect: () => openAssign(inst, { returnFocus: back }) },
      ];
      if (inst.status === 'connected' || inst.status === 'queued' || inst.status === 'connecting') {
        items.push({ label: inst.status === 'connected' ? 'Desconectar' : 'Cancelar conexão', locked: c.ok ? '' : c.msg, onSelect: () => disconnect(inst, back) });
      }
      items.push({ label: 'Remover…', danger: true, locked: d.ok ? '' : d.msg, onSelect: () => remove(inst, back) });
      return items;
    };

    // ---------------------------------------------------------------- render
    const metric = (value, label) => h('div', null, h('div', { class: 'instances-metric__v num' }, value), h('div', { class: 'instances-metric__l' }, label));

    function card(inst) {
      const st = statusMeta(inst.status);
      const att = inst.status === 'attention' ? ATTENTION[inst.attentionReason] || ATTENTION.badSession : null;
      const busy = st.busy;
      const needsReconnect = inst.status === 'disconnected' || inst.status === 'attention';
      // Quem só lê (nenhuma ação de escrita liberada) vê "Detalhes" em vez de "Gerenciar".
      const readOnly = !anyOk(C.update(), C.connect(), C.remove(), check('ai_agent', 'update'));

      const note = att
        ? h('div', { class: 'instances-note instances-note--warn', role: 'note' }, icon(ICON.warn, 16), h('div', null, h('strong', null, att.title), h('span', null, att.text)))
        : inst.status === 'disconnected'
          ? h('div', { class: 'instances-card__hint muted' }, inst.channel === 'baileys' ? 'Sessão encerrada. Leia um novo QR Code para voltar a atender.' : 'Autorização da Meta pendente. Entre de novo para reativar.')
          : inst.status === 'connected'
            ? h('div', { class: 'instances-card__hint muted' }, inst.channel === 'baileys' ? 'Sessão por QR ativa. Só conversas recentes foram importadas.' : 'API oficial ativa. Cobrança por mensagem entregue, direto pela Meta.')
            : null;

      const primary = h(
        'button',
        {
          class: 'btn btn--ghost instances-card__primary',
          type: 'button',
          'data-focus': 'primary',
          disabled: busy,
          onclick: () => (needsReconnect ? reconnect(inst) : manage(inst)),
        },
        busy ? 'Conectando…' : needsReconnect ? 'Reconectar' : readOnly ? 'Detalhes' : 'Gerenciar'
      );
      // Reconectar é ação de escrita (instance.connect); abrir os detalhes é leitura.
      if (needsReconnect) hints.lock(primary, C.connect(), { other: busy });
      const menuBtn = h('button', { class: 'btn btn--quiet instances-card__menu', type: 'button', 'data-focus': 'menu', 'aria-label': `Mais ações de ${inst.name}`, 'aria-haspopup': 'menu', 'aria-expanded': 'false', onclick: (e) => openCardMenu(inst, e.currentTarget) }, '⋯');
      // Se nenhum item do menu é permitido, o próprio ⋯ fica desabilitado (com o motivo).
      const allLocked = menuItems(inst, () => null).every((i) => i.locked);
      if (allLocked) hints.lock(menuBtn, { ok: false, msg: menuItems(inst, () => null)[0].locked });

      return h(
        'article',
        { class: 'card instances-card' + (inst.id === highlightId ? ' is-new' : ''), 'data-inst': inst.id, 'data-status': inst.status, 'aria-label': `Instância ${inst.name}` },
        h('div', { class: 'instances-card__head' }, h('h2', { class: 'instances-card__name truncate' }, inst.name), h('span', { class: `status ${st.cls}` + (busy ? ' is-pulse' : '') }, '● ', st.label)),
        h('div', { class: 'instances-card__sub truncate' }, [inst.phone, inst.ownerName || 'Sem responsável'].filter(Boolean).join(' · ')),
        channelBadge(inst.channel),
        note,
        h('div', { class: 'instances-metrics' }, metric(fmtInt(inst.conversations), 'conversas'), metric(fmtInt(inst.messagesToday), 'msgs hoje'), metric(inst.aiActive ? 'Sim' : 'Não', 'IA ativa')),
        h(
          'div',
          { class: 'instances-card__actions' },
          primary,
          inst.status === 'attention' ? hints.lock(h('button', { class: 'btn btn--quiet instances-card__remove', type: 'button', onclick: () => remove(inst, refocus(inst.id, 'primary')) }, 'Remover'), C.remove()) : null,
          menuBtn
        )
      );
    }

    const summary = h('p', { class: 'muted instances-summary' });
    const grid = h('div', { class: 'instances-grid' });
    const addCard = h(
      'button',
      { class: 'card card--dashed instances-new', type: 'button', onclick: connectNew },
      h('span', { class: 'instances-new__plus' }, icon(ICON.plus, 22)),
      h('span', { class: 'instances-new__title' }, 'Conectar novo número'),
      h('span', { class: 'instances-new__sub' }, 'Escaneie o QR Code ou entre com a Meta')
    );

    function draw() {
      closeMenu();
      hints.lock(addCard, C.create());
      bannerEl.hidden = anyOk(C.create(), C.connect(), C.update(), C.remove());
      const list = store.state.instances;
      const count = (s) => list.filter((i) => i.status === s).length;
      const parts = [];
      const on = count('connected');
      const off = count('disconnected');
      const att = count('attention');
      const pend = count('queued') + count('connecting');
      if (on) parts.push(`${on} ${on === 1 ? 'conectada' : 'conectadas'}`);
      if (pend) parts.push(`${pend} em conexão`);
      if (off) parts.push(`${off} ${off === 1 ? 'desconectada' : 'desconectadas'}`);
      if (att) parts.push(`${att} ${att === 1 ? 'precisa de atenção' : 'precisam de atenção'}`);
      summary.textContent = parts.join(' · ') || 'Nenhum número conectado ainda.';
      replaceChildren(grid, list.map(card), addCard);
    }

    replaceChildren(
      el,
      h(
        'div',
        { class: 'page instances-page' },
        bannerEl,
        h('header', { class: 'page-header' }, h('div', { class: 'grow' }, h('div', { class: 'eyebrow' }, 'CANAIS'), h('h1', { class: 'page-title' }, 'Instâncias WhatsApp')), summary),
        grid,
        hints.host
      )
    );
    draw();

    const unsub = store.subscribe(draw);
    return () => {
      unsub();
      clearTimeout(highlightTimer);
      closeMenu();
      closeAllModals();
    };
  },
};
