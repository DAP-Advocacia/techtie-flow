'use strict';
// Dashboard com números REAIS, calculados no banco para os três períodos (hoje, 7 dias, 30 dias).
//  - Quem enxerga a tela: `report.read` (o motor). Os números respeitam o que a pessoa já pode ler:
//    conversas e negócios entram pelo MESMO filtro do motor (+ RLS), então um Gestor de equipe vê a equipe.
//  - Definições (honestas, sem inventar dado):
//      Novos leads      = conversas cujo PRIMEIRO contato do cliente caiu no período
//      Conversas ativas = conversas não resolvidas agora (foto do momento; sem comparação)
//      Conversão        = ganhos ÷ (ganhos + perdidos) no período
//      Receita ganha    = soma do valor dos negócios ganhos no período
//      Funil            = negócios criados no período, por etapa em que estão (cumulativo, sem perdidos)
//      1ª resposta      = tempo entre a 1ª mensagem do cliente e a 1ª resposta, por quem respondeu
//  - Dia = fuso America/Sao_Paulo.

const TZ = 'America/Sao_Paulo';
const DAY = 24 * 3600 * 1000;
const PERIODS = {
  today: { label: 'Hoje' },
  week: { label: '7 dias' },
  month: { label: '30 dias' },
};
const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const pad2 = (n) => String(n).padStart(2, '0');
const ddmm = (d) => `${pad2(d.getUTCDate())}/${pad2(d.getUTCMonth() + 1)}`;
const pct = (cur, prev) => (prev ? ((cur - prev) / prev) * 100 : cur ? 100 : 0);
const round1 = (n) => Math.round(n * 10) / 10;

module.exports = function registerDashboard({ route, must, tx, pool, listWhere, canAccess, ttlMs = 30_000 }) {
  const cache = new Map(); // `${tenant}:${user}` -> { at, data }  (30 s: o painel abre muito e a conta é pesada)

  route('GET', '/api/dashboard', async ({ access }) => {
    must(access, 'report', 'read', { tenantId: access.tenantId });
    const key = `${access.tenantId}:${access.userId}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.data;
    const data = await tx(pool, access, (c) => compute(c, access), { readOnly: true });
    cache.set(key, { at: Date.now(), data });
    return data;
  });

  async function compute(c, access) {
    const nowRow = (await c.query("SELECT now() AS now, (date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1) AS today_start", [TZ])).rows[0];
    const now = nowRow.now.getTime();
    const todayStart = nowRow.today_start.getTime();
    const win = {
      today: { from: todayStart, to: now, pFrom: todayStart - DAY, pTo: now - DAY },
      week: { from: now - 7 * DAY, to: now, pFrom: now - 14 * DAY, pTo: now - 7 * DAY },
      month: { from: now - 30 * DAY, to: now, pFrom: now - 60 * DAY, pTo: now - 30 * DAY },
    };
    const canConv = canAccess(access, 'conversation', 'read');
    const canDeal = canAccess(access, 'deal', 'read');
    const cw = canConv ? listWhere(access, 'conversation', 'read', 't') : { sql: 'FALSE', params: [] };
    const dw = canDeal ? listWhere(access, 'deal', 'read', 'd') : { sql: 'FALSE', params: [] };
    const iso = (ms) => new Date(ms).toISOString();

    // `sql` do motor usa $1..$n; as nossas datas entram DEPOIS dos parâmetros dele
    const withConv = (sql, params) => c.query(sql.replace(/\$C(\d)/g, (_, i) => `$${cw.params.length + Number(i)}`).replace('{CONV}', cw.sql), [...cw.params, ...params]);
    const withDeal = (sql, params) => c.query(sql.replace(/\$D(\d)/g, (_, i) => `$${dw.params.length + Number(i)}`).replace('{DEAL}', dw.sql), [...dw.params, ...params]);

    const leadsIn = async (from, to) =>
      (await withConv(
        `SELECT count(*)::int n FROM (SELECT m.conversation_id, min(m.created_at) first_at FROM messages m JOIN conversations t ON t.id = m.conversation_id WHERE m.direction = 'in' AND ({CONV}) GROUP BY m.conversation_id) f WHERE f.first_at >= $C1 AND f.first_at < $C2`,
        [iso(from), iso(to)]
      )).rows[0].n;
    const closedIn = async (from, to) => {
      const r = (await withDeal(
        `SELECT count(*) FILTER (WHERE d.status = 'won')::int won, count(*) FILTER (WHERE d.status = 'lost')::int lost, COALESCE(sum(d.value) FILTER (WHERE d.status = 'won'), 0)::float revenue
           FROM deals d WHERE d.status IN ('won', 'lost') AND COALESCE(d.stage_changed_at, d.created_at) >= $D1 AND COALESCE(d.stage_changed_at, d.created_at) < $D2 AND ({DEAL})`,
        [iso(from), iso(to)]
      )).rows[0];
      return { ...r, conversion: r.won + r.lost ? (r.won / (r.won + r.lost)) * 100 : 0 };
    };

    const active = canConv ? (await withConv("SELECT count(*)::int n FROM conversations t WHERE t.status <> 'resolved' AND ({CONV})", [])).rows[0].n : 0;

    // conversas distintas com mensagem do cliente, por hora (hoje) e por dia (30 dias), no fuso local
    const byBucket = async (from, unit) =>
      Object.fromEntries(
        (await withConv(
          `SELECT to_char(date_trunc('${unit}', m.created_at AT TIME ZONE '${TZ}'), 'YYYY-MM-DD HH24') AS b, count(DISTINCT m.conversation_id)::int n
             FROM messages m JOIN conversations t ON t.id = m.conversation_id WHERE m.direction = 'in' AND m.created_at >= $C1 AND ({CONV}) GROUP BY 1`,
          [iso(from)]
        )).rows.map((r) => [r.b, r.n])
      );
    const hours = canConv ? await byBucket(todayStart, 'hour') : {};
    const days = canConv ? await byBucket(now - 30 * DAY, 'day') : {};
    const localNow = new Date(now - 3 * 3600 * 1000); // só para rotular (Brasil = UTC-3, sem horário de verão desde 2019)
    const dayKey = (agoDays) => {
      const d = new Date(localNow.getTime() - agoDays * DAY);
      return { key: `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} 00`, d };
    };

    const barsFor = (key) => {
      if (key === 'today') {
        const y = `${localNow.getUTCFullYear()}-${pad2(localNow.getUTCMonth() + 1)}-${pad2(localNow.getUTCDate())}`;
        const items = [];
        for (let h = 8; h < 20; h++) items.push({ label: `${pad2(h)}h`, full: `Hoje, ${pad2(h)}h às ${pad2(h + 1)}h`, value: hours[`${y} ${pad2(h)}`] || 0 });
        return { hint: 'Conversas por hora', unit: 'conversas', items };
      }
      if (key === 'week') {
        const items = [];
        for (let ago = 6; ago >= 0; ago--) {
          const { key: k, d } = dayKey(ago);
          const name = ago === 0 ? 'Hoje' : WEEKDAYS[d.getUTCDay()];
          items.push({ label: name, full: `${name}, ${ddmm(d)}`, value: days[k] || 0 });
        }
        return { hint: 'Conversas por dia', unit: 'conversas', items };
      }
      const items = [];
      for (let g = 9; g >= 0; g--) {
        let total = 0;
        const first = dayKey(g * 3 + 2).d;
        const last = dayKey(g * 3).d;
        for (let k = 0; k < 3; k++) total += days[dayKey(g * 3 + k).key] || 0;
        items.push({ label: ddmm(first), full: `${ddmm(first)} a ${ddmm(last)}`, value: total });
      }
      return { hint: 'Conversas a cada 3 dias', unit: 'conversas', items };
    };

    // funil: no pipeline com mais negócios visíveis
    const topPipeline = canDeal ? (await withDeal('SELECT d.pipeline_id AS id, count(*)::int n FROM deals d WHERE d.pipeline_id IS NOT NULL AND ({DEAL}) GROUP BY 1 ORDER BY 2 DESC LIMIT 1', [])).rows[0] : null;
    const funnelFor = async (from, to) => {
      if (!topPipeline) return [];
      const rows = (await withDeal(
        `SELECT s.name, s.kind, count(d.id)::int n FROM pipeline_stages s
           LEFT JOIN deals d ON d.stage_id = s.id AND d.created_at >= $D1 AND d.created_at < $D2 AND ({DEAL})
          WHERE s.pipeline_id = $D3 AND s.kind <> 'lost' GROUP BY s.id, s.name, s.kind, s.position ORDER BY s.position`,
        [iso(from), iso(to), topPipeline.id]
      )).rows;
      // cumulativo: quem chegou à etapa N também passou pelas anteriores
      const out = rows.map((r) => ({ name: r.name, n: r.n }));
      for (let i = out.length - 2; i >= 0; i--) out[i].n += out[i + 1].n;
      const top = out[0]?.n || 0;
      return out.map((s) => ({ ...s, pct: top ? (s.n / top) * 100 : 0 }));
    };

    // desempenho por pessoa
    const teamFor = async (from, to) => {
      const users = (await c.query("SELECT id, name FROM users WHERE status = 'active' ORDER BY name")).rows;
      const first = canConv
        ? (await withConv(
            `WITH fi AS (SELECT m.conversation_id, min(m.created_at) fi FROM messages m WHERE m.direction = 'in' GROUP BY m.conversation_id),
                  fo AS (SELECT DISTINCT ON (m.conversation_id) m.conversation_id, m.created_at fo, m.author_id, m.by_ai
                           FROM messages m JOIN fi ON fi.conversation_id = m.conversation_id AND m.created_at > fi.fi
                          WHERE m.direction = 'out' AND m.kind = 'text' AND (m.author_id IS NOT NULL OR m.by_ai)
                          ORDER BY m.conversation_id, m.created_at)
             SELECT fo.author_id, fo.by_ai, count(*)::int n, avg(extract(epoch FROM (fo.fo - fi.fi)))::float secs
               FROM fi JOIN fo USING (conversation_id) JOIN conversations t ON t.id = fi.conversation_id
              WHERE fi.fi >= $C1 AND fi.fi < $C2 AND ({CONV}) GROUP BY 1, 2`,
            [iso(from), iso(to)]
          )).rows
        : [];
      const won = canDeal
        ? (await withDeal(
            `SELECT d.owner_id, count(*)::int won, COALESCE(sum(d.value), 0)::float revenue FROM deals d
              WHERE d.status = 'won' AND COALESCE(d.stage_changed_at, d.created_at) >= $D1 AND COALESCE(d.stage_changed_at, d.created_at) < $D2 AND ({DEAL}) GROUP BY d.owner_id`,
            [iso(from), iso(to)]
          )).rows
        : [];
      const rows = users
        .map((u) => {
          const f = first.find((x) => x.author_id === u.id && !x.by_ai);
          const w = won.find((x) => x.owner_id === u.id);
          return { name: u.name, isBot: false, conversations: f?.n || 0, firstResponse: f ? Math.round(f.secs) : null, won: w?.won || 0, revenue: w?.revenue || 0 };
        })
        .filter((r) => r.conversations || r.won);
      const ai = first.find((x) => x.by_ai);
      if (ai) rows.push({ name: 'Agente de IA', isBot: true, conversations: ai.n, firstResponse: Math.round(ai.secs), won: 0, revenue: 0 });
      return rows.sort((a, b) => b.revenue - a.revenue || b.conversations - a.conversations);
    };

    const periods = {};
    for (const [key, w] of Object.entries(win)) {
      const [leads, prevLeads, closed, prevClosed, funnel, team] = [
        canConv ? await leadsIn(w.from, w.to) : 0,
        canConv ? await leadsIn(w.pFrom, w.pTo) : 0,
        canDeal ? await closedIn(w.from, w.to) : { won: 0, lost: 0, revenue: 0, conversion: 0 },
        canDeal ? await closedIn(w.pFrom, w.pTo) : { won: 0, lost: 0, revenue: 0, conversion: 0 },
        await funnelFor(w.from, w.to),
        await teamFor(w.from, w.to),
      ];
      periods[key] = {
        key,
        label: PERIODS[key].label,
        kpis: { leads, active, conversion: round1(closed.conversion), revenue: closed.revenue },
        deltas: { leads: round1(pct(leads, prevLeads)), active: 0, conversion: round1(closed.conversion - prevClosed.conversion), revenue: round1(pct(closed.revenue, prevClosed.revenue)) },
        bars: barsFor(key),
        funnel,
        team,
      };
    }
    return { generatedAt: new Date(now).toISOString(), periods };
  }
};
