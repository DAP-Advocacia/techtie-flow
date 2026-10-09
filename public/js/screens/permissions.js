// Permissões (#/permissions) — a tela de administração do modelo de acesso.
//
// UI é REFLEXO, não barreira: nada aqui decide acesso sozinho. Quem pode abrir a
// tela, editar perfil, atribuir, suspender, ver auditoria ou mudar a política é
// SEMPRE o motor (decide/canAccess em access.js); e toda gravação passa por
// permissions/actions.js, que repete validateRole / checkNoEscalation /
// wouldRemoveLastAdmin / decide antes de escrever no store. Os botões
// desabilitados com dica são cortesia para quem lê — se alguém forçar a chamada,
// o motor recusa do mesmo jeito.
//
// Estado de tela (aba, rascunhos, filtros, simulador) vive em closures — por
// isso re-renderizar por mudança do store (keepUi) não perde edição em andamento.
import { h, icon, replaceChildren, toast } from '../ui.js';
import { canAccess } from '../access.js';
import { createRolesTab } from './permissions/roles-tab.js';
import { createUsersTab } from './permissions/users-tab.js';
import { createSimulatorTab } from './permissions/simulator-tab.js';
import { createAuditTab } from './permissions/audit-tab.js';
import { createPolicyTab } from './permissions/policy-tab.js';
import { closeAllDialogs, closePopover } from './permissions/dialog.js';
import { keepUi, ICON } from './permissions/util.js';

const TABS = [
  { id: 'roles', label: 'Perfis', make: createRolesTab },
  { id: 'users', label: 'Usuários', make: createUsersTab },
  { id: 'simulator', label: 'Simulador', make: createSimulatorTab },
  { id: 'audit', label: 'Auditoria', make: createAuditTab },
  { id: 'policy', label: 'Política', make: createPolicyTab },
];

/** Aba inicial: #/permissions/<aba> (a rota é a mesma; só lemos o 2º segmento). */
function tabFromHash() {
  const seg = location.hash.replace(/^#\/?/, '').split(/[/?]/)[1];
  return TABS.some((t) => t.id === seg) ? seg : 'roles';
}

export default {
  mount(el, { store }) {
    let active = tabFromHash();
    const tabs = new Map(); // id -> instância (criada na 1ª visita)
    const sigs = new Map();
    const stale = new Set();
    const panels = new Map();

    const tablist = h('div', { class: 'pills perm-tabs', role: 'tablist', 'aria-label': 'Seções de permissões' });
    const panelsHost = h('div', { class: 'perm-panels' });
    const root = h(
      'div',
      { class: 'page perm' },
      h('div', { class: 'perm__wrap' }, h('header', { class: 'page-header' }, h('div', { class: 'grow' }, h('div', { class: 'eyebrow' }, 'Administração'), h('h1', { class: 'page-title' }, 'Permissões')), tablist), panelsHost)
    );
    replaceChildren(el, root);

    // ---------------------------------------------------------- abas
    const auditLocked = () => !canAccess('audit_log', 'read');
    const rolesUnsaved = () => !!tabs.get('roles')?.hasUnsaved();

    function renderTabs() {
      keepUi(tablist, () =>
        replaceChildren(
          tablist,
          TABS.map((t) => {
            const locked = t.id === 'audit' && auditLocked();
            const dirty = t.id === 'roles' && rolesUnsaved();
            return h(
              'button',
              {
                class: 'pill perm-tab' + (t.id === active ? ' is-active' : ''),
                type: 'button',
                role: 'tab',
                id: `perm-tab-${t.id}`,
                'aria-selected': String(t.id === active),
                'aria-controls': `perm-panel-${t.id}`,
                tabindex: t.id === active ? '0' : '-1',
                'data-fk': `tab:${t.id}`,
                onclick: () => setTab(t.id),
                onkeydown: (e) => onTabKey(e, t.id),
              },
              t.label,
              locked ? h('span', { class: 'perm-tab__ico', title: 'Bloqueada para o seu perfil' }, icon(ICON.lock, 12), h('span', { class: 'perm-sr' }, ' (bloqueada)')) : null,
              dirty ? h('span', { class: 'perm-dirty', title: 'Há perfis com alterações não salvas' }, h('span', { 'aria-hidden': 'true' }, '●'), h('span', { class: 'perm-sr' }, ' alterações não salvas')) : null
            );
          })
        )
      );
    }

    function onTabKey(e, id) {
      const i = TABS.findIndex((t) => t.id === id);
      const to = { ArrowRight: (i + 1) % TABS.length, ArrowLeft: (i - 1 + TABS.length) % TABS.length, Home: 0, End: TABS.length - 1 }[e.key];
      if (to === undefined) return;
      e.preventDefault();
      setTab(TABS[to].id, { focus: true });
    }

    function ensure(id) {
      if (tabs.has(id)) return tabs.get(id);
      const def = TABS.find((t) => t.id === id);
      const inst = def.make({ store, onDirtyChange: () => renderTabs() });
      tabs.set(id, inst);
      sigs.set(id, inst.sig());
      const panel = h('div', { class: 'perm-panel', role: 'tabpanel', id: `perm-panel-${id}`, 'aria-labelledby': `perm-tab-${id}`, hidden: true, tabindex: '-1' }, inst.el);
      panels.set(id, panel);
      panelsHost.append(panel);
      return inst;
    }

    function setTab(id, { focus = false } = {}) {
      if (id === active && tabs.has(id)) {
        if (focus) el.querySelector(`#perm-tab-${id}`)?.focus();
        return;
      }
      const leaving = active;
      active = id;
      const inst = ensure(id);
      if (stale.has(id)) {
        stale.delete(id);
        inst.refresh();
        sigs.set(id, inst.sig());
      }
      for (const [pid, p] of panels) p.hidden = pid !== id;
      // não perde o rascunho ao trocar de aba, mas avisa que ele continua pendente
      if (leaving === 'roles' && tabs.get('roles')?.hasUnsaved()) {
        const names = tabs.get('roles').unsavedNames();
        toast(`Rascunho preservado em Perfis: ${names.slice(0, 2).join(', ')}${names.length > 2 ? '…' : ''} — ainda não salvo.`, 3600);
      }
      // aba na URL (replaceState não dispara hashchange, então a tela não remonta)
      try {
        history.replaceState(null, '', id === 'roles' ? '#/permissions' : `#/permissions/${id}`);
      } catch {
        /* sem history: só não deep-linka */
      }
      renderTabs();
      if (focus) el.querySelector(`#perm-tab-${id}`)?.focus();
    }

    // ----------------------------------------------- store → re-render
    const unsub = store.subscribe(() => {
      for (const [id, inst] of tabs) {
        let sig;
        try {
          sig = inst.sig();
        } catch {
          sig = null;
        }
        if (sig === sigs.get(id)) continue;
        sigs.set(id, sig);
        if (id === active) inst.refresh();
        else stale.add(id);
      }
      renderTabs();
    });

    // alterações não salvas + recarregar/fechar a página
    const onBeforeUnload = (e) => {
      if (!rolesUnsaved()) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);

    ensure(active);
    for (const [pid, p] of panels) p.hidden = pid !== active;
    renderTabs();

    return () => {
      unsub();
      window.removeEventListener('beforeunload', onBeforeUnload);
      closeAllDialogs();
      closePopover();
      for (const inst of tabs.values()) inst.destroy?.();
      tabs.clear();
    };
  },
};
