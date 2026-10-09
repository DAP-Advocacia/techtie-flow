// Tela Dashboard: filtro de período + 4 KPIs + conversas por dia + funil +
// desempenho da equipe. Dados derivados em dashboard/model.js.
import { h, replaceChildren } from '../ui.js';
import { buildView, describeDelta } from './dashboard/model.js';
import { renderBars } from './dashboard/bars.js';
import { renderFunnel } from './dashboard/funnel.js';
import { renderTeam, defaultDir } from './dashboard/team.js';
import { applyAccess } from './dashboard/access.js';

const LOAD_MS = 300; // loading simulado ao trocar o período

const skel = (cls) => h('span', { class: `dashboard-skel ${cls}`, 'aria-hidden': 'true' });

function kpiCard(k, compare) {
  // noDelta: valor oculto pelo perfil — a variação também revelaria o número, então some junto
  const d = k.value != null && !k.noDelta ? describeDelta(k.delta, k.unit, compare) : null;
  return h(
    'div',
    { class: 'kpi' },
    h(
      'div',
      { class: 'kpi__body dashboard-kpi' },
      h('span', { class: 'dashboard-kpi__label' }, k.label),
      k.value == null ? skel('dashboard-skel--value') : h('span', { class: 'dashboard-kpi__value num', title: k.title || null }, k.value),
      k.noDelta
        ? h('span', { class: 'dashboard-kpi__delta' }, h('span', { class: 'dashboard-kpi__cmp' }, 'oculto pelo seu perfil'))
        : d
        ? // aria-label em <span> sem role é ignorado por leitores de tela: o texto
        // completo vai em um trecho só para leitores e o visual fica aria-hidden
        h('span', { class: 'dashboard-kpi__delta' }, h('span', { class: 'dashboard-sr' }, d.aria), h('span', { 'aria-hidden': 'true' }, h('span', { class: d.sign > 0 ? 'is-up' : d.sign < 0 ? 'is-down' : 'is-flat' }, d.text), h('span', { class: 'dashboard-kpi__cmp' }, ` ${compare}`)))
        : skel('dashboard-skel--delta')
    )
  );
}

const KPI_LABELS = ['NOVOS LEADS', 'CONVERSAS ATIVAS', 'TAXA DE CONVERSÃO', 'RECEITA GANHA'];

function card(title, hint, ...content) {
  return h('section', { class: 'card dashboard-card' }, h('div', { class: 'dashboard-card__head' }, h('h2', { class: 'label' }, title), hint ? h('span', { class: 'dashboard-card__hint' }, hint) : null), ...content);
}

export default {
  mount(el, { store }) {
    const periods = () => store.state.dashboard?.periods || {};
    let periodKey = periods().month ? 'month' : Object.keys(periods())[0];
    let sort = null; // { key, dir } ou null = ordem original
    let timer = null;
    let loading = false;

    const kpisHost = h('div', { class: 'dashboard-kpis' });
    const chartsHost = h('div', { class: 'dashboard-row' });
    const teamHost = h('div', { class: 'dashboard-teamhost' });
    const live = h('div', { class: 'dashboard-sr', role: 'status', 'aria-live': 'polite' });

    // ---- filtro de período (radiogroup com roving tabindex) ----
    const pills = h('div', { class: 'pills', role: 'radiogroup', 'aria-label': 'Período' });
    const pillBtns = Object.entries(periods()).map(([key, p]) =>
      h('button', { class: 'pill', type: 'button', role: 'radio', dataset: { key }, onclick: () => setPeriod(key) }, p.label)
    );
    pills.append(...pillBtns);
    pills.addEventListener('keydown', (e) => {
      const i = pillBtns.indexOf(document.activeElement);
      const next = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1 }[e.key];
      if (i < 0 || next == null) return;
      e.preventDefault();
      const b = pillBtns[(next + pillBtns.length) % pillBtns.length];
      b.focus();
      setPeriod(b.dataset.key);
    });
    function syncPills() {
      for (const b of pillBtns) {
        const on = b.dataset.key === periodKey;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-checked', String(on));
        b.tabIndex = on ? 0 : -1;
      }
    }

    // ---- desenho ----
    // Permissões (motor) aplicadas sobre a visão: linhas da equipe no escopo do usuário e receita por campo.
    const view = () => applyAccess(store.state, buildView(store.state, periodKey));

    function drawKpis(v) {
      replaceChildren(kpisHost, v ? v.kpis.map((k) => kpiCard(k, v.compare)) : KPI_LABELS.map((label) => kpiCard({ label, value: null }, '')));
      kpisHost.setAttribute('aria-busy', String(!v));
    }

    function drawCharts(v) {
      const barsSkeleton = h('div', { class: 'dashboard-chart is-loading', 'aria-hidden': 'true' }, h('div', { class: 'dashboard-skelbars' }, [40, 62, 55, 78, 70, 90, 48, 66, 84, 72, 95, 60].map((p) => h('span', { class: 'dashboard-skel', style: { height: `${p}%` } }))));
      const funnelSkeleton = h('ul', { class: 'dashboard-funnel', 'aria-hidden': 'true' }, Array.from({ length: 5 }, () => h('li', { class: 'dashboard-funnel__row' }, skel('dashboard-skel--line'), h('div', { class: 'dashboard-funnel__track' }))));
      replaceChildren(
        chartsHost,
        card('CONVERSAS POR DIA', v?.bars.hint, v ? renderBars(v.bars) : barsSkeleton),
        card('FUNIL', v ? `Base: ${v.label.toLowerCase()}` : '', v ? renderFunnel(v.funnel) : funnelSkeleton)
      );
      chartsHost.setAttribute('aria-busy', String(!v));
    }

    function drawTeam(v, refocusKey) {
      const tableSkeleton = h('div', { class: 'dashboard-tableskel', 'aria-hidden': 'true' }, [skel('dashboard-skel--thead'), ...Array.from({ length: 3 }, () => skel('dashboard-skel--row'))]);
      if (v?.revenueHidden && sort?.key === 'revenue') sort = null;
      replaceChildren(teamHost, card('DESEMPENHO DA EQUIPE', v?.teamRestricted ? 'Exibindo só as pessoas do seu escopo' : '', v ? renderTeam(v.team, sort, onSort, { revenueHidden: v.revenueHidden, emptyText: v.teamRestricted ? 'Nenhuma pessoa no seu escopo neste período.' : undefined }) : tableSkeleton));
      teamHost.setAttribute('aria-busy', String(!v));
      // o redesenho troca o <button>: devolve o foco para quem acabou de ordenar
      if (refocusKey) teamHost.querySelector(`.dashboard-sort[data-key="${refocusKey}"]`)?.focus();
    }

    function onSort(key) {
      sort = sort?.key === key ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: defaultDir(key) };
      drawTeam(view(), key);
    }

    // Sem dados de dashboard (ou período inexistente) e sem loading: mostra vazio em
    // vez de ficar eternamente no skeleton.
    function drawEmpty() {
      replaceChildren(kpisHost);
      replaceChildren(chartsHost, card('DASHBOARD', '', h('div', { class: 'empty' }, 'Sem dados de dashboard.')));
      replaceChildren(teamHost);
      for (const host of [kpisHost, chartsHost, teamHost]) host.setAttribute('aria-busy', 'false');
    }

    function drawAll() {
      const v = loading ? null : view();
      if (!loading && !v) return drawEmpty();
      drawKpis(v);
      drawCharts(v);
      drawTeam(v);
    }

    function setPeriod(key) {
      if (key === periodKey && !loading) return;
      periodKey = key;
      syncPills();
      loading = true;
      drawAll();
      clearTimeout(timer);
      timer = setTimeout(() => {
        loading = false;
        drawAll();
        live.textContent = `Dashboard atualizado: ${periods()[key]?.label || ''}`;
      }, LOAD_MS);
    }

    // ---- estrutura ----
    replaceChildren(
      el,
      h(
        'div',
        { class: 'page dashboard' },
        h('header', { class: 'page-header' }, h('div', { class: 'grow' }, h('div', { class: 'eyebrow' }, 'VISÃO GERAL'), h('h1', { class: 'page-title' }, 'DASHBOARD')), pills),
        kpisHost,
        chartsHost,
        teamHost,
        live
      )
    );
    syncPills();
    drawAll();

    // Só os KPIs reagem ao store (ex.: conversa resolvida na Inbox muda
    // "Conversas ativas"). Gráficos não redesenham para não perder foco/tooltip
    // nem repetir a animação a cada troca de tema.
    const unsub = store.subscribe(() => {
      if (loading) return;
      const v = view();
      if (v) drawKpis(v);
      else drawAll();
    });

    return () => {
      unsub();
      clearTimeout(timer);
    };
  },
};
