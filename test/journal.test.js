import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRun, saveArtifact, appendEvent, readEvents, listRuns, pruneRuns, sweepExpiredApprovals, patchRunMeta, setRunState, pidAlive, runIsActive, MAX_ARCHIVES } from '../src/agent/journal.js';

const root = mkdtempSync(path.join(tmpdir(), 'fs-harness-journal-'));
process.on('exit', () => rmSync(root, { recursive: true, force: true }));

test('events.jsonl: строка на событие, дельты судьи не пишутся', () => {
  const run = createRun('conflict', { root });
  appendEvent(run, { t: 'phase', phase: 'isolate', status: 'start' });
  appendEvent(run, { t: 'delta', text: 'дум' });
  appendEvent(run, { t: 'log', stream: 'stdout', text: 'привет' });
  const events = readEvents(run);
  assert.deepEqual(events.map((e) => e.t), ['phase', 'log']);
  assert.ok(events[0].at, 'у события есть время');
  assert.equal(events[1].text, 'привет');
});

test('readEvents: оборванная строка недописанного рана не роняет чтение', () => {
  const run = createRun('threads', { root });
  appendEvent(run, { t: 'log', text: 'первая' });
  writeFileSync(path.join(run.dir, 'events.jsonl'), '{"t":"log","text":"первая"}\n{"t":"log","te', 'utf8');
  assert.deepEqual(readEvents(run).map((e) => e.text), ['первая']);
  assert.deepEqual(readEvents({ dir: path.join(root, 'нет-такого') }), []);
});

test('listRuns: свежие первыми, незавершённый помечен, мусорный каталог пропущен', () => {
  const done = createRun('review', { root });
  saveArtifact(done, 'meta.json', { id: done.id, action: 'review', mr: 7, created_at: '2026-09-11T10:00:00.000Z' });
  saveArtifact(done, 'result.json', { ok: true });
  saveArtifact(done, 'verdict.json', { decision: 'approve', meta: { cost: 0.4 } });

  const broken = createRun('conflict', { root });
  saveArtifact(broken, 'meta.json', { id: broken.id, action: 'conflict', mr: 8, created_at: '2026-09-11T11:00:00.000Z' });

  mkdirSync(path.join(root, 'не-ран'), { recursive: true });

  const runs = listRuns({ root });
  assert.deepEqual(runs.slice(0, 2).map((r) => r.action), ['conflict', 'review']);
  assert.deepEqual([runs[0].state, runs[1].state], ['прерван', 'done']);
  assert.deepEqual([runs[1].decision, runs[1].cost], ['approve', 0.4]);
  assert.equal(runs.some((r) => r.id === 'не-ран'), false);
});

test('listRuns: явное состояние и код ошибки из meta перебивают догадку по файлам', () => {
  const run = createRun('conflict', { root });
  saveArtifact(run, 'meta.json', {
    id: run.id, action: 'conflict', mr: 9, created_at: '2026-09-12T10:00:00.000Z',
    state: 'failed', error: { code: 'agent_failed', message: 'агент упал' }, worktree: '/tmp/wt',
  });
  const [r] = listRuns({ root, limit: 1 });
  assert.equal(r.state, 'failed');
  assert.equal(r.error_code, 'agent_failed');
  assert.equal(r.worktree, '/tmp/wt');
});

test('patchRunMeta/setRunState: мержат поверх meta и не теряют поля', () => {
  const run = createRun('review', { root });
  saveArtifact(run, 'meta.json', { id: run.id, action: 'review', state: 'running', session_id: 's1' });
  patchRunMeta(run, { state: 'done', pid: null });
  setRunState(run, 'failed');
  const meta = JSON.parse(readFileSync(path.join(run.dir, 'meta.json'), 'utf8'));
  assert.equal(meta.action, 'review');
  assert.equal(meta.session_id, 's1');
  assert.equal(meta.state, 'failed');
});

test('pidAlive/runIsActive: живой свой pid активен, мёртвый и пустой — нет', () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(0), false);
  assert.equal(pidAlive(null), false);
  const run = createRun('conflict', { root });
  appendEvent(run, { t: 'log', text: 'жив' });
  assert.equal(runIsActive({ pid: process.pid }, run.dir), true);
  assert.equal(runIsActive({ pid: process.pid }, run.dir, { staleMs: -1 }), false, 'старый журнал — не активен');
  assert.equal(runIsActive({ pid: null }, run.dir), false);
});

test('pruneRuns: удаляет старые архивы ранов сверх лимита', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fs-harness-prune-'));
  try {
    for (let i = 1; i <= 5; i++) {
      const run = createRun(`action-${i}`, { root: dir, keep: 10 });
      saveArtifact(run, 'meta.json', { id: run.id, action: `action-${i}`, created_at: `2026-09-1${i}T10:00:00.000Z` });
    }
    assert.equal(listRuns({ root: dir, limit: 10 }).length, 5);

    // Ограничиваем тремя
    const deleted = pruneRuns({ root: dir, keep: 3 });
    assert.equal(deleted.length, 2);
    const remaining = listRuns({ root: dir, limit: 10 });
    assert.equal(remaining.length, 3);
    assert.deepEqual(remaining.map((r) => r.action), ['action-5', 'action-4', 'action-3']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pruneRuns: pending_approval переживает keep=0', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fs-harness-prune-pending-'));
  try {
    const waiting = createRun('conflict', { root: dir, keep: 10 });
    saveArtifact(waiting, 'meta.json', {
      id: waiting.id, action: 'conflict', created_at: '2026-01-01T10:00:00.000Z',
      state: 'pending_approval', approval: { nonce: 'n1', issued_at: new Date().toISOString() },
    });
    const done = createRun('conflict', { root: dir, keep: 10 });
    saveArtifact(done, 'meta.json', { id: done.id, action: 'conflict', created_at: '2026-01-02T10:00:00.000Z', state: 'done' });

    const deleted = pruneRuns({ root: dir, keep: 0 });
    assert.ok(deleted.includes(done.id));
    assert.ok(!deleted.includes(waiting.id), 'ран с кнопкой съеден ретеншном');
    assert.ok(listRuns({ root: dir, limit: 10 }).some((r) => r.id === waiting.id));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sweepExpiredApprovals: протухший гасит, свежий не трогает', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fs-harness-sweep-'));
  try {
    const old = createRun('conflict', { root: dir, keep: 10 });
    saveArtifact(old, 'meta.json', {
      id: old.id, action: 'conflict', state: 'pending_approval',
      approval: { nonce: 'n-old', issued_at: '2026-01-01T00:00:00.000Z' },
    });
    const fresh = createRun('conflict', { root: dir, keep: 10 });
    saveArtifact(fresh, 'meta.json', {
      id: fresh.id, action: 'conflict', state: 'pending_approval',
      approval: { nonce: 'n-new', issued_at: '2026-09-23T00:00:00.000Z' },
    });

    const swept = [];
    const expired = sweepExpiredApprovals({
      root: dir,
      now: new Date('2026-09-23T12:00:00.000Z').getTime(),
      ttlMs: 24 * 3600 * 1000,
      onExpired: (run) => swept.push(run.id),
    });
    assert.deepEqual(expired, [old.id]);
    assert.deepEqual(swept, [old.id]);
    assert.equal(JSON.parse(readFileSync(path.join(old.dir, 'meta.json'), 'utf8')).state, 'expired');
    assert.equal(JSON.parse(readFileSync(path.join(fresh.dir, 'meta.json'), 'utf8')).state, 'pending_approval');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
