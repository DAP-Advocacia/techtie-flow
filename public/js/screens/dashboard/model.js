// Deriva tudo o que o Dashboard mostra a partir de store.state.dashboard.
// O mock só traz números "cheios" do período de 30 dias + KPIs por período;
// aqui recalculamos barras, funil e equipe de forma proporcional e
// DETERMINÍSTICA (nada de Math.random: trocar de período e voltar dá o mesmo).
import { createMockData } from '../../mock/data.js';
import { fmtBRL, fmtInt } from '../../ui.js';

const NBSP = ' ';

/** Texto de comparação do delta, por período. */
export const COMPARE = {
  today: 'vs. ontem',
  week: 'vs. 7 dias anteriores',
  month: 'vs. período anterior',
};

// Variação leve por etapa/período para o funil não ficar idêntico (mesmos
// percentuais) em todos os filtros. Mês = base do mock, sem ajuste.
const FUNNEL_JITTER = {
  today: [1, 1.05, 0.95, 1.1],
  week: [1, 0.98, 1.03, 0.96],
};
// 1ª resposta humana oscila um pouco entre períodos; a do agente de IA não.
const RESPONSE_FACTOR = { today: 1.07, week: 0.96, month: 1 };

// Conversas "ativas" semeadas no mock: serve de âncora para o KPI acompanhar
// o que acontece na Inbox (resolver uma conversa derruba o número).
let seedActive;
function seedActiveCount() {
  if (seedActive == null) seedActive = countActive(createMockData().conversations);
  return seedActive;
}
const countActive = (convs) => (convs || []).filter((c) => c.status !== 'resolved').length;

const dec1 = (n) => n.toLocaleString('pt-BR', { maximumFractionDigits: 1 });

/** 312000 -> 'R$ 312 mil', 74200 -> 'R$ 74,2 mil', 1,2 mi, abaixo de 1000 sem abreviar. */
export function fmtMoneyShort(n) {
  const v = Number(n) || 0;
  // corte em 999.500: abaixo disso 'Math.round(k)' ainda dá <= 999 mil; acima, viraria '1.000 mil'
  if (v >= 999500) return `R$${NBSP}${dec1(v / 1e6)} mi`;
  if (v >= 1000) {
    const k = v / 1000;
    return `R$${NBSP}${k >= 100 ? Math.round(k).toLocaleString('pt-BR') : dec1(k)} mil`;
  }
  return fmtBRL(v);
}

/** '2m 10s' -> 130 ; '8s' -> 8 ; inválido -> null */
export function parseSecs(str) {
  const m = /^\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?\s*$/.exec(String(str ?? ''));
  if (!m || (m[1] == null && m[2] == null)) return null;
  return Number(m[1] || 0) * 60 + Number(m[2] || 0);
}

/** 130 -> '2m 10s', 182 -> '3m 02s', 8 -> '8s' */
export function fmtSecs(s) {
  if (s == null) return '—';
  const n = Math.round(s);
  if (n < 60) return `${n}s`;
  return `${Math.floor(n / 60)}m ${String(n % 60).padStart(2, '0')}s`;
}

const pad2 = (n) => String(n).padStart(2, '0');
const ddmm = (d) => `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}`;
const daysAgo = (n) => {
  const d = new Date();
  d.setHours(12, 0, 0, 0); // meio-dia: evita virar o dia por causa de horário de verão
  d.setDate(d.getDate() - n);
  return d;
};
const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

function buildBars(key, series) {
  const data = series.length ? series : [];
  if (key === 'today') {
    // hoje: uma barra por hora comercial, a partir da mesma curva do mock
    const items = data.slice(0, 12).map((v, i) => {
      const hour = 8 + i;
      return { label: `${pad2(hour)}h`, full: `Hoje, ${pad2(hour)}h às ${pad2(hour + 1)}h`, value: Math.max(1, Math.round(data[(i + 3) % data.length] * 0.12)) };
    });
    return { hint: 'Conversas por hora', unit: 'conversas', items };
  }
  if (key === 'week') {
    const last = data.slice(-7);
    const items = last.map((v, i) => {
      const ago = last.length - 1 - i;
      const d = daysAgo(ago);
      return { label: ago === 0 ? 'Hoje' : WEEKDAYS[d.getDay()], full: `${ago === 0 ? 'Hoje' : WEEKDAYS[d.getDay()]}, ${ddmm(d)}`, value: v };
    });
    return { hint: 'Conversas por dia', unit: 'conversas', items };
  }
  // 30 dias: cada barra é a média diária de um intervalo de ~2,5 dias
  const n = data.length;
  const items = data.map((v, i) => {
    const startOff = Math.floor((i * 30) / n);
    const endOff = Math.max(startOff, Math.floor(((i + 1) * 30) / n) - 1);
    const a = daysAgo(29 - startOff);
    const b = daysAgo(29 - endOff);
    return { label: ddmm(a), full: startOff === endOff ? ddmm(a) : `${ddmm(a)} a ${ddmm(b)}`, value: v };
  });
  // a unidade carrega o "média/dia" para o tooltip e o aria-label não parecerem total do intervalo
  return { hint: 'Média diária a cada ~2,5 dias', unit: 'conversas/dia (média)', items };
}

function buildFunnel(key, p, base) {
  const stages = base.funnel || [];
  if (!stages.length) return [];
  const top = p.kpis.leads;
  const baseTop = stages[0].n || 1;
  const jitter = FUNNEL_JITTER[key] || [];
  const out = [];
  stages.forEach((s, i) => {
    let n;
    if (i === 0) n = top;
    else if (i === stages.length - 1) n = Math.round((top * p.kpis.conversion) / 100); // etapa final = ganhos = leads × conversão
    else n = Math.min(out[i - 1].n, Math.round(top * (s.n / baseTop) * (jitter[i] ?? 1)));
    out.push({ name: s.name, n });
  });
  // Funil nunca cresce: o mock traz Ganho > Negociação. Mantemos o Ganho (ele fecha com
  // o KPI de conversão) e levantamos as etapas anteriores até ele, de trás pra frente.
  for (let i = out.length - 2; i >= 0; i--) out[i].n = Math.max(out[i].n, out[i + 1].n);
  for (const s of out) s.pct = top ? (s.n / top) * 100 : 0;
  return out;
}

function buildTeam(state, key, p, month) {
  const team = state.dashboard.team || [];
  const leadsRatio = month.kpis.leads ? p.kpis.leads / month.kpis.leads : 1;
  const revRatio = month.kpis.revenue ? p.kpis.revenue / month.kpis.revenue : 1;
  const baseRevenue = team.reduce((a, t) => a + (t.revenue || 0), 0);
  const factor = RESPONSE_FACTOR[key] ?? 1;

  const rows = team.map((t) => {
    const isBot = !!state.users?.find((u) => u.name === t.name)?.isBot || t.name === 'Agente de IA';
    const secs = parseSecs(t.firstResponse);
    return {
      name: t.name,
      isBot,
      conversations: Math.round((t.conversations || 0) * leadsRatio),
      firstResponse: secs == null ? null : isBot ? secs : secs * factor,
      won: Math.round((t.won || 0) * revRatio),
      revenue: baseRevenue ? Math.round(((t.revenue / baseRevenue) * p.kpis.revenue) / 100) * 100 : 0,
    };
  });
  // a soma da coluna Receita tem que fechar com o KPI: o resto do arredondamento vai pra maior linha
  if (rows.length && baseRevenue) {
    const diff = p.kpis.revenue - rows.reduce((a, r) => a + r.revenue, 0);
    const top = rows.reduce((a, r) => (r.revenue > a.revenue ? r : a), rows[0]);
    top.revenue += diff;
  }
  return rows;
}

function buildKpis(state, key, p) {
  const k = p.kpis;
  const d = p.deltas || {};
  const active = Math.max(0, k.active + countActive(state.conversations) - seedActiveCount());
  const mk = (id, label, value, title, delta, unit) => ({ id, label, value, title, delta, unit });
  return [
    mk('leads', 'NOVOS LEADS', fmtInt(k.leads), null, d.leads, '%'),
    mk('active', 'CONVERSAS ATIVAS', fmtInt(active), null, d.active, '%'),
    mk('conversion', 'TAXA DE CONVERSÃO', `${k.conversion.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`, null, d.conversion, ' p.p.'),
    mk('revenue', 'RECEITA GANHA', fmtMoneyShort(k.revenue), fmtBRL(k.revenue), d.revenue, '%'),
  ];
}

/** Descreve o delta: sinal, texto visível ('▲ 12%') e legenda de leitor de tela. */
export function describeDelta(value, unit, compare) {
  const v = Number(value) || 0;
  const sign = Math.sign(v);
  const abs = Math.abs(v).toLocaleString('pt-BR', { maximumFractionDigits: 1 });
  const text = sign === 0 ? `—${NBSP}0${unit}` : `${sign > 0 ? '▲' : '▼'}${NBSP}${abs}${unit}`;
  const aria = sign === 0 ? `sem variação ${compare}` : `${sign > 0 ? 'alta' : 'queda'} de ${abs}${unit === '%' ? '%' : ' pontos percentuais'} ${compare}`;
  return { sign, text, aria };
}

/** Visão completa de um período, ou null se o período não existir. */
export function buildView(state, key) {
  const periods = state.dashboard?.periods || {};
  const p = periods[key];
  if (!p) return null;
  const month = periods.month || p;
  const d = state.dashboard;
  return {
    key,
    label: p.label,
    compare: COMPARE[key] || 'vs. período anterior',
    kpis: buildKpis(state, key, p),
    bars: buildBars(key, d.conversationsPerDay || []),
    funnel: buildFunnel(key, p, d),
    team: buildTeam(state, key, p, month),
  };
}
