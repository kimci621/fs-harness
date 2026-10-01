import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mergePurity, conflictAction } from '../src/actions/conflict.js';
import { makeGit } from '../src/workspace.js';

const dir = mkdtempSync(path.join(tmpdir(), 'fs-harness-purity-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const sh = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
const commit = (file, text, msg) => {
  writeFileSync(path.join(dir, file), text);
  sh('add', file);
  sh('commit', '-q', '-m', msg);
};

// Две ветки без конфликта: source правит a.txt, target — b.txt.
sh('init', '-q', '-b', 'target');
sh('config', 'user.email', 't@t');
sh('config', 'user.name', 't');
commit('a.txt', 'a\n', 'base');
sh('switch', '-q', '-c', 'source');
commit('a.txt', 'a2\n', 'source');
sh('switch', '-q', 'target');
commit('b.txt', 'b\n', 'target');
sh('switch', '-q', 'source');
const git = makeGit(dir);

test('mergePurity: чистый merge target — pure, судья пропускается', () => {
  const sourceSha = sh('rev-parse', 'source');
  sh('merge', '-q', '--no-edit', 'target');
  const res = mergePurity(git, dir, sourceSha, 'target');
  assert.equal(res.pure, true);
  const skip = conflictAction.action.judge.skip;
  assert.ok(skip({ facts: { pure_merge: true, checks: [{ exit_code: 0 }] } }));
  assert.equal(skip({ facts: { pure_merge: true, checks: [{ exit_code: 1 }] } }), null, 'красная проверка — судья нужен');
  assert.equal(skip({ facts: { pure_merge: true, checks: 'не прогонялись' } }), null, 'без проверок — судья нужен');
  assert.equal(skip({ facts: { pure_merge: false, checks: [{ exit_code: 0 }] } }), null);
});

test('mergePurity: правка сверх мержа — не pure, дифф лишнего отдаётся судье', () => {
  const before = sh('rev-parse', 'HEAD^1');
  sh('reset', '-q', '--hard', before);
  sh('merge', '-q', '--no-commit', 'target');
  writeFileSync(path.join(dir, 'a.txt'), 'сверх мержа\n');
  sh('add', 'a.txt');
  sh('commit', '-q', '--no-edit');
  const res = mergePurity(git, dir, before, 'target');
  assert.equal(res.pure, false);
  assert.match(res.extra, /сверх мержа/);
});
