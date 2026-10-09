// Seções "Recortes (partições)" e "Campos sensíveis" do editor de perfil.
// Recorte = o perfil só alcança os pipelines/instâncias marcados (vale para
// TODAS as regras do perfil sobre as entidades que usam a chave). Campo
// sensível = esconder ou travar um dado mesmo quando o registro é acessível.
import { h } from '../../ui.js';
import { ENTITIES, PARTITIONS } from '/shared/permissions/index.js';
import { entityLabel, fieldLabel, FIELD_ACCESS_LABELS } from './labels.js';
import { nextId, sr } from './util.js';

const SOURCES = {
  pipelineId: (s) => s.pipelines.map((p) => ({ id: p.id, name: p.name })),
  instanceId: (s) => s.instances.map((i) => ({ id: i.id, name: i.name, sub: i.phone })),
};

/** Entidades afetadas por uma chave de partição, em texto ("Negócios"). */
const affected = (key) =>
  Object.entries(ENTITIES)
    .filter(([, e]) => Object.values(e.partitions || {}).length && Object.keys(e.partitions).includes(key))
    .map(([n]) => entityLabel(n))
    .join(', ');

export function partitionsSection(ed) {
  const { role, readOnly, state } = ed;
  role.partitions ||= {};
  return h(
    'div',
    { class: 'perm-sec-body' },
    h('p', { class: 'perm-hint' }, 'Limita o perfil a parte dos pipelines ou dos números de WhatsApp. O recorte vale para todas as regras do perfil.'),
    Object.keys(PARTITIONS).map((key) => {
      const items = SOURCES[key](state);
      const cur = role.partitions[key];
      const all = cur === undefined || cur === 'all';
      const list = all ? [] : cur;
      const name = nextId('part');
      const known = new Set(items.map((i) => i.id));
      const orphan = list.filter((id) => !known.has(id)); // ids de algo que foi removido: mostra, não esconde
      const setAll = (v) => {
        if (v) delete role.partitions[key];
        else role.partitions[key] = [];
        ed.refresh(['part']);
      };
      return h(
        'fieldset',
        { class: 'perm-part', disabled: readOnly },
        h('legend', { class: 'perm-part__legend' }, PARTITIONS[key].label, h('span', { class: 'perm-hint' }, ` · afeta ${affected(key)}`)),
        h(
          'div',
          { class: 'perm-radios' },
          h('label', { class: 'perm-radio' }, h('input', { type: 'radio', name, checked: all, 'data-fk': `part:${key}:all`, onchange: () => setAll(true) }), h('span', null, 'Todos')),
          h('label', { class: 'perm-radio' }, h('input', { type: 'radio', name, checked: !all, 'data-fk': `part:${key}:some`, onchange: () => setAll(false) }), h('span', null, 'Escolher'))
        ),
        all
          ? null
          : h(
              'div',
              { class: 'perm-checks' },
              items.map((it) =>
                h(
                  'label',
                  { class: 'perm-check' },
                  h('input', {
                    type: 'checkbox',
                    checked: list.includes(it.id),
                    'data-fk': `part:${key}:${it.id}`,
                    onchange: (e) => {
                      role.partitions[key] = e.target.checked ? [...list, it.id] : list.filter((x) => x !== it.id);
                      ed.refresh(['part']);
                    },
                  }),
                  h('span', null, it.name, it.sub ? h('small', { class: 'muted' }, ` · ${it.sub}`) : null)
                )
              ),
              orphan.map((id) =>
                h(
                  'label',
                  { class: 'perm-check perm-check--orphan' },
                  h('input', { type: 'checkbox', checked: true, 'data-fk': `part:${key}:${id}`, onchange: () => { role.partitions[key] = list.filter((x) => x !== id); ed.refresh(['part']); } }),
                  h('span', null, `${id} (removido)`)
                )
              ),
              !list.length ? h('div', { class: 'perm-warn' }, 'Nada marcado: o perfil não alcança nenhum registro deste recorte (o motor falha fechado).') : null
            )
      );
    })
  );
}

export function fieldsSection(ed) {
  const { role, readOnly } = ed;
  role.fields ||= [];
  const accessOf = (entity, field) => role.fields.find((f) => f.entity === entity && f.field === field)?.access || 'write';
  const set = (entity, field, access) => {
    role.fields = role.fields.filter((f) => !(f.entity === entity && f.field === field));
    if (access !== 'write') role.fields.push({ entity, field, access });
    ed.refresh(['fields']);
  };
  const entities = Object.entries(ENTITIES).filter(([, e]) => e.fields.length);
  return h(
    'div',
    { class: 'perm-sec-body' },
    h('p', { class: 'perm-hint' }, 'Esconde ou trava dados sensíveis mesmo em registros que a pessoa pode abrir. A restrição mais forte entre os perfis do usuário vence.'),
    h(
      'div',
      { class: 'perm-fields' },
      entities.map(([entity, def]) =>
        h(
          'div',
          { class: 'perm-fgroup' },
          h('div', { class: 'perm-fgroup__t' }, entityLabel(entity)),
          def.fields.map((field) => {
            const name = nextId('fld');
            const labelId = `${name}-l`;
            const cur = accessOf(entity, field);
            return h(
              'div',
              { class: 'perm-frow', role: 'radiogroup', 'aria-labelledby': labelId },
              h('span', { class: 'perm-frow__label', id: labelId }, fieldLabel(entity, field)),
              h(
                'div',
                { class: 'perm-seg' },
                ['write', 'readonly', 'hidden'].map((acc) =>
                  h(
                    'label',
                    { class: `perm-seg__opt perm-seg--${acc}` },
                    h('input', { type: 'radio', name, value: acc, checked: cur === acc, disabled: readOnly, 'data-fk': `fld:${entity}.${field}:${acc}`, onchange: () => set(entity, field, acc) }),
                    h('span', null, FIELD_ACCESS_LABELS[acc])
                  )
                )
              )
            );
          })
        )
      )
    )
  );
}

export { sr };
