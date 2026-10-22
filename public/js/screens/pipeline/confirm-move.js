// Mini-confirmação ao mover para etapa final (ganho/perdido). Motivo de perda: se a empresa cadastrou motivos (tela Funis),
// escolher um é obrigatório; sem lista, é um texto livre opcional.
import { h } from '../../ui.js';
import { store } from '../../store.js';
import { openModal } from './modal.js';

export function openConfirmMove({ deal, stage, onConfirm, restoreFocus }) {
  const lost = stage.kind === 'lost';
  const names = lost ? (store.state.lossReasons || []).map((r) => r.name) : [];
  const required = names.length > 0;
  const reason = !lost
    ? null
    : required
      ? h('select', { class: 'select', 'aria-label': 'Motivo da perda', 'data-autofocus': true }, h('option', { value: '' }, 'Escolha o motivo…'), ...names.map((n) => h('option', { value: n }, n)))
      : h('textarea', { class: 'textarea', rows: '3', maxlength: '300', placeholder: 'Ex.: Preço acima do orçamento, escolheu concorrente…', 'data-autofocus': true });
  const confirmBtn = h('button', { class: 'btn btn--primary', type: 'button', disabled: required, 'data-autofocus': lost ? null : true }, lost ? 'Marcar como perdido' : 'Marcar como ganho');
  if (required) reason.addEventListener('change', () => (confirmBtn.disabled = !reason.value));
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
      lost ? h('label', { class: 'field' }, required ? 'Motivo da perda' : 'Motivo da perda (opcional)', reason) : null,
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
