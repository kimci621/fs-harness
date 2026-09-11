import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runAction } from '../src/engine.js';
import { readEvents } from '../src/agent/journal.js';
import { CliError } from '../src/errors.js';

let root;
let project;

before(() => {
  root = mkdtempSync(path.join(tmpdir(), 'fs-harness-gate-'));
  const origin = path.join(root, 'origin.git');
  project = path.join(root, 'project');
  const git = (args, cwd) =>
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=t@e.st', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '--bare', '-b', 'main', origin], root);
  git(['clone', origin, project], root);
  writeFileSync(path.join(project, 'f.txt'), 'файл\n');
  git(['add', 'f.txt'], project);
  git(['commit', '-m', 'база'], project);
  git(['push', 'origin', 'main'], project);
  mkdirSync(path.join(project, '.fs-harness', 'prompts'), { recursive: true });
  writeFileSync(path.join(project, '.fs-harness', 'prompts', 'gate-test.md'), '---\nvars: [where]\n---\nработай в {{where}}\n');
});

after(() => rmSync(root, { recursive: true, force: true }));

const verdict = (decision) => ({
  decision, confidence: 0.9, summary: 'тест', findings: [], checks: [], next: { action: 'push', hint: '' },
});

const fakeJudge = (decision) => async () => ({
  name: 'fake',
  complete: async () => ({ text: JSON.stringify(verdict(decision)), cost: 0 }),
});

// Действие-пустышка на настоящем движке: агент — /bin/echo, публикация только считает вызовы.
function spec(published) {
  return {
    name: 'gate-test',
    kind: 'action',
    usage: 'gate-test',
    action: {
      title: 'тест гейта', target: 'none', writes: true, isolation: 'ephemeral-worktree',
      prompt: 'gate-test', agent: { default: 'echo', allow: ['echo'] },
      judge: { gate: 'pre-push', role: 'acceptance' },
      precheck: () => ({ projectDir: project, workspace: { project, ref: 'main', baseRef: 'main', key: 'x' } }),
      context: ({ ws }) => ({ where: ws.dir }),
      goal: () => 'проверить гейт',
      verify: ({ ws }) => ({ commits_ahead: 1, head_sha: 'deadbeef', diff: 'diff', dir: ws.dir }),
      publish: () => { published.push('push'); return {}; },
      result: ({ facts, verdict: v }) => ({ ok: true, dir: facts.dir, decision: v?.decision ?? null }),
    },
  };
}

const opts = (over) => ({
  agent: 'echo', yes: true, asObject: true, projectDir: project,
  runsDir: path.join(root, 'runs'),
  cfg: { workspace: { root: path.join(root, 'worktrees') }, judge: { profiles: { fake: { provider: 'fake' } }, roles: { acceptance: ['fake'] } } },
  ...over,
});

test('гейт: reject — publish не зовётся, worktree остаётся с работой агента', async () => {
  const published = [];
  const run = runAction(spec(published), {}, {}, opts({ makeProvider: fakeJudge('reject') }));
  let dir;
  run.on((ev) => { if (ev.t === 'phase' && ev.phase === 'isolate' && ev.status === 'done') dir = ev.detail; });
  await assert.rejects(() => run.result, (e) => e instanceof CliError && e.code === 'judge_rejected');
  assert.deepEqual(published, []);
  assert.ok(existsSync(dir), 'worktree снесён вместе с работой агента');
});

test('гейт: approve — publish зовётся, worktree убран, события легли в журнал', async () => {
  const published = [];
  const run = runAction(spec(published), {}, {}, opts({ makeProvider: fakeJudge('approve') }));
  const res = await run.result;
  assert.deepEqual(published, ['push']);
  assert.equal(res.decision, 'approve');
  assert.equal(existsSync(res.dir), false);

  // Журнал рана переживает и уборку worktree, и закрытие процесса.
  const events = readEvents({ dir: path.join(root, 'runs', run.id) });
  const phases = events.filter((e) => e.t === 'phase' && e.status === 'done').map((e) => e.phase);
  assert.ok(phases.includes('judge') && phases.includes('publish'), phases.join(', '));
  assert.equal(events.at(-1).t, 'done');
});

test('гейт: --no-judge пушит без вердикта', async () => {
  const published = [];
  const res = await runAction(spec(published), {}, {}, opts({ noJudge: true })).result;
  assert.deepEqual(published, ['push']);
  assert.equal(res.decision, null);
});

test('гейт: падение бэкенда судьи тоже закрывает гейт и бережёт worktree', async () => {
  const published = [];
  const boom = async () => ({ name: 'fake', complete: async () => { throw new CliError('бэкенд молчит', 1, 'judge_failed'); } });
  const run = runAction(spec(published), {}, {}, opts({ makeProvider: boom }));
  let dir;
  run.on((ev) => { if (ev.t === 'phase' && ev.phase === 'isolate' && ev.status === 'done') dir = ev.detail; });
  await assert.rejects(() => run.result, (e) => e.code === 'judge_failed');
  assert.deepEqual(published, []);
  assert.ok(existsSync(dir), 'worktree снесён при сбое судьи');
});

// Судья по очереди: сначала revise, потом что скажут. Заодно считает свои заходы.
const judgeQueue = (decisions) => {
  const left = [...decisions];
  return async () => ({ name: 'fake', complete: async () => ({ text: JSON.stringify(verdict(left.shift() ?? 'approve')), cost: 0 }) });
};

// Поддельный агент с именем claude: пишет свои аргументы в файл и что-то отвечает.
function fakeClaude(dir) {
  const bin = path.join(dir, 'bin');
  const calls = path.join(dir, 'calls.txt');
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${calls}\necho готово\n`, { mode: 0o755 });
  process.env.PATH = `${bin}:${process.env.PATH}`;
  return () => readFileSync(calls, 'utf8').trim().split('\n');
}

test('revise: агент доделывает в той же сессии, второй вердикт пускает push', async () => {
  const dir = mkdtempSync(path.join(root, 'revise-'));
  const calls = fakeClaude(dir);
  const published = [];
  const res = await runAction(spec(published), {}, {}, opts({
    agent: 'claude',
    makeProvider: judgeQueue(['revise', 'approve']),
  })).result;

  const [first, second] = calls();
  const id = first.match(/--session-id (\S+)/)?.[1];
  assert.ok(id, `сессия не задана: ${first}`);
  assert.match(second, new RegExp(`--resume ${id}`));
  assert.match(second, /вернула работу на доделку/);
  assert.deepEqual(published, ['push']);
  assert.equal(res.decision, 'approve');
});

test('revise: лимит 0 — доделки нет, гейт закрыт', async () => {
  const dir = mkdtempSync(path.join(root, 'revise0-'));
  const calls = fakeClaude(dir);
  const published = [];
  const o = opts({ agent: 'claude', makeProvider: judgeQueue(['revise', 'approve']) });
  o.cfg.judge.maxRevise = 0;
  await assert.rejects(() => runAction(spec(published), {}, {}, o).result, (e) => e.code === 'judge_rejected');
  assert.equal(calls().length, 1);
  assert.deepEqual(published, []);
});

test('judge.enabled=false — приёмки нет, как при --no-judge', async () => {
  const published = [];
  const o = opts({});
  o.cfg.judge.enabled = false;
  const res = await runAction(spec(published), {}, {}, o).result;
  assert.deepEqual(published, ['push']);
  assert.equal(res.decision, null);
});
