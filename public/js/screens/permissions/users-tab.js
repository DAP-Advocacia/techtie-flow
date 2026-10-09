// Aba USUÁRIOS: tabela de pessoas (status, MFA, perfis, equipes), organograma e
// as ações de gestão. Os botões são gateados pelo motor (com a razão na dica),
// mas quem decide de verdade é actions.js — que repete as validações.
import { h, icon, replaceChildren, toast, avatar } from '../../ui.js';
import { openDialog, openPopover, closePopover } from './dialog.js';
import { authority, checkUserRoles, saveUserRoles, setUserStatus, checkUserStatus, saveUserTeams, checkInvite, inviteUser, roleAssignProblems, checkUserEdit, saveUserProfile, resendInvite, checkResetMfa, resetUserMfa, checkUserRemove, removeUser } from './actions.js';
import { STATUS_LABELS, plural } from './labels.js';
import { keepUi, selectEl, ICON, sr } from './util.js';

/** Equipes em ordem de árvore (pai antes dos filhos) com a profundidade — tolera ciclo/pai inexistente. */
export function flatTeams(teams) {
  const byParent = new Map();
  const ids = new Set(teams.map((t) => t.id));
  for (const t of teams) {
    const p = t.parentId && ids.has(t.parentId) ? t.parentId : null;
    byParent.set(p, [...(byParent.get(p) || []), t]);
  }
  const out = [];
  const seen = new Set();
  const walk = (parent, depth) => {
    for (const t of byParent.get(parent) || []) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      out.push({ team: t, depth });
      walk(t.id, depth + 1);
    }
  };
  walk(null, 0);
  for (const t of teams) if (!seen.has(t.id)) out.push({ team: t, depth: 0 }); // ciclo: não some da tela
  return out;
}

export function createUsersTab(S) {
  const { store } = S;
  const el = h('div', { class: 'perm-users' });
  // filtros da tabela: vivem na closure, então re-renderizar por mudança do store não os perde
  const filters = { q: '', status: 'all', role: 'all' };

  const teamPath = (state, id) => {
    const parts = [];
    let cur = state.teams.find((t) => t.id === id);
    let guard = 0;
    while (cur && guard++ < 10) {
      parts.unshift(cur.name.replace(/^Equipe /, ''));
      cur = state.teams.find((t) => t.id === cur.parentId);
    }
    return parts.join(' › ') || id;
  };

  // ------------------------------------------------------------ popovers
  function rolesPopover(anchor, user) {
    const state = store.state;
    let next = [...(user.roleIds || [])];
    const auth = authority('role', 'assign');
    const msgBox = h('div', { class: 'perm-pop__msg', role: 'status', 'aria-live': 'polite' });
    const apply = h('button', { class: 'btn btn--primary btn--sm', type: 'button', 'data-autofocus': false }, 'Aplicar');
    const list = h(
      'div',
      { class: 'perm-pop__list', role: 'group', 'aria-label': `Perfis de ${user.name}` },
      state.roles.map((r) => {
        const assigned = (user.roleIds || []).includes(r.id);
        const v = assigned ? [] : roleAssignProblems(r.id);
        const blocked = !auth.ok || (v.length > 0 && !assigned);
        return h(
          'label',
          { class: 'perm-check perm-check--rich' + (blocked ? ' is-disabled' : ''), title: !auth.ok ? auth.hint : v.length ? v[0] : r.description || '' },
          h('input', {
            type: 'checkbox',
            checked: assigned,
            disabled: !auth.ok || (v.length > 0 && !assigned),
            'data-fk': `rp:${r.id}`,
            onchange: (e) => {
              next = e.target.checked ? [...next, r.id] : next.filter((x) => x !== r.id);
              check();
            },
          }),
          h('span', null, h('span', { class: 'perm-check__name' }, r.name, r.system ? h('span', { class: 'chip' }, 'sistema') : null), h('small', { class: 'muted' }, v.length && !assigned ? 'Indisponível: acima do seu poder de concessão.' : r.description || ''))
        );
      })
    );
    function check() {
      const res = checkUserRoles(store.state, user.id, next);
      const unchanged = res.problems.length === 1 && res.problems[0] === 'Nada mudou.';
      apply.disabled = !res.ok;
      replaceChildren(msgBox, !res.ok && !unchanged ? h('ul', { class: 'perm-errors perm-errors--plain' }, res.problems.map((p) => h('li', null, p))) : null);
      pop?.place();
      return res;
    }
    apply.addEventListener('click', () => {
      const res = saveUserRoles(store, user.id, next);
      if (!res.ok) return check();
      pop.close();
      toast(`Perfis de ${user.name} atualizados.`);
    });
    const pop = openPopover(anchor, {
      label: `Perfis de ${user.name}`,
      width: 360,
      content: [h('div', { class: 'perm-pop__title' }, 'Perfis de ', h('strong', null, user.name)), h('p', { class: 'perm-hint' }, 'Permissões somam: a pessoa pode tudo o que qualquer um dos perfis permite — e as negações de qualquer perfil vencem.'), list, msgBox, h('div', { class: 'perm-pop__foot' }, h('button', { class: 'btn btn--quiet btn--sm', type: 'button', onclick: () => pop.close() }, 'Cancelar'), apply)],
    });
    check();
    pop.el.querySelector('input:not([disabled])')?.focus();
  }

  function teamsPopover(anchor, user) {
    const state = store.state;
    let next = [...(user.teamIds || [])];
    const auth = authority('user', 'update');
    const msgBox = h('div', { class: 'perm-pop__msg', role: 'status', 'aria-live': 'polite' });
    const apply = h('button', { class: 'btn btn--primary btn--sm', type: 'button' }, 'Aplicar');
    const flat = flatTeams(state.teams);
    const refresh = () => {
      const same = JSON.stringify([...next].sort()) === JSON.stringify([...(user.teamIds || [])].sort());
      apply.disabled = !auth.ok || same;
    };
    apply.addEventListener('click', () => {
      const res = saveUserTeams(store, user.id, next);
      if (!res.ok) return replaceChildren(msgBox, h('ul', { class: 'perm-errors perm-errors--plain' }, res.problems.map((p) => h('li', null, p))));
      pop.close();
      toast(`Equipes de ${user.name} atualizadas.`);
    });
    const pop = openPopover(anchor, {
      label: `Equipes de ${user.name}`,
      width: 340,
      content: [
        h('div', { class: 'perm-pop__title' }, 'Equipes de ', h('strong', null, user.name)),
        !auth.ok ? h('p', { class: 'perm-warn' }, auth.hint) : h('p', { class: 'perm-hint' }, 'A equipe define o alcance de “Equipe” e “Equipe e subequipes” nos perfis da pessoa.'),
        flat.length
          ? h(
              'div',
              { class: 'perm-pop__list', role: 'group', 'aria-label': 'Equipes' },
              flat.map(({ team, depth }) =>
                h(
                  'label',
                  { class: 'perm-check', style: { paddingLeft: `${depth * 18}px` } },
                  h('input', { type: 'checkbox', checked: next.includes(team.id), disabled: !auth.ok, 'data-fk': `tp:${team.id}`, onchange: (e) => { next = e.target.checked ? [...next, team.id] : next.filter((x) => x !== team.id); refresh(); } }),
                  h('span', null, depth ? h('span', { class: 'muted', 'aria-hidden': 'true' }, '└ ') : null, team.name)
                )
              )
            )
          : h('div', { class: 'perm-none' }, 'Nenhuma equipe cadastrada.'),
        msgBox,
        h('div', { class: 'perm-pop__foot' }, h('button', { class: 'btn btn--quiet btn--sm', type: 'button', onclick: () => pop.close() }, 'Cancelar'), apply),
      ],
    });
    refresh();
    pop.el.querySelector('input:not([disabled])')?.focus();
  }

  // -------------------------------------------------------------- convite
  function inviteDialog() {
    const state = store.state;
    const a1 = authority('user', 'create');
    const a2 = authority('role', 'assign');
    if (!a1.ok || !a2.ok) return toast((!a1.ok ? a1 : a2).hint);
    const form = { email: '', name: '', roleId: '', teamId: '' };
    const email = h('input', { class: 'input', id: 'perm-inv-email', type: 'email', placeholder: 'pessoa@empresa.com.br', 'data-autofocus': true, autocomplete: 'off', 'aria-describedby': 'perm-inv-email-err' });
    const name = h('input', { class: 'input', id: 'perm-inv-name', placeholder: 'Opcional — usamos o e-mail se vazio', autocomplete: 'off' });
    const err = (id) => h('div', { class: 'field-error', id, role: 'alert' });
    const eEmail = err('perm-inv-email-err');
    const eRole = err('perm-inv-role-err');
    const eTeam = err('perm-inv-team-err');
    const eTop = h('div', { class: 'perm-banner perm-banner--err', hidden: true, role: 'alert' });
    const roleSel = selectEl({
      id: 'perm-inv-role',
      label: 'Perfil',
      value: '',
      describedBy: 'perm-inv-role-err',
      options: [{ value: '', label: 'Escolha um perfil…' }, ...state.roles.map((r) => ({ value: r.id, label: roleAssignProblems(r.id).length ? `${r.name} — indisponível (acima do seu poder)` : r.name, disabled: roleAssignProblems(r.id).length > 0 }))],
      onChange: (v) => (form.roleId = v),
    });
    const teamSel = selectEl({ id: 'perm-inv-team', label: 'Equipe', value: '', options: [{ value: '', label: 'Sem equipe' }, ...flatTeams(state.teams).map(({ team, depth }) => ({ value: team.id, label: `${'— '.repeat(depth)}${team.name}` }))], onChange: (v) => (form.teamId = v) });
    const submit = () => {
      form.email = email.value;
      form.name = name.value;
      const res = checkInvite(store.state, form);
      eEmail.textContent = res.errors.email || '';
      eRole.textContent = res.errors.role || '';
      eTeam.textContent = res.errors.team || '';
      email.setAttribute('aria-invalid', res.errors.email ? 'true' : 'false');
      roleSel.setAttribute('aria-invalid', res.errors.role ? 'true' : 'false');
      eTop.hidden = !res.problems.length;
      eTop.textContent = res.problems.join(' ');
      if (!res.ok) return (res.errors.email ? email : res.errors.role ? roleSel : email).focus();
      const out = inviteUser(store, form);
      if (!out.ok) return;
      dlg.close();
      toast(`Convite enviado a ${res.mail}.`);
    };
    const field = (label, forId, control, errEl) => h('div', { class: 'perm-field' }, h('label', { class: 'perm-field__label', for: forId }, label), control, errEl);
    const dlg = openDialog({
      eyebrow: 'Convidar usuário',
      title: 'Convidar usuário',
      width: 480,
      content: h('form', { class: 'perm-form', onsubmit: (e) => { e.preventDefault(); submit(); } }, eTop, field('E-mail', 'perm-inv-email', email, eEmail), field('Nome', 'perm-inv-name', name), field('Perfil', 'perm-inv-role', roleSel, eRole), field('Equipe', 'perm-inv-team', teamSel, eTeam), h('button', { type: 'submit', hidden: true, tabindex: '-1', 'aria-hidden': 'true' }), h('p', { class: 'perm-hint' }, 'A pessoa entra com status “Convidado” e só ganha acesso depois de aceitar o convite.')),
      footer: [h('button', { class: 'btn btn--quiet', type: 'button', onclick: () => dlg.close() }, 'Cancelar'), h('button', { class: 'btn btn--primary', type: 'button', onclick: submit }, 'Enviar convite')],
    });
  }

  // ----------------------------------------------------- menu "⋯" da pessoa
  function editDialog(user) {
    const name = h('input', { class: 'input', id: 'perm-ed-name', value: user.name, 'data-autofocus': true, autocomplete: 'off' });
    const email = h('input', { class: 'input', id: 'perm-ed-email', type: 'email', value: user.email || '', autocomplete: 'off' });
    const eName = h('div', { class: 'field-error', role: 'alert' });
    const eEmail = h('div', { class: 'field-error', role: 'alert' });
    const eTop = h('div', { class: 'perm-banner perm-banner--err', hidden: true, role: 'alert' });
    const submit = () => {
      const res = checkUserEdit(store.state, user.id, { name: name.value, email: email.value });
      eName.textContent = res.errors.name || '';
      eEmail.textContent = res.errors.email || '';
      eTop.hidden = !res.problems.length;
      eTop.textContent = res.problems.join(' ');
      if (!res.ok) return (res.errors.name ? name : email).focus();
      if (!saveUserProfile(store, user.id, { name: name.value, email: email.value }).ok) return;
      dlg.close();
      toast(`Dados de ${res.name} atualizados.`);
    };
    const field = (label, forId, control, errEl) => h('div', { class: 'perm-field' }, h('label', { class: 'perm-field__label', for: forId }, label), control, errEl);
    const dlg = openDialog({
      eyebrow: 'Editar usuário',
      title: user.name,
      width: 460,
      content: h('form', { class: 'perm-form', onsubmit: (e) => { e.preventDefault(); submit(); } }, eTop, field('Nome', 'perm-ed-name', name, eName), field('E-mail', 'perm-ed-email', email, eEmail), h('button', { type: 'submit', hidden: true, tabindex: '-1', 'aria-hidden': 'true' }), h('p', { class: 'perm-hint' }, 'Perfis e equipes são alterados na própria tabela. Mudar o e-mail muda o login da pessoa.')),
      footer: [h('button', { class: 'btn btn--quiet', type: 'button', onclick: () => dlg.close() }, 'Cancelar'), h('button', { class: 'btn btn--primary', type: 'button', onclick: submit }, 'Salvar')],
    });
  }

  function removeDialog(user) {
    const check = checkUserRemove(store.state, user.id);
    const dlg = openDialog({
      eyebrow: 'Remover usuário',
      title: `Remover ${user.name}?`,
      width: 460,
      content: h('div', { class: 'perm-form' }, check.ok ? h('p', null, 'A pessoa perde o acesso e sai da lista. O histórico de auditoria é mantido. Esta ação não pode ser desfeita (para bloquear só o acesso, use Suspender).') : h('div', { class: 'perm-banner perm-banner--err', role: 'alert' }, check.problems.join(' '))),
      footer: [
        h('button', { class: 'btn btn--quiet', type: 'button', onclick: () => dlg.close() }, check.ok ? 'Cancelar' : 'Fechar'),
        check.ok ? h('button', { class: 'btn btn--primary', type: 'button', onclick: () => { const res = removeUser(store, user.id); dlg.close(); toast(res.ok ? `${user.name} removido(a).` : res.problems[0]); } }, 'Remover') : null,
      ],
    });
  }

  function userMenu(anchor, user) {
    const state = store.state;
    const upd = authority('user', 'update');
    const inv = authority('user', 'create');
    const del = authority('user', 'delete');
    const mfa = checkResetMfa(state, user.id);
    let pop;
    // item bloqueado continua clicável só para explicar o motivo (toast) — a ação em si é re-validada em actions.js
    const item = (label, hint, run, { danger = false } = {}) =>
      h('button', { class: 'perm-menu__item' + (danger ? ' is-danger' : ''), type: 'button', role: 'menuitem', 'aria-disabled': hint ? 'true' : null, title: hint || null, onclick: () => { if (hint) return toast(hint); pop.close(); run(); } }, label);
    const items = [
      item('Editar nome e e-mail', upd.ok ? '' : upd.hint, () => editDialog(user)),
      user.status === 'invited' ? item('Reenviar convite', inv.ok ? '' : inv.hint, () => { const r = resendInvite(store, user.id); toast(r.ok ? `Convite reenviado a ${user.email}.` : r.problems[0]); }) : null,
      user.mfa ? item('Redefinir MFA', mfa.ok ? '' : mfa.problems[0], () => { const r = resetUserMfa(store, user.id); toast(r.ok ? `MFA de ${user.name} redefinido.` : r.problems[0]); }) : null,
      item('Remover usuário…', del.ok ? '' : del.hint, () => removeDialog(user), { danger: true }),
    ].filter(Boolean);
    pop = openPopover(anchor, { label: `Ações para ${user.name}`, width: 240, content: [h('div', { class: 'perm-menu', role: 'menu' }, items)] });
    pop.el.querySelector('.perm-menu__item')?.focus();
  }

  // -------------------------------------------------------------- render
  const statusChip = (u) => h('span', { class: `perm-status perm-status--${u.status}` }, h('span', { class: 'perm-status__dot', 'aria-hidden': 'true' }), STATUS_LABELS[u.status] || u.status);

  function row(state, u) {
    const roles = (u.roleIds || []).map((id) => state.roles.find((r) => r.id === id)).filter(Boolean);
    const rolesAuth = authority('role', 'assign');
    const userAuth = authority('user', 'update');
    if (u.isBot) {
      return h(
        'tr',
        { class: 'perm-urow perm-urow--bot' },
        h('th', { scope: 'row', class: 'perm-ucell-name' }, h('div', { class: 'perm-person' }, avatar(u.name, { small: false }), h('div', { class: 'perm-person__t' }, h('span', { class: 'perm-person__name' }, u.name, ' ', h('span', { class: 'perm-aitag' }, 'IA')), h('span', { class: 'muted' }, 'Agente automático')))),
        h('td', null, h('span', { class: 'muted' }, '—')),
        h('td', null, statusChip(u)),
        h('td', { class: 'perm-center' }, h('span', { class: 'muted' }, '—'), sr('não se aplica')),
        h('td', null, h('span', { class: 'muted' }, 'Sem perfil — opera pelas regras do Agente de IA')),
        h('td', null, h('span', { class: 'muted' }, '—')),
        h('td', null, h('span', { class: 'muted' }, '—'))
      );
    }
    const isMe = u.id === state.currentUserId;
    const statusAction = u.status === 'suspended' ? 'active' : 'suspended';
    const stCheck = checkUserStatus(state, u.id, statusAction);
    const blockedHint = !userAuth.ok ? userAuth.hint : !stCheck.ok ? stCheck.problems[0] : '';
    return h(
      'tr',
      { class: 'perm-urow' + (u.status === 'suspended' ? ' is-suspended' : '') },
      h('th', { scope: 'row', class: 'perm-ucell-name' }, h('div', { class: 'perm-person' }, avatar(u.name), h('div', { class: 'perm-person__t' }, h('span', { class: 'perm-person__name' }, u.name, isMe ? h('span', { class: 'chip perm-me' }, 'você') : null)))),
      h('td', null, h('span', { class: 'truncate perm-email', title: u.email || '' }, u.email || '—')),
      h('td', null, statusChip(u)),
      h('td', { class: 'perm-center' }, u.mfa ? h('span', { class: 'status status--ok', title: 'Verificação em duas etapas ativa' }, '✓', sr('MFA ativo')) : h('span', { class: 'muted', title: 'Sem verificação em duas etapas' }, '—', sr('sem MFA'))),
      h(
        'td',
        null,
        h(
          'div',
          { class: 'perm-chipcell' },
          roles.length ? roles.map((r) => h('span', { class: 'chip' }, r.name)) : h('span', { class: 'muted' }, 'Sem perfil'),
          h('button', { class: 'perm-linkbtn', type: 'button', 'data-fk': `ur:${u.id}`, 'aria-label': `Alterar perfis de ${u.name}`, 'aria-disabled': rolesAuth.ok ? null : 'true', title: rolesAuth.ok ? 'Atribuir ou remover perfis' : rolesAuth.hint, onclick: (e) => (rolesAuth.ok ? rolesPopover(e.currentTarget, u) : toast(rolesAuth.hint)) }, 'Alterar')
        )
      ),
      h(
        'td',
        null,
        h(
          'div',
          { class: 'perm-chipcell' },
          (u.teamIds || []).length ? u.teamIds.map((id) => h('span', { class: 'chip chip--team', title: teamPath(state, id) }, teamPath(state, id))) : h('span', { class: 'muted' }, 'Sem equipe'),
          h('button', { class: 'perm-linkbtn', type: 'button', 'data-fk': `ut:${u.id}`, 'aria-label': `Alterar equipes de ${u.name}`, 'aria-disabled': userAuth.ok ? null : 'true', title: userAuth.ok ? 'Alterar equipes' : userAuth.hint, onclick: (e) => (userAuth.ok ? teamsPopover(e.currentTarget, u) : toast(userAuth.hint)) }, 'Alterar')
        )
      ),
      h(
        'td',
        { class: 'perm-actions' },
        h('button', {
          class: 'btn btn--quiet btn--sm',
          type: 'button',
          'data-fk': `us:${u.id}`,
          'aria-disabled': blockedHint ? 'true' : null,
          title: blockedHint || (statusAction === 'suspended' ? 'Bloqueia o acesso sem apagar o histórico' : 'Devolve o acesso'),
          'aria-label': `${statusAction === 'suspended' ? 'Suspender' : 'Reativar'} ${u.name}`,
          onclick: () => {
            if (blockedHint) return toast(blockedHint);
            const res = setUserStatus(store, u.id, statusAction);
            toast(res.ok ? `${u.name} ${statusAction === 'suspended' ? 'suspenso(a)' : 'reativado(a)'}.` : res.problems[0]);
          },
        }, statusAction === 'suspended' ? 'Suspender' : 'Reativar'),
        blockedHint ? h('span', { class: 'perm-sr' }, ` Indisponível: ${blockedHint}`) : null,
        h('button', { class: 'btn btn--quiet btn--sm perm-morebtn', type: 'button', 'data-fk': `um:${u.id}`, 'aria-haspopup': 'menu', 'aria-label': `Mais ações para ${u.name}`, title: 'Editar, reenviar convite, redefinir MFA, remover', onclick: (e) => userMenu(e.currentTarget, u) }, '⋯')
      )
    );
  }

  /** Usuários que passam nos filtros (busca por nome/e-mail, status e perfil). */
  function filtered(state) {
    const q = filters.q.trim().toLowerCase();
    return state.users.filter((u) => {
      if (filters.status !== 'all' && !(u.isBot ? filters.status === 'active' : u.status === filters.status)) return false;
      if (filters.role !== 'all' && !(u.roleIds || []).includes(filters.role)) return false;
      if (q && !`${u.name} ${u.email || ''}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }

  function build() {
    closePopover();
    const state = store.state;
    const flat = flatTeams(state.teams);
    const invAuth1 = authority('user', 'create');
    const invAuth2 = authority('role', 'assign');
    const invBlock = !invAuth1.ok ? invAuth1.hint : !invAuth2.ok ? invAuth2.hint : '';
    const humans = state.users.filter((u) => !u.isBot);
    const readOnly = !authority('role', 'assign').ok && !authority('user', 'update').ok;
    const members = (teamId) => humans.filter((u) => (u.teamIds || []).includes(teamId)).length;

    // Só o corpo da tabela é refeito ao digitar/filtrar: assim a caixa de busca não perde o foco.
    const tbody = h('tbody', null);
    const renderRows = () => {
      const list = filtered(store.state);
      replaceChildren(tbody, list.length ? list.map((u) => row(store.state, u)) : h('tr', null, h('td', { colspan: '7' }, h('div', { class: 'empty' }, store.state.users.length ? 'Nenhum usuário encontrado com esses filtros.' : 'Nenhum usuário ainda. Convide a primeira pessoa.'))));
    };
    const toolbar = h(
      'div',
      { class: 'perm-toolbar' },
      h('input', { class: 'input perm-toolbar__search', type: 'search', placeholder: 'Buscar por nome ou e-mail…', value: filters.q, 'aria-label': 'Buscar usuários', 'data-fk': 'users:q', oninput: (e) => { filters.q = e.target.value; renderRows(); } }),
      selectEl({ id: 'perm-f-status', label: 'Status', value: filters.status, options: [{ value: 'all', label: 'Todos os status' }, { value: 'active', label: 'Ativos' }, { value: 'invited', label: 'Convidados' }, { value: 'suspended', label: 'Suspensos' }], onChange: (v) => { filters.status = v; renderRows(); } }),
      selectEl({ id: 'perm-f-role', label: 'Perfil', value: filters.role, options: [{ value: 'all', label: 'Todos os perfis' }, ...state.roles.map((r) => ({ value: r.id, label: r.name }))], onChange: (v) => { filters.role = v; renderRows(); } })
    );
    const table = h(
      'div',
      { class: 'card perm-utable-card' },
      h('div', { class: 'perm-sechead' }, h('div', null, h('h3', { class: 'perm-card__title' }, 'Pessoas e acessos'), h('p', { class: 'perm-hint' }, `${plural(humans.length, 'usuário', 'usuários')} · ${humans.filter((u) => u.status === 'active').length} ativos`)), h('button', { class: 'btn btn--primary btn--sm', type: 'button', 'data-fk': 'users:invite', 'aria-disabled': invBlock ? 'true' : null, title: invBlock || 'Convidar uma pessoa por e-mail', onclick: () => (invBlock ? toast(invBlock) : inviteDialog()) }, icon(ICON.plus, 14), ' Convidar usuário')),
      toolbar,
      readOnly ? h('div', { class: 'perm-banner perm-banner--lock', role: 'note' }, icon(ICON.lock, 16), h('div', null, h('strong', null, 'Modo leitura. '), authority('role', 'assign').hint)) : null,
      h(
        'div',
        { class: 'perm-scroll perm-scroll--x', 'data-scroll': 'users', tabindex: '0', role: 'region', 'aria-label': 'Tabela de usuários' },
        h(
          'table',
          { class: 'perm-utable' },
          h('caption', { class: 'perm-sr' }, 'Usuários, status, verificação em duas etapas, perfis e equipes'),
          h('thead', null, h('tr', null, ['Usuário', 'E-mail', 'Status', 'MFA', 'Perfis', 'Equipes', 'Acesso'].map((c) => h('th', { scope: 'col' }, c)))),
          tbody
        )
      )
    );

    const org = h(
      'aside',
      { class: 'card perm-org', 'aria-labelledby': 'perm-org-t' },
      h('h3', { class: 'perm-card__title', id: 'perm-org-t' }, 'Organograma'),
      h('p', { class: 'perm-hint' }, '“Equipe e subequipes” alcança a equipe da pessoa e tudo que está abaixo dela.'),
      flat.length
        ? h('ul', { class: 'perm-tree' }, flat.map(({ team, depth }) => h('li', { class: 'perm-tree__item', style: { paddingLeft: `${depth * 20}px` } }, depth ? h('span', { class: 'perm-tree__elbow', 'aria-hidden': 'true' }, '└') : null, h('span', { class: 'perm-tree__name' }, team.name), h('span', { class: 'muted perm-tree__n' }, plural(members(team.id), 'pessoa', 'pessoas')))))
        : h('div', { class: 'perm-none' }, 'Nenhuma equipe cadastrada.')
    );
    renderRows();
    replaceChildren(el, table, org);
  }

  build();
  return {
    el,
    sig: () => JSON.stringify([store.state.users, store.state.roles.map((r) => [r.id, r.name, r.system, r.grants]), store.state.teams, store.state.tenant.policy, store.state.currentUserId]),
    refresh: () => keepUi(el, build),
    hasUnsaved: () => false,
    destroy: closePopover,
  };
}
