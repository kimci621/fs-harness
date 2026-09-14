import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { acquireWorkspace, makeGit, MODES, WORKTREE_ROOT } from '../src/workspace.js';

let root;
let project;
let wtRoot;

const git = (args, cwd) =>
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=t@e.st', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

before(() => {
  root = mkdtempSync(path.join(tmpdir(), 'fs-harness-ws-'));
  const origin = path.join(root, 'origin.git');
  project = path.join(root, 'project');
  wtRoot = path.join(root, 'worktrees');

  git(['init', '--bare', '-b', 'main', origin], root);
  git(['clone', origin, project], root);
  writeFileSync(path.join(project, '.gitignore'), 'node_modules/\n');
  writeFileSync(path.join(project, 'package-lock.json'), '{"v":1}\n');
  writeFileSync(path.join(project, 'f.txt'), 'база\n');
  mkdirSync(path.join(project, 'node_modules', 'пакет'), { recursive: true });
  writeFileSync(path.join(project, 'node_modules', 'пакет', 'index.js'), 'export default 1;\n');
  git(['add', '-A'], project);
  git(['commit', '-m', 'база'], project);
  git(['push', 'origin', 'main'], project);
});

after(() => rmSync(root, { recursive: true, force: true }));

test('workspace: рут лежит вне репозитория проекта', () => {
  assert.ok(!WORKTREE_ROOT.includes('.worktrees'));
  assert.match(WORKTREE_ROOT, /\.local\/state\/fs-harness\/worktrees$/);
});

test('ephemeral-worktree: каталог вне проекта, своя ветка, node_modules и уборка', async () => {
  const ws = await acquireWorkspace({
    mode: 'ephemeral-worktree', action: 'conflict', project, ref: 'main', key: '7',
    root: wtRoot, deps: { strategy: 'link' },
  });
  assert.ok(ws.dir.startsWith(wtRoot), 'worktree вне каталога проекта');
  assert.ok(!ws.dir.startsWith(project));
  assert.match(ws.branch, /^fs-harness\/conflict-7-/);
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], ws.dir), ws.branch);
  assert.ok(lstatSync(path.join(ws.dir, 'node_modules')).isSymbolicLink());
  assert.equal(ws.deps.available, true); // lock-файл тот же — зависимости годны

  ws.cleanup(false);
  assert.equal(existsSync(ws.dir), false);
  assert.doesNotMatch(git(['branch', '--list', ws.branch], project), /fs-harness/);
});

test('deps_available: разошедшийся lock-файл закрывает линт агенту', async () => {
  git(['checkout', '-b', 'other'], project);
  writeFileSync(path.join(project, 'package-lock.json'), '{"v":2}\n');
  git(['commit', '-am', 'другой lock'], project);
  git(['push', 'origin', 'other'], project);
  git(['checkout', 'main'], project);
  try {
    const ws = await acquireWorkspace({
      mode: 'ephemeral-worktree', action: 'conflict', project, ref: 'other', key: '8',
      root: wtRoot, deps: { strategy: 'link' }, refs: ['other'],
    });
    assert.equal(ws.deps.available, false);
    ws.cleanup(false);
  } finally {
    git(['branch', '-D', 'other'], project);
  }
});

test('deps strategy none: зависимости не переносятся и это не ошибка', async () => {
  const ws = await acquireWorkspace({
    mode: 'ephemeral-worktree', action: 'conflict', project, ref: 'main', key: '9',
    root: wtRoot, deps: { strategy: 'none' },
  });
  assert.equal(ws.deps.available, false);
  assert.equal(existsSync(path.join(ws.dir, 'node_modules')), false);
  ws.cleanup(false);
});

test('checkout: каталог проекта, а изменение чекаута ловится', async () => {
  const ws = await acquireWorkspace({ mode: 'checkout', action: 'review', project, ref: 'main', key: '1' });
  assert.equal(ws.dir, project);
  assert.equal(ws.branch, null);
  const before = ws.snapshot();
  ws.assertClean(before); // ничего не трогали — проходит
  writeFileSync(path.join(project, 'f.txt'), 'кто-то написал\n');
  assert.throws(() => ws.assertClean(before), (e) => e.code === 'dirty_checkout');
  writeFileSync(path.join(project, 'f.txt'), 'база\n');
});

test('workspace: неизвестный режим — понятная ошибка, а не молчание', async () => {
  assert.deepEqual(MODES, ['checkout', 'ephemeral-worktree', 'task-worktree']);
  await assert.rejects(
    () => acquireWorkspace({ mode: 'нет-такого', action: 'x', project, key: '1' }),
    (e) => e.code === 'config_invalid',
  );
});

test('task-worktree: уборка не удаляет каталог', async () => {
  const ws = await acquireWorkspace({
    mode: 'task-worktree', action: 'analyze', project, ref: 'main', key: 'FD-1',
    root: wtRoot, deps: { strategy: 'none' },
  });
  ws.cleanup(false);
  assert.equal(existsSync(ws.dir), true);
  git(['worktree', 'remove', '--force', ws.dir], project);
  git(['branch', '-D', ws.branch], project);
});

// Ран падал с ENOBUFS уже после работы агента: дефолтный буфер execFileSync — мегабайт,
// а дифф ветки после мержа target больше. Проверка держит буфер на месте.
test('makeGit: вывод больше мегабайта не роняет команду', () => {
  const big = path.join(root, 'big');
  git(['init', '-b', 'main', big], root);
  writeFileSync(path.join(big, 'f.txt'), 'строка с текстом подлиннее\n'.repeat(60000)); // ~2.8 МБ
  git(['add', 'f.txt'], big);
  git(['commit', '-m', 'большой файл'], big);

  const out = makeGit(big)(['show', 'HEAD']);
  assert.ok(out.length > 1024 * 1024, `вывод всего ${out.length} байт — тест ничего не проверяет`);
});
