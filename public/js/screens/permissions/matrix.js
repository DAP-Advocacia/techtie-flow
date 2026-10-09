// Estrutura da matriz entidade × ação (compartilhada pelo editor de perfis e
// pelo mapa efetivo do simulador). Uma tabela por seção, só com as colunas de
// ações que existem nas entidades da seção — menos células vazias e rolagem
// menor que uma tabela única de 18 colunas. Cada tabela rola DENTRO do cartão
// (nunca estoura a página) com a 1ª coluna e o cabeçalho fixos.
import { h } from '../../ui.js';
import { ENTITIES } from '/shared/permissions/index.js';
import { SECTIONS, entityLabel, actionLabel, actionShort, actionsOf, isSensitive, SCOPE_LABELS } from './labels.js';
import { sr } from './util.js';

/**
 * matrixSections({ cell, scrollKey })
 *  cell(entity, action) -> Node da célula (conteúdo do <td>); só é chamada se a entidade tem a ação.
 */
export function matrixSections({ cell, scrollKey = 'm' }) {
  return SECTIONS.map((sec) => {
    const actions = actionsOf(sec.entities);
    const head = h(
      'tr',
      null,
      h('th', { scope: 'col', class: 'perm-matrix__corner' }, 'Recurso'),
      actions.map((a) =>
        h(
          'th',
          { scope: 'col', class: 'perm-matrix__col' + (isSensitive(a) ? ' is-sensitive' : ''), title: actionLabel(a) + (isSensitive(a) ? ' — ação sensível (pode exigir MFA)' : '') },
          actionShort(a),
          isSensitive(a) ? h('span', { class: 'perm-sensdot', 'aria-hidden': 'true' }, '●') : null,
          isSensitive(a) ? sr(' (ação sensível)') : null
        )
      )
    );
    const rows = sec.entities.map((e) =>
      h(
        'tr',
        null,
        h('th', { scope: 'row', class: 'perm-matrix__row' }, entityLabel(e)),
        actions.map((a) => {
          const sensitive = isSensitive(a);
          if (!ENTITIES[e].actions.includes(a)) return h('td', { class: 'perm-td perm-td--na' + (sensitive ? ' is-sensitive' : '') }, sr('não se aplica'));
          return h('td', { class: 'perm-td' + (sensitive ? ' is-sensitive' : '') }, cell(e, a));
        })
      )
    );
    return h(
      'section',
      { class: 'perm-msec', 'aria-label': sec.label },
      h('h4', { class: 'perm-msec__title' }, sec.label),
      h('div', { class: 'perm-scroll', 'data-scroll': `${scrollKey}:${sec.id}`, tabindex: '0', role: 'region', 'aria-label': `Matriz de permissões — ${sec.label}` }, h('table', { class: 'perm-matrix' }, h('thead', null, head), h('tbody', null, rows)))
    );
  });
}

/** Barrinhas de amplitude (0..4) — o mesmo vocabulário visual na matriz, no mapa e na legenda. */
export function meter(level) {
  return h('span', { class: 'perm-meter', 'aria-hidden': 'true', 'data-lvl': String(level) }, [1, 2, 3, 4].map((i) => h('i', { class: i <= level ? 'on' : '' })));
}

/** Legenda de escopos e marcadores. */
export function legend({ withFlags = true } = {}) {
  const scopes = ['none', 'own', 'team', 'team_tree', 'tenant'];
  return h(
    'div',
    { class: 'perm-legend', role: 'group', 'aria-label': 'Legenda' },
    scopes.map((s, i) => h('span', { class: `perm-legend__item perm-lvl-${i}`, title: SCOPE_LABELS[s].hint }, meter(i), SCOPE_LABELS[s].label)),
    withFlags
      ? [
          h('span', { class: 'perm-legend__item' }, h('span', { class: 'perm-flag', 'aria-hidden': 'true' }, '⚙'), 'regra avançada (condição ou aprovação)'),
          h('span', { class: 'perm-legend__item' }, h('span', { class: 'perm-flag perm-flag--deny', 'aria-hidden': 'true' }, '⊘'), 'negação'),
          h('span', { class: 'perm-legend__item' }, h('span', { class: 'perm-sensdot', 'aria-hidden': 'true' }, '●'), 'ação sensível'),
        ]
      : null
  );
}
