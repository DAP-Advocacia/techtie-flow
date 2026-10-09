// Card PERFIS DE ACESSO em Configurações: resumo e atalho. A gestão de verdade
// (matriz, partições, campos, usuários, auditoria, simulador) mora em #/permissions.
import { h, replaceChildren } from '../../ui.js';
import { canAccess } from '../../access.js';

export function createRolesCard(store) {
  const rolesEl = h('div', { class: 'settings-list settings-list--tight' });
  const footEl = h('div', null);

  function render() {
    const { roles, users } = store.state;
    replaceChildren(
      rolesEl,
      roles.map((r) => {
        const n = users.filter((u) => (u.roleIds || []).includes(r.id) && !u.isBot).length;
        return h(
          'div',
          { class: 'settings-role', style: 'flex-direction:column;align-items:flex-start;gap:2px' },
          h('span', { class: 'settings-row__title' }, r.name, r.system ? h('span', { class: 'chip', style: 'margin-left:8px' }, 'sistema') : null),
          h('span', { class: 'settings-hint' }, `${r.description || ''}${r.description ? ' · ' : ''}${n} ${n === 1 ? 'usuário' : 'usuários'}`)
        );
      })
    );
    replaceChildren(
      footEl,
      canAccess('role', 'read')
        ? h('a', { class: 'btn btn--ghost btn--block', href: '#/permissions', style: 'text-align:center;display:block;text-decoration:none' }, 'Gerenciar permissões')
        : h('span', { class: 'settings-hint' }, 'Você não tem acesso à gestão de permissões.')
    );
  }

  const el = h('section', { class: 'card settings-card', 'aria-labelledby': 'settings-roles-title' }, h('span', { class: 'label', id: 'settings-roles-title' }, 'Perfis de acesso'), rolesEl, footEl);
  render();

  const sig = () => JSON.stringify([store.state.roles.map((r) => [r.id, r.name]), store.state.users.map((u) => [u.id, u.roleIds]), store.state.currentUserId]);
  let last = sig();
  const unsub = store.subscribe(() => {
    const now = sig();
    if (now === last) return;
    last = now;
    render();
  });
  return { el, destroy: unsub };
}
