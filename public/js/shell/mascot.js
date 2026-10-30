// Mascote "Flow": bichinho roxo, felpudo e brilhante em SVG (gradientes, reflexos e borda de pelo dão o ar 3D), com orelhas pontudas.
// Cantinho fixo; ao clicar ele vem para o meio da tela com um chat ao lado e reage à conversa (sem IA, por palavras-chave).
// Os olhos e a cabeça seguem o cursor. Exceção consciente ao visual sóbrio do CRM: ele é o único toque "fofo".
import { h, replaceChildren } from '../ui.js';
import { MASCOT_NAME, greeting, idleMood, lookVector, nextTip, reply } from './mascot-model.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MIN_KEY = 'ttf:mascot';
const CHIPS = ['Dica desta tela', 'Quem é você?', 'Conte uma piada'];

let uid = 0;
/** Conversa da sessão (some ao recarregar a página; fica ao navegar entre telas). */
const history = [];
let replies = 0;

const reduced = () => {
  try {
    return !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};

// ---------- olhar que segue o cursor (um único ouvinte para todos os mascotes montados) ----------
const live = new Set();
let listening = false;
let frame = 0;
let cursor = null;

function applyLook() {
  frame = 0;
  if (!cursor) return;
  for (const root of [...live]) {
    if (!root.isConnected) {
      live.delete(root);
      continue;
    }
    const el = root.querySelector('.mascot__tilt');
    const r = el?.getBoundingClientRect?.();
    if (!r) continue;
    const v = lookVector(r.left + r.width / 2, r.top + r.height / 2, cursor.x, cursor.y);
    root.style.setProperty('--lx', v.x.toFixed(3));
    root.style.setProperty('--ly', v.y.toFixed(3));
    root.style.setProperty('--ax', Math.abs(v.x).toFixed(3));
    root.style.setProperty('--ay', Math.abs(v.y).toFixed(3));
  }
}

function onMove(e) {
  cursor = { x: e.clientX, y: e.clientY };
  if (!frame) frame = (globalThis.requestAnimationFrame || ((f) => setTimeout(f, 16)))(applyLook);
}

function track(root) {
  live.add(root);
  if (listening || reduced()) return;
  listening = true;
  document.addEventListener('pointermove', onMove, { passive: true });
}

// ---------- desenho ----------
function s(tag, attrs, ...kids) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  el.append(...kids.filter(Boolean));
  return el;
}

const INK = '#2a1458';
const stroke = { fill: 'none', stroke: INK, 'stroke-width': 3, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };

/** Olhos, boca e bochechas por humor (viewBox 0 0 100 100). */
function face(mood, id) {
  const eye = (cx) =>
    s('g', {}, s('ellipse', { cx, cy: 52, rx: 5.8, ry: 7.2, fill: `url(#${id}-eye)` }), s('circle', { cx: cx + 2.1, cy: 49, r: 2.4, fill: '#fff' }), s('circle', { cx: cx - 1.8, cy: 55, r: 1.1, fill: '#fff', opacity: 0.8 }));
  const eyes = () => s('g', { class: 'mascot__eyes' }, s('g', { class: 'mascot__look' }, eye(37), eye(63)));
  const heart = (cx) => s('path', { d: 'M0 -3C-6 -9 -12 0 0 8C12 0 6 -9 0 -3Z', fill: '#ff5fa8', transform: `translate(${cx} 52) scale(.62)` });
  const cheek = (cx, a = 0.55) => s('ellipse', { cx, cy: 63, rx: 8, ry: 4.8, fill: `url(#${id}-cheek)`, opacity: Math.min(1, a * 1.5) });
  const cheeks = (a) => [cheek(26, a), cheek(74, a)];
  switch (mood) {
    case 'sleep':
      return [s('path', { d: 'M32 54q5 4 10 0M58 54q5 4 10 0', ...stroke }), s('path', { d: 'M46 66q4 2.5 8 0', ...stroke }), ...cheeks()];
    case 'wow':
      return [eyes(), s('ellipse', { cx: 50, cy: 68, rx: 4.5, ry: 5.8, fill: INK }), ...cheeks()];
    case 'think':
      return [eyes(), s('path', { d: 'M44 67h12', ...stroke }), s('path', { d: 'M55 41q8-5 14-1', ...stroke, 'stroke-width': 2.4 }), ...cheeks()];
    case 'confused':
      return [eyes(), s('path', { d: 'M42 68q4-4 8 0t8 0', ...stroke }), s('path', { d: 'M56 42l12-3', ...stroke, 'stroke-width': 2.4 }), ...cheeks()];
    case 'love':
      return [s('g', { class: 'mascot__eyes' }, heart(37), heart(63)), s('path', { d: 'M42 64q8 10 16 0', ...stroke }), ...cheeks(0.8)];
    case 'laugh':
      return [
        s('path', { d: 'M31 55q6-9 12 0M57 55q6-9 12 0', ...stroke }),
        s('path', { d: 'M39 62q11 17 22 0z', fill: INK }),
        s('ellipse', { cx: 50, cy: 70, rx: 4.6, ry: 2.6, fill: '#ff7fb8' }),
        ...cheeks(0.7),
      ];
    case 'sad':
      return [eyes(), s('path', { d: 'M30 44l12 4M70 44l-12 4', ...stroke, 'stroke-width': 2.4 }), s('path', { d: 'M43 70q7-6 14 0', ...stroke }), ...cheeks(0.3)];
    default:
      return [eyes(), s('path', { d: 'M42 64q8 9 16 0', ...stroke }), ...cheeks()];
  }
}

/** O bichinho. `size` em px; `mood` troca a expressão. */
export function mascotSvg(mood = 'happy', size = 64) {
  const id = `mascot-${++uid}`;
  const stop = (offset, color, opacity) => s('stop', { offset, 'stop-color': color, ...(opacity == null ? {} : { 'stop-opacity': opacity }) });
  return s(
    'svg',
    { class: `mascot-art mascot-art--${mood}`, viewBox: '0 0 100 100', width: size, height: size, 'aria-hidden': 'true', focusable: 'false' },
    s(
      'defs',
      {},
      s('radialGradient', { id: `${id}-body`, cx: '36%', cy: '27%', r: '78%' }, stop('0', '#f3eaff'), stop('0.2', '#b896ff'), stop('0.55', '#7447e0'), stop('0.85', '#3f2092'), stop('1', '#2a1170')),
      s('radialGradient', { id: `${id}-belly`, cx: '50%', cy: '35%', r: '65%' }, stop('0', '#f1e6ff', 0.85), stop('1', '#c9a8ff', 0)),
      s('linearGradient', { id: `${id}-rim`, x1: '1', y1: '0.2', x2: '0.2', y2: '1' }, stop('0', '#ffb6f0', 0.9), stop('0.5', '#ffb6f0', 0.15), stop('1', '#ffb6f0', 0)),
      s('linearGradient', { id: `${id}-ear`, x1: '0', y1: '1', x2: '0', y2: '0' }, stop('0', '#7c4be0'), stop('1', '#4a2599')),
      s('linearGradient', { id: `${id}-inner`, x1: '0', y1: '1', x2: '0', y2: '0' }, stop('0', '#ff8fd2'), stop('1', '#ffc9ec')),
      s('radialGradient', { id: `${id}-glow`, cx: '50%', cy: '50%', r: '50%' }, stop('0', '#b794ff', 0.45), stop('1', '#b794ff', 0)),
      // sombra de forma: luz vem de cima à esquerda, então o miolo é claro e as bordas (embaixo/direita) escurecem
      s('radialGradient', { id: `${id}-shade`, cx: '38%', cy: '30%', r: '74%' }, stop('0.5', '#14063a', 0), stop('0.82', '#14063a', 0.34), stop('1', '#0c0326', 0.72)),
      s('radialGradient', { id: `${id}-bounce`, cx: '56%', cy: '104%', r: '52%' }, stop('0', '#ff8fe0', 0.6), stop('1', '#ff8fe0', 0)),
      s('radialGradient', { id: `${id}-eye`, cx: '38%', cy: '28%', r: '75%' }, stop('0', '#6b42c9'), stop('0.5', '#2a1458'), stop('1', '#10062a')),
      s('radialGradient', { id: `${id}-cheek`, cx: '50%', cy: '50%', r: '50%' }, stop('0', '#ff8fcf', 0.95), stop('1', '#ff8fcf', 0)),
      s('radialGradient', { id: `${id}-foot`, cx: '38%', cy: '25%', r: '85%' }, stop('0', '#9a6cf2'), stop('1', '#3d1d8c')),
      s('filter', { id: `${id}-blur`, x: '-20%', y: '-60%', width: '140%', height: '220%' }, s('feGaussianBlur', { stdDeviation: '2.4' })),
      // borda irregular = pelinho
      s(
        'filter',
        { id: `${id}-fur`, x: '-10%', y: '-10%', width: '120%', height: '120%' },
        s('feTurbulence', { type: 'fractalNoise', baseFrequency: '0.85', numOctaves: '2', seed: '3', result: 'n' }),
        s('feDisplacementMap', { in: 'SourceGraphic', in2: 'n', scale: '5', xChannelSelector: 'R', yChannelSelector: 'G' })
      )
    ),
    s('ellipse', { cx: 50, cy: 94, rx: 30, ry: 5, fill: '#000', opacity: 0.32, filter: `url(#${id}-blur)` }),
    s('circle', { cx: 50, cy: 54, r: 49, fill: `url(#${id}-glow)` }),
    // orelhas pontudas (atrás do corpo, num grupo que se move ao contrário do rosto = profundidade), com miolo, fio de luz e tufinhos
    s(
      'g',
      { class: 'mascot__back' },
      s('g', { class: 'mascot__ear' }, s('path', { d: 'M19 46C13 31 15 16 22 3C32 9 41 18 45 28Z', fill: `url(#${id}-ear)` }), s('path', { d: 'M24 40C21 29 22 19 25 11C31 16 37 22 40 29Z', fill: `url(#${id}-inner)` }), s('path', { d: 'M24 40C21 29 22 19 25 11C31 16 37 22 40 29Z', fill: '#4a1d8f', opacity: 0.22, transform: 'translate(2.4 3)' }), s('path', { d: 'M21 8C17 18 17 30 21 40', ...stroke, 'stroke-width': 1.5, stroke: '#e9dcff', opacity: 0.55 }), s('path', { d: 'M22 6l-1 6M26 9l-1 6', ...stroke, 'stroke-width': 1.6, stroke: '#f3e8ff' })),
      s('g', { class: 'mascot__ear mascot__ear--r' }, s('path', { d: 'M81 46C87 31 85 16 78 3C68 9 59 18 55 28Z', fill: `url(#${id}-ear)` }), s('path', { d: 'M76 40C79 29 78 19 75 11C69 16 63 22 60 29Z', fill: `url(#${id}-inner)` }), s('path', { d: 'M76 40C79 29 78 19 75 11C69 16 63 22 60 29Z', fill: '#4a1d8f', opacity: 0.3, transform: 'translate(-2 3)' }), s('path', { d: 'M82 12C85 22 84 32 80 40', ...stroke, 'stroke-width': 1.5, stroke: '#ffb6f0', opacity: 0.5 }), s('path', { d: 'M78 6l1 6M74 9l1 6', ...stroke, 'stroke-width': 1.6, stroke: '#f3e8ff' }))
    ),
    // pés (com brilho e sombra de contato)
    s('ellipse', { cx: 34, cy: 91, rx: 10, ry: 3.4, fill: '#14063a', opacity: 0.35 }),
    s('ellipse', { cx: 66, cy: 91, rx: 10, ry: 3.4, fill: '#14063a', opacity: 0.35 }),
    s('ellipse', { cx: 34, cy: 88.5, rx: 9.5, ry: 5.4, fill: `url(#${id}-foot)` }),
    s('ellipse', { cx: 66, cy: 88.5, rx: 9.5, ry: 5.4, fill: `url(#${id}-foot)` }),
    s('ellipse', { cx: 31, cy: 86.4, rx: 4, ry: 1.5, fill: '#fff', opacity: 0.4 }),
    s('ellipse', { cx: 63, cy: 86.4, rx: 4, ry: 1.5, fill: '#fff', opacity: 0.4 }),
    // pelagem: corpo maior e borrado atrás, depois o corpo liso
    s('circle', { cx: 50, cy: 53, r: 40, fill: '#7a4ce0', filter: `url(#${id}-fur)` }),
    s('circle', { cx: 50, cy: 53, r: 38, fill: `url(#${id}-body)` }),
    s('ellipse', { cx: 50, cy: 72, rx: 20, ry: 13, fill: `url(#${id}-belly)`, opacity: 0.7 }),
    // sombra de forma por cima (borda escura, miolo claro) e sombra de chão na parte de baixo: é o que dá o volume
    s('circle', { cx: 50, cy: 53, r: 38, fill: `url(#${id}-shade)` }),
    s('circle', { cx: 50, cy: 53, r: 38, fill: `url(#${id}-bounce)` }),
    // sombra das orelhas na cabeça
    s('g', { class: 'mascot__back' }, s('ellipse', { cx: 28, cy: 27, rx: 13, ry: 5, fill: '#1e0b52', opacity: 0.22, transform: 'rotate(-35 28 27)' }), s('ellipse', { cx: 72, cy: 27, rx: 13, ry: 5, fill: '#1e0b52', opacity: 0.22, transform: 'rotate(35 72 27)' })),
    // luz de contorno rosada à direita + reflexos (um macio e um brilho duro, de plástico)
    s('path', { d: 'M73 26C83 35 88 47 86 60C83 76 70 88 52 90C67 83 77 71 79 57C80 45 78 35 73 26Z', fill: `url(#${id}-rim)` }),
    s('ellipse', { cx: 33, cy: 31, rx: 13, ry: 7, fill: '#fff', opacity: 0.45, transform: 'rotate(-30 33 31)' }),
    s('ellipse', { cx: 29, cy: 27.5, rx: 5.5, ry: 2.4, fill: '#fff', opacity: 0.85, transform: 'rotate(-30 29 27.5)' }),
    s('circle', { cx: 22, cy: 45, r: 2.3, fill: '#fff', opacity: 0.6 }),
    // pelinhos no peito
    s('path', { d: 'M40 78l2-4.5l2 4.5M50 81l2-4.5l2 4.5M59 78l2-4.5l2 4.5', ...stroke, 'stroke-width': 1.3, stroke: '#efe3ff', opacity: 0.55 }),
    // tufinhos de pelo nas laterais
    s('path', { d: 'M13 60l-6 1l5 3l-5 3l6 1', fill: '#7a4ce0', stroke: '#6a3fd6', 'stroke-width': 1, 'stroke-linejoin': 'round' }),
    s('path', { d: 'M87 60l6 1l-5 3l5 3l-6 1', fill: '#7a4ce0', stroke: '#6a3fd6', 'stroke-width': 1, 'stroke-linejoin': 'round' }),
    s('g', { class: 'mascot__face' }, s('g', { class: 'mascot__wrap' }, ...face(mood, id))),
    mood === 'sleep' ? s('text', { x: 74, y: 30, 'font-size': 14, 'font-weight': 700, fill: '#e5d4ff' }, 'z') : null
  );
}

// ---------- o cantinho e o palco ----------
export function createMascot({ routeId, firstName, now = () => new Date(), delay = 650 }) {
  let minimized = false;
  try {
    minimized = localStorage.getItem(MIN_KEY) === 'min';
  } catch {
    /* sem armazenamento: só não lembra */
  }
  let stage = null;
  let hero = null;
  let log = null;
  let input = null;
  let busy = false;
  let closing = false;
  let timer = 0;

  const root = h('div', { class: 'mascot' });
  track(root);
  const hour = () => now().getHours();
  /** `.mascot__tilt` inclina o desenho conforme o olhar (variáveis --lx/--ly na raiz). */
  const art = (mood, size) => h('span', { class: 'mascot__tilt' }, mascotSvg(mood, size));

  function drawClosed() {
    root.classList.toggle('is-min', minimized);
    if (minimized) {
      replaceChildren(root, h('button', { class: 'mascot__peek', type: 'button', 'aria-label': `Mostrar ${MASCOT_NAME}`, title: `Mostrar ${MASCOT_NAME}`, onclick: () => setMinimized(false) }, art('happy', 30)));
      return;
    }
    replaceChildren(
      root,
      h('button', { class: 'mascot__btn', type: 'button', 'aria-haspopup': 'dialog', 'aria-label': `Conversar com o ${MASCOT_NAME}`, title: `Conversar com o ${MASCOT_NAME}`, onclick: openStage }, art(idleMood(hour()), 64))
    );
  }

  function setMinimized(v) {
    minimized = v;
    try {
      localStorage.setItem(MIN_KEY, v ? 'min' : 'open');
    } catch {
      /* sem armazenamento */
    }
    closeStage(false);
    if (!stage) drawClosed();
  }

  /** Troca a expressão do mascote grande; o desenho novo entra com um "pulinho". */
  function setMood(mood) {
    if (hero) replaceChildren(hero, h('span', { class: 'mascot__react' }, art(mood, 200)));
  }

  function addMessage(from, text, { remember = true } = {}) {
    if (remember) {
      history.push({ from, text });
      if (history.length > 60) history.shift();
    }
    const el = h('div', { class: `mascot__msg mascot__msg--${from}` }, text);
    log.append(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }

  function send(raw) {
    const text = String(raw || '').trim();
    if (!text || busy || !stage) return;
    addMessage('me', text);
    busy = true;
    setMood('think');
    const typing = addMessage('bot', '…', { remember: false });
    typing.classList.add('is-typing');
    const finish = () => {
      timer = 0;
      busy = false;
      typing.remove();
      const r = reply(text, { routeId, n: ++replies });
      addMessage('bot', r.text);
      setMood(r.mood);
    };
    if (delay <= 0) finish();
    else timer = setTimeout(finish, delay);
  }

  function tickle() {
    if (busy) return;
    addMessage('bot', 'Hihi, cócegas!');
    setMood('laugh');
  }

  function trap(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeStage();
      return;
    }
    if (e.key !== 'Tab') return;
    const items = [...stage.querySelectorAll('button, input')].filter((el) => !el.disabled);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function openStage() {
    const from = root.querySelector('.mascot__btn')?.getBoundingClientRect?.();
    const first = !history.length;
    if (first) {
      history.push({ from: 'bot', text: `${greeting(hour(), firstName)} Eu sou o ${MASCOT_NAME}.` });
      history.push({ from: 'bot', text: nextTip(routeId, 0).text });
    }
    hero = h('button', { class: 'mascot__hero', type: 'button', 'aria-label': `Fazer cócegas no ${MASCOT_NAME}`, onclick: tickle });
    log = h('div', { class: 'mascot__log', role: 'log', 'aria-live': 'polite' });
    input = h('input', { class: 'input mascot__input', type: 'text', maxlength: '300', autocomplete: 'off', placeholder: `Escreva para o ${MASCOT_NAME}…`, 'aria-label': 'Mensagem' });
    const form = h(
      'form',
      {
        class: 'mascot__form',
        onsubmit: (e) => {
          e.preventDefault();
          send(input.value);
          input.value = '';
        },
      },
      input,
      h('button', { class: 'btn btn--primary btn--sm', type: 'submit' }, 'Enviar')
    );
    const chat = h(
      'section',
      { class: 'mascot__chat', role: 'dialog', 'aria-modal': 'true', 'aria-label': `Conversa com o ${MASCOT_NAME}` },
      h(
        'header',
        { class: 'mascot__head' },
        h('strong', null, MASCOT_NAME),
        h('span', { class: 'mascot__sub' }, 'dicas e bate-papo'),
        h(
          'div',
          { class: 'mascot__head-actions' },
          h('button', { class: 'mascot__x mascot__min', type: 'button', 'aria-label': 'Minimizar', title: 'Minimizar', onclick: () => setMinimized(true) }, '–'),
          h('button', { class: 'mascot__x mascot__close', type: 'button', 'aria-label': 'Fechar', title: 'Fechar', onclick: () => closeStage() }, '×')
        )
      ),
      log,
      h('div', { class: 'mascot__chips' }, CHIPS.map((c) => h('button', { class: 'mascot__chip', type: 'button', onclick: () => send(c) }, c))),
      form
    );
    stage = h('div', { class: 'mascot-stage', onclick: (e) => e.target === stage && closeStage(), onkeydown: trap }, h('div', { class: 'mascot-stage__box' }, hero, chat));
    root.classList.remove('is-min');
    replaceChildren(root, stage);
    for (const m of history) addMessage(m.from, m.text, { remember: false });
    setMood(first ? nextTip(routeId, 0).mood : 'happy');
    // o bichinho "voa" do cantinho até o meio (pula se o navegador não anima ou se há movimento reduzido)
    const to = hero.getBoundingClientRect?.();
    if (from && to && to.width && hero.animate && !reduced()) {
      const dx = from.left + from.width / 2 - (to.left + to.width / 2);
      const dy = from.top + from.height / 2 - (to.top + to.height / 2);
      hero.animate([{ transform: `translate(${dx}px, ${dy}px) scale(${from.width / to.width})` }, { transform: 'none' }], { duration: 480, easing: 'cubic-bezier(.2,.9,.3,1.12)' });
    }
    input.focus?.();
  }

  /** Fecha o palco. Com `redraw`, o bichinho voa de volta ao cantinho (o inverso de abrir) antes de sumir. */
  function closeStage(redraw = true) {
    if (!stage || closing) return;
    clearTimeout(timer);
    timer = 0;
    busy = false;
    const finish = () => {
      closing = false;
      stage = hero = log = input = null;
      if (!redraw) return;
      drawClosed();
      root.querySelector('.mascot__btn')?.focus?.();
    };
    const from = hero?.getBoundingClientRect?.();
    const home = root.getBoundingClientRect?.();
    if (redraw && from && home && from.width && hero.animate && !reduced()) {
      closing = true;
      stage.classList.add('is-closing');
      // o botão do cantinho tem 64px e fica colado no canto de `root`
      const dx = home.right - 32 - (from.left + from.width / 2);
      const dy = home.bottom - 32 - (from.top + from.height / 2);
      let done = false;
      const end = () => {
        if (done) return;
        done = true;
        finish();
      };
      const anim = hero.animate([{ transform: 'none' }, { transform: `translate(${dx}px, ${dy}px) scale(${64 / from.width})` }], { duration: 420, easing: 'cubic-bezier(.5,0,.75,.4)', fill: 'forwards' });
      anim.onfinish = end;
      setTimeout(end, 560);
      return;
    }
    finish();
  }

  drawClosed();
  return root;
}
