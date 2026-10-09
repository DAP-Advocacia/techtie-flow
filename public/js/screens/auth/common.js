// Peças compartilhadas entre #/login e #/onboarding (telas sem sidebar).
import { h, icon } from '../../ui.js';
import { store } from '../../store.js';

export const AUTH_ICONS = {
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  eyeOff: 'M3 3l18 18M10.6 6.1A9.8 9.8 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4M6.3 6.8C3.8 8.5 2 12 2 12s3.5 7 10 7c1.6 0 3-.4 4.3-1M9.9 9.9a3 3 0 0 0 4.2 4.2',
  check: 'M5 12.5l4.5 4.5L19 7',
  back: 'M19 12H5M11 6l-6 6 6 6',
  refresh: 'M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5',
  alert: 'M12 3l9.5 16.5h-19zM12 10v4M12 17v.01',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM9 12l2 2 4-4',
  phone:'M7 2h10a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zM11 18h2',
};

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * As regras .auth-* (marca, botão de tema, spinner, formulário) vivem em
 * login.css. O roteador só carrega o CSS da rota atual, então o onboarding
 * garante o link aqui; o data-screen-css igual ao do roteador evita duplicar.
 */
export function ensureAuthCss() {
  if (document.querySelector('link[data-screen-css="login"]')) return;
  document.head.append(h('link', { rel: 'stylesheet', href: '/css/screens/login.css', 'data-screen-css': 'login' }));
}

/** Marca (quadrado com a inicial + nome do produto em caixa-alta). */
export function authBrand({ large = false } = {}) {
  const name = (store.state.tenant.brand.productName || 'TechTie Flow').toUpperCase();
  return h(
    'div',
    { class: 'auth-brand' + (large ? ' auth-brand--lg' : '') },
    h('div', { class: 'auth-brand__mark', 'aria-hidden': 'true' }, name[0] || 'T'),
    h('span', { class: 'auth-brand__name' }, name)
  );
}

/** Alternância de tema discreta — nestas telas não há sidebar para isso. */
export function themeToggle() {
  const btn = h('button', { class: 'auth-theme', type: 'button' });
  const paint = () => {
    const dark = store.state.theme === 'dark';
    btn.replaceChildren(icon(dark ? AUTH_ICONS.sun : AUTH_ICONS.moon, 16), h('span', null, dark ? 'Modo claro' : 'Modo escuro'));
    btn.setAttribute('aria-label', dark ? 'Alternar para o modo claro' : 'Alternar para o modo escuro');
  };
  btn.addEventListener('click', () => {
    store.setTheme(store.state.theme === 'dark' ? 'light' : 'dark');
    paint();
  });
  paint();
  return btn;
}

/** Spinner que herda a cor do texto (currentColor). */
export const spinner = () => h('span', { class: 'auth-spinner', 'aria-hidden': 'true' });
