// Regressão: o QR sumia da tela ~3 s depois de aparecer. O gateway fica em 'connecting' enquanto
// espera a leitura; a consulta de estado devolvia 'connecting' e apagava o QR no front.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createBaileysChannel } = require('../../src/channels/baileys.js');

const QR = 'data:image/png;base64,AAAA';
const ids = { id: '11111111-2222-4333-8444-555555555555', tenantId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' };
const make = (gateway) => {
  const channel = createBaileysChannel({ pool: null, config: { authFolder: path.join(os.tmpdir(), 'ttf-baileys-state-test') }, notify() {} });
  channel.manager.getActiveGateway = () => gateway;
  return channel;
};

test('conectando COM QR é "qr" para a tela (e devolve o QR)', () => {
  const s = make({ getStatus: () => 'connecting', getLastQr: () => QR }).state(ids);
  assert.deepEqual(s, { status: 'qr', qr: QR });
});

test('conectando SEM QR continua "connecting"; fila continua "queued"', () => {
  assert.equal(make({ getStatus: () => 'connecting', getLastQr: () => null }).state(ids).status, 'connecting');
  assert.equal(make({ getStatus: () => 'queued', getLastQr: () => null }).state(ids).status, 'queued');
});

test('conectado nunca devolve QR; sem sessão é "disconnected"', () => {
  assert.deepEqual(make({ getStatus: () => 'online', getLastQr: () => QR }).state(ids), { status: 'connected', qr: null });
  assert.deepEqual(make(undefined).state(ids), { status: 'disconnected', qr: null });
});
