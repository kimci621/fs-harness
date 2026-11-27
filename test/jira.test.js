import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createJira, ISSUE_KEY, fieldByName, fieldIdByName, fieldText, editKind, editValueFor, openSprints } from '../src/jira.js';
import { CliError } from '../src/errors.js';
import { cmdJira, MY_ISSUES_JQL, buildJql, pickTransition, pickSprint, boardOf, pickLinkType, COLUMN_MAX } from '../src/commands/jira.js';

// Подменённый fetch: отдаёт заготовленные ответы по порядку и пишет, что спрашивали.
function fakeFetch(responses) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null, headers: init.headers });
    const r = responses.shift();
    if (r instanceof Error) throw r;
    return {
      ok: r.status < 400,
      status: r.status,
      headers: { get: (h) => r.headers?.[h] ?? null },
      json: async () => r.body,
    };
  };
  return { impl, calls };
}

const jira = (responses, over = {}) => {
  const { impl, calls } = fakeFetch(responses);
  return { j: createJira({ baseUrl: 'https://j.invalid/', email: 'me@e.st', token: 't', fetchImpl: impl, sleepMs: 1, ...over }), calls };
};

test('jira: Basic-авторизация и обрезанный хвост baseUrl', async () => {
  const { j, calls } = jira([{ status: 200, body: { accountId: 'a1' } }]);
  assert.equal((await j.myself()).accountId, 'a1');
  assert.equal(calls[0].url, 'https://j.invalid/rest/api/3/myself');
  assert.equal(calls[0].headers.authorization, `Basic ${Buffer.from('me@e.st:t').toString('base64')}`);
});

test('jira: issue и comments идут в v2 — description текстом, а не ADF', async () => {
  const { j, calls } = jira([{ status: 200, body: { key: 'FD-1' } }, { status: 200, body: { comments: [] } }]);
  await j.issue('FD-1');
  await j.comments('FD-1');
  assert.match(calls[0].url, /\/rest\/api\/2\/issue\/FD-1\?expand=renderedFields,names$/);
  assert.match(calls[1].url, /\/rest\/api\/2\/issue\/FD-1\/comment\?maxResults=50$/);
});

test('jira: searchJql — новый POST /search/jql, курсор наружу', async () => {
  const { j, calls } = jira([{ status: 200, body: { issues: [{ key: 'FD-1' }], nextPageToken: 'next' } }]);
  const r = await j.searchJql({ jql: 'assignee = currentUser()' });
  assert.deepEqual(r.issues.map((i) => i.key), ['FD-1']);
  assert.equal(r.cursor, 'next');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].body.jql, 'assignee = currentUser()');
});

test('jira: 404 на /search/jql уводит на старый GET /search и запоминается', async () => {
  const { j, calls } = jira([
    { status: 404, body: {} },
    { status: 200, body: { issues: [{ key: 'FD-1' }], startAt: 0, total: 2 } },
    { status: 200, body: { issues: [{ key: 'FD-2' }], startAt: 1, total: 2 } },
  ]);
  const first = await j.searchJql({ jql: 'x', max: 1 });
  assert.equal(first.cursor, 1);
  const second = await j.searchJql({ jql: 'x', max: 1, cursor: first.cursor });
  assert.equal(second.cursor, null); // дочитали до total
  assert.deepEqual(calls.map((c) => c.method), ['POST', 'GET', 'GET']);
  assert.match(calls[2].url, /startAt=1/);
});

test('jira: 429 с Retry-After повторяется, 401 — сразу понятная ошибка', async () => {
  const { j, calls } = jira([{ status: 429, headers: { 'retry-after': '1' }, body: {} }, { status: 200, body: { accountId: 'a1' } }]);
  assert.equal((await j.myself()).accountId, 'a1');
  assert.equal(calls.length, 2);

  const { j: j2 } = jira([{ status: 401, body: {} }]);
  await assert.rejects(() => j2.myself(), (e) => e instanceof CliError && e.code === 'api_failed' && /токен/.test(e.message));
});

test('jira: без baseUrl/email — config_invalid, а не непонятный запрос в никуда', () => {
  assert.throws(() => createJira({ token: 't' }), (e) => e.code === 'config_invalid');
  assert.throws(() => createJira({ baseUrl: 'https://j.invalid', token: 't' }), (e) => e.code === 'config_invalid');
});

test('ISSUE_KEY: ключ задачи отличается от номера MR и ветки', () => {
  assert.ok(ISSUE_KEY.test('FD-7647'));
  assert.ok(ISSUE_KEY.test('ABC1-2'));
  assert.equal(ISSUE_KEY.test('fd-7647'), false);
  assert.equal(ISSUE_KEY.test('!2547'), false);
  assert.equal(ISSUE_KEY.test('feature/FD-7647'), false);
});

test('jira mine: JQL и колонки таблицы, задача — с комментариями и ссылкой', async () => {
  const issue = {
    key: 'FD-1', fields: { summary: 'Починить', status: { name: 'In Progress' }, issuetype: { name: 'Bug' }, priority: { name: 'High' }, updated: '2026-09-01T10:00:00.000+0300', description: 'текст', assignee: { displayName: 'Я' },
      parent: { key: 'FD-0', fields: { summary: 'Эпик' } } },
  };
  let seenJql;
  const ctx = {
    cfg: { jira: { baseUrl: 'https://j.invalid/' } },
    jira: () => ({
      searchJql: async ({ jql }) => {
        if (jql.startsWith('parent = ')) return { issues: [{ key: 'FD-2', fields: { summary: 'Кусок', status: { name: 'Open' } } }], cursor: null };
        seenJql = jql;
        return { issues: [issue], cursor: null };
      },
      issue: async () => issue,
      comments: async () => ({ comments: [{ author: { displayName: 'Ревьюер' }, created: '2026-09-01T11:00:00.000+0300', body: 'вопрос' }] }),
    }),
  };
  const list = await cmdJira(ctx, [], { asObject: true });
  assert.equal(seenJql, MY_ISSUES_JQL);
  assert.deepEqual(list.issues.map((i) => i.key), ['FD-1']);
  assert.deepEqual(list.issues[0].parent, { key: 'FD-0', summary: 'Эпик' });
  assert.equal(list.issues[0].url, 'https://j.invalid/browse/FD-1');

  const one = await cmdJira(ctx, ['FD-1'], { asObject: true });
  assert.equal(one.issue.url, 'https://j.invalid/browse/FD-1');
  assert.equal(one.issue.description, 'текст');
  assert.deepEqual(one.issue.subtasks, [{ key: 'FD-2', summary: 'Кусок', status: 'Open' }]);
  assert.deepEqual(one.comments.map((c) => c.author), ['Ревьюер']);

  await assert.rejects(() => cmdJira(ctx, ['не-ключ'], { asObject: true }), (e) => e.code === 'usage');
});

// --- фильтры и смена статуса -------------------------------------------------

test('buildJql: дефолт, фильтры, чужой JQL', () => {
  assert.match(buildJql({}), /^assignee = currentUser\(\) AND statusCategory != Done ORDER BY updated DESC$/);
  assert.equal(buildJql({ assignee: 'any' }), 'statusCategory != Done ORDER BY updated DESC');
  assert.equal(
    buildJql({ assignee: 'a@b.c', sprint: 'current', component: 'Frontend', status: 'В работе' }),
    'assignee = "a@b.c" AND sprint in openSprints() AND "Компонент" = "Frontend" AND status = "В работе" ORDER BY updated DESC',
  );
  assert.match(buildJql({ sprint: 'Спринт 7' }), /sprint = "Спринт 7"/);
  assert.match(buildJql({ component: 'QA', componentField: 'Чек-лист QA' }), /"Чек-лист QA" = "QA"/);
  assert.equal(buildJql({ jql: 'project = FD' }), 'project = FD');
  assert.match(buildJql({ assignee: 'кавычка"внутри' }), /assignee = "кавычка\\"внутри"/);
});

test('pickTransition: точное имя, вхождение, неизвестное — ошибка со списком', () => {
  const ts = [
    { id: '11', name: 'В тестирование', to: { name: 'Тестирование' } },
    { id: '21', name: 'Готово к релизу', to: { name: 'Готово к релизу' } },
  ];
  assert.equal(pickTransition(ts, 'в тестирование').id, '11');
  assert.equal(pickTransition(ts, 'Тестирование').id, '11'); // по целевому статусу
  assert.equal(pickTransition(ts, 'релиз').id, '21');
  assert.throws(() => pickTransition(ts, 'в'), (e) => e.code === 'usage' && /подходит нескольким/.test(e.message));
  assert.throws(() => pickTransition(ts, 'Ревью'), (e) => /Доступны: В тестирование, Готово к релизу/.test(e.message));
});

// Поддельная Jira: статус живёт в переменной, переход его меняет.
function fakeJira({ moves = true } = {}) {
  let status = 'К выполнению';
  return {
    transitions: async () => ({ transitions: [{ id: '11', name: 'В тестирование', to: { name: 'Тестирование' } }] }),
    issue: async () => ({ fields: { status: { name: status } } }),
    transition: async () => { if (moves) status = 'Тестирование'; return null; },
  };
}

const ctxWith = (j) => ({ jira: () => j, cfg: { jira: { baseUrl: 'https://j.example' } } });

test('jira move: перевод по имени, read-back подтверждает новый статус', async () => {
  const res = await cmdJira(ctxWith(fakeJira()), ['move', 'FD-1', 'в', 'тестирование'], { asObject: true, yes: true });
  assert.deepEqual([res.from, res.to, res.transition], ['К выполнению', 'Тестирование', 'В тестирование']);
  assert.equal(res.url, 'https://j.example/browse/FD-1');
});

test('jira move: --dry-run ничего не меняет, молчаливый отказ Jira — ошибка', async () => {
  const dry = await cmdJira(ctxWith(fakeJira()), ['move', 'FD-1', 'тестирование'], { asObject: true, dryRun: true });
  assert.equal(dry.dry_run, true);
  assert.equal(dry.to, 'Тестирование');

  await assert.rejects(
    () => cmdJira(ctxWith(fakeJira({ moves: false })), ['move', 'FD-1', 'тестирование'], { asObject: true, yes: true }),
    (e) => e.code === 'api_failed' && /остался/.test(e.message),
  );
});

test('jira move: без ключа или без статуса — подсказка по использованию', async () => {
  await assert.rejects(() => cmdJira(ctxWith(fakeJira()), ['move', 'FD-1'], { asObject: true, yes: true }), (e) => e.code === 'usage');
  await assert.rejects(() => cmdJira(ctxWith(fakeJira()), ['move', 'мусор', 'x'], { asObject: true, yes: true }), (e) => e.code === 'usage');
});

test('поля задачи ищутся по названию, а не по customfield_*', () => {
  const issue = {
    names: { customfield_10341: 'Ответственный разработчик', customfield_10020: 'Sprint', summary: 'Summary' },
    fields: {
      customfield_10341: [{ displayName: 'Амир' }, { displayName: 'Эмиль' }],
      customfield_10020: [{ id: 1, name: 'Спринт 17', state: 'closed' }, { id: 2, name: 'Спринт 18', state: 'active' }],
    },
  };
  assert.equal(fieldText(fieldByName(issue, 'Ответственный разработчик')), 'Амир, Эмиль');
  assert.equal(fieldByName(issue, 'Такого поля нет'), undefined);
  assert.deepEqual(openSprints(fieldByName(issue, 'Sprint')).map((x) => x.name), ['Спринт 18']);
  assert.deepEqual(openSprints(undefined), []);
  assert.equal(fieldText(null), '');
  assert.equal(fieldText({ value: 'Frontend' }), 'Frontend');
});

test('pickSprint: по имени, по id и по вхождению; неоднозначность — ошибка', () => {
  const sprints = [{ id: 10, name: 'BE/FE. Спринт 18' }, { id: 11, name: 'Мобайл. Спринт 18' }, { id: 12, name: 'Design. Sprint 18' }];
  assert.equal(pickSprint(sprints, 'BE/FE. Спринт 18').id, 10);
  assert.equal(pickSprint(sprints, '11').id, 11);
  assert.equal(pickSprint(sprints, 'мобайл').id, 11);
  assert.throws(() => pickSprint(sprints, 'спринт 18'), (e) => /подходит нескольким/.test(e.message));
  assert.throws(() => pickSprint(sprints, 'Спринт 19'), (e) => /Доступны/.test(e.message));
});

test('boardOf: доска берётся из спринта задачи, иначе ищется по ключу проекта', async () => {
  const withSprint = { key: 'FD-1', names: { cf: 'Sprint' }, fields: { cf: [{ id: 1, name: 'С', state: 'active', boardId: 7 }] } };
  assert.equal(await boardOf({ boards: async () => { throw new Error('не должно спрашивать'); } }, withSprint), 7);

  const bare = { key: 'FD-1', names: {}, fields: {} };
  let asked = null;
  assert.equal(await boardOf({ boards: async (k) => { asked = k; return { values: [{ id: 3 }] }; } }, bare), 3);
  assert.equal(asked, 'FD');
  await assert.rejects(() => boardOf({ boards: async () => ({ values: [] }) }, bare), (e) => e.code === 'api_failed');
});

// Поддельная Jira для записи: спринт и комментарий складываются в журнал вызовов.
function fakeWriter() {
  const done = [];
  return {
    done,
    issue: async () => ({ key: 'FD-1', names: { cf: 'Sprint' }, fields: { cf: [{ id: 1, name: 'Спринт 17', state: 'active', boardId: 7 }] } }),
    sprints: async (board) => { done.push(['sprints', board]); return { values: [{ id: 42, name: 'Спринт 18' }] }; },
    moveToSprint: async (id, keys) => { done.push(['move', id, keys]); return null; },
    addComment: async (key, text) => { done.push(['comment', key, text]); return { id: '9001' }; },
  };
}

test('jira sprint: спринт с доски задачи, dry-run не пишет', async () => {
  const j = fakeWriter();
  const dry = await cmdJira(ctxWith(j), ['sprint', 'FD-1', 'спринт 18'], { asObject: true, dryRun: true });
  assert.deepEqual([dry.dry_run, dry.from, dry.to], [true, 'Спринт 17', 'Спринт 18']);
  assert.deepEqual(j.done.filter((c) => c[0] === 'move'), []);

  const res = await cmdJira(ctxWith(j), ['sprint', 'FD-1', 'спринт 18'], { asObject: true, yes: true });
  assert.deepEqual([res.from, res.to, res.sprint_id], ['Спринт 17', 'Спринт 18', 42]);
  assert.deepEqual(j.done.at(-1), ['move', 42, ['FD-1']]);
  assert.deepEqual(j.done[0], ['sprints', 7]); // доску не искали — она уже была в спринте задачи
});

test('jira sprint backlog: задача уходит в бэклог, спринты доски не спрашиваются, dry-run не пишет', async () => {
  const j = { ...fakeWriter(), moveToBacklog: async (keys) => { j.done.push(['backlog', keys]); return null; } };
  const dry = await cmdJira(ctxWith(j), ['sprint', 'FD-1', 'backlog'], { asObject: true, dryRun: true });
  assert.deepEqual([dry.dry_run, dry.from, dry.to], [true, 'Спринт 17', 'бэклог']);
  assert.deepEqual(j.done, []);
  const res = await cmdJira(ctxWith(j), ['sprint', 'FD-1', 'Бэклог'], { asObject: true, yes: true });
  assert.deepEqual([res.from, res.to, res.backlog], ['Спринт 17', 'бэклог', true]);
  assert.deepEqual(j.done, [['backlog', ['FD-1']]]);
});

test('jira sprint <id>: спринт чужой доски проекта ищется по id, закрытый — ошибка, id не ищется в именах', async () => {
  const j = fakeWriter();
  j.sprints = async (board) => { j.done.push(['sprints', board]); return { values: [{ id: 42, name: 'Спринт 99 Retention' }] }; };
  j.boards = async (project) => (project === 'FD' ? { values: [{ id: 7 }, { id: 8 }] } : { values: [] });
  j.sprint = async (id) => (String(id) === '99' ? { id: 99, name: 'Чужой', state: 'future', originBoardId: 8 } : { id: 7, name: 'Старый', state: 'closed', originBoardId: 7 });
  const res = await cmdJira(ctxWith(j), ['sprint', 'FD-1', '99'], { asObject: true, yes: true });
  assert.deepEqual([res.to, res.sprint_id], ['Чужой', 99]);
  assert.deepEqual(j.done.at(-1), ['move', 99, ['FD-1']]);
  await assert.rejects(() => cmdJira(ctxWith(j), ['sprint', 'FD-1', '7'], { asObject: true, yes: true }), (e) => e.code === 'usage');
  // id с доски задачи по-прежнему берётся из её списка
  const own = await cmdJira(ctxWith(j), ['sprint', 'FD-1', '42'], { asObject: true, yes: true });
  assert.equal(own.sprint_id, 42);

  // Открытый спринт чужого проекта (опечатка в id) — ошибка, в Jira ничего не уходит.
  const moves = j.done.filter((c) => c[0] === 'move').length;
  j.sprint = async () => ({ id: 23, name: 'MOB Sprint 4', state: 'active', originBoardId: 999 });
  await assert.rejects(() => cmdJira(ctxWith(j), ['sprint', 'FD-1', '23'], { asObject: true, yes: true }), (e) => e.code === 'usage');
  assert.equal(j.done.filter((c) => c[0] === 'move').length, moves);
});

test('jira comment: текст уходит как есть, без ключа или текста — подсказка', async () => {
  const j = fakeWriter();
  const res = await cmdJira(ctxWith(j), ['comment', 'FD-1', 'нашёл', 'баг'], { asObject: true, yes: true });
  assert.deepEqual([res.key, res.comment, res.comment_id], ['FD-1', 'нашёл баг', '9001']);
  assert.deepEqual(j.done.at(-1), ['comment', 'FD-1', 'нашёл баг']);

  await assert.rejects(() => cmdJira(ctxWith(j), ['comment', 'FD-1'], { asObject: true, yes: true }), (e) => e.code === 'usage');
  await assert.rejects(() => cmdJira(ctxWith(j), ['comment', 'мусор', 'текст'], { asObject: true, yes: true }), (e) => e.code === 'usage');
});

test('jira: правка поля — форма значения берётся из схемы editmeta', () => {
  const user = { schema: { type: 'user' }, name: 'Assignee' };
  const users = { schema: { type: 'array', items: 'user' }, name: 'Ответственный разработчик' };
  const priority = { schema: { type: 'priority' }, name: 'Priority' };
  const labels = { schema: { type: 'array', items: 'string' }, name: 'Labels' };

  assert.deepEqual(editValueFor(user, { accountId: 'a1' }), { accountId: 'a1' });
  assert.deepEqual(editValueFor(users, { accountId: 'a1' }), [{ accountId: 'a1' }]);
  assert.deepEqual(editValueFor(priority, { id: 3 }), { id: '3' });
  assert.deepEqual(editValueFor(labels, { value: 'Frontend' }), ['Frontend']);

  // Очистка: у списка это пустой массив, у одиночного поля null — Jira другого не принимает.
  assert.deepEqual(editValueFor(users, null), []);
  assert.equal(editValueFor(user, null), null);

  // Чем править поле: список, строка, число или внешний редактор.
  assert.equal(editKind(user), 'pick');
  assert.equal(editKind(users), 'pick');
  assert.equal(editKind({ schema: { type: 'priority' }, allowedValues: [{ id: '1' }] }), 'pick');
  assert.equal(editKind(labels), 'list');
  assert.equal(editKind({ schema: { type: 'string', system: 'summary' } }), 'text');
  assert.equal(editKind({ schema: { type: 'string', system: 'description' } }), 'editor');
  assert.equal(editKind({ schema: { type: 'string', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:textarea' } }), 'editor');
  assert.equal(editKind({ schema: { type: 'number' } }), 'number');
  assert.equal(editKind({ schema: { type: 'date' } }), 'text');
  assert.equal(editKind({ schema: { type: 'array', items: 'attachment' } }), null); // заполнить нечем

  assert.equal(fieldIdByName({ names: { customfield_10341: 'Ответственный разработчик' } }, 'Ответственный разработчик'), 'customfield_10341');
  assert.equal(fieldIdByName({ names: {} }, 'Нет такого'), null);
});

test('jira: updateIssue — один PUT с полями, editmeta и люди читаются GET-ом', async () => {
  const { j, calls } = jira([
    { status: 200, body: { fields: { assignee: { name: 'Assignee', schema: { type: 'user' } } } } },
    { status: 200, body: [{ accountId: 'a1', displayName: 'Амир' }] },
    { status: 204, body: null },
  ]);
  await j.editMeta('FD-1');
  await j.assignableUsers('FD-1');
  await j.updateIssue('FD-1', { assignee: { accountId: 'a1' } });

  assert.match(calls[0].url, /\/rest\/api\/2\/issue\/FD-1\/editmeta$/);
  assert.match(calls[1].url, /\/user\/assignable\/search\?issueKey=FD-1&maxResults=50$/);
  assert.equal(calls[2].method, 'PUT');
  assert.match(calls[2].url, /\/rest\/api\/2\/issue\/FD-1$/);
  assert.deepEqual(calls[2].body, { fields: { assignee: { accountId: 'a1' } } });
});

// --- запись поля по имени ----------------------------------------------------

// Поддельная Jira с editmeta: поле хранится в переменной, PUT его меняет.
function fakeFields(over = {}) {
  const stored = {};
  return {
    stored,
    editMeta: async () => ({
      fields: {
        customfield_10242: { name: 'Technical details for QA', schema: { type: 'string', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:textarea' } },
        customfield_10275: { name: 'Контент', schema: { type: 'string', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:textarea' } },
        labels: { name: 'Labels', schema: { type: 'array', items: 'string' } },
        priority: { name: 'Priority', schema: { type: 'priority' }, allowedValues: [{ id: '3', name: 'High' }] },
        attachment: { name: 'Attachment', schema: { type: 'array', items: 'attachment' } },
        ...over,
      },
    }),
    updateIssue: async (key, fields) => void Object.assign(stored, fields),
    // В PUT уходит только id варианта, а на чтение Jira отдаёт вариант целиком.
    issue: async () => ({ fields: { ...stored, ...(stored.priority ? { priority: { ...stored.priority, name: 'High' } } : {}) } }),
  };
}

test('jira field: имя поля → id из editmeta, многострочный текст из файла', async () => {
  const j = fakeFields();
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'fsh-f-')), 'qa.md');
  writeFileSync(file, 'Шаг 1\nШаг 2\n');
  const res = await cmdJira(ctxWith(j), ['field', 'FD-1', 'Technical details for QA'], { asObject: true, yes: true, file });
  assert.equal(res.field_id, 'customfield_10242');
  assert.equal(j.stored.customfield_10242, 'Шаг 1\nШаг 2\n');
  assert.equal(res.url, 'https://j.example/browse/FD-1');
});

test('jira field: форма значения по схеме — список, выбор из allowedValues', async () => {
  const j = fakeFields();
  await cmdJira(ctxWith(j), ['field', 'FD-1', 'Labels', 'a, b'], { asObject: true, yes: true });
  assert.deepEqual(j.stored.labels, ['a', 'b']);
  await cmdJira(ctxWith(j), ['field', 'FD-1', 'Priority', 'high'], { asObject: true, yes: true });
  assert.deepEqual(j.stored.priority, { id: '3' });
});

test('jira field: выбор пользователя через assignableUsers и me', async () => {
  const users = [
    { accountId: 'u1', displayName: 'Амир Латипов' },
    { accountId: 'u2', displayName: 'Эмиль Латыпов' },
  ];
  const j = {
    ...fakeFields({
      customfield_10341: { name: 'Ответственный разработчик', schema: { type: 'array', items: 'user' } },
      assignee: { name: 'Assignee', schema: { type: 'user' } },
    }),
    assignableUsers: async () => users,
    myself: async () => ({ accountId: 'u1', displayName: 'Амир Латипов' }),
  };
  await cmdJira(ctxWith(j), ['field', 'FD-1', 'Ответственный разработчик', 'Амир'], { asObject: true, yes: true });
  assert.deepEqual(j.stored.customfield_10341, [{ accountId: 'u1' }]);

  await cmdJira(ctxWith(j), ['field', 'FD-1', 'Ответственный разработчик', 'Амир, Эмиль'], { asObject: true, yes: true });
  assert.deepEqual(j.stored.customfield_10341, [{ accountId: 'u1' }, { accountId: 'u2' }]);

  await cmdJira(ctxWith(j), ['field', 'FD-1', 'Assignee', 'me'], { asObject: true, yes: true });
  assert.deepEqual(j.stored.assignee, { accountId: 'u1' });
});

test('jira field: неизвестное имя, незаполняемое поле и чужой вариант — ошибка со списком', async () => {
  const j = fakeFields();
  await assert.rejects(
    () => cmdJira(ctxWith(j), ['field', 'FD-1', 'Эпик', 'x'], { asObject: true, yes: true }),
    (e) => e.code === 'usage' && /Есть: .*Контент/.test(e.message) && !/Attachment/.test(e.message),
  );
  await assert.rejects(
    () => cmdJira(ctxWith(j), ['field', 'FD-1', 'Attachment', 'x'], { asObject: true, yes: true }),
    (e) => e.code === 'usage' && /заполнить нечем/.test(e.message),
  );
  await assert.rejects(
    () => cmdJira(ctxWith(j), ['field', 'FD-1', 'Priority', 'Срочно'], { asObject: true, yes: true }),
    (e) => e.code === 'usage' && /Доступно: High/.test(e.message),
  );
  // Без значения field читает поле; пустое значение — это пустой --file.
  const emptyFile = path.join(mkdtempSync(path.join(tmpdir(), 'fsh-e-')), 'empty.txt');
  writeFileSync(emptyFile, '  \n');
  await assert.rejects(
    () => cmdJira(ctxWith(j), ['field', 'FD-1', 'Labels'], { asObject: true, yes: true, file: emptyFile }),
    (e) => e.code === 'usage' && /значение пустое/.test(e.message),
  );
  assert.deepEqual(j.stored, {});
});

test('jira field: dry-run показывает значение и ничего не пишет', async () => {
  const j = fakeFields();
  const dry = await cmdJira(ctxWith(j), ['field', 'FD-1', 'Контент', 'слово,перевод'], { asObject: true, dryRun: true });
  assert.deepEqual([dry.dry_run, dry.field_id, dry.value], [true, 'customfield_10275', 'слово,перевод']);
  assert.deepEqual(j.stored, {});
});

// Поддельная Jira для CRUD: создание и удаление складываются в журнал вызовов.
function fakeCrud() {
  const done = [];
  return {
    done,
    issue: async () => ({ key: 'FD-1', fields: { summary: 'старая задача' } }),
    createTypes: async (project) => { done.push(['types', project]); return [{ id: '10001', name: 'Task' }, { id: '10002', name: 'Bug' }]; },
    createMeta: async (project, typeId) => ({
      id: typeId,
      // allowedValues делает поле pick: значения проверяются по списку, как в TUI
      fields: { customfield_10105: { name: 'Компонент', schema: { type: 'array', items: 'string', custom: 'textarea' }, allowedValues: [{ id: '1', value: 'Тест' }] } },
    }),
    createIssue: async (fields) => { done.push(['create', fields]); return { key: 'FD-9', id: '9' }; },
    deleteIssue: async (key) => { done.push(['delete', key]); return null; },
  };
}

test('jira create: тип по createmeta, dry-run не пишет, unknown тип — ошибка', async () => {
  const j = fakeCrud();
  const dry = await cmdJira(ctxWith(j), ['create', 'FD', 'bug', 'новая', 'задача'], { asObject: true, dryRun: true });
  assert.deepEqual([dry.dry_run, dry.project, dry.type, dry.summary], [true, 'FD', 'Bug', 'новая задача']);
  assert.deepEqual(j.done.filter((c) => c[0] === 'create'), []);

  const res = await cmdJira(ctxWith(j), ['create', 'FD', 'task', 'новая задача'], { asObject: true, yes: true });
  assert.equal(res.key, 'FD-9');
  assert.deepEqual(j.done.at(-1)[1], { project: { key: 'FD' }, issuetype: { id: '10001' }, summary: 'новая задача' });

  // --component уходит как customfield_10105 со значением по схеме поля (массив строк)
  const withComp = await cmdJira(ctxWith(j), ['create', 'FD', 'task', 'с компонентом'], { asObject: true, yes: true, component: 'Тест' });
  assert.deepEqual(withComp.component, 'Тест');
  const body = j.done.at(-1)[1];
  assert.deepEqual(body.customfield_10105, ['Тест']);

  await assert.rejects(() => cmdJira(ctxWith(j), ['create', 'FD', 'task', 'x'], { asObject: true, yes: true, component: 'Чужой' }), (e) => e.code === 'usage');

  await assert.rejects(() => cmdJira(ctxWith(j), ['create', 'FD', 'хотелка', 'x'], { asObject: true, yes: true }), (e) => e.code === 'usage');
  await assert.rejects(() => cmdJira(ctxWith(j), ['create', 'FD', 'task'], { asObject: true, yes: true }), (e) => e.code === 'usage');
});

test('jira delete: dry-run не удаляет, без подтверждения — отмена', async () => {
  const j = fakeCrud();
  const dry = await cmdJira(ctxWith(j), ['delete', 'FD-1'], { asObject: true, dryRun: true });
  assert.deepEqual([dry.dry_run, dry.key, dry.summary], [true, 'FD-1', 'старая задача']);
  assert.deepEqual(j.done.filter((c) => c[0] === 'delete'), []);

  const res = await cmdJira(ctxWith(j), ['delete', 'FD-1'], { asObject: true });
  assert.equal(res.ok, true);
  assert.deepEqual(j.done.at(-1), ['delete', 'FD-1']);

  await assert.rejects(() => cmdJira(ctxWith(j), ['delete', 'мусор'], { asObject: true }), (e) => e.code === 'usage');
});

test('jira delete: -y удаляет без вопроса и без asObject', async () => {
  const j = fakeCrud();
  await cmdJira(ctxWith(j), ['delete', 'FD-1'], { yes: true, json: true });
  assert.deepEqual(j.done.at(-1), ['delete', 'FD-1']);
});

test('jira.js: createIssue и deleteIssue идут в правильные пути', async () => {
  const { j, calls } = jira([{ status: 201, body: { key: 'FD-9' } }, { status: 204 }]);
  await j.createIssue({ project: { key: 'FD' }, summary: 'x' });
  await j.deleteIssue('FD-9');
  assert.equal(calls[0].url, 'https://j.invalid/rest/api/2/issue');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[1].url, 'https://j.invalid/rest/api/2/issue/FD-9');
  assert.equal(calls[1].method, 'DELETE');
});

// --- вложения ---

test('jira addAttachment: multipart, X-Atlassian-Token и файл как есть', async () => {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => [{ id: 10, filename: 'content.csv', size: 3 }] };
  };
  const j = createJira({ baseUrl: 'https://j.invalid', email: 'me@e.st', token: 't', fetchImpl: impl, sleepMs: 1 });
  const res = await j.addAttachment('FD-1', [{ name: 'content.csv', data: Buffer.from('a,b') }]);

  assert.equal(calls[0].url, 'https://j.invalid/rest/api/2/issue/FD-1/attachments');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['x-atlassian-token'], 'no-check');
  // content-type не ставим руками: boundary проставляет fetch, иначе Jira не разберёт тело
  assert.equal(calls[0].init.headers['content-type'], undefined);
  assert.ok(calls[0].init.body instanceof FormData, 'тело должно уйти FormData, а не JSON-строкой');
  const file = calls[0].init.body.get('file');
  assert.equal(file.name, 'content.csv');
  assert.equal(await file.text(), 'a,b');
  assert.equal(res[0].id, 10);
});

test('jira attachmentData: абсолютная ссылка не клеится к baseUrl, тело не разбирается в JSON', async () => {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => new TextEncoder().encode('csv').buffer };
  };
  const j = createJira({ baseUrl: 'https://j.invalid', email: 'me@e.st', token: 't', fetchImpl: impl, sleepMs: 1 });
  const buf = await j.attachmentData('https://j.invalid/rest/api/3/attachment/content/10');

  assert.equal(calls[0].url, 'https://j.invalid/rest/api/3/attachment/content/10');
  assert.equal(Buffer.from(buf).toString(), 'csv');
});

function fakeAttachJira(list = []) {
  const done = [];
  return {
    done,
    attachments: async (key) => { done.push(['list', key]); return list; },
    addAttachment: async (key, files) => {
      done.push(['add', key, files.map((f) => f.name)]);
      return files.map((f, i) => ({ id: 100 + i, filename: f.name, size: f.data.length, author: { displayName: 'me' }, created: '2026-09-17T10:00:00.000+0300' }));
    },
    attachmentData: async (url) => { done.push(['get', url]); return new TextEncoder().encode('данные').buffer; },
  };
}

test('jira attach: без файлов список, с файлами аплоад, dry-run молчит', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fsh-attach-'));
  const file = path.join(dir, 'content.csv');
  writeFileSync(file, 'Группа, Ключ, Значение\n');

  const j = fakeAttachJira([{ id: 7, filename: 'old.txt', size: 12, author: { displayName: 'кто-то' }, created: '' }]);
  const list = await cmdJira(ctxWith(j), ['attach', 'FD-1'], { asObject: true });
  assert.deepEqual(list.attachments.map((a) => a.filename), ['old.txt']);
  assert.deepEqual(j.done.at(-1), ['list', 'FD-1']);

  const dry = await cmdJira(ctxWith(j), ['attach', 'FD-1', file], { asObject: true, dryRun: true });
  assert.equal(dry.dry_run, true);
  assert.deepEqual(j.done.filter((c) => c[0] === 'add'), []);

  const res = await cmdJira(ctxWith(j), ['attach', 'FD-1', file], { asObject: true, yes: true });
  assert.deepEqual(res.attached.map((a) => a.filename), ['content.csv']);
  assert.deepEqual(j.done.at(-1), ['add', 'FD-1', ['content.csv']]);

  await assert.rejects(() => cmdJira(ctxWith(j), ['attach', 'FD-1', path.join(dir, 'нет.txt')], { asObject: true, yes: true }), (e) => e.code === 'usage');
  await assert.rejects(() => cmdJira(ctxWith(j), ['attach', 'мусор', file], { asObject: true, yes: true }), (e) => e.code === 'usage');
});

test('jira attach get: имя вложения из Jira — чужой ввод, каталог назначения из него не уедет', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fsh-attach-get-'));
  const j = fakeAttachJira([
    { id: 7, filename: '../../сбежал.txt', size: 6, content: 'https://j.example/a/7', author: { displayName: 'me' }, created: '' },
  ]);
  const res = await cmdJira(ctxWith(j), ['attach', 'get', 'FD-1'], { asObject: true, out: dir });

  assert.equal(res.saved[0].path, path.join(dir, 'сбежал.txt'));
  assert.equal(readFileSync(res.saved[0].path, 'utf8'), 'данные');
  assert.deepEqual(j.done.at(-1), ['get', 'https://j.example/a/7']);

  await assert.rejects(() => cmdJira(ctxWith(j), ['attach', 'get', 'FD-1', 'нет-такого'], { asObject: true, out: dir }), (e) => e.code === 'usage');
});

// --- связи ---

const LINK_TYPES = [
  { id: '1', name: 'Blocks', outward: 'blocks', inward: 'is blocked by' },
  { id: '2', name: 'Relates', outward: 'relates to', inward: 'relates to' },
  { id: '3', name: 'Cloners', outward: 'clones', inward: 'is cloned by' },
];

test('pickLinkType: имя, фраза outward и inward; неоднозначное и чужое — ошибка со списком', () => {
  assert.deepEqual([pickLinkType(LINK_TYPES, 'blocks').type.name, pickLinkType(LINK_TYPES, 'blocks').asInward], ['Blocks', false]);
  assert.deepEqual([pickLinkType(LINK_TYPES, 'Is Blocked By').type.name, pickLinkType(LINK_TYPES, 'is blocked by').asInward], ['Blocks', true]);
  assert.equal(pickLinkType(LINK_TYPES, 'blocked').asInward, true);
  assert.deepEqual([pickLinkType(LINK_TYPES, 'relates').type.name, pickLinkType(LINK_TYPES, 'relates').asInward], ['Relates', false]);
  assert.throws(() => pickLinkType(LINK_TYPES, 'is'), (e) => e.code === 'usage' && /нескольким/.test(e.message));
  assert.throws(() => pickLinkType(LINK_TYPES, 'дублирует'), (e) => e.code === 'usage' && /Blocks \(blocks \/ is blocked by\)/.test(e.message));
});

// Поддельная Jira связей: созданная связь появляется у задач так, как её показывает настоящая Jira —
// у inwardIssue в связях стоит outwardIssue, и наоборот. flip портит направление для проверки read-back.
function fakeLinks({ flip = false } = {}) {
  const created = [];
  const byKey = {};
  return {
    created,
    linkTypes: async () => LINK_TYPES,
    createLink: async ({ type, inward, outward }) => {
      created.push({ type, inward, outward });
      const [a, b] = flip ? [outward, inward] : [inward, outward];
      (byKey[a] ??= []).push({ type: { name: type }, outwardIssue: { key: b } });
      (byKey[b] ??= []).push({ type: { name: type }, inwardIssue: { key: a } });
    },
    issueLinks: async (key) => byKey[key] ?? [],
  };
}

test('jira link: «FD-2 blocks FD-1» — FD-2 в inwardIssue, read-back со стороны FD-2', async () => {
  const j = fakeLinks();
  const res = await cmdJira(ctxWith(j), ['link', 'FD-2', 'blocks', 'FD-1'], { asObject: true, yes: true });
  assert.deepEqual(j.created, [{ type: 'Blocks', inward: 'FD-2', outward: 'FD-1' }]);
  assert.deepEqual([res.link, res.type, res.url], ['FD-2 blocks FD-1', 'Blocks', 'https://j.example/browse/FD-2']);
});

test('jira link: фраза inward разворачивает задачи в запросе', async () => {
  const j = fakeLinks();
  const res = await cmdJira(ctxWith(j), ['link', 'FD-1', 'is', 'blocked', 'by', 'FD-2'], { asObject: true, yes: true });
  assert.deepEqual(j.created, [{ type: 'Blocks', inward: 'FD-2', outward: 'FD-1' }]);
  assert.equal(res.link, 'FD-1 is blocked by FD-2');
});

test('jira link: dry-run не пишет, обратное направление после записи — ошибка, мусор — подсказка', async () => {
  const dry = fakeLinks();
  const res = await cmdJira(ctxWith(dry), ['link', 'FD-2', 'relates', 'FD-1'], { asObject: true, dryRun: true });
  assert.deepEqual([res.dry_run, res.link], [true, 'FD-2 relates to FD-1']);
  assert.deepEqual(dry.created, []);

  await assert.rejects(
    () => cmdJira(ctxWith(fakeLinks({ flip: true })), ['link', 'FD-2', 'blocks', 'FD-1'], { asObject: true, yes: true }),
    (e) => e.code === 'api_failed' && /FD-2 is blocked by FD-1/.test(e.message),
  );
  for (const args of [['link', 'FD-2', 'FD-1'], ['link', 'FD-2', 'blocks', 'мусор'], ['link', 'FD-2', 'blocks', 'FD-2']]) {
    await assert.rejects(() => cmdJira(ctxWith(fakeLinks()), args, { asObject: true, yes: true }), (e) => e.code === 'usage');
  }
});

test('jira.js: связи — типы GET-ом, создание POST в /issueLink, связи задачи из fields=issuelinks', async () => {
  const { j, calls } = jira([
    { status: 200, body: { issueLinkTypes: LINK_TYPES } },
    { status: 201, body: null },
    { status: 200, body: { fields: { issuelinks: [{ id: '7' }] } } },
  ]);
  assert.equal((await j.linkTypes()).length, 3);
  await j.createLink({ type: 'Blocks', inward: 'FD-2', outward: 'FD-1' });
  assert.deepEqual(await j.issueLinks('FD-2'), [{ id: '7' }]);
  assert.equal(calls[0].url, 'https://j.invalid/rest/api/2/issueLinkType');
  assert.deepEqual([calls[1].url, calls[1].method, calls[1].body], [
    'https://j.invalid/rest/api/2/issueLink',
    'POST',
    { type: { name: 'Blocks' }, inwardIssue: { key: 'FD-2' }, outwardIssue: { key: 'FD-1' } },
  ]);
  assert.equal(calls[2].url, 'https://j.invalid/rest/api/2/issue/FD-2?fields=issuelinks');
});

test('jira link: такая связь уже есть — второй раз не создаётся', async () => {
  const j = fakeLinks();
  await cmdJira(ctxWith(j), ['link', 'FD-2', 'blocks', 'FD-1'], { asObject: true, yes: true });
  const again = await cmdJira(ctxWith(j), ['link', 'FD-1', 'is blocked by', 'FD-2'], { asObject: true, yes: true });
  assert.equal(again.existed, true);
  assert.equal(j.created.length, 1);
});

// --- агентские удобства: синонимы, чтение поля, родитель, флаги create -------

test('jira: синонимы show/view/search/transition и справка голой подкоманды', async () => {
  const issue = { key: 'FD-1', fields: { summary: 'S', status: { name: 'Open' } } };
  const seen = [];
  const j = {
    issue: async () => issue,
    comments: async () => ({ comments: [] }),
    searchJql: async ({ jql }) => { seen.push(jql); return { issues: jql.startsWith('parent') ? [] : [issue], cursor: null }; },
  };
  for (const sub of ['show', 'view']) {
    const r = await cmdJira(ctxWith(j), [sub, 'FD-1'], { asObject: true });
    assert.equal(r.issue.key, 'FD-1');
  }
  const found = await cmdJira(ctxWith(j), ['search', 'project = FD AND status = Open'], { asObject: true });
  assert.equal(found.jql, 'project = FD AND status = Open');

  const moved = await cmdJira(ctxWith(fakeJira()), ['transition', 'FD-1', 'тестирование'], { asObject: true, yes: true });
  assert.equal(moved.to, 'Тестирование');

  for (const sub of ['create', 'field', 'parent', 'search']) {
    const help = await cmdJira(ctxWith({}), [sub], { asObject: true });
    assert.match(help.usage, new RegExp(`fsh jira ${sub} `));
  }
});

test('jira field: человек ищется и по accountId, «Исполнитель» — это Assignee, латиница не выдумывается', async () => {
  const j = {
    ...fakeFields({ assignee: { name: 'Assignee', schema: { type: 'user', system: 'assignee' } } }),
    assignableUsers: async () => [{ accountId: '712020:fee71ae5', displayName: 'Амир Латипов' }],
  };
  await cmdJira(ctxWith(j), ['field', 'FD-1', 'Assignee', '712020:fee71ae5'], { asObject: true, yes: true });
  assert.deepEqual(j.stored.assignee, { accountId: '712020:fee71ae5' });
  delete j.stored.assignee;
  await cmdJira(ctxWith(j), ['field', 'FD-1', 'Исполнитель', 'Амир'], { asObject: true, yes: true });
  assert.deepEqual(j.stored.assignee, { accountId: '712020:fee71ae5' });
  await assert.rejects(
    () => cmdJira(ctxWith(j), ['field', 'FD-1', 'Исполнитель', 'Amir Latipov'], { asObject: true, yes: true }),
    (e) => e.code === 'usage' && /Амир Латипов/.test(e.message) && /accountId/.test(e.message),
  );
});

test('jira field: accountId вне первых 50 назначаемых уходит в Jira как есть', async () => {
  const j = {
    ...fakeFields({ assignee: { name: 'Assignee', schema: { type: 'user', system: 'assignee' } } }),
    assignableUsers: async () => [{ accountId: '557058:other', displayName: 'Кто-то' }],
  };
  await cmdJira(ctxWith(j), ['field', 'FD-1', 'Assignee', '712020:fee71ae5-539f-4d46-8831-f6ead07c3a95'], { asObject: true, yes: true });
  assert.deepEqual(j.stored.assignee, { accountId: '712020:fee71ae5-539f-4d46-8831-f6ead07c3a95' });
});

// Поддельная Jira с картой имён: чтение поля идёт через issue(expand=names).
function fakeNamed(fields) {
  const j = fakeFields();
  Object.assign(j.stored, fields);
  const names = { customfield_10242: 'Technical details for QA', description: 'Description', labels: 'Labels' };
  return { ...j, issue: async () => ({ key: 'FD-1', names, fields: { ...j.stored } }) };
}

test('jira field без значения — чтение как есть, без записи; --json отдаёт сырое значение', async () => {
  const j = fakeNamed({ customfield_10242: 'h3. Шаги\n# открыть', description: 'текст' });
  let wrote = false;
  j.updateIssue = async () => { wrote = true; };
  const r = await cmdJira(ctxWith(j), ['field', 'FD-1', 'technical details for qa'], { asObject: true });
  assert.deepEqual([r.read, r.field_id, r.text, r.value], [true, 'customfield_10242', 'h3. Шаги\n# открыть', 'h3. Шаги\n# открыть']);
  const d = await cmdJira(ctxWith(j), ['field', 'FD-1', 'Описание'], { asObject: true });
  assert.equal(d.text, 'текст');
  await assert.rejects(() => cmdJira(ctxWith(j), ['field', 'FD-1', 'Нет такого'], { asObject: true }), (e) => e.code === 'usage' && /Technical details for QA/.test(e.message));
  assert.equal(wrote, false);
});

test('jira field --append дописывает текст с новой строки, нетекстовое поле — ошибка', async () => {
  const j = fakeNamed({ customfield_10242: 'h3. Было\n' });
  const r = await cmdJira(ctxWith(j), ['field', 'FD-1', 'Technical details for QA', '* новая строка'], { asObject: true, yes: true, append: true });
  assert.equal(j.stored.customfield_10242, 'h3. Было\n* новая строка');
  assert.equal(r.written, 'h3. Было\n* новая строка');
  const empty = fakeNamed({});
  await cmdJira(ctxWith(empty), ['field', 'FD-1', 'Technical details for QA', 'первая'], { asObject: true, yes: true, append: true });
  assert.equal(empty.stored.customfield_10242, 'первая');
  await assert.rejects(
    () => cmdJira(ctxWith(j), ['field', 'FD-1', 'Labels', 'x'], { asObject: true, yes: true, append: true }),
    (e) => e.code === 'usage' && /--append/.test(e.message),
  );
});

function fakeParent({ sticks = true } = {}) {
  const done = [];
  let parent = null;
  return {
    done,
    issue: async () => ({ key: 'FD-1', fields: { parent: parent ? { key: parent } : undefined } }),
    updateIssue: async (key, fields) => { done.push(['update', key, fields]); if (sticks) parent = fields.parent.key; },
  };
}

test('jira parent: ставит эпик через поле parent и сверяет чтением; field Parent ведёт туда же', async () => {
  const j = fakeParent();
  const dry = await cmdJira(ctxWith(j), ['parent', 'FD-1', 'FD-100'], { asObject: true, dryRun: true });
  assert.deepEqual([dry.dry_run, dry.to], [true, 'FD-100']);
  assert.deepEqual(j.done, []);
  const r = await cmdJira(ctxWith(j), ['parent', 'FD-1', 'FD-100'], { asObject: true, yes: true });
  assert.deepEqual([r.from, r.to], ['без родителя', 'FD-100']);
  assert.deepEqual(j.done, [['update', 'FD-1', { parent: { key: 'FD-100' } }]]);

  const viaField = fakeParent();
  await cmdJira(ctxWith(viaField), ['field', 'FD-1', 'Parent', 'FD-7'], { asObject: true, yes: true });
  assert.deepEqual(viaField.done, [['update', 'FD-1', { parent: { key: 'FD-7' } }]]);

  await assert.rejects(() => cmdJira(ctxWith(fakeParent({ sticks: false })), ['parent', 'FD-1', 'FD-100'], { asObject: true, yes: true }), (e) => e.code === 'api_failed');
  await assert.rejects(() => cmdJira(ctxWith(j), ['parent', 'FD-1', 'эпик'], { asObject: true, yes: true }), (e) => e.code === 'usage');
});

test('jira create --parent --sprint --assignee: задача по правилам команды одной командой', async () => {
  const j = {
    ...fakeCrud(),
    createTypes: async () => [{ id: '10001', name: 'Task' }],
    boards: async () => ({ values: [{ id: 1 }] }),
    sprints: async () => ({ values: [{ id: 4176, name: 'Канбан доска Growth' }] }),
    projectUsers: async () => [],
    myself: async () => ({ accountId: 'me1', displayName: 'Я' }),
  };
  const created = [];
  const moved = [];
  j.createIssue = async (fields) => { created.push(fields); return { key: 'FD-9' }; };
  j.moveToSprint = async (id, keys) => { moved.push([id, keys]); };
  const opts = { asObject: true, yes: true, parent: 'FD-100', sprint: '4176', assignee: 'me' };

  const dry = await cmdJira(ctxWith(j), ['create', 'FD', 'task', 'новая'], { ...opts, dryRun: true });
  assert.deepEqual([dry.parent, dry.sprint, dry.assignee], ['FD-100', '4176', 'me']);
  assert.deepEqual(created, []);

  const r = await cmdJira(ctxWith(j), ['create', 'FD', 'task', 'новая'], opts);
  assert.equal(r.key, 'FD-9');
  assert.deepEqual(created[0].parent, { key: 'FD-100' });
  assert.deepEqual(moved, [[4176, ['FD-9']]]);
  assert.deepEqual(created[0].assignee, { accountId: 'me1' });

  // Опечатка в спринте или исполнителе ловится до создания, а не оставляет задачу наполовину.
  await assert.rejects(() => cmdJira(ctxWith(j), ['create', 'FD', 'task', 'новая'], { ...opts, sprint: 'нет такого' }), (e) => e.code === 'usage');
  await assert.rejects(() => cmdJira(ctxWith(j), ['create', 'FD', 'task', 'новая'], { ...opts, assignee: 'Amir' }), (e) => e.code === 'usage');
  assert.equal(created.length, 1);

  // Спринт не принялся уже после создания — ошибка называет ключ созданной задачи.
  j.moveToSprint = async () => { throw new Error('500'); };
  await assert.rejects(() => cmdJira(ctxWith(j), ['create', 'FD', 'task', 'новая'], opts), (e) => /FD-9 создана/.test(e.message));
});

test('jira comment --file: длинный текст из файла или stdin, а не из argv', async () => {
  const j = fakeWriter();
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'fsh-c-')), 'c.md');
  writeFileSync(file, 'строка 1\nстрока 2\n');
  const r = await cmdJira(ctxWith(j), ['comment', 'FD-1'], { asObject: true, yes: true, file });
  assert.equal(r.comment, 'строка 1\nстрока 2');
  assert.deepEqual(j.done.at(-1), ['comment', 'FD-1', 'строка 1\nстрока 2']);
});

// --- доска проекта для внешних досок (bb) ---

test('jira board: колонки доски с именами статусов, запрос задач на каждую колонку, исполнитель', async () => {
  const seen = [];
  const byStatus = {
    '1, 2': [{ key: 'FD-1', fields: { summary: 'Починить', status: { id: '2', name: 'Backlog' }, issuetype: { name: 'Bug' }, priority: { name: 'High' }, assignee: { displayName: 'Я' } } }],
    '3': [{ key: 'FD-2', fields: { summary: 'Без исполнителя', status: { id: '3', name: 'Готово' }, issuetype: { name: 'Task' }, priority: { name: 'Low' } } }],
  };
  const ctx = {
    cfg: { jira: { baseUrl: 'https://j.invalid/' } },
    jira: () => ({
      boards: async (p) => (seen.push(['boards', p]), { values: [{ id: 7, name: 'FD board' }, { id: 8, name: 'другая' }] }),
      boardConfig: async (id) => (seen.push(['config', id]), { columnConfig: { columns: [
        { name: 'To do', statuses: [{ id: '1' }, { id: '2' }] },
        { name: 'Пустая', statuses: [] },
        { name: 'Done', statuses: [{ id: '3' }] },
      ] } }),
      allStatuses: async () => [
        { id: '1', name: 'Open', statusCategory: { key: 'new' } },
        { id: '2', name: 'Backlog', statusCategory: { key: 'new' } },
        { id: '3', name: 'Готово', statusCategory: { key: 'done' } },
      ],
      fieldList: async () => [],
      sprints: async () => ({ values: [] }),
      searchJql: async ({ jql, max }) => {
        seen.push(['search', jql, max]);
        return { issues: byStatus[jql.match(/status in \(([^)]*)\)/)[1]], cursor: null };
      },
    }),
  };
  const r = await cmdJira(ctx, ['board', 'FD'], { asObject: true });
  assert.deepEqual(r.board, { id: 7, name: 'FD board' });
  assert.equal(seen.find((s) => s[0] === 'config')[1], 7);
  assert.deepEqual(r.columns, [
    { name: 'To do', statuses: [{ id: '1', name: 'Open', category: 'new' }, { id: '2', name: 'Backlog', category: 'new' }], truncated: false },
    { name: 'Пустая', statuses: [], truncated: false },
    { name: 'Done', statuses: [{ id: '3', name: 'Готово', category: 'done' }], truncated: false },
  ]);
  // Колонка без статусов в Jira не спрашивается.
  assert.deepEqual(seen.filter((s) => s[0] === 'search').map((s) => [s[1], s[2]]), [
    ['project = "FD" AND (statusCategory != Done OR statusCategoryChangedDate >= -14d) AND status in (1, 2) ORDER BY Rank ASC', COLUMN_MAX],
    ['project = "FD" AND (statusCategory != Done OR statusCategoryChangedDate >= -14d) AND status in (3) ORDER BY Rank ASC', COLUMN_MAX],
  ]);
  assert.deepEqual(r.issues.map((i) => [i.key, i.status, i.status_id, i.assignee, i.url]), [
    ['FD-1', 'Backlog', '2', 'Я', 'https://j.invalid/browse/FD-1'],
    ['FD-2', 'Готово', '3', null, 'https://j.invalid/browse/FD-2'],
  ]);
  assert.equal(r.truncated, false);
});

test('jira board: --jql добавляется условием, переполненная колонка обрезается с флагом и не вытесняет другие, без доски и без проекта — ошибка', async () => {
  const jqls = [];
  const many = Array.from({ length: COLUMN_MAX }, (_, i) => ({ key: `FD-${i}`, fields: { status: { id: '1', name: 'Open' } } }));
  const ctx = (boards) => ({
    cfg: { jira: { baseUrl: 'https://j.invalid' } },
    jira: () => ({
      boards: async () => ({ values: boards }),
      boardConfig: async () => ({ columnConfig: { columns: [
        { name: 'Бэклог', statuses: [{ id: '1' }] },
        { name: 'В работе', statuses: [{ id: '2' }] },
      ] } }),
      allStatuses: async () => [],
      fieldList: async () => [],
      sprints: async () => ({ values: [] }),
      searchJql: async ({ jql }) => {
        jqls.push(jql);
        return jql.includes('status in (1)')
          ? { issues: many, cursor: 'next' }
          : { issues: [{ key: 'FD-999', fields: { status: { id: '2', name: 'В работе' } } }], cursor: null };
      },
    }),
  });
  const r = await cmdJira(ctx([{ id: 1, name: 'b' }]), ['board', 'FD'], { asObject: true, jql: 'assignee = currentUser()' });
  assert.ok(jqls.every((q) => q.startsWith('project = "FD" AND (assignee = currentUser()) AND ')), jqls.join('\n'));
  assert.equal(jqls.length, 2);
  assert.equal(r.issues.length, COLUMN_MAX + 1);
  assert.ok(r.issues.some((i) => i.key === 'FD-999'));
  assert.deepEqual(r.columns.map((c) => c.truncated), [true, false]);
  assert.equal(r.truncated, true);

  await assert.rejects(() => cmdJira(ctx([]), ['board', 'FD'], { asObject: true }), (e) => e.code === 'api_failed' && /нет доски/.test(e.message));
  const help = await cmdJira(ctx([]), ['board'], { asObject: true });
  assert.match(help.usage, /fsh jira board <ПРОЕКТ>/);
  await assert.rejects(() => cmdJira(ctx([]), ['board', 'FD AND 1=1'], { asObject: true }), (e) => e.code === 'usage');
});

test('jira board: спринты доски, спринт, метки и id исполнителя у задачи; доска без спринтов — пустой список', async () => {
  const issue = { key: 'FD-1', fields: {
    summary: 'С', status: { id: '1', name: 'Open' }, issuetype: { name: 'Task' }, priority: { name: 'Low' },
    assignee: { displayName: 'Я', accountId: 'acc-1' }, labels: ['ios'],
    customfield_10020: [{ id: 3, name: 'Старый', state: 'closed' }, { id: 5, name: 'Спринт 23', state: 'active' }],
    parent: { key: 'FD-0', fields: { summary: 'Эпик', issuetype: { name: 'Epic' } } },
  } };
  const searched = [];
  const ctx = (sprints) => ({
    cfg: { jira: { baseUrl: 'https://j.invalid' } },
    jira: () => ({
      boards: async () => ({ values: [{ id: 1, name: 'b' }] }),
      boardConfig: async () => ({ columnConfig: { columns: [{ name: 'To do', statuses: [{ id: '1' }] }] } }),
      allStatuses: async () => [{ id: '1', name: 'Open', statusCategory: { key: 'new' } }],
      fieldList: async () => [{ id: 'summary', name: 'Summary', schema: {} }, { id: 'customfield_10020', name: 'Sprint', schema: { custom: 'com.pyxis.greenhopper.jira:gh-sprint' } }],
      sprints,
      searchJql: async ({ fields }) => (searched.push(fields), { issues: [issue], cursor: null }),
    }),
  });
  const r = await cmdJira(ctx(async () => ({ values: [{ id: 5, name: 'Спринт 23', state: 'active', goal: 'x' }, { id: 6, name: 'Спринт 24', state: 'future' }] })), ['board', 'FD'], { asObject: true });
  assert.deepEqual(r.sprints, [{ id: 5, name: 'Спринт 23', state: 'active' }, { id: 6, name: 'Спринт 24', state: 'future' }]);
  assert.ok(searched[0].includes('customfield_10020') && searched[0].includes('labels'));
  assert.deepEqual([r.issues[0].sprint, r.issues[0].labels, r.issues[0].assignee_id], [{ id: 5, name: 'Спринт 23', state: 'active' }, ['ios'], 'acc-1']);
  assert.deepEqual(r.issues[0].parent, { key: 'FD-0', summary: 'Эпик', type: 'Epic' });

  const noSprints = async () => { throw new CliError('Jira GET /rest/agile/1.0/board/1/sprint → 400. The board does not support sprints', 1, 'api_failed'); };
  const kanban = await cmdJira(ctx(noSprints), ['board', 'FH'], { asObject: true });
  assert.deepEqual(kanban.sprints, []);
  const broken = async () => { throw new CliError('Jira GET /rest/agile/1.0/board/1/sprint → 500.', 1, 'api_failed'); };
  await assert.rejects(() => cmdJira(ctx(broken), ['board', 'FD'], { asObject: true }), /→ 500/);
});

test('jira.js: allStatuses — общий список статусов /rest/api/2/status', async () => {
  const { j, calls } = jira([{ status: 200, body: [{ id: '1', name: 'Open' }] }]);
  assert.deepEqual(await j.allStatuses(), [{ id: '1', name: 'Open' }]);
  assert.equal(calls[0].url, 'https://j.invalid/rest/api/2/status');
});

test('jira show: метки, Team, «Контент», QA, тип родителя, эпик (и через родителя подзадачи), открытый спринт', async () => {
  const names = { customfield_1: 'Team', customfield_2: 'Контент', customfield_3: 'Technical details for QA', customfield_4: 'Sprint' };
  const sub = { key: 'FD-3', names, fields: {
    summary: 'Сабтаска', status: { name: 'Open' }, issuetype: { name: 'Subtask' }, priority: { name: 'Low' },
    reporter: { displayName: 'Автор' }, labels: ['ios', 'frontend'],
    customfield_1: { id: 't1', name: 'Retention Team' }, customfield_2: 'тексты', customfield_3: 'проверить на iOS',
    customfield_4: [{ id: 3, name: 'Старый', state: 'closed' }, { id: 5, name: 'Спринт 23', state: 'active', boardId: 1 }],
    parent: { key: 'FD-2', fields: { summary: 'Задача', issuetype: { name: 'Task' } } },
  } };
  const task = { key: 'FD-2', fields: { summary: 'Задача', issuetype: { name: 'Task' }, parent: { key: 'FD-1', fields: { summary: 'Эпик оплаты', issuetype: { name: 'Epic' } } } } };
  const asked = [];
  const ctx = (byKey) => ({
    cfg: { jira: { baseUrl: 'https://j.invalid' } },
    jira: () => ({
      issue: async (key) => (asked.push(key), byKey[key]),
      comments: async () => ({ comments: [] }),
      searchJql: async () => ({ issues: [], cursor: null }),
    }),
  });
  const { issue } = await cmdJira(ctx({ 'FD-3': sub, 'FD-2': task }), ['show', 'FD-3'], { asObject: true });
  assert.deepEqual(issue.labels, ['ios', 'frontend']);
  assert.deepEqual([issue.reporter, issue.team, issue.content, issue.qa], ['Автор', 'Retention Team', 'тексты', 'проверить на iOS']);
  assert.deepEqual(issue.parent, { key: 'FD-2', summary: 'Задача', type: 'Task' });
  assert.deepEqual(issue.epic, { key: 'FD-1', summary: 'Эпик оплаты' });
  assert.deepEqual(issue.sprint, { id: 5, name: 'Спринт 23', state: 'active' });

  // Родитель — сам эпик: лишний запрос не нужен. Пустые поля — null и [].
  asked.length = 0;
  const story = { key: 'FD-4', fields: { summary: 'История', issuetype: { name: 'Story' }, parent: task.fields.parent } };
  const r = await cmdJira(ctx({ 'FD-4': story }), ['show', 'FD-4'], { asObject: true });
  assert.deepEqual(asked, ['FD-4']);
  assert.deepEqual(r.issue.epic, { key: 'FD-1', summary: 'Эпик оплаты' });
  assert.deepEqual([r.issue.labels, r.issue.team, r.issue.content, r.issue.qa, r.issue.sprint], [[], null, null, null, null]);
});

test('jira history: изменения задачи — кто, когда, поле, было → стало; длинные значения обрезаются', async () => {
  const long = 'x'.repeat(500);
  const ctx = {
    cfg: { jira: { baseUrl: 'https://j.invalid' } },
    jira: () => ({
      changelog: async (key) => (assert.equal(key, 'FD-1'), [
        { author: { displayName: 'Аня' }, created: '2026-11-01T10:00:00.000+0300', items: [{ field: 'status', fromString: 'To Do', toString: 'В работе' }] },
        { author: null, created: '2026-11-02T10:00:00.000+0300', items: [{ field: 'description', fromString: null, toString: long }] },
      ]),
    }),
  };
  const r = await cmdJira(ctx, ['history', 'FD-1'], { asObject: true });
  assert.equal(r.key, 'FD-1');
  assert.deepEqual(r.history[0], { author: 'Аня', created: '2026-11-01T10:00:00.000+0300', items: [{ field: 'status', from: 'To Do', to: 'В работе' }] });
  assert.equal(r.history[1].author, 'Jira');
  assert.equal(r.history[1].items[0].from, null);
  assert.ok(r.history[1].items[0].to.length <= 300);
  await assert.rejects(() => cmdJira(ctx, ['history', 'не-ключ'], { asObject: true }), (e) => e.code === 'usage');
});

test('jira.js: changelog — короткая история одним запросом, длинная — последние 100 записей', async () => {
  const short = jira([{ status: 200, body: { values: [{ id: '1' }], total: 1, isLast: true } }]);
  assert.deepEqual(await short.j.changelog('FD-1'), [{ id: '1' }]);
  assert.equal(short.calls.length, 1);
  assert.match(short.calls[0].url, /\/rest\/api\/2\/issue\/FD-1\/changelog\?maxResults=100$/);

  const long = jira([
    { status: 200, body: { values: [{ id: 'old' }], total: 250, isLast: false } },
    { status: 200, body: { values: [{ id: 'new' }], total: 250, isLast: true } },
  ]);
  assert.deepEqual(await long.j.changelog('FD-1'), [{ id: 'new' }]);
  assert.match(long.calls[1].url, /changelog\?startAt=150&maxResults=100$/);
});

test('jira history: нет ключа fromString/toString в изменении — null, а не метод Object.prototype', async () => {
  const ctx = {
    cfg: { jira: { baseUrl: 'https://j.invalid' } },
    jira: () => ({ changelog: async () => [{ author: null, created: 'c', items: [{ field: 'Attachment', fromString: 'a.png' }] }] }),
  };
  const r = await cmdJira(ctx, ['history', 'FD-1'], { asObject: true });
  assert.deepEqual(r.history[0].items[0], { field: 'Attachment', from: 'a.png', to: null });
});

test('jira board: эпик у карточки — родитель-эпик, у подзадачи — эпик её родителя одним доп. запросом', async () => {
  const issue = (key, type, parent) => ({ key, fields: {
    summary: key, status: { id: '1', name: 'Open' }, issuetype: { name: type }, priority: { name: 'Low' }, labels: [],
    ...(parent ? { parent } : {}),
  } });
  const epicParent = { key: 'FD-10', fields: { summary: 'Эпик', issuetype: { name: 'Epic' } } };
  const taskParent = { key: 'FD-20', fields: { summary: 'Задача', issuetype: { name: 'Task' } } };
  const orphanParent = { key: 'FD-30', fields: { summary: 'Без эпика', issuetype: { name: 'Task' } } };
  const searches = [];
  const ctx = {
    cfg: { jira: { baseUrl: 'https://j.invalid' } },
    jira: () => ({
      boards: async () => ({ values: [{ id: 1, name: 'b' }] }),
      boardConfig: async () => ({ columnConfig: { columns: [{ name: 'To do', statuses: [{ id: '1' }] }] } }),
      allStatuses: async () => [{ id: '1', name: 'Open', statusCategory: { key: 'new' } }],
      fieldList: async () => [],
      sprints: async () => ({ values: [] }),
      searchJql: async (q) => {
        searches.push(q);
        if (q.jql.startsWith('key in')) return { issues: [{ key: 'FD-20', fields: { parent: epicParent } }, { key: 'FD-30', fields: {} }], cursor: null };
        return { issues: [issue('FD-1', 'Task', epicParent), issue('FD-2', 'Subtask', taskParent), issue('FD-3', 'Subtask', taskParent), issue('FD-4', 'Subtask', orphanParent), issue('FD-5', 'Task')], cursor: null };
      },
    }),
  };
  const r = await cmdJira(ctx, ['board', 'FD'], { asObject: true });
  const epic = { key: 'FD-10', summary: 'Эпик' };
  assert.deepEqual(r.issues.map((i) => i.epic), [epic, epic, epic, null, null]);
  const lookups = searches.filter((q) => q.jql.startsWith('key in'));
  assert.equal(lookups.length, 1);
  assert.equal(lookups[0].jql, 'key in (FD-20, FD-30)');
  assert.deepEqual(lookups[0].fields, ['parent']);
});
