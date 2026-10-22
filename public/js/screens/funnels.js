// #/funnels — Funis: criar, renomear e apagar funis; editar etapas (nome, tipo, probabilidade, ordem) e os motivos de perda.
// Só quem o motor deixa alterar funis (entidade `pipeline`) chega aqui. Etapa com negócio não sai nem muda de tipo
// (o servidor confere com TODOS os negócios da empresa). A probabilidade alimenta a previsão ponderada do Início.
import { h, icon, replaceChildren, toast } from '../ui.js';
import { visible } from '../access.js';
import { check } from './_ops/perm.js';
import { openDialog } from './contacts/form.js';
import * as A from './funnels/actions.js';
import { KINDS, MAX_STAGES, MAX_REASONS, SUGGESTED_REASONS, moveItem, normalizeStages, cleanReasons } from './funnels/model.js';

const UP = 'M6 15l6-6 6 6';
const DOWN = 'M6 9l6 6 6-6';
const PLUS = 'M12 5v14M5 12h14';
const CLOSE = 'M6 6l12 12M18 6L6 18';
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const sig = (stages) => JSON.stringify(normalizeStages(stages).map((s) => [s.id || null, s.name, s.kind, s.probability]));

export default {
  mount(el, { store }) {
    let selId = null;
    const drafts = new Map(); // funil -> etapas em edição (nasce ao abrir o funil; some ao salvar ou descartar)
    const base = new Map(); // funil -> assinatura do salvo quando o rascunho nasceu (para saber se alguém mexeu e o salvo mudou)
    let reasonsDraft = null; // motivos em edição (null = igual ao salvo)
    let busy = false;
    const errors = { name: '', stages: '', reasons: '' };
    const root = h('div', { class: 'page funnels' });
    el.append(root);

    const pipelines = () => store.state.pipelines;
    const current = () => pipelines().find((p) => p.id === selId) || pipelines()[0] || null;
    function stagesOf(p) {
      const saved = A.draftOf(p);
      const cur = drafts.get(p.id);
      // sem edição minha e o salvo mudou (outra pessoa mexeu): pega o novo; com edição minha, o rascunho fica
      if (!cur || (sig(cur) === base.get(p.id) && sig(saved) !== base.get(p.id))) {
        drafts.set(p.id, saved.map((s) => ({ ...s })));
        base.set(p.id, sig(saved));
      }
      return drafts.get(p.id);
    }
    const savedReasons = () => (store.state.lossReasons || []).map((r) => r.name);
    const reasonsOf = () => reasonsDraft || savedReasons();
    const dealCount = (p) => visible('deal', store.state.deals).filter((d) => d.pipelineId === p.id).length;
    const focusKey = () => (root.contains(document.activeElement) ? document.activeElement.dataset?.fk : null);
    const dirtyStages = (p) => drafts.has(p.id) && sig(drafts.get(p.id)) !== sig(A.draftOf(p));

    const field = (label, control, hint) => h('label', { class: 'field' }, label, control, hint ? h('span', { class: 'funnels-hint' }, hint) : null);
    const lock = (node, c, why) => {
      if (!c.ok) {
        node.disabled = true;
        node.title = why || c.msg;
      }
      return node;
    };

    // ---------------------------------------------------------------- ações
    const run = async (fn, okMsg) => {
      if (busy) return null;
      busy = true;
      draw();
      const r = await fn();
      busy = false;
      if (r?.ok && okMsg) toast(okMsg);
      return r;
    };

    function newFunnel() {
      const input = h('input', { class: 'input', type: 'text', maxlength: '200', placeholder: 'Ex.: Pós-venda', autocomplete: 'off', 'data-autofocus': true });
      const err = h('span', { class: 'field-error', role: 'alert' });
      const save = h('button', { class: 'btn btn--primary', type: 'submit' }, 'Criar funil');
      const cancel = h('button', { class: 'btn btn--quiet', type: 'button' }, 'Cancelar');
      const dlg = openDialog({
        eyebrow: 'FUNIS',
        title: 'Novo funil',
        content: h(
          'form',
          {
            class: 'contacts-form',
            novalidate: true,
            onsubmit: async (e) => {
              e.preventDefault();
              err.textContent = '';
              save.disabled = true;
              const r = await A.createPipeline(input.value);
              if (!r.ok) {
                err.textContent = r.error;
                save.disabled = false;
                return;
              }
              dlg.close();
              selId = r.pipeline?.id || null;
              toast('Funil criado com as etapas padrão. Ajuste como preferir.');
              draw();
            },
          },
          h('p', { class: 'muted' }, 'Nasce com as etapas Novo, Qualificação, Proposta, Ganho e Perdido. Depois você edita tudo.'),
          h('label', { class: 'field' }, 'Nome do funil', input),
          err,
          h('div', { class: 'contacts-form__actions' }, cancel, save)
        ),
      });
      cancel.addEventListener('click', () => dlg.close());
    }

    function confirmDelete(p) {
      const ok = h('button', { class: 'btn btn--primary', type: 'button' }, 'Excluir funil');
      const cancel = h('button', { class: 'btn btn--quiet', type: 'button', 'data-autofocus': true }, 'Cancelar');
      const err = h('span', { class: 'field-error', role: 'alert' });
      const dlg = openDialog({ eyebrow: 'AÇÃO SEM VOLTA', title: `Excluir o funil “${p.name}”?`, content: h('div', { class: 'contacts-form' }, h('p', { class: 'muted' }, 'As etapas deste funil serão removidas. Só dá para excluir um funil sem negócios.'), err, h('div', { class: 'contacts-form__actions' }, cancel, ok)) });
      cancel.addEventListener('click', () => dlg.close());
      ok.addEventListener('click', async () => {
        ok.disabled = true;
        const r = await A.deletePipeline(p.id);
        if (!r.ok) {
          err.textContent = r.error;
          ok.disabled = false;
          return;
        }
        dlg.close();
        drafts.delete(p.id);
        selId = null;
        toast('Funil excluído');
        draw();
      });
    }

    // ---------------------------------------------------------------- desenho
    function listCard() {
      return h(
        'nav',
        { class: 'funnels-list', 'aria-label': 'Funis' },
        ...pipelines().map((p) =>
          h(
            'button',
            { class: 'funnels-item' + (p.id === current()?.id ? ' is-active' : ''), type: 'button', 'aria-current': p.id === current()?.id ? 'true' : null, 'data-fk': `pipe:${p.id}`, onclick: () => ((selId = p.id), draw()) },
            h('span', { class: 'funnels-item__name truncate' }, p.name),
            h('span', { class: 'funnels-item__sub' }, `${plural(p.stages.length, 'etapa', 'etapas')} · ${plural(dealCount(p), 'negócio', 'negócios')}`)
          )
        )
      );
    }

    function nameCard(p) {
      const upd = check('pipeline', 'update', { id: p.id });
      const input = lock(h('input', { class: 'input', type: 'text', maxlength: '200', value: p.name, 'aria-label': 'Nome do funil', 'data-fk': 'name' }), upd);
      const save = lock(h('button', { class: 'btn btn--quiet btn--sm', type: 'button', 'data-fk': 'rename' }, 'Renomear'), upd);
      save.addEventListener('click', async () => {
        errors.name = '';
        const r = await run(() => A.renamePipeline(p.id, input.value), 'Funil renomeado');
        if (r && !r.ok) errors.name = r.error;
        draw();
      });
      input.addEventListener('keydown', (e) => e.key === 'Enter' && save.click());
      return h('section', { class: 'card funnels-card' }, h('span', { class: 'label' }, 'Funil'), h('div', { class: 'funnels-namerow' }, input, save), errors.name ? h('p', { class: 'field-error', role: 'alert' }, errors.name) : null);
    }

    function stageRow(p, list, i, upd) {
      const st = list[i];
      const n = st.id ? A.dealsInStage(st.id) : 0;
      const fixed = st.kind !== 'open';
      const onName = h('input', { class: 'input funnels-stage__name', type: 'text', maxlength: '200', value: st.name, 'aria-label': `Nome da etapa ${i + 1}`, placeholder: 'Nome da etapa', 'data-fk': `n${i}` });
      onName.addEventListener('input', () => {
        st.name = onName.value;
        refresh(p);
      });
      const kind = lock(h('select', { class: 'select funnels-stage__kind', 'aria-label': `Tipo da etapa ${i + 1}`, 'data-fk': `k${i}` }, ...KINDS.map((k) => h('option', { value: k.id, selected: k.id === st.kind }, k.label))), upd, 'Sem permissão');
      if (n) {
        kind.disabled = true;
        kind.title = 'O tipo não muda enquanto houver negócio nesta etapa.';
      }
      kind.addEventListener('change', () => {
        st.kind = kind.value;
        if (st.kind === 'won') st.probability = 100;
        if (st.kind === 'lost') st.probability = 0;
        draw();
        root.querySelector(`[data-fk="k${i}"]`)?.focus();
      });
      const prob = h('input', { class: 'input funnels-stage__prob', type: 'number', min: '0', max: '100', step: '1', value: String(st.probability), disabled: fixed || !upd.ok, 'aria-label': `Probabilidade da etapa ${i + 1}, em %`, title: fixed ? (st.kind === 'won' ? 'Etapa ganha vale sempre 100%.' : 'Etapa perdida vale sempre 0%.') : null, 'data-fk': `p${i}` });
      prob.addEventListener('input', () => {
        st.probability = prob.value === '' ? '' : Number(prob.value);
        refresh(p);
      });
      const move = (to) => {
        drafts.set(p.id, moveItem(list, i, to));
        draw();
        root.querySelector(`[data-fk="${to < i ? 'u' : 'd'}${to}"]`)?.focus();
      };
      const remove = lock(h('button', { class: 'funnels-x', type: 'button', 'aria-label': `Remover a etapa ${st.name || i + 1}`, 'data-fk': `x${i}` }, icon(CLOSE, 16)), upd, 'Sem permissão');
      if (n) {
        remove.disabled = true;
        remove.title = `A etapa tem ${plural(n, 'negócio', 'negócios')}: mova antes de remover.`;
      }
      remove.addEventListener('click', () => {
        drafts.set(p.id, list.filter((_, j) => j !== i));
        draw();
      });
      return h(
        'li',
        { class: 'funnels-stage', 'data-kind': st.kind },
        h('span', { class: 'funnels-stage__order' }, lock(h('button', { class: 'funnels-move', type: 'button', 'aria-label': `Subir a etapa ${st.name || i + 1}`, 'data-fk': `u${i}`, disabled: i === 0, onclick: () => move(i - 1) }, icon(UP, 14)), upd), lock(h('button', { class: 'funnels-move', type: 'button', 'aria-label': `Descer a etapa ${st.name || i + 1}`, 'data-fk': `d${i}`, disabled: i === list.length - 1, onclick: () => move(i + 1) }, icon(DOWN, 14)), upd)),
        onName,
        kind,
        h('span', { class: 'funnels-stage__probwrap' }, prob, h('span', { class: 'funnels-hint' }, '%')),
        h('span', { class: 'funnels-stage__n funnels-hint', title: 'Negócios nesta etapa (os que você enxerga)' }, n ? plural(n, 'negócio', 'negócios') : ''),
        remove
      );
    }

    function stagesCard(p) {
      const upd = check('pipeline', 'update', { id: p.id });
      const list = stagesOf(p);
      const saveBtn = lock(h('button', { class: 'btn btn--primary btn--sm', type: 'button', 'data-fk': 'save-stages', 'aria-busy': busy ? 'true' : null, disabled: busy || !dirtyStages(p) }, 'Salvar etapas'), upd);
      const discard = h('button', { class: 'btn btn--quiet btn--sm', type: 'button', 'data-fk': 'discard-stages', hidden: !dirtyStages(p), onclick: () => (drafts.delete(p.id), (errors.stages = ''), draw()) }, 'Descartar alterações');
      const add = lock(h('button', { class: 'btn btn--ghost btn--sm', type: 'button', 'data-fk': 'add-stage', disabled: list.length >= MAX_STAGES, onclick: () => {
        const copy = [...list];
        const at = Math.max(0, copy.findLastIndex((s) => s.kind === 'open') + 1);
        copy.splice(at, 0, { id: null, name: '', kind: 'open', probability: 50 });
        drafts.set(p.id, copy);
        draw();
        root.querySelector(`[data-fk="n${at}"]`)?.focus();
      } }, icon(PLUS, 14), 'Etapa'), upd);
      saveBtn.addEventListener('click', async () => {
        errors.stages = '';
        const r = await run(() => A.saveStages(p.id, drafts.get(p.id) || list), 'Etapas salvas');
        if (r?.ok) drafts.delete(p.id);
        else if (r) errors.stages = r.error;
        draw();
      });
      return h(
        'section',
        { class: 'card funnels-card', 'aria-label': 'Etapas do funil' },
        h('div', { class: 'funnels-card__head' }, h('span', { class: 'label' }, 'Etapas'), h('span', { class: 'funnels-hint' }, 'Probabilidade = chance da etapa virar ganho; alimenta a previsão ponderada do Início.')),
        h('ol', { class: 'funnels-stages' }, ...list.map((_, i) => stageRow(p, list, i, upd))),
        errors.stages ? h('p', { class: 'field-error', role: 'alert' }, errors.stages) : null,
        h('div', { class: 'funnels-actions' }, add, h('span', { class: 'funnels-spacer' }), discard, saveBtn)
      );
    }

    function reasonsCard() {
      const upd = check('pipeline', 'update', null);
      const list = reasonsOf();
      const dirty = reasonsDraft && JSON.stringify(cleanReasons(reasonsDraft)) !== JSON.stringify(savedReasons());
      const rows = list.map((r, i) => {
        const input = lock(h('input', { class: 'input', type: 'text', maxlength: '80', value: r, 'aria-label': `Motivo de perda ${i + 1}`, 'data-fk': `r${i}` }), upd);
        input.addEventListener('input', () => {
          reasonsDraft = [...reasonsOf()];
          reasonsDraft[i] = input.value;
          refreshReasons();
        });
        const x = lock(h('button', { class: 'funnels-x', type: 'button', 'aria-label': `Remover o motivo ${r || i + 1}`, 'data-fk': `rx${i}`, onclick: () => ((reasonsDraft = reasonsOf().filter((_, j) => j !== i)), draw()) }, icon(CLOSE, 16)), upd);
        return h('li', { class: 'funnels-reason' }, input, x);
      });
      const save = lock(h('button', { class: 'btn btn--primary btn--sm', type: 'button', 'data-fk': 'save-reasons', 'aria-busy': busy ? 'true' : null, disabled: busy || !dirty }, 'Salvar motivos'), upd);
      save.addEventListener('click', async () => {
        errors.reasons = '';
        const r = await run(() => A.saveLossReasons(reasonsDraft), 'Motivos de perda salvos');
        if (r?.ok) reasonsDraft = null;
        else if (r) errors.reasons = r.error;
        draw();
      });
      const missing = SUGGESTED_REASONS.filter((s) => !list.map((x) => x.toLowerCase()).includes(s.toLowerCase()));
      return h(
        'section',
        { class: 'card funnels-card', 'aria-label': 'Motivos de perda' },
        h('div', { class: 'funnels-card__head' }, h('span', { class: 'label' }, 'Motivos de perda'), h('span', { class: 'funnels-hint' }, 'Com motivos cadastrados, perder um negócio passa a exigir escolher um deles. Vale para todos os funis.')),
        list.length ? h('ul', { class: 'funnels-reasons' }, ...rows) : h('p', { class: 'funnels-hint' }, 'Nenhum motivo cadastrado: hoje o motivo ao perder um negócio é opcional e livre.'),
        errors.reasons ? h('p', { class: 'field-error', role: 'alert' }, errors.reasons) : null,
        h(
          'div',
          { class: 'funnels-actions' },
          lock(h('button', { class: 'btn btn--ghost btn--sm', type: 'button', 'data-fk': 'add-reason', disabled: list.length >= MAX_REASONS, onclick: () => {
            reasonsDraft = [...list, ''];
            draw();
            root.querySelector(`[data-fk="r${list.length}"]`)?.focus();
          } }, icon(PLUS, 14), 'Motivo'), upd),
          missing.length ? lock(h('button', { class: 'btn btn--quiet btn--sm', type: 'button', 'data-fk': 'suggest', onclick: () => ((reasonsDraft = [...list.filter(Boolean), ...missing].slice(0, MAX_REASONS)), draw()) }, 'Sugerir motivos comuns'), upd) : null,
          h('span', { class: 'funnels-spacer' }),
          dirty ? h('button', { class: 'btn btn--quiet btn--sm', type: 'button', onclick: () => ((reasonsDraft = null), (errors.reasons = ''), draw()) }, 'Descartar') : null,
          save
        )
      );
    }

    function dangerCard(p) {
      const del = check('pipeline', 'delete', { id: p.id });
      const n = dealCount(p);
      const btn = lock(h('button', { class: 'btn btn--quiet btn--sm funnels-danger', type: 'button', 'data-fk': 'delete', onclick: () => confirmDelete(p) }, 'Excluir funil'), del);
      return h('section', { class: 'card funnels-card funnels-card--danger' }, h('span', { class: 'label' }, 'Excluir funil'), h('p', { class: 'funnels-hint' }, n ? `Este funil tem ${plural(n, 'negócio', 'negócios')}: mova ou exclua antes de apagar.` : 'Só dá para excluir um funil sem negócios. A empresa precisa manter pelo menos um.'), h('div', null, btn));
    }

    /** Atualiza só o que depende do que se digita (botões de salvar), sem refazer a tela (o foco fica no campo). */
    function refresh(p) {
      const btn = root.querySelector('[data-fk="save-stages"]');
      const dirty = dirtyStages(p);
      if (btn && check('pipeline', 'update', { id: p.id }).ok) btn.disabled = busy || !dirty;
      const d = root.querySelector('[data-fk="discard-stages"]');
      if (d) d.hidden = !dirty;
    }
    function refreshReasons() {
      const btn = root.querySelector('[data-fk="save-reasons"]');
      if (btn && check('pipeline', 'update', null).ok) btn.disabled = busy || !(reasonsDraft && JSON.stringify(cleanReasons(reasonsDraft)) !== JSON.stringify(savedReasons()));
    }

    function draw() {
      const fk = focusKey();
      const p = current();
      if (p) selId = p.id;
      const create = check('pipeline', 'create', null);
      const newBtn = lock(h('button', { class: 'btn btn--primary', type: 'button', 'data-fk': 'new', onclick: newFunnel }, icon(PLUS, 16), 'Novo funil'), create);
      replaceChildren(
        root,
        h('header', { class: 'page-header' }, h('div', { class: 'grow' }, h('div', { class: 'eyebrow' }, 'CONFIGURAÇÃO'), h('h1', { class: 'page-title' }, 'FUNIS')), newBtn),
        p ? h('div', { class: 'funnels-grid' }, listCard(), h('div', { class: 'funnels-main' }, nameCard(p), stagesCard(p), reasonsCard(), dangerCard(p))) : h('div', { class: 'empty' }, 'Nenhum funil ainda. Crie o primeiro com “Novo funil”.')
      );
      if (fk) root.querySelector(`[data-fk="${CSS.escape(fk)}"]:not(:disabled)`)?.focus();
    }

    draw();
    return store.subscribe(() => {
      if (!busy) draw();
    });
  },
};
