// Diálogos pequenos da tela: renomear, vincular responsável, confirmar
// (desconectar/remover) e o painel "Gerenciar".
import { h, replaceChildren, toast, toggle, fmtInt } from '../../ui.js';
import { store } from '../../store.js';
import { openModal } from './modal.js';
import { CHANNELS, ATTENTION, NAME_MAX, channelBadge, nameError, ownerOptions, statusMeta } from './channels.js';
import { updateInstance } from './actions.js';
import { check, blocked, createHints } from '../_ops/perm.js';

const cancelBtn = (m, label = 'Cancelar') => h('button', { class: 'btn btn--quiet', type: 'button', onclick: () => m.close() }, label);

export function openRename(inst, { returnFocus, onDone } = {}) {
  if (blocked(check('instance', 'update'))) return null;
  const m = openModal({ title: 'Renomear instância', eyebrow: inst.name, size: 'sm', returnFocus });
  const err = h('div', { class: 'field-error', id: 'instances-rename-err', role: 'alert' });
  const input = h('input', { class: 'input', type: 'text', value: inst.name, maxlength: String(NAME_MAX), autocomplete: 'off', 'aria-describedby': 'instances-rename-err' });
  const submit = () => {
    const msg = nameError(input.value, store.state.instances, inst.id);
    err.textContent = msg;
    input.setAttribute('aria-invalid', String(!!msg));
    if (msg) return input.focus();
    const name = input.value.trim();
    const old = inst.name;
    const done = updateInstance(
      inst.id,
      (i) => {
        i.name = name;
      },
      { event: 'instance.update', detail: `Instância "${old}" renomeada para "${name}"` }
    );
    if (!done) return blocked(check('instance', 'update')) || m.close();
    toast(`Instância renomeada para ${name}`);
    m.close();
    onDone?.();
  };
  input.addEventListener('input', () => {
    err.textContent = '';
    input.removeAttribute('aria-invalid');
  });
  replaceChildren(
    m.body,
    h('form', { id: 'instances-rename-form', class: 'instances-form', novalidate: true, onsubmit: (e) => (e.preventDefault(), submit()) }, h('label', { class: 'field' }, 'Novo nome', input, err))
  );
  replaceChildren(m.foot, cancelBtn(m), h('button', { class: 'btn btn--primary', type: 'submit', form: 'instances-rename-form' }, 'Salvar'));
  input.focus();
  input.select();
  return m;
}

export function openAssign(inst, { returnFocus, onDone } = {}) {
  if (blocked(check('instance', 'update'))) return null;
  const m = openModal({ title: 'Vincular responsável', eyebrow: inst.name, size: 'sm', returnFocus });
  const select = h('select', { class: 'select' }, ownerOptions(store.state, inst.ownerName).map((n) => h('option', { value: n, selected: n === inst.ownerName }, n)));
  replaceChildren(
    m.body,
    h(
      'form',
      {
        id: 'instances-assign-form',
        class: 'instances-form',
        onsubmit: (e) => {
          e.preventDefault();
          const owner = select.value;
          const done = updateInstance(
            inst.id,
            (i) => {
              i.ownerName = owner;
            },
            { event: 'instance.update', detail: `Responsável de "${inst.name}" alterado para ${owner}` }
          );
          if (!done) return blocked(check('instance', 'update')) || m.close();
          toast(`${inst.name} agora é de ${owner}`);
          m.close();
          onDone?.();
        },
      },
      h('label', { class: 'field' }, 'Responsável pelo número', select),
      h('p', { class: 'muted instances-hint' }, 'Quem recebe os avisos de queda e é o contato para decisões sobre este número.')
    )
  );
  replaceChildren(m.foot, cancelBtn(m), h('button', { class: 'btn btn--primary', type: 'submit', form: 'instances-assign-form' }, 'Vincular'));
  select.focus();
  return m;
}

/**
 * Confirmação com ação simulada (~700ms) para não parecer instantâneo demais:
 * botão desabilitado + rótulo de andamento. `blockedReason` desabilita a ação.
 */
export function openConfirm({ title, eyebrow, message, confirmLabel, busyLabel = 'Aguarde…', danger = false, blockedReason = '', onConfirm, returnFocus }) {
  let timer = null;
  let busy = false;
  // Durante a ação simulada o diálogo não pode ser dispensado (Esc/X/clique fora):
  // senão o timer seria cancelado e a ação sumiria sem toast nem mudança.
  const m = openModal({ title, eyebrow, size: 'sm', returnFocus, canClose: () => !busy, onClose: () => clearTimeout(timer) });
  const ok = h('button', { class: danger ? 'btn instances-btn--danger' : 'btn btn--primary', type: 'button', disabled: !!blockedReason }, confirmLabel);
  const cancel = cancelBtn(m);
  ok.addEventListener('click', () => {
    busy = true;
    ok.disabled = true;
    cancel.disabled = true;
    ok.textContent = busyLabel;
    timer = setTimeout(() => {
      busy = false;
      onConfirm();
      m.close();
    }, 700);
  });
  replaceChildren(m.body, h('p', { class: 'instances-msg' }, message), blockedReason ? h('div', { class: 'instances-note instances-note--warn', role: 'alert' }, blockedReason) : null);
  replaceChildren(m.foot, cancel, ok);
  (blockedReason ? cancel : danger ? cancel : ok).focus();
  return m;
}

/** Painel "Gerenciar": ficha da instância, IA e atalhos para as outras ações. */
export function openManage(inst, { returnFocus, onRename, onAssign, onDisconnect } = {}) {
  const m = openModal({ title: inst.name, eyebrow: 'Gerenciar instância', size: 'md', returnFocus });
  const ch = CHANNELS[inst.channel] || CHANNELS.baileys;
  const st = statusMeta(inst.status);

  // Ligar/desligar a IA na instância é alterar o Agente de IA: exige ai_agent.update (não instance.update).
  const hints = createHints();
  const cAi = check('ai_agent', 'update');
  const cUpdate = check('instance', 'update');
  const cConnect = check('instance', 'connect');
  const aiSwitch = toggle(
    !!inst.aiActive,
    (v) => {
      const done = !blocked(check('ai_agent', 'update')) && updateInstance(inst.id, (i) => (i.aiActive = v), { entity: 'ai_agent', action: 'update', event: 'ai_agent.update', detail: `Agente de IA ${v ? 'ativado' : 'desativado'} na instância "${inst.name}"` });
      if (!done) aiSwitch.setAttribute('aria-checked', String(!!store.instance(inst.id)?.aiActive)); // desfaz a troca visual
    },
    `Agente de IA ativo em ${inst.name}`
  );
  hints.lock(aiSwitch, cAi);
  const row = (k, v) => h('div', { class: 'instances-kv' }, h('dt', { class: 'label' }, k), h('dd', null, v));

  const attention = inst.status === 'attention' ? ATTENTION[inst.attentionReason] || ATTENTION.badSession : null;
  const channelNote = inst.channel === 'cloud_api'
    ? 'Sem risco de banimento por automação. A Meta cobra por mensagem entregue, direto na sua conta Meta Business; fora da janela de 24h só templates aprovados.'
    : 'Sessão por QR Code. No pareamento, o histórico completo não é importado (só conversas recentes) para reduzir o risco de banimento. Quedas temporárias reconectam sozinhas com intervalos crescentes; casos permanentes pedem ação manual.';

  replaceChildren(
    m.body,
    h('div', { class: 'instances-manage-status' }, h('span', { class: `status ${st.cls}` }, '● ', st.label), channelBadge(inst.channel)),
    attention ? h('div', { class: 'instances-note instances-note--warn' }, h('strong', null, attention.title), h('span', null, attention.text)) : null,
    h(
      'dl',
      { class: 'instances-kvs' },
      row('Número', inst.phone || '—'),
      row('Responsável', inst.ownerName || 'Sem responsável'),
      row('Conversas', fmtInt(inst.conversations)),
      row('Msgs hoje', fmtInt(inst.messagesToday))
    ),
    h('div', { class: 'instances-ai' }, h('div', null, h('div', { class: 'instances-ai__title' }, 'Agente de IA nesta instância'), h('div', { class: 'muted instances-hint' }, 'Quando ativo, a IA responde primeiro e transfere conforme as regras de transbordo.')), aiSwitch),
    h('p', { class: 'muted instances-hint' }, channelNote),
    hints.host
  );
  replaceChildren(
    m.foot,
    h('div', { class: 'instances-foot-actions' },
      hints.lock(h('button', { class: 'btn btn--quiet btn--sm', type: 'button', onclick: () => onRename?.() }, 'Renomear'), cUpdate),
      hints.lock(h('button', { class: 'btn btn--quiet btn--sm', type: 'button', onclick: () => onAssign?.() }, 'Vincular responsável'), cUpdate),
      inst.status === 'connected' ? hints.lock(h('button', { class: 'btn btn--quiet btn--sm', type: 'button', onclick: () => onDisconnect?.() }, 'Desconectar'), cConnect) : null
    ),
    h('button', { class: 'btn btn--primary', type: 'button', onclick: () => m.close() }, 'Fechar')
  );
  m.focus(aiSwitch);
  return m;
}
