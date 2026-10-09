// Tela Inbox: lista · thread · painel do contato. Este arquivo só orquestra
// (estado de UI, timers e ligação entre as colunas); a renderização de cada
// coluna fica em screens/inbox/*.js, as regras de negócio em actions.js e a ponte
// com o motor de permissões em perm.js. A tela NÃO decide permissão: pergunta ao motor.
import { h, toast } from '../ui.js';
import { audit } from '../access.js';
import { createList } from './inbox/list.js';
import { createThread } from './inbox/thread.js';
import { createComposer } from './inbox/composer.js';
import { createPanel } from './inbox/panel.js';
import { composerAccess, convAccess, otherAssignee, visibleConvs } from './inbox/perm.js';
import { canMarkRead, firstName, markDelivered, markRead, messagesOf, receiveMessage, reopen, resolve, insightToFollowUp, sendMessage, tabCounts, transfer, visibleConversations } from './inbox/actions.js';

// Conversas em que o "lead" responde sozinho ~2s depois de uma mensagem nossa (demo).
const LEAD_REPLIES = {
  cv1: ['Perfeito! Pode mandar por aqui mesmo.', 'Show, vou repassar para o financeiro e já te retorno.', 'Combinado, aguardo então.'],
};

// Sobrevive ao desmontar a tela (voltar do pipeline reabre a mesma conversa), mas é DE UM USUÁRIO:
// outro usuário nunca herda a seleção. Além disso só vale se a conversa ainda é visível para ele.
let remembered = { userId: null, id: null };

export default {
  mount(el, { store, navigate }) {
    const meId = store.state.currentUserId; // a tela é remontada a cada troca de usuário
    let selectedId = null; // estado por montagem: nada vaza entre usuários
    let tab = 'mine';
    let query = '';
    let lastIds = []; // ids exibidos no último render da lista (para escolher a vizinha quando a conversa sai do escopo)
    let disposed = false;
    let stale = false; // já substituí o conteúdo por causa de troca de usuário
    const typing = new Set(); // convIds com o lead "digitando"
    const replyScheduled = new Set(); // convIds com resposta simulada já agendada (vale desde o envio, não só do "digitando")
    const timers = new Set();
    const pendingDelivery = new Map(); // msgId -> convId
    const superviseAudited = new Set(); // convIds já auditados como "supervisão" nesta sessão de tela
    const replyCursor = {};

    const later = (fn, ms) => {
      const t = setTimeout(() => {
        timers.delete(t);
        fn();
      }, ms);
      timers.add(t);
    };

    // Só conversas que o motor deixa ler: um id fora disso é tratado como inexistente.
    const currentConv = () => (selectedId ? visibleConvs(store).find((c) => c.id === selectedId) || null : null);

    const composer = createComposer({
      store,
      onSend(type, text) {
        const convId = selectedId;
        const res = sendMessage(store, convId, type, text);
        if (!res.ok) {
          if (res.msg) toast(res.msg);
          return false; // mantém o rascunho
        }
        // Supervisão: responder/anotar na conversa de OUTRA pessoa gera um evento de auditoria (uma vez por conversa nesta tela).
        if (res.supervisedOf && !superviseAudited.has(convId)) {
          superviseAudited.add(convId);
          const me = store.userById(meId);
          const owner = store.userById(res.supervisedOf);
          audit('conversation.supervise', convId, `${me?.name || meId} ${type === 'note' ? 'registrou nota interna' : 'respondeu'} na conversa de ${owner?.name || res.supervisedOf}`);
        }
        const msg = res.msg;
        if (type === 'out') {
          pendingDelivery.set(msg.id, convId);
          later(() => {
            pendingDelivery.delete(msg.id);
            markDelivered(store, convId, msg.id);
          }, 900);
          simulateLead(convId);
        }
        return true;
      },
    });

    const thread = createThread({
      store,
      footer: composer.el,
      onTransfer(userId) {
        const conv = currentConv();
        if (!conv) return;
        const res = transfer(store, conv.id, userId);
        if (!res.ok) {
          toast(res.msg);
          return;
        }
        const base = userId ? `Conversa transferida para ${firstName(store.userById(userId)?.name)}` : 'Conversa devolvida para a fila';
        toast(res.leaves ? `${base} · saiu da sua lista` : base);
      },
      onResolve() {
        const conv = currentConv();
        if (!conv) return;
        const before = visibleConversations(store, { tab, query });
        const idx = before.findIndex((c) => c.id === conv.id);
        const res = resolve(store, conv.id);
        if (!res.ok) {
          toast(res.msg);
          return;
        }
        // resolvida some de Meus/Fila: segue para a próxima conversa da lista, como num inbox de verdade
        const after = visibleConversations(store, { tab, query });
        if (after.length && !after.some((c) => c.id === conv.id)) {
          select(after[Math.min(Math.max(idx, 0), after.length - 1)].id);
          toast('Conversa resolvida · abrindo a próxima');
        } else toast('Conversa resolvida');
      },
      onReopen() {
        const conv = currentConv();
        if (!conv) return;
        const res = reopen(store, conv.id);
        toast(res.ok ? 'Conversa reaberta' : res.msg);
      },
      onUseReply: (text) => composer.fill(text),
      onFollowUp(insightId) {
        const conv = currentConv();
        if (!conv) return;
        const res = insightToFollowUp(store, conv.id, insightId);
        toast(res.ok ? 'Follow-up criado como nota interna' : res.msg);
      },
    });

    const list = createList({
      store,
      onSelect: (id) => select(id, { focusComposer: true }),
      onTab(id) {
        tab = id;
        renderAll();
      },
      onQuery(q) {
        query = q;
        renderAll();
      },
    });

    const panel = createPanel({ store, navigate });

    const root = h('div', { class: 'inbox' }, list.el, thread.el, panel.el);
    el.append(root);

    function simulateLead(convId) {
      const replies = LEAD_REPLIES[convId];
      // marca já no envio: várias mensagens em sequência rápida geram uma única resposta
      if (!replies || replyScheduled.has(convId)) return;
      replyScheduled.add(convId);
      later(() => {
        typing.add(convId);
        renderAll();
      }, 500);
      later(() => deliverReply(convId, convId === selectedId), 2200);
    }

    function deliverReply(convId, viewing) {
      const replies = LEAD_REPLIES[convId];
      replyScheduled.delete(convId);
      typing.delete(convId);
      const i = (replyCursor[convId] = (replyCursor[convId] ?? -1) + 1) % replies.length;
      // se o atendente não está olhando a conversa, a resposta chega como não lida (badge sobe na sidebar)
      receiveMessage(store, convId, replies[i], { viewing });
    }

    function select(id, { focusComposer = false } = {}) {
      // id fora do que o motor deixa ler é descartado (nunca seleciona conversa invisível)
      if (!visibleConvs(store).some((c) => c.id === id)) return;
      selectedId = id;
      renderAll();
      if (focusComposer) composer.focus();
    }

    // Garante uma seleção VISÍVEL. Se a conversa aberta saiu do escopo (transferida, perfil mudou),
    // migra para a vizinha na lista que o usuário estava vendo; sem nenhuma visível, fica sem seleção.
    function ensureSelection() {
      const vis = visibleConvs(store);
      if (selectedId && vis.some((c) => c.id === selectedId)) return;
      const inTab = visibleConversations(store, { tab, query });
      const prevIdx = selectedId ? lastIds.indexOf(selectedId) : -1;
      const pool = inTab.length ? inTab : visibleConversations(store, { tab, query: '' });
      const pick = pool.length ? pool[prevIdx >= 0 ? Math.min(prevIdx, pool.length - 1) : 0] : [...vis].sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0))[0];
      selectedId = pick?.id ?? null;
    }

    let shownId; // conversa que thread/composer estão mostrando
    function renderAll() {
      if (disposed) return;
      // trocou de usuário no seletor: o store avisa antes de o app remontar a tela — não toca em dado nenhum.
      // Se o remonte não vier (rota atual igual à padrão e proibida), esta tela não pode continuar
      // exibindo os dados do usuário anterior: troca o conteúdo por um aviso neutro.
      if (store.state.currentUserId !== meId) {
        if (!stale) {
          stale = true;
          root.replaceChildren(h('div', { class: 'empty inbox-stale' }, h('div', null, 'Permissões atualizadas para o novo usuário.')));
        }
        return;
      }
      ensureSelection();
      const conv = currentConv();
      remembered = { userId: meId, id: selectedId };
      // abrir a conversa = lida (só para quem atende; supervisor/leitor não zera a não lida de outra pessoa).
      // O update dispara este mesmo render de novo, então encerra aqui.
      if (conv?.unread && canMarkRead(store, conv)) {
        markRead(store, conv.id);
        return;
      }
      const access = conv ? convAccess(conv) : null;
      const cAccess = conv ? composerAccess(store, conv, access, firstName) : null;
      if (shownId !== selectedId) {
        shownId = selectedId;
        thread.reset();
        composer.show(selectedId, cAccess);
      } else if (cAccess) composer.setAccess(cAccess);

      const convs = visibleConversations(store, { tab, query });
      lastIds = convs.map((c) => c.id);
      list.render({ tab, query, selectedId, convs, counts: tabCounts(store) });

      const other = conv && otherAssignee(store, conv);
      const supervising = other ? { name: other.name, acts: access.send.ok || access.note.ok } : null;
      thread.render(conv, { typing: !!conv && typing.has(conv.id), access, supervising, emptyText: tabCounts(store).total === 0 ? 'Nenhuma conversa disponível para o seu perfil.' : undefined });
      panel.render(conv);
    }

    // Outras telas (ex.: "Abrir conversa" no pipeline) pedem uma conversa gravando
    // state.ui.inboxConversationId antes de navegar. Consome o pedido uma vez só:
    // sem limpar, voltar ao Inbox depois sempre reabriria aquela conversa.
    const requestedId = store.state.ui?.inboxConversationId;
    if (requestedId) {
      // pedido de conversa que o usuário não pode ler = ignorado (descartado), nunca selecionado
      if (visibleConvs(store).some((c) => c.id === requestedId)) {
        selectedId = requestedId;
        // a aba atual pode esconder a conversa pedida (ex.: está na fila ou resolvida)
        if (!visibleConversations(store, { tab, query: '' }).some((c) => c.id === requestedId)) tab = 'all';
      }
      delete store.state.ui.inboxConversationId;
    } else if (remembered.userId === meId && remembered.id && visibleConvs(store).some((c) => c.id === remembered.id)) {
      selectedId = remembered.id;
    }

    // quem não tem conversa própria (gestor, leitura) abre em "Todos", em vez de uma aba "Meus" vazia
    if (tab === 'mine' && tabCounts(store).mine === 0 && tabCounts(store).total > 0) tab = 'all';

    const unsubscribe = store.subscribe(renderAll);
    renderAll();

    return () => {
      disposed = true;
      unsubscribe();
      thread.destroy();
      for (const t of timers) clearTimeout(t);
      timers.clear();
      // sair da tela não pode engolir a resposta pendente: entrega agora como não lida (demo do badge)
      for (const convId of [...replyScheduled]) deliverReply(convId, false);
      // entrega pendente vira "entregue" ao sair, para não ficar presa em ✓ para sempre
      for (const [msgId, convId] of pendingDelivery) {
        const m = messagesOf(store.state, convId).find((x) => x.id === msgId);
        if (m) m.status = 'delivered';
      }
    };
  },
};
