// Helpers de UI compartilhados. Sem innerHTML: strings viram nós de texto,
// então dado de usuário nunca vira HTML (XSS-safe por construção).

/**
 * h('div', { class: 'card', onclick: fn, style: {gap:'8px'}, dataset:{id:1} }, 'texto', filho, [filhos])
 * - `class` aceita string; `style` aceita string ou objeto; `on*` registra listener.
 * - atributos booleanos: true liga, false/null/undefined omite.
 * - filhos falsy (null/undefined/false) são ignorados; arrays são achatados.
 */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs && typeof attrs === 'object' && !(attrs instanceof Node) && !Array.isArray(attrs)) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') {
        if (typeof v === 'string') el.style.cssText = v;
        else Object.assign(el.style, v);
      } else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') el.value = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
  } else if (attrs != null) {
    children.unshift(attrs);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** Esvazia `el` e põe `children` no lugar (útil em re-render). */
export function replaceChildren(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Ícone de traço simples (24px viewBox, stroke 1.7) a partir de um path `d`. */
export function icon(d, size = 18) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', d);
  svg.append(p);
  return svg;
}

/** Paths de ícone usados em mais de um lugar. Telas podem ter os seus próprios. */
export const ICONS = {
  inbox: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  pipeline: 'M3 3h6v18H3zM15 3h6v10h-6z',
  agent: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z',
  automations: 'M13 2L4 14h7l-1 8 9-12h-7z',
  dashboard: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  instances: 'M7 2h10a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zM11 18h2',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12h3M2 12h3M12 2v3M12 19v3',
  permissions: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM9 12l2 2 4-4',
  users: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
};

/** 'Marina Alves' -> 'MA' */
export function initials(name) {
  const parts = String(name || '?')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const first = parts[0]?.[0] || '?';
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase();
}

export function avatar(name, { small = false } = {}) {
  return h('div', { class: small ? 'avatar avatar--sm' : 'avatar', title: name }, initials(name));
}

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
const BRL_CENTS = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
/** 18400 -> 'R$ 18.400' */
export const fmtBRL = (n) => BRL.format(n || 0).replace(/ /g, ' ');
/** 18400.5 -> 'R$ 18.400,50' */
export const fmtBRLCents = (n) => BRL_CENTS.format(n || 0).replace(/ /g, ' ');
export const fmtInt = (n) => new Intl.NumberFormat('pt-BR').format(n || 0);

/** Date|number -> '10:42' */
export function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

/** Rótulo curto para lista de conversas: hora se for hoje, 'Ontem', ou dd/mm. */
export function fmtListTime(ts, now = Date.now()) {
  const d = new Date(ts);
  const n = new Date(now);
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(n) - startOf(d)) / 86400000);
  if (diffDays <= 0) return fmtTime(ts);
  if (diffDays === 1) return 'Ontem';
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

/** 'há 4h', 'há 2d' — idade curta de um card. */
export function timeAgo(ts, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return 'agora';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}min`;
  const hr = Math.floor(m / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

let toastHost;
/** Aviso passageiro no canto da tela. */
export function toast(message, ms = 2600) {
  if (!toastHost) {
    toastHost = h('div', { class: 'toast-host', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  const t = h('div', { class: 'toast' }, message);
  toastHost.append(t);
  setTimeout(() => t.remove(), ms);
}

/** Toggle acessível. onChange(novoValor). Devolve o <button>. */
export function toggle(checked, onChange, label = '') {
  const b = h('button', { class: 'toggle', type: 'button', role: 'switch', 'aria-checked': String(!!checked), 'aria-label': label });
  b.addEventListener('click', () => {
    const next = b.getAttribute('aria-checked') !== 'true';
    b.setAttribute('aria-checked', String(next));
    onChange?.(next);
  });
  return b;
}
