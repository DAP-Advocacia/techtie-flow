// Detalhes de movimento: ondinha dourada ao clicar em botões/pílulas/cartões e chuva curta de brilhos nos momentos de
// conquista (negócio ganho, tarefa feita, meta batida). Só decora: nada depende disso, some com "reduzir movimento".
const SEL = '.btn, .pill, .contacts-chip, .stage-chip, .home-tile, .home-stat, .picker__btn';
let last = null; // onde foi o último clique (os brilhos nascem ali)
const burstDone = new Set();

const hasDom = () => typeof document !== 'undefined' && !!document.body;
export const motionOk = () => {
  try {
    return !globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return true;
  }
};

/** Ondinha a partir do ponto do clique, dentro do elemento (ele já é `position: relative; overflow: hidden` no CSS). */
export function ripple(el, x, y) {
  if (!hasDom() || !motionOk() || el.disabled || el.getAttribute('aria-disabled') === 'true') return null;
  const r = el.getBoundingClientRect?.() || { left: 0, top: 0, width: 0, height: 0 };
  const size = Math.max(r.width, r.height, 24) * 2;
  const dot = document.createElement('span');
  dot.className = 'fx-ripple';
  dot.setAttribute('aria-hidden', 'true');
  dot.style.cssText = `width:${size}px;height:${size}px;left:${x - r.left - size / 2}px;top:${y - r.top - size / 2}px`;
  el.append(dot);
  dot.addEventListener('animationend', () => dot.remove());
  setTimeout(() => dot.remove(), 900); // se a animação não rodar, não deixa lixo no DOM
  return dot;
}

/** Chuva curta de brilhos de 4 pontas (dourados) saindo de (x, y); por padrão, do último clique. */
export function burst({ x, y, n = 12 } = {}) {
  if (!hasDom() || !motionOk()) return null;
  const at = last || { x: (globalThis.innerWidth || 800) / 2, y: (globalThis.innerHeight || 600) / 3 };
  const box = document.createElement('div');
  box.className = 'fx-burst';
  box.setAttribute('aria-hidden', 'true');
  box.style.cssText = `left:${x ?? at.x}px;top:${y ?? at.y}px`;
  for (let i = 0; i < n; i++) {
    const a = (Math.PI * 2 * i) / n + Math.random() * 0.5;
    const d = 46 + Math.random() * 56;
    const s = document.createElement('span');
    s.className = 'fx-spark' + (i % 3 === 0 ? ' fx-spark--alt' : '');
    s.style.cssText = `--dx:${Math.round(Math.cos(a) * d)}px;--dy:${Math.round(Math.sin(a) * d - 12)}px;--s:${(0.55 + Math.random() * 0.8).toFixed(2)};--r:${Math.round(Math.random() * 180)}deg;--t:${(0.6 + Math.random() * 0.35).toFixed(2)}s`;
    box.append(s);
  }
  document.body.append(box);
  setTimeout(() => box.remove(), 1200);
  return box;
}

/** Como `burst`, mas só uma vez por `key` (ex.: meta do mês batida). */
export function burstOnce(key) {
  if (burstDone.has(key)) return null;
  burstDone.add(key);
  return burst();
}

export function initFx() {
  if (!hasDom()) return;
  document.addEventListener(
    'pointerdown',
    (e) => {
      last = { x: e.clientX, y: e.clientY };
      const el = e.target?.closest?.(SEL);
      if (el) ripple(el, e.clientX, e.clientY);
    },
    true
  );
}
