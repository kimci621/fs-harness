import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createJira, ISSUE_KEY, fieldByName, fieldIdByName, fieldText, editKind, editValueFor, openSprints } from '../src/jira.js';
import { CliError } from '../src/errors.js';
import { cmdJira, MY_ISSUES_JQL, buildJql, pickTransition, pickSprint, boardOf } from '../src/commands/jira.js';

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
    key: 'FD-1', fields: { summary: 'Починить', status: { name: 'In Progress' }, issuetype: { name: 'Bug' }, priority: { name: 'High' }, updated: '2026-09-01T10:00:00.000+0300', description: 'текст', assignee: { displayName: 'Я' } },
  };
  let seenJql;
  const ctx = {
    cfg: { jira: { baseUrl: 'https://j.invalid/' } },
    jira: () => ({
      searchJql: async ({ jql }) => { seenJql = jql; return { issues: [issue], cursor: null }; },
      issue: async () => issue,
      comments: async () => ({ comments: [{ author: { displayName: 'Ревьюер' }, created: '2026-09-01T11:00:00.000+0300', body: 'вопрос' }] }),
    }),
  };
  const list = await cmdJira(ctx, [], { asObject: true });
  assert.equal(seenJql, MY_ISSUES_JQL);
  assert.deepEqual(list.issues.map((i) => i.key), ['FD-1']);

  const one = await cmdJira(ctx, ['FD-1'], { asObject: true });
  assert.equal(one.issue.url, 'https://j.invalid/browse/FD-1');
  assert.equal(one.issue.description, 'текст');
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
  await assert.rejects(
    () => cmdJira(ctxWith(j), ['field', 'FD-1', 'Labels'], { asObject: true, yes: true }),
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

test('jira.js: createIssue и deleteIssue идут в правильные пути', async () => {
  const { j, calls } = jira([{ status: 201, body: { key: 'FD-9' } }, { status: 204 }]);
  await j.createIssue({ project: { key: 'FD' }, summary: 'x' });
  await j.deleteIssue('FD-9');
  assert.equal(calls[0].url, 'https://j.invalid/rest/api/2/issue');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[1].url, 'https://j.invalid/rest/api/2/issue/FD-9');
  assert.equal(calls[1].method, 'DELETE');
});
