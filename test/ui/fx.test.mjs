// Brilhos e cliques: ondinha nos botões, chuva de brilhos nas conquistas, respeito a "reduzir movimento".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { installDom, fire, $$ } from './dom-env.mjs';

installDom();
const fx = await import('../../public/js/fx.js');
const { store } = await import('../../public/js/store.js');
const PA = await import('../../public/js/screens/pipeline/actions.js');
const TA = await import('../../public/js/screens/tasks/actions.js');
const css = fs.readFileSync(path.resolve(import.meta.dirname, '../../public/css/base.css'), 'utf8');

const sparks = () => $$(document, '.fx-spark').length;
const clear = () => document.querySelectorAll('.fx-burst').forEach((b) => b.remove());

test('clique em botão cria a ondinha no ponto do clique; botão desabilitado não', () => {
  fx.initFx();
  const b = document.createElement('button');
  b.className = 'btn btn--primary';
  document.body.append(b);
  fire(b, 'pointerdown', { clientX: 30, clientY: 12 });
  assert.equal(b.querySelectorAll('.fx-ripple').length, 1);
  const off = document.createElement('button');
  off.className = 'btn';
  off.disabled = true;
  document.body.append(off);
  fire(off, 'pointerdown', { clientX: 1, clientY: 1 });
  assert.equal(off.querySelectorAll('.fx-ripple').length, 0);
  const plain = document.createElement('div');
  document.body.append(plain);
  fire(plain, 'pointerdown', { clientX: 1, clientY: 1 });
  assert.equal(plain.children.length, 0, 'fora dos elementos de clique nada acontece');
});

test('burst cria os brilhos no último clique e limpa depois; burstOnce só dispara uma vez por chave', async () => {
  clear();
  const el = document.createElement('button');
  el.className = 'btn';
  document.body.append(el);
  fire(el, 'pointerdown', { clientX: 200, clientY: 80 });
  const box = fx.burst({ n: 8 });
  assert.equal(sparks(), 8);
  assert.match(box.style.cssText, /left:200px/);
  assert.match(box.style.cssText, /top:80px/);
  assert.ok(fx.burstOnce('k1'));
  assert.equal(fx.burstOnce('k1'), null);
  await new Promise((r) => setTimeout(r, 1300));
  assert.equal(sparks(), 0, 'os brilhos saem do DOM');
});

test('reduzir movimento: nada de ondinha nem brilhos', () => {
  clear();
  const old = globalThis.matchMedia;
  globalThis.matchMedia = () => ({ matches: true });
  const b = document.createElement('button');
  b.className = 'btn';
  document.body.append(b);
  assert.equal(fx.ripple(b, 1, 1), null);
  assert.equal(fx.burst(), null);
  globalThis.matchMedia = old;
});

test('conquistas disparam o brilho: negócio ganho e tarefa feita (e não o contrário)', async () => {
  clear();
  store.state.currentUserId = 'u_marina';
  assert.equal(PA.moveDeal('d3', 's_negoc').ok, true);
  assert.equal(sparks(), 0, 'mover para etapa aberta não comemora');
  assert.equal(PA.moveDeal('d3', 's_fechamento').ok, true);
  assert.ok(sparks() > 0, 'ganho comemora');
  clear();
  const t = await TA.createTask({ title: 'Teste de brilho' });
  assert.ok(t.ok, JSON.stringify(t));
  const id = t.task.id;
  TA.setStatus(id, 'doing');
  assert.equal(sparks(), 0);
  TA.setStatus(id, 'done');
  assert.ok(sparks() > 0, 'tarefa feita comemora');
  clear();
  TA.setStatus(id, 'done');
  assert.equal(sparks(), 0, 'já estava feita: não repete');
});

test('CSS: pressionar, brilho do botão principal, IA piscando e movimento reduzido', () => {
  for (const k of ['@keyframes fx-ripple', '@keyframes fx-spark', '@keyframes twinkle', '.btn--primary::after', ".nav-item[href='#/agent'] svg", '.inbox-msg--ai::after']) assert.ok(css.includes(k), k);
  assert.match(css, /\.btn:active:not\(:disabled\)[^}]*\{\s*transform: scale\(0\.97\)/s);
  assert.match(css, /prefers-reduced-motion: reduce\) \{\s*\.fx-ripple/);
});

test('rodada 2: aviso sai suave, botão ocupado, estrelinhas do login, esqueleto e entrada de tela no CSS', async () => {
  const { toast } = await import('../../public/js/ui.js');
  toast('Teste de saída', 20);
  const t = [...document.querySelectorAll('.toast')].find((x) => x.textContent === 'Teste de saída');
  assert.ok(t);
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(t.classList.contains('is-leaving'), 'primeiro sai deslizando');
  await new Promise((r) => setTimeout(r, 260));
  assert.equal(t.isConnected, false, 'depois some do DOM');
  const b = document.createElement('button');
  fx.busy(b, true);
  assert.equal(b.getAttribute('aria-busy'), 'true');
  fx.busy(b, false);
  assert.equal(b.hasAttribute('aria-busy'), false);
  const sp = fx.sparkles(9);
  assert.equal(sp.children.length, 9);
  assert.equal(sp.getAttribute('aria-hidden'), 'true');
  assert.ok([...sp.children].every((s) => /left:\d+%;top:\d+%/.test(s.style.cssText)));
  for (const k of ['.fx-in > *', '@keyframes fx-bar', ".btn[aria-busy='true']::before", '.skeleton::after', '.toast.is-leaving', '.fx-sparkles span']) assert.ok(css.includes(k), k);
  assert.match(css, /prefers-reduced-motion: reduce\) \{\s*\.fx-in \*/);
});
