// Formulário de contato (novo/edição) e exclusão — usados pela tela Contatos e pelo "+ Novo" da barra superior.
// Em operação espera o servidor (o ID e as regras são dele); no protótipo grava só no navegador.
import { h, toast } from '../../ui.js';
import { fieldLevel, decide, audit } from '../../access.js';
import { store } from '../../store.js';
import * as live from '../../live.js';
import { ensureScreenCss } from '../../css.js';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Diálogo simples (sobreposição + cartão). Devolve { close }. Esc e clique fora fecham. */
export function openDialog({ title, eyebrow, content }) {
  ensureScreenCss('contacts');
  const prev = document.activeElement;
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    prev?.focus?.();
  };
  const onKey = (e) => e.key === 'Escape' && close();
  const overlay = h('div', { class: 'contacts-overlay', onmousedown: (e) => e.target === overlay && close() }, h('div', { class: 'contacts-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, eyebrow ? h('div', { class: 'eyebrow' }, eyebrow) : null, h('h2', { class: 'contacts-dialog__title' }, title), content));
  document.body.append(overlay);
  document.addEventListener('keydown', onKey, true);
  overlay.querySelector('[data-autofocus]')?.focus();
  return { close };
}

/** O usuário atual pode criar contato? (a tarefa nasce dele: dono = ele, equipe = a primeira dele) */
export const canCreateContact = () => decide('contact', 'create', { ownerId: store.state.currentUserId, teamId: store.user()?.teamIds?.[0] ?? null }).effect === 'allow';

/** Protótipo (sem servidor): grava só no navegador. */
function saveLocal(contact, body) {
  let out;
  store.update((s) => {
    const phone = body.phone ? `+${body.phone}` : '';
    if (contact) {
      out = s.contacts.find((c) => c.id === contact.id);
      Object.assign(out, { name: body.name, company: body.company, ...(body.phone !== undefined ? { phone } : {}), ...(body.email !== undefined ? { email: body.email } : {}) });
    } else {
      out = { id: `c_${Date.now().toString(36)}`, name: body.name, company: body.company, phone, email: body.email || '', ownerId: s.currentUserId, source: 'manual', tags: [] };
      s.contacts.push(out);
    }
  });
  audit(contact ? 'contact.update' : 'contact.create', out.id, `Contato "${out.name}" ${contact ? 'alterado' : 'criado'}`);
  return out;
}

/** @param contact contato existente (edição) ou null (novo) · @param onSaved(contato salvo) */
export function openContactForm({ contact = null, onSaved } = {}) {
  const editing = !!contact;
  const phoneHidden = editing && fieldLevel('contact', 'phone') === 'hidden';
  const emailHidden = editing && fieldLevel('contact', 'email') === 'hidden';
  const f = {
    name: h('input', { class: 'input', type: 'text', maxlength: '200', value: contact?.name || '', 'data-autofocus': true, autocomplete: 'off' }),
    company: h('input', { class: 'input', type: 'text', maxlength: '200', value: contact?.company || '', autocomplete: 'off' }),
    phone: h('input', { class: 'input', type: 'tel', inputmode: 'tel', value: phoneHidden ? '' : contact?.phone || '', placeholder: '+55 11 99999-9999', disabled: phoneHidden, autocomplete: 'off' }),
    email: h('input', { class: 'input', type: 'email', value: emailHidden ? '' : contact?.email || '', placeholder: 'nome@empresa.com.br', disabled: emailHidden, autocomplete: 'off' }),
  };
  const error = h('span', { class: 'field-error', role: 'alert' });
  const save = h('button', { class: 'btn btn--primary', type: 'submit' }, editing ? 'Salvar' : 'Criar contato');
  const cancel = h('button', { class: 'btn btn--quiet', type: 'button' }, 'Cancelar');
  const dlg = openDialog({
    eyebrow: 'CONTATO',
    title: editing ? 'Editar contato' : 'Novo contato',
    content: h(
      'form',
      {
        class: 'contacts-form',
        novalidate: true,
        onsubmit: async (e) => {
          e.preventDefault();
          error.textContent = '';
          const name = f.name.value.trim();
          const phoneDigits = f.phone.value.replace(/\D/g, '');
          const email = f.email.value.trim();
          if (!name) return (error.textContent = 'Informe o nome.');
          if (phoneDigits && !/^[0-9]{8,15}$/.test(phoneDigits)) return (error.textContent = 'Telefone inválido: use de 8 a 15 dígitos (com DDD).');
          if (email && !EMAIL.test(email)) return (error.textContent = 'E-mail inválido.');
          save.disabled = true;
          try {
            const body = { name, company: f.company.value.trim() };
            if (!phoneHidden) body.phone = phoneDigits;
            if (!emailHidden) body.email = email;
            const saved = live.enabled ? (editing ? await live.updateContact(contact.id, body) : await live.createContact(body)) : saveLocal(contact, body);
            dlg.close();
            toast(editing ? 'Contato atualizado' : 'Contato criado');
            onSaved?.(saved);
          } catch (err) {
            error.textContent = err.message || 'Não foi possível salvar.';
            save.disabled = false;
          }
        },
      },
      h('label', { class: 'field' }, 'Nome', f.name),
      h('label', { class: 'field' }, 'Empresa', f.company),
      h('label', { class: 'field' }, 'Telefone (WhatsApp)', f.phone),
      h('label', { class: 'field' }, 'E-mail', f.email),
      error,
      h('div', { class: 'contacts-form__actions' }, cancel, save)
    ),
  });
  cancel.addEventListener('click', () => dlg.close());
  return dlg;
}

export function openDeleteContact({ contact, onDeleted }) {
  const ok = h('button', { class: 'btn btn--primary', type: 'button' }, 'Excluir contato');
  const cancel = h('button', { class: 'btn btn--quiet', type: 'button', 'data-autofocus': true }, 'Cancelar');
  const error = h('span', { class: 'field-error', role: 'alert' });
  const dlg = openDialog({ eyebrow: 'AÇÃO SEM VOLTA', title: 'Excluir este contato?', content: h('div', { class: 'contacts-form' }, h('p', { class: 'muted' }, `“${contact.name}” será removido. Contatos com conversas ou negócios não podem ser excluídos, para não perder o histórico.`), error, h('div', { class: 'contacts-form__actions' }, cancel, ok)) });
  cancel.addEventListener('click', () => dlg.close());
  ok.addEventListener('click', async () => {
    ok.disabled = true;
    try {
      if (live.enabled) await live.deleteContact(contact.id);
      else {
        if (store.state.deals.some((d) => d.contactId === contact.id) || store.state.conversations.some((cv) => cv.contactId === contact.id)) throw new Error('Este contato tem negócios ou conversas e não pode ser excluído.');
        store.update((s) => (s.contacts = s.contacts.filter((c) => c.id !== contact.id)));
        audit('contact.delete', contact.id, `Contato "${contact.name}" excluído`);
      }
      dlg.close();
      toast('Contato excluído');
      onDeleted?.();
    } catch (err) {
      error.textContent = err.message || 'Não foi possível excluir.';
      ok.disabled = false;
    }
  });
  return dlg;
}
