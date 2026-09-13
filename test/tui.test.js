import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, reduce, keyIntent, logLine, selected, activeRuns, totalCost, LOG_LIMIT, orderJobs, deploySlot, DEPLOY_JOB, mrRow, issueRow, detailLines, toggleFilter, filterSummary, FILTER_FIELDS, busyText } from '../src/tui/store.js';

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

test('пайплайн: порядок стадий, слот деплоя, клавиша p только на вкладке MR', () => {
  const jobs = [
    { id: 22, stage: 'deploy_dev', name: 'deploy_dev2' },
    { id: 11, stage: 'build', name: 'build_image' },
    { id: 21, stage: 'deploy_dev', name: 'deploy_dev' },
    { id: 12, stage: 'build', name: 'lint' },
  ];
  assert.deepEqual(orderJobs(jobs).map((j) => j.name), ['build_image', 'lint', 'deploy_dev', 'deploy_dev2']);
  assert.deepEqual(orderJobs([]), []);

  assert.equal(deploySlot('deploy_dev'), '');
  assert.equal(deploySlot('deploy_dev3'), '3');
  assert.equal(deploySlot('build_image'), '');
  assert.equal(DEPLOY_JOB.test('deploy_dev10'), true);
  assert.equal(DEPLOY_JOB.test('deploy_prod'), false);

  const s = withItems();
  assert.deepEqual(keyIntent('p', {}, s), { type: 'pipeline' });
  assert.equal(keyIntent('p', {}, reduce(s, { type: 'tab', tab: 'issues' })), null);

  // Панель джоб обновляется на месте: курсор остаётся там, где стоял.
  const open = reduce(s, { type: 'modalOpen', kind: 'pipeline', title: 'п', mr: 1, items: jobs });
  const moved = reduce(open, { type: 'modalMove', by: 2 });
  const fresh = reduce(moved, { type: 'modalItems', items: jobs.slice(0, 3), busy: true });
  assert.equal(fresh.modal.cursor, 2);
  assert.equal(fresh.modal.busy, true);
  assert.equal(fresh.modal.kind, 'pipeline');
});

test('фокус: Tab переносит его по кругу, j/k в списке двигают курсор, в остальных прокручивают', () => {
  const s = withItems();
  assert.deepEqual(keyIntent('', { tab: true }, s), { type: 'focus', by: 1 });
  assert.deepEqual(keyIntent('', { tab: true, shift: true }, s), { type: 'focus', by: -1 });
  assert.deepEqual(keyIntent('j', {}, s), { type: 'move', by: 1 });

  const onDetails = reduce(s, { type: 'focus', by: 1 });
  assert.equal(onDetails.focus, 'details');
  assert.deepEqual(keyIntent('j', {}, onDetails), { type: 'scroll', by: 1 });
  assert.deepEqual(keyIntent('', { pageDown: true }, onDetails), { type: 'scroll', by: 10 });
  assert.equal(reduce(onDetails, { type: 'scroll', by: 3 }).scroll.details, 3);
  assert.equal(reduce(onDetails, { type: 'scroll', by: -3 }).scroll.details, 0); // выше начала не уедет

  const onLog = reduce(onDetails, { type: 'focus', by: 1 });
  assert.equal(onLog.focus, 'log');
  // У лога отсчёт от конца: вверх — это «показать более старое».
  assert.equal(reduce(onLog, { type: 'scroll', by: -5 }).scroll.log, 5);
  assert.equal(reduce(onLog, { type: 'scroll', by: 5 }).scroll.log, 0);
  assert.equal(reduce(onLog, { type: 'focus', by: 1 }).focus, 'list');

  // Съехал курсор — правая панель показывает другое, прокрутку сбрасываем.
  const scrolled = reduce(onDetails, { type: 'scroll', by: 4 });
  assert.equal(reduce(scrolled, { type: 'move', by: 1 }).scroll.details, 0);
});

test('строки списка: MR двухэтажный с бейджами, у задачи статус между ключом и названием', () => {
  const mr = {
    iid: 2785, title: 'Draft: фрейм оплаты', draft: true, author: 'Амир Латипов', labels: ['review'],
    created_at: new Date(Date.now() - 2 * 86400e3).toISOString(), has_conflicts: true, approved: true,
    pipeline: { status: 'success' }, comments: { open: 2, resolved: 2 },
  };
  const row = mrRow(mr);
  assert.equal(row.title, 'Draft: фрейм оплаты');
  assert.match(row.badges, /✅Approved/);
  assert.match(row.badges, /💬2 of 4/);
  assert.match(row.badges, /⚠конфликт/);
  assert.match(row.meta, /^!2785 · создан 2 дн назад · Амир Латипов · review$/);

  // Ещё не дозагрузились треды и аппрувы — бейджей просто нет, а не «0 of 0».
  const bare = mrRow({ iid: 1, title: 'x', comments: { open: null, resolved: null } });
  assert.equal(bare.badges, '');

  assert.equal(issueRow({ key: 'FD-1', fields: { status: { name: 'В работе' }, summary: 'Починить' } }), 'FD-1 · В работе · Починить');
});

test('карточка задачи: поля по названию, длинные блоки раскрываются по e', () => {
  const item = { key: 'FD-1', fields: { summary: 'Починить', status: { name: 'В работе' }, issuetype: { name: 'Task' }, updated: new Date().toISOString() } };
  const full = {
    names: { customfield_1: 'Ответственный разработчик', customfield_2: 'Technical details for QA', customfield_3: 'Sprint' },
    fields: {
      assignee: { displayName: 'Амир' }, reporter: { displayName: 'Эмиль' }, priority: { name: 'Medium' },
      labels: ['Frontend'], parent: { key: 'FD-0', fields: { summary: 'Эпик' } },
      issuelinks: [{ type: { outward: 'блокирует' }, outwardIssue: { key: 'FD-9', fields: { summary: 'Другая' } } }],
      description: 'строка один\nстрока два',
      customfield_1: [{ displayName: 'Амир' }],
      customfield_2: 'проверить чекаут',
      customfield_3: [{ id: 4, name: 'Спринт 18', state: 'active' }],
    },
  };
  const text = (lines) => lines.map((l) => l.text).join('\n');

  assert.match(text(detailLines('issues', item, {})), /подробности загружаются/);

  const closed = text(detailLines('issues', item, { full, comments: [] }));
  assert.match(closed, /Assignee: Амир · Reporter: Эмиль/);
  assert.match(closed, /Ответственный разработчик: Амир/);
  assert.match(closed, /Priority: Medium · Labels: Frontend/);
  assert.match(closed, /Sprint: Спринт 18 \(active\)/);
  assert.match(closed, /Parent: FD-0 Эпик/);
  assert.match(closed, /блокирует FD-9 Другая/);
  assert.match(closed, /▸ Technical details for QA · 1 стр\. · e раскрыть/);
  assert.doesNotMatch(closed, /проверить чекаут/); // свёрнуто — текста не видно

  const open = text(detailLines('issues', item, { full, comments: [], expand: true }));
  assert.match(open, /▾ Описание/);
  assert.match(open, /строка два/);
  assert.match(open, /проверить чекаут/);
  assert.match(open, /▸ Контент · пусто|▾ Контент · пусто/);
});

test('фильтры MR: переключатели, сводка для шапки и сброс', () => {
  let f = {};
  f = toggleFilter(f, 'conflicts');
  assert.equal(f.conflicts, true);
  f = toggleFilter(f, 'conflicts');
  assert.equal(f.conflicts, null);

  f = toggleFilter(f, 'draft'); // не важно → да
  assert.equal(f.draft, true);
  f = toggleFilter(f, 'draft'); // да → нет
  assert.equal(f.draft, false);
  f = toggleFilter(f, 'draft'); // нет → не важно
  assert.equal(f.draft, null);

  assert.equal(filterSummary({}), '');
  assert.equal(filterSummary({ author: 'me', threads: true, draft: false }), 'автор=me, draft=нет, только с открытыми тредами=да');
  assert.deepEqual(FILTER_FIELDS.map((x) => x.key).slice(0, 3), ['author', 'assignee', 'reviewer']);

  const s = withItems();
  assert.deepEqual(keyIntent('f', {}, s), { type: 'openFilters' });
  assert.equal(keyIntent('f', {}, reduce(s, { type: 'tab', tab: 'issues' })), null);

  // Пока набирают текст фильтра, клавиши принадлежат полю ввода.
  const modal = reduce(reduce(s, { type: 'modalOpen', kind: 'filters', title: 'ф', items: FILTER_FIELDS }), { type: 'modalEdit', editing: 'author', value: '' });
  assert.equal(keyIntent('j', {}, modal), null);
  assert.equal(keyIntent('q', {}, modal), null);
  assert.deepEqual(keyIntent('', { backspace: true }, reduce(modal, { type: 'modalEdit', editing: null })), { type: 'modalClear' });
});

test('задача: S — спринт, c — комментарий, только на вкладке задач', () => {
  const s = withItems();
  assert.equal(keyIntent('S', {}, s), null);
  assert.equal(keyIntent('c', {}, s), null);
  const onIssues = reduce(s, { type: 'tab', tab: 'issues' });
  assert.deepEqual(keyIntent('S', {}, onIssues), { type: 'sprint' });
  assert.deepEqual(keyIntent('c', {}, onIssues), { type: 'comment' });
  assert.deepEqual(keyIntent('e', {}, onIssues), { type: 'expand' });
  assert.equal(reduce(onIssues, { type: 'expand' }).expand, true);
});

test('занятость: каждый запрос снимает только себя, после трёх секунд видно сколько идёт', () => {
  const t0 = 1_000_000;
  let s = initialState('app');
  assert.equal(busyText(s.busy, t0), '');

  s = reduce(s, { type: 'busy', label: 'список MR', on: true, at: t0 });
  s = reduce(s, { type: 'busy', label: 'задачи Jira', on: true, at: t0 + 1000 });
  assert.equal(busyText(s.busy, t0 + 1500), 'список MR · задачи Jira'); // меньше трёх секунд — без счётчика
  assert.equal(busyText(s.busy, t0 + 5000), 'список MR 5с · задачи Jira 4с');

  s = reduce(s, { type: 'busy', label: 'задачи Jira', on: false });
  assert.equal(busyText(s.busy, t0 + 5000), 'список MR 5с');

  // Снятие того, чего нет, ничего не ломает и не плодит состояний.
  assert.equal(reduce(s, { type: 'busy', label: 'нет такого', on: false }), s);
  assert.equal(reduce(s, { type: 'busy', label: 'список MR', on: false }).busy.length, 0);

  // Два одинаковых запроса разом: в шапке одна подпись, снимаются по одному.
  let d = reduce(reduce(initialState('app'), { type: 'busy', label: 'карточка FD-1', on: true, at: t0 }), { type: 'busy', label: 'карточка FD-1', on: true, at: t0 + 200 });
  assert.equal(busyText(d.busy, t0 + 4000), 'карточка FD-1 4с');
  d = reduce(d, { type: 'busy', label: 'карточка FD-1', on: false });
  assert.equal(d.busy.length, 1);
});
