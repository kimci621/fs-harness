import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGlab } from '../src/glab.js';
import { CliError } from '../src/errors.js';

// Мок: перехватывает вызовы и отдаёт ответы по порядку.
function fakeRun(responses) {
  const calls = [];
  const run = (bin, args) => {
    calls.push({ bin, args });
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
