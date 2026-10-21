// Modelo puro das tarefas: criar rápido em português, prazo, agrupamento e visões. Datas em hora local.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const MODEL = await import('../../public/js/screens/tasks/model.js');
globalThis.__m = MODEL;
const { parseQuickAdd, dueLabel, groupTasks, viewTasks, viewCounts, inView, isOverdue, compareTasks, checklistProgress, boardColumns, dueFrom, startOfDay } = await import('../../public/js/screens/tasks/model.js');

// quarta-feira, 21/10/2026, 10:00 (local)
const NOW = new Date(2026, 9, 21, 10, 0);
const at = (y, mo, d, h = 12, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const q = (text) => parseQuickAdd(text, NOW);

test('criar rápido: dia relativo, hora e prioridade saem do título', () => {
  assert.deepEqual(q('Ligar para a Carla amanhã 10h !alta'), { title: 'Ligar para a Carla', dueAt: at(2026, 10, 22, 10), dueHasTime: true, priority: 'high' });
  assert.deepEqual(q('Enviar contrato hoje às 15:30'), { title: 'Enviar contrato', dueAt: at(2026, 10, 21, 15, 30), dueHasTime: true, priority: 'normal' });
  assert.deepEqual(q('revisar proposta depois de amanhã !urgente'), { title: 'revisar proposta', dueAt: at(2026, 10, 23, 12), dueHasTime: false, priority: 'urgent' });
  assert.equal(q('cobrar retorno em 3 dias').dueAt, at(2026, 10, 24, 12));
  assert.equal(q('cobrar retorno daqui a 10 dias').dueAt, at(2026, 10, 31, 12));
  assert.equal(q('reunião semana que vem').dueAt, at(2026, 10, 26, 12), 'semana que vem = próxima segunda');
});

test('criar rápido: dia da semana (sempre o próximo), dia do mês e data completa', () => {
  assert.equal(q('mandar relatório sexta').dueAt, at(2026, 10, 23, 12));
  assert.equal(q('mandar relatório sexta-feira 9h').dueAt, at(2026, 10, 23, 9));
  assert.equal(q('ligar quarta').dueAt, at(2026, 10, 28, 12), 'hoje é quarta: vale a quarta da semana que vem');
  assert.equal(q('ligar próxima segunda').dueAt, at(2026, 10, 26, 12));
  assert.equal(q('pagar boleto dia 25').dueAt, at(2026, 10, 25, 12));
  assert.equal(q('pagar boleto dia 5').dueAt, at(2026, 11, 5, 12), 'dia 5 deste mês já passou: mês que vem');
  assert.equal(q('pagar boleto dia 31').dueAt, at(2026, 10, 31, 12));
  assert.equal(q('assinar 30/10').dueAt, at(2026, 10, 30, 12));
  assert.equal(q('assinar 05/10').dueAt, at(2027, 10, 5, 12), 'sem ano e já passou: ano que vem');
  assert.equal(q('assinar 15/03/2027 14h').dueAt, at(2027, 3, 15, 14));
  assert.equal(q('assinar 15/03/27').dueAt, at(2027, 3, 15, 12));
  assert.equal(q('assinar 31/02').dueAt, null, 'data impossível não vira prazo');
});

test('criar rápido: hora sem data vale hoje (ou amanhã se já passou); horas inválidas e "as" artigo são ignorados', () => {
  assert.equal(q('ligar 15h').dueAt, at(2026, 10, 21, 15));
  assert.equal(q('ligar 9h').dueAt, at(2026, 10, 22, 9), '9h de hoje já passou');
  assert.equal(q('ligar às 16').dueAt, at(2026, 10, 21, 16));
  assert.equal(q('ligar às 16').dueHasTime, true);
  assert.equal(q('enviar as 2 propostas').dueAt, null, '"as 2" sem crase é artigo, não horário');
  assert.equal(q('ligar 25h').dueAt, null);
  assert.equal(q('ligar 10h75').dueAt, null, 'minutos inválidos: não é horário');
  assert.equal(q('ligar amanhã às 8:45').dueAt, at(2026, 10, 22, 8, 45));
});

test('criar rápido: sem nada reconhecido devolve o texto; título nunca fica vazio; acentos e caixa não importam', () => {
  assert.deepEqual(q('Preparar apresentação'), { title: 'Preparar apresentação', dueAt: null, dueHasTime: false, priority: 'normal' });
  assert.equal(q('amanhã').title, 'amanhã', 'só a data: mantém o texto como título');
  assert.equal(q('').title, '');
  assert.equal(q('LIGAR AMANHA 10H').dueAt, at(2026, 10, 22, 10));
  assert.equal(q('ligar amanha').title, 'ligar');
  assert.equal(q('Falar com o cliente !ALTA').priority, 'high');
  assert.equal(q('ligar para ele amanhã').title, 'ligar para ele');
  assert.equal(q('ligar hoje, depois enviar').title, 'ligar, depois enviar');
});

test('prazo: rótulos e tons (atrasada, hoje, amanhã, semana, depois)', () => {
  const t = (dueAt, dueHasTime = false, status = 'todo') => ({ dueAt, dueHasTime, status });
  assert.deepEqual(dueLabel(t(null), NOW), { text: 'Sem prazo', tone: 'none' });
  assert.deepEqual(dueLabel(t(at(2026, 10, 20, 12)), NOW), { text: 'Atrasada · ontem', tone: 'overdue' });
  assert.deepEqual(dueLabel(t(at(2026, 10, 18, 12)), NOW), { text: 'Atrasada · há 3 dias', tone: 'overdue' });
  assert.deepEqual(dueLabel(t(at(2026, 10, 21, 12)), NOW), { text: 'Hoje', tone: 'today' });
  assert.deepEqual(dueLabel(t(at(2026, 10, 21, 15, 30), true), NOW), { text: 'Hoje 15:30', tone: 'today' });
  assert.deepEqual(dueLabel(t(at(2026, 10, 21, 9, 0), true), NOW), { text: 'Hoje 09:00', tone: 'overdue' }, 'a hora de hoje já passou');
  assert.deepEqual(dueLabel(t(at(2026, 10, 22, 12)), NOW), { text: 'Amanhã', tone: 'soon' });
  assert.deepEqual(dueLabel(t(at(2026, 10, 24, 12)), NOW), { text: 'sáb 24/10', tone: 'soon' });
  assert.deepEqual(dueLabel(t(at(2026, 11, 20, 12)), NOW), { text: '20/11', tone: 'later' });
  assert.deepEqual(dueLabel(t(at(2027, 1, 5, 12)), NOW), { text: '05/01/2027', tone: 'later' });
  assert.equal(dueLabel(t(at(2026, 10, 10, 12), false, 'done'), NOW).tone, 'none', 'feita não é "atrasada"');
  assert.equal(isOverdue(t(at(2026, 10, 21, 12)), NOW), false, 'só data de hoje: ainda não atrasou');
  assert.equal(isOverdue(t(at(2026, 10, 21, 9, 0), true), NOW), true);
  assert.equal(isOverdue(t(at(2026, 10, 20, 12), false, 'done'), NOW), false);
});

test('agrupamento "Minhas tarefas": atrasadas, hoje, 7 dias, depois, sem prazo e concluídas (ordenadas)', () => {
  const mk = (id, dueAt, extra = {}) => ({ id, dueAt, dueHasTime: false, status: 'todo', priority: 'normal', createdAt: 1, ...extra });
  const tasks = [
    mk('late', at(2026, 10, 19, 12)),
    mk('today-b', at(2026, 10, 21, 12), { priority: 'urgent' }),
    mk('today-a', at(2026, 10, 21, 9, 0), { dueHasTime: true }),
    mk('d3', at(2026, 10, 24, 12)),
    mk('d7', at(2026, 10, 28, 12)),
    mk('d8', at(2026, 10, 29, 12)),
    mk('nodue', null),
    mk('done1', at(2026, 10, 1, 12), { status: 'done', completedAt: 100 }),
    mk('done2', null, { status: 'done', completedAt: 200 }),
  ];
  const g = Object.fromEntries(groupTasks(tasks, NOW).map((x) => [x.key, x.tasks.map((t) => t.id)]));
  assert.deepEqual(g.overdue, ['late']);
  assert.deepEqual(g.today, ['today-a', 'today-b'], 'por hora; sem hora vem depois');
  assert.deepEqual(g.next7, ['d3', 'd7']);
  assert.deepEqual(g.later, ['d8']);
  assert.deepEqual(g.nodue, ['nodue']);
  assert.deepEqual(g.done, ['done2', 'done1'], 'concluídas: a mais recente primeiro');
  assert.deepEqual(groupTasks([], NOW), []);
  assert.deepEqual(groupTasks(Array.from({ length: 30 }, (_, i) => mk(`x${i}`, null, { status: 'done', completedAt: i })), NOW).find((x) => x.key === 'done').tasks.length, 20);
});

test('ordem: prazo, depois prioridade, depois mais antiga; sem prazo por último', () => {
  const t = (id, dueAt, priority = 'normal', createdAt = 0) => ({ id, dueAt, priority, createdAt });
  const sorted = [t('c', null), t('b', 5, 'normal'), t('a', 5, 'urgent'), t('z', 1), t('old', 5, 'normal', -1)].sort(compareTasks).map((x) => x.id);
  assert.deepEqual(sorted, ['z', 'a', 'old', 'b', 'c']);
});

test('visões: minhas, delegadas, compartilhadas, equipe e todas — e a contagem só de abertas', () => {
  const me = { userId: 'u1', teamIds: ['T1'] };
  const tasks = [
    { id: 'mine', ownerId: 'u1', createdBy: 'u1', teamId: 'T1', status: 'todo' },
    { id: 'mineDone', ownerId: 'u1', createdBy: 'u1', teamId: 'T1', status: 'done' },
    { id: 'delegated', ownerId: 'u2', createdBy: 'u1', teamId: 'T2', status: 'todo' },
    { id: 'shared', ownerId: 'u3', createdBy: 'u3', teamId: 'T2', status: 'todo', sharedWith: [{ type: 'user', id: 'u1', level: 'read' }] },
    { id: 'sharedTeam', ownerId: 'u3', createdBy: 'u3', teamId: 'T2', status: 'todo', sharedWith: [{ type: 'team', id: 'T1', level: 'edit' }] },
    { id: 'colleague', ownerId: 'u4', createdBy: 'u4', teamId: 'T1', status: 'todo' },
    { id: 'other', ownerId: 'u5', createdBy: 'u5', teamId: 'T9', status: 'todo' },
  ];
  const ids = (v) => viewTasks(tasks, v, me).map((t) => t.id);
  assert.deepEqual(ids('mine'), ['mine', 'mineDone']);
  assert.deepEqual(ids('delegated'), ['delegated']);
  assert.deepEqual(ids('shared'), ['shared', 'sharedTeam']);
  assert.deepEqual(ids('team'), ['colleague']);
  assert.equal(ids('all').length, 7);
  assert.deepEqual(viewCounts(tasks, me), { mine: 1, delegated: 1, shared: 2, team: 1, all: 6 });
  assert.equal(inView({ ownerId: 'u1' }, 'team', me), false);
});

test('checklist e quadro: progresso e colunas por status', () => {
  assert.deepEqual(checklistProgress({ checklist: [{ done: true }, { done: false }, { done: true }] }), { done: 2, total: 3 });
  assert.deepEqual(checklistProgress({}), { done: 0, total: 0 });
  const cols = boardColumns([{ id: 'a', status: 'todo', dueAt: 2 }, { id: 'b', status: 'todo', dueAt: 1 }, { id: 'c', status: 'waiting' }, { id: 'd', status: 'done', completedAt: 5 }]);
  assert.deepEqual(cols.map((c) => [c.id, c.tasks.map((t) => t.id)]), [['todo', ['b', 'a']], ['doing', []], ['waiting', ['c']], ['done', ['d']]]);
  assert.equal(dueFrom(startOfDay(NOW), null), at(2026, 10, 21, 12), 'só data = meio-dia');
});

test('resumo do dia (Início): só MINHAS abertas atrasadas ou de hoje, em ordem, com a contagem de atrasadas', () => {
  const { todaySummary } = globalThis.__m;
  const mk = (id, dueAt, extra = {}) => ({ id, ownerId: 'me', status: 'todo', dueAt, dueHasTime: false, priority: 'normal', createdAt: 1, ...extra });
  const s = todaySummary(
    [
      mk('late', at(2026, 10, 19, 12)),
      mk('today', at(2026, 10, 21, 12)),
      mk('today-timed-late', at(2026, 10, 21, 9, 0), { dueHasTime: true }),
      mk('tomorrow', at(2026, 10, 22, 12)),
      mk('nodue', null),
      mk('done', at(2026, 10, 21, 12), { status: 'done' }),
      mk('other', at(2026, 10, 21, 12), { ownerId: 'outra' }),
    ],
    'me',
    NOW
  );
  assert.deepEqual(s.list.map((t) => t.id), ['late', 'today-timed-late', 'today']);
  assert.equal(s.total, 3);
  assert.equal(s.overdue, 2, 'atrasada de ontem + a de hoje cuja hora já passou');
  assert.deepEqual(todaySummary([], 'me', NOW), { list: [], total: 0, overdue: 0 });
});
