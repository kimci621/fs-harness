import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { cmdCommit } from '../src/commands/commit.js';

function setupRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'fsh-commit-'));
  const git = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Tester']);
  git(['config', 'user.email', 'tester@example.com']);
  writeFileSync(path.join(dir, 'file.txt'), 'hello\n');
  git(['add', 'file.txt']);
  git(['commit', '-m', 'initial commit']);
  return { dir, git, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('cmdCommit: dry-run не запускает агента и возвращает план', async () => {
  const { dir, cleanup } = setupRepo();
  try {
    const res = await cmdCommit([], { projectDir: dir, dryRun: true, asObject: true });
    assert.equal(res.ok, true);
    assert.equal(res.dry_run, true);
    assert.equal(res.branch, 'main');
    assert.match(res.action, /git add/);
  } finally {
    cleanup();
  }
});

test('cmdCommit: агент agy получает промпт аргументом -p, а не через stdin', async () => {
  const { dir, git, cleanup } = setupRepo();
  try {
    writeFileSync(path.join(dir, 'file.txt'), 'hello world\n');

    let calledArgs = null;
    let calledInput = null;
    const fakeSpawn = (bin, args, options) => {
      calledArgs = args;
      calledInput = options.input;
      // Делаем коммит, чтобы commit.js увидел сдвиг HEAD
      git(['add', 'file.txt']);
      git(['commit', '-m', 'fix: test message']);
      return { status: 0, error: null };
    };

    const res = await cmdCommit([], {
      projectDir: dir,
      agent: 'agy',
      yes: true,
      asObject: true,
      spawnSyncImpl: fakeSpawn,
    });

    assert.equal(res.ok, true);
    assert.ok(calledArgs.includes('-p'), 'флаг -p передан');
    const pIndex = calledArgs.indexOf('-p');
    assert.ok(calledArgs[pIndex + 1], 'после -p передан текст промпта');
    assert.equal(calledInput, undefined, 'stdin для agy не передаётся');
  } finally {
    cleanup();
  }
});

test('cmdCommit: агент claude получает промпт через stdin', async () => {
  const { dir, git, cleanup } = setupRepo();
  try {
    writeFileSync(path.join(dir, 'file.txt'), 'hello claude\n');

    let calledArgs = null;
    let calledInput = null;
    const fakeSpawn = (bin, args, options) => {
      calledArgs = args;
      calledInput = options.input;
      git(['add', 'file.txt']);
      git(['commit', '-m', 'fix: claude message']);
      return { status: 0, error: null };
    };

    const res = await cmdCommit([], {
      projectDir: dir,
      agent: 'cc',
      yes: true,
      asObject: true,
      spawnSyncImpl: fakeSpawn,
    });

    assert.equal(res.ok, true);
    assert.deepEqual(calledArgs.slice(-1), ['-p']);
    assert.ok(typeof calledInput === 'string' && calledInput.length > 0, 'промпт ушёл в stdin');
  } finally {
    cleanup();
  }
});
