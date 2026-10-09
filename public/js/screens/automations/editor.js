// Painel de edição do nó selecionado. Campos dependem do tipo; erros inline só
// aparecem depois que o campo foi tocado (ou após uma tentativa de publicar/testar),
// para não gritar em formulário recém-aberto.
import { h, icon } from '../../ui.js';
import { KIND_META, typesOf, nodeIssues, DAY_OPTIONS, AI_GOALS, FIELD_OPTIONS, OPERATOR_OPTIONS, instanceOptions, pipelineOptions, stageOptions, templateOptions, ownerOptions } from './catalog.js';

export const PATHS = {
  left: 'M15 18l-6-6 6-6',
  right: 'M9 18l6-6-6-6',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  close: 'M6 6l12 12M18 6L6 18',
};

const MODE_OPTIONS = [
  { value: 'template', label: 'Modelo de mensagem' },
  { value: 'text', label: 'Texto livre' },
];
const SCOPE_OPTIONS = [
  { value: 'new', label: 'Somente contatos novos' },
  { value: 'any', label: 'Qualquer contato' },
];

/**
 * ctx: { node, index, total, state, api, confirmingRemove, isTouched(nodeId,key), touch(nodeId,key), forceErrors() }
 * api: { setType(id), setParam(key, value, {structural}), move(dir), remove(), close() }
 * perm (opcional): { hints, check } — check = resultado de check('automation','update'); sem
 * permissão todos os campos ficam desabilitados/somente leitura (com a dica do motivo).
 */
export function renderEditor(ctx) {
  const { node, state: s, api } = ctx;
  const meta = KIND_META[node.kind];
  const p = node.params || {};
  const errEls = {};

  const refreshErrors = () => {
    const issues = nodeIssues(node, s);
    for (const [key, el] of Object.entries(errEls)) {
      el.textContent = ctx.isTouched(node.id, key) || ctx.forceErrors() ? issues[key] || '' : '';
    }
  };

  const wrap = (key, label, control, { wide = false } = {}) => {
    const err = h('span', { class: 'field-error', id: `automations-err-${key}`, role: 'alert' });
    errEls[key] = err;
    control.setAttribute('aria-describedby', err.id);
    control.dataset.fk = `f-${key}`;
    if (ctx.perm) ctx.perm.hints.lock(control, ctx.perm.check, { readOnly: control.tagName !== 'SELECT' });
    return h('label', { class: 'field' + (wide ? ' automations-wide' : '') }, label, control, err);
  };

  const select = (key, label, options, { placeholder } = {}) => {
    const el = h('select', { class: 'select input--inset', onchange: (e) => { ctx.touch(node.id, key); api.setParam(key, e.target.value, { structural: true }); } },
      placeholder ? h('option', { value: '', disabled: true }, placeholder) : null,
      options.map((o) => {
        const opt = typeof o === 'string' ? { value: o, label: o } : o;
        return h('option', { value: opt.value }, opt.label);
      }));
    el.value = p[key] ?? '';
    return wrap(key, label, el);
  };

  const input = (key, label, { type = 'text', min, max, placeholder, wide, maxlength } = {}) => {
    const el = h('input', {
      class: 'input input--inset', type, min, max, placeholder, maxlength,
      value: p[key] ?? '',
      oninput: (e) => {
        ctx.touch(node.id, key);
        // Início/fim são validados em conjunto (o erro mora em "Até"): tocar um revela o outro.
        if (key === 'from' || key === 'to') { ctx.touch(node.id, 'from'); ctx.touch(node.id, 'to'); }
        const raw = e.target.value;
        api.setParam(key, type === 'number' ? (raw === '' ? '' : Number(raw)) : raw, { structural: false });
        refreshErrors();
      },
      onblur: () => { ctx.touch(node.id, key); refreshErrors(); },
    });
    return wrap(key, label, el, { wide });
  };

  const textarea = (key, label, { placeholder } = {}) => {
    const el = h('textarea', {
      class: 'textarea input--inset', rows: 3, placeholder, maxlength: 500,
      oninput: (e) => { ctx.touch(node.id, key); api.setParam(key, e.target.value, { structural: false }); refreshErrors(); },
      onblur: () => { ctx.touch(node.id, key); refreshErrors(); },
    });
    el.value = p[key] ?? '';
    return wrap(key, label, el, { wide: true });
  };

  // Campos específicos por tipo.
  const FORMS = {
    new_message: () => [select('instanceId', 'Instância', instanceOptions(s)), select('scope', 'Contato', SCOPE_OPTIONS)],
    no_reply: () => [input('hours', 'Horas sem resposta', { type: 'number', min: 1, max: 720 }), select('instanceId', 'Instância', instanceOptions(s))],
    deal_moved: () => [select('pipelineId', 'Pipeline', pipelineOptions(s)), select('stageId', 'Etapa de destino', stageOptions(s, p.pipelineId))],
    tag_added: () => [input('tag', 'Tag', { placeholder: 'Ex.: Quente', maxlength: 40 })],
    business_hours: () => [select('days', 'Dias', DAY_OPTIONS), input('from', 'Das', { type: 'time' }), input('to', 'Até', { type: 'time' })],
    contact_field: () => [select('field', 'Campo', FIELD_OPTIONS), select('operator', 'Operador', OPERATOR_OPTIONS), input('value', 'Valor', { placeholder: 'Ex.: Landing page', maxlength: 60 })],
    deal_open: () => [h('p', { class: 'automations-note' }, 'Segue adiante só se o negócio do contato ainda estiver em uma etapa em andamento (nem Ganho, nem Perdido). Não tem parâmetros.')],
    ai_reply: () => [select('goal', 'Objetivo do agente', AI_GOALS)],
    send_message: () => [
      select('mode', 'Tipo de envio', MODE_OPTIONS),
      p.mode === 'template' ? select('templateId', 'Modelo', templateOptions(s)) : textarea('text', 'Mensagem', { placeholder: 'Olá! Tudo bem? …' }),
    ],
    create_deal: () => [select('pipelineId', 'Pipeline', pipelineOptions(s)), select('stageId', 'Etapa inicial', stageOptions(s, p.pipelineId))],
    assign_owner: () => [select('userId', 'Responsável', ownerOptions(s))],
    add_tag: () => [input('tag', 'Tag', { placeholder: 'Ex.: Quente', maxlength: 40 })],
    create_task: () => [input('text', 'Tarefa', { placeholder: 'Ex.: Ligar para o contato', maxlength: 80 }), input('days', 'Prazo (dias)', { type: 'number', min: 1, max: 90 })],
  };

  const typeOptions = typesOf(node.kind).map((t) => ({ value: t.id, label: t.label }));
  const typeField = (() => {
    const el = h('select', { class: 'select input--inset', onchange: (e) => { ctx.touch(node.id, 'type'); api.setType(e.target.value); } },
      node.type ? null : h('option', { value: '', disabled: true }, 'Selecione…'),
      typeOptions.map((o) => h('option', { value: o.value }, o.label)));
    el.value = node.type || '';
    return wrap('type', `Tipo de ${meta.label.toLowerCase()}`, el);
  })();

  // Mover/remover alteram o fluxo (exigem update); fechar o painel não.
  const iconBtn = (path, label, onclick, { disabled = false, danger = false, key, edits = true } = {}) => {
    const btn = h('button', { class: 'automations-iconbtn' + (danger ? ' is-danger' : ''), type: 'button', 'aria-label': label, title: label, disabled, onclick, 'data-fk': key }, icon(path, 16));
    if (edits && ctx.perm) ctx.perm.hints.lock(btn, ctx.perm.check, { other: disabled });
    return btn;
  };

  const isTrigger = node.kind === 'trigger';
  const removeBtn = isTrigger
    ? null
    : ctx.confirmingRemove
      ? h('span', { class: 'automations-confirm', role: 'group', 'aria-label': 'Confirmar remoção' },
          h('span', null, 'Remover este nó?'),
          h('button', { class: 'btn btn--sm automations-confirm__yes', type: 'button', onclick: api.remove, 'data-fk': 'remove-yes' }, 'Remover'),
          h('button', { class: 'btn btn--quiet btn--sm', type: 'button', onclick: api.cancelRemove }, 'Cancelar'))
      : iconBtn(PATHS.trash, 'Remover nó', api.askRemove, { danger: true, key: 'remove' });

  const body = h('div', { class: 'automations-panel__grid' }, typeField, node.type ? FORMS[node.type]?.() : null);
  refreshErrors();

  return h('section', { class: 'automations-panel', 'aria-label': `Editar ${meta.label.toLowerCase()}` },
    h('div', { class: 'automations-panel__head' },
      h('div', { class: 'automations-panel__title' },
        h('span', { class: 'automations-kind', style: { color: meta.color } }, `EDITAR · ${meta.tag}`),
        h('span', { class: 'automations-panel__name' }, node.title)),
      h('div', { class: 'automations-panel__actions' },
        iconBtn(PATHS.left, 'Mover para a esquerda', () => api.move(-1), { disabled: isTrigger || ctx.index <= 1, key: 'move-left' }),
        iconBtn(PATHS.right, 'Mover para a direita', () => api.move(1), { disabled: isTrigger || ctx.index >= ctx.total - 1, key: 'move-right' }),
        removeBtn,
        iconBtn(PATHS.close, 'Fechar painel', api.close, { key: 'close', edits: false }))),
    body,
    isTrigger ? h('p', { class: 'automations-note' }, 'O gatilho é sempre o primeiro nó do fluxo: não pode ser removido nem reordenado.') : null);
}
