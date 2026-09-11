import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { conflictAction, parseMergeTree } from '../src/actions/conflict.js';
import { runActionCLI } from '../src/engine.js';
import { hasMergeTree } from '../src/commands/doctor.js';
import { CliError } from '../src/errors.js';

let root;
let project;

// Настоящий git-фикстур: bare origin + клон. Сети не требует.
//   target ← база ← source   (оба правят f.txt → конфликт)
//   clean  ← база            (правит другой файл → merge чистый)
before(() => {
  root = mkdtempSync(path.join(tmpdir(), 'fs-harness-conflict-'));
  const origin = path.join(root, 'origin.git');
  project = path.join(root, 'project');
  const git = (args, cwd) =>
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=t@e.st', ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

  git(['init', '--bare', '-b', 'target', origin], root);
  git(['clone', origin, project], root);

  writeFileSync(path.join(project, 'f.txt'), 'база\n');
  git(['add', 'f.txt'], project);
  git(['commit', '-m', 'база'], project);
  git(['push', 'origin', 'target'], project);

  git(['checkout', '-b', 'source'], project);
  writeFileSync(path.join(project, 'f.txt'), 'сторона A\n');
  git(['commit', '-am', 'A'], project);
  git(['push', 'origin', 'source'], project);

  git(['checkout', '-b', 'clean', 'target'], project);
  writeFileSync(path.join(project, 'other.txt'), 'не пересекается\n');
  git(['add', 'other.txt'], project);
  git(['commit', '-m', 'other'], project);
  git(['push', 'origin', 'clean'], project);

  git(['checkout', 'target'], project);
  writeFileSync(path.join(project, 'f.txt'), 'сторона B\n');
  git(['commit', '-am', 'B'], project);
  git(['push', 'origin', 'target'], project);
});

after(() => rmSync(root, { recursive: true, force: true }));

// GitLab отдаёт has_conflicts: false — команда обязана не поверить и посчитать сама.
const fakeGitlab = (sourceBranch) => ({
  getMR: async () => ({
    iid: 7,
    title: 'тестовый MR',
    web_url: 'https://example.invalid/mr/7',
    source_branch: sourceBranch,
    target_branch: 'target',
    has_conflicts: false,
  }),
});

test('parseMergeTree: первая строка — OID дерева, а не файл', () => {
  const out = 'e9ad03c7f2ec5caf072f713507601901315fc115\nf.txt\nsrc/a.js\n';
  assert.deepEqual(parseMergeTree(out), ['f.txt', 'src/a.js']);
  assert.deepEqual(parseMergeTree('e9ad03c\n'), []);
});

test('conflict --dry-run: конфликт найден локально, файлы в плане', async () => {
  const plan = await runActionCLI(conflictAction, { g: fakeGitlab('source'), repo: 'r/repo' }, ['7'], {
    agent: 'claude',
    projectDir: project,
    dryRun: true,
    asObject: true,
  });
  assert.equal(plan.has_conflicts, true);
  assert.deepEqual(plan.conflict_files, ['f.txt']);
});

test('conflict: чистый merge — skipped, несмотря на has_conflicts из GitLab', async () => {
  const res = await runActionCLI(conflictAction, { g: fakeGitlab('clean'), repo: 'r/repo' }, ['7'], {
    agent: 'claude',
    projectDir: project,
    yes: true,
    asObject: true,
  });
  assert.deepEqual([res.skipped, res.has_conflicts, res.conflict_files], [true, false, []]);
});

test('conflict: падение до создания worktree долетает наружу, а не глохнет в finally', async () => {
  // Рут worktree — файл вместо каталога: изоляция обязана упасть до запуска агента.
  const notADir = path.join(root, 'не-каталог');
  writeFileSync(notADir, 'файл\n');
  await assert.rejects(
    () =>
      runActionCLI(conflictAction, { g: fakeGitlab('source'), repo: 'r/repo' }, ['7'], {
        agent: 'claude',
        projectDir: project,
        yes: true,
        asObject: true,
        runsDir: path.join(root, 'runs'),
        cfg: { workspace: { root: notADir } },
      }),
    (err) => err instanceof CliError && err.code === 'workspace_failed',
  );
});

test('hasMergeTree: --write-tree есть с 2.38', () => {
  assert.equal(hasMergeTree('git version 2.50.1 (Apple Git-155)'), true);
  assert.equal(hasMergeTree('git version 2.38.0'), true);
  assert.equal(hasMergeTree('git version 2.37.9'), false);
  assert.equal(hasMergeTree('git version 3.0.0'), true);
  assert.equal(hasMergeTree(null), false);
});
