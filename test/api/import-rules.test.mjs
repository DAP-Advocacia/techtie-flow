// Regras da importação (compartilhadas entre a prévia da tela e o servidor).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const R = await import('../../shared/import/rules.js');

test('telefone: só dígitos, 55 em número brasileiro com DDD, 00 sai, tamanho 8 a 15', () => {
  assert.deepEqual(R.normalizePhone('(11) 98888-7777'), { value: '5511988887777' });
  assert.deepEqual(R.normalizePhone('11 3333-4444'), { value: '551133334444' });
  assert.deepEqual(R.normalizePhone('+55 11 98888-7777'), { value: '5511988887777' });
  assert.deepEqual(R.normalizePhone('0055 11 98888-7777'), { value: '5511988887777' });
  assert.deepEqual(R.normalizePhone('+1 415 555 2671'), { value: '14155552671' });
  assert.deepEqual(R.normalizePhone('3333-4444'), { value: '33334444' }, '8 dígitos sem DDD: fica como veio');
  assert.deepEqual(R.normalizePhone(''), { value: null });
  assert.deepEqual(R.normalizePhone('  '), { value: null });
  assert.deepEqual(R.normalizePhone('123'), { error: 'Telefone inválido' });
  assert.deepEqual(R.normalizePhone('1'.repeat(16)), { error: 'Telefone inválido' });
});

test('e-mail, valor em reais e data', () => {
  assert.deepEqual(R.normalizeEmail(' ANA@Acme.com.br '), { value: 'ana@acme.com.br' });
  assert.deepEqual(R.normalizeEmail(''), { value: null });
  assert.deepEqual(R.normalizeEmail('sem-arroba'), { error: 'E-mail inválido' });
  assert.equal(R.parseMoney('R$ 1.500,50'), 1500.5);
  assert.equal(R.parseMoney('1500'), 1500);
  assert.equal(R.parseMoney('1.200'), 1200);
  assert.equal(R.parseMoney(''), null);
  assert.ok(Number.isNaN(R.parseMoney('abc')));
  assert.ok(Number.isNaN(R.parseMoney('1,234.50')), 'ambíguo é recusado');
  assert.equal(R.parseDate('25/10/2026'), '2026-10-25');
  assert.equal(R.parseDate('5-1-2027'), '2027-01-05');
  assert.equal(R.parseDate('2026-10-25'), '2026-10-25');
  assert.equal(R.parseDate('2026-10-25T10:00:00Z'), '2026-10-25');
  assert.equal(R.parseDate(''), null);
  assert.ok(Number.isNaN(R.parseDate('31/02/2026')));
  assert.ok(Number.isNaN(R.parseDate('ontem')));
});

test('contato: nome obrigatório e demais campos opcionais, mas válidos quando vêm', () => {
  assert.deepEqual(R.validateContact({ name: '  Ana   Paula ', company: ' Acme ', phone: '11 98888-7777', email: 'ANA@x.com', source: '' }), { ok: true, value: { name: 'Ana Paula', company: 'Acme', phone: '5511988887777', email: 'ana@x.com', source: 'import' } });
  assert.deepEqual(R.validateContact({ name: 'Só nome' }), { ok: true, value: { name: 'Só nome', company: null, phone: null, email: null, source: 'import' } });
  assert.equal(R.validateContact({ name: '   ', phone: '11 98888-7777' }).reason, 'Sem nome');
  assert.equal(R.validateContact({ name: 'A', phone: '12' }).reason, 'Telefone inválido');
  assert.equal(R.validateContact({ name: 'A', email: 'x' }).reason, 'E-mail inválido');
  assert.equal(R.validateContact({ name: 'x'.repeat(201) }).reason, 'Nome com mais de 200 caracteres');
});

test('plano de contatos: o que entra, o que sai e por quê (já existe, repetido no arquivo, inválido)', () => {
  const existing = { phones: new Set(['5511988887777']), emails: new Set(['velho@x.com']) };
  const rows = [
    { line: 2, name: 'Nova', phone: '21 97777-6666' },
    { line: 3, name: 'Telefone velho', phone: '(11) 98888-7777' },
    { line: 4, name: 'E-mail velho', email: 'VELHO@x.com' },
    { line: 5, name: 'Repete tel', phone: '+55 21 97777-6666' },
    { line: 6, name: 'Repete e-mail A', email: 'a@x.com' },
    { line: 7, name: 'Repete e-mail B', email: 'A@x.com' },
    { line: 8, name: '', phone: '11 91111-2222' },
    { line: 9, name: 'Tel ruim', phone: '12' },
    { line: 10, name: 'Sem contato nenhum' },
    { line: 11, name: 'Sem contato nenhum' },
  ];
  const p = R.planContacts(rows, existing);
  assert.deepEqual(p.create.map((c) => c.line), [2, 6, 10, 11], 'quem não tem telefone nem e-mail não tem como repetir');
  assert.deepEqual(p.skipped.map((s) => [s.line, s.reason]), [
    [3, 'Já existe um contato com este telefone'],
    [4, 'Já existe um contato com este e-mail'],
    [5, 'Telefone repetido no arquivo'],
    [7, 'E-mail repetido no arquivo'],
    [8, 'Sem nome'],
    [9, 'Telefone inválido'],
  ]);
  assert.deepEqual(R.planContacts([], {}), { create: [], skipped: [] });
});

const ctx = { stages: [{ id: 's1', name: 'Proposta', kind: 'open' }, { id: 's2', name: 'Negociação' }, { id: 's3', name: 'Fechamento', kind: 'won' }], users: [{ id: 'u1', name: 'Carla Souza', email: 'carla@x.com' }, { id: 'u2', name: 'Carla Souza', email: 'carla2@x.com' }, { id: 'u3', name: 'Pedro', email: 'pedro@x.com' }] };

test('negócio: etapa por nome (sem acento), padrão = 1ª em andamento, responsável por e-mail/nome, valor e data', () => {
  const ok = R.validateDeal({ title: ' Implantação ', value: 'R$ 18.400,00', stage: 'negociacao', expectedClose: '31/12/2026', owner: 'PEDRO', contactName: 'Ana', contactPhone: '11 98888-7777' }, ctx);
  assert.deepEqual(ok, { ok: true, value: { title: 'Implantação', value: 18400, expectedClose: '2026-12-31', stageId: 's2', ownerId: 'u3', contact: { name: 'Ana', phone: '5511988887777', email: null } } });
  const min = R.validateDeal({ title: 'X' }, ctx);
  assert.deepEqual(min.value, { title: 'X', value: null, expectedClose: null, stageId: 's1', ownerId: null, contact: null });
  assert.equal(R.validateDeal({ title: 'X', owner: 'carla@x.com' }, ctx).value.ownerId, 'u1');
  assert.equal(R.validateDeal({ title: '' }, ctx).reason, 'Sem título');
  assert.match(R.validateDeal({ title: 'X', stage: 'Inexistente' }, ctx).reason, /Etapa “Inexistente” não existe/);
  assert.match(R.validateDeal({ title: 'X', owner: 'Carla Souza' }, ctx).reason, /ambíguo/);
  assert.match(R.validateDeal({ title: 'X', owner: 'Zé' }, ctx).reason, /não encontrado/);
  assert.equal(R.validateDeal({ title: 'X', value: 'abc' }, ctx).reason, 'Valor inválido');
  assert.equal(R.validateDeal({ title: 'X', expectedClose: '32/13/2026' }, ctx).reason, 'Data de fechamento inválida');
  assert.match(R.validateDeal({ title: 'X', contactPhone: '1' }, ctx).reason, /Contato: telefone inválido/);
  assert.equal(R.validateDeal({ title: 'X' }, { stages: [], users: [] }).reason, 'O funil não tem etapas');
});

test('mapeamento: chuta a coluna certa por cabeçalho (igual primeiro, parecido depois) sem repetir coluna', () => {
  const h = ['Nome completo', 'Empresa', 'Celular', 'E-mail', 'Observações'];
  assert.deepEqual(R.guessMapping(h, R.CONTACT_FIELDS), { name: 0, company: 1, phone: 2, email: 3 });
  const d = ['Título', 'Cliente', 'Telefone', 'Email', 'Valor total', 'Fase', 'Data de fechamento', 'Vendedor'];
  assert.deepEqual(R.guessMapping(d, R.DEAL_FIELDS), { title: 0, contactName: 1, contactPhone: 2, contactEmail: 3, value: 4, stage: 5, expectedClose: 6, owner: 7 });
  assert.deepEqual(R.guessMapping(['a', 'b'], R.CONTACT_FIELDS), {});
  assert.deepEqual(R.rowToRaw(['Ana', 'Acme', '119'], { name: 0, phone: 2, email: undefined }), { name: 'Ana', phone: '119', email: '' });
});
