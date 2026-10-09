// Aba POLÍTICA: regras da empresa que valem acima dos perfis. Hoje: exigir MFA
// para ações sensíveis (ACTIONS[x].sensitive). Ligar a política derruba, na hora,
// o acesso de quem não tem MFA a essas ações — por isso o impacto é mostrado
// antes e a confirmação é explícita.
import { h, icon, replaceChildren, toast, avatar } from '../../ui.js';
import { ENTITIES, ACTIONS } from '/shared/permissions/index.js';
import { matrixFor } from '../../access.js';
import { authority, checkPolicy, setPolicy } from './actions.js';
import { confirmDialog } from './dialog.js';
import { actionLabel, entityLabel, plural } from './labels.js';
import { keepUi, ICON } from './util.js';

const PRINCIPLES = [
  ['Permissões somam', 'A pessoa pode tudo o que qualquer um dos seus perfis permite. Dar um segundo perfil nunca tira acesso.'],
  ['Restrições vencem', 'Uma negação ou um campo oculto em qualquer perfil prevalece sobre qualquer permissão — não existe “permitir mais forte que negar”.'],
  ['Isolamento da empresa é incondicional', 'Dados de uma empresa nunca aparecem para outra: nenhum perfil, negação ou compartilhamento desliga essa barreira (e o banco repete a trava).'],
];

export function createPolicyTab(S) {
  const { store } = S;
  const el = h('div', { class: 'perm-policy' });

  const sensitiveActions = () =>
    Object.keys(ACTIONS)
      .filter((a) => ACTIONS[a].sensitive)
      .map((a) => ({ action: a, entities: Object.entries(ENTITIES).filter(([, e]) => e.actions.includes(a)).map(([n]) => n) }))
      .filter((x) => x.entities.length);

  /** Quem hoje usa alguma ação sensível e não tem MFA (perderia/perdeu o acesso). */
  function impact() {
    const state = store.state;
    const sens = sensitiveActions();
    return state.users
      .filter((u) => !u.isBot && u.status === 'active' && !u.mfa)
      .map((u) => {
        const m = matrixFor(u.id);
        const lost = sens
          .map((s) => ({ action: s.action, entities: s.entities.filter((e) => (m[e]?.[s.action]?.scope || 'none') !== 'none') }))
          .filter((x) => x.entities.length);
        return { user: u, lost };
      })
      .filter((x) => x.lost.length);
  }

  async function onToggle() {
    const state = store.state;
    const on = !!state.tenant.policy?.requireMfaForSensitive;
    const next = !on;
    const chk = checkPolicy(state, next);
    if (!chk.ok) return toast(chk.problems[0]);
    if (next) {
      const aff = impact();
      const ok = await confirmDialog({
        eyebrow: 'Política de segurança',
        title: 'Exigir MFA para ações sensíveis?',
        message: aff.length ? `${plural(aff.length, 'usuário perde', 'usuários perdem')} o acesso a ações sensíveis até ativar a verificação em duas etapas: ${aff.map((a) => a.user.name).join(', ')}.` : 'Ninguém é afetado hoje: todos que usam ações sensíveis já têm MFA.',
        confirmLabel: 'Exigir MFA',
      });
      if (!ok) return;
    }
    const res = setPolicy(store, next);
    toast(res.ok ? (next ? 'MFA agora é obrigatório para ações sensíveis.' : 'MFA deixou de ser obrigatório.') : res.problems[0]);
  }

  function build() {
    const state = store.state;
    const on = !!state.tenant.policy?.requireMfaForSensitive;
    const auth = authority('tenant_settings', 'update');
    const aff = impact();
    const sens = sensitiveActions();
    const noMfaTotal = state.users.filter((u) => !u.isBot && u.status === 'active' && !u.mfa).length;

    const sw = h('button', { class: 'toggle', type: 'button', role: 'switch', 'aria-checked': String(on), 'aria-labelledby': 'perm-pol-label', 'aria-describedby': 'perm-pol-desc', 'data-fk': 'policy:mfa', 'aria-disabled': auth.ok ? null : 'true', title: auth.ok ? '' : auth.hint, onclick: () => (auth.ok ? onToggle() : toast(auth.hint)) });

    replaceChildren(
      el,
      h(
        'section',
        { class: 'card perm-polcard', 'aria-labelledby': 'perm-pol-label' },
        h('div', { class: 'perm-sechead' }, h('div', null, h('span', { class: 'label' }, 'Segurança de acesso'), h('h3', { class: 'perm-card__title', id: 'perm-pol-label' }, 'Exigir verificação em duas etapas (MFA) para ações sensíveis')), sw),
        !auth.ok ? h('div', { class: 'perm-banner perm-banner--lock', role: 'note' }, icon(ICON.lock, 16), h('div', null, h('strong', null, 'Modo leitura. '), auth.hint)) : null,
        h('p', { class: 'perm-hint', id: 'perm-pol-desc' }, on ? 'Ligada: quem não tem MFA não executa as ações sensíveis abaixo, mesmo que o perfil permita.' : 'Desligada: o perfil sozinho decide quem executa as ações sensíveis.'),
        h(
          'div',
          { class: 'perm-polgrid' },
          h(
            'div',
            null,
            h('div', { class: 'label' }, 'Ações sensíveis do catálogo'),
            h('ul', { class: 'perm-senslist' }, sens.map((s) => h('li', null, h('strong', null, actionLabel(s.action)), h('span', { class: 'muted' }, ` · ${s.entities.map((e) => entityLabel(e)).join(', ')}`))))
          ),
          h(
            'div',
            null,
            h('div', { class: 'label' }, on ? 'Sem acesso por falta de MFA hoje' : 'Quem seria afetado ao ligar'),
            aff.length
              ? [
                  h('p', { class: 'perm-impact-sum' }, h('strong', null, plural(aff.length, 'usuário', 'usuários')), on ? ' estão sem acesso a ações sensíveis até ativar o MFA.' : ' perderiam o acesso a ações sensíveis até ativar o MFA.'),
                  h('ul', { class: 'perm-impact' }, aff.map(({ user, lost }) => h('li', null, avatar(user.name, { small: true }), h('div', null, h('strong', null, user.name), h('div', { class: 'muted' }, lost.map((l) => actionLabel(l.action)).join(', '))))))
                ]
              : h('div', { class: 'perm-none' }, noMfaTotal ? 'Os usuários sem MFA não usam ações sensíveis.' : 'Todos os usuários ativos já têm MFA.'),
            h('p', { class: 'perm-hint' }, `${plural(noMfaTotal, 'usuário ativo sem MFA', 'usuários ativos sem MFA')} no total.`)
          )
        )
      ),
      h(
        'section',
        { class: 'card perm-principles', 'aria-labelledby': 'perm-prin-t' },
        h('h3', { class: 'perm-card__title', id: 'perm-prin-t' }, 'Como o modelo decide'),
        h('ol', { class: 'perm-prin-list' }, PRINCIPLES.map(([t, d], i) => h('li', null, h('span', { class: 'perm-prin-n', 'aria-hidden': 'true' }, i + 1), h('div', null, h('strong', null, t), h('p', { class: 'perm-hint' }, d)))))
      )
    );
  }

  build();
  return {
    el,
    sig: () => JSON.stringify([store.state.tenant.policy, store.state.users.map((u) => [u.id, u.status, u.mfa, u.roleIds]), store.state.roles, store.state.currentUserId]),
    refresh: () => keepUi(el, build),
    hasUnsaved: () => false,
    destroy() {},
  };
}
