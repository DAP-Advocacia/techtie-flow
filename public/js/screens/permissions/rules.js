// Seções "Regras avançadas" (grants com condição/aprovação) e "Negações"
// (denies — vencem tudo) do editor de perfil, mais os presets de 1 clique.
// Tudo aqui edita o RASCUNHO (ed.role); nada vai ao store sem passar pelo
// diálogo "Revisar e salvar" (que valida no motor).
import { h, icon, toast } from '../../ui.js';
import { ENTITIES, ACTIONS } from '/shared/permissions/index.js';
import { entityLabel, actionLabel, scopeLabel, describeGrant, describeDeny, SECTIONS } from './labels.js';
import { isAdvanced, PRESETS } from './model.js';
import { conditionList, fieldOptions } from './conditions.js';
import { selectEl, ICON, nextId } from './util.js';

const entityOptions = (withStar) => [
  ...(withStar ? [{ value: '*', label: 'Todas as entidades' }] : []),
  ...SECTIONS.flatMap((s) => s.entities.map((e) => ({ value: e, label: entityLabel(e), group: s.label }))),
];

const validActions = (entity) => (entity === '*' ? [...new Set(Object.values(ENTITIES).flatMap((e) => e.actions))] : ENTITIES[entity]?.actions || []);

/** Mantém só as condições cujo campo ainda existe para (entidade, ações). */
function pruneConditions(list, entity, actions, ns) {
  const ok = new Set(fieldOptions(entity, actions).map((o) => o.value));
  return (list || []).filter((c) => ok.has(c.field));
}

function chipsOf({ entity, actions, readOnly, fk, allowAll, onChange }) {
  const options = validActions(entity);
  const selected = new Set(actions);
  return h(
    'div',
    { class: 'perm-chips', role: 'group', 'aria-label': 'Ações' },
    allowAll
      ? h('button', { type: 'button', class: 'perm-toggle', 'aria-pressed': String(selected.has('*')), disabled: readOnly, 'data-fk': `${fk}:a*`, onclick: () => onChange(selected.has('*') ? [] : ['*']) }, 'Todas as ações')
      : null,
    options.map((a) =>
      h(
        'button',
        {
          type: 'button',
          class: 'perm-toggle' + (ACTIONS[a]?.sensitive ? ' is-sensitive' : ''),
          'aria-pressed': String(selected.has(a) && !selected.has('*')),
          disabled: readOnly || selected.has('*'),
          'data-fk': `${fk}:a${a}`,
          onclick: () => {
            const next = new Set(selected);
            next.delete('*');
            next.has(a) ? next.delete(a) : next.add(a);
            onChange(options.filter((x) => next.has(x)));
          },
        },
        actionLabel(a)
      )
    )
  );
}

function presetBar(ed, area) {
  const mine = PRESETS.filter((p) => p.area === area || p.area === 'both');
  const add = (p, x) => {
    const built = p.build(x);
    const role = ed.role;
    let added = 0;
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    for (const g of built.grants) if (!role.grants.some((r) => same({ ...r, _adv: undefined }, { ...g, _adv: undefined }))) { role.grants.push(g); added++; }
    for (const d of built.denies) if (!role.denies.some((r) => same(r, d))) { role.denies.push(d); added++; }
    if (!added) return toast('Esta regra já existe neste perfil.');
    toast(`Regra adicionada: ${p.label.replace('X', x ?? '')}`);
    ed.refresh(['matrix', 'adv', 'deny']);
  };
  return h(
    'div',
    { class: 'perm-presets', role: 'group', 'aria-label': 'Atalhos prontos' },
    h('span', { class: 'perm-presets__label' }, 'Atalhos prontos'),
    mine.map((p) => {
      if (!p.param) {
        const label = p.area === 'both' && area === 'grants' ? `${p.label} (cria uma negação)` : p.label;
        return h('button', { class: 'perm-preset', type: 'button', title: p.hint, 'data-fk': `preset:${area}:${p.id}`, onclick: () => add(p) }, '+ ', label);
      }
      const [pre, post] = p.label.split('X');
      const input = h('input', { class: 'input perm-input--xs', type: 'number', min: p.param.min, max: p.param.max, value: String(p.param.value), 'aria-label': p.param.label, 'data-fk': `preset:${area}:${p.id}:x` });
      return h(
        'span',
        { class: 'perm-preset perm-preset--param', title: p.hint },
        h('button', { class: 'perm-preset__add', type: 'button', 'aria-label': `Adicionar: ${p.label}`, 'data-fk': `preset:${area}:${p.id}`, onclick: () => {
          const x = Number(input.value);
          if (Number.isNaN(x) || x < p.param.min || x > p.param.max) return toast(`${p.param.label}: informe um número entre ${p.param.min} e ${p.param.max}.`);
          add(p, x);
        } }, '+'),
        h('span', null, pre),
        input,
        h('span', null, post)
      );
    })
  );
}

// slot preenchido no lugar pelo editor (fillErrSlots) — assim o erro some assim que a pessoa corrige o valor
const errorSlot = (kind, i, msgs) => h('ul', { class: 'perm-errors perm-errors--slot', role: 'alert', 'data-errslot': `${kind}:${i}` }, (msgs || []).map((m) => h('li', null, m.charAt(0).toUpperCase() + m.slice(1))));

// ---------------------------------------------------------------------------
// Regras avançadas
// ---------------------------------------------------------------------------
export function advancedSection(ed) {
  const { role, readOnly, state, ns } = ed;
  const adv = role.grants.filter(isAdvanced);
  const addRule = () => {
    role.grants.push({ _adv: true, entity: 'deal', actions: ['read'], scope: 'own', conditions: [] });
    ed.refresh(['adv'], { focus: `adv${adv.length}:entity` });
  };

  const cards = adv.map((g, i) => {
    const fk = `adv${i}`;
    if (readOnly) return h('li', { class: 'perm-rule perm-rule--ro' }, h('span', { class: 'perm-rule__sum' }, describeGrant(role.name || 'Este perfil', g, ns)));
    const ent = ENTITIES[g.entity];
    const scopes = (ent?.scopes || ['tenant']).filter((s) => s !== 'none');
    const errs = ed.errs?.byAdv.get(i);
    const approvalOn = !!g.approval;
    return h(
      'li',
      { class: 'perm-rule' },
      h(
        'div',
        { class: 'perm-rule__head' },
        h('span', { class: 'perm-rule__sum' }, h('span', { class: 'perm-flag', 'aria-hidden': 'true' }, '⚙'), ' ', describeGrant(role.name || 'Este perfil', { ...g, conditions: g.conditions || [] }, ns)),
        h('button', { class: 'perm-iconbtn', type: 'button', title: 'Remover regra', 'aria-label': `Remover regra avançada ${i + 1}`, 'data-fk': `${fk}:rm`, onclick: () => { role.grants.splice(role.grants.indexOf(g), 1); ed.refresh(['matrix', 'adv']); } }, icon(ICON.trash, 15))
      ),
      h(
        'div',
        { class: 'perm-rule__row' },
        h('label', { class: 'perm-mini' }, h('span', null, 'Recurso'), selectEl({
          options: entityOptions(g.entity === '*'),
          value: g.entity,
          label: `Recurso da regra ${i + 1}`,
          fk: `${fk}:entity`,
          cls: 'perm-sel--sm',
          onChange: (v) => {
            g.entity = v;
            const valid = validActions(v);
            g.actions = g.actions.filter((a) => valid.includes(a));
            if (!g.actions.length) g.actions = [valid[0]];
            const sc = (ENTITIES[v]?.scopes || ['tenant']).filter((s) => s !== 'none');
            if (!sc.includes(g.scope)) g.scope = sc[sc.length - 1];
            g.conditions = pruneConditions(g.conditions, v, g.actions, ns);
            if (g.approval) g.approval.when = pruneConditions(g.approval.when, v, g.actions, ns);
            ed.refresh(['matrix', 'adv']);
          },
        })),
        h('label', { class: 'perm-mini' }, h('span', null, 'Escopo'), selectEl({
          options: scopes.map((s) => ({ value: s, label: scopeLabel(s) })),
          value: g.scope,
          label: `Escopo da regra ${i + 1}`,
          fk: `${fk}:scope`,
          cls: 'perm-sel--sm',
          onChange: (v) => { g.scope = v; ed.refresh(['adv']); },
        }))
      ),
      h('div', { class: 'perm-rule__block' }, h('span', { class: 'perm-mini__t' }, 'Ações'), chipsOf({
        entity: g.entity,
        actions: g.actions,
        fk,
        readOnly,
        allowAll: false,
        onChange: (next) => { g.actions = next.length ? next : g.actions; g.conditions = pruneConditions(g.conditions, g.entity, g.actions, ns); ed.refresh(['matrix', 'adv']); },
      })),
      h(
        'div',
        { class: 'perm-rule__block' },
        h('span', { class: 'perm-mini__t' }, 'Vale somente quando (todas as condições)'),
        (g.conditions ||= []) && conditionList({ conds: g.conditions, entity: g.entity, actions: g.actions, state, readOnly, fk: `${fk}:w`, onStructure: () => ed.refresh(['adv']), onValue: () => ed.touch() }),
        !g.conditions.length && !approvalOn ? h('div', { class: 'perm-hint' }, 'Sem condição nem aprovação, esta regra equivale a uma permissão simples (vai para a matriz ao salvar).') : null
      ),
      h(
        'div',
        { class: 'perm-rule__block' },
        h('label', { class: 'perm-check' }, h('input', { type: 'checkbox', checked: approvalOn, 'data-fk': `${fk}:appr`, onchange: (e) => { if (e.target.checked) g.approval = { when: [] }; else delete g.approval; ed.refresh(['adv']); } }), h('span', null, 'Exigir aprovação de um gestor quando…')),
        approvalOn
          ? [
              conditionList({ conds: g.approval.when, entity: g.entity, actions: g.actions, state, readOnly, fk: `${fk}:ap`, onStructure: () => ed.refresh(['adv']), onValue: () => ed.touch() }),
              !g.approval.when.length ? h('div', { class: 'perm-hint' }, 'Sem condições: toda execução desta regra exige aprovação.') : null,
            ]
          : null
      ),
      errorSlot('adv', i, errs)
    );
  });

  return h(
    'div',
    { class: 'perm-sec-body' },
    h('p', { class: 'perm-hint' }, 'Regras que só valem sob certas condições (ex.: conversa sem responsável, desconto até um limite) ou que exigem aprovação. Aparecem na matriz com o marcador ⚙.'),
    readOnly ? null : presetBar(ed, 'grants'),
    cards.length ? h('ul', { class: 'perm-rule-list' }, cards) : h('div', { class: 'perm-none' }, 'Nenhuma regra avançada neste perfil.'),
    readOnly ? null : h('button', { class: 'btn btn--ghost btn--sm perm-addbtn', type: 'button', 'data-fk': 'adv:add', onclick: addRule }, icon(ICON.plus, 14), ' Nova regra avançada')
  );
}

// ---------------------------------------------------------------------------
// Negações
// ---------------------------------------------------------------------------
export function deniesSection(ed) {
  const { role, readOnly, state, ns } = ed;
  const cards = role.denies.map((d, i) => {
    const fk = `deny${i}`;
    if (readOnly) return h('li', { class: 'perm-rule perm-rule--ro perm-rule--deny' }, h('span', { class: 'perm-rule__sum' }, describeDeny(role.name || 'Este perfil', d, ns)));
    const star = d.entity === '*';
    return h(
      'li',
      { class: 'perm-rule perm-rule--deny' },
      h(
        'div',
        { class: 'perm-rule__head' },
        h('span', { class: 'perm-rule__sum' }, h('span', { class: 'perm-flag perm-flag--deny', 'aria-hidden': 'true' }, '⊘'), ' ', describeDeny(role.name || 'Este perfil', d, ns)),
        h('button', { class: 'perm-iconbtn', type: 'button', title: 'Remover negação', 'aria-label': `Remover negação ${i + 1}`, 'data-fk': `${fk}:rm`, onclick: () => { role.denies.splice(i, 1); ed.refresh(['matrix', 'deny']); } }, icon(ICON.trash, 15))
      ),
      h(
        'div',
        { class: 'perm-rule__row' },
        h('label', { class: 'perm-mini' }, h('span', null, 'Recurso'), selectEl({
          options: entityOptions(true),
          value: d.entity,
          label: `Recurso da negação ${i + 1}`,
          fk: `${fk}:entity`,
          cls: 'perm-sel--sm',
          onChange: (v) => {
            d.entity = v;
            const valid = validActions(v);
            d.actions = d.actions.includes('*') ? d.actions : d.actions.filter((a) => valid.includes(a));
            if (!d.actions.length) d.actions = [valid[0]];
            // '*' não tem atributos comuns a todas as entidades: condições só em entidade específica
            d.conditions = v === '*' ? [] : pruneConditions(d.conditions, v, d.actions, ns);
            ed.refresh(['matrix', 'deny']);
          },
        }))
      ),
      h('div', { class: 'perm-rule__block' }, h('span', { class: 'perm-mini__t' }, 'Ações bloqueadas'), chipsOf({
        entity: d.entity,
        actions: d.actions,
        fk,
        readOnly,
        allowAll: true,
        onChange: (next) => { d.actions = next.length ? next : d.actions; d.conditions = star ? [] : pruneConditions(d.conditions, d.entity, d.actions, ns); ed.refresh(['matrix', 'deny']); },
      })),
      star
        ? h('div', { class: 'perm-hint' }, 'Aplica-se a todos os recursos. Para bloquear só sob uma condição, escolha um recurso específico.')
        : h('div', { class: 'perm-rule__block' }, h('span', { class: 'perm-mini__t' }, 'Bloqueia somente quando (vazio = sempre)'), (d.conditions ||= []) && conditionList({ conds: d.conditions, entity: d.entity, actions: d.actions, state, readOnly, fk: `${fk}:w`, onStructure: () => ed.refresh(['deny']), onValue: () => ed.touch() })),
      errorSlot('deny', i, ed.errs?.denies.get(i))
    );
  });
  return h(
    'div',
    { class: 'perm-sec-body' },
    h('p', { class: 'perm-hint' }, 'Negações vencem qualquer permissão, inclusive de outros perfis do mesmo usuário. Use para travas que não podem ser contornadas.'),
    readOnly ? null : presetBar(ed, 'denies'),
    cards.length ? h('ul', { class: 'perm-rule-list' }, cards) : h('div', { class: 'perm-none' }, 'Nenhuma negação neste perfil.'),
    readOnly ? null : h('button', { class: 'btn btn--ghost btn--sm perm-addbtn', type: 'button', 'data-fk': 'deny:add', onclick: () => { role.denies.push({ entity: 'deal', actions: ['delete'], conditions: [] }); ed.refresh(['deny'], { focus: `deny${role.denies.length - 1}:entity` }); } }, icon(ICON.plus, 14), ' Nova negação')
  );
}

export { nextId };
