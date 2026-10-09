// #/login — hero + formulário. Autenticação SIMULADA: e-mail válido e senha
// preenchida passam na validação; senha curta (< 6) vira "credenciais
// inválidas" depois do loading; qualquer outra senha entra.
import { h, icon, toast } from '../ui.js';
import { AUTH_ICONS, EMAIL_RE, authBrand, ensureAuthCss, spinner, themeToggle } from './auth/common.js';

const FAKE_LATENCY_MS = 650;
const MIN_PASSWORD = 6;

export default {
  mount(el, { store, navigate }) {
    ensureAuthCss();
    let timer = null;
    let busy = false;

    const emailErr = h('p', { class: 'field-error', id: 'login-email-err', 'aria-live': 'polite' });
    const passErr = h('p', { class: 'field-error', id: 'login-pass-err', 'aria-live': 'polite' });
    const emailInput = h('input', {
      class: 'input',
      id: 'login-email',
      name: 'email',
      type: 'email',
      autocomplete: 'username',
      inputmode: 'email',
      spellcheck: 'false',
      'aria-describedby': 'login-email-err',
      value: 'marina@acme.com.br',
    });
    const passInput = h('input', {
      class: 'input login-pass__input',
      id: 'login-pass',
      name: 'password',
      type: 'password',
      autocomplete: 'current-password',
      'aria-describedby': 'login-pass-err',
    });
    const eyeBtn = h('button', { class: 'login-pass__eye', type: 'button', 'aria-label': 'Mostrar senha', 'aria-pressed': 'false' }, icon(AUTH_ICONS.eye, 18));
    const alertBox = h('div', { class: 'login-alert', role: 'alert', hidden: true }, icon(AUTH_ICONS.alert, 16), h('span', null, 'E-mail ou senha incorretos. Confira os dados e tente de novo.'));
    const submitBtn = h('button', { class: 'btn btn--primary login-submit', type: 'submit' }, 'Entrar');

    function setError(input, errEl, msg) {
      errEl.textContent = msg || '';
      if (msg) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
      return !msg;
    }
    const checkEmail = () => {
      const v = emailInput.value.trim();
      return setError(emailInput, emailErr, !v ? 'Informe o e-mail.' : EMAIL_RE.test(v) ? '' : 'Informe um e-mail válido, como nome@empresa.com.br.');
    };
    const checkPass = () => setError(passInput, passErr, passInput.value ? '' : 'Informe a senha.');

    function setBusy(on) {
      busy = on;
      submitBtn.disabled = on;
      submitBtn.replaceChildren(...(on ? [spinner(), h('span', null, 'Entrando…')] : ['Entrar']));
      submitBtn.setAttribute('aria-busy', String(on));
    }

    emailInput.addEventListener('blur', () => emailInput.value && checkEmail());
    emailInput.addEventListener('input', () => {
      alertBox.hidden = true;
      if (emailInput.hasAttribute('aria-invalid')) checkEmail();
    });
    passInput.addEventListener('input', () => {
      alertBox.hidden = true;
      if (passInput.hasAttribute('aria-invalid')) checkPass();
    });
    eyeBtn.addEventListener('click', () => {
      const show = passInput.type === 'password';
      passInput.type = show ? 'text' : 'password';
      eyeBtn.setAttribute('aria-pressed', String(show));
      eyeBtn.setAttribute('aria-label', show ? 'Ocultar senha' : 'Mostrar senha');
      eyeBtn.replaceChildren(icon(show ? AUTH_ICONS.eyeOff : AUTH_ICONS.eye, 18));
    });

    const form = h(
      'form',
      { class: 'login-form auth-form', novalidate: true, 'aria-labelledby': 'login-title' },
      h('h2', { class: 'login-form__title', id: 'login-title' }, 'ENTRAR'),
      alertBox,
      h('div', { class: 'field' }, h('label', { for: 'login-email' }, 'E-mail'), emailInput, emailErr),
      h('div', { class: 'field' }, h('label', { for: 'login-pass' }, 'Senha'), h('div', { class: 'login-pass' }, passInput, eyeBtn), passErr),
      h(
        'button',
        {
          class: 'auth-link login-forgot',
          type: 'button',
          onclick: () => {
            if (!checkEmail()) return emailInput.focus();
            toast(`Enviamos um link de redefinição para ${emailInput.value.trim()} (demo).`);
          },
        },
        'Esqueci a senha'
      ),
      submitBtn,
      h('button', { class: 'btn btn--ghost login-create', type: 'button', onclick: () => navigate('onboarding') }, 'Criar conta da empresa'),
      h('p', { class: 'login-hint' }, 'Protótipo: use qualquer e-mail válido e uma senha com 6 caracteres ou mais.')
    );

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (busy) return;
      alertBox.hidden = true;
      const okEmail = checkEmail();
      const okPass = checkPass();
      if (!okEmail || !okPass) return (okEmail ? passInput : emailInput).focus();

      setBusy(true);
      timer = setTimeout(() => {
        timer = null;
        if (passInput.value.length < MIN_PASSWORD) {
          setBusy(false);
          alertBox.hidden = false;
          passInput.focus();
          passInput.select();
          return;
        }
        // Se o e-mail for de um usuário do mock, entra como ele; senão segue como o padrão.
        const email = emailInput.value.trim().toLowerCase();
        store.update((s) => {
          const user = s.users.find((u) => u.email && u.email.toLowerCase() === email);
          if (user) s.currentUserId = user.id;
          s.session.loggedIn = true;
        });
        navigate('inbox');
      }, FAKE_LATENCY_MS);
    });

    el.append(
      h(
        'div',
        { class: 'login' },
        h('div', { class: 'login__top' }, themeToggle()),
        h(
          'section',
          { class: 'login-hero', 'aria-label': 'Apresentação' },
          authBrand({ large: true }),
          h('div', { class: 'login-hero__eyebrow' }, 'CRM + CONTACT CENTER'),
          h('h1', { class: 'login-hero__title' }, h('span', { class: 'login-hero__strong' }, 'ATENDA, VENDA E AUTOMATIZE'), h('span', { class: 'login-hero__light' }, 'TUDO NO MESMO LUGAR.')),
          h('p', { class: 'login-hero__lead' }, 'WhatsApp, funil de vendas, agente de IA e BI em uma plataforma só — sem depender de outro CRM.')
        ),
        h('section', { class: 'login-panel' }, h('div', { class: 'login-panel__inner' }, form))
      )
    );

    return () => {
      clearTimeout(timer);
    };
  },
};
