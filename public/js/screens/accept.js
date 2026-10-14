// Aceite de convite (#/accept?token=…): a pessoa convidada define a senha e passa a poder entrar.
import { h, replaceChildren, toast } from '../ui.js';
import * as live from '../live.js';

export default {
  mount(el, { navigate }) {
    const token = new URLSearchParams(location.hash.split('?')[1] || '').get('token') || '';
    const pass = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', minlength: '10', 'aria-label': 'Nova senha' });
    const again = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', 'aria-label': 'Repita a senha' });
    const err = h('div', { class: 'field-error', role: 'alert' });
    const btn = h('button', { class: 'btn btn--primary btn--block', type: 'submit' }, 'Definir senha e entrar');

    const submit = async (e) => {
      e.preventDefault();
      err.textContent = '';
      if (!token) return (err.textContent = 'Link de convite inválido.');
      if (pass.value.length < 10) return (err.textContent = 'A senha precisa ter pelo menos 10 caracteres.');
      if (pass.value !== again.value) return (err.textContent = 'As senhas não são iguais.');
      btn.disabled = true;
      try {
        await live.acceptInvite(token, pass.value);
        toast('Senha definida. Agora é só entrar.');
        navigate('login');
      } catch (ex) {
        err.textContent = ex.message;
        btn.disabled = false;
      }
    };

    replaceChildren(
      el,
      h('div', { style: 'flex:1;display:grid;place-items:center;padding:32px;background:var(--bg)' },
        h('form', { class: 'card', style: 'width:100%;max-width:400px;gap:16px', onsubmit: submit, novalidate: true },
          h('h1', { class: 'section-title gold' }, 'Bem-vindo(a)'),
          h('p', { class: 'muted' }, 'Defina uma senha para ativar o seu acesso.'),
          h('label', { class: 'field' }, 'Nova senha', pass),
          h('label', { class: 'field' }, 'Repita a senha', again),
          err,
          btn))
    );
    pass.focus();
  },
};
