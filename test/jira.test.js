import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJira, ISSUE_KEY } from '../src/jira.js';
import { CliError } from '../src/errors.js';
import { cmdJira, MY_ISSUES_JQL } from '../src/commands/jira.js';

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
  assert.match(calls[0].url, /\/rest\/api\/2\/issue\/FD-1\?expand=renderedFields$/);
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
