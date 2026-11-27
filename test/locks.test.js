import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { acquireLock, releaseLock, listLocks, lockKey, gcLocks, runSingle } from '../src/locks.js';

let root;

before(() => {
  root = mkdtempSync(path.join(tmpdir(), 'fs-harness-locks-'));
});

after(() => rmSync(root, { recursive: true, force: true }));

test('locks: ключ нормализуется', () => {
  assert.equal(lockKey({ repo: 'group/repo', mr: 42 }), 'group_repo_mr42');
  assert.equal(lockKey({ repo: 'group/repo', branch: 'feature/foo' }), 'group_repo_feature_foo');
  assert.equal(lockKey('custom:key'), 'custom_key');
});

test('locks: второй acquire на тот же ключ отклонён, release освобождает', () => {
  const key = 'test:first';
  const lock1 = acquireLock({ root, key, pid: process.pid });
  assert.equal(lock1.acquired, true);

  // Второй acquire тем же или другим pid не проходит
  const lock2 = acquireLock({ root, key, pid: process.pid + 1 });
  assert.equal(lock2.acquired, false);
  assert.equal(lock2.holder.pid, process.pid);

  // release освобождает
  const released = lock1.release();
  assert.equal(released, true);

  // Теперь можно захватить снова
  const lock3 = acquireLock({ root, key, pid: process.pid + 1 });
  assert.equal(lock3.acquired, true);
  lock3.release();
});

test('locks: чужой живой pid не отдаёт лок', () => {
  const key = 'test:alive';
  // process.pid живой
  const lock1 = acquireLock({ root, key, pid: process.pid });
  assert.equal(lock1.acquired, true);

  const lock2 = acquireLock({ root, key, pid: process.pid + 10 });
  assert.equal(lock2.acquired, false);
  assert.equal(lock2.holder.pid, process.pid);

  lock1.release();
});

test('locks: мёртвый pid перехватывается', () => {
  const key = 'test:dead';
  // PID 99999999 заведомо не существует
  const deadPid = 99999999;
  const lock1 = acquireLock({ root, key, pid: deadPid });
  assert.equal(lock1.acquired, true);

  // Новый процесс видит, что pid мёртв, и перехватывает
  const lock2 = acquireLock({ root, key, pid: process.pid });
  assert.equal(lock2.acquired, true);
  assert.equal(lock2.holder, undefined);

  lock2.release();
});

test('locks: протухший лок перехватывается по mtime', () => {
  const key = 'test:stale';
  const now = Date.now();
  const lock1 = acquireLock({ root, key, pid: process.pid, now });
  assert.equal(lock1.acquired, true);

  // Искусственно старим файл на 1 час назад
  const oneHourAgo = (now - 3600_000) / 1000;
  utimesSync(lock1.file, oneHourAgo, oneHourAgo);

  // Захват с проверкой staleMs = 30 мин
  const lock2 = acquireLock({ root, key, pid: process.pid, now, staleMs: 30 * 60 * 1000 });
  assert.equal(lock2.acquired, true);

  lock2.release();
});

test('locks: listLocks возвращает список локов с флагом stale', () => {
  const key = 'test:list';
  const lock = acquireLock({ root, key, pid: process.pid });
  assert.equal(lock.acquired, true);

  const list = listLocks({ root });
  assert.ok(list.length >= 1);
  const found = list.find((l) => l.key === 'test_list');
  assert.ok(found);
  assert.equal(found.pid, process.pid);
  assert.equal(found.alive, true);
  assert.equal(found.stale, false);

  lock.release();
});

test('gcLocks: убирает локи мёртвых процессов, живые не трогает', () => {
  const gcRoot = mkdtempSync(path.join(tmpdir(), 'fs-harness-locks-gc-'));
  try {
    const dead = acquireLock({ root: gcRoot, key: 'gc:dead', pid: 99999999 });
    const alive = acquireLock({ root: gcRoot, key: 'gc:alive', pid: process.pid });

    const removed = gcLocks({ root: gcRoot });

    assert.deepEqual(removed.map((l) => l.key), ['gc_dead']);
    assert.equal(existsSync(dead.file), false, 'лок мёртвого pid удалён');
    assert.equal(existsSync(alive.file), true, 'лок живого pid остался');
  } finally {
    rmSync(gcRoot, { recursive: true, force: true });
  }
});

test('runSingle: второй экземпляр той же команды не стартует, после первого - стартует', async () => {
  let done;
  const first = runSingle('bot', () => new Promise((r) => { done = r; }), { root });
  await assert.rejects(runSingle('bot', async () => 'второй', { root }), { code: 'already_running' });
  // Другая команда своим локом не мешает
  assert.equal(await runSingle('qa-bot', async () => 'ok', { root }), 'ok');
  done('первый');
  assert.equal(await first, 'первый');
  assert.equal(await runSingle('bot', async () => 'снова', { root }), 'снова');
});

test('runSingle: лок мёртвого процесса без срока давности перехватывается', async () => {
  acquireLock({ root, key: 'daemon-watch', pid: 999999 });
  assert.equal(await runSingle('watch', async () => 'ok', { root }), 'ok');
});
