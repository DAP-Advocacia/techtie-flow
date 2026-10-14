import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { silenceSignalNoise } = createRequire(import.meta.url)('../../src/logging.js');

test('descarta o dump de sessão do libsignal (tem chaves privadas) e deixa o resto passar', () => {
  const seen = [];
  const fake = { info: (...a) => seen.push(['info', ...a]), log: (...a) => seen.push(['log', ...a]), warn: (...a) => seen.push(['warn', ...a]) };
  const restore = silenceSignalNoise(fake);
  fake.info('Closing session:', { privKey: 'SEGREDO' });
  fake.info('Opening session:', { rootKey: 'SEGREDO' });
  fake.warn('Removing old closed session:', { x: 1 });
  fake.log('[whatsapp] conectado com sucesso');
  fake.warn('aviso qualquer', 1);
  fake.info({ objeto: true }); // primeiro argumento não-texto: passa
  assert.deepEqual(seen, [['log', '[whatsapp] conectado com sucesso'], ['warn', 'aviso qualquer', 1], ['info', { objeto: true }]]);
  assert.equal(JSON.stringify(seen).includes('SEGREDO'), false);
  restore();
  fake.info('Closing session:', 1);
  assert.equal(seen.length, 4, 'depois de restaurar, volta ao normal');
});
