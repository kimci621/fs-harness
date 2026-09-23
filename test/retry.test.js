import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cmdRetry } from '../src/commands/retry.js';
import { createRun, saveArtifact } from '../src/agent/journal.js';
import { CliError } from '../src/errors.js';

let runsDir;
before(() => { runsDir = mkdtempSync(path.join(tmpdir(), 'fs-harness-retry-')); });
after(() => rmSync(runsDir, { recursive: true, force: true }));

const makeRun = (meta, extra = {}) => {
  const run = createRun('x', { root: runsDir });
  saveArtifact(run, 'meta.json', { id: run.id, created_at: '2026-09-12T10:00:00.000Z', ...meta });
  for (const [name, body] of Object.entries(extra)) saveArtifact(run, name, body);
  return run;
};

test('retry: восстанавливает цель и агента из meta и зовёт действие', async () => {
  const run = makeRun({ action: 'my-action', mr: 8, agent: 'pi' });
  const seen = [];
  const entry = { action: { target: 'mr' }, run: (ctx, args, opts) => { seen.push({ args, agent: opts.agent, runId: opts.runsDir }); return { ok: true, retried: true }; } };
  const res = await cmdRetry({}, [run.id], { runsDir, findCommand: () => entry });
  assert.deepEqual(seen[0].args, ['!8']);
  assert.equal(seen[0].agent, 'pi');
  assert.deepEqual(res, { ok: true, retried: true });
});

test('retry: неизвестное действие — action_unknown', async () => {
  const run = makeRun({ action: 'ghost', mr: 1 });
  await assert.rejects(
    () => cmdRetry({}, [run.id], { runsDir, findCommand: () => null }),
    (e) => e instanceof CliError && e.code === 'action_unknown',
  );
});

test('retry: ран без цели — run_not_retryable', async () => {
  const run = makeRun({ action: 'my-action', agent: 'cc' });
  await assert.rejects(
    () => cmdRetry({}, [run.id], { runsDir, findCommand: () => ({ action: { target: 'mr' }, run: () => {} }) }),
    (e) => e.code === 'run_not_retryable',
  );
});

test('retry: живой ран — run_active', async () => {
  const run = makeRun({ action: 'my-action', mr: 1, pid: process.pid }, { 'events.jsonl': '{"t":"log","text":"жив"}\n' });
  await assert.rejects(
    () => cmdRetry({}, [run.id], { runsDir, findCommand: () => ({ action: { target: 'mr' }, run: () => {} }) }),
    (e) => e.code === 'run_active',
  );
});

test('retry: без runId — usage', async () => {
  await assert.rejects(() => cmdRetry({}, [], { runsDir }), (e) => e.code === 'usage');
});
