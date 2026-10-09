// Gráfico de barras feito à mão (HTML/CSS). Cada barra é um <button> para
// ter foco/tooltip por teclado; só uma é tab stop (roving tabindex) e as
// setas navegam entre elas.
import { h, fmtInt } from '../../ui.js';

/** Escala "bonita": ~4 intervalos com passo redondo e teto >= max. */
export function niceScale(max) {
  if (!(max > 0)) return { ymax: 4, ticks: [0, 1, 2, 3, 4] };
  const raw = max / 4;
  const mag = Math.max(1, Math.pow(10, Math.floor(Math.log10(raw)))); // passo inteiro: contagem de conversas
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).filter(Number.isInteger).find((s) => s >= raw) || 10 * mag;
  const n = Math.ceil(max / step);
  return { ymax: n * step, ticks: Array.from({ length: n + 1 }, (_, i) => i * step) };
}

export function renderBars({ items, unit = 'conversas' }) {
  if (!items.length) return h('div', { class: 'empty' }, 'Sem conversas neste período.');

  const { ymax, ticks } = niceScale(Math.max(...items.map((i) => i.value)));
  const pct = (v) => `${(v / ymax) * 100}%`;

  const axis = h('div', { class: 'dashboard-axis', 'aria-hidden': 'true' }, ticks.map((t) => h('span', { class: 'dashboard-axis__tick num', style: { bottom: pct(t) } }, fmtInt(t))));
  const grid = h('div', { class: 'dashboard-grid', 'aria-hidden': 'true' }, ticks.map((t) => h('span', { class: 'dashboard-grid__line' + (t === 0 ? ' is-base' : ''), style: { bottom: pct(t) } })));

  const last = items.length - 1;
  const cols = items.map((it, i) => {
    const text = `${it.full}: ${fmtInt(it.value)} ${unit}`;
    return h(
      'button',
      { class: 'dashboard-col', type: 'button', tabindex: i === 0 ? '0' : '-1', 'aria-label': text },
      h(
        'span',
        { class: 'dashboard-slot' },
        h('span', { class: 'dashboard-bar', style: { height: pct(it.value), animationDelay: `${i * 18}ms` } }),
        // tooltip só visual (sem title nativo, que duplicaria o balão): o aria-label do botão já carrega a mesma informação
        h('span', { class: 'dashboard-tip' + (i < 2 ? ' is-left' : i > last - 2 ? ' is-right' : ''), style: { bottom: `min(calc(${pct(it.value)} + 8px), calc(var(--plot-h) - 50px))` }, 'aria-hidden': 'true' }, h('span', { class: 'dashboard-tip__label' }, it.full), h('span', { class: 'dashboard-tip__value num' }, `${fmtInt(it.value)} ${unit}`))
      ),
      h('span', { class: 'dashboard-col__label' }, it.label)
    );
  });

  const group = h('div', { class: 'dashboard-cols', role: 'group', 'aria-label': 'Conversas por dia, uma barra por intervalo' }, cols);
  group.addEventListener('keydown', (e) => {
    const idx = cols.indexOf(document.activeElement);
    if (idx < 0) return;
    const next = { ArrowRight: idx + 1, ArrowLeft: idx - 1, Home: 0, End: last }[e.key];
    if (next == null) return;
    e.preventDefault();
    const target = cols[Math.max(0, Math.min(last, next))];
    cols.forEach((c) => c.setAttribute('tabindex', c === target ? '0' : '-1'));
    target.focus();
  });

  return h('div', { class: 'dashboard-chart' }, axis, h('div', { class: 'dashboard-plot' }, grid, group));
}
