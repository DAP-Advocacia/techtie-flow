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

// shell:false = tela cheia, sem sidebar (login/onboarding).
// require = [entidade, ação] que o motor de permissões exige para abrir a rota
// (some do menu e mostra "acesso negado" se acessada direto pela URL).
const ROUTES = [
  { id: 'login', label: 'Login', shell: false },
  { id: 'onboarding', label: 'Onboarding', shell: false },
  { id: 'inbox', label: 'Inbox', shell: true, nav: true, require: ['conversation', 'read'] },
  { id: 'pipeline', label: 'Negócios', shell: true, nav: true, require: ['deal', 'read'] },
  { id: 'agent', label: 'Agente de IA', shell: true, nav: true, require: ['ai_agent', 'read'] },
  { id: 'automations', label: 'Automações', shell: true, nav: true, require: ['automation', 'read'] },
  { id: 'dashboard', label: 'Dashboard', shell: true, nav: true, require: ['report', 'read'] },
  { id: 'instances', label: 'Instâncias', shell: true, nav: true, require: ['instance', 'read'] },
  { id: 'users', label: 'Usuários', shell: true, nav: true, admin: true, require: ['user', 'read'] },
  { id: 'settings', label: 'Configurações', shell: true, nav: true, admin: true, require: ['tenant_settings', 'read'] },
  { id: 'permissions', label: 'Permissões', shell: true, nav: true, admin: true, require: ['role', 'read'] },
];
const allowedRoute = (r) => !r.require || canAccess(r.require[0], r.require[1]);
const DEFAULT_ROUTE = 'inbox';

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
  return visible('conversation', store.state.conversations).reduce((n, c) => n + (c.unread || 0), 0);
}

function renderSidebar(active) {
  const s = store.state;
  const user = store.user();
  const navRoute = (r) => {
    const badge = r.id === 'inbox' ? unreadTotal() : 0;
    return h(
      'a',
      { class: 'nav-item' + (r.id === active ? ' is-active' : ''), href: `#/${r.id}` },
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
    h('div', { class: 'brand' }, h('div', { class: 'brand__mark' }, s.tenant.brand.logo?.dataUrl ? h('img', { src: s.tenant.brand.logo.dataUrl, alt: brand, class: 'brand__logo' }) : first[0] || 'T'), h('div', { class: 'brand__text' }, h('span', { class: 'brand__name' }, first), h('span', { class: 'brand__sub' }, (rest.join(' ') || 'FLOW').toUpperCase()))),
    h('div', { class: 'sidebar__group' }, 'OPERAÇÃO'),
    ...operation,
    admin.length ? h('div', { class: 'sidebar__group sidebar__group--spaced' }, 'ADMINISTRAÇÃO') : null,
    ...admin,
    h('div', { class: 'sidebar__spacer' }),
    h('button', { class: 'sidebar__btn', type: 'button', onclick: () => store.setTheme(s.theme === 'dark' ? 'light' : 'dark') }, s.theme === 'dark' ? 'Modo claro' : 'Modo escuro'),
    h('button', { class: 'sidebar__btn sidebar__btn--dashed', type: 'button', onclick: () => navigate('login') }, 'Ver login / onboarding'),
    h(
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
    h('div', { class: 'sidebar__user' }, h('div', { class: 'avatar' }, initials(user.name)), h('div', { class: 'sidebar__user-text' }, h('span', { style: 'font-weight:600' }, user.name), h('small', null, `${s.roles.filter((r) => (user.roleIds || []).includes(r.id)).map((r) => r.name).join(', ') || 'Sem perfil'} · ${s.tenant.name}`)))
  );
}

function placeholder(route, err) {
  return h('div', { class: 'empty', style: 'flex:1' }, h('div', { class: 'section-title gold' }, route.label), h('div', null, err ? `Erro ao carregar a tela: ${err.message}` : 'Tela em construção.'));
}

async function render() {
  const token = ++renderToken;
  const route = currentRoute();
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
    const sidebarHost = h('div', { style: 'display:contents' });
    const draw = () => replaceChildren(sidebarHost, renderSidebar(route.id));
    draw();
    unsubSidebar = store.subscribe(draw);
    replaceChildren(root, h('div', { class: 'app' }, sidebarHost, h('main', { class: 'app__main' }, screenEl)));
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
store.subscribe(() => applyTheme());
// Cor de destaque escolhida em Configurações precisa valer em qualquer tela
// depois de recarregar, não só quando aquela tela é aberta.
applySavedAccent();
render();
