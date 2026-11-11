import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cmdWait, checkWaits, makeWait, readWaits, runWaits, writeWaits, today } from '../src/waits.js';

const POST = 'abcdefghijklmnopqrstuvwxyz';
const T0 = Date.parse('2026-11-11T09:00:00');

const mmFake = (posts) => ({
  me: async () => ({ id: 'me' }),
  thread: async () => ({ posts: Object.fromEntries(posts.map((p, i) => [`p${i}`, p])) }),
  usersByIds: async (ids) => ids.map((id) => ({ id, username: id === 'u1' ? 'g.rekunov' : id })),
});
const jiraFake = (comments) => ({ myself: async () => ({ accountId: 'me' }), comments: async () => ({ comments }) });

test('wait: add/list/rm через файл, ключ Jira и permalink разбираются, мусор — usage', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fsh-wait-'));
  const file = path.join(dir, 'waits.json');
  const ctx = { cfg: { activeProject: 'front' } };
  const { added } = await cmdWait(ctx, ['add', 'mm', `https://mm/team/pl/${POST}`], { from: 'rekunov' }, { file, now: T0 });
  assert.equal(added.target, POST);
  assert.equal(added.day, today(T0));
  await cmdWait(ctx, ['add', 'jira', 'fd-8835'], {}, { file, now: T0 });
  assert.deepEqual(readWaits(file).map((w) => w.target), [POST, 'FD-8835']);
  await cmdWait(ctx, ['rm', added.id], {}, { file });
  assert.deepEqual(readWaits(file).map((w) => w.target), ['FD-8835']);
  assert.throws(() => makeWait('jira', 'не-ключ'), { code: 'usage' });
  rmSync(dir, { recursive: true, force: true });
});

test('wait: ответ не от меня после since — уведомление и снятие; мой ответ и старый — нет', async () => {
  const mm = makeWait('mm', POST, { now: T0 });
  const jira = makeWait('jira', 'FD-1', { now: T0, from: 'Гриша' });
  const sent = [];
  const clients = {
    mm: mmFake([
      { user_id: 'u1', create_at: T0 - 1, message: 'старое' },
      { user_id: 'me', create_at: T0 + 1, message: 'моё' },
      { user_id: 'u1', create_at: T0 + 2, message: 'ответ' },
    ]),
    jira: jiraFake([{ created: new Date(T0 + 5).toISOString(), author: { accountId: 'x', displayName: 'Даша' }, body: 'не тот' }]),
  };
  const { keep, done } = await checkWaits([mm, jira], { clientsFor: () => clients, notify: async (w, r) => sent.push([w.kind, r.author, r.text]), now: T0 + 10 });
  assert.deepEqual(sent, [['mm', 'g.rekunov', 'ответ']]);
  assert.deepEqual(done.map((w) => w.id), [mm.id]);
  // --from Гриша: ответ Даши не считается, пункт остаётся.
  assert.deepEqual(keep.map((w) => w.id), [jira.id]);
});

test('wait: день сменился — снят без сети; проверка упала — пункт остаётся', async () => {
  const old = makeWait('jira', 'FD-1', { now: T0 });
  const broken = makeWait('jira', 'FD-2', { now: T0 + 1 });
  const tomorrow = T0 + 24 * 3600_000;
  const touched = [];
  const r1 = await checkWaits([old], { clientsFor: (w) => { touched.push(w.id); return {}; }, notify: async () => {}, now: tomorrow });
  assert.deepEqual([r1.keep, r1.done, touched], [[], [], []]);
  const r2 = await checkWaits([broken], { clientsFor: () => ({ jira: { myself: async () => { throw new Error('401'); } } }), notify: async () => {}, now: T0 + 2 });
  assert.deepEqual(r2.keep.map((w) => w.id), [broken.id]);
});

test('wait: runWaits на пустом файле ничего не грузит, отвеченный пункт стирает из файла', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fsh-wait-'));
  const file = path.join(dir, 'waits.json');
  const loadCfg = () => assert.fail('пустой файл — конфиг не нужен');
  assert.deepEqual(await runWaits({ loadCfg, env: {}, makeCtx: () => ({}), file }), { keep: [], done: [] });

  const w = makeWait('jira', 'FD-3', { now: T0 });
  writeWaits([w], file);
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push(JSON.parse(init.body).text); return { ok: true, json: async () => ({ ok: true, result: {} }) }; };
  await runWaits({
    loadCfg: () => ({ telegram: { chat_id: '1', bot_token: 't' } }),
    env: {},
    makeCtx: () => ({ jira: () => jiraFake([{ created: new Date(T0 + 1).toISOString(), author: { accountId: 'x', displayName: 'Даша' }, body: 'готово' }]) }),
    file,
    now: T0 + 2,
    fetchImpl,
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /FD-3 от Даша:\nготово/);
  assert.deepEqual(readWaits(file), []);
  rmSync(dir, { recursive: true, force: true });
});
