// Modal "Editar negócio": título e valor estimado. O valor fica travado quando a proposta tem itens
// (nesse caso ele é a soma dos produtos) ou quando o perfil não pode editar o campo.
import { h } from '../../ui.js';
import { openModal } from './modal.js';
import { fieldLevels } from './perm.js';
import { itemsOf, parseMoney } from './actions.js';

export function openEditDeal({ deal, onSave, restoreFocus }) {
  const lv = fieldLevels();
  const hasItems = itemsOf(deal).length > 0;
  const valueLocked = lv.value !== 'write' || hasItems;
  const title = h('input', { class: 'input', type: 'text', maxlength: '200', value: deal.title, 'data-autofocus': true, autocomplete: 'off' });
  const value = h('input', { class: 'input num', type: 'text', inputmode: 'decimal', value: String(deal.value ?? 0).replace('.', ','), disabled: valueLocked });
  const error = h('span', { class: 'field-error', role: 'alert' });
  const saveBtn = h('button', { class: 'btn btn--primary', type: 'submit' }, 'Salvar');
  const cancelBtn = h('button', { class: 'btn btn--quiet', type: 'button' }, 'Cancelar');
  const modal = openModal({
    eyebrow: 'Negócio',
    title: 'Editar negócio',
    width: 460,
    restoreFocus,
    content: h(
      'form',
      {
        class: 'pipeline-form',
        novalidate: true,
        onsubmit: (e) => {
          e.preventDefault();
          const t = title.value.trim();
          if (!t) return (error.textContent = 'Informe o título.');
          const patch = { title: t };
          if (!valueLocked) {
            const v = parseMoney(value.value);
            if (Number.isNaN(v)) return (error.textContent = 'Informe um valor válido, como 1.500,00.');
            patch.value = v;
          }
          const res = onSave(patch);
          if (res && res.ok === false && res.error) return (error.textContent = res.error);
          modal.close();
        },
      },
      h('label', { class: 'field' }, 'Título', title),
      h('label', { class: 'field' }, 'Valor estimado (R$)', value, hasItems ? h('span', { class: 'muted', style: { fontSize: '12.5px' } }, 'Calculado pelos produtos da proposta.') : lv.value !== 'write' ? h('span', { class: 'muted', style: { fontSize: '12.5px' } }, 'Seu perfil não pode editar o valor.') : null),
      error,
      h('div', { class: 'pipeline-modal__actions' }, cancelBtn, saveBtn)
    ),
  });
  cancelBtn.addEventListener('click', () => modal.close());
  return modal;
}
