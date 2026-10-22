// Funis configuráveis — modelo PURO (sem DOM, sem store). Mesmas regras do servidor (src/api/routes-pipelines.js),
// aplicadas aqui para dar o aviso na hora; quem manda é o servidor. Testado em Node (test/api/funnels-model.test.mjs).

export const KINDS = [
  { id: 'open', label: 'Em andamento' },
  { id: 'won', label: 'Ganha' },
  { id: 'lost', label: 'Perdida' },
];
export const MAX_STAGES = 30;
export const MAX_REASONS = 30;
export const SUGGESTED_REASONS = ['Preço acima do orçamento', 'Escolheu concorrente', 'Sem resposta do cliente', 'Sem orçamento no momento', 'Fora do perfil', 'Desistiu da compra', 'Outro motivo'];

const clean = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');

/** Probabilidade padrão da etapa aberta nº i (0-based) entre n abertas: espalhada pelo funil (3 → 25, 50, 75). */
export const spread = (i, n) => Math.round((100 * (i + 1)) / (n + 1));

/** Etapas de um funil novo. */
export function defaultStages() {
  return [
    { name: 'Novo', kind: 'open', probability: spread(0, 3) },
    { name: 'Qualificação', kind: 'open', probability: spread(1, 3) },
    { name: 'Proposta', kind: 'open', probability: spread(2, 3) },
    { name: 'Ganho', kind: 'won', probability: 100 },
    { name: 'Perdido', kind: 'lost', probability: 0 },
  ];
}

/** Ganho vale 100% e perdido 0% (não se edita); aberta fica entre 0 e 100, inteira. Nome sem espaços sobrando. */
export function normalizeStages(list) {
  return (list || []).map((s) => {
    const kind = ['open', 'won', 'lost'].includes(s.kind) ? s.kind : 'open';
    const p = Math.round(Number(s.probability));
    return { ...s, name: clean(s.name), kind, probability: kind === 'won' ? 100 : kind === 'lost' ? 0 : Number.isFinite(p) ? Math.min(100, Math.max(0, p)) : 0 };
  });
}

/** Mensagem do primeiro problema da lista de etapas ('' se estiver tudo certo). */
export function validateStages(list) {
  if (!Array.isArray(list) || list.length < 3 || list.length > MAX_STAGES) return `O funil precisa ter de 3 a ${MAX_STAGES} etapas.`;
  for (const [i, s] of list.entries()) {
    const name = clean(s.name);
    if (!name) return `Dê um nome à etapa ${i + 1}.`;
    if (name.length > 200) return `O nome da etapa ${i + 1} passa de 200 caracteres.`;
    if (s.kind === 'open') {
      const p = Number(s.probability);
      if (s.probability === '' || s.probability === null || !Number.isFinite(p) || p < 0 || p > 100) return `A probabilidade da etapa “${name}” precisa estar entre 0 e 100.`;
    }
  }
  for (const [kind, label] of [['open', 'em andamento'], ['won', 'ganha'], ['lost', 'perdida']]) if (!list.some((s) => s.kind === kind)) return `O funil precisa de pelo menos uma etapa ${label}.`;
  return '';
}

/** Nome de funil válido e sem repetir outro (sem diferenciar caixa nem acento). '' se estiver certo. */
export function validatePipelineName(name, others = []) {
  const n = clean(name);
  if (!n) return 'Informe o nome do funil.';
  if (n.length > 200) return 'O nome do funil passa de 200 caracteres.';
  const fold = (x) => clean(x).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  if (others.some((o) => fold(o) === fold(n))) return 'Já existe um funil com esse nome.';
  return '';
}

/** Motivos de perda: limpa, tira vazios e repetidos (sem diferenciar caixa). */
export function cleanReasons(list) {
  const seen = new Set();
  const out = [];
  for (const r of list || []) {
    const n = clean(r);
    if (!n || seen.has(n.toLowerCase())) continue;
    seen.add(n.toLowerCase());
    out.push(n);
  }
  return out;
}
export function validateReasons(list) {
  const names = (list || []).map(clean).filter(Boolean);
  if (names.length > MAX_REASONS) return `Até ${MAX_REASONS} motivos de perda.`;
  if (names.some((n) => n.length > 80)) return 'Cada motivo pode ter até 80 caracteres.';
  if (new Set(names.map((n) => n.toLowerCase())).size !== names.length) return 'Há motivos repetidos.';
  return '';
}

/** Move o item `from` para a posição `to` (devolve nova lista; índices fora do limite não mudam nada). */
export function moveItem(list, from, to) {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const out = [...list];
  const [it] = out.splice(from, 1);
  out.splice(to, 0, it);
  return out;
}

/** Valor × probabilidade da etapa (previsão ponderada). null se o valor não existe. */
export function weightedValue(value, probability) {
  const v = Number(value);
  return Number.isFinite(v) ? Math.round(v * (Math.min(100, Math.max(0, Number(probability) || 0)) / 100) * 100) / 100 : null;
}
