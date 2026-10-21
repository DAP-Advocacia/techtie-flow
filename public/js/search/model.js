// Busca global — modelo PURO (sem DOM, sem store). Recebe listas JÁ filtradas pelo motor de permissões e devolve
// resultados agrupados e ordenados. Testado em Node (test/api/search-model.test.mjs).

/** minúscula e sem acento */
export const fold = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
const digitsOf = (s) => String(s ?? '').replace(/\D/g, '');

export const GROUPS = [
  { type: 'command', label: 'Ir para e criar' },
  { type: 'deal', label: 'Negócios' },
  { type: 'contact', label: 'Contatos' },
  { type: 'conversation', label: 'Conversas' },
  { type: 'task', label: 'Tarefas' },
];

/** Pontuação de UM campo para UMA palavra da busca: igual > começa > palavra começa > contém. */
function fieldScore(token, field) {
  if (!field) return 0;
  const t = fold(field);
  if (t === token) return 100;
  if (t.startsWith(token)) return 85;
  if (t.split(/[^a-z0-9]+/).some((w) => w.startsWith(token))) return 70;
  if (t.includes(token)) return 45;
  return 0;
}

/**
 * Todas as palavras da busca precisam casar (em algum campo). O 1º campo (título) pesa mais.
 * Número com 3+ dígitos casa com o telefone (qualquer formatação).
 */
export function scoreEntry(entry, tokens) {
  let total = 0;
  for (const token of tokens) {
    let best = 0;
    entry.fields.forEach((f, i) => {
      const sc = fieldScore(token, f) * (i === 0 ? 1.15 : 1);
      if (sc > best) best = sc;
    });
    const d = digitsOf(token);
    if (!best && d.length >= 3 && entry.digits && entry.digits.includes(d)) best = 60;
    if (!best) return 0;
    total += best;
  }
  return total / tokens.length + (entry.boost || 0);
}

/** Resultados agrupados (na ordem de GROUPS), no máximo `limit` por grupo. Busca vazia = nada. */
export function searchEntries(entries, query, { limit = 5 } = {}) {
  const q = fold(query);
  // só números e símbolos ("(21) 98888-7777"): é um telefone, não várias palavras
  const tokens = !/[a-z]/.test(q) && digitsOf(q).length >= 3 ? [digitsOf(q)] : q.split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const scored = entries.map((e) => ({ e, score: scoreEntry(e, tokens) })).filter((x) => x.score > 0);
  return GROUPS.map((g) => ({
    ...g,
    items: scored
      .filter((x) => x.e.type === g.type)
      .sort((a, b) => b.score - a.score || String(a.e.title).localeCompare(String(b.e.title), 'pt-BR'))
      .slice(0, limit)
      .map((x) => x.e),
  })).filter((g) => g.items.length);
}

const clip = (s, n) => (String(s ?? '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s ?? ''));

/**
 * Transforma os dados (já filtrados) em entradas pesquisáveis.
 * @param d { contacts, deals, conversations, tasks, stageName(id), contactById(id), userName(id), moneyOf(deal) }
 */
export function buildEntries(d) {
  const out = [];
  for (const c of d.contacts || []) {
    out.push({ type: 'contact', id: c.id, title: c.name || 'Sem nome', subtitle: [c.company, c.phone].filter(Boolean).join(' · '), fields: [c.name, c.company, c.email], digits: digitsOf(c.phone) });
  }
  for (const deal of d.deals || []) {
    const contact = d.contactById?.(deal.contactId);
    out.push({ type: 'deal', id: deal.id, title: deal.title, subtitle: [contact?.name, d.stageName?.(deal.stageId), d.moneyOf?.(deal)].filter(Boolean).join(' · '), fields: [deal.title, contact?.name, contact?.company], digits: digitsOf(contact?.phone) });
  }
  for (const cv of d.conversations || []) {
    const contact = d.contactById?.(cv.contactId);
    const title = contact?.name || cv.phone || 'Conversa';
    out.push({ type: 'conversation', id: cv.id, title, subtitle: clip(cv.lastMessage, 70), fields: [contact?.name, contact?.company, cv.lastMessage], digits: digitsOf(contact?.phone || cv.phone) });
  }
  for (const t of d.tasks || []) {
    out.push({ type: 'task', id: t.id, title: t.title, subtitle: [t.status === 'done' ? 'Feita' : null, d.userName?.(t.ownerId)].filter(Boolean).join(' · '), fields: [t.title, t.description] });
  }
  return out;
}

/** Ir para telas e criar coisas. `routes`: [{ id, label }] já filtradas por permissão; `actions`: [{ id, label, keywords }]. */
export function commandEntries(routes, actions) {
  return [
    ...routes.map((r) => ({ type: 'command', id: `go:${r.id}`, title: r.label, subtitle: 'Ir para', fields: [r.label, r.keywords || ''], command: { go: r.id } })),
    ...actions.map((a) => ({ type: 'command', id: `do:${a.id}`, title: a.label, subtitle: a.hint || 'Criar', fields: [a.label, a.keywords || ''], command: { action: a.id }, boost: 5 })),
  ];
}

// ---- recentes (os últimos itens abertos) ----
const RECENTS_KEY = 'ttf:recents';
export function makeRecents(storage, max = 8) {
  const read = () => {
    try {
      const v = JSON.parse(storage.getItem(RECENTS_KEY) || '[]');
      return Array.isArray(v) ? v.filter((x) => x && x.type && x.id) : [];
    } catch {
      return [];
    }
  };
  return {
    list: read,
    push(item) {
      const next = [{ type: item.type, id: item.id }, ...read().filter((x) => !(x.type === item.type && x.id === item.id))].slice(0, max);
      try {
        storage.setItem(RECENTS_KEY, JSON.stringify(next));
      } catch {
        /* sem armazenamento: só não lembra */
      }
      return next;
    },
  };
}
