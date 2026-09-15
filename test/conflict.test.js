import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { conflictAction, parseMergeTree, resolutionScope } from '../src/actions/conflict.js';
import { runActionCLI } from '../src/engine.js';
import { hasMergeTree } from '../src/commands/doctor.js';
import { makeGit } from '../src/workspace.js';
import { runChecks, checksFact } from '../src/checks.js';
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

// Живой случай: мерж привёл 188 коммитов target, дифф base..HEAD оказался в 13 тысяч строк,
// судью обрезало, и конфликтующий файл в него не попал вовсе.
test('resolutionScope: судье уходит решение конфликта, а не весь мерж target', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fs-harness-resolution-'));
  const g = (...args) =>
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=t@e.st', ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  g('init', '-b', 'target');
  writeFileSync(path.join(dir, 'f.txt'), 'база\n');
  g('add', '.');
  g('commit', '-m', 'база');

  g('checkout', '-b', 'feature');
  writeFileSync(path.join(dir, 'f.txt'), 'сторона A\n');
  g('commit', '-am', 'A');
  const start = g('rev-parse', 'HEAD').trim();

  g('checkout', 'target');
  writeFileSync(path.join(dir, 'f.txt'), 'сторона B\n');
  g('commit', '-am', 'B');
  writeFileSync(path.join(dir, 'noise.txt'), 'посторонний файл из target\n'.repeat(50));
  g('add', '.');
  g('commit', '-m', 'шум из target');

  g('checkout', 'feature');
  try {
    g('merge', 'target');
  } catch {
    // конфликт — это и есть сценарий
  }
  writeFileSync(path.join(dir, 'f.txt'), 'сторона A + сторона B\n');
  g('add', 'f.txt');
  g('commit', '--no-edit');

  const scope = resolutionScope(makeGit(dir), dir, start, ['f.txt']);
  assert.deepEqual(scope.files, ['f.txt'], 'в дифф попал мерж target, а не решение');
  assert.match(scope.diff, /сторона A \+ сторона B/);
  assert.doesNotMatch(scope.diff, /посторонний файл из target/);
  assert.match(scope.title, /решени/);
  rmSync(dir, { recursive: true, force: true });
});

test('resolutionScope: без мерж-коммита откатываемся на base..HEAD', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fs-harness-resolution-'));
  const g = (...args) =>
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=t@e.st', ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  g('init', '-b', 'main');
  writeFileSync(path.join(dir, 'f.txt'), 'база\n');
  g('add', '.');
  g('commit', '-m', 'база');
  const start = g('rev-parse', 'HEAD').trim();
  writeFileSync(path.join(dir, 'f.txt'), 'правка\n');
  g('commit', '-am', 'правка');

  const scope = resolutionScope(makeGit(dir), dir, start, ['f.txt']);
  assert.equal(scope.title, 'Дифф base..HEAD');
  assert.deepEqual(scope.files, ['f.txt']);
  rmSync(dir, { recursive: true, force: true });
});

test('runChecks: код выхода и хвост вывода снимаются механически', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fs-harness-checks-'));
  const got = runChecks(['echo зелено', 'sh -c "echo падает >&2; exit 3"'], dir, { tailLines: 2 });
  assert.deepEqual(got.map((c) => c.exit_code), [0, 3]);
  assert.match(got[0].tail, /зелено/);
  assert.match(got[1].tail, /падает/);
  rmSync(dir, { recursive: true, force: true });
});

test('runChecks: упавшая проверка повторяется, флейк виден в фактах, поломка — нет', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fs-harness-flake-'));
  writeFileSync(path.join(dir, 'flaky.sh'), '#!/bin/sh\nn=$(cat counter 2>/dev/null || echo 0)\nn=$((n+1))\necho $n > counter\n[ "$n" -ge 2 ]\n', { mode: 0o755 });
  writeFileSync(path.join(dir, 'broken.sh'), '#!/bin/sh\nexit 4\n', { mode: 0o755 });
  const logs = [];
  const [flake, broken] = runChecks([`sh ${path.join(dir, 'flaky.sh')}`, `sh ${path.join(dir, 'broken.sh')}`], dir, { say: (t) => logs.push(t) });

  // Флейк: первый заход красный, второй зелёный — и это записано в факт, а не спрятано.
  assert.equal(flake.exit_code, 0);
  assert.equal(flake.attempts, 2);
  assert.equal(flake.first_exit_code, 1);
  // Настоящая поломка повтором не маскируется: код остался ненулевым.
  assert.equal(broken.exit_code, 4);
  assert.equal(broken.attempts, 2);
  assert.equal(broken.first_exit_code, 4);
  assert.ok(logs.some((l) => /пробую ещё раз/.test(l)), logs.join('\n'));
  assert.ok(logs.some((l) => /со 2-й попытки — флейк/.test(l)), logs.join('\n'));
  rmSync(dir, { recursive: true, force: true });
});

test('runChecks: retries=0 — один заход, без полей повтора', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fs-harness-noretry-'));
  const [c] = runChecks(['sh -c "exit 5"'], dir, { retries: 0 });
  assert.equal(c.exit_code, 5);
  assert.equal(c.attempts, undefined);
  assert.equal(c.first_exit_code, undefined);
  rmSync(dir, { recursive: true, force: true });
});

test('checksFact: без настроенных команд и без зависимостей судье уходит причина, а не пустота', () => {
  assert.match(checksFact([], true), /не настроены/);
  assert.match(checksFact(['npm test'], false), /node_modules/);
  assert.equal(checksFact(['npm test'], true), null); // есть что запускать — запускаем
});
