import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGlab, defaultRun } from '../src/glab.js';
import { CliError } from '../src/errors.js';

// Мок: перехватывает вызовы и отдаёт ответы по порядку.
function fakeRun(responses) {
  const calls = [];
  const run = (bin, args, opts = {}) => {
    calls.push({ bin, args, opts });
    const r = responses.shift();
    if (r instanceof Error) {
      const err = new Error('exit 1');
      err.stderr = r.message;
      throw err;
    }
    return JSON.stringify(r);
  };
  return { run, calls };
}

// fakeRun + готовый g: в новых тестах нужен именно так.
function fake(responses) {
  const { run, calls } = fakeRun(responses);
  return { g: createGlab(run, { sleepMs: 0 }), calls };
}

test('api: кодирует repo и строит URL', () => {
  const { run, calls } = fakeRun([[]]);
  const g = createGlab(run);
  g.listOpenMRs('fitstars/fitstars-nuxt');
  assert.equal(calls[0].bin, 'glab');
  assert.equal(calls[0].args[0], 'api');
  assert.equal(calls[0].args[1], 'projects/fitstars%2Ffitstars-nuxt/merge_requests?state=opened&per_page=100&order_by=updated_at&sort=desc');
});

test('api: POST добавляет -X POST', () => {
  const { run, calls } = fakeRun([{ id: 1, status: 'pending' }]);
  const g = createGlab(run);
  g.playJob('r/repo', 42);
  assert.deepEqual(calls[0].args, ['api', 'projects/r%2Frepo/jobs/42/play', '-X', 'POST']);
});

test('api: ошибка glab превращается в CliError с подсказкой', async () => {
  const errors = Array.from({ length: 5 }, () => new Error('404 Not Found'));
  const { run } = fakeRun(errors);
  const g = createGlab(run, { sleepMs: 1 });
  await assert.rejects(() => g.getMR('r/repo', 1), (e) => e instanceof CliError && /404/.test(e.message));
});

test('api: retry при флапе — второй ответ побеждает', async () => {
  const { run, calls } = fakeRun([new Error('flaky'), [{ iid: 1 }]]);
  const g = createGlab(run, { sleepMs: 1 });
  const mrs = await g.listOpenMRs('r/repo');
  assert.equal(mrs.length, 1);
  assert.equal(calls.length, 2);
});

test('api: input прокидывается в run — тело запроса уходит в stdin', async () => {
  const { run, calls } = fakeRun([{ id: 'n1' }]);
  const g = createGlab(run);
  await g.api('r/repo', '/merge_requests/1/discussions/abc/notes', { method: 'POST', input: '{"body":"многострочный\nmarkdown"}' });
  assert.equal(calls[0].opts.input, '{"body":"многострочный\nmarkdown"}');
});

test('defaultRun: input доезжает до stdin процесса', () => {
  assert.equal(defaultRun('cat', [], { input: 'первая\nвторая\n' }), 'первая\nвторая\n');
});

test('defaultRun: без input stdin закрыт и процесс не виснет', () => {
  assert.equal(defaultRun('cat', []), '');
});

test('api: input добавляет --input - в аргументы glab', async () => {
  const { g, calls } = fake([{}]);
  await g.api('r/repo', '/x', { method: 'POST', input: '{"body":"текст"}' });
  assert.ok(calls[0].args.includes('--input'), '--input в аргументах');
  assert.equal(calls[0].args[calls[0].args.indexOf('--input') + 1], '-');
  const plain = fake([{}]);
  await plain.g.api('r/repo', '/x');
  assert.equal(plain.calls[0].args.includes('--input'), false);
});

test('replyDiscussion: read-back ловит потерянный ответ', async () => {
  const ok = fake([{ id: 42 }, { notes: [{ id: 42, body: 'ответ' }] }]);
  assert.equal((await ok.g.replyDiscussion('r/repo', 1, 'abc', 'ответ')).id, 42);
  assert.equal(ok.calls[0].opts.input, JSON.stringify({ body: 'ответ' }));

  const lost = fake([{ id: 42 }, { notes: [] }]);
  await assert.rejects(
    () => lost.g.replyDiscussion('r/repo', 1, 'abc', 'ответ'),
    (e) => e.code === 'api_failed' && /перечитыван/.test(e.message),
  );
});

test('resolveDiscussion: резолв идёт query-параметром, а результат перечитывается', async () => {
  const ok = fake([{}, { notes: [{ id: 1, resolved: true }, { id: 2, system: true }] }]);
  await ok.g.resolveDiscussion('r/repo', 1, 'abc');
  assert.ok(ok.calls[0].args.some((a) => a.endsWith('/discussions/abc?resolved=true')), 'resolved в query');
  assert.ok(ok.calls[0].args.includes('PUT'));

  const noop = fake([{}, { notes: [{ id: 1, resolved: false }] }]);
  await assert.rejects(
    () => noop.g.resolveDiscussion('r/repo', 1, 'abc'),
    (e) => e.code === 'api_failed' && /всё ещё открыт/.test(e.message),
  );
});

test('api: фильтры MR уходят в query, пустые значения не уходят', () => {
  const { run, calls } = fakeRun([[]]);
  const g = createGlab(run);
  g.listOpenMRs('r/repo', { author_username: 'a.latipov', target_branch: 'dev', labels: null, search: '' });
  const url = calls[0].args[1];
  assert.match(url, /author_username=a.latipov/);
  assert.match(url, /target_branch=dev/);
  assert.doesNotMatch(url, /labels|search/);
});

test('api: /user идёт мимо projects/', () => {
  const { run, calls } = fakeRun([{ username: 'a.latipov' }]);
  createGlab(run).me();
  assert.equal(calls[0].args[1], 'user');
});
