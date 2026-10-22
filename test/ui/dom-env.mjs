// DOM simulado (linkedom) para rodar as TELAS do front em Node, sem navegador. Não mede layout nem pixels:
// serve para pegar o que quebra ao executar (variável errada, evento sem tratamento, permissão que some do DOM).
import { parseHTML } from 'linkedom';
import { register } from 'node:module';

register(new URL('../permissions/shared-loader.mjs', import.meta.url));

export function installDom() {
  const { window, document } = parseHTML('<!doctype html><html><head></head><body><div id="app"></div></body></html>');
  const store = new Map();
  const g = globalThis;
  g.window = window;
  g.document = document;
  g.Node = window.Node;
  g.Event = window.Event;
  g.CustomEvent = window.CustomEvent;
  g.HTMLElement = window.HTMLElement;
  Object.defineProperty(g, 'navigator', { value: { userAgent: 'node-test', platform: 'test', maxTouchPoints: 0, standalone: false }, configurable: true, writable: true });
  g.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => void store.set(k, String(v)), removeItem: (k) => void store.delete(k) };
  window.localStorage = g.localStorage;
  g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.matchMedia = g.matchMedia;
  g.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  g.cancelAnimationFrame = (id) => clearTimeout(id);
  g.CSS = { escape: (s) => String(s).replace(/[^\w-]/g, '\\$&') };
  g.location = { hash: '#/home', protocol: 'http:', hostname: 'localhost' };
  window.location = g.location;
  g.__TTF__ = { live: false };
  window.__TTF__ = g.__TTF__;
  // APIs de observação que o navegador tem e o linkedom não: sem layout, nunca disparam (só não podem faltar)
  class NoopObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  g.ResizeObserver = NoopObserver;
  g.IntersectionObserver = NoopObserver;
  g.MutationObserver = g.MutationObserver || NoopObserver;
  g.getComputedStyle = () => ({ getPropertyValue: () => '' });
  // linkedom: <select>.value só lê. No navegador também escreve (marca a <option> certa): reproduzimos isso.
  const optValue = (o) => (o.hasAttribute('value') ? o.getAttribute('value') : o.textContent);
  Object.defineProperty(window.HTMLSelectElement.prototype, 'value', {
    configurable: true,
    get() {
      const opts = [...this.querySelectorAll('option')];
      const picked = opts.find((o) => o.hasAttribute('selected')) || opts[0];
      return picked ? optValue(picked) : '';
    },
    set(v) {
      for (const o of this.querySelectorAll('option')) {
        if (optValue(o) === String(v)) o.setAttribute('selected', '');
        else o.removeAttribute('selected');
      }
    },
  });
  Object.defineProperty(window.HTMLSelectElement.prototype, 'selectedOptions', {
    configurable: true,
    get() {
      const opts = [...this.querySelectorAll('option')];
      const picked = opts.filter((o) => o.hasAttribute('selected'));
      return picked.length ? picked : opts.slice(0, 1);
    },
  });
  return { window, document };
}

/** Evento com campos extras (key, dataTransfer…) — linkedom não traz KeyboardEvent/DragEvent completos. */
export function fire(el, type, extra = {}) {
  const ev = new globalThis.Event(type, { bubbles: true, cancelable: true });
  Object.assign(ev, extra);
  el.dispatchEvent(ev);
  return ev;
}

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
export const $ = (root, sel) => root.querySelector(sel);
export const $$ = (root, sel) => [...root.querySelectorAll(sel)];
export const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();

/** Espera (até `timeout` ms) a condição ficar verdadeira — telas montam de forma assíncrona e a máquina pode estar carregada. */
export async function waitFor(fn, timeout = 4000, step = 10) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try {
      v = fn();
    } catch {
      v = null;
    }
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`waitFor: a condição não ficou verdadeira em ${timeout} ms: ${fn}`);
    await tick(step);
  }
}
