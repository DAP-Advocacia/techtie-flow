// Tabela semântica de desempenho com ordenação clicável por coluna.
import { h, fmtInt, fmtBRL } from '../../ui.js';
import { fmtMoneyShort, fmtSecs } from './model.js';
import { HIDDEN } from './access.js';

// dir = sentido da 1ª ordenação: nome A→Z, números do maior pro menor,
// 1ª resposta do menor (melhor) pro maior.
const COLS = [
  { key: 'name', label: 'ATENDENTE', dir: 'asc', get: (r) => r.name.toLocaleLowerCase('pt-BR') },
  { key: 'conversations', label: 'CONVERSAS', dir: 'desc', get: (r) => r.conversations },
  { key: 'firstResponse', label: '1ª RESPOSTA', dir: 'asc', get: (r) => r.firstResponse },
  { key: 'won', label: 'GANHOS', dir: 'desc', get: (r) => r.won },
  { key: 'revenue', label: 'RECEITA', dir: 'desc', get: (r) => r.revenue },
];

export const defaultDir = (key) => COLS.find((c) => c.key === key)?.dir || 'desc';

function sortRows(rows, sort) {
  if (!sort) return rows;
  const col = COLS.find((c) => c.key === sort.key);
  if (!col) return rows;
  const sign = sort.dir === 'asc' ? 1 : -1;
  // valores ausentes (null) vão sempre pro fim, qualquer que seja o sentido
  return [...rows].sort((a, b) => {
    const x = col.get(a);
    const y = col.get(b);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return (typeof x === 'string' ? x.localeCompare(y, 'pt-BR') : x - y) * sign;
  });
}

/** opts.revenueHidden: campo deal.value oculto — coluna mascarada e sem ordenação (não pode virar oráculo). */
export function renderTeam(rows, sort, onSort, { revenueHidden = false, emptyText = 'Sem atendentes neste período.' } = {}) {
  if (!rows.length) return h('div', { class: 'empty' }, emptyText);

  const head = h(
    'tr',
    null,
    COLS.map((c) => {
      const locked = revenueHidden && c.key === 'revenue';
      const active = !locked && sort?.key === c.key;
      const ariaSort = active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
      return h(
        'th',
        { scope: 'col', 'aria-sort': ariaSort },
        h('button', { class: 'dashboard-sort' + (active ? ' is-active' : ''), type: 'button', dataset: { key: c.key }, disabled: locked, onclick: () => !locked && onSort(c.key), title: locked ? 'Seu perfil não permite ver os valores dos negócios.' : `Ordenar por ${c.label.toLowerCase()}` }, c.label, h('span', { class: 'dashboard-sort__arrow', 'aria-hidden': 'true' }, active ? (sort.dir === 'asc' ? '▲' : '▼') : '⇅'))
      );
    })
  );

  const body = sortRows(rows, revenueHidden && sort?.key === 'revenue' ? null : sort).map((r) =>
    h(
      'tr',
      { class: r.isBot ? 'dashboard-team__ai' : null },
      h('th', { scope: 'row' }, h('span', { class: 'dashboard-team__name' }, r.isBot ? h('span', { class: 'dashboard-ai-dot', 'aria-hidden': 'true' }) : null, r.name, r.isBot ? h('span', { class: 'dashboard-ai-tag' }, 'IA') : null)),
      h('td', { class: 'num' }, fmtInt(r.conversations)),
      h('td', { class: 'num' }, fmtSecs(r.firstResponse)),
      h('td', { class: 'num' }, fmtInt(r.won)),
      r.revenue == null
        ? h('td', { class: 'num dashboard-team__rev', 'aria-label': 'valor oculto pelo seu perfil' }, HIDDEN)
        : h('td', { class: 'num dashboard-team__rev', title: fmtBRL(r.revenue) }, fmtMoneyShort(r.revenue))
    )
  );

  return h('div', { class: 'dashboard-tablewrap' }, h('table', { class: 'dashboard-team' }, h('thead', null, head), h('tbody', null, body)));
}
