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
