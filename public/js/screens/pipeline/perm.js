// Decisões de permissão da tela Negócios. A UI NÃO tem regra própria: tudo aqui só
// monta o registro/contexto a partir dos DADOS da tela e pergunta ao motor
// (shared/permissions) via public/js/access.js.
//
// Contexto de operação (`ctx.*`) é sempre derivado das etapas reais do store —
// nunca de entrada solta — porque as regras (ex.: SDR não move para Ganho/Perdido)
// dependem dele e chave ausente = desconhecida = negado.
import { store } from '../../store.js';
import { visible, decide, canAccess, fieldLevel, denyMessage, aclRow } from '../../access.js';

const RANK = { allow: 0, approval: 1, deny: 2 };
const deny = (reason) => ({ effect: 'deny', reason, matched: [] });

/** Pior decisão do conjunto (deny > approval > allow). */
export const worst = (...ds) => ds.reduce((a, b) => (RANK[b.effect] > RANK[a.effect] ? b : a));

/** Etapa sem `kind` é aberta. O motor trata chave ausente como "desconhecida" (nega), então normalizamos. */
export const kindOf = (stage) => stage?.kind || 'open';

// ---------------------------------------------------------------------------
// Visibilidade
// ---------------------------------------------------------------------------

/** ÚNICA fonte de negócios exibidos (colunas, totais, contagens, seleção). */
export const visibleDeals = () => visible('deal', store.state.deals);

/**
 * Pipelines que o usuário pode ver: a "sonda" pergunta ao motor se ele leria um negócio SEU
 * naquele pipeline (cobre as partições do perfil). Também aparece o pipeline onde ele já enxerga
 * algum negócio (ex.: compartilhado com ele), porque o motor já autorizou a leitura.
 */
export function visiblePipelines(deals = visibleDeals()) {
  const me = store.state.currentUserId;
  return store.state.pipelines.filter((p) => {
    const probe = decide('deal', 'read', { pipelineId: p.id, ownerId: me, stageId: p.stages[0]?.id }, undefined, me);
    return probe.effect === 'allow' || deals.some((d) => d.pipelineId === p.id);
  });
}

// ---------------------------------------------------------------------------
// Campos (valor / itens / desconto)
// ---------------------------------------------------------------------------

/** 'write' | 'readonly' | 'hidden' por campo do negócio. */
export const fieldLevels = () => ({
  value: fieldLevel('deal', 'value'),
  items: fieldLevel('deal', 'items'),
  discount: fieldLevel('deal', 'discount'),
});

/** Preços (valor, itens, total) ficam ocultos se o valor OU os itens estão ocultos. */
export const pricesHidden = (lv = fieldLevels()) => lv.value === 'hidden' || lv.items === 'hidden';

// ---------------------------------------------------------------------------
// Mover
// ---------------------------------------------------------------------------

/**
 * Decisão de mover `deal` para `toStage`. Origem e destino vêm do store (etapas reais) e o destino
 * precisa ser do mesmo pipeline do negócio.
 */
export function moveDecision(deal, toStage) {
  if (!deal || !toStage) return deny('unknown_action');
  const pipeline = store.pipeline(deal.pipelineId);
  if (!pipeline?.stages.some((s) => s.id === toStage.id)) return deny('invalid_stage');
  const from = pipeline.stages.find((s) => s.id === deal.stageId);
  return decide('deal', 'move', deal, { fromStageId: from?.id ?? deal.stageId, toStageId: toStage.id, fromStageKind: kindOf(from), toStageKind: kindOf(toStage) });
}

// ---------------------------------------------------------------------------
// Proposta
// ---------------------------------------------------------------------------

/** Maior desconto (%) entre os itens. Só existe se o item trouxer `discountPct`; sem desconto = 0. */
export function discountOf(deal) {
  const list = Array.isArray(deal?.items) ? deal.items : [];
  return list.reduce((m, i) => Math.max(m, Number(i.discountPct) || 0), 0);
}

/** `proposal <ação>` sobre a proposta do negócio (o registro é o negócio decorado: dono, equipe). */
export function proposalDecision(deal, action, discountPct = discountOf(deal)) {
  const row = aclRow('deal', deal);
  return decide('proposal', action, row, action === 'update' ? { discountPct } : undefined);
}

/** Editar itens/valor: campos liberados + atualizar o negócio + atualizar a proposta (pior das duas). */
export function editDecision(deal, discountPct) {
  const lv = fieldLevels();
  if (lv.value !== 'write' || lv.items !== 'write') return deny(pricesHidden(lv) ? 'field_hidden' : 'field_readonly');
  return worst(decide('deal', 'update', deal), proposalDecision(deal, 'update', discountPct));
}

/** Enviar proposta: permissão `proposal send` e preços visíveis (o texto enviado vai parar na conversa). */
export function sendDecision(deal) {
  if (pricesHidden()) return deny('field_hidden');
  return proposalDecision(deal, 'send');
}

/** Ler a proposta (itens) — `proposal read`. */
export const proposalReadDecision = (deal) => proposalDecision(deal, 'read');

// ---------------------------------------------------------------------------
// Conversa vinculada
// ---------------------------------------------------------------------------

function candidateConversations(deal) {
  const all = store.state.conversations;
  const linked = all.filter((c) => c.dealId === deal.id);
  return linked.length ? linked : all.filter((c) => c.contactId === deal.contactId);
}

/** { conv, decision } — a 1ª conversa vinculada que o usuário PODE ler; se existem mas nenhuma é legível, a negação da 1ª. */
export function chatFor(deal) {
  if (!deal) return { conv: null, decision: deny('no_grant') };
  const cands = candidateConversations(deal);
  if (!cands.length) return { conv: null, decision: deny('no_chat') };
  let firstDeny = null;
  for (const conv of cands) {
    const decision = decide('conversation', 'read', conv);
    if (decision.effect === 'allow') return { conv, decision };
    firstDeny ||= { conv, decision };
  }
  return firstDeny;
}

/** Conversa onde dá para postar a proposta: legível E com `send_message` liberado. */
export function sendTarget(deal) {
  if (!deal) return null;
  return candidateConversations(deal).find((c) => decide('conversation', 'read', c).effect === 'allow' && decide('conversation', 'send_message', c).effect === 'allow') || null;
}

/** A prévia da última mensagem só aparece se o usuário puder ler a conversa vinculada (ou se não há conversa). */
export function previewAllowed(deal) {
  const linked = store.state.conversations.filter((c) => c.dealId === deal.id);
  return !linked.length || linked.some((c) => decide('conversation', 'read', c).effect === 'allow');
}

// ---------------------------------------------------------------------------
// Criar / excluir / compartilhar
// ---------------------------------------------------------------------------

/** Linha de um negócio a criar (o `teamId` é decorado pelo adaptador a partir do responsável). */
export const newDealRow = (pipeline, stageId, ownerId) => ({ pipelineId: pipeline?.id, stageId, ownerId });

/**
 * Responsáveis possíveis: quem o motor aceita como dono de um negócio novo neste pipeline
 * (Atendente/SDR: só ele; Gestor: quem está no escopo; Admin: todos).
 */
export function createOwners(pipeline) {
  const firstStage = pipeline?.stages?.[0]?.id;
  const users = store.state.users.filter((u) => !u.isBot && u.status === 'active');
  const allowed = users.filter((u) => decide('deal', 'create', newDealRow(pipeline, firstStage, u.id)).effect === 'allow');
  const probe = decide('deal', 'create', newDealRow(pipeline, firstStage, store.state.currentUserId));
  return { allowed, probe: allowed.length ? { effect: 'allow', reason: 'ok', matched: [] } : probe };
}

/** Pode criar já nesta etapa? Etapas finais passam pela regra de mover (ex.: SDR não cria direto em Ganho). */
export function createStageDecision(pipeline, stage, ownerId) {
  const row = newDealRow(pipeline, stage?.id, ownerId);
  const create = decide('deal', 'create', row);
  if (create.effect !== 'allow' || kindOf(stage) === 'open') return create;
  // não há "etapa de origem" num negócio novo: nulos explícitos (definidos), nunca ausentes
  const mv = decide('deal', 'move', row, { fromStageId: null, toStageId: stage.id, fromStageKind: null, toStageKind: kindOf(stage) });
  return mv.effect === 'allow' ? create : mv;
}

export const deleteDecision = (deal) => decide('deal', 'delete', deal);

/** Quem pode compartilhar: `transfer` ou `update` do negócio. */
export function shareDecision(deal) {
  const t = decide('deal', 'transfer', deal);
  if (t.effect === 'allow') return t;
  const u = decide('deal', 'update', deal);
  return u.effect === 'allow' ? u : t;
}

// ---------------------------------------------------------------------------
// Textos
// ---------------------------------------------------------------------------

/**
 * Motivo curto de uma negação/aprovação (toasts e dicas). `what` ("editar a proposta") deixa a
 * negação genérica `no_grant` mais específica; as demais razões vêm do motor.
 */
export function reasonOf(decision, what) {
  if (decision?.reason === 'no_grant' && what) return `Seu perfil não permite ${what}.`;
  switch (decision?.reason) {
    case 'field_hidden':
      return 'Seu perfil não vê os valores desta proposta.';
    case 'field_readonly':
      return 'Seu perfil só pode consultar os valores (campo travado).';
    case 'no_chat':
      return 'Este contato ainda não tem conversa.';
    case 'invalid_stage':
      return 'Etapa de outro pipeline.';
    default:
      return decision ? denyMessage(decision) : 'Ação não permitida.';
  }
}

export { canAccess };
