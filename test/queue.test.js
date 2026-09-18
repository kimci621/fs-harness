import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { queueKey, jobFromEvent, enqueue, listJobs, pruneQueue, clearQueue, jobFile } from '../src/queue.js';

const withRoot = (fn) => {
  const root = mkdtempSync(path.join(tmpdir(), 'fs-harness-queue-'));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const event = (over = {}) => ({
  id: 'e1', source: 'gitlab', kind: 'conflict', mr: 42, sha: 'abc123',
  title: 'MR', url: 'https://gl/42', detail: 'появился конфликт', level: 'срочно', ...over,
});

test('ключ идемпотентности: источник, вид, объект и sha; без sha и MR ключ всё равно собирается', () => {
  assert.equal(queueKey(event()), 'gitlab:conflict:mr42:abc123');
  assert.equal(queueKey({ kind: 'pipeline', task: 'FD-7719', sha: 'def' }), 'gitlab:pipeline:FD-7719:def');
  assert.equal(queueKey({ kind: 'mr_gone', mr: 1 }), 'gitlab:mr_gone:mr1:nosha');
  // Разный sha — разные задания: новый коммит это новая работа.
  assert.notEqual(queueKey(event()), queueKey(event({ sha: 'zzz' })));
});

test('событие → задание: вид знает своё действие, у pipeline исполнителя пока нет', () => {
  assert.equal(jobFromEvent(event()).action, 'conflict');
  assert.equal(jobFromEvent(event({ kind: 'threads' })).action, 'threads');
  assert.equal(jobFromEvent(event({ kind: 'pipeline' })).action, null);
  assert.deepEqual(
    jobFromEvent(event(), { project: 'front', repo: 'a/b' }),
    { source: 'gitlab', kind: 'conflict', project: 'front', repo: 'a/b', mr: 42, sha: 'abc123', action: 'conflict', title: 'MR', url: 'https://gl/42', detail: 'появился конфликт', level: 'срочно' },
  );
});

test('очередь: повтор того же события не плодит задание, протухшее — плодит', () => withRoot((root) => {
  const now = Date.parse('2026-09-17T10:00:00Z');
  const job = jobFromEvent(event(), { project: 'front', repo: 'a/b' });

  const first = enqueue(job, { root, now, ttlSeconds: 60 });
  assert.equal(first.added, true);
  assert.equal(enqueue(job, { root, now: now + 59_000, ttlSeconds: 60 }).added, false);
  assert.equal(listJobs({ root, now: now + 59_000 }).length, 1);

  // TTL вышел — то же событие снова становится заданием.
  assert.equal(listJobs({ root, now: now + 61_000 }).length, 0);
  assert.equal(enqueue(job, { root, now: now + 61_000, ttlSeconds: 60 }).added, true);

  // Другой MR — другое задание, а не дубль.
  assert.equal(enqueue(jobFromEvent(event({ mr: 7 })), { root, now: now + 61_000, ttlSeconds: 60 }).added, true);
  assert.equal(listJobs({ root, now: now + 61_000 }).length, 2);
}));

test('очередь: уборка протухших и полная очистка', () => withRoot((root) => {
  const now = Date.now();
  enqueue(jobFromEvent(event()), { root, now, ttlSeconds: 60 });
  enqueue(jobFromEvent(event({ mr: 2 })), { root, now, ttlSeconds: 3600 });

  assert.equal(pruneQueue({ root, now: now + 61_000 }).length, 1);
  assert.equal(readdirSync(root).length, 1);
  assert.equal(clearQueue({ root }).length, 1);
  assert.deepEqual(listJobs({ root }), []);
}));

test('имя файла задания не уезжает в подкаталоги', () => {
  assert.equal(path.basename(jobFile('gitlab:conflict:mr42:abc', '/tmp/q')), 'gitlab_conflict_mr42_abc.json');
  assert.equal(path.dirname(jobFile('a/b:c', '/tmp/q')), '/tmp/q');
});
