// Modal "+ Adicionar produto": escolhe item do catálogo + quantidade.
import { store } from '../../store.js';
import { h, fmtBRL, replaceChildren } from '../../ui.js';
import { openModal } from './modal.js';
import { addItem, itemsOf } from './actions.js';
import { editDecision } from './perm.js';

export function openAddProduct({ deal, onAdded, onBlocked }) {
  const products = store.state.products || [];
  // Efeito 'approval' (desconto acima do limite do perfil): o motor libera só mediante aprovação — o fluxo é futuro, então só avisamos.
  const needsApproval = editDecision(deal).effect === 'approval';
  const select = h('select', { class: 'select', 'data-autofocus': true }, ...products.map((p) => h('option', { value: p.id }, `${p.name} — ${fmtBRL(p.price)}/${p.unit}`)));
  const qty = h('input', { class: 'input num', type: 'number', min: '1', max: '999', step: '1', inputmode: 'numeric' });
  qty.value = '1';
  const error = h('span', { class: 'field-error', id: 'pipeline-qty-err', 'aria-live': 'polite' });
  qty.setAttribute('aria-describedby', error.id);
  const preview = h('div', { class: 'pipeline-addprod__preview' });

  const product = () => products.find((p) => p.id === select.value);
  const quantity = () => (/^\d+$/.test(qty.value.trim()) ? Number(qty.value) : NaN);
  const valid = () => quantity() >= 1 && quantity() <= 999;

  function sync() {
    const p = product();
    const q = quantity();
    const ok = valid();
    error.textContent = ok ? '' : 'Informe uma quantidade inteira entre 1 e 999.';
    if (ok) qty.removeAttribute('aria-invalid');
    else qty.setAttribute('aria-invalid', 'true');
    const already = p && itemsOf(deal).find((i) => i.productId === p.id);
    replaceChildren(
      preview,
      h('div', { class: 'pipeline-addprod__row' }, h('span', { class: 'label' }, 'Subtotal'), h('span', { class: 'pipeline-addprod__sub num' }, ok && p ? fmtBRL(p.price * q) : '—')),
      already ? h('div', { class: 'muted', style: { fontSize: '12.5px' } }, 'Já está na proposta: a quantidade será somada à linha existente.') : null
    );
    addBtn.disabled = !ok || !p;
  }

  const addBtn = h('button', { class: 'btn btn--primary', type: 'submit' }, needsApproval ? 'Pedir aprovação' : 'Adicionar');
  const cancelBtn = h('button', { class: 'btn btn--quiet', type: 'button' }, 'Cancelar');

  const content = products.length
    ? h(
        'form',
        {
          class: 'pipeline-form',
          novalidate: true,
          onsubmit: (e) => {
            e.preventDefault();
            const p = product();
            if (!p || !valid()) return;
            const result = addItem(deal.id, p, quantity());
            modal.close();
            if (result.ok) onAdded?.(p);
            else onBlocked?.(result.decision);
          },
          oninput: sync,
          onchange: sync,
        },
        needsApproval ? h('div', { class: 'pipeline-hint is-warn', role: 'note' }, 'Precisa de aprovação: esta proposta tem desconto acima do limite do seu perfil. A alteração só vale depois que um gestor aprovar.') : null,
        h('label', { class: 'field' }, 'Produto', select),
        h('label', { class: 'field' }, 'Quantidade', qty, error),
        preview,
        h('div', { class: 'pipeline-modal__actions' }, cancelBtn, addBtn)
      )
    : h('div', { class: 'empty' }, h('div', null, 'Nenhum produto cadastrado ainda.'), h('button', { class: 'btn btn--quiet btn--sm', type: 'button', onclick: () => modal.close() }, 'Fechar'));

  const modal = openModal({ eyebrow: 'Proposta', title: 'Adicionar produto', content, width: 480, restoreFocus: () => document.querySelector('.pipeline-panel [data-focus="add"]') });
  cancelBtn.addEventListener('click', () => modal.close());
  if (products.length) sync();
  return modal;
}
