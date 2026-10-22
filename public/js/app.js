// Shell + roteador por hash (#/inbox). Cada tela é um módulo em
// js/screens/<id>.js com o contrato:
//
//   export default {
//     // el: contêiner vazio (.screen) dentro do <main>; ctx: { store, navigate, route }
//     // Pode ser async. Devolve (opcional) uma função de limpeza — chamada ao sair
//     // da tela: cancele aqui store.subscribe, timers, listeners globais.
//     mount(el, ctx) { ...; return () => {...}; },
//   };
//
// CSS específico da tela: css/screens/<id>.css (carregado sob demanda, se existir).
import { h, icon, ICONS, initials, replaceChildren } from './ui.js';
import { store, applyTheme } from './store.js';
import { applySavedAccent } from './screens/settings/accent.js';
import { canAccess, visible } from './access.js';
import * as live from './live.js';
import { MARK_SRC } from './screens/auth/logo.js';
import * as pwa from './pwa.js';
import { isMobile } from './mobile.js';
import { renderTopbar } from './shell/topbar.js';
import { openPalette } from './search/palette.js';
import { openMenu } from './shell/menu.js';
import { newActions } from './shell/new.js';
import { trackViewport } from './viewport.js';
import { initFx } from './fx.js';
import { totalUnread as chatUnread } from './screens/inbox/chat/actions.js';

pwa.register();
trackViewport(); // teclado e barras do celular: modais medem a área visível de verdade
initFx(); // ondinha ao clicar e brilhos nas conquistas

// shell:false = tela cheia, sem sidebar (login/onboarding).
// require = [entidade, ação] que o motor de permissões exige para abrir a rota
// (some do menu e mostra "acesso negado" se acessada direto pela URL).
const ROUTES = [
  { id: 'login', label: 'Login', shell: false },
  { id: 'onboarding', label: 'Onboarding', shell: false },
  { id: 'accept', label: 'Convite', shell: false },
  { id: 'home', label: 'Início', shell: true, nav: true },
  { id: 'inbox', label: 'Inbox', shell: true, nav: true },
  { id: 'pipeline', label: 'Negócios', shell: true, nav: true, require: ['deal', 'read'] },
  { id: 'contacts', label: 'Contatos', shell: true, nav: true, require: ['contact', 'read'] },
  // página de um negócio: não aparece no menu; o menu destaca Negócios e o caminho da página mostra Negócios › Negócio
  { id: 'deal', label: 'Negócio', shell: true, nav: false, parent: 'pipeline', require: ['deal', 'read'] },
  // perfil da própria pessoa: não aparece no menu (abre pelo nome no menu lateral ou pelo avatar da barra superior)
  { id: 'profile', label: 'Meu perfil', shell: true, nav: false },
  { id: 'tasks', label: 'Tarefas', shell: true, nav: true, require: ['task', 'read'] },
  { id: 'agent', label: 'Agente de IA', shell: true, nav: true, require: ['ai_agent', 'read'] },
  // desktopOnly: no celular a tela é substituída por um aviso (são telas densas, feitas para o computador)
  { id: 'automations', label: 'Automações', shell: true, nav: true, desktopOnly: true, require: ['automation', 'read'] },
  { id: 'dashboard', label: 'Dashboard', shell: true, nav: true, require: ['report', 'read'] },
  { id: 'instances', label: 'Instâncias', shell: true, nav: true, require: ['instance', 'read'] },
  { id: 'funnels', label: 'Funis', shell: true, nav: true, admin: true, desktopOnly: true, require: ['pipeline', 'update'] },
  { id: 'users', label: 'Usuários', shell: true, nav: true, admin: true, desktopOnly: true, require: ['user', 'read'] },
  { id: 'settings', label: 'Configurações', shell: true, nav: true, admin: true, desktopOnly: true, require: ['tenant_settings', 'read'] },
  { id: 'permissions', label: 'Permissões', shell: true, nav: true, admin: true, desktopOnly: true, require: ['role', 'read'] },
];
const allowedRoute = (r) => !r.require || canAccess(r.require[0], r.require[1]);
const DEFAULT_ROUTE = 'home';

const root = document.getElementById('app');
let cleanup = null;
let renderToken = 0;

export function navigate(id) {
  location.hash = `#/${id}`;
}

function currentRoute() {
  const id = location.hash.replace(/^#\/?/, '').split(/[/?]/)[0];
  return ROUTES.find((r) => r.id === id) || ROUTES.find((r) => r.id === DEFAULT_ROUTE);
}

function loadScreenCss(id) {
  const href = `/css/screens/${id}.css`;
  if (document.querySelector(`link[data-screen-css="${id}"]`)) return;
  const link = h('link', { rel: 'stylesheet', href, 'data-screen-css': id });
  // CSS de tela é opcional: se não existir (404), só remove o <link>.
  link.addEventListener('error', () => link.remove());
  document.head.append(link);
}

// Só conta o que o usuário pode ver: o badge não pode vazar que existe conversa alheia.
function unreadTotal() {
  return visible('conversation', store.state.conversations).reduce((n, c) => n + (c.unread || 0), 0) + chatUnread();
}

/** Barra de abas do celular: o que mais se usa na rua. O resto fica no menu ☰. */
function renderTabbar(active) {
  const unread = unreadTotal();
  const tabs = ['home', 'inbox', 'pipeline', 'contacts', 'tasks'].map((id) => ROUTES.find((r) => r.id === id)).filter((r) => r && allowedRoute(r));
  return h(
    'nav',
    { class: 'tabbar', 'aria-label': 'Principal' },
    tabs.map((r) =>
      h(
        'a',
        { class: 'tabbar__item' + (r.id === active ? ' is-active' : ''), href: `#/${r.id}`, 'aria-current': r.id === active ? 'page' : null },
        h('span', { class: 'tabbar__icon' }, icon(ICONS[r.id], 22), r.id === 'inbox' && unread ? h('span', { class: 'tabbar__badge' }, unread > 99 ? '99+' : unread) : null),
        h('span', { class: 'tabbar__label' }, r.label)
      )
    )
  );
}

function renderSidebar(active) {
  const s = store.state;
  const user = store.user();
  const navRoute = (r) => {
    const badge = r.id === 'inbox' ? unreadTotal() : 0;
    return h(
      'a',
      { class: 'nav-item' + (r.id === active ? ' is-active' : ''), href: `#/${r.id}`, 'data-desktop': r.desktopOnly ? 'true' : null },
      icon(ICONS[r.id]),
      h('span', { class: 'nav-item__label' }, r.label),
      badge ? h('span', { class: 'badge' }, badge) : null
    );
  };
  // Só aparece no menu o que o usuário pode abrir (o motor decide; a rota também é protegida).
  const allowed = ROUTES.filter((r) => r.nav && allowedRoute(r));
  const operation = allowed.filter((r) => !r.admin).map(navRoute);
  const admin = allowed.filter((r) => r.admin).map(navRoute);
  const impersonable = s.users.filter((u) => !u.isBot && u.status === 'active');
  const brand = s.tenant.brand.productName || 'TechTie Flow';
  const [first, ...rest] = brand.split(' ');
  return h(
    'aside',
    { class: 'sidebar' },
    h('a', { class: 'brand', href: '#/home', 'aria-label': 'Início' }, h('div', { class: 'brand__mark' }, s.tenant.brand.logo?.dataUrl ? h('img', { src: s.tenant.brand.logo.dataUrl, alt: brand, class: 'brand__logo' }) : /^techtie$/i.test(first) ? h('img', { src: MARK_SRC.small, alt: brand, class: 'brand__logo brand__logo--mark' }) : first[0] || 'T'), h('div', { class: 'brand__text' }, h('span', { class: 'brand__name' }, first), h('span', { class: 'brand__sub' }, (rest.join(' ') || 'FLOW').toUpperCase()))),
    h('div', { class: 'sidebar__group' }, 'OPERAÇÃO'),
    ...operation,
    admin.length ? h('div', { class: 'sidebar__group sidebar__group--spaced' }, 'ADMINISTRAÇÃO') : null,
    ...admin,
    h('div', { class: 'sidebar__spacer' }),
    pwa.shouldOffer() ? h('button', { class: 'sidebar__btn sidebar__install', type: 'button', onclick: () => pwa.install() }, 'Instalar app no celular') : null,
    h('button', { class: 'sidebar__btn', type: 'button', onclick: () => store.setTheme(s.theme === 'dark' ? 'light' : 'dark') }, s.theme === 'dark' ? 'Modo claro' : 'Modo escuro'),
    live.enabled
      ? h('button', { class: 'sidebar__btn sidebar__btn--dashed', type: 'button', onclick: () => live.logout() }, 'Sair')
      : h('button', { class: 'sidebar__btn sidebar__btn--dashed', type: 'button', onclick: () => navigate('login') }, 'Ver login / onboarding'),
    live.enabled ? null : h(
      'label',
      { class: 'sidebar__viewas' },
      h('span', null, 'PROTÓTIPO · VER COMO'),
      h(
        'select',
        {
          class: 'select sidebar__select',
          'aria-label': 'Ver o sistema como outro usuário (somente no protótipo)',
          onchange: (e) => {
            store.update((st) => {
              st.currentUserId = e.target.value;
            });
            // as permissões mudaram: remonta a tela atual (e volta ao início se ela ficou proibida)
            // Se a rota atual ficou proibida, vai para a primeira que o novo usuário pode abrir.
            // Quando o hash não muda (já estava nela), hashchange não dispara — por isso o
            // render() explícito: sem ele a tela do usuário ANTERIOR continuaria montada.
            const target = allowedRoute(currentRoute()) ? null : ROUTES.find((r) => r.nav && allowedRoute(r));
            if (target && location.hash !== `#/${target.id}`) navigate(target.id);
            else render();
          },
        },
        impersonable.map((u) => h('option', { value: u.id, selected: u.id === s.currentUserId }, u.name))
      )
    ),
    h('a', { class: 'sidebar__user', href: '#/profile', title: 'Meu perfil' }, h('div', { class: 'avatar' }, initials(user.name)), h('div', { class: 'sidebar__user-text' }, h('span', { style: 'font-weight:600' }, user.name), h('small', null, `${s.roles.filter((r) => (user.roleIds || []).includes(r.id)).map((r) => r.name).join(', ') || 'Sem perfil'} · ${s.tenant.name}`)))
  );
}

function placeholder(route, err) {
  return h('div', { class: 'empty', style: 'flex:1' }, h('div', { class: 'section-title gold' }, route.label), h('div', null, err ? `Erro ao carregar a tela: ${err.message}` : 'Tela em construção.'));
}

async function render() {
  const token = ++renderToken;
  const route = currentRoute();
  // Modo operação: sem sessão só existem o login e o aceite de convite.
  if (live.enabled && !live.hasToken() && !['login', 'accept'].includes(route.id)) {
    location.hash = '#/login';
    return;
  }
  applyTheme();

  if (cleanup) {
    try {
      cleanup();
    } catch (e) {
      console.error('[app] erro na limpeza da tela anterior:', e);
    }
    cleanup = null;
  }

  const screenEl = h('div', { class: 'screen', 'data-screen': route.id });
  let unsubSidebar = null;

  if (route.shell) {
    const sidebarHost = h('div', { class: 'sidebar-host' });
    const tabHost = h('div', { class: 'sidebar-host' });
    const topHost = h('div', { class: 'sidebar-host' });
    const parent = route.parent ? ROUTES.find((r) => r.id === route.parent) : null;
    const crumbs = parent ? [{ label: parent.label, href: `#/${parent.id}` }, { label: route.label }] : [{ label: route.label }];
    // menu lateral recolhido (só ícones) — a escolha fica guardada neste navegador
    const COLLAPSE_KEY = 'ttf:sidebar';
    const toggleSidebar = () => {
      const on = app.classList.toggle('is-collapsed');
      try {
        localStorage.setItem(COLLAPSE_KEY, on ? 'collapsed' : 'open');
      } catch {
        /* sem armazenamento: só não lembra */
      }
    };
    const draw = () => {
      replaceChildren(sidebarHost, renderSidebar(route.parent || route.id));
      replaceChildren(tabHost, renderTabbar(route.parent || route.id));
      replaceChildren(topHost, renderTopbar({ crumbs, onToggleSidebar: toggleSidebar, navigate }));
    };
    const unsubStore = store.subscribe(draw);
    const unsubPwa = pwa.onChange(draw);
    unsubSidebar = () => (unsubStore(), unsubPwa());
    // Celular: a barra lateral vira um menu que abre por cima (botão ☰); fechar ao escolher uma tela,
    // tocar fora ou apertar Esc. Em tela larga estes dois elementos ficam escondidos (CSS).
    const app = h('div', { class: 'app' });
    try {
      if (localStorage.getItem(COLLAPSE_KEY) === 'collapsed') app.classList.add('is-collapsed');
    } catch {
      /* sem armazenamento */
    }
    draw();
    const setNav = (open) => app.classList.toggle('is-nav-open', open);
    const mobilebar = h(
      'header',
      { class: 'mobilebar' },
      h('button', { class: 'mobilebar__btn', type: 'button', 'aria-label': 'Abrir menu', onclick: () => setNav(!app.classList.contains('is-nav-open')) }, icon('M4 6h16M4 12h16M4 18h16', 22)),
      h('img', { class: 'mobilebar__logo', src: MARK_SRC.small, alt: '' }),
      h('span', { class: 'mobilebar__title' }, route.label),
      h('button', { class: 'mobilebar__btn mobilebar__search', type: 'button', 'aria-label': 'Buscar', onclick: () => openPalette() }, icon('M21 21l-4.3-4.3M17 10.5a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0z', 22)),
      (() => {
        const plus = h('button', { class: 'mobilebar__btn', type: 'button', 'aria-label': 'Criar novo', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, icon('M12 5v14M5 12h14', 22));
        plus.addEventListener('click', () => openMenu(plus, newActions().map((a) => ({ label: a.label, hint: a.hint, disabled: a.disabled, reason: a.reason, onSelect: a.run })), { align: 'right' }));
        return plus;
      })()
    );
    const backdrop = h('div', { class: 'nav-backdrop', onclick: () => setNav(false) });
    sidebarHost.addEventListener('click', (e) => e.target.closest('.nav-item') && setNav(false));
    app.addEventListener('keydown', (e) => e.key === 'Escape' && setNav(false));
    app.append(mobilebar, backdrop, sidebarHost, h('main', { class: 'app__main' }, topHost, screenEl), tabHost);
    replaceChildren(root, app);
  } else {
    replaceChildren(root, h('div', { class: 'app' }, h('main', { class: 'app__main' }, screenEl)));
  }

  document.title = `${route.label} · ${store.state.tenant.brand.productName}`;
  loadScreenCss(route.id);

  let screenCleanup = null;
  try {
    if (!allowedRoute(route)) {
      replaceChildren(screenEl, h('div', { class: 'empty', style: 'flex:1' }, h('div', { class: 'section-title gold' }, 'Acesso negado'), h('div', null, `Seu perfil não tem acesso a "${route.label}".`), h('div', { class: 'muted' }, 'Peça acesso a um administrador da sua empresa.')));
      cleanup = () => unsubSidebar?.();
      return;
    }
    if (route.desktopOnly && isMobile()) {
      replaceChildren(
        screenEl,
        h(
          'div',
          { class: 'desktop-only' },
          h('span', { class: 'desktop-only__icon' }, icon(ICONS.desktop, 34)),
          h('h1', { class: 'desktop-only__title' }, `${route.label} é no computador`),
          h('p', { class: 'desktop-only__text' }, 'Esta tela é densa demais para o celular. Abra o TechTie Flow no computador para usá-la; aqui ficam o atendimento, os negócios, os contatos e o dashboard.'),
          h('a', { class: 'btn btn--primary desktop-only__btn', href: '#/home' }, 'Voltar ao Início')
        )
      );
      cleanup = () => unsubSidebar?.();
      return;
    }
    const mod = await import(`./screens/${route.id}.js`);
    if (token !== renderToken) return; // navegou de novo enquanto carregava
    screenCleanup = await mod.default.mount(screenEl, { store, navigate, route });
  } catch (err) {
    console.error(`[app] falha ao montar a tela "${route.id}":`, err);
    if (token === renderToken) replaceChildren(screenEl, placeholder(route, err.code === 'MODULE_NOT_FOUND' ? null : err));
  }

  if (token !== renderToken) {
    // Chegou tarde: a navegação já seguiu em frente — limpa o que acabou de montar.
    if (typeof screenCleanup === 'function') screenCleanup();
    return;
  }
  cleanup = () => {
    unsubSidebar?.();
    if (typeof screenCleanup === 'function') screenCleanup();
  };
}

window.addEventListener('hashchange', render);

// Atalho global da busca: Ctrl+K / ⌘K (e "/" fora de campos de texto). Só nas telas com menu (não no login).
document.addEventListener('keydown', (e) => {
  if (!currentRoute().shell) return;
  const typing = /^(input|textarea|select)$/i.test(e.target?.tagName || '') || e.target?.isContentEditable;
  if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'k') {
    e.preventDefault();
    openPalette();
  } else if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    openPalette();
  }
});
store.subscribe(() => applyTheme());
// Cor de destaque escolhida em Configurações precisa valer em qualquer tela
// depois de recarregar, não só quando aquela tela é aberta.
applySavedAccent();

async function boot() {
  // Modo operação com sessão guardada: carrega os dados reais ANTES do primeiro desenho.
  if (live.enabled && live.hasToken()) {
    try {
      await live.hydrate();
    } catch {
      /* sessão inválida: o guarda de rota leva ao login */
    }
  }
  render();
}
boot();
