// Perfil: normalizar, validar e descobrir o que mudou (modelo puro).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { normalizeProfile, validateProfile, changedFields, LIMITS } = await import('../../public/js/screens/profile/model.js');

test('normalizar: espaços sobrando saem, "sobre" mantém quebras de linha', () => {
  assert.deepEqual(normalizeProfile({ name: '  Ana   Paula ', jobTitle: ' SDR\t senior ', phone: ' +55 11 9 ', bio: ' linha 1\r\nlinha 2 ' }), { name: 'Ana Paula', jobTitle: 'SDR senior', phone: '+55 11 9', bio: 'linha 1\nlinha 2' });
  assert.deepEqual(normalizeProfile({}), { name: '', jobTitle: '', phone: '', bio: '' });
});

test('validar: nome obrigatório e limites; telefone só com números e símbolos; campos vazios são aceitos', () => {
  assert.deepEqual(validateProfile({ name: 'Ana', jobTitle: '', phone: '', bio: '' }), {});
  assert.match(validateProfile({ name: '   ' }).name, /Informe o seu nome/);
  assert.match(validateProfile({ name: 'x'.repeat(LIMITS.name + 1) }).name, /200/);
  assert.match(validateProfile({ name: 'A', jobTitle: 'x'.repeat(81) }).jobTitle, /80/);
  assert.match(validateProfile({ name: 'A', phone: 'abc' }).phone, /inválido/);
  assert.match(validateProfile({ name: 'A', phone: '123' }).phone, /inválido/, 'curto demais');
  assert.deepEqual(validateProfile({ name: 'A', phone: '+55 (11) 98888-7777' }), {});
  assert.match(validateProfile({ name: 'A', bio: 'x'.repeat(301) }).bio, /300/);
});

test('o que mudou: só os campos diferentes do salvo (ignora espaços e vazios iguais)', () => {
  const saved = { name: 'Ana Souza', jobTitle: 'SDR', phone: '', bio: undefined };
  assert.deepEqual(changedFields(saved, { name: ' Ana  Souza ', jobTitle: 'SDR', phone: '', bio: '' }), {});
  assert.deepEqual(changedFields(saved, { name: 'Ana Souza', jobTitle: 'Gerente', phone: '+55 11 99999-0000', bio: '' }), { jobTitle: 'Gerente', phone: '+55 11 99999-0000' });
  assert.deepEqual(changedFields(null, { name: 'X' }), { name: 'X' });
});
