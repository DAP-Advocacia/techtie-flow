// Aba AUDITORIA: trilha somente leitura de quem mudou o quê. Exige
// audit_log.read (canAccess — "algum registro", pois o log não tem dono).
// Eventos de perfil carregam o `diff` estruturado (diffRoles) e o mostramos em
// português; eventos antigos/sem diff mostram só o texto.
import { h, icon, replaceChildren, avatar } from '../../ui.js';
import { canAccess } from '../../access.js';
import { auditLabel, AUDIT_LABELS, describeChange, makeNamer, relTime, fmtDateTime, plural } from './labels.js';
import { keepUi, selectEl, ICON } from './util.js';

const PAGE = 40;
const MARK = { added: ['+', 'perm-diff--add'], removed: ['−', 'perm-diff--rem'], changed: ['~', 'perm-diff--chg'] };

export function createAuditTab(S) {
  const { store } = S;
  const el = h('div', { class: 'perm-audit' });
  const f = { action: '', actor: '', q: '', shown: PAGE };

  function targetName(state, ev) {
    if (ev.action === 'policy.update') return 'Política de segurança';
    if (ev.action.startsWith('role.') && ev.action !== 'role.assign') return state.roles.find((r) => r.id === ev.target)?.name || ev.target;
    return state.users.find((u) => u.id === ev.target)?.name || state.roles.find((r) => r.id === ev.target)?.name || ev.target;
  }

  function build() {
    const state = store.state;
    if (!canAccess('audit_log', 'read')) {
      replaceChildren(
        el,
        h(
          'div',
          { class: 'card perm-locked', role: 'note' },
          h('div', { class: 'perm-locked__icon' }, icon(ICON.lock, 28)),
          h('h3', { class: 'perm-card__title' }, 'Auditoria bloqueada para o seu perfil'),
          h('p', null, 'A trilha de auditoria registra mudanças de perfis, atribuições e políticas — por isso só quem tem a permissão “Auditoria › Visualizar” pode abri-la.'),
          h('p', { class: 'perm-hint' }, 'Peça a um administrador da sua empresa para incluir essa permissão no seu perfil, se você precisar dela.')
        )
      );
      return;
    }
    const ns = makeNamer(state);
    const log = [...state.auditLog].sort((a, b) => b.at - a.at);
    const actors = [...new Set(log.map((e) => e.actorId))];
    const actions = [...new Set(log.map((e) => e.action))];
    const q = f.q.trim().toLowerCase();
    const rows = log.filter((e) => (!f.action || e.action === f.action) && (!f.actor || e.actorId === f.actor) && (!q || `${e.detail || ''} ${targetName(state, e)} ${ns.user(e.actorId)}`.toLowerCase().includes(q)));
    const visible = rows.slice(0, f.shown);
    const rerender = () => keepUi(el, build);

    const filters = h(
      'div',
      { class: 'perm-filters' },
      h('div', { class: 'perm-field' }, h('label', { class: 'perm-field__label', for: 'aud-act' }, 'Ação'), selectEl({ id: 'aud-act', label: 'Filtrar por ação', fk: 'aud:action', value: f.action, options: [{ value: '', label: 'Todas as ações' }, ...actions.map((a) => ({ value: a, label: auditLabel(a) }))], onChange: (v) => { f.action = v; f.shown = PAGE; rerender(); } })),
      h('div', { class: 'perm-field' }, h('label', { class: 'perm-field__label', for: 'aud-actor' }, 'Quem'), selectEl({ id: 'aud-actor', label: 'Filtrar por autor', fk: 'aud:actor', value: f.actor, options: [{ value: '', label: 'Todas as pessoas' }, ...actors.map((a) => ({ value: a, label: ns.user(a) }))], onChange: (v) => { f.actor = v; f.shown = PAGE; rerender(); } })),
      h('div', { class: 'perm-field perm-field--grow' }, h('label', { class: 'perm-field__label', for: 'aud-q' }, 'Buscar'), h('input', { class: 'input', id: 'aud-q', type: 'search', placeholder: 'Nome, perfil ou trecho do detalhe', value: f.q, 'data-fk': 'aud:q', oninput: (e) => { f.q = e.target.value; f.shown = PAGE; rerender(); } }))
    );

    const diffOf = (ev) => {
      if (!ev.diff?.length) return null;
      const who = state.roles.find((r) => r.id === ev.target)?.name || 'O perfil';
      return h(
        'details',
        { class: 'perm-evdiff' },
        h('summary', null, `Ver ${plural(ev.diff.length, 'mudança', 'mudanças')}`),
        h('ul', { class: 'perm-diff' }, ev.diff.map((c) => { const [sym, cls] = MARK[c.type] || MARK.changed; return h('li', { class: `perm-diff__row ${cls}` }, h('span', { class: 'perm-diff__sym', 'aria-hidden': 'true' }, sym), h('span', null, describeChange(c, who, ns))); }))
      );
    };

    const table = rows.length
      ? h(
          'div',
          { class: 'perm-scroll perm-scroll--x', 'data-scroll': 'audit', tabindex: '0', role: 'region', 'aria-label': 'Eventos de auditoria' },
          h(
            'table',
            { class: 'perm-atable' },
            h('caption', { class: 'perm-sr' }, 'Eventos de auditoria, do mais recente para o mais antigo'),
            h('thead', null, h('tr', null, ['Quando', 'Quem', 'Ação', 'Alvo', 'Detalhe'].map((c) => h('th', { scope: 'col' }, c)))),
            h(
              'tbody',
              null,
              visible.map((ev) =>
                h(
                  'tr',
                  null,
                  h('td', { class: 'perm-atime' }, h('time', { datetime: new Date(ev.at).toISOString(), title: fmtDateTime(ev.at) }, relTime(ev.at)), h('small', { class: 'muted' }, fmtDateTime(ev.at))),
                  h('td', null, h('div', { class: 'perm-person' }, avatar(ns.user(ev.actorId), { small: true }), h('span', null, ns.user(ev.actorId)))),
                  h('td', null, h('span', { class: 'chip' + (AUDIT_LABELS[ev.action] ? '' : ' chip--raw') }, auditLabel(ev.action))),
                  h('td', null, targetName(state, ev)),
                  h('td', { class: 'perm-adetail' }, ev.detail || '—', diffOf(ev))
                )
              )
            )
          )
        )
      : h('div', { class: 'empty perm-empty' }, h('div', { class: 'section-title gold' }, log.length ? 'Nada com esses filtros' : 'Sem eventos ainda'), h('div', null, log.length ? 'Limpe os filtros para ver todos os eventos.' : 'Mudanças de perfis, usuários e políticas aparecem aqui assim que acontecerem.'), log.length ? h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => { f.action = ''; f.actor = ''; f.q = ''; rerender(); } }, 'Limpar filtros') : null);

    replaceChildren(
      el,
      h(
        'div',
        { class: 'card perm-audit-card' },
        h('div', { class: 'perm-sechead' }, h('div', null, h('h3', { class: 'perm-card__title' }, 'Trilha de auditoria'), h('p', { class: 'perm-hint' }, `${plural(rows.length, 'evento', 'eventos')}${rows.length !== log.length ? ` de ${log.length}` : ''} · somente leitura · mais recentes primeiro`))),
        filters,
        table,
        rows.length > visible.length ? h('div', { class: 'perm-more' }, h('button', { class: 'btn btn--quiet btn--sm', type: 'button', 'data-fk': 'aud:more', onclick: () => { f.shown += PAGE; rerender(); } }, `Mostrar mais (${rows.length - visible.length})`)) : null
      )
    );
  }

  build();
  return {
    el,
    sig: () => JSON.stringify([store.state.auditLog.length, store.state.auditLog[0]?.id, store.state.users.map((u) => [u.id, u.name]), store.state.roles.map((r) => [r.id, r.name, r.grants]), store.state.currentUserId]),
    refresh: () => keepUi(el, build),
    hasUnsaved: () => false,
    destroy() {},
  };
}
