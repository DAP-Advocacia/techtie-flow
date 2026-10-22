// Ações em massa da lista de Negócios: mover de etapa, mudar o responsável e excluir. Cada negócio passa pelo motor
// (mesmas funções de uma ação isolada: A.moveDeal / A.transferDeal / A.deleteDeal), então quem não pode algo
// simplesmente fica de fora e o aviso conta quantos foram e quantos não. Etapa final e exclusão pedem confirmação.
import { h, toast } from '../../ui.js';
import { store } from '../../store.js';
import { canAccess } from '../../access.js';
import { openDialog } from '../contacts/form.js';
import * as A from './actions.js';
import * as P from './perm.js';

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** "3 negócios movidos para Proposta. 2 não puderam ser alterados (...)" */
function report(ok, total, doneOne, doneMany) {
  const skipped = total - ok;
  const head = ok ? `${plural(ok, 'negócio', 'negócios')} ${ok === 1 ? doneOne : doneMany}` : 'Nada foi alterado';
  const tail = skipped ? `${ok ? '. ' : ': '}${plural(skipped, 'não pôde', 'não puderam')} ser alterado${skipped === 1 ? '' : 's'} (sem permissão, aprovação pendente ou já estava assim)` : '';
  return head + tail;
}

/** Confirmação simples (com motivo opcional): onConfirm(motivo). */
export function openBulkConfirm({ title, message, confirmLabel, danger = false, withReason = false, onConfirm }) {
  const reason = withReason ? h('textarea', { class: 'textarea', rows: '2', maxlength: '300', placeholder: 'Motivo (opcional)', 'aria-label': 'Motivo' }) : null;
  const ok = h('button', { class: 'btn btn--primary', type: 'button' }, confirmLabel);
  const cancel = h('button', { class: 'btn btn--quiet', type: 'button', 'data-autofocus': true }, 'Cancelar');
  const dlg = openDialog({ eyebrow: danger ? 'AÇÃO SEM VOLTA' : 'EM MASSA', title, content: h('div', { class: 'contacts-form' }, h('p', { class: 'muted' }, message), reason, h('div', { class: 'contacts-form__actions' }, cancel, ok)) });
  cancel.addEventListener('click', () => dlg.close());
  ok.addEventListener('click', () => {
    dlg.close();
    onConfirm(reason ? reason.value : '');
  });
  return dlg;
}

const dealsOf = (rows) => rows.map((r) => store.deal(r.id)).filter(Boolean);

export function moveBulk(rows, stageId, done) {
  const stage = store.stage(stageId);
  if (!stage) return;
  const deals = dealsOf(rows);
  const movable = deals.filter((d) => d.stageId !== stageId && P.moveDecision(d, stage).effect === 'allow');
  if (!movable.length) {
    toast(report(0, deals.length, '', ''));
    return;
  }
  const apply = (reason = '') => {
    const ok = movable.filter((d) => A.moveDeal(d.id, stageId, { reason }).ok).length;
    toast(report(ok, deals.length, `movido para ${stage.name}`, `movidos para ${stage.name}`));
    done();
  };
  if (stage.kind === 'won' || stage.kind === 'lost') {
    openBulkConfirm({
      title: `Mover ${plural(movable.length, 'negócio', 'negócios')} para ${stage.name}?`,
      message: stage.kind === 'won' ? 'Os negócios serão marcados como ganhos.' : 'Os negócios serão marcados como perdidos.',
      confirmLabel: `Mover para ${stage.name}`,
      withReason: stage.kind === 'lost',
      onConfirm: apply,
    });
  } else apply();
}

export function ownerBulk(rows, ownerId, done) {
  const owner = store.userById(ownerId);
  if (!owner) return;
  const deals = dealsOf(rows);
  const ok = deals.filter((d) => A.transferDeal(d.id, ownerId).ok).length;
  toast(report(ok, deals.length, `agora com ${owner.name}`, `agora com ${owner.name}`));
  done();
}

export function deleteBulk(rows, done) {
  const deals = dealsOf(rows);
  const deletable = deals.filter((d) => P.deleteDecision(d).effect === 'allow');
  if (!deletable.length) {
    toast('Seu perfil não permite excluir estes negócios.');
    return;
  }
  const skipped = deals.length - deletable.length;
  openBulkConfirm({
    title: `Excluir ${plural(deletable.length, 'negócio', 'negócios')}?`,
    message: `Os negócios e suas propostas serão removidos. Esta ação não tem volta.${skipped ? ` ${plural(skipped, 'selecionado fica', 'selecionados ficam')} de fora, por falta de permissão.` : ''}`,
    confirmLabel: 'Excluir',
    danger: true,
    onConfirm: () => {
      const ok = deletable.filter((d) => A.deleteDeal(d.id).ok).length;
      toast(report(ok, deals.length, 'excluído', 'excluídos'));
      done();
    },
  });
}

/** Ações em massa para a tabela do funil `pipelineId` (todas as linhas pertencem a ele; as etapas vêm do store na hora). */
export function dealBulk(pipelineId) {
  return [
    { id: 'move', label: 'Mover para etapa…', choices: () => (store.pipeline(pipelineId)?.stages || []).map((st) => ({ value: st.id, label: st.name })), run: (rows, done, stageId) => moveBulk(rows, stageId, done) },
    { id: 'owner', label: 'Mudar responsável…', show: () => canAccess('deal', 'transfer'), choices: () => store.state.users.filter((u) => !u.isBot && u.status === 'active').map((u) => ({ value: u.id, label: u.name })), run: (rows, done, ownerId) => ownerBulk(rows, ownerId, done) },
    { id: 'delete', label: 'Excluir', danger: true, show: () => canAccess('deal', 'delete'), run: (rows, done) => deleteBulk(rows, done) },
  ];
}
