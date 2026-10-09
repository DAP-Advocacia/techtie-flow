// Aplica o motor de permissões sobre a visão do Dashboard (já calculada por model.js).
// Os KPIs, o gráfico e o funil são do TENANT (quem tem report.read vê o agregado da empresa).
// Duas coisas são recortadas por pessoa/campo:
//   1. Linhas da tabela de desempenho: só aparecem pessoas cujos negócios o usuário poderia
//      ver (decide deal.read com ownerId/teamId da pessoa) + a própria linha do usuário;
//      a linha do "Agente de IA" aparece para quem lê as conversas dele (decide conversation.read).
//   2. Receita/valores: respeitam o campo deal.value (oculto → "•••").
import { decide, fieldLevel } from '../../access.js';

export const HIDDEN = '•••';

/** Pessoa da linha → usuário do store (por nome, como o model.js já faz). */
const userOfRow = (state, row) => state.users.find((u) => u.name === row.name) || null;

export function revenueHidden() {
  return fieldLevel('deal', 'value') === 'hidden';
}

/** Linhas que o usuário atual pode ver. Devolve { rows, restricted }. */
export function scopeTeamRows(state, rows) {
  const me = state.users.find((u) => u.id === state.currentUserId);
  const kept = rows.filter((r) => {
    const u = userOfRow(state, r);
    if (u && u.id === state.currentUserId) return true; // a própria linha sempre
    if (r.isBot) {
      // o agente de IA atende conversas: só vê quem pode ler as conversas dele
      return decide('conversation', 'read', { assigneeId: u?.id ?? null, teamId: null, instanceId: state.agent?.instanceId ?? null }).effect === 'allow';
    }
    return decide('deal', 'read', { ownerId: u?.id ?? null, teamId: u?.teamIds?.[0] ?? null }).effect === 'allow';
  });
  return { rows: kept, restricted: kept.length < rows.length, me };
}

/** Cópia da visão com permissões aplicadas. */
export function applyAccess(state, view) {
  if (!view) return view;
  const hidden = revenueHidden();
  const { rows, restricted } = scopeTeamRows(state, view.team);
  return {
    ...view,
    revenueHidden: hidden,
    teamRestricted: restricted,
    kpis: view.kpis.map((k) => (k.id === 'revenue' && hidden ? { ...k, value: HIDDEN, title: null, delta: 0, noDelta: true } : k)),
    // linha sem valores monetários quando o campo está oculto (nada vaza para o DOM nem para a ordenação)
    team: rows.map((r) => (hidden ? { ...r, revenue: null } : r)),
  };
}
