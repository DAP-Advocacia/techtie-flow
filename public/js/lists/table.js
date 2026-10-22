// Tabela de lista reutilizável (Contatos e Negócios): colunas escolhíveis, ordenação, busca, filtros por coluna,
// visões salvas (neste navegador), seleção com ações em massa e "Mostrar mais". A tela só descreve as colunas
// (ver lists/model.js) e entrega as linhas JÁ filtradas pelo motor de permissões: a tabela nunca amplia o acesso.
// Colunas de campo oculto NÃO entram em `columns` (senão ordenar/filtrar vazaria o valor escondido).
import { h, icon, replaceChildren, fmtBRL, fmtInt } from '../ui.js';
import { runList, normalizeState, opsOf, opDef, describeFilter, makeViewsStore, parseNumber } from './model.js';

const PAGE = 50;
/** Estado de trabalho de cada lista na sessão (chave: lista + escopo, ex.: usuário). Some ao recarregar a página. */
const memory = new Map();
const fmtDate = (t) => new Date(t).toLocaleDateString('pt-BR');
const blank = (v) => v === null || v === undefined || v === '';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Texto padrão de uma célula, conforme o tipo da coluna (a coluna pode trazer o próprio `cell`). */
function defaultCell(col, row, ctx) {
  const v = col.get(row, ctx);
  if (blank(v) || (typeof v === 'number' && Number.isNaN(v))) return '—';
  switch (col.type) {
    case 'money':
      return fmtBRL(v);
    case 'number':
      return fmtInt(v);
    case 'date':
      return fmtDate(v);
    case 'bool':
      return v ? 'Sim' : 'Não';
    case 'enum':
      return col.options?.(ctx)?.find((o) => String(o.value) === String(v))?.label ?? String(v);
    default:
      return String(v);
  }
}

/**
 * @param {object} o
 * @param {string} o.id               chave da lista (visões salvas ficam em ttf:views:<id>)
 * @param {Array|Function} o.columns  colunas (ou função que as devolve — chamada a cada desenho)
 * @param {Function} o.getRows        () => linhas já visíveis para o usuário (e sem campos ocultos)
 * @param {Array} o.builtins          visões de fábrica [{ id, name, state }]
 * @param {Function} [o.ctx]          () => contexto passado a get/cell/options
 * @param {Function} [o.onOpen]       (row) => abre o registro (clique/Enter na linha)
 * @param {Function} [o.rowHref]      (row) => href do link da 1ª coluna (abrir em nova aba)
 * @param {Array} [o.bulk]            [{ id, label, danger?, show?(), run(rows, done) }] — `done()` limpa a seleção.
 *                                    Com `choices(rows) → [{ value, label }]` vira um menu e `run(rows, done, valor)`.
 * @param {Function} [o.summary]      (linhas filtradas, ctx) => texto extra do rodapé (ex.: soma dos valores)
 * @param {Function} [o.rowClass]     (row) => classe extra da linha
 * @param {string} [o.scope]          separa o estado lembrado entre usuários (use o id do usuário atual)
 */
export function createTable(o) {
  const { id, builtins = [], onOpen, rowHref, bulk = [], noun = ['item', 'itens'], emptyText = 'Nada por aqui.', summary, rowClass, storage = globalThis.localStorage } = o;
  const getCols = () => (typeof o.columns === 'function' ? o.columns() : o.columns);
  const getCtx = o.ctx || (() => ({}));
  const views = makeViewsStore(storage, id, builtins);

  let cols = getCols();
  // Ao voltar para a tela (ex.: depois de abrir um negócio) a lista continua como estava, com filtros não salvos e tudo.
  const memKey = `${id}|${o.scope ?? ''}`;
  const mem = memory.get(memKey);
  const start = (mem && views.get(mem.viewId)) || views.get(views.last()) || views.all()[0] || null;
  let viewId = start?.id ?? null;
  let state = normalizeState(mem && views.get(mem.viewId) ? mem.state : start?.state, cols);
  let panel = null; // 'filters' | 'columns' | 'save' | null
  let limit = PAGE;
  let draft = null; // filtro em edição
  let draftError = '';
  let timer = null;
  const selected = new Set();
  let shown = []; // linhas filtradas do último desenho

  // ---------------------------------------------------------------- elementos fixos (não são recriados: mantêm o foco)
  const search = h('input', { class: 'input lt-search', type: 'search', placeholder: o.searchPlaceholder || 'Buscar nesta lista', autocomplete: 'off', 'aria-label': 'Buscar nesta lista' });
  const viewSel = h('select', { class: 'select lt-views', 'aria-label': 'Visão da lista' });
  const modified = h('button', { class: 'lt-modified', type: 'button', title: 'Voltar ao que a visão tinha salvo', onclick: () => restoreView() }, 'Visão alterada · restaurar');
  const btnFilters = h('button', { class: 'btn btn--quiet btn--sm lt-btn', type: 'button', 'aria-expanded': 'false', onclick: () => togglePanel('filters') });
  const btnCols = h('button', { class: 'btn btn--quiet btn--sm lt-btn', type: 'button', 'aria-expanded': 'false', onclick: () => togglePanel('columns') }, 'Colunas');
  const btnSave = h('button', { class: 'btn btn--quiet btn--sm lt-btn', type: 'button', 'aria-expanded': 'false', onclick: () => togglePanel('save') }, 'Salvar visão');
  const btnDelete = h('button', { class: 'btn btn--quiet btn--sm lt-btn', type: 'button', onclick: () => deleteView() }, 'Apagar visão');
  const chips = h('div', { class: 'lt-chips' });
  const panelEl = h('div', { class: 'lt-panel' });
  const bulkEl = h('div', { class: 'lt-bulk', role: 'region', 'aria-label': 'Ações em massa' });
  const wrap = h('div', { class: 'lt-wrap' });
  const countEl = h('span', { class: 'lt-count muted', role: 'status' });
  const more = h('button', { class: 'btn btn--ghost btn--sm lt-more', type: 'button', onclick: () => ((limit += PAGE), draw()) }, 'Mostrar mais');
  const el = h(
    'section',
    { class: 'lt', 'aria-label': 'Lista em tabela' },
    h('div', { class: 'lt-toolbar' }, h('div', { class: 'lt-search-wrap' }, icon('M21 21l-4.3-4.3M17 10.5a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0z', 17), search), viewSel, modified, h('span', { class: 'lt-spacer' }), btnFilters, btnCols, btnSave, btnDelete),
    chips,
    panelEl,
    bulkEl,
    wrap,
    h('div', { class: 'lt-foot' }, countEl, more)
  );

  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state = { ...state, q: search.value };
      limit = PAGE;
      draw();
    }, 150);
  });
  viewSel.addEventListener('change', () => pickView(viewSel.value));

  // ---------------------------------------------------------------- visões
  function pickView(vid) {
    const v = views.get(vid);
    if (!v) return;
    viewId = v.id;
    views.setLast(v.id);
    state = normalizeState(v.state, cols);
    search.value = state.q;
    limit = PAGE;
    selected.clear();
    draw();
  }
  const restoreView = () => pickView(viewId);
  function deleteView() {
    if (!views.remove(viewId)) return;
    pickView(views.all()[0]?.id);
  }
  function saveView(name) {
    const v = views.save(name, state);
    if (!v) return false;
    viewId = v.id;
    panel = null;
    draw();
    return true;
  }

  // ---------------------------------------------------------------- painéis
  function togglePanel(name) {
    panel = panel === name ? null : name;
    if (panel === 'filters') {
      draft = null;
      draftError = '';
    }
    draw();
    el.querySelector(`[data-focus="panel:${panel}"]`)?.focus();
  }
  const setState = (patch) => {
    state = { ...state, ...patch };
    limit = PAGE;
    draw();
  };

  const colOptions = (extra) => cols.filter((c) => c.filter !== false).map((c) => h('option', { value: c.id, selected: extra === c.id }, c.label));

  function filterPanel(ctx) {
    const filterable = cols.filter((c) => c.filter !== false);
    if (!filterable.length) return h('p', { class: 'muted' }, 'Esta lista não tem colunas filtráveis.');
    if (!draft || !filterable.some((c) => c.id === draft.col)) {
      const c = filterable[0];
      draft = { col: c.id, op: opsOf(c)[0].id, value: '', to: '' };
    }
    const col = cols.find((c) => c.id === draft.col);
    const ops = opsOf(col);
    if (!ops.some((x) => x.id === draft.op)) draft.op = ops[0].id;
    const op = opDef(col, draft.op);
    const colSel = h('select', { class: 'select', 'aria-label': 'Coluna do filtro', 'data-focus': 'f-col' }, ...colOptions(draft.col));
    const opSel = h('select', { class: 'select', 'aria-label': 'Condição do filtro', 'data-focus': 'f-op' }, ...ops.map((x) => h('option', { value: x.id, selected: x.id === draft.op }, x.label)));
    colSel.addEventListener('change', () => {
      const c = cols.find((x) => x.id === colSel.value);
      draft = { col: c.id, op: opsOf(c)[0].id, value: '', to: '' };
      draftError = '';
      drawPanel();
      panelEl.querySelector('[data-focus="f-col"]')?.focus();
    });
    opSel.addEventListener('change', () => {
      draft.op = opSel.value;
      draftError = '';
      drawPanel();
      panelEl.querySelector('[data-focus="f-op"]')?.focus();
    });
    const valueInput = (key, label) => {
      const bind = (node) => {
        node.addEventListener('input', () => (draft[key] = node.value));
        node.addEventListener('change', () => (draft[key] = node.value));
        return node;
      };
      if (col.type === 'enum') {
        const opts = col.options?.(ctx) || [];
        return bind(h('select', { class: 'select', 'aria-label': label, 'data-focus': 'f-val' }, h('option', { value: '' }, 'Escolha…'), ...opts.map((x) => h('option', { value: String(x.value), selected: String(x.value) === String(draft[key]) }, x.label))));
      }
      if (op.date) return bind(h('input', { class: 'input', type: 'date', 'aria-label': label, value: draft[key], 'data-focus': 'f-val' }));
      const numeric = col.type === 'number' || col.type === 'money';
      return bind(h('input', { class: 'input', type: 'text', inputmode: numeric ? 'decimal' : 'text', placeholder: numeric ? '0' : 'Valor', 'aria-label': label, value: draft[key], 'data-focus': 'f-val' }));
    };
    const form = h(
      'form',
      {
        class: 'lt-filter',
        novalidate: true,
        onsubmit: (e) => {
          e.preventDefault();
          addDraft(col, op);
        },
      },
      h('div', { class: 'lt-filter__row' }, colSel, opSel, op.noValue ? null : valueInput('value', op.range ? 'De' : 'Valor'), op.range ? h('span', { class: 'muted' }, 'e') : null, op.range ? valueInput('to', 'Até') : null, h('button', { class: 'btn btn--primary btn--sm', type: 'submit' }, 'Adicionar filtro')),
      draftError ? h('p', { class: 'field-error', role: 'alert' }, draftError) : null
    );
    return h('div', { class: 'lt-panel__body' }, h('div', { class: 'lt-panel__title' }, 'Filtrar por'), form, h('p', { class: 'muted lt-panel__hint' }, 'Vários filtros se somam: a lista mostra só o que atende a todos.'));
  }

  function addDraft(col, op) {
    draftError = '';
    const f = { col: col.id, op: op.id };
    if (!op.noValue) {
      const numeric = col.type === 'number' || col.type === 'money';
      const read = (v) => (numeric ? parseNumber(v) : String(v ?? '').trim());
      f.value = read(draft.value);
      if (op.range) f.to = read(draft.to);
      const bad = (v) => (numeric ? Number.isNaN(v) : !v);
      if (bad(f.value) || (op.range && bad(f.to))) draftError = numeric ? 'Informe números válidos, como 1.500,50.' : col.type === 'date' ? 'Escolha a data.' : 'Informe o valor do filtro.';
      else if (col.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(f.value)) draftError = 'Escolha a data.';
    }
    if (draftError) {
      drawPanel();
      panelEl.querySelector('[data-focus="f-val"]')?.focus();
      return;
    }
    draft = null;
    setState({ filters: [...state.filters, f] });
    el.querySelector('[data-focus="panel:filters"]')?.focus();
  }

  function columnsPanel() {
    const on = new Set(state.columns);
    return h(
      'div',
      { class: 'lt-panel__body' },
      h('div', { class: 'lt-panel__title' }, 'Colunas visíveis'),
      h(
        'ul',
        { class: 'lt-cols' },
        ...cols.map((c, i) =>
          h(
            'li',
            null,
            h(
              'label',
              { class: 'lt-check-label' },
              h('input', {
                type: 'checkbox',
                checked: on.has(c.id),
                disabled: i === 0, // a 1ª coluna identifica o registro: fica sempre
                'data-focus': `col:${c.id}`,
                onchange: (e) => {
                  const next = new Set(state.columns);
                  if (e.target.checked) next.add(c.id);
                  else next.delete(c.id);
                  setState({ columns: cols.filter((x) => next.has(x.id)).map((x) => x.id) });
                },
              }),
              h('span', null, c.label)
            )
          )
        )
      )
    );
  }

  function savePanel() {
    const current = views.get(viewId);
    const input = h('input', { class: 'input', type: 'text', maxlength: '60', placeholder: 'Nome da visão (ex.: Quentes da semana)', 'aria-label': 'Nome da visão', 'data-focus': 'view-name', value: current && !current.builtin ? current.name : '' });
    const err = h('p', { class: 'field-error', role: 'alert', hidden: true }, 'Dê um nome à visão.');
    return h(
      'div',
      { class: 'lt-panel__body' },
      h('div', { class: 'lt-panel__title' }, 'Salvar esta visão'),
      h(
        'form',
        {
          class: 'lt-filter__row',
          novalidate: true,
          onsubmit: (e) => {
            e.preventDefault();
            if (!saveView(input.value)) err.hidden = false;
          },
        },
        input,
        h('button', { class: 'btn btn--primary btn--sm', type: 'submit' }, 'Salvar')
      ),
      err,
      h('p', { class: 'muted lt-panel__hint' }, 'Guarda colunas, ordem, busca e filtros atuais neste navegador. Um nome que já existe é atualizado.')
    );
  }

  function drawPanel() {
    const ctx = getCtx();
    replaceChildren(panelEl, panel === 'filters' ? filterPanel(ctx) : panel === 'columns' ? columnsPanel() : panel === 'save' ? savePanel() : null);
    panelEl.hidden = !panel;
  }

  // ---------------------------------------------------------------- tabela
  function sortBy(colId) {
    const cur = state.sort?.col === colId ? state.sort.dir : null;
    setState({ sort: cur === null ? { col: colId, dir: 'asc' } : cur === 'asc' ? { col: colId, dir: 'desc' } : null });
    el.querySelector(`[data-focus="sort:${colId}"]`)?.focus();
  }

  function header(visibleCols, allSelected, someSelected) {
    const check = bulk.length
      ? h('th', { class: 'lt-th lt-th--check', scope: 'col' }, h('input', { type: 'checkbox', class: 'lt-check', 'aria-label': 'Selecionar todos os resultados', 'data-focus': 'sel-all', checked: allSelected, onchange: (e) => selectAll(e.target.checked) }))
      : null;
    if (check && someSelected && !allSelected) check.querySelector('input').indeterminate = true;
    return h(
      'tr',
      null,
      check,
      ...visibleCols.map((c) => {
        const dir = state.sort?.col === c.id ? state.sort.dir : null;
        const label = h('span', null, c.label);
        const th = h('th', { class: 'lt-th' + (c.align === 'right' ? ' lt-right' : ''), scope: 'col', 'aria-sort': c.sortable === false ? null : dir ? (dir === 'asc' ? 'ascending' : 'descending') : 'none' });
        if (c.sortable === false) th.append(label);
        else th.append(h('button', { class: 'lt-sort' + (dir ? ' is-sorted' : ''), type: 'button', 'data-focus': `sort:${c.id}`, title: `Ordenar por ${c.label}`, onclick: () => sortBy(c.id) }, label, h('span', { class: 'lt-sort__arrow', 'aria-hidden': 'true' }, dir === 'asc' ? '↑' : dir === 'desc' ? '↓' : '')));
        return th;
      })
    );
  }

  function selectAll(on) {
    if (on) shown.forEach((r) => selected.add(String(rowKey(r))));
    else selected.clear();
    draw();
    el.querySelector('[data-focus="sel-all"]')?.focus();
  }
  const rowKey = (r) => (o.rowId ? o.rowId(r) : r.id);

  function bodyRow(row, visibleCols, ctx) {
    const key = String(rowKey(row));
    const tr = h('tr', { class: 'lt-row' + (selected.has(key) ? ' is-selected' : '') + (rowClass ? ` ${rowClass(row) || ''}` : ''), 'data-row-id': key, tabindex: onOpen ? '0' : null });
    if (bulk.length) {
      tr.append(
        h(
          'td',
          { class: 'lt-td lt-td--check' },
          h('input', {
            type: 'checkbox',
            class: 'lt-check',
            'aria-label': `Selecionar ${String(visibleCols[0]?.get(row, ctx) ?? '')}`.trim(),
            checked: selected.has(key),
            onchange: (e) => {
              if (e.target.checked) selected.add(key);
              else selected.delete(key);
              draw();
            },
          })
        )
      );
    }
    visibleCols.forEach((c, i) => {
      const content = c.cell ? c.cell(row, ctx) : defaultCell(c, row, ctx);
      const href = i === 0 && rowHref ? rowHref(row) : null;
      tr.append(h('td', { class: 'lt-td' + (c.align === 'right' ? ' lt-right' : '') + (i === 0 ? ' lt-td--main' : '') }, href ? h('a', { class: 'lt-link', href }, content) : content));
    });
    if (onOpen) {
      const open = (e) => {
        if (e.target.closest?.('a, button, input, select, label')) return;
        onOpen(row);
      };
      tr.addEventListener('click', open);
      tr.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target === tr) onOpen(row);
      });
    }
    return tr;
  }

  /** Ação em massa com escolha (ex.: "Mover para etapa…"): um <select> que dispara `run(linhas, done, valor)` ao escolher. */
  function bulkChoice(a, items, done) {
    const sel = h('select', { class: 'select lt-bulk__select', 'aria-label': a.label, 'data-bulk': a.id }, h('option', { value: '' }, a.label), ...a.choices(items).map((c) => h('option', { value: String(c.value) }, c.label)));
    sel.addEventListener('change', () => {
      const v = sel.value;
      sel.value = '';
      if (v) a.run(items, done, v);
    });
    return sel;
  }

  function drawBulk(rows) {
    const items = rows.filter((r) => selected.has(String(rowKey(r))));
    bulkEl.hidden = !items.length;
    if (!items.length) return replaceChildren(bulkEl);
    const done = () => {
      selected.clear();
      draw();
    };
    replaceChildren(
      bulkEl,
      h('span', { class: 'lt-bulk__n' }, `${fmtInt(items.length)} ${items.length === 1 ? 'selecionado' : 'selecionados'}`),
      ...bulk.filter((a) => !a.show || a.show()).map((a) => (a.choices ? bulkChoice(a, items, done) : h('button', { class: 'btn btn--quiet btn--sm' + (a.danger ? ' lt-danger' : ''), type: 'button', 'data-bulk': a.id, onclick: () => a.run(items, done) }, a.label))),
      h('button', { class: 'btn btn--quiet btn--sm', type: 'button', 'data-bulk': 'clear', onclick: done }, 'Limpar seleção')
    );
  }

  function draw() {
    const focus = el.contains(document.activeElement) ? document.activeElement?.dataset?.focus : null;
    cols = getCols();
    state = normalizeState(state, cols); // colunas que sumiram (permissão mudou) saem de filtros, ordem e visibilidade
    const ctx = getCtx();
    const all = o.getRows();
    shown = runList(all, state, cols, ctx);
    const keys = new Set(shown.map((r) => String(rowKey(r))));
    for (const k of [...selected]) if (!keys.has(k)) selected.delete(k); // seleção só vale para o que está na lista

    memory.set(memKey, { viewId, state });

    // visões
    const current = views.get(viewId);
    replaceChildren(viewSel, ...views.all().map((v) => h('option', { value: v.id, selected: v.id === viewId }, v.builtin ? v.name : `${v.name} (minha)`)));
    viewSel.value = viewId ?? '';
    modified.hidden = !current || same(state, normalizeState(current.state, cols));
    btnDelete.hidden = !current || !!current.builtin;
    if (search.value !== state.q) search.value = state.q;

    // botões e painel
    btnFilters.textContent = state.filters.length ? `Filtros (${state.filters.length})` : 'Filtros';
    btnFilters.dataset.focus = 'panel:filters';
    btnCols.dataset.focus = 'panel:columns';
    btnSave.dataset.focus = 'panel:save';
    for (const [b, name] of [[btnFilters, 'filters'], [btnCols, 'columns'], [btnSave, 'save']]) {
      b.setAttribute('aria-expanded', String(panel === name));
      b.classList.toggle('is-open', panel === name);
    }
    drawPanel();

    // chips dos filtros ativos
    chips.hidden = !state.filters.length;
    replaceChildren(
      chips,
      ...state.filters.map((f, i) =>
        h('span', { class: 'lt-chip' }, describeFilter(f, cols, ctx), h('button', { class: 'lt-chip__x', type: 'button', 'aria-label': `Remover filtro: ${describeFilter(f, cols, ctx)}`, onclick: () => setState({ filters: state.filters.filter((_, j) => j !== i) }) }, '×')),
      ),
      state.filters.length > 1 ? h('button', { class: 'lt-clear', type: 'button', onclick: () => setState({ filters: [] }) }, 'Limpar filtros') : null
    );

    // tabela
    const visibleCols = state.columns.map((cid) => cols.find((c) => c.id === cid)).filter(Boolean);
    const page = shown.slice(0, limit);
    const allSelected = !!shown.length && shown.every((r) => selected.has(String(rowKey(r))));
    const table = h('table', { class: 'lt-table' }, h('thead', null, header(visibleCols, allSelected, selected.size > 0)));
    const tbody = h('tbody', null, ...page.map((r) => bodyRow(r, visibleCols, ctx)));
    table.append(tbody);
    replaceChildren(wrap, shown.length ? table : h('div', { class: 'empty lt-empty' }, all.length ? 'Nenhum resultado com esta busca e estes filtros.' : emptyText));
    drawBulk(shown);

    // rodapé
    const nounText = shown.length === 1 ? noun[0] : noun[1];
    const extra = summary && shown.length ? summary(shown, ctx) : '';
    countEl.textContent = [`${fmtInt(shown.length)} ${nounText}${shown.length !== all.length ? ` de ${fmtInt(all.length)}` : ''}`, extra].filter(Boolean).join(' · ');
    more.hidden = shown.length <= limit;
    more.textContent = `Mostrar mais (${fmtInt(shown.length - limit)})`;

    if (focus) el.querySelector(`[data-focus="${CSS.escape(focus)}"]:not(:disabled)`)?.focus();
  }

  draw();
  return {
    el,
    redraw: draw,
    /** Estado atual (colunas, ordem, filtros, busca) — útil para testes e para o "Mostrar mais". */
    get state() {
      return state;
    },
    get rows() {
      return shown;
    },
    get selected() {
      return shown.filter((r) => selected.has(String(rowKey(r))));
    },
    /** Troca para a visão `id` (se existir) — usado por atalhos de outras telas. */
    selectView(vid) {
      pickView(vid);
    },
    clearSelection() {
      selected.clear();
      draw();
    },
    destroy() {
      clearTimeout(timer);
    },
  };
}
