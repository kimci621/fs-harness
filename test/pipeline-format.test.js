import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findJob, deployJobName, mapLimit } from '../src/pipeline.js';
import { commentStats, fmtComments, fmtMRRow, humanize } from '../src/format.js';
import { CliError } from '../src/errors.js';

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
