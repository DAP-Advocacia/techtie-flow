// Mini-confirmação ao mover para etapa final (ganho/perdido). Motivo de perda é opcional.
import { h } from '../../ui.js';
import { openModal } from './modal.js';

export function openConfirmMove({ deal, stage, onConfirm, restoreFocus }) {
  const lost = stage.kind === 'lost';
  const reason = lost ? h('textarea', { class: 'textarea', rows: '3', maxlength: '300', placeholder: 'Ex.: Preço acima do orçamento, escolheu concorrente…', 'data-autofocus': true }) : null;
  const confirmBtn = h('button', { class: 'btn btn--primary', type: 'button', 'data-autofocus': lost ? null : true }, lost ? 'Marcar como perdido' : 'Marcar como ganho');
  const cancelBtn = h('button', { class: 'btn btn--quiet', type: 'button' }, 'Cancelar');

  const modal = openModal({
    eyebrow: lost ? 'Etapa final · perdido' : 'Etapa final · ganho',
    title: `Mover para ${stage.name}?`,
    width: 460,
    restoreFocus,
    content: h(
      'div',
      { class: 'pipeline-form' },
      h('p', { class: 'muted' }, `“${deal.title}” será movido para ${stage.name}.`),
      lost ? h('label', { class: 'field' }, 'Motivo da perda (opcional)', reason) : null,
      h('div', { class: 'pipeline-modal__actions' }, cancelBtn, confirmBtn)
    ),
  });
  cancelBtn.addEventListener('click', () => modal.close());
  confirmBtn.addEventListener('click', () => {
    const text = reason ? reason.value : '';
    modal.close();
    onConfirm(text);
  });
  return modal;
}
