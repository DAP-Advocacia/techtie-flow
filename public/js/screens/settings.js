// Configurações (white-label): marca à esquerda; equipes/pipelines e perfis à direita.
import { h, replaceChildren } from '../ui.js';
import { applySavedAccent } from './settings/accent.js';
import { createBrandCard } from './settings/brand.js';
import { createTeamsCard } from './settings/teams.js';
import { createRolesCard } from './settings/roles.js';
import { check, banner } from './_ops/perm.js';

export default {
  mount(el, { store }) {
    // Reaplica o accent salvo (localStorage). Enquanto app.js não chamar
    // applySavedAccent() no boot, é aqui que ele volta a valer após recarregar.
    applySavedAccent();

    const brand = createBrandCard(store);
    const teams = createTeamsCard(store);
    const roles = createRolesCard(store);
    // Sem tenant_settings.update a tela inteira é somente leitura (cada card também trava os seus controles).
    const bannerEl = banner(!check('tenant_settings', 'update').ok);
    const unsubBanner = store.subscribe(() => {
      bannerEl.hidden = check('tenant_settings', 'update').ok;
    });

    replaceChildren(
      el,
      h(
        'div',
        { class: 'page settings' },
        h(
          'div',
          { class: 'settings__wrap' },
          h('header', null, h('div', { class: 'eyebrow' }, 'White-label'), h('h1', { class: 'page-title' }, 'Configurações')),
          bannerEl,
          h('div', { class: 'settings__grid' }, brand.el, h('div', { class: 'settings__col' }, teams.el, roles.el))
        )
      )
    );

    return () => {
      unsubBanner();
      brand.destroy();
      teams.destroy();
      roles.destroy();
    };
  },
};
