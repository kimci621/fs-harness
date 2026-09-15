import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { threadsAction } from '../src/actions/threads.js';
import { conflictAction } from '../src/actions/conflict.js';
import { runAction, runActionCLI, judgeRun } from '../src/engine.js';
import { readEvents } from '../src/agent/journal.js';
import { CliError } from '../src/errors.js';

// Полные циклы действий на настоящем движке и настоящем git: фейковые — только
// агент (sh-скрипты), GitLab (g) и судья (makeProvider). Пуш идёт в локальный bare.

let root;
let origin;
let project;
let runsRoot;
let bin;

const git = (args, cwd = project) =>
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=t@e.st', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

before(() => {
  root = mkdtempSync(path.join(tmpdir(), 'fs-harness-e2e-'));
  origin = path.join(root, 'origin.git');
  project = path.join(root, 'project');
  runsRoot = path.join(root, 'runs');
  bin = path.join(root, 'bin');
  mkdirSync(bin, { recursive: true });

  // target и source расходятся в app.txt → merge-tree даёт конфликт для conflict-сценариев.
  git(['init', '--bare', '-b', 'target', origin], root);
  git(['clone', origin, project], root);
  git(['config', 'user.name', 'test'], project);
  git(['config', 'user.email', 't@e.st'], project);
  writeFileSync(path.join(project, 'app.txt'), 'база\n');
  git(['add', 'app.txt'], project);
  git(['commit', '-m', 'база'], project);
  git(['push', 'origin', 'target'], project);
  git(['checkout', '-b', 'source'], project);
  writeFileSync(path.join(project, 'app.txt'), 'source\n');
  git(['commit', '-am', 'правка source'], project);
  git(['push', 'origin', 'source'], project);
  git(['checkout', 'target'], project);
  writeFileSync(path.join(project, 'app.txt'), 'target\n');
  git(['commit', '-am', 'правка target'], project);
  git(['push', 'origin', 'target'], project);
  git(['checkout', 'source'], project);
  // `same` — ветка без расхождений с target: сценарий «конфликтов нет».
  git(['branch', 'same', 'target'], project);
  git(['push', 'origin', 'same'], project);
  // `conflict-src` расходится с target как и source: full-cycle пушит merge-коммит в неё,
  // а не в source — иначе следующие conflict-тесты видят уже смерженную ветку и уходят в skip.
  git(['branch', 'conflict-src', 'source'], project);
  git(['push', 'origin', 'conflict-src'], project);
  // `conflict-stage` — своя ветка тесту «целевая джоба стала manual позже»: он тоже пушит
  // мерж, и без отдельной ветки следующие conflict-тесты уйдут в skip.
  git(['branch', 'conflict-stage', 'source'], project);
  git(['push', 'origin', 'conflict-stage'], project);

  // Скрипты фейковых агентов: claude в headless-режиме — stream-json в stdout.
  const agent = (name, body) => {
    const file = path.join(bin, name);
    writeFileSync(file, `#!/bin/sh\ncat > /dev/null\n${body}\n`, { mode: 0o755 });
    chmodSync(file, 0o755);
    return file;
  };
  agent('threads-bot', [
    'echo \'правка по треду\' >> note.txt',
    'git add -A && git commit -m "fix: правка по тредам" >/dev/null',
    'd=$(ls -td "$RUNS"/threads-* | head -1)',
    "printf '%s' '[{\"id\":\"aaa1\",\"reply\":\"поправлено в коммите\",\"resolve\":true}]' > \"$d/replies.json\"",
    'echo \'{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"npm test"}}]}}\'',
    'echo \'{"type":"result","subtype":"success","result":"готово: правки внесены"}\'',
  ].join('\n'));
  agent('threads-reply-bot', [
    'd=$(ls -td "$RUNS"/threads-* | head -1)',
    "printf '%s' '[{\"id\":\"aaa1\",\"reply\":\"код уже правильный\",\"resolve\":false}]' > \"$d/replies.json\"",
    'echo \'{"type":"result","subtype":"success","result":"ответы подготовлены"}\'',
  ].join('\n'));
  agent('threads-broken', [
    'echo \'правка\' >> note.txt',
    'git add -A && git commit -m "fix" >/dev/null',
    'echo \'{"type":"result","subtype":"success","result":"сделано"}\'',
  ].join('\n'));
  agent('threads-crash', [
    // Коммит сделал, отчёт не выдал, упал — как живой агент, убитый посреди работы.
    'echo \'правка\' >> note.txt',
    'git add -A && git commit -m "fix: упал после коммита" >/dev/null',
    'echo \'{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"npm test"}}]}}\'',
    'exit 3',
  ].join('\n'));
  agent('conflict-bot', [
    'git merge --no-edit origin/target >/dev/null 2>&1 || true',
    "printf 'source\\ntarget\\nрешено обе стороны\\n' > app.txt",
    'git add -A && git commit -m "merge: решён конфликт" >/dev/null',
    'echo \'{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"app.txt"}}]}}\'',
    'echo \'{"type":"result","subtype":"success","result":"мерж закрыт"}\'',
  ].join('\n'));
  agent('conflict-noop', [
    'git merge --no-edit origin/target >/dev/null 2>&1 || true',
    'echo \'{"type":"result","subtype":"success","result":"конфликт решён"}\'',
  ].join('\n'));
  agent('conflict-idle', [
    'echo \'{"type":"result","subtype":"success","result":"я ничего не делал"}\'',
  ].join('\n'));
});

after(() => rmSync(root, { recursive: true, force: true }));

const discussions = [
  { id: 'aaa1', notes: [{ resolvable: true, resolved: false, system: false, author: { username: 'rev' }, body: 'тут утечка', position: { new_path: 'app.txt', new_line: 1 } }] },
  { id: 'zzz9', notes: [{ resolvable: true, resolved: true, system: false, author: { username: 'rev' }, body: 'уже решено' }] },
];

const makeG = (over = {}) => {
  const calls = { replied: [], resolved: [], played: [] };
  const g = {
    getMR: async (_repo, iid) => ({
      iid: Number(iid), title: 'тестовый MR', web_url: 'http://x/mr', sha: 'abc',
      source_branch: 'source', target_branch: 'target', head_pipeline: null,
    }),
    getDiscussions: async () => discussions,
    replyDiscussion: async (_repo, _iid, id, text) => { calls.replied.push({ id, text }); },
    resolveDiscussion: async (_repo, _iid, id) => { calls.resolved.push(id); },
    createMRPipeline: async () => ({ id: 9, status: 'created', web_url: 'http://x/p9' }),
    getPipeline: async (_repo, id) => ({ id, status: 'success', web_url: 'http://x/p9' }),
    getJobs: async () => [{ id: 5, name: 'build_image', stage: 'build', status: 'success', web_url: 'http://x/j5' }],
    playJob: async (_repo, id) => { calls.played.push(id); return { id, status: 'running' }; },
    retryJob: async (_repo, id) => ({ id: id + 1, status: 'running' }),
    getJob: async (_repo, id) => ({ id, name: 'build_image', status: 'success', web_url: 'http://x/j5' }),
    ...over,
  };
  return { g, calls };
};

const verdict = (decision) => ({
  decision, confidence: 0.9, summary: 'тест', findings: [], checks: [], next: { action: 'push', hint: '' },
});
const fakeJudge = (decision) => async () => ({ name: 'fake', complete: async () => ({ text: JSON.stringify(verdict(decision)), cost: 0 }) });

const opts = (over = {}) => ({
  agent: 'threads-bot', yes: true, asObject: true, projectDir: project,
  runsDir: runsRoot,
  cfg: {
    agents: {
      'threads-bot': { bin: path.join(bin, 'threads-bot'), env: { RUNS: runsRoot } },
      'threads-reply-bot': { bin: path.join(bin, 'threads-reply-bot'), env: { RUNS: runsRoot } },
      'threads-broken': { bin: path.join(bin, 'threads-broken'), env: { RUNS: runsRoot } },
      'threads-crash': { bin: path.join(bin, 'threads-crash'), env: { RUNS: runsRoot } },
      'conflict-bot': { bin: path.join(bin, 'conflict-bot') },
      'conflict-noop': { bin: path.join(bin, 'conflict-noop') },
      'conflict-idle': { bin: path.join(bin, 'conflict-idle') },
    },
    workspace: { root: path.join(root, 'worktrees'), deps: { strategy: 'none' } },
    judge: { enabled: true, maxRevise: 1, profiles: { fake: { provider: 'fake' } }, roles: { acceptance: ['fake'] } },
    checks: [],
  },
  ...over,
});

const originSha = (branch = 'source') =>
  execFileSync('git', ['ls-remote', origin, `refs/heads/${branch}`], { encoding: 'utf8' }).trim().split(/\s+/)[0];

test('threads: полный цикл — агент, судья approve, push, ответы, резолв', async () => {
  const { g, calls } = makeG();
  const res = await runActionCLI(threadsAction, { g, repo: 'r/r' }, ['7'], opts({ makeProvider: fakeJudge('approve') }));

  assert.equal(res.ok, true);
  assert.equal(res.commits_ahead, 1);
  assert.deepEqual(res.replied, ['aaa1']);
  assert.deepEqual(res.resolved, ['aaa1']);
  assert.match(calls.replied[0].text, /поправлено в коммите/);
  assert.equal(originSha(), res.head_sha, 'push не дошёл до origin');

  // Журнал: метки времени везде, активность агента записана, фазы закрыты по порядку.
  const events = readEvents({ dir: path.join(runsRoot, res.run) });
  assert.ok(events.length > 5);
  assert.ok(events.every((e) => e.at), 'у события нет метки времени');
  assert.ok(events.some((e) => e.t === 'log' && e.stream === 'activity' && e.text.includes('Bash')), 'активность агента не в журнале');
  const phases = events.filter((e) => e.t === 'phase' && e.status === 'done').map((e) => e.phase);
  assert.deepEqual(phases, ['isolate', 'context', 'prompt', 'agent', 'verify', 'judge', 'publish']);
  const prompt = readFileSync(path.join(runsRoot, res.run, 'prompt.md'), 'utf8');
  assert.match(prompt, /aaa1/);
  assert.match(readFileSync(path.join(runsRoot, res.run, 'agent.txt'), 'utf8'), /готово: правки внесены/, 'в agent.txt должен быть отчёт из result, а не сырой JSON');
});

test('threads: судья reject — ответы не отправлены, пуша нет, worktree с работой сохранён', async () => {
  const before = originSha();
  const { g, calls } = makeG();
  const o = opts({ makeProvider: fakeJudge('reject') });
  const run = runAction(threadsAction, { g, repo: 'r/r' }, { query: '7' }, o);
  let dir;
  run.on((ev) => { if (ev.t === 'phase' && ev.phase === 'isolate' && ev.status === 'done') dir = ev.detail; });
  await assert.rejects(() => run.result, (e) => e instanceof CliError && e.code === 'judge_rejected');
  assert.deepEqual(calls.replied, [], 'ответы уехали без approve');
  assert.deepEqual(calls.resolved, []);
  assert.equal(originSha(), before, 'push прошёл без approve');
  assert.ok(existsSync(dir), 'worktree снесён вместе с работой агента');
});

test('threads: агент ответил без правок кода — пуша нет, ответы уходят', async () => {
  const before = originSha();
  const { g, calls } = makeG();
  const res = await runActionCLI(threadsAction, { g, repo: 'r/r' }, ['7'], opts({
    agent: 'threads-reply-bot', makeProvider: fakeJudge('approve'),
  }));
  assert.equal(res.ok, true);
  assert.equal(res.commits_ahead, 0);
  assert.deepEqual(res.replied, ['aaa1']);
  assert.equal(originSha(), before, 'пуш без коммитов');
});

test('threads: агент закоммитил, но не записал replies.json — agent_failed', async () => {
  const { g } = makeG();
  await assert.rejects(
    () => runActionCLI(threadsAction, { g, repo: 'r/r' }, ['7'], opts({ agent: 'threads-broken', makeProvider: fakeJudge('approve') })),
    (e) => e.code === 'agent_failed' && /replies\.json/.test(e.message),
  );
});

test('threads: агент упал посреди работы — agent_failed с кодом, пуша нет, worktree сохранён', async () => {
  const before = originSha();
  const { g, calls } = makeG();
  const o = opts({ agent: 'threads-crash', makeProvider: fakeJudge('approve') });
  const run = runAction(threadsAction, { g, repo: 'r/r' }, { query: '7' }, o);
  let dir;
  run.on((ev) => { if (ev.t === 'phase' && ev.phase === 'isolate' && ev.status === 'done') dir = ev.detail; });
  await assert.rejects(() => run.result, (e) => e.code === 'agent_failed' && /кодом 3/.test(e.message));
  assert.equal(originSha(), before, 'push прошёл после падения агента');
  assert.deepEqual(calls.replied, [], 'ответы уехали без approve');
  assert.ok(existsSync(dir), 'worktree снесён вместе с работой агента');
});

test('threads: нет открытых тредов — skip до создания worktree', async () => {
  const { g } = makeG({ getDiscussions: async () => discussions.filter((d) => d.id === 'zzz9') });
  const res = await runActionCLI(threadsAction, { g, repo: 'r/r' }, ['7'], opts({ makeProvider: fakeJudge('approve') }));
  assert.equal(res.skipped, true);
  assert.equal(res.threads_open, 0);
});

test('conflict: полный цикл — мерж, судья approve, push, пайплайн и build', async () => {
  // Джоба при первом опросе manual (её играют), дальше — success (ждать нечего).
  // Пуш идёт в conflict-src: source нужна следующим тестам расходящейся.
  let jobsCalled = 0;
  const { g, calls } = makeG({
    getMR: async (_repo, iid) => ({
      iid: Number(iid), title: 'тестовый MR', web_url: 'http://x/mr', sha: 'abc',
      source_branch: 'conflict-src', target_branch: 'target', head_pipeline: null,
    }),
    getJobs: async () => {
      const status = jobsCalled++ === 0 ? 'manual' : 'success';
      return [{ id: 5, name: 'build_image', stage: 'build', status, web_url: 'http://x/j5' }];
    },
  });
  const res = await runActionCLI(conflictAction, { g, repo: 'r/r' }, ['7'], opts({
    agent: 'conflict-bot', makeProvider: fakeJudge('approve'),
  }));
  assert.equal(res.ok, true);
  assert.deepEqual(res.conflict_files, ['app.txt']);
  assert.ok(res.commits_ahead >= 1);
  assert.equal(res.pipeline.id, 9);
  assert.equal(res.build.status, 'success');
  assert.deepEqual(calls.played, [5], 'manual-джоба не сыграна');
  assert.equal(originSha('conflict-src'), res.head_sha, 'push не дошёл до origin');
});

test('conflict: агент оставил мерж незавершённым — agent_failed, пуша нет', async () => {
  const before = originSha();
  const { g } = makeG();
  const o = opts({ agent: 'conflict-noop', makeProvider: fakeJudge('approve') });
  const run = runAction(conflictAction, { g, repo: 'r/r' }, { query: '7' }, o);
  let dir;
  run.on((ev) => { if (ev.t === 'phase' && ev.phase === 'isolate' && ev.status === 'done') dir = ev.detail; });
  await assert.rejects(() => run.result, (e) => e.code === 'agent_failed' && /Мерж не завершён/.test(e.message) && /app\.txt/.test(e.message));
  assert.equal(originSha(), before, 'push прошёл при незавершённом мерже');
  assert.ok(existsSync(dir), 'worktree снесён');
});

test('conflict: агент ничего не сделал — agent_failed «не создал коммитов»', async () => {
  const { g } = makeG();
  await assert.rejects(
    () => runActionCLI(conflictAction, { g, repo: 'r/r' }, ['7'], opts({ agent: 'conflict-idle', makeProvider: fakeJudge('approve') })),
    (e) => e.code === 'agent_failed' && /не создал коммитов/.test(e.message),
  );
});

test('conflict: build-джоба ещё created (стадия tests идёт) — waitJob играет её, когда станет manual', async () => {
  // Живой случай: после push пайплайн новый, build сначала created, manual — только когда
  // отработает стадия tests. Раньше startJob на created ничего не делал, и ожидание упиралось
  // в таймаут хотя джобу надо было просто play.
  let polls = 0;
  const { g, calls } = makeG({
    getMR: async (_repo, iid) => ({
      iid: Number(iid), title: 'тестовый MR', web_url: 'http://x/mr', sha: 'abc',
      source_branch: 'conflict-stage', target_branch: 'target', head_pipeline: null,
    }),
    getJobs: async () => {
      polls += 1;
      const status = polls === 1 ? 'created' : polls === 2 ? 'manual' : 'success';
      return [{ id: 5, name: 'build_image', stage: 'build', status, web_url: 'http://x/j5' }];
    },
  });
  const res = await runActionCLI(conflictAction, { g, repo: 'r/r' }, ['7'], opts({
    agent: 'conflict-bot', makeProvider: fakeJudge('approve'), intervalMs: 5,
  }));
  assert.equal(res.ok, true);
  assert.equal(res.build.status, 'success');
  assert.deepEqual(calls.played, [5], 'manual-джоба не сыграна после того, как стадия дошла');
});

test('conflict: конфликтов нет — skip, агент не запускается', async () => {
  const { g } = makeG({ getMR: async () => ({ iid: 8, title: 'чистый MR', web_url: 'http://x/8', source_branch: 'same', target_branch: 'target', head_pipeline: null }) });
  const res = await runActionCLI(conflictAction, { g, repo: 'r/r' }, ['8'], opts({ makeProvider: fakeJudge('approve') }));
  assert.equal(res.skipped, true);
  assert.equal(res.has_conflicts, false);
});

test('judgeRun: приёмка по сохранённым артефактам рана, без worktree', async () => {
  const { g } = makeG();
  const run = await runActionCLI(threadsAction, { g, repo: 'r/r' }, ['7'], opts({ makeProvider: fakeJudge('approve') }));
  const res = await judgeRun(run.run, { runsDir: runsRoot, asObject: true, cfg: opts().cfg, makeProvider: fakeJudge('approve') });
  assert.equal(res.ok, true);
  assert.equal(res.judge_only, true);
  assert.equal(res.verdict.decision, 'approve');
  assert.ok(existsSync(path.join(runsRoot, run.run, 'verdict.json')));
});
