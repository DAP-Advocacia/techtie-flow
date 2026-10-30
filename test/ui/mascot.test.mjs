// Mascote "Flow" (fase 1): respostas por palavra-chave, olhar, palco central com chat e CSS que respeita movimento reduzido.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { installDom, fire } from './dom-env.mjs';
import { greeting, idleMood, lookVector, nextTip, norm, reply, tipsFor, MASCOT_NAME } from '../../public/js/shell/mascot-model.js';

installDom();
const { createMascot, mascotSvg } = await import('../../public/js/shell/mascot.js');

test('saudação e humor mudam com a hora', () => {
  assert.equal(greeting(9, 'Ana'), 'Bom dia, Ana!');
  assert.equal(greeting(15), 'Boa tarde!');
  assert.equal(greeting(21, 'Ana'), 'Boa noite, Ana!');
  assert.equal(idleMood(3), 'sleep');
  assert.equal(idleMood(10), 'happy');
});

test('dicas: por tela, com rodízio e fallback', () => {
  assert.ok(tipsFor('pipeline').length >= 2);
  assert.equal(nextTip('pipeline', 2).text, tipsFor('pipeline')[0].text);
  assert.equal(nextTip('pipeline', -1).text, tipsFor('pipeline')[1].text);
  assert.ok(tipsFor('tela-inexistente')[0].text);
});

test('norm tira acento e caixa; lookVector limita a [-1, 1]', () => {
  assert.equal(norm('  Olá, ÁGUA '), '  ola, agua ');
  assert.deepEqual(lookVector(100, 100, 100, 100), { x: 0, y: 0 });
  assert.deepEqual(lookVector(100, 100, 5000, -5000), { x: 1, y: -1 });
  assert.ok(lookVector(100, 100, 230, 100).x > 0 && lookVector(100, 100, 230, 100).x < 1);
});

test('reações: cada tipo de conversa dá um humor diferente', () => {
  const mood = (t) => reply(t, { routeId: 'pipeline', n: 0 }).mood;
  assert.equal(mood('Oi!'), 'happy');
  assert.equal(mood('kkkkk'), 'laugh');
  assert.equal(mood('muito obrigado'), 'love');
  assert.equal(mood('não gostei'), 'sad');
  assert.equal(reply('me dá uma dica', { routeId: 'dashboard' }).mood, 'think');
  assert.equal(mood('asdfgh qwerty'), 'confused');
  assert.equal(reply('quem é você?').mood, 'happy');
  assert.match(reply('quem é você?').text, /Flow/);
  // piadas rodam; assunto citado puxa a dica da tela certa
  assert.notEqual(reply('conte uma piada', { n: 0 }).text, reply('conte uma piada', { n: 1 }).text);
  assert.equal(reply('como crio uma tarefa?', { routeId: 'home' }).text, tipsFor('tasks')[0].text);
  // não finge que sabe o que não sabe
  assert.match(reply('abra o negócio 123 do João', { routeId: 'home' }).text, /./);
  assert.equal(reply('xyzzy').mood, 'confused');
});

test('todo humor desenha um SVG com orelhas e ids próprios', () => {
  for (const mood of ['happy', 'think', 'wow', 'confused', 'sleep', 'love', 'laugh', 'sad']) {
    const svg = mascotSvg(mood, 40);
    assert.equal(svg.tagName.toLowerCase(), 'svg');
    assert.ok(svg.querySelector('.mascot__ear'), mood);
    assert.ok(svg.querySelector('.mascot__ear--r'), mood);
  }
  const a = mascotSvg('happy').querySelector('radialGradient').getAttribute('id');
  const b = mascotSvg('happy').querySelector('radialGradient').getAttribute('id');
  assert.notEqual(a, b);
});

const tick = () => new Promise((r) => setTimeout(r, 0));
const heroMood = (el) => el.querySelector('.mascot__hero svg').getAttribute('class');

test('clicar abre o palco com o chat; reage; fecha com Esc e devolve ao cantinho', async () => {
  localStorage.removeItem('ttf:mascot');
  const el = createMascot({ routeId: 'pipeline', firstName: 'Ana', now: () => new Date(2026, 9, 29, 9), delay: 0 });
  assert.ok(!el.querySelector('.mascot-stage'));
  fire(el.querySelector('.mascot__btn'), 'click');
  assert.ok(el.querySelector('.mascot-stage'));
  assert.ok(el.querySelector('.mascot__hero'));
  assert.equal(el.querySelector('[role="dialog"]').getAttribute('aria-modal'), 'true');
  assert.match(el.querySelector('.mascot__log').textContent, /Bom dia, Ana!/);

  const say = (text) => {
    el.querySelector('.mascot__input').value = text;
    fire(el.querySelector('.mascot__form'), 'submit');
  };
  say('kkkk');
  assert.ok(el.querySelector('.mascot__msg--me'));
  assert.match(heroMood(el), /mascot-art--laugh/);
  say('obrigado');
  assert.match(heroMood(el), /mascot-art--love/);
  say('asdfgh');
  assert.match(heroMood(el), /mascot-art--confused/);
  assert.equal(el.querySelector('.mascot__input').value, '');

  // chips mandam a mensagem pronta
  fire(el.querySelector('.mascot__chip'), 'click');
  assert.match(heroMood(el), /mascot-art--(think|wow)/); // humor da dica da tela

  fire(el.querySelector('.mascot-stage'), 'keydown', { key: 'Escape' });
  assert.ok(!el.querySelector('.mascot-stage'));
  assert.ok(el.querySelector('.mascot__btn'));

  // a conversa continua ao reabrir
  fire(el.querySelector('.mascot__btn'), 'click');
  assert.match(el.querySelector('.mascot__log').textContent, /asdfgh/);
});

test('mensagem em branco é ignorada e a resposta demora (digitando…) quando há atraso', async () => {
  const el = createMascot({ routeId: 'home', delay: 5 });
  fire(el.querySelector('.mascot__btn'), 'click');
  const before = el.querySelectorAll('.mascot__msg').length;
  el.querySelector('.mascot__input').value = '   ';
  fire(el.querySelector('.mascot__form'), 'submit');
  assert.equal(el.querySelectorAll('.mascot__msg').length, before);
  el.querySelector('.mascot__input').value = 'oi';
  fire(el.querySelector('.mascot__form'), 'submit');
  assert.ok(el.querySelector('.is-typing'));
  assert.match(heroMood(el), /mascot-art--think/);
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(!el.querySelector('.is-typing'));
  assert.match(heroMood(el), /mascot-art--happy/);
});

test('minimizar lembra a escolha; fechar o palco não perde o cantinho', () => {
  localStorage.removeItem('ttf:mascot');
  const el = createMascot({ routeId: 'home', delay: 0 });
  fire(el.querySelector('.mascot__btn'), 'click');
  fire(el.querySelector('.mascot__min'), 'click');
  assert.ok(el.querySelector('.mascot__peek'));
  assert.ok(!el.querySelector('.mascot-stage'));
  assert.equal(localStorage.getItem('ttf:mascot'), 'min');
  assert.ok(createMascot({ routeId: 'home' }).querySelector('.mascot__peek'));
  fire(el.querySelector('.mascot__peek'), 'click');
  assert.ok(el.querySelector('.mascot__btn'));
  localStorage.removeItem('ttf:mascot');
});

test('CSS: movimento reduzido, sem 100vh e largura do chat por --modal-w', () => {
  const css = fs.readFileSync(path.resolve(import.meta.dirname, '../../public/css/mascot.css'), 'utf8');
  const i = css.indexOf('@media (prefers-reduced-motion: reduce)');
  assert.ok(i !== -1);
  assert.match(css.slice(i), /\.mascot-art[\s\S]*animation: none/);
  assert.match(css.slice(i), /\.mascot__tilt[\s\S]*transform: none/);
  assert.ok(!/100vh/.test(css));
  assert.match(css, /width: var\(--modal-w\)/);
  assert.ok(!/\.mascot__chat \{[^}]*[^-]width: \d+px/.test(css));
});

test('fechar: o bichinho voa de volta ao cantinho e só então o palco some', async () => {
  const Proto = Object.getPrototypeOf(Object.getPrototypeOf(document.createElement('div')));
  // (o protótipo exato varia no linkedom; o que importa é que valha para os elementos criados)
  assert.ok(Proto);
  const saved = { animate: Proto.animate, rect: Proto.getBoundingClientRect };
  const calls = [];
  Proto.getBoundingClientRect = () => ({ left: 400, top: 200, width: 200, height: 200, right: 600, bottom: 400 });
  Proto.animate = function (frames, opts) {
    const anim = { onfinish: null };
    calls.push({ frames, opts });
    setTimeout(() => anim.onfinish?.(), 5);
    return anim;
  };
  try {
    const el = createMascot({ routeId: 'home', delay: 0 });
    fire(el.querySelector('.mascot__btn'), 'click');
    calls.length = 0;
    fire(el.querySelector('.mascot__close'), 'click');
    // ainda no palco, marcado como fechando, com o voo de volta (termina menor que o tamanho aberto)
    assert.ok(el.querySelector('.mascot-stage.is-closing'));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].frames[0].transform, 'none');
    assert.match(calls[0].frames[1].transform, /translate\(.*\) scale\(0\.32\)/);
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(!el.querySelector('.mascot-stage'));
    assert.ok(el.querySelector('.mascot__btn'));
  } finally {
    Proto.animate = saved.animate;
    Proto.getBoundingClientRect = saved.rect;
  }
});

test('CSS: orelhas acompanham a cabeça (deslocam e afinam o lado que vira)', () => {
  const css = fs.readFileSync(path.resolve(import.meta.dirname, '../../public/css/mascot.css'), 'utf8');
  // olhando para baixo as orelhas sobem, nunca descem para trás do corpo
  assert.match(css, /\.mascot__back \{[^}]*transform: translate\(calc\(var\(--lx\) \* 9px\), calc\(var\(--ly\) \* -5px\)\)/);
  assert.match(css, /\.mascot__ear \{\s*scale: calc\(1 \+ var\(--lx\)/);
  assert.match(css, /\.mascot__ear--r \{\s*scale: calc\(1 - var\(--lx\)/);
  assert.match(css, /\.mascot-stage\.is-closing/);
});
