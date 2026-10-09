// Editor de condições ("Responsável é igual a o próprio usuário", "Desconto da
// operação é no máximo 15%"). Edita a lista `conds` NA PLACE (é o rascunho).
// Mudança estrutural (campo/operador/adicionar/remover) chama onStructure() —
// quem chama re-renderiza a seção; digitar um valor só chama onValue(), para
// não perder o foco no meio da digitação.
import { h } from '../../ui.js';
import { ENTITIES, ACTIONS, REFS } from '/shared/permissions/index.js';
import { OP_LABELS, ATTR_LABELS, CTX_LABELS, REF_LABELS, enumFor, conditionFieldLabel } from './labels.js';
import { selectEl, ICON } from './util.js';
import { icon } from '../../ui.js';

const NO_VALUE = new Set(['isNull', 'notNull']);
const LIST_OPS = new Set(['in', 'nin']);
const NUMERIC_CTX = new Set(['discountPct', 'rowCount']);

/** Campos que a condição pode usar: atributos da entidade + chaves de contexto comuns às ações. */
export function fieldOptions(entity, actions) {
  const opts = [];
  if (entity && entity !== '*' && ENTITIES[entity]) {
    for (const f of Object.keys(ENTITIES[entity].attrs)) if (f !== 'id' && f !== 'tenantId') opts.push({ value: f, label: ATTR_LABELS[f] || f, group: 'Do registro' });
    const acts = (actions || []).filter((a) => a !== '*');
    if (acts.length) {
      const common = (ACTIONS[acts[0]]?.ctx || []).filter((k) => acts.every((a) => (ACTIONS[a]?.ctx || []).includes(k)));
      for (const k of common) opts.push({ value: `ctx.${k}`, label: CTX_LABELS[k] || k, group: 'Da operação' });
    }
  }
  return opts;
}

function typeOf(entity, field) {
  if (field.startsWith('ctx.')) return NUMERIC_CTX.has(field.slice(4)) ? 'numeric' : 'text';
  return ENTITIES[entity]?.attrs[field] || 'text';
}

function opsFor(entity, field) {
  const type = typeOf(entity, field);
  const en = enumFor(field, entity);
  if (type === 'numeric') return ['eq', 'ne', 'lt', 'lte', 'gt', 'gte'];
  if (en || field.startsWith('ctx.')) return ['eq', 'ne', 'in', 'nin'];
  return ['eq', 'ne', 'in', 'nin', 'isNull', 'notNull'];
}

/** Opções de valor para campos enumerados / com origem no store. */
function choicesFor(en, state) {
  if (en.kind === 'enum') return Object.entries(en.values).map(([value, label]) => ({ value, label }));
  if (en.source === 'stage') return state.pipelines.flatMap((p) => p.stages.map((s) => ({ value: s.id, label: `${p.name} › ${s.name}` })));
  if (en.source === 'pipeline') return state.pipelines.map((p) => ({ value: p.id, label: p.name }));
  if (en.source === 'instance') return state.instances.map((i) => ({ value: i.id, label: i.name }));
  return [];
}

function resetForField(c, entity) {
  const ops = opsFor(entity, c.field);
  if (!ops.includes(c.op)) c.op = ops[0];
  delete c.ref;
  c.value = LIST_OPS.has(c.op) ? [] : undefined;
}

function changeOp(c, op) {
  const prev = c.value;
  c.op = op;
  if (NO_VALUE.has(op)) {
    delete c.value;
    delete c.ref;
  } else if (LIST_OPS.has(op)) {
    c.value = Array.isArray(prev) ? prev : prev === undefined ? [] : [prev];
    if (c.ref !== '$user.teamIds') delete c.ref;
  } else {
    c.value = Array.isArray(prev) ? prev[0] : prev;
    if (c.ref !== '$user.id') delete c.ref;
  }
}

/**
 * conditionList({ conds, entity, actions, state, readOnly, fk, onStructure, onValue, addLabel })
 * Devolve um nó. `conds` é mutado diretamente.
 */
export function conditionList({ conds, entity, actions, state, readOnly = false, fk, onStructure, onValue, addLabel = '+ Condição' }) {
  const fields = fieldOptions(entity, actions);
  const rows = conds.map((c, i) => {
    const key = `${fk}:c${i}`;
    const type = typeOf(entity, c.field);
    const en = enumFor(c.field, entity);
    const fieldKnown = fields.some((f) => f.value === c.field);
    const fieldOpts = fieldKnown ? fields : [...fields, { value: c.field, label: `${conditionFieldLabel(c.field)} (indisponível)`, group: 'Outros' }];
    const ops = opsFor(entity, c.field);
    const opOpts = (ops.includes(c.op) ? ops : [...ops, c.op]).map((o) => ({ value: o, label: OP_LABELS[o] || o }));

    // ---- valor ----
    let valueNode = null;
    if (!NO_VALUE.has(c.op)) {
      const isList = LIST_OPS.has(c.op);
      const refCapable = type === 'uuid' && !en;
      const useRef = refCapable && c.ref !== undefined;
      const refChoices = REFS.filter((r) => (isList ? r === '$user.teamIds' : r === '$user.id'));
      const modeSel = refCapable
        ? selectEl({
            options: [
              { value: 'fixed', label: 'Valor informado' },
              ...refChoices.map((r) => ({ value: r, label: REF_LABELS[r].replace(/^./, (x) => x.toUpperCase()) })),
            ],
            value: useRef ? c.ref : 'fixed',
            label: 'Comparar com',
            fk: `${key}:mode`,
            disabled: readOnly,
            cls: 'perm-sel--sm',
            onChange: (v) => {
              if (v === 'fixed') {
                delete c.ref;
                c.value = isList ? [] : undefined;
              } else {
                c.ref = v;
                delete c.value;
              }
              onStructure();
            },
          })
        : null;
      let input = null;
      if (!useRef) {
        if (en) {
          const choices = choicesFor(en, state);
          if (isList) {
            const cur = Array.isArray(c.value) ? c.value : [];
            input = h(
              'div',
              { class: 'perm-chips', role: 'group', 'aria-label': 'Valores' },
              choices.map((o, k) =>
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'perm-toggle',
                    'aria-pressed': String(cur.includes(o.value)),
                    disabled: readOnly,
                    'data-fk': `${key}:v${k}`,
                    onclick: () => {
                      c.value = cur.includes(o.value) ? cur.filter((x) => x !== o.value) : [...cur, o.value];
                      onStructure();
                    },
                  },
                  o.label
                )
              )
            );
          } else {
            input = selectEl({ options: [{ value: '', label: 'Escolha…' }, ...choices], value: c.value ?? '', label: 'Valor', fk: `${key}:v`, disabled: readOnly, cls: 'perm-sel--sm', onChange: (v) => { c.value = v === '' ? undefined : v; onValue(); } });
          }
        } else if (type === 'numeric') {
          const shown = isList ? (Array.isArray(c.value) ? c.value.join(', ') : '') : c.value ?? '';
          input = h('input', {
            class: 'input perm-input--sm',
            type: isList ? 'text' : 'number',
            step: 'any',
            'aria-label': isList ? 'Valores separados por vírgula' : 'Valor',
            placeholder: isList ? 'ex.: 10, 20' : 'número',
            value: String(shown),
            disabled: readOnly,
            'data-fk': `${key}:v`,
            oninput: (e) => {
              const raw = e.target.value;
              if (isList) c.value = raw.split(',').map((s) => s.trim()).filter(Boolean).map(Number).filter((n) => !Number.isNaN(n));
              else c.value = raw === '' ? undefined : Number(raw);
              onValue();
            },
          });
        } else {
          const shown = isList ? (Array.isArray(c.value) ? c.value.join(', ') : '') : c.value ?? '';
          input = h('input', {
            class: 'input perm-input--sm',
            type: 'text',
            'aria-label': isList ? 'Valores separados por vírgula' : 'Valor',
            placeholder: isList ? 'valor1, valor2' : 'valor',
            value: String(shown),
            disabled: readOnly,
            'data-fk': `${key}:v`,
            oninput: (e) => {
              const raw = e.target.value;
              if (isList) c.value = raw.split(',').map((s) => s.trim()).filter(Boolean);
              else c.value = raw === '' ? undefined : raw;
              onValue();
            },
          });
        }
      }
      valueNode = h('div', { class: 'perm-cond__value' }, modeSel, input);
    }

    return h(
      'li',
      { class: 'perm-cond' },
      h(
        'div',
        { class: 'perm-cond__main' },
        selectEl({ options: fieldOpts, value: c.field, label: 'Campo da condição', fk: `${key}:f`, disabled: readOnly, cls: 'perm-sel--sm', onChange: (v) => { c.field = v; resetForField(c, entity); onStructure(); } }),
        selectEl({ options: opOpts, value: c.op, label: 'Operador', fk: `${key}:o`, disabled: readOnly, cls: 'perm-sel--sm', onChange: (v) => { changeOp(c, v); onStructure(); } }),
        valueNode
      ),
      readOnly
        ? null
        : h('button', { class: 'perm-iconbtn', type: 'button', title: 'Remover condição', 'aria-label': `Remover condição ${i + 1}`, 'data-fk': `${key}:rm`, onclick: () => { conds.splice(i, 1); onStructure(); } }, icon(ICON.close, 14))
    );
  });

  const canAdd = !readOnly && fields.length > 0;
  return h(
    'div',
    { class: 'perm-conds' },
    rows.length ? h('ul', { class: 'perm-cond-list' }, rows) : null,
    canAdd
      ? h(
          'button',
          {
            class: 'btn btn--quiet btn--sm perm-addbtn',
            type: 'button',
            'data-fk': `${fk}:add`,
            onclick: () => {
              const f = fields[0].value;
              const c = { field: f, op: opsFor(entity, f)[0] };
              if (LIST_OPS.has(c.op)) c.value = [];
              conds.push(c);
              onStructure();
            },
          },
          addLabel
        )
      : null
  );
}
