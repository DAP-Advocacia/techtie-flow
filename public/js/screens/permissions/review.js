// Diálogo "Revisar e salvar": mostra o que vai mudar (diffRoles em português) e
// só libera o botão se o MOTOR aprovar — validateRole (erros por caminho),
// checkNoEscalation (ninguém concede o que não tem) e decide (autoridade).
import { h, icon, toast } from '../../ui.js';
import { openDialog } from './dialog.js';
import { checkRoleSave, saveRole } from './actions.js';
import { describeChange, makeNamer, plural } from './labels.js';
import { newRoleId, pathLabel } from './model.js';
import { ICON } from './util.js';

const MARK = { added: ['+', 'perm-diff--add', 'Adicionou'], removed: ['−', 'perm-diff--rem', 'Removeu'], changed: ['~', 'perm-diff--chg', 'Alterou'] };

export function openReview({ store, draft, onSaved }) {
  const state = store.state;
  const id = draft.isNew ? newRoleId(draft.role.name, new Set(state.roles.map((r) => r.id))) : draft.base.id;
  const ns = makeNamer(state);
  let dlg;
  let saveBtn;

  function body() {
    const check = checkRoleSave(store.state, draft, id);
    const who = check.after.name || 'Este perfil';
    const nodes = [];
    nodes.push(
      h('p', { class: 'perm-dialog__text' }, draft.isNew ? `Novo perfil “${who}”${draft.cloneOf ? ` (cópia de ${draft.cloneOf.name})` : ''}.` : `Perfil “${who}”.`, ' ', h('strong', null, check.changes.length ? plural(check.changes.length, 'mudança', 'mudanças') : 'Nenhuma mudança de permissão'), check.changes.length ? (draft.isNew && draft.cloneOf ? ' em relação ao perfil de origem.' : '.') : '.')
    );
    if (check.problems.length) nodes.push(h('div', { class: 'perm-banner perm-banner--err', role: 'alert' }, icon(ICON.shield, 16), h('ul', { class: 'perm-errors' }, check.problems.map((p) => h('li', null, p)))));
    if (check.errors.length) {
      nodes.push(
        h('div', { class: 'perm-banner perm-banner--err', role: 'alert' }, h('div', null, h('strong', null, 'O motor recusou este perfil:'), h('ul', { class: 'perm-errors' }, check.errors.map((e) => h('li', null, h('span', { class: 'perm-errpath' }, pathLabel(check.after, e.path)), ': ', e.message)))))
      );
    }
    if (check.violationTexts.length) {
      nodes.push(h('div', { class: 'perm-banner perm-banner--err', role: 'alert' }, icon(ICON.shield, 16), h('div', null, h('strong', null, 'Escalonamento de privilégio bloqueado:'), h('ul', { class: 'perm-errors' }, check.violationTexts.map((t) => h('li', null, t))))));
    }
    if (check.changes.length) {
      nodes.push(
        h(
          'ul',
          { class: 'perm-diff', 'aria-label': 'Mudanças' },
          check.changes.map((c) => {
            const [sym, cls] = MARK[c.type] || MARK.changed;
            return h('li', { class: `perm-diff__row ${cls}` }, h('span', { class: 'perm-diff__sym', 'aria-hidden': 'true' }, sym), h('span', null, describeChange(c, who, ns)));
          })
        )
      );
    }
    return { check, nodes };
  }

  function paint() {
    const { check, nodes } = body();
    dlg.body.replaceChildren(...nodes);
    const blocked = !check.ok || (!check.changes.length && !draft.isNew);
    saveBtn.disabled = blocked;
    return check;
  }

  saveBtn = h(
    'button',
    {
      class: 'btn btn--primary',
      type: 'button',
      'data-autofocus': true,
      onclick: () => {
        const res = saveRole(store, draft);
        if (!res.ok) {
          paint();
          return;
        }
        dlg.close();
        toast(draft.isNew ? 'Perfil criado e registrado na auditoria.' : 'Perfil salvo e registrado na auditoria.');
        onSaved?.(res);
      },
    },
    draft.isNew ? 'Criar perfil' : 'Salvar perfil'
  );
  dlg = openDialog({
    eyebrow: 'Revisão de segurança',
    title: 'Revisar e salvar',
    width: 680,
    content: null,
    footer: [h('button', { class: 'btn btn--quiet', type: 'button', onclick: () => dlg.close() }, 'Voltar e editar'), saveBtn],
  });
  const check = paint();
  if (saveBtn.disabled) dlg.el.querySelector('.perm-dialog__foot .btn--quiet')?.focus();
  return check;
}
