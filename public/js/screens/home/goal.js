// Meta de receita do mês (cartão do Início): quem altera as configurações da empresa define o valor.
// Fica em tenant.goals.monthlyRevenue (no servidor: tenants.settings.goals). Em branco ou 0 = sem meta.
import { h, toast } from '../../ui.js';
import { store } from '../../store.js';
import { decide, audit } from '../../access.js';
import * as live from '../../live.js';
import { parseNumber } from '../../lists/model.js';
import { openDialog } from '../contacts/form.js';

/** Pode definir a meta? (mesma permissão de alterar as configurações da empresa — o servidor confere de novo) */
export const canSetGoal = () => decide('tenant_settings', 'update', null).effect === 'allow';
export const currentGoal = () => Number(store.state.tenant?.goals?.monthlyRevenue) || null;

/** Grava a meta (null remove). Em operação espera o servidor; no protótipo grava no navegador. */
export async function saveGoal(value) {
  if (!canSetGoal()) throw new Error('Seu perfil não permite definir a meta.');
  if (live.enabled) return live.setGoal(value);
  store.update((s) => {
    s.tenant.goals = { ...(s.tenant.goals || {}), monthlyRevenue: value };
  });
  audit('tenant.goals', store.state.tenant.id, value ? 'Meta de receita do mês definida' : 'Meta de receita do mês removida');
  return store.state.tenant.goals;
}

export function openGoalDialog({ onSaved } = {}) {
  const now = currentGoal();
  const input = h('input', { class: 'input', type: 'text', inputmode: 'decimal', placeholder: 'Ex.: 120.000', autocomplete: 'off', 'aria-label': 'Meta de receita do mês, em reais', 'data-autofocus': true, value: now ? String(now).replace('.', ',') : '' });
  const error = h('span', { class: 'field-error', role: 'alert' });
  const save = h('button', { class: 'btn btn--primary', type: 'submit' }, 'Salvar meta');
  const cancel = h('button', { class: 'btn btn--quiet', type: 'button' }, 'Cancelar');
  const dlg = openDialog({
    eyebrow: 'INÍCIO',
    title: 'Meta de receita do mês',
    content: h(
      'form',
      {
        class: 'contacts-form',
        novalidate: true,
        onsubmit: async (e) => {
          e.preventDefault();
          error.textContent = '';
          const raw = input.value.trim();
          const value = raw === '' ? null : parseNumber(raw);
          if (value !== null && (Number.isNaN(value) || value < 0 || value > 1e10)) return (error.textContent = 'Informe um valor em reais, como 120.000.');
          save.disabled = true;
          try {
            await saveGoal(value && value > 0 ? value : null);
            dlg.close();
            toast(value ? 'Meta do mês atualizada' : 'Meta do mês removida');
            onSaved?.();
          } catch (err) {
            error.textContent = err.message || 'Não foi possível salvar.';
            save.disabled = false;
          }
        },
      },
      h('p', { class: 'muted' }, 'Quanto a empresa quer vender por mês. O Início soma os negócios ganhos no mês e mostra o quanto falta. Deixe em branco para remover a meta.'),
      h('label', { class: 'field' }, 'Meta mensal (R$)', input),
      error,
      h('div', { class: 'contacts-form__actions' }, cancel, save)
    ),
  });
  cancel.addEventListener('click', () => dlg.close());
  return dlg;
}
