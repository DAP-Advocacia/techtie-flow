// Regressão: sessão pareada por QR tem `creds.me` mas `registered:false` (Baileys 7). A regra
// antiga a descartava a cada reinício ("nunca pareada"), derrubando o número já conectado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { isPairedCreds } = createRequire(import.meta.url)('../../src/sessions.js');

test('pareada por QR: tem a conta (me) mesmo com registered:false', () => {
  assert.equal(isPairedCreds({ registered: false, me: { id: '5511999990000:12@s.whatsapp.net' }, account: {} }), true);
});

test('registered:true também vale', () => assert.equal(isPairedCreds({ registered: true }), true));

test('QR gerado e nunca lido (sem me) NÃO é sessão pareada', () => {
  assert.equal(isPairedCreds({ registered: false, noiseKey: {}, signedIdentityKey: {} }), false);
  assert.equal(isPairedCreds({ me: {} }), false);
  assert.equal(isPairedCreds({ me: { id: '' } }), false);
  assert.equal(isPairedCreds(null), false);
  assert.equal(isPairedCreds(undefined), false);
});
