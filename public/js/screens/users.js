// Usuários (#/users) — gestão de pessoas pelo administrador: busca e filtros,
// convidar, editar nome/e-mail, perfis, equipes, suspender/reativar, reenviar
// convite, redefinir MFA e remover. É o MESMO componente da aba "Usuários" de
// Permissões (permissions/users-tab.js), para existir uma única implementação.
// UI é reflexo: quem decide é o motor, e actions.js re-valida cada gravação.
import { h, replaceChildren } from '../ui.js';
import { createUsersTab } from './permissions/users-tab.js';
import { closeAllDialogs, closePopover } from './permissions/dialog.js';

export default {
  mount(el, { store }) {
    const tab = createUsersTab({ store });
    replaceChildren(
      el,
      h('div', { class: 'page perm' }, h('div', { class: 'perm__wrap' }, h('header', { class: 'page-header' }, h('div', { class: 'grow' }, h('div', { class: 'eyebrow' }, 'Administração'), h('h1', { class: 'page-title' }, 'Usuários'))), tab.el))
    );

    // re-renderiza só quando algo relevante mudou (evita refazer a tabela a cada notificação do store)
    let last = tab.sig();
    const unsub = store.subscribe(() => {
      const now = tab.sig();
      if (now === last) return;
      last = now;
      tab.refresh();
    });

    return () => {
      unsub();
      tab.destroy?.();
      closePopover();
      closeAllDialogs();
    };
  },
};
