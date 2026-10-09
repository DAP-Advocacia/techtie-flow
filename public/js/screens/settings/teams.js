// Card EQUIPES E PIPELINES: lista, vínculo equipe <-> pipeline e "+ Nova equipe".
// Alterações valem na hora (store.update), sem passar pelo "Salvar" da marca.
import { h, icon, toast, replaceChildren } from '../../ui.js';
import { audit } from '../../access.js';
import { check, blocked, createHints } from '../_ops/perm.js';

const PLUS = 'M12 5v14M5 12h14';
const plural = (n) => `${n} ${n === 1 ? 'membro' : 'membros'}`;

/** Vínculo 1:1 — desfaz o antigo dos dois lados e devolve a equipe que perdeu o pipeline (se houve). */
function linkPipeline(s, teamId, pipelineId) {
  const team = s.teams.find((t) => t.id === teamId);
  const oldPipeline = s.pipelines.find((p) => p.id === team.pipelineId);
  if (oldPipeline) oldPipeline.teamId = null;
  let displaced = null;
  const pipeline = s.pipelines.find((p) => p.id === pipelineId);
  if (pipeline) {
    displaced = s.teams.find((t) => t.id === pipeline.teamId && t.id !== teamId) || null;
    if (displaced) displaced.pipelineId = null;
    pipeline.teamId = teamId;
  }
  team.pipelineId = pipeline ? pipeline.id : null;
  return displaced;
}

export function createTeamsCard(store) {
  // Equipes e vínculo equipe↔pipeline: tenant_settings.update (motor), com defesa nos handlers.
  const hints = createHints();
  const rw = () => check('tenant_settings', 'update');
  const listEl = h('div', { class: 'settings-list', role: 'list' });
  const formHost = h('div');
  const addBtn = h('button', { class: 'btn btn--ghost btn--sm settings-add', type: 'button', onclick: () => !blocked(rw()) && openForm() }, icon(PLUS, 14), 'Nova equipe');
  let formOpen = false;

  function pipelineOptions(selectedId, ownTeamId) {
    const { pipelines, teams } = store.state;
    return [
      h('option', { value: '', selected: !selectedId }, 'Sem pipeline'),
      ...pipelines.map((p) => {
        const owner = teams.find((t) => t.id === p.teamId);
        const elsewhere = owner && owner.id !== ownTeamId;
        return h('option', { value: p.id, selected: p.id === selectedId }, elsewhere ? `${p.name} (hoje: ${owner.name})` : p.name);
      }),
    ];
  }

  function renderList() {
    const { teams } = store.state;
    // re-render recria os <select>; devolve o foco a quem o tinha (navegação por teclado)
    const focusKey = document.activeElement?.dataset?.fk;
    const canEdit = rw();
    hints.lock(addBtn, canEdit);
    if (!teams.length) {
      replaceChildren(listEl, h('div', { class: 'empty' }, 'Nenhuma equipe ainda. Crie a primeira com “Nova equipe”.'));
      return;
    }
    replaceChildren(
      listEl,
      teams.map((t) =>
        h(
          'div',
          { class: 'settings-row', role: 'listitem' },
          h('div', { class: 'settings-row__main' }, h('span', { class: 'settings-row__title truncate' }, t.name), h('span', { class: 'settings-hint' }, plural(t.members || 0))),
          hints.lock(h(
            'select',
            {
              class: 'select settings-select settings-select--pipe',
              'aria-label': `Pipeline vinculado a ${t.name}`,
              dataset: { fk: `team-${t.id}` },
              onchange: (e) => {
                if (blocked(rw())) {
                  renderList(); // volta o select ao valor salvo
                  return;
                }
                const before = store.pipeline(t.pipelineId)?.name;
                let displaced = null;
                store.update((s) => {
                  displaced = linkPipeline(s, t.id, e.target.value);
                });
                const name = store.pipeline(e.target.value)?.name;
                audit('settings.update', `team:${t.id}`, `Pipeline da equipe "${t.name}": ${before ?? 'nenhum'} → ${name ?? 'nenhum'}`);
                if (displaced) audit('settings.update', `team:${displaced.id}`, `Equipe "${displaced.name}" ficou sem pipeline (vínculo passou para "${t.name}")`);
                toast(name ? `${t.name} agora usa o pipeline ${name}.` : `${t.name} ficou sem pipeline.`);
                if (displaced) toast(`${displaced.name} ficou sem pipeline.`);
              },
            },
            pipelineOptions(t.pipelineId, t.id)
          ), canEdit)
        )
      )
    );
    if (focusKey) listEl.querySelector(`[data-fk="${focusKey}"]`)?.focus();
  }

  function closeForm() {
    formOpen = false;
    replaceChildren(formHost);
    addBtn.hidden = false;
    addBtn.focus();
  }

  function openForm() {
    if (blocked(rw())) return;
    formOpen = true;
    addBtn.hidden = true;
    const err = h('div', { class: 'field-error', id: 'settings-team-err', role: 'alert' });
    const input = h('input', { class: 'input input--inset', id: 'settings-team-name', type: 'text', maxlength: 40, placeholder: 'Ex.: Equipe Parcerias', autocomplete: 'off', 'aria-describedby': 'settings-team-err' });
    const select = h('select', { class: 'select settings-select', id: 'settings-team-pipe', 'aria-label': 'Pipeline da nova equipe' }, pipelineOptions('', null));
    const form = h(
      'form',
      {
        class: 'settings-newteam',
        novalidate: true,
        onkeydown: (e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            closeForm();
          }
        },
        onsubmit: (e) => {
          e.preventDefault();
          if (blocked(rw())) return;
          const name = input.value.trim().replace(/\s+/g, ' ');
          let msg = '';
          if (name.length < 2) msg = 'Informe o nome da equipe (mínimo de 2 caracteres).';
          else if (store.state.teams.some((t) => t.name.toLowerCase() === name.toLowerCase())) msg = 'Já existe uma equipe com esse nome.';
          err.textContent = msg;
          input.setAttribute('aria-invalid', msg ? 'true' : 'false');
          if (msg) {
            input.focus();
            return;
          }
          let displaced = null;
          let newId = null;
          store.update((s) => {
            const id = `tm_${Date.now().toString(36)}`;
            newId = id;
            s.teams.push({ id, name, members: 0, pipelineId: null });
            if (select.value) displaced = linkPipeline(s, id, select.value);
          });
          const pipeName = store.pipeline(select.value)?.name;
          audit('settings.update', `team:${newId}`, `Equipe "${name}" criada${pipeName ? ` com o pipeline ${pipeName}` : ''}`);
          if (displaced) audit('settings.update', `team:${displaced.id}`, `Equipe "${displaced.name}" ficou sem pipeline (vínculo passou para "${name}")`);
          toast(`Equipe ${name} criada.`);
          if (displaced) toast(`${displaced.name} ficou sem pipeline.`);
          closeForm();
        },
      },
      h('label', { class: 'field', for: 'settings-team-name' }, 'Nome da equipe', input),
      err,
      h('label', { class: 'field', for: 'settings-team-pipe' }, 'Pipeline', select),
      h('div', { class: 'settings-actions' }, h('span', { class: 'settings-spacer' }), h('button', { class: 'btn btn--quiet btn--sm', type: 'button', onclick: closeForm }, 'Cancelar'), h('button', { class: 'btn btn--primary btn--sm', type: 'submit' }, 'Criar equipe'))
    );
    replaceChildren(formHost, form);
    input.focus();
  }

  const el = h(
    'section',
    { class: 'card settings-card', 'aria-labelledby': 'settings-teams-title' },
    h('span', { class: 'label', id: 'settings-teams-title' }, 'Equipes e pipelines'),
    listEl,
    formHost,
    h('div', null, addBtn),
    hints.host
  );
  renderList();

  // Re-render só quando algo relevante mudou (a assinatura dispara a cada tecla do nome da marca).
  const sig = () => JSON.stringify([store.state.teams, store.state.pipelines.map((p) => [p.id, p.name, p.teamId]), rw().ok]);
  let last = sig();
  const unsub = store.subscribe(() => {
    const now = sig();
    if (now === last) return;
    last = now;
    renderList();
    if (formOpen) {
      const sel = formHost.querySelector('select');
      if (sel) replaceChildren(sel, pipelineOptions(sel.value, null));
    }
  });

  return { el, destroy: unsub };
}
