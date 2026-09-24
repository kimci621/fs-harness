import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { enqueue, listJobs } from '../src/queue.js';
import { takeJob, runWorker, JOB_MAX_ATTEMPTS } from '../src/worker.js';

let tempDir;
let queueRoot;
let locksRoot;

before(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'fs-harness-worker-'));
  queueRoot = path.join(tempDir, 'queue');
  locksRoot = path.join(tempDir, 'locks');
});

after(() => rmSync(tempDir, { recursive: true, force: true }));

test('takeJob: берёт задание с непустым action и захватывает лок', () => {
  const job = {
    source: 'gitlab',
    kind: 'conflict',
    repo: 'my/repo',
    mr: 10,
    sha: 's1',
    action: 'conflict',
    title: 'test',
  };
  enqueue(job, { root: queueRoot });

  const taken = takeJob({ queueRoot, locksRoot });
  assert.ok(taken);
  assert.equal(taken.job.mr, 10);
  assert.equal(typeof taken.release, 'function');

  // Повторный takeJob на тот же лок возвращает null (лок занят)
  const second = takeJob({ queueRoot, locksRoot });
  assert.equal(second, null);

  taken.release();
});

test('runWorker: параллельное выполнение и сериализация по локу MR', async () => {
  const qRoot = path.join(tempDir, 'q1');
  const lRoot = path.join(tempDir, 'l1');

  // Job 1: MR 1
  enqueue(
    { source: 'gitlab', kind: 'conflict', repo: 'my/repo', mr: 1, sha: 'sha1', action: 'conflict' },
    { root: qRoot },
  );
  // Job 2: MR 2
  enqueue(
    { source: 'gitlab', kind: 'conflict', repo: 'my/repo', mr: 2, sha: 'sha2', action: 'conflict' },
    { root: qRoot },
  );
  // Job 3: MR 1 (тот же MR, что у Job 1!)
  enqueue(
    { source: 'gitlab', kind: 'threads', repo: 'my/repo', mr: 1, sha: 'sha3', action: 'threads' },
    { root: qRoot },
  );

  let resolve1, resolve2, resolve3;
  const p1 = new Promise((r) => { resolve1 = r; });
  const p2 = new Promise((r) => { resolve2 = r; });
  const p3 = new Promise((r) => { resolve3 = r; });

  const started = [];
  const mockRunAction = async (spec, ctx, args) => {
    const target = args[0];
    if (spec.name === 'conflict' && target === '1') {
      started.push('job1');
      return p1;
    }
    if (spec.name === 'conflict' && target === '2') {
      started.push('job2');
      return p2;
    }
    if (spec.name === 'threads' && target === '1') {
      started.push('job3');
      return p3;
    }
  };

  const fakeActions = [
    { name: 'conflict', action: {} },
    { name: 'threads', action: {} },
  ];

  const workerPromise = runWorker({
    queueRoot: qRoot,
    locksRoot: lRoot,
    concurrency: 2,
    once: true,
    log: () => {},
    deps: {
      runAction: mockRunAction,
      actions: fakeActions,
      ctx: { repo: 'my/repo' },
    },
  });

  // Даём микро-тикеру время взять задания
  await new Promise((r) => setTimeout(r, 30));

  // Job 1 и Job 2 запустились параллельно, Job 3 ждёт лок MR 1
  assert.ok(started.includes('job1'), 'job1 стартовал');
  assert.ok(started.includes('job2'), 'job2 стартовал');
  assert.equal(started.includes('job3'), false, 'job3 ожидает освобождения лока MR 1');

  // Завершаем Job 1, освобождая лок MR 1
  resolve1();
  await new Promise((r) => setTimeout(r, 30));

  // Теперь Job 3 должен был стартовать
  assert.ok(started.includes('job3'), 'job3 стартовал после освобождения лока MR 1');

  // Завершаем остальные
  resolve2();
  resolve3();

  await workerPromise;

  // Все задания завершены и удалены из очереди
  const remaining = listJobs({ root: qRoot });
  assert.equal(remaining.length, 0);
});

test('runWorker: задание с action: null пропускается', async () => {
  const qRoot = path.join(tempDir, 'q2');
  const lRoot = path.join(tempDir, 'l2');

  enqueue(
    { source: 'gitlab', kind: 'pipeline', repo: 'my/repo', mr: 5, sha: 'sha5', action: null },
    { root: qRoot },
  );

  let ran = false;
  await runWorker({
    queueRoot: qRoot,
    locksRoot: lRoot,
    concurrency: 2,
    once: true,
    log: () => {},
    deps: {
      runAction: async () => { ran = true; },
      actions: [],
      ctx: { repo: 'my/repo' },
    },
  });

  assert.equal(ran, false);
  const remaining = listJobs({ root: qRoot });
  assert.equal(remaining.length, 1, 'Задание с action:null осталось в очереди');
});

test('runWorker: attempts растёт при ошибках, после 3 попыток задание снимается', async () => {
  const qRoot = path.join(tempDir, 'q3');
  const lRoot = path.join(tempDir, 'l3');

  enqueue(
    { source: 'gitlab', kind: 'conflict', repo: 'my/repo', mr: 9, sha: 'sha9', action: 'conflict' },
    { root: qRoot },
  );

  const fakeActions = [{ name: 'conflict', action: {} }];
  const failingAction = async () => {
    throw new Error('boom');
  };

  // Попытка 1
  await runWorker({
    queueRoot: qRoot,
    locksRoot: lRoot,
    concurrency: 1,
    once: true,
    log: () => {},
    deps: { runAction: failingAction, actions: fakeActions, ctx: { repo: 'my/repo' } },
  });
  let jobs = listJobs({ root: qRoot });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].attempts, 1);

  // Попытка 2
  await runWorker({
    queueRoot: qRoot,
    locksRoot: lRoot,
    concurrency: 1,
    once: true,
    log: () => {},
    deps: { runAction: failingAction, actions: fakeActions, ctx: { repo: 'my/repo' } },
  });
  jobs = listJobs({ root: qRoot });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].attempts, 2);

  // Попытка 3 -> удаляется
  await runWorker({
    queueRoot: qRoot,
    locksRoot: lRoot,
    concurrency: 1,
    once: true,
    log: () => {},
    deps: { runAction: failingAction, actions: fakeActions, ctx: { repo: 'my/repo' } },
  });
  jobs = listJobs({ root: qRoot });
  assert.equal(jobs.length, 0, 'Снято после 3 попыток');
});

test('runWorker: слушатель signal удаляется при завершении воркера (нет утечки)', async () => {
  const qRoot = path.join(tempDir, 'q4');
  const lRoot = path.join(tempDir, 'l4');
  const ctrl = new AbortController();

  await runWorker({
    queueRoot: qRoot,
    locksRoot: lRoot,
    concurrency: 1,
    once: true,
    signal: ctrl.signal,
    log: () => {},
    deps: { actions: [], ctx: { repo: 'my/repo' } },
  });

  const { getEventListeners } = await import('node:events');
  const listeners = getEventListeners(ctrl.signal, 'abort');
  assert.equal(listeners.length, 0, 'слушатель abort должен быть удален');
});

