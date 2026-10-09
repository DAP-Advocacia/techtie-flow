// Automações: lista de fluxos (esquerda) + canvas (direita) com nós
// Gatilho → Condição → Ação ligados por conectores. Os fluxos vivem em
// store.state.automations; seleção, menu aberto, simulação etc. são só de UI.
import { h, icon, replaceChildren, toast, toggle } from '../ui.js';
import { KIND_META, TYPES, typesOf, createNode, refresh, emptyTrigger, flowIssues, nodeIssues, normalizeNode, newId } from './automations/catalog.js';
import { renderEditor, PATHS } from './automations/editor.js';
import { audit } from '../access.js';
import { check, blocked, createHints, banner, anyOk } from './_ops/perm.js';

const PLUS = 'M12 5v14M5 12h14';
const PLAY = 'M7 4l13 8-13 8z';
const CHECK = 'M5 12l5 5 9-10';
const NOTICE_UNPUBLISHABLE = 'Este fluxo estava ativo e foi pausado pela edição: seu perfil não permite publicar. Peça a quem tem essa permissão para publicá-lo de novo.';
const STEP_MS = 750; // tempo por nó na simulação de "Testar"

const STATUS = {
  active: { label: 'Ativo', color: 'var(--green)' },
  paused: { label: 'Pausado', color: 'var(--acc)' },
  draft: { label: 'Rascunho', color: 'var(--mute)' },
};

function runsLabel(n) {
  if (!n) return 'nenhuma execução';
  const v = n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  return `${v} ${n === 1 ? 'execução' : 'execuções'}`;
}

function flowMeta(f) {
  const st = STATUS[f.status] || STATUS.draft;
  return f.status === 'draft' ? st.label : `${st.label} · ${runsLabel(f.runs)}`;
}

export default {
  mount(el, { store }) {
    // Nós do mock só têm título/descrição: completa tipo/params para o editor funcionar.
    store.update((s) => {
      for (const a of s.automations) {
        a.nodes ||= [];
        for (const n of a.nodes) normalizeNode(n, s);
      }
    });

    // ---- estado só de UI ----
    let selFlowId = store.state.automations[0]?.id ?? null;
    let selNodeId = null;
    let menuIdx = null; // índice do nó depois do qual o menu "+" está aberto
    let confirmRemove = false;
    let errors = null; // { verb, items } quando publicar/testar falha
    let attempted = false; // marca nós incompletos em vermelho
    let run = null; // simulação do "Testar"
    let runTimer = null;
    let busy = false; // true enquanto EU mudo o store (evita re-render duplo e perda de foco)
    const touched = new Set();
    let removeTimer = null;
    let notice = null; // aviso informativo (ex.: fluxo pausado por edição sem permissão de publicar)

    // Permissões (motor). Criar / editar / publicar são ações distintas: o Gestor edita, não publica.
    // "Testar" é simulação e basta ler (a rota já exige automation.read).
    const hints = createHints();
    const P = {
      create: () => check('automation', 'create'),
      update: () => check('automation', 'update'),
      publish: () => check('automation', 'publish'),
      remove: () => check('automation', 'delete'),
    };
    // Auditoria sem disparar o re-render global (as renderizações granulares abaixo cuidam disso).
    const log = (action, target, detail) => {
      busy = true;
      try {
        audit(action, target, detail);
      } finally {
        busy = false;
      }
    };
    const bannerEl = banner(false);
    const syncBanner = () => {
      bannerEl.hidden = anyOk(P.create(), P.update(), P.publish(), P.remove());
    };

    const flows = () => store.state.automations;
    const curFlow = () => flows().find((f) => f.id === selFlowId) || null;
    const curNode = () => curFlow()?.nodes.find((n) => n.id === selNodeId) || null;

    /** Muta o store sem disparar o re-render global (os renders granulares abaixo cuidam disso). */
    function commit(fn) {
      busy = true;
      try {
        store.update(fn);
      } finally {
        busy = false;
      }
    }

    // ---- contêineres ----
    const listHost = h('section', { class: 'automations-list', 'aria-label': 'Fluxos' });
    const headHost = h('div', { class: 'automations-head' });
    const alertHost = h('div');
    const flowHost = h('div', { class: 'automations-flow', role: 'list', 'aria-label': 'Etapas do fluxo' });
    const panelHost = h('div', { class: 'automations-panelhost' });
    const logHost = h('div');
    const canvas = h('section', { class: 'automations-canvas', 'aria-label': 'Editor do fluxo' }, bannerEl, headHost, alertHost, flowHost, panelHost, logHost, hints.host);
    el.append(h('div', { class: 'automations' }, listHost, canvas));

    /** Reconstrói um contêiner devolvendo o foco ao mesmo controle (via data-fk). */
    function rebuild(host, build) {
      const a = document.activeElement;
      const key = host.contains(a) ? a.dataset?.fk : null;
      replaceChildren(host, build());
      if (key) {
        const t = host.querySelector(`[data-fk="${CSS.escape(key)}"]`);
        if (t && !t.disabled) t.focus({ preventScroll: true });
      }
    }

    // ================= lista =================
    function renderList() {
      syncBanner();
      const canPublish = P.publish();
      rebuild(listHost, () => [
        h('h1', { class: 'section-title automations-list__title' }, 'Automações'),
        hints.lock(h('button', { class: 'btn btn--primary btn--block', type: 'button', onclick: newFlow, 'data-fk': 'new' }, '+ Novo fluxo'), P.create()),
        flows().length
          ? flows().map((f) => {
              const sel = f.id === selFlowId;
              const st = STATUS[f.status] || STATUS.draft;
              const tg = toggle(f.status === 'active', (on) => setStatus(f, on), `${f.status === 'active' ? 'Pausar' : 'Ativar'} fluxo ${f.name}`);
              hints.lock(tg, canPublish);
              tg.dataset.fk = `tg-${f.id}`;
              tg.classList.add('automations-item__toggle');
              return h('div', { class: 'automations-item' + (sel ? ' is-selected' : '') },
                h('button', { class: 'automations-item__main', type: 'button', 'data-fk': `item-${f.id}`, 'aria-current': sel ? 'true' : null, onclick: () => selectFlow(f.id) },
                  h('span', { class: 'automations-item__name', title: f.name || 'Fluxo sem nome' }, f.name || 'Fluxo sem nome'),
                  h('span', { class: 'automations-item__meta' }, h('i', { class: 'automations-dot', style: { background: st.color } }), flowMeta(f))),
                tg);
            })
          : h('div', { class: 'empty' }, 'Nenhum fluxo ainda.', h('span', { class: 'muted' }, 'Crie o primeiro com "+ Novo fluxo".')),
      ]);
    }

    // ================= cabeçalho =================
    function renderHead() {
      const f = curFlow();
      if (!f) {
        replaceChildren(headHost);
        return;
      }
      const st = STATUS[f.status] || STATUS.draft;
      const running = run?.status === 'running' && run.flowId === f.id;
      const canUpdate = P.update();
      rebuild(headHost, () => [
        h('div', { class: 'automations-head__id' },
          h('div', { class: 'label' }, 'Fluxo'),
          hints.lock(h('input', {
            class: 'automations-name', type: 'text', value: f.name, maxlength: 80, 'aria-label': 'Nome do fluxo', 'data-fk': 'name', placeholder: 'Nome do fluxo',
            oninput: (e) => {
              if (!P.update().ok) { e.target.value = f.name; return; }
              commit(() => { f.name = e.target.value; });
              renderList();
            },
            onblur: (e) => {
              if (!P.update().ok) return;
              // Nome vazio não faz sentido na lista: volta para um padrão.
              if (!e.target.value.trim()) {
                commit(() => { f.name = 'Fluxo sem nome'; });
                e.target.value = f.name;
                renderList();
              }
            },
          }), canUpdate, { readOnly: true })),
        h('div', { class: 'automations-head__actions' },
          h('span', { class: 'automations-status' }, h('i', { class: 'automations-dot', style: { background: st.color } }), st.label),
          h('button', { class: 'btn automations-test', type: 'button', disabled: running, onclick: testFlow, 'data-fk': 'test' }, icon(PLAY, 13), running ? 'Testando…' : 'Testar'),
          hints.lock(h('button', { class: 'btn btn--primary automations-publish', type: 'button', onclick: publish, 'data-fk': 'publish' }, 'Publicar'), P.publish())),
      ]);
    }

    function renderAlert() {
      replaceChildren(alertHost,
        notice
          ? h('div', { class: 'automations-alert automations-alert--notice', role: 'status' }, h('strong', null, notice))
          : null,
        errors
          ? h('div', { class: 'automations-alert', role: 'alert' },
              h('strong', null, `Não foi possível ${errors.verb} o fluxo`),
              h('ul', null, errors.items.map((m) => h('li', null, m))))
          : null);
    }

    // ================= canvas de nós =================
    function renderFlow() {
      const f = curFlow();
      if (!f) {
        replaceChildren(flowHost);
        return;
      }
      const issuesOn = attempted;
      const canUpdate = P.update();
      rebuild(flowHost, () => f.nodes.map((n, i) => {
        const meta = KIND_META[n.kind] || KIND_META.action;
        const empty = !n.type;
        const hasIssue = issuesOn && (empty || Object.keys(nodeIssues(n, store.state)).length > 0);
        const runIdx = run && run.flowId === f.id ? run : null;
        const isRunning = runIdx?.status === 'running' && runIdx.idx === i;
        // Interrompida: só até o nó em que parou executou (o log já registrou a linha dele); "done" sem interrupção = todos.
        const isDone = runIdx && (runIdx.interrupted ? i <= runIdx.idx : runIdx.status === 'done' || i < runIdx.idx);
        const cls = ['automations-node', `automations-node--${n.kind}`];
        if (n.id === selNodeId) cls.push('is-selected');
        if (empty) cls.push('is-empty');
        if (hasIssue) cls.push('has-issue');
        if (isRunning) cls.push('is-running');
        if (isDone) cls.push('is-done');
        const isLast = i === f.nodes.length - 1;
        const menuOpen = menuIdx === i;

        const node = h('button', {
          class: cls.join(' '), type: 'button', 'data-fk': `node-${n.id}`, 'data-node-id': n.id,
          'aria-pressed': String(n.id === selNodeId),
          'aria-label': `${i + 1}. ${meta.label}: ${n.title}. ${n.desc}${hasIssue ? '. Incompleto' : ''}`,
          title: i > 0 && canUpdate.ok ? 'Alt + ← / → reordena' : null,
          onclick: () => selectNode(n.id === selNodeId ? null : n.id),
          onkeydown: (e) => {
            if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && n.kind !== 'trigger') {
              e.preventDefault();
              moveNode(n.id, e.key === 'ArrowLeft' ? -1 : 1);
            }
          },
        },
          h('span', { class: 'automations-node__top' },
            h('span', { class: 'automations-kind', style: { color: meta.color } }, meta.tag),
            h('span', { class: 'automations-node__num' }, hasIssue ? h('span', { class: 'automations-node__warn', title: 'Incompleto' }, '!') : null, isDone ? h('span', { class: 'automations-node__check' }, icon(CHECK, 13)) : String(i + 1))),
          h('span', { class: 'automations-node__title' }, n.title),
          h('span', { class: 'automations-node__desc' }, n.desc));

        const add = hints.lock(h('button', {
          class: 'automations-add' + (isLast ? ' automations-add--end' : '') + (menuOpen ? ' is-open' : ''), type: 'button', 'data-fk': `add-${n.id}`,
          'aria-label': `Inserir etapa depois de "${n.title}"`, 'aria-haspopup': 'menu', 'aria-expanded': String(menuOpen),
          onclick: (e) => {
            e.stopPropagation();
            if (!P.update().ok) return;
            menuIdx = menuOpen ? null : i;
            renderFlow();
            if (menuIdx != null) openMenuUi();
          },
        }, icon(PLUS, 12)), canUpdate);

        return h('div', { class: 'automations-step', role: 'listitem', dataset: { idx: String(i) } },
          node,
          h('div', { class: 'automations-link' },
            h('span', { class: 'automations-link__line' }),
            h('span', { class: 'automations-link__anchor' }, add, menuOpen ? buildMenu(i) : null),
            isLast ? null : h('span', { class: 'automations-link__tail' })));
      }));
      markRows();
    }

    // Último item de cada linha: esconde (sem mudar a largura) o rabicho do conector,
    // senão ele fica pendurado no vazio quando o fluxo quebra de linha.
    function markRows() {
      const steps = [...flowHost.children];
      steps.forEach((s, i) => s.classList.toggle('is-wrap', !!steps[i + 1] && steps[i + 1].offsetTop > s.offsetTop + 4));
    }
    const ro = new ResizeObserver(markRows);
    ro.observe(flowHost);

    // ---- menu "+" ----
    function buildMenu(idx) {
      const groups = [['condition', typesOf('condition')], ['action', typesOf('action')]];
      const menu = h('div', {
        class: 'automations-menu', role: 'menu', 'aria-label': 'Inserir etapa',
        onkeydown: (e) => {
          const items = [...menu.querySelectorAll('[role=menuitem]')];
          const i = items.indexOf(document.activeElement);
          if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
        },
      }, groups.map(([kind, types]) =>
        h('div', { class: 'automations-menu__group', role: 'group', 'aria-label': KIND_META[kind].label },
          h('span', { class: 'automations-menu__label', style: { color: KIND_META[kind].color } }, KIND_META[kind].tag),
          types.map((t) => h('button', { class: 'automations-menu__item', type: 'button', role: 'menuitem', onclick: () => insertNode(idx, t.id) }, t.label)))));
      return menu;
    }

    // Mantém o menu dentro do canvas (nós perto da borda direita empurrariam o scroll horizontal).
    function openMenuUi() {
      const menu = flowHost.querySelector('.automations-menu');
      if (!menu) return;
      requestAnimationFrame(() => {
        const c = canvas.getBoundingClientRect();
        const r = menu.getBoundingClientRect();
        const maxRight = c.left + canvas.clientWidth - 12;
        let shift = 0;
        if (r.left < c.left + 12) shift = c.left + 12 - r.left;
        else if (r.right > maxRight) shift = maxRight - r.right;
        if (shift) menu.style.marginLeft = `${shift}px`;
        menu.scrollIntoView({ block: 'nearest' });
        menu.querySelector('[role=menuitem]')?.focus({ preventScroll: true });
      });
    }

    function closeMenu(returnFocus = false) {
      if (menuIdx == null) return;
      const id = curFlow()?.nodes[menuIdx]?.id;
      menuIdx = null;
      renderFlow();
      if (returnFocus && id) flowHost.querySelector(`[data-fk="add-${CSS.escape(id)}"]`)?.focus();
    }

    const onDocPointer = (e) => {
      if (menuIdx != null && !e.target.closest?.('.automations-menu, .automations-add')) closeMenu();
    };
    const onDocKey = (e) => {
      if (e.key === 'Escape' && menuIdx != null) {
        e.preventDefault();
        closeMenu(true);
      }
    };
    document.addEventListener('pointerdown', onDocPointer);
    document.addEventListener('keydown', onDocKey);

    // ================= painel de edição =================
    function renderPanel() {
      const f = curFlow();
      const n = curNode();
      if (!f) {
        replaceChildren(panelHost);
        return;
      }
      if (!n) {
        replaceChildren(panelHost, h('p', { class: 'automations-hint' }, 'Clique em um nó para editar. Use o + entre os nós para inserir condições e ações.'));
        return;
      }
      rebuild(panelHost, () => renderEditor({
        node: n, index: f.nodes.indexOf(n), total: f.nodes.length, state: store.state, confirmingRemove: confirmRemove,
        isTouched: (id, key) => touched.has(`${id}:${key}`),
        touch: (id, key) => touched.add(`${id}:${key}`),
        forceErrors: () => attempted,
        perm: { hints, check: P.update() },
        api: {
          setType: (typeId) => editNode(n, (node) => {
            const def = TYPES[typeId];
            node.type = typeId;
            node.params = def.defaults(store.state);
          }, true),
          setParam: (key, value, { structural }) => editNode(n, (node) => { node.params[key] = value; }, structural),
          move: (dir) => moveNode(n.id, dir),
          askRemove: () => {
            if (blocked(P.update())) return;
            confirmRemove = true;
            clearTimeout(removeTimer);
            removeTimer = setTimeout(() => { confirmRemove = false; renderPanel(); }, 5000);
            renderPanel();
            panelHost.querySelector('[data-fk="remove-yes"]')?.focus();
          },
          cancelRemove: () => { confirmRemove = false; clearTimeout(removeTimer); renderPanel(); },
          remove: () => removeNode(n.id),
          close: () => selectNode(null),
        },
      }));
    }

    // ================= log do "Testar" =================
    function renderLog() {
      const f = curFlow();
      if (!f || !run || run.flowId !== f.id) {
        replaceChildren(logHost);
        return;
      }
      replaceChildren(logHost, h('section', { class: 'automations-panel automations-log', 'aria-label': 'Log de execução' },
        h('div', { class: 'automations-panel__head' },
          h('span', { class: 'automations-kind', style: { color: 'var(--mute)' } }, 'LOG DE EXECUÇÃO · SIMULAÇÃO'),
          h('span', { class: 'automations-log__state', style: { color: run.status === 'running' ? 'var(--acc)' : 'var(--green)' } }, run.status === 'running' ? 'Executando…' : run.interrupted ? 'Interrompido' : 'Concluído')),
        h('ol', { class: 'automations-log__lines', 'aria-live': 'polite' }, run.lines.map((l) =>
          h('li', { class: `automations-log__line is-${l.tone}` }, h('time', { class: 'num' }, l.t), h('span', null, l.text))))));
    }

    // ================= ações =================
    function renderAll() {
      renderList();
      renderHead();
      renderAlert();
      renderFlow();
      renderPanel();
      renderLog();
    }

    function selectFlow(id) {
      stopRun();
      selFlowId = id;
      selNodeId = null;
      menuIdx = null;
      confirmRemove = false;
      notice = null;
      errors = null;
      attempted = false;
      renderAll();
    }

    function selectNode(id) {
      selNodeId = id;
      confirmRemove = false;
      menuIdx = null;
      renderFlow();
      renderPanel();
      if (id) panelHost.firstElementChild?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    function newFlow() {
      if (blocked(P.create())) return;
      const names = new Set(flows().map((f) => f.name));
      let name = 'Novo fluxo';
      for (let i = 2; names.has(name); i++) name = `Novo fluxo ${i}`;
      const trigger = emptyTrigger();
      const flow = { id: `a${newId()}`, name, status: 'draft', runs: 0, nodes: [trigger] };
      commit((s) => { s.automations.push(flow); });
      log('automation.create', flow.id, `Fluxo "${flow.name}" criado (rascunho)`);
      selectFlow(flow.id);
      selectNode(trigger.id);
      listHost.querySelector(`[data-fk="item-${CSS.escape(flow.id)}"]`)?.scrollIntoView({ block: 'nearest' });
      const nameInput = headHost.querySelector('.automations-name');
      nameInput?.focus();
      nameInput?.select();
    }

    // Edita um nó e atualiza título/desc; `structural` refaz o painel (campos dependentes).
    function editNode(node, fn, structural) {
      if (blocked(P.update())) {
        renderPanel();
        return;
      }
      stopRun('Execução interrompida: o fluxo foi editado.');
      commit((s) => {
        fn(node);
        refresh(node, s);
      });
      const demoted = demoteIfInvalid() || pauseIfUnpublishable();
      revalidate();
      renderFlow();
      renderLog(); // o stopRun pode ter descartado o resultado do teste
      renderList();
      if (demoted) renderHead();
      if (structural) renderPanel();
    }

    function insertNode(afterIdx, typeId) {
      const f = curFlow();
      if (!f || blocked(P.update())) return;
      stopRun('Execução interrompida: o fluxo foi editado.');
      const node = createNode(typeId, store.state);
      commit(() => { f.nodes.splice(afterIdx + 1, 0, node); });
      menuIdx = null;
      selNodeId = node.id;
      confirmRemove = false;
      const paused = pauseIfUnpublishable();
      revalidate();
      if (paused) { renderList(); renderHead(); }
      renderFlow();
      renderPanel();
      renderLog();
      panelHost.querySelector('[data-fk="f-type"]')?.focus();
      flowHost.querySelector(`[data-node-id="${CSS.escape(node.id)}"]`)?.scrollIntoView({ block: 'nearest' });
    }

    function moveNode(id, dir) {
      const f = curFlow();
      if (!f || blocked(P.update())) return;
      const i = f.nodes.findIndex((n) => n.id === id);
      const j = i + dir;
      // O gatilho (posição 0) é fixo: ninguém troca de lugar com ele.
      if (i < 1 || j < 1 || j >= f.nodes.length) return;
      stopRun('Execução interrompida: o fluxo foi editado.');
      commit(() => { [f.nodes[i], f.nodes[j]] = [f.nodes[j], f.nodes[i]]; });
      if (pauseIfUnpublishable()) { renderList(); renderHead(); }
      renderFlow();
      renderPanel();
      renderLog();
      flowHost.querySelector(`[data-node-id="${CSS.escape(id)}"]`)?.focus();
    }

    function removeNode(id) {
      const f = curFlow();
      if (!f || blocked(P.update())) return;
      const i = f.nodes.findIndex((n) => n.id === id);
      if (i < 1) return; // gatilho não sai
      stopRun('Execução interrompida: o fluxo foi editado.');
      commit(() => { f.nodes.splice(i, 1); });
      clearTimeout(removeTimer);
      confirmRemove = false;
      selNodeId = null;
      menuIdx = null;
      const paused = pauseIfUnpublishable();
      revalidate();
      if (paused) { renderList(); renderHead(); }
      renderFlow();
      renderPanel();
      renderLog();
      const prev = f.nodes[i - 1];
      if (prev) flowHost.querySelector(`[data-node-id="${CSS.escape(prev.id)}"]`)?.focus();
      toast('Nó removido');
    }

    // Fluxo ativo editado até ficar inválido não pode seguir rodando incompleto:
    // volta a "Pausado" e mostra o motivo; precisa de novo Publicar.
    function demoteIfInvalid() {
      const f = curFlow();
      if (!f || f.status !== 'active') return false;
      const items = flowIssues(f, store.state);
      if (!items.length) return false;
      commit(() => { f.status = 'paused'; });
      log('automation.pause', f.id, `Fluxo "${f.name}" pausado: ficou incompleto após edição`);
      if (!P.publish().ok) notice = NOTICE_UNPUBLISHABLE;
      errors = { verb: 'manter ativo', items };
      attempted = true;
      renderAlert();
      toast('Fluxo incompleto: pausado até ser publicado de novo');
      return true;
    }

    // Quem edita mas NÃO pode publicar não pode alterar um fluxo que está rodando em produção:
    // a edição rebaixa o fluxo para Pausado (mesmo comportamento do fluxo incompleto) e avisa que
    // só um perfil com permissão de publicar volta a ativá-lo.
    function pauseIfUnpublishable() {
      const f = curFlow();
      if (!f || f.status !== 'active' || P.publish().ok) return false;
      commit(() => { f.status = 'paused'; });
      log('automation.pause', f.id, `Fluxo "${f.name}" pausado: editado por perfil sem permissão de publicar`);
      notice = NOTICE_UNPUBLISHABLE;
      renderAlert();
      toast('Fluxo pausado: seu perfil não pode republicar');
      return true;
    }

    // Depois de uma tentativa falha, o aviso acompanha as correções.
    function revalidate() {
      if (!errors) return;
      const items = flowIssues(curFlow(), store.state);
      errors = items.length ? { ...errors, items } : null;
      if (!errors) attempted = false;
      renderAlert();
    }

    function fail(verb) {
      const items = flowIssues(curFlow(), store.state);
      if (!items.length) return false;
      errors = { verb, items };
      attempted = true;
      renderAlert();
      renderFlow();
      renderPanel();
      alertHost.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      return true;
    }

    function ok() {
      errors = null;
      attempted = false;
      renderAlert();
      renderFlow();
      renderPanel();
    }

    function publish() {
      const f = curFlow();
      if (!f || blocked(P.publish()) || fail('publicar')) return;
      ok();
      commit(() => { f.status = 'active'; });
      log('automation.publish', f.id, `Fluxo "${f.name}" publicado e ativo (${f.nodes.length} etapas)`);
      notice = null;
      renderAlert();
      renderList();
      renderHead();
      toast(`Fluxo "${f.name}" publicado e ativo`);
    }

    function setStatus(f, on) {
      if (blocked(P.publish())) {
        renderList(); // desfaz a troca visual do switch
        return;
      }
      if (on) {
        if (f.id !== selFlowId) selectFlow(f.id);
        if (fail('ativar')) {
          renderList();
          toast('Complete o fluxo antes de ativar');
          return;
        }
        ok();
        commit(() => { f.status = 'active'; });
        log('automation.publish', f.id, `Fluxo "${f.name}" ativado`);
        notice = null;
        renderAlert();
        toast(`"${f.name}" ativado`);
      } else {
        commit(() => { f.status = f.status === 'draft' ? 'draft' : 'paused'; });
        log('automation.pause', f.id, `Fluxo "${f.name}" pausado`);
        toast(`"${f.name}" pausado`);
      }
      renderList();
      renderHead();
    }

    // ---- simulação ----
    function stopRun(reason) {
      clearTimeout(runTimer);
      runTimer = null;
      if (run && run.status === 'running') {
        run.status = 'done';
        run.interrupted = true;
        if (reason) run.lines.push({ t: elapsed(), text: reason, tone: 'warn' });
        if (run.flowId === selFlowId) {
          renderHead();
          renderLog();
        }
      } else if (reason) {
        run = null; // edição depois de um teste concluído: o resultado ficou obsoleto
      }
    }
    const elapsed = () => `${((Date.now() - run.start) / 1000).toFixed(1).replace('.', ',')}s`;

    function testFlow() {
      const f = curFlow();
      if (!f || (run?.status === 'running')) return;
      if (fail('testar')) return;
      ok();
      selNodeId = null; // o destaque da execução não pode se confundir com o de seleção
      menuIdx = null;
      renderPanel();
      run = { flowId: f.id, status: 'running', idx: 0, lines: [], start: Date.now(), interrupted: false };
      step();
    }

    function step() {
      const f = curFlow();
      if (!run || !f || run.flowId !== f.id) return;
      const n = f.nodes[run.idx];
      const text = n.kind === 'trigger'
        ? `Gatilho disparado: ${n.title}. ${n.desc}.`
        : n.kind === 'condition'
          ? `Condição "${n.title}" avaliada como verdadeira. Segue o fluxo.`
          : `Ação executada: ${n.title}. ${n.desc}.`;
      run.lines.push({ t: elapsed(), text, tone: 'ok' });
      renderHead();
      renderFlow();
      renderLog();
      runTimer = setTimeout(() => {
        if (run.idx + 1 < f.nodes.length) {
          run.idx += 1;
          step();
        } else {
          run.status = 'done';
          run.lines.push({ t: elapsed(), text: `Fluxo concluído: ${f.nodes.length} etapas, sem erros. Simulação: nada foi enviado de verdade.`, tone: 'end' });
          renderHead();
          renderFlow();
          renderLog();
          logHost.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
      }, STEP_MS);
    }

    // Mudanças vindas de fora (outra tela / sidebar) — as minhas passam por commit().
    const unsub = store.subscribe(() => {
      if (busy) return;
      if (!flows().some((f) => f.id === selFlowId)) selFlowId = flows()[0]?.id ?? null;
      renderAll();
    });

    renderAll();

    return () => {
      unsub();
      ro.disconnect();
      clearTimeout(runTimer);
      clearTimeout(removeTimer);
      document.removeEventListener('pointerdown', onDocPointer);
      document.removeEventListener('keydown', onDocKey);
    };
  },
};
