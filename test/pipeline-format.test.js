import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findJob, deployJobName, mapLimit, startJob, jobAction } from '../src/pipeline.js';
import { cmdDeploy } from '../src/commands/deploy.js';
import { buildMRParams, applyLocalFilters, anyFilter } from '../src/commands/mrs.js';
import { commentStats, fmtComments, fmtMRRow, humanize } from '../src/format.js';
import { CliError } from '../src/errors.js';
import { formatErrorJSON, makeLogger } from '../src/output.js';
import { waitJob } from '../src/ui.js';

const JOBS = [
  { id: 1, name: 'build_image', stage: 'build', status: 'manual' },
  { id: 2, name: 'deploy_dev', stage: 'deploy_dev', status: 'manual' },
  { id: 3, name: 'deploy_dev2', stage: 'deploy_dev', status: 'manual' },
  { id: 4, name: 'deploy_dev10', stage: 'deploy_dev', status: 'manual' },
];

test('findJob: точное имя и по id', () => {
  assert.equal(findJob(JOBS, 'deploy_dev2').id, 3);
  assert.equal(findJob(JOBS, '4').name, 'deploy_dev10');
});

test('findJob: единственное contains-совпадение', () => {
  assert.equal(findJob(JOBS, 'build').id, 1);
});

test('findJob: неоднозначно → ошибка со списком', () => {
  assert.throws(() => findJob(JOBS, 'deploy'), (e) => e instanceof CliError && /нескольким/.test(e.message));
});

test('findJob: отсутствует → null', () => {
  assert.equal(findJob(JOBS, 'missing_job'), null);
});

test('deployJobName: дефолт и N', () => {
  assert.equal(deployJobName(), 'deploy_dev');
  assert.equal(deployJobName(1), 'deploy_dev');
  assert.equal(deployJobName(2), 'deploy_dev2');
  assert.equal(deployJobName(10), 'deploy_dev10');
});

test('commentStats: считает треды', () => {
  const stats = commentStats([
    { resolvable: true, resolved: false },
    { resolvable: true, resolved: true },
    { resolvable: false },
  ], 7);
  assert.deepEqual(stats, { total: 7, open: 1, resolved: 1 });
  assert.equal(fmtComments(stats), '💬 7 · открыто 1 · решено 1');
});

test('fmtMRRow: показывает конфликт и пайплайн', () => {
  const mr = {
    iid: 2547, title: 'T', draft: true, source_branch: 'feature/x', target_branch: 'dev',
    has_conflicts: true, head_pipeline: { id: 1, status: 'manual' },
  };
  const row = fmtMRRow(mr, commentStats(null, 3), 160);
  assert.match(row, /! *2547/);
  assert.match(row, /D /);
  assert.match(row, /feature\/x → dev/);
  assert.match(row, /⏸ manual/);
  assert.match(row, /⚠ да/);
});

test('humanize: относительное время', () => {
  assert.equal(humanize(new Date().toISOString()), 'только что');
  assert.equal(humanize(new Date(Date.now() - 5 * 60_000).toISOString()), '5 мин назад');
  assert.equal(humanize(null), '—');
});

test('mapLimit: конкурентность и порядок', async () => {
  let active = 0;
  let maxActive = 0;
  const out = await mapLimit([1, 2, 3, 4, 5], 2, async (x) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 10));
    active--;
    return x * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10]);
  assert.ok(maxActive <= 2);
});

test('startJob: manual → play (тот же id), failed → retry (новый id), success → null, force → retry', async () => {
  const calls = [];
  const g = {
    playJob: async (_r, jid) => { calls.push(['play', jid]); return { id: jid, status: 'pending' }; },
    retryJob: async (_r, jid) => { calls.push(['retry', jid]); return { id: jid + 100, status: 'pending' }; },
  };
  assert.deepEqual(await startJob(g, 'r', { id: 1, status: 'manual' }), { id: 1, status: 'pending' });
  assert.deepEqual(await startJob(g, 'r', { id: 2, status: 'failed' }), { id: 102, status: 'pending' });
  assert.equal(await startJob(g, 'r', { id: 3, status: 'success' }), null);
  assert.deepEqual(await startJob(g, 'r', { id: 4, status: 'success' }, { force: true }), { id: 104, status: 'pending' });
  assert.deepEqual(calls, [['play', 1], ['retry', 2], ['retry', 4]]);
});

test('jobAction: play/retry/skip и force', () => {
  assert.equal(jobAction('manual').action, 'play');
  assert.equal(jobAction('failed').action, 'retry');
  assert.equal(jobAction('canceled').action, 'retry');
  assert.equal(jobAction('success').action, 'skip');
  assert.equal(jobAction('success', { force: true }).action, 'retry');
  assert.equal(jobAction('success', { force: true }).reason, 'force');
});

test('formatErrorJSON: {ok:false, error:{code,message}}', () => {
  const out = JSON.parse(formatErrorJSON(new CliError('плохо', 1, 'job_failed')));
  assert.equal(out.ok, false);
  assert.deepEqual(out.error, { code: 'job_failed', message: 'плохо' });
});

test('formatErrorJSON: упавший ран отдаёт run и run_dir, обычная ошибка — нет', () => {
  const err = new CliError('агент упал', 1, 'agent_failed');
  err.run = 'conflict-abc-1a2b';
  err.runDir = '/tmp/runs/conflict-abc-1a2b';
  const out = JSON.parse(formatErrorJSON(err));
  assert.equal(out.error.run, 'conflict-abc-1a2b');
  assert.equal(out.error.run_dir, '/tmp/runs/conflict-abc-1a2b');
  const plain = JSON.parse(formatErrorJSON(new CliError('плохо', 1, 'job_failed')));
  assert.equal(plain.error.run, undefined);
});

test('makeLogger: json-режим пишет в stderr', () => {
  let out = '';
  let err = '';
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  process.stdout.write = (s) => { out += s; return true; };
  process.stderr.write = (s) => { err += s; return true; };
  try {
    makeLogger(true)('привет');
    makeLogger(false)('пока');
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  assert.equal(out, 'пока\n');
  assert.equal(err, 'привет\n');
});

test('cmdDeploy: buildJob null → дефолт build_image', async () => {
  const calls = [];
  const g = {
    getMR: async () => ({ iid: 1, sha: 'abc', source_branch: 'feature/x', target_branch: 'dev', head_pipeline: { id: 9, sha: 'abc' } }),
    listOpenMRs: async () => [],
    getJobs: async (_r, pid) => {
      calls.push(['getJobs', pid]);
      if (calls.filter((c) => c[0] === 'getJobs').length === 1) {
        return [
          { id: 1, name: 'build_image', stage: 'build', status: 'success' },
          { id: 2, name: 'deploy_dev2', stage: 'deploy_dev', status: 'success' },
        ];
      }
      return [
        { id: 1, name: 'build_image', stage: 'build', status: 'success' },
        { id: 2, name: 'deploy_dev2', stage: 'deploy_dev', status: 'success' },
      ];
    },
    playJob: async (_r, jid) => { calls.push(['play', jid]); return { status: 'pending' }; },
  };
  // buildJob явно null (так приходит из parseArgs) — должен отработать дефолт.
  await cmdDeploy(g, 'r/repo', ['1', '2'], { buildJob: null, intervalMs: 1 });
  assert.ok(calls.some((c) => c[0] === 'getJobs'));
});

test('waitJob: терминальный статус возвращает джобу, таймаут — CliError с кодом', async () => {
  const job = (status) => ({ id: 9, name: 'build_image', stage: 'build', status });
  const ticks = [];
  const ok = await waitJob({
    g: { getJobs: async () => [job('success')], getJob: async () => job('success') },
    repo: 'r/repo', pipelineId: 1, jobId: 9, intervalMs: 1, quiet: true,
    label: 'build', onTick: (t) => ticks.push(t),
  });
  assert.equal(ok.status, 'success');
  assert.deepEqual(ticks, ['build: success']);

  await assert.rejects(
    () => waitJob({
      g: { getJobs: async () => [job('running')], getJob: async () => job('running') },
      repo: 'r/repo', pipelineId: 1, jobId: 9, intervalMs: 1, timeoutMs: 0, quiet: true, label: 'build',
    }),
    (e) => e instanceof CliError && e.code === 'job_timeout',
  );
});

test('waitJob: джоба, ставшая manual после created, играется сама, а не ждётся час', async () => {
  // Сценарий свежего push: стадия tests ещё идёт, build-джоба — created; только потом manual.
  const seq = ['created', 'manual', 'success'];
  let i = 0;
  const job = () => ({ id: 9, name: 'build_image', stage: 'build', status: seq[Math.min(i++, seq.length - 1)] });
  const played = [];
  const final = await waitJob({
    g: { getJobs: async () => [job()], getJob: async () => job() },
    repo: 'r/repo', pipelineId: 1, jobId: 9, intervalMs: 1, quiet: true, label: 'build',
    onManual: async (j) => { played.push(j.status); return { id: j.id, status: 'pending' }; },
  });
  assert.equal(final.status, 'success');
  assert.deepEqual(played, ['manual'], 'manual-джоба должна играться ровно один раз');
});

test('waitJob: retry вернул новый id — дальше следим за новой джобой', async () => {
  let polls = 0;
  const g = {
    getJobs: async () => {
      polls += 1;
      if (polls === 1) return [{ id: 9, name: 'deploy_dev', stage: 'deploy', status: 'manual' }];
      return [{ id: 10, name: 'deploy_dev', stage: 'deploy', status: 'success' }];
    },
    getJob: async (_repo, id) => ({ id, name: 'deploy_dev', status: 'success' }),
  };
  const final = await waitJob({
    g, repo: 'r/repo', pipelineId: 1, jobId: 9, intervalMs: 1, quiet: true, label: 'deploy',
    onManual: async () => ({ id: 10, status: 'running' }),
  });
  assert.equal(final.id, 10);
  assert.equal(final.status, 'success');
});

test('mrs: фильтры делятся на серверные и клиентские, me резолвится в ник', async () => {
  const params = await buildMRParams({ me: async () => ({ username: 'a.latipov' }) }, {
    author: 'me', reviewer: 'petya', target: 'dev', draft: false, label: 'ui',
  });
  assert.equal(params.author_username, 'a.latipov');
  assert.equal(params.reviewer_username, 'petya');
  assert.equal(params.target_branch, 'dev');
  assert.equal(params.labels, 'ui');
  assert.equal(params.wip, 'no');
  assert.equal(params.assignee_username, undefined);
  assert.equal((await buildMRParams({}, {})).wip, null);

  const rows = [
    { mr: { iid: 1, has_conflicts: true, head_pipeline: { status: 'failed' } }, stats: { open: 0 } },
    { mr: { iid: 2, has_conflicts: false, head_pipeline: { status: 'success' } }, stats: { open: 3 } },
    { mr: { iid: 3, has_conflicts: false, head_pipeline: null }, stats: { open: 1 } },
  ];
  const iids = (f) => applyLocalFilters(rows, f).map((r) => r.mr.iid);
  assert.deepEqual(iids({ conflicts: true }), [1]);
  assert.deepEqual(iids({ threads: true }), [2, 3]);
  assert.deepEqual(iids({ pipeline: 'failed' }), [1]);
  assert.deepEqual(iids({ pipeline: 'none' }), [3]);
  assert.deepEqual(iids({}), [1, 2, 3]);

  assert.equal(anyFilter({ json: true, repo: 'r/r' }), false);
  assert.equal(anyFilter({ pipeline: 'failed' }), true);
});
