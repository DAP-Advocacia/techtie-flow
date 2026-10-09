// Menu "Mover para…" — alternativa por teclado/ponteiro ao arrastar e soltar.
// Fica no <body> (position:fixed) para não ser cortado pelo overflow do quadro.
import { h } from '../../ui.js';
import { reasonOf } from './perm.js';

let current = null;

export function closeMoveMenu({ restoreFocus = true } = {}) {
  if (!current) return;
  const { el, anchor, returnTo, off } = current;
  current = null;
  off();
  el.remove();
  anchor.setAttribute('aria-expanded', 'false');
  // returnTo pode ser função: o gatilho some do DOM se a tela re-renderizar com o menu aberto.
  const back = typeof returnTo === 'function' ? returnTo() : returnTo;
  if (restoreFocus && back?.isConnected) back.focus();
}

/**
 * `options`: [{ stage, decision }] — `decision` vem do motor; destino negado/que exige aprovação aparece
 * desabilitado com o motivo (acessível: o motivo faz parte do nome do botão).
 * `returnTo`: elemento (ou função que o resolve) que recebe o foco ao fechar com Esc (padrão: o próprio gatilho).
 */
export function openMoveMenu({ anchor, options, currentStageId, onPick, returnTo = anchor }) {
  closeMoveMenu({ restoreFocus: false });

  const items = options.map(({ stage: st, decision }) => {
    const here = st.id === currentStageId;
    const blocked = !here && decision.effect !== 'allow';
    const why = blocked ? (decision.effect === 'approval' ? 'Requer aprovação de um gestor' : reasonOf(decision, 'mover este negócio')) : '';
    return h(
      'button',
      {
        class: 'pipeline-menu__item' + (blocked ? ' is-blocked' : ''),
        type: 'button',
        role: 'menuitem',
        disabled: here || blocked,
        title: why || null,
        onclick: () => {
          closeMoveMenu({ restoreFocus: false });
          onPick(st.id);
        },
      },
      h('span', { class: 'pipeline-menu__dot', style: { background: st.accent } }),
      h('span', { class: 'pipeline-menu__name' }, st.name, blocked ? h('span', { class: 'pipeline-menu__why' }, why) : null),
      here ? h('span', { class: 'pipeline-menu__here' }, 'atual') : null
    );
  });
  const el = h('div', { class: 'pipeline-menu', role: 'menu', 'aria-label': 'Mover para' }, h('div', { class: 'label pipeline-menu__title' }, 'Mover para…'), ...items);
  document.body.append(el);

  // Posiciona sob o gatilho; vira para cima/esquerda se faltar espaço.
  const r = anchor.getBoundingClientRect();
  const mw = el.offsetWidth;
  const mh = el.offsetHeight;
  const left = Math.max(8, Math.min(r.right - mw, window.innerWidth - mw - 8));
  const top = r.bottom + 6 + mh > window.innerHeight - 8 ? Math.max(8, r.top - mh - 6) : r.bottom + 6;
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  anchor.setAttribute('aria-expanded', 'true');

  const enabled = () => items.filter((b) => !b.disabled);
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeMoveMenu();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const list = enabled();
      const i = list.indexOf(document.activeElement);
      const next = e.key === 'ArrowDown' ? (i + 1) % list.length : (i - 1 + list.length) % list.length;
      list[next]?.focus();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      closeMoveMenu();
    }
  };
  const onDown = (e) => {
    if (!el.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) closeMoveMenu({ restoreFocus: false });
  };
  const onDismiss = () => closeMoveMenu({ restoreFocus: false });
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onDown, true);
  window.addEventListener('resize', onDismiss);
  // Rolar o quadro desloca o gatilho: fecha em vez de deixar o menu flutuando solto.
  document.addEventListener('scroll', onDismiss, true);
  const off = () => {
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('resize', onDismiss);
    document.removeEventListener('scroll', onDismiss, true);
  };
  current = { el, anchor, returnTo, off };
  (enabled()[0] || items[0])?.focus();
}
