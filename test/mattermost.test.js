import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMattermost, reviewMessage } from '../src/mattermost.js';
import { cmdMM, resolveChannel } from '../src/commands/mm.js';

const CFG = { mattermost: { baseUrl: 'https://mm.example/', channels: { review: 'chan123' } } };

// Ответ fetch: тело JSON плюс заголовки (в логине токен приходит именно заголовком).
const res = (body, { status = 200, headers = {} } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (n) => headers[n.toLowerCase()] ?? null },
  json: async () => body,
});

test('reviewMessage: формат ровно тот, что читают в канале', () => {
  const text = reviewMessage({
    iid: 2833,
    mrUrl: 'https://gl/fitstars/fitstars-nuxt/-/merge_requests/2833',
    key: 'FD-7655',
    issueUrl: 'https://fitstars.atlassian.net/browse/FD-7655',
  });
  assert.equal(
    text,
    '• MR !2833: https://gl/fitstars/fitstars-nuxt/-/merge_requests/2833\n'
    + '• Jira FD-7655 https://fitstars.atlassian.net/browse/FD-7655',
  );
});

test('reviewMessage: без задачи остаётся одна строка, без всего — ошибка', () => {
  assert.equal(reviewMessage({ iid: 7, mrUrl: 'https://gl/mr/7' }), '• MR !7: https://gl/mr/7');
  assert.throws(() => reviewMessage({}), /Нечего отправлять/);
});

test('resolveChannel: сценарий из конфига, сырой id, пустой аргумент', () => {
  assert.deepEqual(resolveChannel(CFG, 'review'), { id: 'chan123', scenario: 'review' });
  assert.deepEqual(resolveChannel(CFG, 'abc999'), { id: 'abc999', scenario: '' });
  assert.throws(() => resolveChannel(CFG, ''), /Не задан канал/);
});

test('login: токен берётся из заголовка Token, а не из тела', async () => {
  const calls = [];
  const mm = createMattermost({
    baseUrl: 'https://mm.example',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return res({ id: 'u1', username: 'amir' }, { headers: { token: 'sess-token' } });
    },
  });
  const { token, user } = await mm.login({ loginId: 'amir', password: 'p' });
  assert.equal(token, 'sess-token');
  assert.equal(user.username, 'amir');
  assert.equal(calls[0].url, 'https://mm.example/api/v4/users/login');
  assert.equal(JSON.parse(calls[0].init.body).login_id, 'amir');
  // Логин идёт без authorization: токена ещё нет, именно за ним и пришли.
  assert.equal(calls[0].init.headers.authorization, undefined);
});

test('login: инстанс ответил 200 без заголовка Token — это ошибка, а не пустой токен', async () => {
  const mm = createMattermost({ baseUrl: 'https://mm.example', fetchImpl: async () => res({ id: 'u1' }) });
  await assert.rejects(() => mm.login({ loginId: 'a', password: 'p' }), /не отдал токен сессии/);
});

test('post: уходит channel_id, текст и Bearer', async () => {
  const calls = [];
  const mm = createMattermost({
    baseUrl: 'https://mm.example',
    token: 'sess',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return res({ id: 'post1' });
    },
  });
  const out = await mm.post('chan123', 'привет');
  assert.equal(out.id, 'post1');
  assert.equal(calls[0].url, 'https://mm.example/api/v4/posts');
  assert.equal(calls[0].init.headers.authorization, 'Bearer sess');
  assert.deepEqual(JSON.parse(calls[0].init.body), { channel_id: 'chan123', message: 'привет' });
});

test('без токена не ходим в сеть вовсе', async () => {
  const mm = createMattermost({
    baseUrl: 'https://mm.example',
    fetchImpl: async () => assert.fail('запроса быть не должно'),
  });
  await assert.rejects(() => mm.me(), /fsh mm login/);
});

test('401: говорим про протухшую сессию, а не «ошибка 401»', async () => {
  const mm = createMattermost({
    baseUrl: 'https://mm.example',
    token: 'stale',
    sleepMs: 1,
    fetchImpl: async () => res({}, { status: 401 }),
  });
  await assert.rejects(() => mm.me(), /Сессия протухает при разлогине/);
});

test('mm post --dry-run: печатает план и не ходит в сеть', async () => {
  const out = await cmdMM({ cfg: CFG }, ['post', 'review', 'текст', 'сообщения'], { asObject: true, dryRun: true });
  assert.deepEqual(out, { ok: true, dry_run: true, channel: 'chan123', scenario: 'review', text: 'текст сообщения' });
});

test('mm: незнакомая подкоманда — usage, а не падение', async () => {
  await assert.rejects(() => cmdMM({ cfg: CFG }, ['send'], { asObject: true }), /Использование: fsh mm/);
});
