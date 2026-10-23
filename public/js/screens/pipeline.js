// Tela "Negócios" (#/pipeline): quadro Kanban por pipeline + painel de proposta.
// Referência: docs/design-handoff (seção 4). Dados 100% em store.state.
// Permissões: a tela só REFLETE o motor (shared/permissions via access.js, decisões em
// pipeline/perm.js): negócios visíveis, pipelines, mover, proposta, conversa, campos e compartilhamento.
import { h, icon, replaceChildren, toast, fmtBRL } from '../ui.js';
import { isMobile } from '../mobile.js';
import { linkTo, hashParam } from '../router.js';
import { ensureScreenCss } from '../css.js';
import { mask, fieldLevel } from '../access.js';
import { createTable } from '../lists/table.js';
import { dealColumns, dealCtx, dealViews } from './pipeline/list.js';
import { dealBulk } from './pipeline/bulk.js';
import { canImport, canExport, logExport } from './import/actions.js';
import { openImport } from './import/wizard.js';
import { weightedValue } from './funnels/model.js';
import { renderBoard, clearDrag, autoScroll } from './pipeline/board.js';
import { renderPanel, renderPanelEmpty } from './pipeline/panel.js';
import { createDealController, sending } from './pipeline/controller.js';
import { openNewDeal } from './pipeline/new-deal.js';
import { openMoveMenu, closeMoveMenu } from './pipeline/move-menu.js';
import { createPicker } from './pipeline/picker.js';
import { burst } from '../fx.js';
import { closeAllModals } from './pipeline/modal.js';
import * as A from './pipeline/actions.js';
import * as P from './pipeline/perm.js';

// Estado só de UI. Fica no módulo (não no store), mas é REINICIADO a cada mount: ao trocar de usuário
// ("Ver como") a tela remonta e nenhuma seleção/pipeline do usuário anterior vaza.
const MODE_KEY = 'ttf:pipeline:mode';
const PANEL_KEY = 'ttf:pipeline:panel';
/** Painel da proposta: o que a pessoa escolheu; sem escolha, recolhido em tela de notebook (< 1360 px) e aberto em monitor grande. */
function initialPanel() {
  try {
    const v = localStorage.getItem(PANEL_KEY);
    if (v === 'open' || v === 'closed') return v;
  } catch {
    /* sem armazenamento */
  }
  return (globalThis.innerWidth || 1440) < 1360 ? 'closed' : 'open';
}
function savedMode() {
  try {
    return localStorage.getItem(MODE_KEY) === 'list' ? 'list' : 'board';
  } catch {
    return 'board';
  }
}

const view = {
  pipelineId: null,
  selectedByPipeline: {}, // pipelineId -> dealId (a seleção volta ao trocar de aba)
  pendingFocus: null, // chave data-focus a devolver ao foco quando o elemento estiver utilizável de novo
  mStage: null, // celular: etapa mostrada (o quadro vira uma lista por etapa)
};

export default {
  mount(el, { store, navigate }) {
    let alive = true;
    ensureScreenCss('lists');
    // #/pipeline?view=closing (atalho do Início): abre a lista já na visão pedida, sem trocar a preferência salva
    let pendingView = hashParam('view');
    let mode = pendingView ? 'list' : savedMode();
    let ctxCache = null;
    const tables = new Map(); // pipelineId -> tabela (cada funil guarda os próprios filtros e colunas)
    const effectiveMode = () => (isMobile() ? 'board' : mode);
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

    // Funil em lista suspensa (como no Bitrix): escala para empresas com muitos funis, onde abas não cabem.
    const picker = createPicker({
      label: 'Funil',
      onPick: (id) => {
        if (view.pipelineId === id) return;
        view.pipelineId = id;
        board.scrollLeft = 0;
        render();
      },
    });
    const modeBtns = ['board', 'list'].map((id) => h('button', { class: 'pill', type: 'button', 'data-mode': id, 'aria-pressed': 'false', onclick: () => setMode(id) }, id === 'board' ? 'Quadro' : 'Lista'));
    const modeToggle = h('div', { class: 'pills lt-mode', role: 'group', 'aria-label': 'Forma de ver os negócios' }, ...modeBtns);
    const listHost = h('div', { class: 'pipeline-list', 'aria-label': 'Negócios em lista' });
    const newBtn = h('button', { class: 'btn btn--primary', type: 'button', onclick: () => newDeal() }, '+ Novo negócio');
    const importBtn = h('button', { class: 'btn btn--ghost pipeline-import', type: 'button', title: 'Trazer negócios de uma planilha CSV para este funil', onclick: () => openImport({ entity: 'deal', pipeline: store.pipeline(view.pipelineId), onDone: () => render() }) }, 'Importar CSV');
    const newHint = h('span', { class: 'pipeline-header__hint', role: 'note' });
    const board = h('div', { class: 'pipeline-board', id: 'pipeline-board', role: 'tabpanel', 'aria-label': 'Quadro do pipeline', onscroll: () => closeMoveMenu({ restoreFocus: false }), ondragover: (e) => autoScroll(e, board) });
    const panel = h('aside', { class: 'pipeline-panel', id: 'pipeline-panel', 'aria-label': 'Proposta do negócio selecionado' });

    // Celular: em vez do quadro Kanban (colunas lado a lado), abas por etapa + lista vertical dos negócios da etapa;
    // tocar num negócio abre a proposta em tela cheia. Mover de etapa continua pelo menu "Mover para…" do cartão.
    const stagebar = h('div', { class: 'pipeline-stagebar', role: 'tablist', 'aria-label': 'Etapas' });
    const mback = h('button', { class: 'pipeline-mback', type: 'button', onclick: () => setMView('board') }, icon('M15 5l-7 7 7 7', 22), h('span', null, 'Negócios'));
    const pipelineEl = h('div', { class: 'pipeline', 'data-mview': 'board', 'data-mode': 'board', 'data-panel': initialPanel() });
    const setMView = (v) => (pipelineEl.dataset.mview = v);
    // Painel da proposta recolhível: em notebook ele come um terço do quadro e esconde etapas. A escolha fica lembrada.
    const panelToggle = h('button', { class: 'pipeline-paneltoggle', type: 'button', 'aria-controls': 'pipeline-panel', onclick: () => setPanel(pipelineEl.dataset.panel === 'closed' ? 'open' : 'closed') });
    function setPanel(v, { remember = true } = {}) {
      pipelineEl.dataset.panel = v;
      const open = v !== 'closed';
      panelToggle.setAttribute('aria-expanded', String(open));
      panelToggle.title = open ? 'Recolher a proposta e ganhar espaço no quadro' : 'Mostrar a proposta do negócio selecionado';
      replaceChildren(panelToggle, icon(open ? 'M9 6l6 6-6 6' : 'M15 6l-6 6 6 6', 16), h('span', null, 'Proposta'));
      if (remember) {
        try {
          localStorage.setItem(PANEL_KEY, v);
        } catch {
          /* sem armazenamento: vale só nesta visita */
        }
      }
    }
    setPanel(pipelineEl.dataset.panel, { remember: false });

    pipelineEl.append(
        h('header', { class: 'pipeline-header' }, h('div', { class: 'grow' }, h('div', { class: 'eyebrow' }, 'NEGÓCIOS'), h('h1', { class: 'page-title' }, 'PIPELINES')), picker.el, modeToggle, h('div', { class: 'pipeline-header__new' }, importBtn, newBtn, newHint)),
        stagebar,
        listHost,
        h('div', { class: 'pipeline-body' }, mback, board, panelToggle, panel)
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

    function setMode(m) {
      mode = m;
      try {
        localStorage.setItem(MODE_KEY, m);
      } catch {
        /* sem armazenamento: só não lembra */
      }
      render();
    }

    /** Tabela do funil (criada sob demanda): linhas = negócios que o motor deixa ler, sem campos ocultos. */
    function tableFor(pipeline) {
      if (!tables.has(pipeline.id)) {
        const open = (d) => (location.hash = linkTo('deal', { id: d.id }));
        tables.set(
          pipeline.id,
          createTable({
            id: 'deals',
            scope: `${store.state.currentUserId}:${pipeline.id}`,
            columns: () => dealColumns(store.pipeline(pipeline.id)),
            ctx: () => (ctxCache ||= dealCtx()),
            getRows: () => P.visibleDeals().filter((d) => d.pipelineId === pipeline.id).map((d) => mask('deal', d)),
            builtins: dealViews(store.state.currentUserId),
            bulk: dealBulk(pipeline.id),
            noun: ['negócio', 'negócios'],
            exportable: { base: 'negocios', allowed: (n) => canExport('deal', n), log: (n) => logExport('deal', n) },
            emptyText: 'Nenhum negócio visível neste funil.',
            searchPlaceholder: 'Buscar por negócio, contato ou empresa',
            rowHref: (d) => linkTo('deal', { id: d.id }),
            onOpen: open,
            summary: (rows) => (fieldLevel('deal', 'value') === 'hidden' ? '' : `Soma ${fmtBRL(rows.reduce((n, d) => n + (Number(d.value) || 0), 0))} · ponderada ${fmtBRL(rows.reduce((n, d) => n + (weightedValue(d.value, store.stage(d.stageId)?.probability) || 0), 0))}`),
          })
        );
      }
      return tables.get(pipeline.id);
    }

    // ---- render ----
    function render() {
      if (!alive) return;
      ctxCache = null; // contatos e tarefas por negócio mudam com o estado
      const m = effectiveMode();
      pipelineEl.dataset.mode = m;
      for (const b of modeBtns) {
        const on = b.dataset.mode === m;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-pressed', String(on));
      }
      // Mantém o foco no mesmo elemento (cartão, botão, aba) depois de reconstruir o DOM.
      let focusKey = el.contains(document.activeElement) ? document.activeElement.dataset?.focus : null;
      if (!focusKey && document.activeElement === document.body) focusKey = view.pendingFocus;

      const deals = P.visibleDeals();
      const pipelines = P.visiblePipelines(deals);
      const pipeline = currentPipeline(pipelines);
      const deal = selectedDeal(pipeline, deals);
      const levels = P.fieldLevels();

      const countOf = (p) => deals.filter((d) => d.pipelineId === p.id).length;
      picker.update({ items: pipelines.map((p) => ({ id: p.id, name: p.name, sub: `${countOf(p)} ${countOf(p) === 1 ? 'negócio' : 'negócios'}` })), selectedId: pipeline?.id ?? null });

      // "+ Novo negócio": habilitado se o motor aceita algum responsável neste pipeline.
      const create = pipeline ? P.createOwners(pipeline) : null;
      const canCreate = !!create && create.allowed.length > 0;
      newBtn.disabled = !canCreate;
      importBtn.hidden = !pipeline || !canImport('deal');
      const newWhy = !pipeline ? 'Sem pipeline disponível para o seu perfil.' : canCreate ? '' : P.reasonOf(create.probe, 'criar negócios neste pipeline');
      newBtn.title = newWhy;
      newHint.textContent = newWhy;
      newHint.hidden = !newWhy;

      if (m === 'list') {
        if (!pipeline) replaceChildren(listHost, h('div', { class: 'empty pipeline-noaccess' }, h('div', { class: 'section-title gold' }, 'Nenhum pipeline disponível'), h('div', null, 'Seu perfil não permite ler negócios em nenhum pipeline.')));
        else {
          const t = tableFor(pipeline);
          if (pendingView) {
            t.selectView(pendingView);
            pendingView = null;
          }
          if (listHost.firstChild !== t.el) replaceChildren(listHost, t.el);
          t.redraw();
        }
        if (focusKey) el.querySelector(`[data-focus="${CSS.escape(focusKey)}"]:not(:disabled)`)?.focus();
        return;
      }

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
            if (!isMobile() && pipelineEl.dataset.panel === 'closed') setPanel('open'); // escolheu um negócio: mostra a proposta
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
          burst({ n: 7 });
        },
      });
    }

    // ---- ciclo de vida ----
    const unsub = store.subscribe(render);
    document.addEventListener('dragend', clearDrag);
    render();

    return () => {
      alive = false;
      tables.forEach((t) => t.destroy());
      picker.close();
      unsub();
      document.removeEventListener('dragend', clearDrag);
      clearDrag();
      closeMoveMenu({ restoreFocus: false });
      closeAllModals();
    };
  },
};
