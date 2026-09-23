import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runAction, slimPre } from '../src/engine.js';
import { createRun, saveArtifact } from '../src/agent/journal.js';
import { CliError } from '../src/errors.js';

let root;
let project;
let origin;
let runsDir;

const git = (args, cwd) =>
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=t@e.st', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

before(() => {
  root = mkdtempSync(path.join(tmpdir(), 'fs-harness-resume-'));
  origin = path.join(root, 'origin.git');
  project = path.join(root, 'project');
  runsDir = path.join(root, 'runs');
  git(['init', '--bare', '-b', 'main', origin], root);
  git(['clone', origin, project], root);
  writeFileSync(path.join(project, 'f.txt'), 'файл\n');
  git(['add', 'f.txt'], project);
  git(['commit', '-m', 'база'], project);
  git(['push', 'origin', 'main'], project);
  mkdirSync(path.join(project, '.fs-harness', 'prompts'), { recursive: true });
  writeFileSync(path.join(project, '.fs-harness', 'prompts', 'resume-test.md'), '---\nvars: [where]\n---\nработай в {{where}}\n');
});

after(() => rmSync(root, { recursive: true, force: true }));

const verdict = (decision) => ({
  decision, confidence: 0.9, summary: 'тест', findings: [], checks: [], next: { action: 'push', hint: '' },
});
const fakeJudge = (decision) => async () => ({
  name: 'fake',
  complete: async () => ({ text: JSON.stringify(verdict(decision)), cost: 0 }),
});

// Действие-пустышка: изоляция настоящая, публикация только считает вызовы.
function spec(published) {
  return {
    name: 'resume-test',
    kind: 'action',
    usage: 'resume-test',
    action: {
      title: 'тест resume', target: 'none', writes: true, isolation: 'ephemeral-worktree',
      prompt: 'resume-test', agent: { default: 'claude' },
      judge: { gate: 'pre-push', role: 'acceptance' },
      precheck: () => ({
        projectDir: project,
        workspace: { project, ref: 'main', baseRef: 'main', key: 'x' },
        meta: { repo: 'r/r', project_dir: project },
      }),
      context: ({ ws }) => ({ where: ws.dir }),
      goal: () => 'проверить resume',
      verify: ({ ws }) => ({
        commits_ahead: Number(ws.git(['rev-list', '--count', `${ws.base}..HEAD`], ws.dir)),
        head_sha: ws.git(['rev-parse', 'HEAD'], ws.dir),
        diff: 'diff',
      }),
      publish: () => { published.push('push'); return {}; },
      result: ({ facts, verdict: v }) => ({ ok: true, decision: v?.decision ?? null, head_sha: facts.head_sha }),
    },
  };
}

const opts = (over) => ({
  agent: 'claude', yes: true, asObject: true, projectDir: project, runsDir,
  cfg: {
    agents: { claude: { bin: 'claude' } },
    workspace: { root: path.join(root, 'worktrees') },
    judge: { profiles: { fake: { provider: 'fake' } }, roles: { acceptance: ['fake'] } },
  },
  ...over,
});

// Агент падает на первом заходе и коммитит на втором: так проверяем доигрывание.
function flakyClaude(dir) {
  const bin = path.join(dir, 'bin');
  const calls = path.join(dir, 'calls.txt');
  const inputs = path.join(dir, 'stdin.txt');
  const marker = path.join(dir, 'was-here');
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, 'claude'), [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> ${calls}`,
    `{ cat; printf '\\n<<КОНЕЦ>>\\n'; } >> ${inputs}`,
    `if [ -f ${marker} ]; then`,
    `  echo 'строка два' >> f.txt`,
    `  git -c user.name=t -c user.email=t@e.st add f.txt`,
    `  git -c user.name=t -c user.email=t@e.st commit -m 'доиграно' >/dev/null`,
    `  echo готово`,
    `  exit 0`,
    `fi`,
    `touch ${marker}`,
    `echo 'частичный результат'`,
    `exit 3`,
  ].join('\n') + '\n', { mode: 0o755 });
  process.env.PATH = `${bin}:${process.env.PATH}`;
  return {
    args: () => readFileSync(calls, 'utf8').trim().split('\n'),
    inputs: () => readFileSync(inputs, 'utf8').split('<<КОНЕЦ>>\n').slice(0, -1),
  };
}

test('resume: агент продолжает ту же сессию в том же worktree и доходит до publish', async () => {
  const dir = mkdtempSync(path.join(root, 'flaky-'));
  const calls = flakyClaude(dir);
  const published = [];

  // Заход 1 — агент падает, worktree с работой сохраняется.
  const first = runAction(spec(published), {}, {}, opts({ makeProvider: fakeJudge('approve') }));
  await assert.rejects(() => first.result, (e) => e instanceof CliError && e.code === 'agent_failed');
  assert.deepEqual(published, []);

  const meta1 = JSON.parse(readFileSync(path.join(runsDir, first.id, 'meta.json'), 'utf8'));
  assert.equal(meta1.state, 'failed');
  assert.equal(meta1.error.code, 'agent_failed');
  assert.ok(meta1.session_id, 'session_id сохранён для resume');
  assert.ok(existsSync(meta1.worktree), 'worktree сохранён');

  // Заход 2 — доигрывание: та же сессия, тот же worktree, publish.
  const second = runAction(spec(published), {}, {}, opts({ resumeOf: first.id, makeProvider: fakeJudge('approve') }));
  const res = await second.result;
  assert.equal(res.decision, 'approve');
  assert.deepEqual(published, ['push'], 'publish вызван после доигрывания');

  const [, resumed] = calls.args();
  assert.match(resumed, new RegExp(`--resume ${meta1.session_id}`), `не resume-сессия: ${resumed}`);
  assert.match(calls.inputs()[1], /Прошлый запуск прервался/);

  const meta2 = JSON.parse(readFileSync(path.join(runsDir, first.id, 'meta.json'), 'utf8'));
  assert.equal(meta2.state, 'done');
  assert.ok(existsSync(path.join(runsDir, first.id, 'result.json')), 'result.json записан');
  assert.equal(existsSync(meta1.worktree), false, 'worktree убран после успеха');
});

test('slimPre: сохраняет поля, нужные verify, и выкидывает workspace и дифф ветки', () => {
  const pre = {
    conflictFiles: ['a'], threads: [1], failed: [{ name: 'lint', tail: 'лог' }], comments: ['c'],
    diff: 'D', files: [{ path: 'a' }], rules: { text: 'r' },
    workspace: { x: 1 }, branch_diff: 'big', job_logs: 'big', result: { ok: true },
  };
  const slim = slimPre(pre);
  assert.deepEqual(slim.conflictFiles, ['a']);
  assert.deepEqual(slim.failed, [{ name: 'lint', tail: 'лог' }]);
  assert.deepEqual(slim.comments, ['c']);
  assert.equal(slim.diff, 'D');
  assert.equal(slim.workspace, undefined);
  assert.equal(slim.branch_diff, undefined);
  assert.equal(slim.job_logs, undefined);
  assert.equal(slim.result, undefined);
});

test('resume: не применим к судейскому провалу — подсказывает --judge-only', async () => {
  const run = createRun('resume-test', { root: runsDir });
  saveArtifact(run, 'meta.json', {
    id: run.id, action: 'resume-test', state: 'failed', worktree: project, pre: {},
    error: { code: 'judge_rejected', message: 'нет' },
  });
  const r = runAction(spec([]), {}, {}, opts({ resumeOf: run.id }));
  await assert.rejects(() => r.result, (e) => e.code === 'resume_not_applicable' && /judge-only/.test(e.message));
});

test('resume: без worktree — run_not_resumable', async () => {
  const run = createRun('resume-test', { root: runsDir });
  saveArtifact(run, 'meta.json', {
    id: run.id, action: 'resume-test', state: 'failed', pre: {}, worktree: path.join(root, 'нет-такого'),
    error: { code: 'agent_failed', message: 'нет' },
  });
  const r = runAction(spec([]), {}, {}, opts({ resumeOf: run.id }));
  await assert.rejects(() => r.result, (e) => e.code === 'run_not_resumable');
});

test('resume: живой ран — run_active', async () => {
  const run = createRun('resume-test', { root: runsDir });
  saveArtifact(run, 'meta.json', {
    id: run.id, action: 'resume-test', state: 'running', pre: {}, worktree: project, pid: process.pid,
    error: { code: 'agent_failed', message: 'нет' },
  });
  saveArtifact(run, 'events.jsonl', '{"t":"log","text":"жив"}\n');
  const r = runAction(spec([]), {}, {}, opts({ resumeOf: run.id }));
  await assert.rejects(() => r.result, (e) => e.code === 'run_active');
});

test('resume: неизвестный runId — run_not_found', async () => {
  const r = runAction(spec([]), {}, {}, opts({ resumeOf: 'нет-такого' }));
  await assert.rejects(() => r.result, (e) => e.code === 'run_not_found');
});
