// Tela "Negócios" (#/pipeline): quadro Kanban por pipeline + painel de proposta.
// Referência: docs/design-handoff (seção 4). Dados 100% em store.state.
// Permissões: a tela só REFLETE o motor (shared/permissions via access.js, decisões em
// pipeline/perm.js): negócios visíveis, pipelines, mover, proposta, conversa, campos e compartilhamento.
import { h, replaceChildren, toast } from '../ui.js';
import { renderBoard, clearDrag, autoScroll } from './pipeline/board.js';
import { renderPanel, renderPanelEmpty } from './pipeline/panel.js';
import { openNewDeal } from './pipeline/new-deal.js';
import { openAddProduct } from './pipeline/add-product.js';
import { openConfirmMove } from './pipeline/confirm-move.js';
import { openConfirmDelete } from './pipeline/confirm-delete.js';
import { openMoveMenu, closeMoveMenu } from './pipeline/move-menu.js';
import { closeAllModals } from './pipeline/modal.js';
import * as A from './pipeline/actions.js';
import * as P from './pipeline/perm.js';

// Estado só de UI. Fica no módulo (não no store), mas é REINICIADO a cada mount: ao trocar de usuário
// ("Ver como") a tela remonta e nenhuma seleção/pipeline do usuário anterior vaza.
const view = {
  pipelineId: null,
  selectedByPipeline: {}, // pipelineId -> dealId (a seleção volta ao trocar de aba)
  sending: new Set(), // dealIds com envio de proposta em andamento
  pendingFocus: null, // chave data-focus a devolver ao foco quando o elemento estiver utilizável de novo
};
let liveRender = null; // render da instância montada (o envio simulado pode terminar depois de sair)

export default {
  mount(el, { store, navigate }) {
    let alive = true;
    view.pipelineId = null;
    view.selectedByPipeline = {};
    view.pendingFocus = null;

    // Negócios antigos/importados podem vir sem lista de itens.
    store.state.deals.forEach((d) => {
      if (!Array.isArray(d.items)) d.items = [];
    });

    const pills = h('div', {
      class: 'pills',
      role: 'tablist',
      'aria-label': 'Pipeline',
      onkeydown: (e) => {
        const nav = { ArrowRight: 1, ArrowLeft: -1, Home: 'first', End: 'last' }[e.key];
        if (nav === undefined) return;
        const tabs = [...pills.querySelectorAll('[role="tab"]')];
        const i = tabs.indexOf(document.activeElement);
        if (i === -1) return;
        e.preventDefault();
        const next = nav === 'first' ? 0 : nav === 'last' ? tabs.length - 1 : (i + nav + tabs.length) % tabs.length;
        tabs[next].click(); // a aba é selecionada ao receber foco (ativação automática); o render devolve o foco pelo data-focus
        el.querySelector(`[data-focus="${CSS.escape(tabs[next].dataset.focus)}"]`)?.focus();
      },
    });
    const newBtn = h('button', { class: 'btn btn--primary', type: 'button', onclick: () => newDeal() }, '+ Novo negócio');
    const newHint = h('span', { class: 'pipeline-header__hint', role: 'note' });
    const board = h('div', { class: 'pipeline-board', id: 'pipeline-board', role: 'tabpanel', 'aria-label': 'Quadro do pipeline', onscroll: () => closeMoveMenu({ restoreFocus: false }), ondragover: (e) => autoScroll(e, board) });
    const panel = h('aside', { class: 'pipeline-panel', 'aria-label': 'Proposta do negócio selecionado' });

    el.append(
      h(
        'div',
        { class: 'pipeline' },
        h('header', { class: 'pipeline-header' }, h('div', { class: 'grow' }, h('div', { class: 'eyebrow' }, 'NEGÓCIOS'), h('h1', { class: 'page-title' }, 'PIPELINES')), pills, h('div', { class: 'pipeline-header__new' }, newBtn, newHint)),
        h('div', { class: 'pipeline-body' }, board, panel)
      )
    );

    // ---- leitura do estado (sempre sobre o que o motor deixa o usuário ver) ----
    /** Pipeline selecionado: sempre um dos visíveis (o lembrado, senão o da equipe do usuário, senão o primeiro). */
    function currentPipeline(pipelines) {
      let p = pipelines.find((x) => x.id === view.pipelineId);
      if (!p) {
        const teamId = store.user()?.teamIds?.[0];
        const teamPipeline = store.state.teams.find((t) => t.id === teamId)?.pipelineId;
        p = pipelines.find((x) => x.id === teamPipeline) || pipelines[0];
        view.pipelineId = p?.id ?? null;
      }
      return p;
    }

    /** Seleção válida do pipeline: a lembrada se ainda for visível ali, senão o primeiro cartão visível. */
    function selectedDeal(pipeline, deals) {
      if (!pipeline) return null;
      const rid = view.selectedByPipeline[pipeline.id];
      const remembered = deals.find((d) => d.id === rid);
      if (remembered && remembered.pipelineId === pipeline.id && pipeline.stages.some((s) => s.id === remembered.stageId)) return remembered;
      const first = A.firstDealOf(pipeline, deals);
      if (first) view.selectedByPipeline[pipeline.id] = first.id;
      else delete view.selectedByPipeline[pipeline.id];
      return first;
    }

    // ---- render ----
    function render() {
      if (!alive) return;
      // Mantém o foco no mesmo elemento (cartão, botão, aba) depois de reconstruir o DOM.
      let focusKey = el.contains(document.activeElement) ? document.activeElement.dataset?.focus : null;
      if (!focusKey && document.activeElement === document.body) focusKey = view.pendingFocus;

      const deals = P.visibleDeals();
      const pipelines = P.visiblePipelines(deals);
      const pipeline = currentPipeline(pipelines);
      const deal = selectedDeal(pipeline, deals);
      const levels = P.fieldLevels();

      replaceChildren(
        pills,
        ...pipelines.map((p) =>
          h(
            'button',
            {
              class: 'pill',
              type: 'button',
              role: 'tab',
              'aria-selected': String(p.id === pipeline?.id),
              tabindex: p.id === pipeline?.id ? '0' : '-1', // roving tabindex: só a aba ativa entra na ordem de Tab
              'aria-controls': 'pipeline-board',
              'data-focus': `pill:${p.id}`,
              onclick: () => {
                if (view.pipelineId === p.id) return;
                view.pipelineId = p.id;
                board.scrollLeft = 0;
                render();
              },
            },
            p.name
          )
        )
      );

      // "+ Novo negócio": habilitado se o motor aceita algum responsável neste pipeline.
      const create = pipeline ? P.createOwners(pipeline) : null;
      const canCreate = !!create && create.allowed.length > 0;
      newBtn.disabled = !canCreate;
      const newWhy = !pipeline ? 'Sem pipeline disponível para o seu perfil.' : canCreate ? '' : P.reasonOf(create.probe, 'criar negócios neste pipeline');
      newBtn.title = newWhy;
      newHint.textContent = newWhy;
      newHint.hidden = !newWhy;

      if (!pipeline) {
        // Nenhum pipeline legível: estado vazio explicativo (nada de quadro).
        replaceChildren(
          board,
          h('div', { class: 'empty pipeline-noaccess', style: { flex: '1' } }, h('div', { class: 'section-title gold' }, 'Nenhum pipeline disponível'), h('div', null, 'Seu perfil não permite ler negócios em nenhum pipeline.'), h('div', { class: 'muted' }, 'Peça acesso a um administrador da sua empresa.'))
        );
        renderPanelEmpty(panel, 'Sem acesso a negócios.');
      } else {
        renderBoard(board, {
          pipeline,
          deals,
          selectedId: deal?.id,
          levels,
          onSelect: (id) => {
            view.selectedByPipeline[pipeline.id] = id;
            render();
          },
          onMove: (id, stageId) => requestMove(id, stageId),
          onOpenMenu: openMenu,
        });

        renderPanel(panel, {
          deal,
          sending: !!deal && view.sending.has(deal.id),
          emptyMessage: deals.some((d) => d.pipelineId === pipeline.id) ? null : 'Você não tem negócios visíveis neste pipeline.',
          onAddProduct: () => addProduct(deal),
          onRemoveItem: (i) => removeItem(deal, i),
          onSend: () => send(deal),
          onOpenChat: () => openChat(deal),
          onFinish: (stage) => requestMove(deal.id, stage.id, { refocus: true }),
          onDelete: () => confirmDelete(deal),
          onShare: (target) => share(deal, target),
          onUnshare: (target) => unshare(deal, target),
        });
      }

      if (focusKey) {
        // Item removido: o foco vai para o botão de adicionar produto em vez de cair no <body>.
        const target = el.querySelector(`[data-focus="${CSS.escape(focusKey)}"]:not(:disabled)`) || (focusKey.startsWith('remove:') ? el.querySelector('[data-focus="add"]') : null);
        target?.focus();
        if (target && focusKey === view.pendingFocus) view.pendingFocus = null;
      }
    }

    // ---- ações ----
    function openMenu(deal, anchor, returnTo = anchor) {
      const pipeline = store.pipeline(deal.pipelineId);
      // O painel/quadro é reconstruído a cada update: o foco volta pelo data-focus, não pelo nó (que pode ter sido substituído).
      const key = returnTo.dataset.focus;
      const back = () => el.querySelector(`[data-focus="${CSS.escape(key)}"]`);
      // Uma decisão do motor por destino, derivada das etapas reais (origem = etapa atual do negócio).
      const options = (pipeline?.stages || []).map((stage) => ({ stage, decision: P.moveDecision(deal, stage) }));
      openMoveMenu({ anchor, options, currentStageId: deal.stageId, returnTo: back, onPick: (stageId) => requestMove(deal.id, stageId, { refocus: true }) });
    }

    /**
     * Único caminho de mover (arraste, menu, atalhos Ganho/Perdido): consulta o motor com o contexto
     * derivado dos dados e, se negado, avisa com o motivo e NÃO muda nada. Etapas finais pedem confirmação.
     */
    function requestMove(dealId, stageId, { refocus = false } = {}) {
      const deal = store.deal(dealId);
      const stage = store.stage(stageId);
      if (!deal || !stage || deal.stageId === stageId) return;
      if (!P.visibleDeals().some((d) => d.id === dealId)) {
        toast('Este negócio está fora do seu escopo.');
        return;
      }
      const decision = P.moveDecision(deal, stage);
      if (decision.effect === 'approval') {
        toast(`Mover para ${stage.name} requer aprovação de um gestor. Nada foi alterado.`);
        return;
      }
      if (decision.effect !== 'allow') {
        toast(`Não foi possível mover para ${stage.name}: ${P.reasonOf(decision, 'mover este negócio')}`);
        return;
      }
      const card = () => el.querySelector(`[data-focus="card:${dealId}"]`);
      const doMove = (reason) => {
        const r = A.moveDeal(dealId, stageId, { reason }); // re-verifica no motor (a permissão pode ter mudado com o modal aberto)
        if (!r.ok) {
          toast(`Não foi possível mover para ${stage.name}: ${P.reasonOf(r.decision, 'mover este negócio')}`);
          return;
        }
        toast(`Movido para ${stage.name}`);
        // Menu/teclado: devolve o foco ao cartão que mudou de coluna. No arraste não, senão o anel de foco aparece sem ter sido pedido.
        if (refocus) card()?.focus();
      };
      if (stage.kind === 'won' || stage.kind === 'lost') openConfirmMove({ deal, stage, onConfirm: doMove, restoreFocus: refocus ? card : undefined });
      else doMove('');
    }

    function newDeal() {
      const pipeline = store.pipeline(view.pipelineId);
      if (!pipeline) return;
      const { allowed, probe } = P.createOwners(pipeline);
      if (!allowed.length) {
        toast(P.reasonOf(probe, 'criar negócios neste pipeline'));
        return;
      }
      openNewDeal({
        pipeline,
        onCreated: (deal) => {
          view.selectedByPipeline[pipeline.id] = deal.id;
          render();
          el.querySelector(`[data-deal-id="${CSS.escape(deal.id)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          toast('Negócio criado');
        },
      });
    }

    function addProduct(deal) {
      const dec = P.editDecision(deal);
      if (dec.effect === 'deny') {
        toast(P.reasonOf(dec, 'editar a proposta'));
        return;
      }
      openAddProduct({
        deal,
        onAdded: (p) => toast(`${p.name} adicionado à proposta`),
        onBlocked: (d) => toast(d.effect === 'approval' ? 'Esta alteração precisa da aprovação de um gestor (o fluxo de aprovação ainda não existe). Nada foi alterado.' : P.reasonOf(d, 'editar a proposta')),
      });
    }

    function removeItem(deal, i) {
      const r = A.removeItem(deal.id, i);
      if (!r.ok) toast(r.decision.effect === 'approval' ? 'Esta alteração precisa da aprovação de um gestor (o fluxo de aprovação ainda não existe). Nada foi alterado.' : P.reasonOf(r.decision, 'editar a proposta'));
    }

    function send(deal) {
      if (view.sending.has(deal.id) || !A.itemsOf(deal).length) return;
      const dec = P.sendDecision(deal);
      if (dec.effect !== 'allow') {
        toast(P.reasonOf(dec, 'enviar a proposta'));
        return;
      }
      const by = store.state.currentUserId;
      view.sending.add(deal.id);
      view.pendingFocus = 'send';
      render();
      // Envio simulado. Se o usuário sair da tela, o envio termina mesmo assim (só mexe no store);
      // por isso este timer não é cancelado na limpeza.
      setTimeout(() => {
        view.sending.delete(deal.id);
        // Trocou de usuário durante o envio: não envia em nome de outra pessoa.
        if (store.state.currentUserId !== by) {
          liveRender?.();
          return;
        }
        const result = A.sendProposal(deal.id); // re-verifica no motor; store.update já re-renderiza quem estiver montado
        liveRender?.();
        // Itens ficam travados durante o envio (ver panel.js), então 'no-items' só ocorreria se outra tela os alterasse.
        const msg = {
          sent: 'Proposta enviada pelo WhatsApp',
          'no-chat': 'Proposta registrada (este contato ainda não tem conversa no WhatsApp)',
          'no-access': 'Proposta registrada, mas você não pode escrever na conversa deste contato',
          'no-items': 'Nada enviado: a proposta ficou sem produtos',
          denied: P.reasonOf(P.sendDecision(store.deal(deal.id) || deal), 'enviar a proposta'),
        }[result];
        toast(msg);
      }, 1100);
    }

    function openChat(deal) {
      const { conv, decision } = P.chatFor(deal);
      if (!conv || decision.effect !== 'allow') {
        toast(P.reasonOf(decision, 'ler a conversa deste contato'));
        return;
      }
      if (A.pointInboxTo(conv.id)) navigate('inbox');
    }

    function confirmDelete(deal) {
      const dec = P.deleteDecision(deal);
      if (dec.effect !== 'allow') {
        toast(P.reasonOf(dec, 'excluir negócios'));
        return;
      }
      const back = () => el.querySelector('[data-focus="delete"]') || el.querySelector('.pipeline-card');
      openConfirmDelete({
        deal,
        restoreFocus: back,
        onConfirm: () => {
          const r = A.deleteDeal(deal.id);
          toast(r.ok ? 'Negócio excluído' : P.reasonOf(r.decision, 'excluir negócios'));
        },
      });
    }

    function share(deal, target) {
      const r = A.shareDeal(deal.id, target);
      if (!r.ok) {
        toast(P.reasonOf(r.decision));
        return;
      }
      toast('Negócio compartilhado');
      el.querySelector('[data-focus="share-target"]')?.focus();
    }

    function unshare(deal, target) {
      const r = A.unshareDeal(deal.id, target);
      toast(r.ok ? 'Acesso removido' : P.reasonOf(r.decision));
    }

    // ---- ciclo de vida ----
    liveRender = render;
    const unsub = store.subscribe(render);
    document.addEventListener('dragend', clearDrag);
    render();

    return () => {
      alive = false;
      if (liveRender === render) liveRender = null;
      unsub();
      document.removeEventListener('dragend', clearDrag);
      clearDrag();
      closeMoveMenu({ restoreFocus: false });
      closeAllModals();
    };
  },
};
