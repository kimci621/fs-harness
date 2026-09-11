import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, reduce, keyIntent, logLine, selected, activeRuns, totalCost, LOG_LIMIT } from '../src/tui/store.js';

const withItems = () =>
  reduce(reduce(initialState('app'), { type: 'items', tab: 'mr', items: [{ iid: 1 }, { iid: 2 }, { iid: 3 }] }), {
    type: 'items', tab: 'issues', items: [{ key: 'FD-1' }],
  });

test('вкладки: цифры, Tab по кругу', () => {
  let s = initialState('app');
  s = reduce(s, { type: 'tab', tab: 'runs' });
  assert.equal(s.tab, 'runs');
  s = reduce(s, { type: 'nextTab' });
  assert.equal(s.tab, 'mr');
});

test('курсор не выезжает за список и переживает смену списка', () => {
  let s = withItems();
  s = reduce(s, { type: 'move', by: 10 });
  assert.equal(s.cursor.mr, 2);
  s = reduce(s, { type: 'move', by: -10 });
  assert.equal(s.cursor.mr, 0);
  s = reduce(reduce(s, { type: 'move', by: 2 }), { type: 'items', tab: 'mr', items: [{ iid: 9 }] });
  assert.equal(s.cursor.mr, 0);
  assert.equal(selected(s).iid, 9);
  assert.equal(selected(reduce(s, { type: 'tab', tab: 'runs' })), null);
});

test('ран: фазы, вердикт с ценой, завершение', () => {
  let s = reduce(withItems(), { type: 'runStarted', id: 'conflict-1', action: 'conflict', target: '2547' });
  assert.equal(activeRuns(s).length, 1);
  s = reduce(s, { type: 'runEvent', id: 'conflict-1', event: { t: 'phase', phase: 'agent', status: 'start', run: 'conflict-mtx-1' } });
  assert.equal(s.runs['conflict-1'].phase, 'agent…');
  assert.equal(s.runs['conflict-1'].runId, 'conflict-mtx-1'); // id рана приходит позже старта
  s = reduce(s, { type: 'runEvent', id: 'conflict-1', event: { t: 'verdict', verdict: { decision: 'approve', meta: { cost: 0.42 } } } });
  assert.deepEqual([s.runs['conflict-1'].decision, s.runs['conflict-1'].cost], ['approve', 0.42]);
  assert.equal(totalCost(s), 0.42);
  s = reduce(s, { type: 'runEvent', id: 'conflict-1', event: { t: 'done', ok: true } });
  assert.deepEqual([s.runs['conflict-1'].done, activeRuns(s).length], [true, 0]);

  // Событие чужого рана не создаёт карточку из воздуха.
  assert.equal(reduce(s, { type: 'runEvent', id: 'нет-такого', event: { t: 'done' } }).runs['нет-такого'], undefined);
});

test('ран упал — карточка помнит почему', () => {
  let s = reduce(initialState(), { type: 'runStarted', id: 'threads-1', action: 'threads', target: '7' });
  s = reduce(s, { type: 'runEvent', id: 'threads-1', event: { t: 'error', code: 'judge_rejected', message: 'судья против' } });
  assert.deepEqual([s.runs['threads-1'].ok, s.runs['threads-1'].error], [false, 'судья против']);
});

test('лог: кольцевой буфер не растёт бесконечно', () => {
  const lines = Array.from({ length: LOG_LIMIT + 50 }, (_, i) => `строка ${i}`);
  const s = reduce(initialState(), { type: 'log', lines });
  assert.equal(s.log.length, LOG_LIMIT);
  assert.equal(s.log.at(-1), `строка ${LOG_LIMIT + 49}`);
});

test('logLine: что попадает в лог, а что рисуется карточкой', () => {
  assert.equal(logLine('conflict-1', { t: 'log', text: 'merge' }), 'conflict ▸ merge');
  assert.match(logLine('conflict-1', { t: 'verdict', verdict: { decision: 'approve', meta: { cost: 0.4 } } }), /судья: approve · \$0\.4000/);
  assert.equal(logLine('conflict-1', { t: 'phase', phase: 'judge', status: 'done' }), null);
  assert.equal(logLine('conflict-1', { t: 'delta', text: 'дум' }), null);
});

test('клавиши: запуск действия только на своей вкладке', () => {
  const s = withItems();
  assert.deepEqual(keyIntent('a', {}, s), { type: 'launch', action: 'conflict' });
  assert.deepEqual(keyIntent('r', {}, s), { type: 'launch', action: 'review' });
  assert.equal(keyIntent('n', {}, s), null); // analyze живёт на вкладке задач
  const onIssues = reduce(s, { type: 'tab', tab: 'issues' });
  assert.deepEqual(keyIntent('n', {}, onIssues), { type: 'launch', action: 'analyze' });
  assert.equal(keyIntent('a', {}, onIssues), null);

  assert.deepEqual(keyIntent('x', {}, s), { type: 'abort' });
  assert.deepEqual(keyIntent('q', {}, s), { type: 'quit' });
  assert.deepEqual(keyIntent('2', {}, s), { type: 'tab', tab: 'issues' });
  assert.deepEqual(keyIntent('', { downArrow: true }, s), { type: 'move', by: 1 });
  assert.deepEqual(keyIntent('j', {}, s), { type: 'move', by: 1 });
  assert.equal(keyIntent('ы', {}, s), null);
});

test('переходы задачи: s только на вкладке задач, в модалке остальные клавиши молчат', () => {
  const s = withItems();
  assert.equal(keyIntent('s', {}, s), null); // на вкладке MR статуса нет
  const onIssues = reduce(s, { type: 'tab', tab: 'issues' });
  assert.deepEqual(keyIntent('s', {}, onIssues), { type: 'transition' });

  const items = [{ id: '11', name: 'В тестирование', to: 'Тестирование' }, { id: '21', name: 'В ревью', to: 'Ревью' }];
  const modal = reduce(onIssues, { type: 'modalOpen', title: 'FD-1', issue: 'FD-1', items });
  assert.equal(modal.modal.cursor, 0);
  assert.deepEqual(keyIntent('j', {}, modal), { type: 'modalMove', by: 1 });
  assert.deepEqual(keyIntent('', { return: true }, modal), { type: 'modalApply' });
  assert.deepEqual(keyIntent('', { escape: true }, modal), { type: 'modalClose' });
  assert.equal(keyIntent('a', {}, modal), null); // запуск действия из модалки не срабатывает
  assert.equal(keyIntent('x', {}, modal), null);

  const moved = reduce(reduce(modal, { type: 'modalMove', by: 1 }), { type: 'modalMove', by: 1 });
  assert.equal(moved.modal.cursor, 1); // дальше списка курсор не уезжает
  assert.equal(reduce(moved, { type: 'modalClose' }).modal, null);
});
