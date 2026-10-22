// Tela "Negócios" (#/pipeline): quadro Kanban por pipeline + painel de proposta.
// Referência: docs/design-handoff (seção 4). Dados 100% em store.state.
// Permissões: a tela só REFLETE o motor (shared/permissions via access.js, decisões em
// pipeline/perm.js): negócios visíveis, pipelines, mover, proposta, conversa, campos e compartilhamento.
import { h, icon, replaceChildren, toast } from '../ui.js';
import { isMobile } from '../mobile.js';
import { linkTo } from '../router.js';
import { renderBoard, clearDrag, autoScroll } from './pipeline/board.js';
import { renderPanel, renderPanelEmpty } from './pipeline/panel.js';
import { createDealController, sending } from './pipeline/controller.js';
import { openNewDeal } from './pipeline/new-deal.js';
import { openMoveMenu, closeMoveMenu } from './pipeline/move-menu.js';
import { closeAllModals } from './pipeline/modal.js';
import * as A from './pipeline/actions.js';
import * as P from './pipeline/perm.js';

// Estado só de UI. Fica no módulo (não no store), mas é REINICIADO a cada mount: ao trocar de usuário
// ("Ver como") a tela remonta e nenhuma seleção/pipeline do usuário anterior vaza.
const view = {
  pipelineId: null,
  selectedByPipeline: {}, // pipelineId -> dealId (a seleção volta ao trocar de aba)
  pendingFocus: null, // chave data-focus a devolver ao foco quando o elemento estiver utilizável de novo
  mStage: null, // celular: etapa mostrada (o quadro vira uma lista por etapa)
};

export default {
  mount(el, { store, navigate }) {
    let alive = true;
    view.pipelineId = null;
    view.selectedByPipeline = {};
    view.pendingFocus = null;
    view.mStage = null;
    // ações do negócio (mover, editar, proposta, excluir, compartilhar) são as mesmas da página do negócio
    const { requestMove, editDeal, addProduct, removeItem, send, openChat, confirmDelete, share, unshare } = createDealController({
      root: el,
      navigate,
      rerender: () => render(),
      onSendStart: () => (view.pendingFocus = 'send'),
    });

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

    // Celular: em vez do quadro Kanban (colunas lado a lado), abas por etapa + lista vertical dos negócios da etapa;
    // tocar num negócio abre a proposta em tela cheia. Mover de etapa continua pelo menu "Mover para…" do cartão.
    const stagebar = h('div', { class: 'pipeline-stagebar', role: 'tablist', 'aria-label': 'Etapas' });
    const mback = h('button', { class: 'pipeline-mback', type: 'button', onclick: () => setMView('board') }, icon('M15 5l-7 7 7 7', 22), h('span', null, 'Negócios'));
    const pipelineEl = h('div', { class: 'pipeline', 'data-mview': 'board' });
    const setMView = (v) => (pipelineEl.dataset.mview = v);

    pipelineEl.append(
        h('header', { class: 'pipeline-header' }, h('div', { class: 'grow' }, h('div', { class: 'eyebrow' }, 'NEGÓCIOS'), h('h1', { class: 'page-title' }, 'PIPELINES')), pills, h('div', { class: 'pipeline-header__new' }, newBtn, newHint)),
        stagebar,
        h('div', { class: 'pipeline-body' }, mback, board, panel)
    );
    el.append(pipelineEl);

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

    /** Abas de etapa do celular (com a contagem de negócios de cada uma). */
    function drawStagebar(pipeline, deals) {
      const stages = pipeline?.stages || [];
      if (!stages.some((st) => st.id === view.mStage)) view.mStage = (stages.find((st) => A.dealsInStage(st.id, deals).length) || stages[0])?.id ?? null;
      replaceChildren(
        stagebar,
        ...stages.map((st) =>
          h(
            'button',
            {
              class: 'stage-chip' + (st.id === view.mStage ? ' is-active' : ''),
              type: 'button',
              role: 'tab',
              'aria-selected': String(st.id === view.mStage),
              onclick: () => {
                view.mStage = st.id;
                render();
              },
            },
            st.name,
            h('span', { class: 'stage-chip__n' }, A.dealsInStage(st.id, deals).length)
          )
        )
      );
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
        drawStagebar(pipeline, deals);
        renderBoard(board, {
          pipeline,
          deals,
          selectedId: deal?.id,
          levels,
          onSelect: (id) => {
            view.selectedByPipeline[pipeline.id] = id;
            if (isMobile()) setMView('deal'); // celular: abre a proposta do negócio em tela cheia
            render();
          },
          onMove: (id, stageId) => requestMove(id, stageId),
          onOpenMenu: openMenu,
        });

        board.querySelectorAll('.pipeline-col').forEach((col) => col.classList.toggle('is-mshow', col.dataset.stageId === view.mStage));
        renderPanel(panel, {
          deal,
          sending: !!deal && sending.has(deal.id),
          emptyMessage: deals.some((d) => d.pipelineId === pipeline.id) ? null : 'Você não tem negócios visíveis neste pipeline.',
          onOpenPage: () => (location.hash = linkTo('deal', { id: deal.id })),
          onEdit: () => editDeal(deal),
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

    // ---- ciclo de vida ----
    const unsub = store.subscribe(render);
    document.addEventListener('dragend', clearDrag);
    render();

    return () => {
      alive = false;
      unsub();
      document.removeEventListener('dragend', clearDrag);
      clearDrag();
      closeMoveMenu({ restoreFocus: false });
      closeAllModals();
    };
  },
};
