// Modais, gavetas e a busca: todos abrem com animação, medem a área VISÍVEL (teclado/barras do celular) e deixam os botões
// à vista. Teste estático dos CSS (evita voltar a `100vh` e modal sem animação) + o acompanhamento da área visível.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { installDom, fire } from './dom-env.mjs';

installDom();
const root = path.resolve(import.meta.dirname, '../../public');
const css = (f) => fs.readFileSync(path.join(root, 'css', f), 'utf8');
/** Corpo da primeira regra cujo seletor é exatamente `selector` (fora de @media). */
const rule = (src, selector) => {
  const i = src.indexOf(`\n${selector} {`);
  assert.ok(i !== -1, `regra ${selector} não encontrada`);
  return src.slice(i, src.indexOf('\n}', i));
};

const OVERLAYS = [
  ['screens/contacts.css', '.contacts-overlay', '.contacts-dialog'],
  ['screens/pipeline.css', '.pipeline-overlay', '.pipeline-modal'],
  ['screens/permissions.css', '.perm-overlay', '.perm-dialog'],
  ['screens/instances.css', '.instances-overlay', '.instances-modal'],
  ['screens/tasks.css', '.tasks-overlay', '.tasks-panel'],
  ['shell.css', '.palette-overlay', '.palette'],
];

for (const [file, overlay, box] of OVERLAYS) {
  test(`${overlay}: mede a área visível, abre com animação e a caixa também`, () => {
    const src = css(file);
    const o = rule(src, overlay);
    assert.match(o, /height: var\(--vvh, 100dvh\)/, 'altura = área visível');
    assert.match(o, /top: var\(--vvt, 0px\)/, 'topo = topo da área visível');
    assert.doesNotMatch(o, /inset: 0/, 'sem inset:0 (que ignora o teclado)');
    assert.match(o, /animation: [^;]*ov-fade|animation: instances-fade/, 'o fundo aparece com fade');
    const b = rule(src, box);
    assert.match(b, /animation: ov-(pop|drawer)/, 'a caixa entra com animação');
  });
}

test('nenhum modal ou menu mede a altura por 100vh (que passa do que o celular mostra)', () => {
  for (const [file] of OVERLAYS) {
    const src = css(file);
    assert.doesNotMatch(src, /max-height: calc\(100vh - (24|32|48)px\)/, `${file}: modal ou popover com max-height em 100vh`);
  }
  assert.doesNotMatch(css('screens/pipeline.css'), /max-height: 92vh/);
});

test('animações compartilhadas existem e respeitam "reduzir movimento"', () => {
  const base = css('base.css');
  for (const k of ['ov-fade', 'ov-pop', 'ov-sheet', 'ov-drawer']) assert.match(base, new RegExp(`@keyframes ${k}`));
  assert.match(base, /prefers-reduced-motion: reduce\) \{\s*\[class\*='-overlay'\]/);
  assert.match(base, /--vvh: 100dvh/);
});

test('celular: modais viram folha de baixo com animação própria; botões de ação ficam fixos ao rolar', () => {
  assert.match(css('screens/contacts.css'), /\.contacts-dialog \{[^}]*animation-name: ov-sheet/s);
  assert.match(css('screens/pipeline.css'), /\.pipeline-modal \{[^}]*animation-name: ov-sheet/s);
  assert.match(css('screens/tasks.css'), /\.tasks-panel \{[^}]*animation-name: ov-sheet/s);
  assert.match(rule(css('screens/contacts.css'), '.contacts-form__actions'), /position: sticky/);
  assert.match(rule(css('screens/pipeline.css'), '.pipeline-modal__actions'), /position: sticky/);
  assert.match(rule(css('screens/tasks.css'), '.tasks-panel__foot'), /safe-area-inset-bottom/);
});

test('o HTML pede que o teclado redimensione a página (Chrome do celular)', () => {
  assert.match(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), /interactive-widget=resizes-content/);
});

test('viewport: --vvh/--vvt acompanham a área visível (teclado aberto encolhe) e o campo em foco é trazido à vista', async () => {
  const { trackViewport, syncViewport } = await import('../../public/js/viewport.js');
  const style = document.documentElement.style;
  // sem visualViewport: usa a altura da janela
  window.innerHeight = 700;
  syncViewport();
  assert.equal(style.getPropertyValue('--vvh'), '700px');
  assert.equal(style.getPropertyValue('--vvt'), '0px');
  // medida inválida não estraga o que já está valendo
  window.innerHeight = 0;
  syncViewport();
  assert.equal(style.getPropertyValue('--vvh'), '700px');
  // com visualViewport: o teclado abre (altura cai, topo desloca) e a variável acompanha
  const handlers = {};
  window.visualViewport = { height: 640, offsetTop: 0, addEventListener: (ev, fn) => (handlers[ev] ||= []).push(fn) };
  trackViewport();
  assert.equal(style.getPropertyValue('--vvh'), '640px');
  window.visualViewport.height = 310.4;
  window.visualViewport.offsetTop = 24.6;
  for (const fn of handlers.resize || []) fn();
  assert.equal(style.getPropertyValue('--vvh'), '310px');
  assert.equal(style.getPropertyValue('--vvt'), '25px');
  // campo em foco dentro de um modal volta para o meio da área visível
  const dlg = document.createElement('div');
  dlg.setAttribute('role', 'dialog');
  const input = document.createElement('input');
  let scrolled = null;
  input.scrollIntoView = (o) => (scrolled = o);
  dlg.append(input);
  document.body.append(dlg);
  fire(input, 'focusin');
  await new Promise((r) => setTimeout(r, 360));
  assert.deepEqual(scrolled, { block: 'center', behavior: 'smooth' });
  // campo fora de modal: não mexe
  const loose = document.createElement('input');
  let touched = false;
  loose.scrollIntoView = () => (touched = true);
  document.body.append(loose);
  fire(loose, 'focusin');
  await new Promise((r) => setTimeout(r, 360));
  assert.equal(touched, false);
});

test('modal de Negócios: a largura NÃO é inline (no celular a folha de baixo ocupa 100%, antes ficava com vão à direita)', async () => {
  const { openModal } = await import('../../public/js/screens/pipeline/modal.js');
  const m = openModal({ title: 'Teste', content: 'x', width: 520 });
  const dialog = document.querySelector('.pipeline-modal');
  assert.ok(!/(^|;)\s*width\s*:/.test(dialog.getAttribute('style') || ''), 'sem width inline');
  assert.match(dialog.getAttribute('style'), /--modal-w:\s*520px/);
  m.close();
  const src = css('screens/pipeline.css');
  assert.match(rule(src, '.pipeline-modal'), /width: min\(var\(--modal-w, 480px\)/);
  assert.match(src, /@media \(max-width: 820px\) \{[\s\S]*?\.pipeline-modal \{[^}]*width: 100%/);
});
