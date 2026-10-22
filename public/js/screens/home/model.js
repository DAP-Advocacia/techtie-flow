// Modelo PURO da tela Início (sem DOM, sem store): recebe listas JÁ filtradas pelo motor de permissões e devolve
// os números do resumo. Testado em Node (test/api/home-model.test.mjs).

/** "Bom dia" / "Boa tarde" / "Boa noite" para a hora local. */
export function greeting(date = new Date()) {
  const h = date.getHours();
  return h < 5 ? 'Boa noite' : h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
}

/**
 * Resumo do dia.
 * @param conversations conversas visíveis ({ unread, status, assigneeId })
 * @param deals negócios visíveis ({ stageId, value })
 * @param stageKind (stageId) => 'open' | 'won' | 'lost' | undefined
 * @param valueHidden o perfil não vê o valor dos negócios? (então o total vira null, nunca 0)
 */
export function summarizeHome({ conversations = [], deals = [], stageKind = () => 'open', meId = null, valueHidden = false }) {
  const live = conversations.filter((c) => c.status !== 'resolved');
  const open = deals.filter((d) => !['won', 'lost'].includes(stageKind(d.stageId)));
  return {
    unread: conversations.reduce((n, c) => n + (Number(c.unread) || 0), 0),
    queue: conversations.filter((c) => c.status === 'queue').length,
    mine: live.filter((c) => meId && c.assigneeId === meId).length,
    openDeals: open.length,
    openValue: valueHidden ? null : open.reduce((n, d) => n + (Number(d.value) || 0), 0),
  };
}

/** Conversas para responder agora: com mensagens não lidas, a mais recente primeiro. */
export function replyNow(conversations = [], limit = 5) {
  return conversations
    .filter((c) => (Number(c.unread) || 0) > 0 && c.status !== 'resolved')
    .sort((a, b) => (b.lastMessageAt || b.lastAt || 0) - (a.lastMessageAt || a.lastAt || 0))
    .slice(0, limit);
}

// ---------------------------------------------------------------------------------------------
// Fechando este mês e meta de receita (negócios já filtrados pelo motor; o chamador decide se o perfil vê valores)
// ---------------------------------------------------------------------------------------------

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const monthRange = (now) => [new Date(now.getFullYear(), now.getMonth(), 1).getTime(), new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime()];
const money = (n) => Number(n) || 0;

/** 'YYYY-MM-DD' → ms de 00:00 local; NaN se não for uma data real. */
function parseDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? ''));
  if (!m) return NaN;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getMonth() === Number(m[2]) - 1 ? d.getTime() : NaN;
}

/**
 * Negócios EM ABERTO com previsão de fechamento no mês corrente, do mais próximo ao mais distante.
 * `late` marca a previsão que já passou (e o negócio segue aberto); `overdueBefore` conta os de meses anteriores.
 * @returns {{ rows: {deal, at, late}[], count, late, overdueBefore, total: number|null }}
 */
export function closingThisMonth({ deals = [], stageKind = () => 'open', now = new Date(), valueHidden = false }) {
  const [from, to] = monthRange(now);
  const today = startOfDay(now);
  const rows = [];
  let overdueBefore = 0;
  for (const d of deals) {
    if (['won', 'lost'].includes(stageKind(d.stageId))) continue;
    const at = parseDay(d.expectedClose);
    if (Number.isNaN(at)) continue;
    if (at < from) overdueBefore++;
    else if (at < to) rows.push({ deal: d, at, late: at < today });
  }
  rows.sort((a, b) => a.at - b.at || money(b.deal.value) - money(a.deal.value));
  return { rows, count: rows.length, late: rows.filter((r) => r.late).length, overdueBefore, total: valueHidden ? null : rows.reduce((n, r) => n + money(r.deal.value), 0) };
}

/**
 * Meta de receita do mês: soma dos negócios GANHOS neste mês (movidos para uma etapa de ganho entre o dia 1 e hoje).
 * `onTrack` compara com o ritmo linear da meta (dia do mês / dias do mês). Valor oculto no perfil → null (nada de 0 enganoso).
 * @returns {null | { goal: number|null, won, pct: number|null, remaining: number|null, daysLeft, onTrack: boolean|null }}
 */
export function monthGoal({ deals = [], stageKind = () => 'open', goal = null, now = new Date(), valueHidden = false }) {
  if (valueHidden) return null;
  const [from, to] = monthRange(now);
  const won = deals.filter((d) => stageKind(d.stageId) === 'won' && Number(d.stageChangedAt) >= from && Number(d.stageChangedAt) < to).reduce((n, d) => n + money(d.value), 0);
  const inMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysLeft = inMonth - now.getDate();
  const g = Number(goal);
  if (!(g > 0)) return { goal: null, won, pct: null, remaining: null, daysLeft, onTrack: null };
  return { goal: g, won, pct: won / g, remaining: Math.max(0, g - won), daysLeft, onTrack: won >= (g * now.getDate()) / inMonth };
}
