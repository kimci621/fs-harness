import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { publishRun, reviseRun, reconstructPre } from '../src/publish.js';
import { authHint, reopenRunWorkspace } from '../src/workspace.js';
import { createRun, saveArtifact } from '../src/agent/journal.js';
import { CliError } from '../src/errors.js';

let root;
let origin;
let project;
let runsDir;

const git = (args, cwd) =>
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=t@e.st', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

before(() => {
  root = mkdtempSync(path.join(tmpdir(), 'fs-harness-publish-'));
  origin = path.join(root, 'origin.git');
  project = path.join(root, 'project');
  runsDir = path.join(root, 'runs');
  git(['init', '--bare', '-b', 'main', origin], root);
  git(['clone', origin, project], root);
  writeFileSync(path.join(project, 'f.txt'), 'база\n');
  git(['add', 'f.txt'], project);
  git(['commit', '-m', 'база'], project);
  git(['push', 'origin', 'main'], project);
  git(['branch', 'dev'], project);
  git(['push', 'origin', 'dev'], project);
});

after(() => rmSync(root, { recursive: true, force: true }));

// Worktree с одним коммитом поверх origin/dev; возвращает {dir, head}.
function makeWorktree(name) {
  const dir = path.join(root, `wt-${name}`);
  git(['worktree', 'add', '--detach', dir, 'origin/dev'], project);
  writeFileSync(path.join(dir, 'f.txt'), `правка ${name}\n`);
  git(['add', 'f.txt'], dir);
  git(['commit', '-m', `коммит ${name}`], dir);
  return { dir, head: git(['rev-parse', 'HEAD'], dir) };
}

// Заглушка действия: publish записывает вызов, result отдаёт тот же контракт, что движок.
function stubSpec(published, { target = 'none', gate = 'pre-push' } = {}) {
  return {
    name: 'stub',
    action: {
      title: '', target, writes: true, isolation: 'ephemeral-worktree', prompt: 'x',
      agent: { default: 'claude' }, judge: { gate, role: 'acceptance' },
      publish: (x) => { published.push(x); return { pushed: true }; },
      result: (x) => ({ ok: true, run: x.run.id, pre: x.pre, head_sha: x.facts.head_sha, published: x.published }),
    },
  };
}

const verdict = (decision) => ({
  decision, confidence: 0.9, summary: 'ок', findings: [], checks: [], next: { action: 'push', hint: '' }, meta: { cost: 1.3, profile: 'opus-cli' },
});

// Ран на диске. pre=undefined -> ключа pre в meta нет (старый ран).
function makeRun({ action = 'stub', meta = {}, withVerdict = 'approve', result = null } = {}) {
  const run = createRun(action, { root: runsDir });
  saveArtifact(run, 'meta.json', { id: run.id, action, created_at: '2026-09-12T10:00:00.000Z', ...meta });
  if (withVerdict) saveArtifact(run, 'verdict.json', verdict(withVerdict));
  if (result) saveArtifact(run, 'result.json', result);
  return run;
}

const ctx = (over = {}) => ({
  repo: 'r/repo',
  cfg: { jira: { baseUrl: 'https://j.invalid' }, ci: { maxRetries: 2 } },
  g: {},
  jira: () => ({ issue: async (key) => ({ key, fields: { summary: 'Задача', description: 'текст' } }) }),
  ...over,
});

test('authHint: подсказка только для remote-команд и только на отказ доступа', () => {
  assert.match(authHint(['push', 'origin'], 'remote: HTTP Basic: Access denied.'), /нет доступа к origin/);
  assert.match(authHint(['fetch'], 'fatal: Authentication failed'), /нет доступа/);
  assert.equal(authHint(['push'], 'rejected non-fast-forward'), '');
  assert.equal(authHint(['rebase', 'main'], 'HTTP Basic: Access denied'), '');
  assert.equal(authHint(['diff'], 'что-то'), '');
});

test('publish: успешный доопублик — push, result.json, state done, worktree убран', async () => {
  const { dir, head } = makeWorktree('ok');
  const run = makeRun({ meta: { worktree: dir, project_dir: project, branch: 'fs-harness/ok', base: 'origin/dev', head_sha: head, facts: { commits_ahead: 1, deps_available: true }, pre: { branch: 'b', target: 'dev' } } });
  const published = [];
  const spec = stubSpec(published);
  spec.action.publish = (x) => { published.push(x); x.ws.git(['push', 'origin', `HEAD:refs/heads/fs-harness/publish-${run.id}`], x.ws.dir); return { pushed: true }; };

  const res = await publishRun(run.id, { ctx: ctx(), find: () => spec, runsDir });
  assert.equal(res.ok, true);
  assert.equal(published.length, 1);
  assert.equal(published[0].facts.head_sha, head);
  assert.ok(existsSync(path.join(runsDir, run.id, 'result.json')));
  const meta = JSON.parse(readFileSync(path.join(runsDir, run.id, 'meta.json'), 'utf8'));
  assert.equal(meta.state, 'done');
  assert.equal(meta.pid, null);
  assert.equal(meta.error, null);
  const events = readFileSync(path.join(runsDir, run.id, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).t, 'done');
  assert.equal(existsSync(dir), false, 'одноразовый worktree не убран после успеха');
});

test('publish: worktree ушёл вперёд — worktree_moved, publish не позван', async () => {
  const { dir } = makeWorktree('moved');
  writeFileSync(path.join(dir, 'f.txt'), 'ещё правка\n');
  git(['add', 'f.txt'], dir);
  git(['commit', '-m', 'лишний'], dir);
  const run = makeRun({ meta: { worktree: dir, project_dir: project, head_sha: 'deadbeef', facts: {} } });
  const published = [];
  await assert.rejects(
    () => publishRun(run.id, { ctx: ctx(), find: () => stubSpec(published), runsDir }),
    (e) => e.code === 'worktree_moved',
  );
  assert.deepEqual(published, []);
});

test('publish: нет вердикта и вердикт revise — run_not_approved', async () => {
  const { dir, head } = makeWorktree('noverdict');
  const noV = makeRun({ withVerdict: null, meta: { worktree: dir, project_dir: project, head_sha: head } });
  await assert.rejects(
    () => publishRun(noV.id, { ctx: ctx(), find: () => stubSpec([]), runsDir }),
    (e) => e.code === 'run_not_approved',
  );
  const rev = makeRun({ withVerdict: 'revise', meta: { worktree: dir, project_dir: project, head_sha: head } });
  await assert.rejects(
    () => publishRun(rev.id, { ctx: ctx(), find: () => stubSpec([]), runsDir }),
    (e) => e.code === 'run_not_approved',
  );
});

test('publish: уже опубликован — already_published, publish не позван', async () => {
  const { dir, head } = makeWorktree('done');
  const run = makeRun({ meta: { worktree: dir, project_dir: project, head_sha: head }, result: { ok: true } });
  const published = [];
  await assert.rejects(
    () => publishRun(run.id, { ctx: ctx(), find: () => stubSpec(published), runsDir }),
    (e) => e.code === 'already_published',
  );
  assert.deepEqual(published, []);
});

test('publish: worktree удалён — worktree_gone', async () => {
  const run = makeRun({ meta: { worktree: path.join(root, 'нет-такого'), project_dir: project, head_sha: 'x' } });
  await assert.rejects(
    () => publishRun(run.id, { ctx: ctx(), find: () => stubSpec([]), runsDir }),
    (e) => e.code === 'worktree_gone',
  );
});

test('publish: действие без publish — run_not_publishable', async () => {
  const run = makeRun({ action: 'analyze', meta: { worktree: project, project_dir: project, head_sha: 'x' } });
  await assert.rejects(
    () => publishRun(run.id, { ctx: ctx(), find: () => ({ action: { target: 'issue', judge: { gate: 'advisory' } } }), runsDir }),
    (e) => e.code === 'run_not_publishable',
  );
});

test('publish: legacy-ран implement без pre — контекст восстанавливается из meta', async () => {
  const { dir, head } = makeWorktree('legacy');
  const run = makeRun({
    action: 'implement',
    meta: {
      worktree: dir, project_dir: project, branch: 'feature/FD-1', target_branch: 'dev',
      issue: 'FD-1', repo: 'r/repo', head_sha: head, facts: { commits_ahead: 1 },
    },
  });
  const published = [];
  const spec = stubSpec(published, { target: 'issue' });
  const res = await publishRun(run.id, { ctx: ctx(), find: () => spec, runsDir });
  assert.equal(published.length, 1);
  assert.deepEqual(published[0].pre, { branch: 'feature/FD-1', target: 'dev', url: 'https://j.invalid/browse/FD-1' });
  assert.equal(published[0].target.key, 'FD-1');
  assert.equal(res.pre.url, 'https://j.invalid/browse/FD-1');
});

test('reconstructPre: ci-fix/conflict/threads/review', () => {
  assert.deepEqual(
    reconstructPre('ci-fix', { mr: 7, facts: { failed_jobs: ['lint', 'test'] } }, { ci: { maxRetries: 3 } }),
    { failed: [{ name: 'lint' }, { name: 'test' }], attempts: { done: 0, max: 3 } },
  );
  assert.equal(reconstructPre('ci-fix', { mr: 7, facts: { failed_jobs: [] } }), null);
  assert.deepEqual(reconstructPre('conflict', { mr: 7, source_branch: 's', conflict_files: ['a.ts'] }), { conflictFiles: ['a.ts'] });
  assert.deepEqual(reconstructPre('threads', { facts: { replies: [] } }), {});
  assert.equal(reconstructPre('threads', { facts: {} }), null);
  assert.equal(reconstructPre('review', { mr: 7 }), null);
  assert.equal(reconstructPre('implement', { branch: 'b' }), null);
});

test('publish: --dry-run проходит гарды, но publish не зовётся', async () => {
  const { dir, head } = makeWorktree('dry');
  const run = makeRun({ meta: { worktree: dir, project_dir: project, branch: 'b', base: 'origin/dev', head_sha: head, facts: {}, pre: {} } });
  const published = [];
  const res = await publishRun(run.id, { ctx: ctx(), find: () => stubSpec(published), runsDir, dryRun: true });
  assert.equal(res.dry_run, true);
  assert.equal(res.pre_source, 'meta');
  assert.deepEqual(published, []);
  assert.equal(existsSync(path.join(runsDir, run.id, 'result.json')), false);
});

test('reopenRunWorkspace: task-worktree не удаляется, ephemeral — удаляется', () => {
  const { dir, head } = makeWorktree('cleanup');
  const task = reopenRunWorkspace({ isolation: 'task-worktree', project_dir: project, worktree: dir, branch: 'fs-harness/cleanup', base: 'origin/dev' }, { isolation: 'task-worktree' });
  assert.equal(task.deps.available, true);
  task.cleanup(false);
  assert.ok(existsSync(dir), 'task-worktree снесён — ветка задачи потеряна');

  const eph = reopenRunWorkspace({ isolation: 'ephemeral-worktree', project_dir: project, worktree: dir, branch: 'fs-harness/cleanup', base: 'origin/dev' }, { isolation: 'ephemeral-worktree' });
  eph.cleanup(false);
  assert.equal(existsSync(dir), false);
  assert.equal(head.length, 40);
});

test('publish: неизвестный runId и живой ран', async () => {
  await assert.rejects(
    () => publishRun('нет-такого', { ctx: ctx(), find: () => stubSpec([]), runsDir }),
    (e) => e instanceof CliError && e.code === 'run_not_found',
  );
  const run = makeRun({ meta: { worktree: project, project_dir: project, head_sha: 'x', pid: process.pid } });
  saveArtifact(run, 'events.jsonl', '{"t":"log","text":"жив"}\n');
  await assert.rejects(
    () => publishRun(run.id, { ctx: ctx(), find: () => stubSpec([]), runsDir }),
    (e) => e.code === 'run_active',
  );
});

test('publish: pending_approval с approve — проходит; ветка уже на origin — already_published', async () => {
  const { dir, head } = makeWorktree('pending-ok');
  const run = makeRun({
    meta: {
      state: 'pending_approval', approval: { nonce: 'n', issued_at: new Date().toISOString() },
      worktree: dir, project_dir: project, branch: 'fs-harness/pending-ok', base: 'origin/dev',
      source_branch: 'fs-harness/pending-ok', head_sha: head, facts: { commits_ahead: 1 }, pre: {},
    },
  });
  const published = [];
  const spec = stubSpec(published);
  const res = await publishRun(run.id, { ctx: ctx(), find: () => spec, runsDir });
  assert.equal(res.ok, true);
  assert.equal(published.length, 1);

  // Отдельный worktree: после успеха первый уже убран, а origin уже на head_sha.
  const wt2 = path.join(root, 'wt-pushed');
  git(['worktree', 'add', '--detach', wt2, head], project);
  git(['push', 'origin', `HEAD:refs/heads/fs-harness/already-pushed`], wt2);
  const run2 = makeRun({
    meta: {
      state: 'pending_approval', approval: { nonce: 'n2', issued_at: new Date().toISOString() },
      worktree: wt2, project_dir: project, branch: 'fs-harness/already-pushed',
      source_branch: 'fs-harness/already-pushed', head_sha: head, facts: {}, pre: {},
    },
  });
  const pub2 = [];
  await assert.rejects(
    () => publishRun(run2.id, { ctx: ctx(), find: () => stubSpec(pub2), runsDir }),
    (e) => e.code === 'already_published',
  );
  assert.deepEqual(pub2, []);
});

test('publish: истёкший аппрув — approval_expired, worktree убран', async () => {
  const { dir, head } = makeWorktree('expired');
  const run = makeRun({
    meta: {
      state: 'pending_approval',
      approval: { nonce: 'old', issued_at: '2026-01-01T00:00:00.000Z' },
      worktree: dir, project_dir: project, branch: 'fs-harness/expired',
      head_sha: head, facts: {}, pre: {},
    },
  });
  const published = [];
  await assert.rejects(
    () => publishRun(run.id, { ctx: ctx(), find: () => stubSpec(published), runsDir }),
    (e) => e.code === 'approval_expired',
  );
  assert.deepEqual(published, []);
  // onExpired убирает worktree
  assert.equal(existsSync(dir), false, 'просроченный worktree убран');
});

test('publish: rejected — run_not_pending', async () => {
  const { dir, head } = makeWorktree('rej');
  const run = makeRun({
    meta: { state: 'rejected', worktree: dir, project_dir: project, head_sha: head, facts: {}, pre: {} },
  });
  await assert.rejects(
    () => publishRun(run.id, { ctx: ctx(), find: () => stubSpec([]), runsDir }),
    (e) => e.code === 'run_not_pending',
  );
});

test('reviseRun: resume-аргументы ушли, после approve и approvals:true снова pending с новым nonce', async () => {
  const { dir, head } = makeWorktree('revise');
  const run = makeRun({
    withVerdict: 'reject',
    meta: {
      state: 'pending_approval', session_id: 'sid-1', agent: 'claude',
      approval: { nonce: 'n-old', issued_at: new Date().toISOString(), run: 'x' },
      worktree: dir, project_dir: project, branch: 'fs-harness/revise', base: 'origin/dev',
      head_sha: head, facts: { commits_ahead: 1, deps_available: true },
      judge: { role: 'acceptance' }, goal: 'сделать', mr: 9, source_branch: 'fs-harness/revise',
    },
  });

  const spawns = [];
  const sinks = [];
  const cfg = {
    jira: { baseUrl: 'https://j.invalid' },
    agents: { claude: { bin: 'claude', family: 'claude' } },
    judge: { profiles: { fake: { provider: 'fake' } }, roles: { acceptance: ['fake'] } },
    telegram: { chat_id: '1', bot_token: 't', approvals: true, allowed_user_ids: [1] },
  };
  const ctxC = {
    repo: 'r/repo',
    cfg,
    g: {},
    jira: () => ({ issue: async (key) => ({ key, fields: { summary: 'З', description: 'т' } }) }),
  };
  const a = {
    action: {
      title: '', target: 'none', writes: true, isolation: 'ephemeral-worktree', prompt: 'x',
      agent: { default: 'claude' }, judge: { gate: 'pre-push', role: 'acceptance' },
      verify: async (x) => ({ ...x.facts, head_sha: head, commits_ahead: 1, diff: 'd' }),
      goal: () => 'цель',
      publish: () => ({ pushed: true }),
      result: (x) => ({ ok: true, run: x.run.id }),
    },
  };

  const res = await reviseRun(run.id, {
    ctx: ctxC,
    find: () => a,
    runsDir,
    makeProvider: async () => ({
      name: 'fake',
      complete: async () => ({
        text: JSON.stringify({ decision: 'approve', confidence: 0.9, summary: 'ок', findings: [], checks: [], next: { action: 'push', hint: '' } }),
        cost: 0,
      }),
    }),
    spawn: async (x, text, o) => {
      spawns.push({ sessionId: x.sessions?.main, resume: o.resume, text });
      return 'агент доделал';
    },
    approvalSink: async (info) => { sinks.push(info); },
  });

  assert.equal(res.pending_approval, true);
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].sessionId, 'sid-1', 'resume по session_id из meta');
  assert.equal(spawns[0].resume, true);
  assert.match(spawns[0].text, /Приёмка вернула работу на доделку/);
  assert.equal(sinks.length, 1);
  assert.notEqual(sinks[0].nonce, 'n-old', 'новый nonce');

  const meta = JSON.parse(readFileSync(path.join(runsDir, run.id, 'meta.json'), 'utf8'));
  assert.equal(meta.state, 'pending_approval');
  assert.notEqual(meta.approval.nonce, 'n-old');
  const v = JSON.parse(readFileSync(path.join(runsDir, run.id, 'verdict.json'), 'utf8'));
  assert.equal(v.decision, 'approve');
  assert.equal(existsSync(path.join(runsDir, run.id, 'result.json')), false);
});

test('reviseRun: нет сессии — no_session; не pending — run_not_pending', async () => {
  const { dir, head } = makeWorktree('revise-bad');
  const noSid = makeRun({
    meta: {
      state: 'pending_approval', worktree: dir, project_dir: project, head_sha: head,
      approval: { nonce: 'n', issued_at: new Date().toISOString() }, facts: {},
    },
  });
  await assert.rejects(
    () => reviseRun(noSid.id, { ctx: ctx(), find: () => stubSpec([]), runsDir }),
    (e) => e.code === 'no_session',
  );
  const notPending = makeRun({
    meta: { state: 'done', session_id: 's', worktree: dir, project_dir: project, head_sha: head },
    result: { ok: true },
  });
  await assert.rejects(
    () => reviseRun(notPending.id, { ctx: ctx(), find: () => stubSpec([]), runsDir }),
    (e) => e.code === 'run_not_pending',
  );
});
