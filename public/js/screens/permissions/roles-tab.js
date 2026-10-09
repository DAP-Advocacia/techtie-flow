// Aba PERFIS: lista à esquerda, editor à direita. Guarda os RASCUNHOS (um por
// perfil em edição) fora do DOM — por isso trocar de aba, re-renderizar por
// mudança do store ou voltar a um perfil não perde nada do que foi digitado.
import { h, icon, replaceChildren, toast } from '../../ui.js';
import { cloneRole } from '/shared/permissions/index.js';
import { openDialog, confirmDialog } from './dialog.js';
import { createEditor } from './editor.js';
import { authority, checkRoleDelete, deleteRole, usersOfRole } from './actions.js';
import { openReview } from './review.js';
import { normalizeRole, clone, blankRole } from './model.js';
import { makeNamer, plural } from './labels.js';
import { keepUi, selectEl, ICON } from './util.js';

export function createRolesTab(S) {
  const { store } = S;
  const el = h('div', { class: 'perm-roles' });
  const st = { selected: null, drafts: new Map(), seq: 0 };
  let editor = null;
  let listSig = '';
  let building = false; // durante a montagem o cromo do editor não deve redesenhar a lista

  const firstRoleId = () => (store.state.roles.find((r) => !r.system) || store.state.roles[0])?.id ?? null;
  const roleById = (id) => store.state.roles.find((r) => r.id === id);
  const isDirty = (d) => !!d && (d.isNew || d.dirty);
  const anyDirty = () => [...st.drafts.values()].some(isDirty);

  /** Rascunho do perfil (cria sob demanda a partir do que está gravado). */
  function draftFor(role) {
    let d = st.drafts.get(role.id);
    if (!d) {
      d = { key: role.id, isNew: false, base: clone(role), role: clone(role), cloneOf: null, showErrors: false, touchedName: false, dirty: false, baseSig: JSON.stringify(normalizeRole(role)) };
      st.drafts.set(role.id, d);
    }
    return d;
  }

  // ---------------------------------------------------------------- lista
  function listItems() {
    const state = store.state;
    const items = [];
    for (const d of st.drafts.values()) if (d.isNew) items.push({ key: d.key, name: d.role.name || 'Novo perfil', system: false, desc: d.role.description, users: 0, draft: true, dirty: true });
    for (const r of state.roles) {
      const d = st.drafts.get(r.id);
      items.push({ key: r.id, name: r.name, system: !!r.system, desc: r.description, users: usersOfRole(state, r.id).filter((u) => !u.isBot).length, draft: false, dirty: isDirty(d) });
    }
    return items;
  }

  function renderList(host) {
    const items = listItems();
    const canCreate = authority('role', 'create');
    replaceChildren(
      host,
      h(
        'div',
        { class: 'perm-rlist__head' },
        h('span', { class: 'label' }, 'Perfis'),
        h('button', { class: 'btn btn--ghost btn--sm', type: 'button', 'data-fk': 'list:new', disabled: !canCreate.ok, title: canCreate.ok ? 'Criar um perfil novo' : canCreate.hint, onclick: () => openNewDialog(null) }, icon(ICON.plus, 14), ' Novo perfil')
      ),
      h(
        'ul',
        { class: 'perm-rlist__ul', 'aria-label': 'Perfis de acesso' },
        items.map((it) =>
          h(
            'li',
            null,
            h(
              'button',
              { type: 'button', class: 'perm-ritem' + (it.key === st.selected ? ' is-active' : ''), 'aria-current': it.key === st.selected ? 'true' : null, 'data-fk': `role:${it.key}`, onclick: () => select(it.key) },
              h('span', { class: 'perm-ritem__top' }, h('span', { class: 'perm-ritem__name truncate' }, it.name), it.system ? h('span', { class: 'chip' }, 'sistema') : null, it.dirty ? h('span', { class: 'perm-dirty', title: 'Alterações não salvas' }, h('span', { 'aria-hidden': 'true' }, '●'), h('span', { class: 'perm-sr' }, ' alterações não salvas')) : null),
              h('span', { class: 'perm-ritem__meta' }, it.draft ? 'Rascunho · não salvo' : plural(it.users, 'usuário', 'usuários')),
              it.desc ? h('span', { class: 'perm-ritem__desc' }, it.desc) : null
            )
          )
        )
      )
    );
  }

  const listHost = h('aside', { class: 'card perm-rlist', 'aria-label': 'Lista de perfis' });
  const mainHost = h('div', { class: 'perm-rmain' });
  el.append(listHost, mainHost);

  // -------------------------------------------------------------- seleção
  /** Troca de perfil; se o atual tem alterações, pergunta (manter rascunho / descartar / cancelar). */
  async function select(key) {
    if (key === st.selected) return;
    const cur = st.drafts.get(st.selected);
    if (isDirty(cur)) {
      const name = cur.isNew ? cur.role.name || 'perfil novo' : cur.base.name;
      const res = await confirmDialog({
        eyebrow: 'Alterações não salvas',
        title: `Trocar de perfil?`,
        message: `Há alterações não salvas em “${name}”. Você pode mantê-las como rascunho (continuam aqui até você salvar ou descartar) ou descartá-las agora.`,
        confirmLabel: 'Manter rascunho e trocar',
        cancelLabel: 'Ficar neste perfil',
        third: { label: 'Descartar e trocar', id: 'discard' },
      });
      if (res === false) return;
      if (res === 'discard') st.drafts.delete(cur.key);
    }
    st.selected = key;
    render();
    S.onDirtyChange();
  }

  // ------------------------------------------------------ novo / clonar
  function openNewDialog(source) {
    const canCreate = authority('role', 'create');
    if (!canCreate.ok) return toast(canCreate.hint);
    const roles = store.state.roles;
    let mode = source ? 'clone' : 'blank';
    let srcId = source?.id || roles.find((r) => r.id === 'role_agent')?.id || roles[0]?.id;
    const nameInput = h('input', { class: 'input', id: 'perm-new-name', 'data-autofocus': true, value: source ? `Cópia de ${source.name}` : '', placeholder: 'Ex.: Atendente sênior', 'aria-describedby': 'perm-new-name-err' });
    const nameErr = h('div', { class: 'field-error', id: 'perm-new-name-err', role: 'alert' });
    const descInput = h('textarea', { class: 'textarea', id: 'perm-new-desc', rows: '2', placeholder: 'Para que serve este perfil? (opcional)' });
    const srcSel = selectEl({ options: roles.map((r) => ({ value: r.id, label: r.system ? `${r.name} (sistema)` : r.name })), value: srcId, label: 'Perfil de origem', onChange: (v) => (srcId = v), disabled: mode !== 'clone', id: 'perm-new-src' });
    const radio = (value, label, hint) =>
      h('label', { class: 'perm-radio perm-radio--block' }, h('input', { type: 'radio', name: 'perm-new-mode', value, checked: mode === value, onchange: () => { mode = value; srcSel.disabled = mode !== 'clone'; } }), h('span', null, h('strong', null, label), h('small', { class: 'muted' }, hint)));
    const submit = () => {
      const name = nameInput.value.trim();
      if (!name) {
        nameErr.textContent = 'Dê um nome ao perfil.';
        nameInput.setAttribute('aria-invalid', 'true');
        nameInput.focus();
        return;
      }
      if (name.length > 60) {
        nameErr.textContent = 'Nome longo demais (máx. 60 caracteres).';
        nameInput.setAttribute('aria-invalid', 'true');
        nameInput.focus();
        return;
      }
      const src = mode === 'clone' ? roleById(srcId) : null;
      const tenantId = store.state.tenant.id;
      const role = src ? cloneRole(src, { id: '__novo__', name, tenantId }) : { ...blankRole(), name, tenantId };
      role.description = descInput.value.trim() || (src ? src.description || '' : '');
      const key = `new:${++st.seq}`;
      st.drafts.set(key, { key, isNew: true, base: null, role, cloneOf: src ? clone(src) : null, showErrors: false, touchedName: true, dirty: true, baseSig: null });
      dlg.close();
      st.selected = key;
      render();
      S.onDirtyChange();
    };
    const dlg = openDialog({
      eyebrow: source ? 'Clonar perfil' : 'Novo perfil',
      title: source ? `Clonar “${source.name}”` : 'Novo perfil',
      width: 520,
      content: h(
        'form',
        { class: 'perm-form', onsubmit: (e) => { e.preventDefault(); submit(); } },
        h('div', { class: 'perm-field' }, h('label', { class: 'perm-field__label', for: 'perm-new-name' }, 'Nome'), nameInput, nameErr),
        h('div', { class: 'perm-field' }, h('label', { class: 'perm-field__label', for: 'perm-new-desc' }, 'Descrição'), descInput),
        h('button', { type: 'submit', hidden: true, tabindex: '-1', 'aria-hidden': 'true' }),
        h('fieldset', { class: 'perm-fieldset' }, h('legend', { class: 'perm-field__label' }, 'Ponto de partida'), radio('blank', 'Em branco', ' — sem nenhuma permissão; você monta tudo.'), radio('clone', 'Clonar de um perfil existente', ' — começa igual e você ajusta.'), h('div', { class: 'perm-field perm-field--indent' }, h('label', { class: 'perm-field__label', for: 'perm-new-src' }, 'Perfil de origem'), srcSel))
      ),
      footer: [h('button', { class: 'btn btn--quiet', type: 'button', onclick: () => dlg.close() }, 'Cancelar'), h('button', { class: 'btn btn--primary', type: 'button', onclick: submit }, 'Criar rascunho')],
    });
    nameInput.select();
  }

  // --------------------------------------------------------------- ações
  async function discard(d) {
    const ok = await confirmDialog({ eyebrow: 'Descartar', title: d.isNew ? 'Descartar o perfil novo?' : 'Descartar alterações?', message: d.isNew ? 'O rascunho deste perfil será apagado. Nada foi salvo ainda.' : `As alterações não salvas em “${d.base.name}” serão perdidas.`, confirmLabel: 'Descartar', danger: true });
    if (!ok) return;
    st.drafts.delete(d.key);
    if (d.isNew) st.selected = firstRoleId();
    render();
    S.onDirtyChange();
    toast('Rascunho descartado.');
  }

  async function removeRole(role) {
    const check = checkRoleDelete(store.state, role.id);
    if (!check.ok) {
      const dlg = openDialog({ eyebrow: 'Não é possível excluir', title: `Excluir “${role.name}”`, width: 460, content: h('ul', { class: 'perm-errors perm-errors--plain' }, check.problems.map((p) => h('li', null, p))), footer: [h('button', { class: 'btn btn--primary', type: 'button', 'data-autofocus': true, onclick: () => dlg.close() }, 'Entendi')] });
      return;
    }
    const ok = await confirmDialog({ eyebrow: 'Excluir perfil', title: `Excluir “${role.name}”?`, message: 'O perfil será removido e a exclusão fica registrada na auditoria. Ninguém usa este perfil hoje.', confirmLabel: 'Excluir perfil', danger: true });
    if (!ok) return;
    st.drafts.delete(role.id);
    const res = deleteRole(store, role.id);
    if (!res.ok) return toast(res.problems[0]);
    st.selected = firstRoleId();
    render();
    S.onDirtyChange();
    toast('Perfil excluído.');
  }

  // --------------------------------------------------------------- render
  function buildMain() {
    const state = store.state;
    let sel = st.drafts.get(st.selected) || roleById(st.selected);
    if (!sel) {
      st.selected = firstRoleId();
      sel = st.drafts.get(st.selected) || roleById(st.selected);
    }
    if (!sel) {
      replaceChildren(mainHost, h('div', { class: 'empty card' }, h('div', { class: 'section-title gold' }, 'Nenhum perfil'), h('div', null, 'Crie o primeiro perfil com “Novo perfil”.')));
      editor = null;
      return;
    }
    const ns = makeNamer(state);
    const isDraftNew = !!sel.isNew;
    const role = isDraftNew ? sel.role : sel;
    const system = !isDraftNew && !!role.system;
    const authUpdate = authority('role', isDraftNew ? 'create' : 'update');
    const authCreate = authority('role', 'create');
    const readOnly = system || !authUpdate.ok;
    const draft = readOnly ? null : isDraftNew ? sel : draftFor(role);
    const del = !isDraftNew && !system ? checkRoleDelete(state, role.id) : null;
    const canDeleteAuth = authority('role', 'delete');
    editor = createEditor({
      draft,
      role,
      state,
      ns,
      rootEl: el,
      system,
      readOnly,
      readReason: authUpdate.hint,
      usersCount: isDraftNew ? 0 : usersOfRole(state, role.id).filter((u) => !u.isBot).length,
      cloneBlock: authCreate.ok ? '' : authCreate.hint,
      deleteBlock: !canDeleteAuth.ok ? canDeleteAuth.hint : del && !del.ok ? del.problems[0] : '',
      onClone: isDraftNew ? null : () => openNewDialog(role),
      onDelete: isDraftNew ? null : () => removeRole(role),
      onDiscard: () => draft && discard(draft),
      onReview: () => {
        if (!draft) return;
        draft.showErrors = true;
        editor.ed.touch();
        openReview({
          store,
          draft,
          onSaved: (res) => {
            const wasNew = draft.isNew;
            st.drafts.delete(draft.key);
            if (wasNew) st.selected = res.roleId;
            render();
            S.onDirtyChange();
          },
        });
      },
      onDirty: () => {
        if (building) return;
        const sig = JSON.stringify(listItems().map((i) => [i.key, i.name, i.dirty]));
        if (sig === listSig) return;
        listSig = sig;
        if (listHost.isConnected) keepUi(el, () => renderList(listHost));
        S.onDirtyChange();
      },
    });
    replaceChildren(mainHost, editor.el);
  }

  function render() {
    keepUi(el, () => {
      if (st.selected == null || (!roleById(st.selected) && !st.drafts.has(st.selected))) st.selected = firstRoleId();
      // rascunho "limpo" de perfil que mudou no store: reinicia a partir do gravado (rascunho sujo é mantido)
      for (const d of [...st.drafts.values()]) {
        if (d.isNew) continue;
        const stored = roleById(d.key);
        if (!stored) st.drafts.delete(d.key);
        else if (!isDirty(d) && JSON.stringify(normalizeRole(stored)) !== d.baseSig) st.drafts.delete(d.key);
      }
      building = true;
      try {
        buildMain();
      } finally {
        building = false;
      }
      listSig = JSON.stringify(listItems().map((i) => [i.key, i.name, i.dirty]));
      renderList(listHost);
    });
  }

  st.selected = firstRoleId();
  render();

  const sigOf = () => {
    const s = store.state;
    return JSON.stringify([s.roles, s.users.map((u) => [u.id, u.roleIds, u.status, u.mfa]), s.pipelines.map((p) => [p.id, p.name, p.stages.map((x) => [x.id, x.name])]), s.instances.map((i) => [i.id, i.name]), s.tenant.policy, s.currentUserId]);
  };

  return {
    el,
    sig: sigOf,
    refresh: render,
    hasUnsaved: anyDirty,
    unsavedNames: () => [...st.drafts.values()].filter(isDirty).map((d) => (d.isNew ? d.role.name || 'perfil novo' : d.base.name)),
    destroy() {
      st.drafts.clear();
    },
  };
}
