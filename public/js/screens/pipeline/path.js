// "Path": as etapas do funil como setas no topo da página do negócio (ideia do Salesforce). A etapa atual fica
// destacada, as anteriores marcadas como feitas; clicar numa etapa move o negócio — passando pelo MESMO caminho de
// permissão e confirmação do quadro. Etapa que o motor não deixa usar fica desabilitada, com o motivo.
import { h, icon } from '../../ui.js';
import * as P from './perm.js';

const CHECK = 'M5 12.5l4.5 4.5L19 7';

/** Estado de cada etapa em relação ao negócio: 'done' | 'current' | 'todo' (+ kind: open | won | lost). */
export function pathSteps(pipeline, deal) {
  const stages = pipeline?.stages || [];
  const cur = stages.findIndex((s) => s.id === deal.stageId);
  return stages.map((s, i) => ({ stage: s, kind: s.kind || 'open', state: i === cur ? 'current' : cur >= 0 && i < cur && (s.kind || 'open') === 'open' ? 'done' : 'todo' }));
}

/** @param onMove(stage)  chamado ao clicar numa etapa que o motor permite */
export function renderPath({ pipeline, deal, onMove }) {
  const steps = pathSteps(pipeline, deal);
  return h(
    'ol',
    { class: 'path', 'aria-label': 'Etapas do funil' },
    ...steps.map(({ stage, kind, state }) => {
      const dec = state === 'current' ? null : P.moveDecision(deal, stage);
      const blocked = !!dec && dec.effect !== 'allow';
      const why = !dec ? 'Etapa atual' : dec.effect === 'allow' ? `Mover para ${stage.name}` : dec.effect === 'approval' ? 'Requer aprovação de um gestor' : P.reasonOf(dec, 'mover este negócio');
      return h(
        'li',
        { class: `path__item path__item--${state} path__item--${kind}` },
        h(
          'button',
          { class: 'path__step', type: 'button', 'aria-current': state === 'current' ? 'step' : null, 'aria-disabled': blocked ? 'true' : null, disabled: state === 'current', title: why, 'data-stage': stage.id, onclick: () => !blocked && state !== 'current' && onMove(stage) },
          state === 'done' ? h('span', { class: 'path__check', 'aria-hidden': 'true' }, icon(CHECK, 14)) : null,
          h('span', { class: 'path__name' }, stage.name)
        )
      );
    })
  );
}
