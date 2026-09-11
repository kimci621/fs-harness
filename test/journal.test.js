import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRun, saveArtifact, appendEvent, readEvents, listRuns } from '../src/agent/journal.js';

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
