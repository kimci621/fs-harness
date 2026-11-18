import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cmdWait } from '../src/waits.js';

const ctx = { cfg: { activeProject: 'front' } };

test('wait: FS_HARNESS_WAITS_FILE переносит файл ожиданий', async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'fsh-wf-')), 'sub', 'waits.json');
  const saved = process.env.FS_HARNESS_WAITS_FILE;
  process.env.FS_HARNESS_WAITS_FILE = file;
  try {
    await cmdWait(ctx, ['add', 'jira', 'FD-1']);
    assert.ok(existsSync(file));
    assert.deepEqual((await cmdWait(ctx, ['list'])).waits.map((w) => w.target), ['FD-1']);
  } finally {
    saved === undefined ? delete process.env.FS_HARNESS_WAITS_FILE : (process.env.FS_HARNESS_WAITS_FILE = saved);
  }
});

test('wait: нет прав на файл — понятная ошибка с подсказкой про FS_HARNESS_WAITS_FILE', async () => {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'fsh-wf-')), 'ro');
  mkdirSync(dir);
  chmodSync(dir, 0o500);
  try {
    await assert.rejects(
      () => cmdWait(ctx, ['add', 'jira', 'FD-1'], {}, { file: path.join(dir, 'waits.json') }),
      (e) => e.code === 'permission_denied' && /FS_HARNESS_WAITS_FILE/.test(e.message) && /EACCES|EPERM/.test(e.message),
    );
  } finally {
    chmodSync(dir, 0o700);
  }
});
