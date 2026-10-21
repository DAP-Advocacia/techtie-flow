// Busca global: modelo puro (pontuação, agrupamento, telefone, recentes).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { fold, scoreEntry, searchEntries, buildEntries, commandEntries, makeRecents, GROUPS } = await import('../../public/js/search/model.js');

const entry = (type, id, title, extra = {}) => ({ type, id, title, subtitle: '', fields: [title], ...extra });

test('fold: sem acento e minúscula', () => {
  assert.equal(fold('  Ação ÚNICA  '), '  acao unica  ');
  assert.equal(fold(null), '');
});

test('pontuação: igual > começa > começo de palavra > contém; título pesa mais; todas as palavras precisam casar', () => {
  const e = (title, other = '') => ({ fields: [title, other] });
  const s = (title, q, other) => scoreEntry(e(title, other), q.split(' ').map(fold));
  assert.ok(s('Carla', 'carla') > s('Carla Souza', 'carla'), 'igual vence começa');
  assert.ok(s('Carla Souza', 'carla') > s('Maria Carla', 'carla'), 'começa vence começo de palavra');
  assert.ok(s('Maria Carla', 'carla') > s('Escarlata', 'carla') || s('Escarlata', 'carla') === 0, 'palavra vence "contém"');
  assert.ok(s('Souza Ltda', 'souza', '') > s('Ltda', 'souza', 'Contato: Souza'), 'o título pesa mais que os outros campos');
  assert.equal(s('Carla Souza', 'carla pereira'), 0, 'todas as palavras precisam casar');
  assert.ok(s('Carla Souza', 'souza carla') > 0, 'ordem das palavras não importa');
  assert.ok(s('João Ação', 'acao') > 0, 'sem acento casa com acento');
});

test('telefone: 3+ dígitos casam o número com qualquer formatação', () => {
  const entries = [entry('contact', 'a', 'Ana', { digits: '5511999990001' }), entry('contact', 'b', 'Beto', { digits: '5521988880002' })];
  const ids = (q) => searchEntries(entries, q).flatMap((g) => g.items.map((i) => i.id));
  assert.deepEqual(ids('99999'), ['a']);
  assert.deepEqual(ids('(21) 98888'), ['b'], 'formatação não atrapalha');
  assert.deepEqual(ids('12'), [], 'menos de 3 dígitos não casa por telefone');
});

test('agrupamento: ordem fixa dos grupos, limite por grupo, grupo vazio some, busca vazia = nada', () => {
  const entries = [
    ...Array.from({ length: 8 }, (_, i) => entry('contact', `c${i}`, `Carlos ${i}`)),
    entry('deal', 'd1', 'Proposta Carlos'),
    entry('task', 't1', 'Ligar Carlos'),
    entry('conversation', 'v1', 'Carlos', { fields: ['Carlos'] }),
    entry('command', 'go:home', 'Início', { fields: ['Início', 'carlos'] }),
  ];
  const groups = searchEntries(entries, 'carlos', { limit: 5 });
  assert.deepEqual(groups.map((g) => g.type), ['command', 'deal', 'contact', 'conversation', 'task']);
  assert.equal(groups.find((g) => g.type === 'contact').items.length, 5);
  assert.deepEqual(searchEntries(entries, 'zzzz'), []);
  assert.deepEqual(searchEntries(entries, '   '), []);
  assert.deepEqual(GROUPS.map((g) => g.type), ['command', 'deal', 'contact', 'conversation', 'task']);
});

test('entradas: contato, negócio (com contato, etapa e valor), conversa e tarefa a partir dos dados', () => {
  const contacts = [{ id: 'c1', name: 'Carla Souza', company: 'Souza Ltda', phone: '+55 11 95555-0001', email: 'carla@souza.com' }];
  const entries = buildEntries({
    contacts,
    deals: [{ id: 'd1', title: 'Implantação ERP', contactId: 'c1', stageId: 's2' }],
    conversations: [{ id: 'v1', contactId: 'c1', lastMessage: 'Podemos fechar amanhã?', phone: '5511955550001' }],
    tasks: [{ id: 't1', title: 'Enviar contrato', ownerId: 'u1', status: 'todo', description: 'revisar cláusulas' }],
    stageName: () => 'Negociação',
    contactById: (id) => contacts.find((c) => c.id === id),
    userName: () => 'Marina',
    moneyOf: () => 'R$ 18.000',
  });
  const by = (type) => entries.find((e) => e.type === type);
  assert.equal(by('contact').subtitle, 'Souza Ltda · +55 11 95555-0001');
  assert.equal(by('deal').subtitle, 'Carla Souza · Negociação · R$ 18.000');
  assert.equal(by('conversation').title, 'Carla Souza');
  assert.equal(by('task').subtitle, 'Marina');
  // achar por empresa, e-mail, texto da última mensagem, descrição da tarefa
  const found = (q) => searchEntries(entries, q).flatMap((g) => g.items.map((i) => i.type));
  assert.ok(found('souza ltda').includes('contact'));
  assert.ok(found('carla@souza').includes('contact'));
  assert.ok(found('fechar amanha').includes('conversation'));
  assert.ok(found('clausulas').includes('task'));
  assert.ok(found('erp').includes('deal') && found('carla erp').includes('deal'), 'negócio acha pelo nome do contato');
  // valor oculto pelo perfil não aparece no subtítulo
  const hidden = buildEntries({ contacts, deals: [{ id: 'd1', title: 'X', contactId: 'c1', stageId: 's' }], contactById: (id) => contacts.find((c) => c.id === id), stageName: () => 'Etapa', moneyOf: () => '' });
  assert.equal(hidden[1].subtitle, 'Carla Souza · Etapa');
});

test('comandos: telas e ações viram entradas pesquisáveis por palavra-chave', () => {
  const entries = commandEntries([{ id: 'tasks', label: 'Tarefas', keywords: 'pendencias lembretes' }], [{ id: 'new:task', label: 'Novo: Tarefa', keywords: 'nova tarefa lembrete' }]);
  assert.deepEqual(searchEntries(entries, 'pendencias').flatMap((g) => g.items.map((i) => i.command)), [{ go: 'tasks' }]);
  assert.deepEqual(searchEntries(entries, 'lembrete').flatMap((g) => g.items.map((i) => i.command)).length, 2);
});

test('recentes: mais novo primeiro, sem repetir, limite e armazenamento quebrado não derruba', () => {
  const mem = new Map();
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v) };
  const r = makeRecents(storage, 3);
  r.push({ type: 'contact', id: 'a' });
  r.push({ type: 'deal', id: 'b' });
  r.push({ type: 'contact', id: 'a' });
  assert.deepEqual(r.list(), [{ type: 'contact', id: 'a' }, { type: 'deal', id: 'b' }]);
  r.push({ type: 'task', id: 'c' });
  r.push({ type: 'task', id: 'd' });
  assert.equal(r.list().length, 3);
  assert.equal(r.list()[0].id, 'd');
  mem.set('ttf:recents', '{lixo');
  assert.deepEqual(r.list(), []);
  assert.doesNotThrow(() => makeRecents({ getItem() { throw new Error('x'); }, setItem() { throw new Error('y'); } }).push({ type: 'a', id: '1' }));
});
