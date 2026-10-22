// Ações do negócio compartilhadas pelo quadro (Negócios) e pela página do negócio: mover (com confirmação nas etapas
// finais), editar, proposta (produtos, enviar), abrir conversa, excluir e compartilhar. Cada ação consulta o motor e
// avisa com o motivo quando negada. `root` só serve para devolver o foco ao elemento certo depois de redesenhar.
import { store } from '../../store.js';
import { toast } from '../../ui.js';
import * as live from '../../live.js';
import { ensureScreenCss } from '../../css.js';
import * as A from './actions.js';
import * as P from './perm.js';
import { openConfirmMove } from './confirm-move.js';
import { openConfirmDelete } from './confirm-delete.js';
import { openEditDeal } from './edit-deal.js';
import { openAddProduct } from './add-product.js';

/** Negócios com envio de proposta em andamento (vale entre telas: o envio termina mesmo se a pessoa sair). */
export const sending = new Set();

const SENT_MSG = {
  sent: 'Proposta enviada pelo WhatsApp',
  'no-chat': 'Proposta registrada (este contato ainda não tem conversa no WhatsApp)',
  'no-access': 'Proposta registrada, mas você não pode escrever na conversa deste contato',
};
const APPROVAL_MSG = 'Esta alteração precisa da aprovação de um gestor (o fluxo de aprovação ainda não existe). Nada foi alterado.';

/**
 * @param root       elemento da tela (foco volta para [data-focus=…] dentro dele)
 * @param navigate   troca de tela (abrir a Inbox)
 * @param rerender   redesenha a tela depois de mudanças locais (envio de proposta)
 * @param onSendStart  chamado ao iniciar o envio (a tela guarda o foco do botão)
 */
export function createDealController({ root, navigate, rerender = () => {}, onSendStart }) {
  ensureScreenCss('pipeline'); // os diálogos usam o CSS do Negócios, mesmo abertos de outra tela
  const q = (sel) => root?.querySelector?.(sel) || null;

  /**
   * Único caminho de mover (arraste, menu, Path, atalhos Ganho/Perdido): consulta o motor com o contexto
   * derivado dos dados e, se negado, avisa com o motivo e NÃO muda nada. Etapas finais pedem confirmação.
   */
  function requestMove(dealId, stageId, { refocus = false } = {}) {
    const deal = store.deal(dealId);
    const stage = store.stage(stageId);
    if (!deal || !stage || deal.stageId === stageId) return;
    if (!P.visibleDeals().some((d) => d.id === dealId)) {
      toast('Este negócio está fora do seu escopo.');
      return;
    }
    const decision = P.moveDecision(deal, stage);
    if (decision.effect === 'approval') {
      toast(`Mover para ${stage.name} requer aprovação de um gestor. Nada foi alterado.`);
      return;
    }
    if (decision.effect !== 'allow') {
      toast(`Não foi possível mover para ${stage.name}: ${P.reasonOf(decision, 'mover este negócio')}`);
      return;
    }
    const card = () => q(`[data-focus="card:${dealId}"]`);
    const doMove = (reason) => {
      const r = A.moveDeal(dealId, stageId, { reason }); // re-verifica no motor (a permissão pode ter mudado com o modal aberto)
      if (!r.ok) {
        toast(`Não foi possível mover para ${stage.name}: ${P.reasonOf(r.decision, 'mover este negócio')}`);
        return;
      }
      toast(`Movido para ${stage.name}`);
      if (refocus) card()?.focus(); // menu/teclado: o foco acompanha o cartão; no arraste não
    };
    if (stage.kind === 'won' || stage.kind === 'lost') openConfirmMove({ deal, stage, onConfirm: doMove, restoreFocus: refocus ? card : undefined });
    else doMove('');
  }

  function editDeal(deal) {
    openEditDeal({
      deal,
      restoreFocus: () => q('[data-focus="edit"]'),
      onSave: (patch) => {
        const r = A.editDeal(deal.id, patch);
        if (r.ok) toast('Negócio atualizado');
        else if (!r.error) toast(P.reasonOf(r.decision, 'editar este negócio'));
        return r;
      },
    });
  }

  function addProduct(deal) {
    const dec = P.editDecision(deal);
    if (dec.effect === 'deny') {
      toast(P.reasonOf(dec, 'editar a proposta'));
      return;
    }
    openAddProduct({
      deal,
      onAdded: (p) => toast(`${p.name} adicionado à proposta`),
      onProductCreated: (p) => {
        toast(`${p.name} cadastrado no catálogo`);
        addProduct(store.deal(deal.id) || deal); // reabre com o catálogo atualizado
      },
      onBlocked: (d) => toast(d.effect === 'approval' ? APPROVAL_MSG : P.reasonOf(d, 'editar a proposta')),
    });
  }

  function removeItem(deal, i) {
    const r = A.removeItem(deal.id, i);
    if (!r.ok) toast(r.decision.effect === 'approval' ? APPROVAL_MSG : P.reasonOf(r.decision, 'editar a proposta'));
  }

  function send(deal) {
    if (sending.has(deal.id) || !A.itemsOf(deal).length) return;
    const dec = P.sendDecision(deal);
    if (dec.effect !== 'allow') {
      toast(P.reasonOf(dec, 'enviar a proposta'));
      return;
    }
    const by = store.state.currentUserId;
    sending.add(deal.id);
    onSendStart?.();
    rerender();
    if (live.enabled) {
      // Modo operação: o servidor monta o texto, envia pelo WhatsApp e registra (erros aparecem como aviso).
      live.sendProposal(deal.id).then((r) => {
        sending.delete(deal.id);
        rerender();
        if (r) toast(SENT_MSG[r.result] || 'Proposta registrada');
      });
      return;
    }
    // Protótipo: envio simulado. Se a pessoa sair da tela, termina mesmo assim (só mexe no store).
    setTimeout(() => {
      sending.delete(deal.id);
      if (store.state.currentUserId !== by) return rerender(); // trocou de usuário: não envia em nome de outra pessoa
      const result = A.sendProposal(deal.id); // re-verifica no motor
      rerender();
      toast({ ...SENT_MSG, 'no-items': 'Nada enviado: a proposta ficou sem produtos', denied: P.reasonOf(P.sendDecision(store.deal(deal.id) || deal), 'enviar a proposta') }[result]);
    }, 1100);
  }

  function openChat(deal) {
    const { conv, decision } = P.chatFor(deal);
    if (!conv || decision.effect !== 'allow') {
      toast(P.reasonOf(decision, 'ler a conversa deste contato'));
      return;
    }
    if (A.pointInboxTo(conv.id)) navigate('inbox');
  }

  function confirmDelete(deal, { onDeleted } = {}) {
    const dec = P.deleteDecision(deal);
    if (dec.effect !== 'allow') {
      toast(P.reasonOf(dec, 'excluir negócios'));
      return;
    }
    openConfirmDelete({
      deal,
      restoreFocus: () => q('[data-focus="delete"]') || q('.pipeline-card'),
      onConfirm: () => {
        const r = A.deleteDeal(deal.id);
        toast(r.ok ? 'Negócio excluído' : P.reasonOf(r.decision, 'excluir negócios'));
        if (r.ok) onDeleted?.();
      },
    });
  }

  function share(deal, target) {
    const r = A.shareDeal(deal.id, target);
    if (!r.ok) {
      toast(P.reasonOf(r.decision));
      return;
    }
    toast('Negócio compartilhado');
    q('[data-focus="share-target"]')?.focus();
  }

  function unshare(deal, target) {
    const r = A.unshareDeal(deal.id, target);
    toast(r.ok ? 'Acesso removido' : P.reasonOf(r.decision));
  }

  return { requestMove, editDeal, addProduct, removeItem, send, openChat, confirmDelete, share, unshare };
}
