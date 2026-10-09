// Funil: barras horizontais proporcionais ao topo. A largura é só reforço
// visual — nome, n e % do topo estão sempre em texto.
import { h, fmtInt } from '../../ui.js';

const fmtPct = (n) => `${Math.round(n)}%`;

export function renderFunnel(stages) {
  if (!stages.length) return h('div', { class: 'empty' }, 'Sem dados de funil neste período.');
  return h(
    'ul',
    { class: 'dashboard-funnel' },
    stages.map((s) => {
      // 0,5 + w/200: mesma opacidade do handoff (topo mais forte, fim mais discreto)
      const w = Math.max(0, Math.min(100, s.pct));
      return h(
        'li',
        { class: 'dashboard-funnel__row', title: `${s.name}: ${fmtInt(s.n)} (${fmtPct(s.pct)} do topo)` },
        h('div', { class: 'dashboard-funnel__head' }, h('span', null, s.name), h('span', { class: 'muted num' }, fmtInt(s.n), h('span', { class: 'dashboard-funnel__pct' }, ` · ${fmtPct(s.pct)}`))),
        h('div', { class: 'dashboard-funnel__track', 'aria-hidden': 'true' }, h('div', { class: 'dashboard-funnel__fill', style: { width: `${Math.max(w, s.n > 0 ? 1.5 : 0)}%`, opacity: String(0.5 + w / 200) } }))
      );
    })
  );
}
