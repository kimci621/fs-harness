import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runAction } from '../src/engine.js';
import { CliError } from '../src/errors.js';

let root;
let project;

before(() => {
  root = mkdtempSync(path.join(tmpdir(), 'fs-harness-approval-'));
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
  writeFileSync(path.join(project, '.fs-harness', 'prompts', 'approval-test.md'), '---\nvars: [where]\n---\nработай в {{where}}\n');
});

after(() => rmSync(root, { recursive: true, force: true }));

const metaOf = (run) => JSON.parse(readFileSync(path.join(root, 'runs', run.id, 'meta.json'), 'utf8'));

const verdict = (decision) => ({
  decision, confidence: 0.9, summary: 'тест', findings: [], checks: [], next: { action: 'push', hint: '' },
});

const fakeJudge = (decision) => async () => ({
  name: 'fake',
  complete: async () => ({ text: JSON.stringify(verdict(decision)), cost: 0 }),
});

function spec(published) {
  return {
    name: 'approval-test',
    kind: 'action',
    usage: 'approval-test',
    action: {
      title: 'тест аппрува', target: 'none', writes: true, isolation: 'ephemeral-worktree',
      prompt: 'approval-test', agent: { default: 'echo', allow: ['echo'] },
      judge: { gate: 'pre-push', role: 'acceptance' },
      precheck: () => ({ projectDir: project, workspace: { project, ref: 'main', baseRef: 'main', key: 'x' } }),
      context: ({ ws }) => ({ where: ws.dir }),
      goal: () => 'проверить интерактивный гейт',
      verify: ({ ws }) => ({ commits_ahead: 1, head_sha: 'deadbeef', diff: 'diff', dir: ws.dir }),
      publish: () => { published.push('push'); return {}; },
      result: ({ facts, verdict: v }) => ({ ok: true, dir: facts.dir, decision: v?.decision ?? null }),
    },
  };
}

const opts = (over) => ({
  agent: 'echo', yes: true, asObject: true, projectDir: project,
  runsDir: path.join(root, 'runs'),
  cfg: {
    agents: { echo: { bin: 'echo' }, claude: { bin: 'claude' } },
    workspace: { root: path.join(root, 'worktrees') },
    judge: { profiles: { fake: { provider: 'fake' } }, roles: { acceptance: ['fake'] } },
    telegram: { chat_id: '1', bot_token: 'tok', approvals: false, allowed_user_ids: [] },
  },
  ...over,
});

test('approvals:true — publish не зовётся, state pending_approval, nonce и worktree на месте', async () => {
  const published = [];
  const sinks = [];
  const o = opts({
    makeProvider: fakeJudge('reject'),
    cfg: {
      ...opts().cfg,
      telegram: { chat_id: '12345', bot_token: 'tok-123', approvals: true, allowed_user_ids: [7] },
    },
    approvalSink: async (info) => { sinks.push(info); },
  });
  const run = runAction(spec(published), {}, {}, o);
  let dir;
  run.on((ev) => { if (ev.t === 'phase' && ev.phase === 'isolate' && ev.status === 'done') dir = ev.detail; });
  const res = await run.result;
  assert.equal(res.pending_approval, true);
  assert.equal(res.ok, true);
  assert.deepEqual(published, [], 'publish не должен быть зван до кнопки');
  const meta = metaOf(run);
  assert.equal(meta.state, 'pending_approval');
  assert.ok(meta.approval?.nonce, 'nonce записан');
  assert.equal(meta.approval.run, run.id);
  assert.equal(meta.pid, null);
  assert.ok(existsSync(dir), 'worktree сохранён под кнопку');
  assert.ok(existsSync(path.join(root, 'runs', run.id, 'verdict.json')));
  assert.equal(existsSync(path.join(root, 'runs', run.id, 'result.json')), false, 'result.json нет — иначе listRuns покажет done');
  assert.equal(sinks.length, 1, 'approvalSink вызван');
  assert.equal(sinks[0].run, run.id);
  assert.equal(sinks[0].nonce, meta.approval.nonce);
});

test('approvals:false — publish зовётся, state done (регрессия дефолта)', async () => {
  const published = [];
  const run = runAction(spec(published), {}, {}, opts({ makeProvider: fakeJudge('approve') }));
  const res = await run.result;
  assert.deepEqual(published, ['push']);
  assert.equal(res.decision, 'approve');
  const meta = metaOf(run);
  assert.equal(meta.state, 'done');
  assert.ok(existsSync(path.join(root, 'runs', run.id, 'result.json')));
});

test('session_id пишется в meta.json (пункт плана, кладёт collect)', async () => {
  const run = runAction(spec([]), {}, {}, opts({
    makeProvider: fakeJudge('approve'),
    agent: 'echo',
    cfg: {
      ...opts().cfg,
      agents: {
        ...opts().cfg.agents,
        // family claude — SESSION_ARGS ставит --session-id, sessionId кладётся в meta
        echo: { bin: 'echo', family: 'claude' },
      },
    },
  }));
  const res = await run.result;
  assert.equal(res.ok, true);
  const meta = metaOf(run);
  assert.ok(meta.session_id, `session_id пустой: ${JSON.stringify(meta)}`);
});
