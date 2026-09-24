import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listWorktrees, gcWorktrees } from '../src/worktrees.js';

let root;
let project;
let wtRoot;
let runsRoot;

const git = (args, cwd) =>
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=t@e.st', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

before(() => {
  root = mkdtempSync(path.join(tmpdir(), 'fs-harness-wt-'));
  const origin = path.join(root, 'origin.git');
  project = path.join(root, 'project');
  wtRoot = path.join(root, 'worktrees');
  runsRoot = path.join(root, 'runs');

  git(['init', '--bare', '-b', 'main', origin], root);
  git(['clone', origin, project], root);
  writeFileSync(path.join(project, 'f.txt'), 'hello\n');
  git(['add', '-A'], project);
  git(['commit', '-m', 'init'], project);
  git(['push', 'origin', 'main'], project);

  mkdirSync(runsRoot, { recursive: true });
});

after(() => rmSync(root, { recursive: true, force: true }));

test('listWorktrees: классифицирует run-alive, run-done, orphan и task', async () => {
  const now = Date.now();
  const projWtDir = path.join(wtRoot, 'project');
  mkdirSync(projWtDir, { recursive: true });

  // 1. Live run
  const dirAlive = path.join(projWtDir, 'conflict-mr1-stamp1');
  git(['worktree', 'add', '-b', 'fs-harness/conflict-mr1-stamp1', dirAlive, 'main'], project);
  mkdirSync(path.join(runsRoot, 'run-alive'), { recursive: true });
  writeFileSync(
    path.join(runsRoot, 'run-alive', 'meta.json'),
    JSON.stringify({
      id: 'run-alive',
      state: 'running',
      worktree: dirAlive,
      branch: 'fs-harness/conflict-mr1-stamp1',
      action: 'conflict',
      mr: 1,
      created_at: new Date(now - 10 * 86400000).toISOString(),
    }),
  );

  // 2. Done run (старый)
  const dirDone = path.join(projWtDir, 'conflict-mr2-stamp2');
  git(['worktree', 'add', '-b', 'fs-harness/conflict-mr2-stamp2', dirDone, 'main'], project);
  mkdirSync(path.join(runsRoot, 'run-done'), { recursive: true });
  writeFileSync(
    path.join(runsRoot, 'run-done', 'meta.json'),
    JSON.stringify({
      id: 'run-done',
      state: 'done',
      worktree: dirDone,
      branch: 'fs-harness/conflict-mr2-stamp2',
      action: 'conflict',
      mr: 2,
      created_at: new Date(now - 10 * 86400000).toISOString(),
    }),
  );

  // 3. Orphan (без рана в журнале, старый)
  const dirOrphan = path.join(projWtDir, 'conflict-mr3-stamp3');
  git(['worktree', 'add', '-b', 'fs-harness/conflict-mr3-stamp3', dirOrphan, 'main'], project);
  const tenDaysAgo = (now - 10 * 86400000) / 1000;
  utimesSync(dirOrphan, tenDaysAgo, tenDaysAgo);

  // 4. Task worktree (ветка не fs-harness/*)
  const dirTask = path.join(projWtDir, 'implement-fd123-stamp4');
  git(['worktree', 'add', '-b', 'feature/FD-123', dirTask, 'main'], project);

  const list = listWorktrees({ root: wtRoot, runsRoot, projectDirs: [project], now, sizes: true });
  assert.equal(list.length, 4);

  const aliveItem = list.find((w) => w.dir === dirAlive);
  assert.ok(aliveItem);
  assert.equal(aliveItem.status, 'run-alive');
  assert.equal(aliveItem.action, 'conflict');
  assert.equal(aliveItem.key, '1');
  assert.equal(typeof aliveItem.size_mb, 'number');

  const doneItem = list.find((w) => w.dir === dirDone);
  assert.ok(doneItem);
  assert.equal(doneItem.status, 'run-done');
  assert.equal(doneItem.action, 'conflict');
  assert.equal(doneItem.key, '2');
  assert.ok(doneItem.age_days >= 9);

  const orphanItem = list.find((w) => w.dir === dirOrphan);
  assert.ok(orphanItem);
  assert.equal(orphanItem.status, 'orphan');
  assert.ok(orphanItem.age_days >= 9);

  const taskItem = list.find((w) => w.dir === dirTask);
  assert.ok(taskItem);
  assert.equal(taskItem.status, 'task');
  assert.equal(taskItem.branch, 'feature/FD-123');

  // gcWorktrees dry-run ничего не удаляет
  const planned = await gcWorktrees({
    root: wtRoot,
    runsRoot,
    projectDirs: [project],
    olderThanDays: 7,
    dryRun: true,
    now,
  });
  assert.equal(planned.length, 2, 'В плане только orphan и done старше 7 дней');
  assert.ok(existsSync(dirAlive));
  assert.ok(existsSync(dirDone));
  assert.ok(existsSync(dirOrphan));
  assert.ok(existsSync(dirTask));

  // Настоящий gc удаляет orphan и done, живой и task не трогает
  const deleted = await gcWorktrees({
    root: wtRoot,
    runsRoot,
    projectDirs: [project],
    olderThanDays: 7,
    dryRun: false,
    now,
  });
  assert.equal(deleted.length, 2);
  assert.equal(existsSync(dirDone), false, 'run-done удалён');
  assert.equal(existsSync(dirOrphan), false, 'orphan удалён');
  assert.equal(existsSync(dirAlive), true, 'run-alive остался');
  assert.equal(existsSync(dirTask), true, 'task остался');
});
