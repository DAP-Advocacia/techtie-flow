// Modal "+ Novo negócio": validação inline, contato existente ou novo (simples).
// Responsável, contatos e etapa inicial só oferecem o que o motor permite para o perfil.
import { store } from '../../store.js';
import { h, replaceChildren } from '../../ui.js';
import { visible, canAccess } from '../../access.js';
import { openModal } from './modal.js';
import { createDeal, parseMoney, MAX_DEAL_VALUE } from './actions.js';
import { createOwners, createStageDecision, fieldLevels, reasonOf } from './perm.js';

const NEW_CONTACT = '__new__';

export function openNewDeal({ pipeline, onCreated }) {
  const s = store.state;
  const stages = pipeline?.stages || [];
  // Responsável: só quem o motor aceita como dono de um negócio novo neste pipeline (Atendente/SDR: ele mesmo).
  const owners = createOwners(pipeline).allowed;
  // Contatos: só os que o usuário pode ler. Contato novo exige permissão de criar contato.
  const contacts = visible('contact', s.contacts);
  const mayCreateContact = canAccess('contact', 'create');
  // Valor: se o campo está oculto/travado para o perfil, o negócio nasce sem valor.
  const valueLocked = fieldLevels().value !== 'write';
  let attempted = false; // só mostra erros depois da 1ª tentativa de enviar
  let timer = null;
  let busy = false;

  const err = (name) => h('span', { class: 'field-error', id: `pipeline-new-err-${name}`, 'aria-live': 'polite' });
  const errors = { title: err('title'), contact: err('contact'), cname: err('cname'), cphone: err('cphone'), value: err('value'), owner: err('owner'), stage: err('stage') };

  const title = h('input', { class: 'input', type: 'text', maxlength: '80', autocomplete: 'off', placeholder: 'Ex.: Implantação CRM + WhatsApp', 'data-autofocus': true });
  const contact = h(
    'select',
    { class: 'select' },
    h('option', { value: '' }, 'Selecione um contato'),
    ...contacts.map((c) => h('option', { value: c.id }, c.company ? `${c.name} — ${c.company}` : c.name)),
    mayCreateContact ? h('option', { value: NEW_CONTACT }, '+ Novo contato…') : null
  );
  const cname = h('input', { class: 'input', type: 'text', maxlength: '80', autocomplete: 'off', placeholder: 'Nome do contato' });
  const ccompany = h('input', { class: 'input', type: 'text', maxlength: '80', autocomplete: 'off', placeholder: 'Empresa (opcional)' });
  const cphone = h('input', { class: 'input', type: 'tel', maxlength: '24', autocomplete: 'off', placeholder: '+55 11 90000-0000' });
  const value = h('input', { class: 'input num', type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: valueLocked ? '—' : '0,00', disabled: valueLocked });
  const owner = h('select', { class: 'select' }, ...owners.map((u) => h('option', { value: u.id }, u.name)));
  const stage = h('select', { class: 'select' }, ...stages.map((st) => h('option', { value: st.id }, st.name)));
  owner.value = owners.some((u) => u.id === s.currentUserId) ? s.currentUserId : owners[0]?.id || '';

  // Etapas que o motor não deixa usar como inicial (ex.: SDR não cria direto em Ganho) ficam desabilitadas, com o motivo.
  const stageDecision = (st) => createStageDecision(pipeline, st, owner.value);
  const syncStages = () => {
    [...stage.options].forEach((opt, i) => {
      const dec = stageDecision(stages[i]);
      opt.disabled = dec.effect !== 'allow';
      opt.textContent = dec.effect === 'allow' ? stages[i].name : `${stages[i].name} — ${dec.effect === 'approval' ? 'requer aprovação' : 'sem permissão'}`;
      opt.title = dec.effect === 'allow' ? '' : reasonOf(dec);
    });
    if (!stage.value || stage.selectedOptions[0]?.disabled) stage.value = [...stage.options].find((o) => !o.disabled)?.value || '';
  };
  syncStages();
  const ownerHint = owners.length === 1 ? 'Seu perfil permite atribuir apenas a você.' : 'Mostrando só quem está no seu escopo.';

  const controls = { title, contact, cname, cphone, value, owner, stage };
  for (const [k, el] of Object.entries(controls)) el.setAttribute('aria-describedby', errors[k].id);

  const newContactBox = h('div', { class: 'pipeline-form__sub' }, h('label', { class: 'field' }, 'Nome do contato', cname, errors.cname), h('label', { class: 'field' }, 'Empresa', ccompany), h('label', { class: 'field' }, 'Telefone', cphone, errors.cphone));
  const syncContactBox = () => {
    newContactBox.hidden = contact.value !== NEW_CONTACT;
  };
  syncContactBox();

  function validate() {
    const e = {};
    if (!title.value.trim()) e.title = 'Dê um título ao negócio.';
    if (!contact.value) e.contact = 'Selecione um contato ou crie um novo.';
    if (contact.value === NEW_CONTACT) {
      if (!cname.value.trim()) e.cname = 'Informe o nome do contato.';
      const digits = cphone.value.replace(/\D/g, '');
      if (cphone.value.trim() && (digits.length < 10 || digits.length > 13)) e.cphone = 'Telefone inválido (DDD + número).';
    }
    if (!valueLocked) {
      const money = parseMoney(value.value);
      if (!value.value.trim()) e.value = 'Informe o valor do negócio.';
      else if (Number.isNaN(money)) e.value = 'Valor inválido. Ex.: 18.400,00';
      else if (money <= 0) e.value = 'O valor deve ser maior que zero.';
      else if (money > MAX_DEAL_VALUE) e.value = 'Valor acima do limite (R$ 1.000.000.000).';
    }
    if (!owner.value || !owners.some((u) => u.id === owner.value)) e.owner = 'Selecione o responsável.';
    if (!stage.value) e.stage = 'Selecione a etapa inicial.';
    else if (stageDecision(stages.find((st) => st.id === stage.value)).effect !== 'allow') e.stage = 'Seu perfil não cria negócios nesta etapa.';
    return e;
  }

  function showErrors() {
    const e = attempted ? validate() : {};
    for (const [k, el] of Object.entries(controls)) {
      errors[k].textContent = e[k] || '';
      if (e[k]) el.setAttribute('aria-invalid', 'true');
      else el.removeAttribute('aria-invalid');
    }
    return e;
  }

  const submitBtn = h('button', { class: 'btn btn--primary', type: 'submit' }, 'Criar negócio');
  const cancelBtn = h('button', { class: 'btn btn--quiet', type: 'button' }, 'Cancelar');

  const form = h(
    'form',
    {
      class: 'pipeline-form',
      novalidate: true,
      onsubmit: (ev) => {
        ev.preventDefault();
        if (busy) return;
        attempted = true;
        const e = showErrors();
        const firstBad = Object.keys(e)[0];
        if (firstBad) {
          controls[firstBad].focus();
          return;
        }
        // Salvamento simulado: deixa o botão ocupado um instante, como faria com um backend.
        busy = true;
        modal.setLocked(true);
        submitBtn.disabled = true;
        cancelBtn.disabled = true;
        replaceChildren(submitBtn, 'Criando…');
        timer = setTimeout(() => {
          const result = createDeal({
            title: title.value.trim(),
            contactId: contact.value === NEW_CONTACT ? null : contact.value,
            newContact: contact.value === NEW_CONTACT ? { name: cname.value.trim(), company: ccompany.value.trim(), phone: cphone.value.trim() } : null,
            value: valueLocked ? 0 : parseMoney(value.value),
            ownerId: owner.value,
            pipelineId: pipeline.id,
            stageId: stage.value,
          });
          busy = false;
          modal.setLocked(false);
          if (!result.ok) {
            // O motor negou (a permissão mudou): mostra o motivo e deixa o usuário corrigir.
            submitBtn.disabled = false;
            cancelBtn.disabled = false;
            replaceChildren(submitBtn, 'Criar negócio');
            errors.owner.textContent = reasonOf(result.decision);
            return;
          }
          modal.close();
          onCreated?.(result.deal);
        }, 450);
      },
      oninput: () => attempted && showErrors(),
      onchange: (ev) => {
        if (ev.target === contact) syncContactBox();
        if (ev.target === owner) syncStages();
        if (attempted) showErrors();
      },
    },
    h('label', { class: 'field' }, 'Título', title, errors.title),
    h('label', { class: 'field' }, 'Contato', contact, errors.contact),
    newContactBox,
    h(
      'div',
      { class: 'pipeline-form__row' },
      h('label', { class: 'field' }, 'Valor (R$)', value, errors.value, valueLocked ? h('span', { class: 'pipeline-hint' }, 'Seu perfil não define o valor.') : null),
      h('label', { class: 'field' }, 'Responsável', owner, errors.owner, h('span', { class: 'pipeline-hint' }, ownerHint))
    ),
    h('label', { class: 'field' }, 'Etapa inicial', stage, errors.stage),
    h('div', { class: 'pipeline-modal__actions' }, cancelBtn, submitBtn)
  );

  const modal = openModal({
    eyebrow: pipeline?.name || 'Pipeline',
    title: 'Novo negócio',
    content: form,
    width: 520,
    onClose: () => clearTimeout(timer),
  });
  cancelBtn.addEventListener('click', () => modal.close());
  return modal;
}
