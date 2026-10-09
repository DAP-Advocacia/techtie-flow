// Mutações e consultas do Pipeline. Tudo que altera dado passa por
// store.update para que Inbox/sidebar enxerguem a mudança (ex.: mensagem nova).
// Toda mutação RE-VERIFICA a permissão no motor (defesa em profundidade: a UI já
// desabilita o botão, mas a ação não confia nisso) e devolve { ok, decision }.
import { store } from '../../store.js';
import { fmtBRL } from '../../ui.js';
import { decide, audit } from '../../access.js';
import * as P from './perm.js';

const uid = (prefix) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';

export const itemsOf = (deal) => (Array.isArray(deal?.items) ? deal.items : []);
export const sumItems = (deal) => itemsOf(deal).reduce((n, i) => n + (Number(i.total) || 0), 0);

/**
 * Negócios de uma etapa, o mais recentemente movido primeiro (feedback visual de "acabou de cair aqui").
 * Por padrão só os que o usuário pode ler; quem chama pode passar a lista já filtrada.
 */
export function dealsInStage(stageId, deals = P.visibleDeals()) {
  return deals.filter((d) => d.stageId === stageId).sort((a, b) => (b.stageChangedAt || 0) - (a.stageChangedAt || 0));
}

/** Primeiro negócio (visível) na ordem visual do quadro (etapas da esquerda p/ direita). */
export function firstDealOf(pipeline, deals = P.visibleDeals()) {
  for (const stage of pipeline?.stages || []) {
    const [first] = dealsInStage(stage.id, deals);
    if (first) return first;
  }
  return null;
}

/** Conversa de WhatsApp do negócio que o usuário pode ler (a vinculada por dealId, senão qualquer do contato). */
export const conversationOf = (deal) => P.chatFor(deal).conv;

export const MAX_DEAL_VALUE = 1e9;

/**
 * '18.400,50' | '18400' | 'R$ 1.200' -> number; NaN se inválido.
 * Aceita só o formato pt-BR (vírgula decimal, ponto de milhar) e ponto decimal sem milhar ('1234.50').
 * Formatos ambíguos como '1,234.50' são recusados em vez de lidos como 1,2345.
 */
export function parseMoney(raw) {
  const s = String(raw ?? '')
    .replace(/R\$|\s| /g, '')
    .trim();
  if (!s) return NaN;
  if (s.includes(',')) return /^(\d{1,3}(\.\d{3})+|\d+),\d{1,2}$/.test(s) ? Number(s.replace(/\./g, '').replace(',', '.')) : NaN;
  if (/^\d{1,3}(\.\d{3})+$/.test(s)) return Number(s.replace(/\./g, ''));
  return /^\d+(\.\d{1,2})?$/.test(s) ? Number(s) : NaN;
}

function logTimeline(s, contactId, text) {
  if (!contactId) return;
  (s.timeline[contactId] ||= []).unshift({ text, who: firstName(s.users.find((u) => u.id === s.currentUserId)?.name), at: Date.now() });
}

const denied = (decision) => ({ ok: false, decision });
const allowed = (decision) => ({ ok: true, decision });

export function moveDeal(dealId, stageId, { reason = '' } = {}) {
  const deal = store.deal(dealId);
  const stage = store.stage(stageId);
  const decision = P.moveDecision(deal, stage);
  if (decision.effect !== 'allow') return denied(decision);
  if (deal.stageId === stageId) return allowed(decision);
  store.update((s) => {
    const d = s.deals.find((x) => x.id === dealId);
    if (!d || d.stageId === stageId) return;
    d.stageId = stageId;
    d.stageChangedAt = Date.now();
    if (stage?.kind === 'lost') d.lostReason = reason.trim();
    else delete d.lostReason;
    logTimeline(s, d.contactId, `Negócio movido para ${stage?.name || 'outra etapa'}`);
  });
  return allowed(decision);
}

const noteFor = (product, qty) => (qty > 1 ? `${qty} × ${product.unit}` : product.unit);

/** Soma `qty` à linha do produto (ou cria) e recalcula total da proposta e deal.value. */
export function addItem(dealId, product, qty) {
  const deal = store.deal(dealId);
  const decision = P.editDecision(deal);
  // 'approval' (desconto acima do limite do perfil) é só informado: o fluxo de aprovação ainda não existe, então nada é gravado.
  if (decision.effect !== 'allow') return denied(decision);
  store.update((s) => {
    const d = s.deals.find((x) => x.id === dealId);
    if (!d) return;
    d.items ||= [];
    const line = d.items.find((i) => i.productId === product.id);
    if (line) {
      line.qty += qty;
      line.note = noteFor(product, line.qty);
      line.total = line.qty * line.unitPrice;
    } else {
      d.items.push({ productId: product.id, name: product.name, qty, unitPrice: product.price, note: noteFor(product, qty), total: qty * product.price });
    }
    d.value = sumItems(d);
  });
  return allowed(decision);
}

/** Remove a linha; se a proposta esvaziar, mantém o valor estimado do negócio. */
export function removeItem(dealId, index) {
  const deal = store.deal(dealId);
  const decision = P.editDecision(deal);
  if (decision.effect !== 'allow') return denied(decision);
  store.update((s) => {
    const d = s.deals.find((x) => x.id === dealId);
    if (!d || !Array.isArray(d.items) || !d.items[index]) return;
    d.items.splice(index, 1);
    if (d.items.length) d.value = sumItems(d);
  });
  return allowed(decision);
}

export function createDeal({ title, contactId, newContact, value, ownerId, pipelineId, stageId }) {
  const pipeline = store.pipeline(pipelineId);
  const stage = pipeline?.stages.find((st) => st.id === stageId);
  const decision = P.createStageDecision(pipeline, stage, ownerId);
  if (decision.effect !== 'allow') return denied(decision);
  if (newContact) {
    const cdec = decide('contact', 'create', { ownerId });
    if (cdec.effect !== 'allow') return denied(cdec);
  }
  // Campo valor travado/oculto: o negócio nasce sem valor (quem tem acesso preenche depois).
  const lv = P.fieldLevels();
  const safeValue = lv.value === 'write' ? value : 0;
  let deal;
  store.update((s) => {
    let cid = contactId;
    if (newContact) {
      cid = uid('c');
      s.contacts.push({ id: cid, name: newContact.name, company: newContact.company || '', phone: newContact.phone || '', email: '', ownerId, source: 'Manual', tags: [] });
      s.timeline[cid] = [{ text: 'Contato criado manualmente', who: '', at: Date.now() }];
    }
    const now = Date.now();
    deal = { id: uid('d'), title, contactId: cid, pipelineId, stageId, value: safeValue, ownerId, createdAt: now, stageChangedAt: now, lastMessage: '', items: [] };
    s.deals.push(deal);
    logTimeline(s, cid, `Negócio criado em ${store.stage(stageId)?.name || 'pipeline'}`);
  });
  return { ok: true, decision, deal };
}

export function deleteDeal(dealId) {
  const deal = store.deal(dealId);
  const decision = deal ? P.deleteDecision(deal) : { effect: 'deny', reason: 'no_grant', matched: [] };
  if (decision.effect !== 'allow') return denied(decision);
  const title = deal.title;
  store.update((s) => {
    const i = s.deals.findIndex((x) => x.id === dealId);
    if (i !== -1) s.deals.splice(i, 1);
  });
  audit('deal.delete', dealId, `Negócio "${title}" excluído`);
  return allowed(decision);
}

/** Compartilha o negócio (usuário ou equipe, leitura/edição). Regrava o nível se o alvo já estava na lista. */
export function shareDeal(dealId, { type, id, level }) {
  const deal = store.deal(dealId);
  const decision = deal ? P.shareDecision(deal) : { effect: 'deny', reason: 'no_grant', matched: [] };
  if (decision.effect !== 'allow') return denied(decision);
  if (!['user', 'team'].includes(type) || !['read', 'edit'].includes(level)) return denied({ effect: 'deny', reason: 'unknown_action', matched: [] });
  const target = type === 'user' ? store.userById(id) : store.state.teams.find((t) => t.id === id);
  if (!target) return denied({ effect: 'deny', reason: 'unknown_action', matched: [] });
  store.update((s) => {
    const d = s.deals.find((x) => x.id === dealId);
    const list = (Array.isArray(d.sharedWith) ? d.sharedWith : []).filter((g) => !(g.type === type && g.id === id));
    list.push({ type, id, level });
    d.sharedWith = list;
  });
  audit('deal.share', dealId, `Negócio "${deal.title}" compartilhado com ${type === 'user' ? '' : 'a equipe '}${target.name} (${level === 'edit' ? 'edição' : 'leitura'})`);
  return allowed(decision);
}

export function unshareDeal(dealId, { type, id }) {
  const deal = store.deal(dealId);
  const decision = deal ? P.shareDecision(deal) : { effect: 'deny', reason: 'no_grant', matched: [] };
  if (decision.effect !== 'allow') return denied(decision);
  const target = type === 'user' ? store.userById(id) : store.state.teams.find((t) => t.id === id);
  store.update((s) => {
    const d = s.deals.find((x) => x.id === dealId);
    d.sharedWith = (Array.isArray(d.sharedWith) ? d.sharedWith : []).filter((g) => !(g.type === type && g.id === id));
  });
  audit('deal.unshare', dealId, `Compartilhamento do negócio "${deal.title}" removido de ${type === 'user' ? '' : 'a equipe '}${target?.name || id}`);
  return allowed(decision);
}

export function proposalText(deal) {
  const contact = store.contact(deal.contactId);
  const lines = itemsOf(deal).map((i) => `• ${i.name} (${i.note || `${i.qty}×`}): ${fmtBRL(i.total)}`);
  return [`Olá${contact ? `, ${firstName(contact.name)}` : ''}! Segue a proposta "${deal.title}":`, ...lines, `Total: ${fmtBRL(sumItems(deal))}`].join('\n');
}

/**
 * Posta a proposta como mensagem 'out' na conversa do contato (se houver e se o usuário puder escrever nela).
 * Devolve 'sent' (postou), 'no-chat' (registrou, mas o contato não tem conversa), 'no-access' (registrou, mas o
 * usuário não pode escrever na conversa), 'no-items' (nada enviado) ou 'denied' (sem permissão de enviar).
 */
export function sendProposal(dealId) {
  const deal = store.deal(dealId);
  if (!deal || P.sendDecision(deal).effect !== 'allow') return 'denied';
  let result = 'no-items';
  store.update((s) => {
    const d = s.deals.find((x) => x.id === dealId);
    if (!d || !itemsOf(d).length) return;
    result = 'no-chat';
    const now = Date.now();
    const cv = P.sendTarget(d);
    if (cv) {
      (s.messages[cv.id] ||= []).push({ id: uid('m'), type: 'out', text: proposalText(d), at: now, authorId: s.currentUserId });
      cv.lastMessageAt = now;
      result = 'sent';
    } else if (P.chatFor(d).conv) {
      result = 'no-access';
    }
    d.proposalSentAt = now;
    logTimeline(s, d.contactId, 'Proposta enviada por WhatsApp');
  });
  return result;
}

/** Aponta a conversa que o Inbox deve abrir (ele lê state.ui.inboxConversationId). Só se o usuário puder ler. */
export function pointInboxTo(conversationId) {
  const conv = store.state.conversations.find((c) => c.id === conversationId);
  if (!conv || decide('conversation', 'read', conv).effect !== 'allow') return false;
  store.update((s) => {
    s.ui = { ...(s.ui || {}), inboxConversationId: conversationId };
  });
  return true;
}
