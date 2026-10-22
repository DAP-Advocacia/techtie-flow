// Listas em tabela — modelo PURO (sem DOM, sem store): filtros por tipo de coluna, ordenação, busca e visões salvas.
// Testado em Node (test/api/lists-model.test.mjs). As telas (Contatos, Negócios) só descrevem as colunas.
//
// Coluna: { id, label, type: 'text'|'number'|'money'|'date'|'enum'|'bool', get(row, ctx), search?: true,
//           options?(ctx) → [{ value, label }] (enum), align?: 'right', visible?: true,
//           sortValue?(row, ctx) (ordena por outro valor que o filtrado), cell?(row, ctx) (conteúdo da célula),
//           sortable?: false, filter?: false }
// Filtro: { col, op, value?, to? }   Estado: { columns: [ids visíveis], sort: { col, dir } | null, filters: [], q: '' }

export const foldText = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

const EMPTY = { id: 'empty', label: 'está vazio', noValue: true };
const NOT_EMPTY = { id: 'notEmpty', label: 'não está vazio', noValue: true };
const NUM_OPS = [{ id: 'gt', label: 'maior que' }, { id: 'lt', label: 'menor que' }, { id: 'eq', label: 'igual a' }, { id: 'between', label: 'entre', range: true }, EMPTY, NOT_EMPTY];

/** Operadores oferecidos por tipo de coluna (a tela monta o formulário de filtro a partir disto). */
export const OPS = {
  text: [{ id: 'contains', label: 'contém' }, { id: 'notContains', label: 'não contém' }, { id: 'equals', label: 'é igual a' }, EMPTY, NOT_EMPTY],
  number: NUM_OPS,
  money: NUM_OPS,
  date: [
    { id: 'today', label: 'é hoje', noValue: true },
    { id: 'last7', label: 'nos últimos 7 dias', noValue: true },
    { id: 'last30', label: 'nos últimos 30 dias', noValue: true },
    { id: 'thisMonth', label: 'neste mês', noValue: true },
    { id: 'overdue', label: 'já passou', noValue: true },
    { id: 'future', label: 'ainda vai chegar', noValue: true },
    { id: 'before', label: 'antes de', date: true },
    { id: 'after', label: 'depois de', date: true },
    EMPTY,
    NOT_EMPTY,
  ],
  enum: [{ id: 'is', label: 'é' }, { id: 'isNot', label: 'não é' }, EMPTY, NOT_EMPTY],
  bool: [{ id: 'yes', label: 'sim', noValue: true }, { id: 'no', label: 'não', noValue: true }],
};
export const opsOf = (col) => OPS[col.type] || OPS.text;
export const opDef = (col, opId) => opsOf(col).find((o) => o.id === opId);

const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
/** 'YYYY-MM-DD' → ms de 00:00 local (NaN se inválida) */
export function parseDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? ''));
  if (!m) return NaN;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getMonth() === Number(m[2]) - 1 ? d.getTime() : NaN;
}
/** '1.500,50' | '1500.5' | 'R$ 1.200' → número; NaN se não for um número (mesmas regras do campo de valor do negócio). */
export function parseNumber(raw) {
  const s = String(raw ?? '').replace(/R\$|\s| /g, '');
  if (!s) return NaN;
  if (s.includes(',')) return /^-?(\d{1,3}(\.\d{3})+|\d+),\d+$/.test(s) ? Number(s.replace(/\./g, '').replace(',', '.')) : NaN;
  if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) return Number(s.replace(/\./g, ''));
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
}
const isBlank = (v) => v === null || v === undefined || v === '' || (typeof v === 'number' && Number.isNaN(v));
const num = (v) => (isBlank(v) ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/** Uma linha (valor já extraído) casa com o filtro? Filtro incompleto (sem valor) NÃO restringe. */
export function matchFilter(filter, value, col, now = new Date()) {
  const op = filter.op;
  if (op === 'empty') return isBlank(value);
  if (op === 'notEmpty') return !isBlank(value);
  switch (col.type) {
    case 'text': {
      if (isBlank(filter.value)) return true;
      const v = foldText(value);
      const q = foldText(filter.value);
      return op === 'contains' ? v.includes(q) : op === 'notContains' ? !v.includes(q) : op === 'equals' ? v === q : true;
    }
    case 'number':
    case 'money': {
      const v = num(value);
      const a = num(filter.value);
      const b = num(filter.to);
      if (op === 'between') return a === null || b === null ? true : v !== null && v >= Math.min(a, b) && v <= Math.max(a, b);
      if (a === null) return true;
      if (v === null) return false;
      return op === 'gt' ? v > a : op === 'lt' ? v < a : op === 'eq' ? v === a : true;
    }
    case 'date': {
      if (isBlank(value)) return false;
      const t = Number(value);
      const today = dayStart(now);
      const day = dayStart(new Date(t));
      switch (op) {
        case 'today':
          return day === today;
        case 'last7':
          return day >= today - 6 * 86400000 && day <= today;
        case 'last30':
          return day >= today - 29 * 86400000 && day <= today;
        case 'thisMonth':
          return new Date(t).getFullYear() === now.getFullYear() && new Date(t).getMonth() === now.getMonth();
        case 'overdue':
          return day < today;
        case 'future':
          return day > today;
        case 'before': {
          const limit = parseDay(filter.value);
          return Number.isNaN(limit) ? true : day < limit;
        }
        case 'after': {
          const limit = parseDay(filter.value);
          return Number.isNaN(limit) ? true : day > limit;
        }
        default:
          return true;
      }
    }
    case 'enum':
      if (isBlank(filter.value)) return true;
      return op === 'is' ? String(value) === String(filter.value) : op === 'isNot' ? String(value) !== String(filter.value) : true;
    case 'bool':
      return op === 'yes' ? !!value : op === 'no' ? !value : true;
    default:
      return true;
  }
}

const byId = (columns) => new Map(columns.map((c) => [c.id, c]));

/** Aplica todos os filtros (E). Filtro de coluna desconhecida é ignorado. */
export function applyFilters(rows, filters, columns, ctx, now = new Date()) {
  const cols = byId(columns);
  const active = (filters || []).filter((f) => cols.has(f.col));
  if (!active.length) return rows;
  return rows.filter((row) => active.every((f) => matchFilter(f, cols.get(f.col).get(row, ctx), cols.get(f.col), now)));
}

/** Busca livre: todas as palavras precisam aparecer em alguma coluna marcada com `search`. */
export function searchRows(rows, q, columns, ctx) {
  const tokens = foldText(q).split(/\s+/).filter(Boolean);
  if (!tokens.length) return rows;
  const cols = columns.filter((c) => c.search);
  return rows.filter((row) => {
    const hay = foldText(cols.map((c) => c.get(row, ctx)).filter((v) => !isBlank(v)).join(' '));
    return tokens.every((t) => hay.includes(t));
  });
}

/** Ordena (estável); vazios por último nos dois sentidos; texto sem acento e com números naturais. */
export function sortRows(rows, sort, columns, ctx) {
  if (!sort) return rows;
  const col = columns.find((c) => c.id === sort.col);
  if (!col) return rows;
  const dir = sort.dir === 'desc' ? -1 : 1;
  const sortKey = col.sortValue || col.get; // ex.: responsável filtra pelo id, mas ordena pelo nome
  return rows
    .map((row, i) => ({ row, i, v: sortKey(row, ctx) }))
    .sort((a, b) => {
      const ea = isBlank(a.v);
      const eb = isBlank(b.v);
      if (ea || eb) return ea === eb ? a.i - b.i : ea ? 1 : -1;
      const c = typeof a.v === 'number' && typeof b.v === 'number' ? a.v - b.v : String(a.v).localeCompare(String(b.v), 'pt-BR', { numeric: true, sensitivity: 'base' });
      return c * dir || a.i - b.i;
    })
    .map((x) => x.row);
}

/** Linhas depois de busca + filtros + ordenação. */
export function runList(rows, state, columns, ctx, now = new Date()) {
  return sortRows(applyFilters(searchRows(rows, state.q, columns, ctx), state.filters, columns, ctx, now), state.sort, columns, ctx);
}

/** Estado válido para as colunas dadas (descarta colunas que não existem mais; sem colunas = as padrão). */
export function normalizeState(state, columns) {
  const ids = new Set(columns.map((c) => c.id));
  const cols = (state?.columns || []).filter((id) => ids.has(id));
  return {
    columns: cols.length ? cols : columns.filter((c) => c.visible).map((c) => c.id),
    sort: state?.sort && ids.has(state.sort.col) ? { col: state.sort.col, dir: state.sort.dir === 'desc' ? 'desc' : 'asc' } : null,
    filters: (state?.filters || []).filter((f) => f && ids.has(f.col) && f.op),
    q: String(state?.q || ''),
  };
}
export const defaultState = (columns, over = {}) => normalizeState({ columns: [], sort: null, filters: [], q: '', ...over }, columns);

/** Rótulo curto de um filtro ("Valor maior que 1000") para os chips. */
export function describeFilter(filter, columns, ctx) {
  const col = columns.find((c) => c.id === filter.col);
  if (!col) return '';
  const op = opDef(col, filter.op);
  if (!op) return col.label;
  if (op.noValue) return `${col.label} ${op.label}`;
  let v = filter.value;
  if (col.type === 'enum') v = col.options?.(ctx)?.find((o) => String(o.value) === String(filter.value))?.label ?? filter.value;
  if (col.type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(String(v))) v = String(v).split('-').reverse().join('/');
  return op.range ? `${col.label} entre ${filter.value} e ${filter.to}` : `${col.label} ${op.label} ${v}`;
}

// ---------------------------------------------------------------------------------------------
// Visões salvas (por lista, neste navegador)
// ---------------------------------------------------------------------------------------------

/**
 * @param storage  { getItem, setItem }
 * @param entityId 'contacts' | 'deals' …
 * @param builtins [{ id, name, state }] visões de fábrica (não se apagam)
 */
export function makeViewsStore(storage, entityId, builtins = []) {
  const key = `ttf:views:${entityId}`;
  const read = () => {
    try {
      const v = JSON.parse(storage.getItem(key) || '{}');
      return { saved: Array.isArray(v.saved) ? v.saved.filter((x) => x && x.id && x.name && x.state) : [], last: typeof v.last === 'string' ? v.last : null };
    } catch {
      return { saved: [], last: null };
    }
  };
  const write = (data) => {
    try {
      storage.setItem(key, JSON.stringify(data));
    } catch {
      /* sem armazenamento: só não lembra */
    }
  };
  return {
    all: () => [...builtins.map((b) => ({ ...b, builtin: true })), ...read().saved],
    get(id) {
      return this.all().find((v) => v.id === id) || null;
    },
    last: () => read().last,
    setLast(id) {
      write({ ...read(), last: id });
    },
    /** Salva (ou sobrescreve, se já existe uma salva com o mesmo nome) e devolve a visão. */
    save(name, state) {
      const clean = String(name || '').trim().slice(0, 60);
      if (!clean) return null;
      const data = read();
      const existing = data.saved.find((v) => foldText(v.name) === foldText(clean));
      const view = { id: existing?.id || `v_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, name: clean, state: JSON.parse(JSON.stringify(state)) };
      data.saved = existing ? data.saved.map((v) => (v.id === view.id ? view : v)) : [...data.saved, view].slice(-30);
      data.last = view.id;
      write(data);
      return view;
    },
    remove(id) {
      const data = read();
      if (!data.saved.some((v) => v.id === id)) return false; // visão de fábrica não se apaga
      data.saved = data.saved.filter((v) => v.id !== id);
      if (data.last === id) data.last = null;
      write(data);
      return true;
    },
  };
}
