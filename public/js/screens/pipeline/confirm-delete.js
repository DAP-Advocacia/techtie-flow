// Confirmação de exclusão de negócio (ação sensível: pede confirmação explícita).
import { h } from '../../ui.js';
import { openModal } from './modal.js';

export function openConfirmDelete({ deal, onConfirm, restoreFocus }) {
  const confirmBtn = h('button', { class: 'btn btn--primary', type: 'button' }, 'Excluir negócio');
  const cancelBtn = h('button', { class: 'btn btn--quiet', type: 'button', 'data-autofocus': true }, 'Cancelar');
  const modal = openModal({
    eyebrow: 'Ação sem volta',
    title: 'Excluir este negócio?',
    width: 460,
    restoreFocus,
    content: h(
      'div',
      { class: 'pipeline-form' },
      h('p', { class: 'muted' }, `“${deal.title}” e a proposta dele serão removidos. A exclusão fica registrada na auditoria.`),
      h('div', { class: 'pipeline-modal__actions' }, cancelBtn, confirmBtn)
    ),
  });
  cancelBtn.addEventListener('click', () => modal.close());
  confirmBtn.addEventListener('click', () => {
    modal.close();
    onConfirm();
  });
  return modal;
}
