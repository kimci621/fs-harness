import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runAction, extractRetryAfter } from '../src/engine.js';
import { createEventStream } from '../src/agent/events.js';
import { sumCosts } from '../src/costs.js';

function initGitRepo(dir) {
  execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'ignore' });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e.st', 'commit', '--allow-empty', '-m', 'init'], { cwd: dir, stdio: 'ignore' });
}

test('extractRetryAfter: распознаёт секунды, минуты и отдаёт дефолт 1800 при отсутствии', () => {
  assert.equal(extractRetryAfter('Rate limit reached. Retry after 45s.'), 45);
  assert.equal(extractRetryAfter('Rate limit exceeded. Please retry in 60 sec.'), 60);
  assert.equal(extractRetryAfter('Too many requests, retry in 5 minutes.'), 300);
  assert.equal(extractRetryAfter('Too many requests, retry after 2m.'), 120);
  assert.equal(extractRetryAfter('429 Too Many Requests'), 1800);
});

test('engine: envelope агента сохраняется в meta.json и уходит в costs.jsonl', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'fs-harness-cost-test-'));
  const project = path.join(root, 'repo');
  initGitRepo(project);
  const runsDir = path.join(root, 'runs');
  const costsRoot = path.join(root, 'state');

  const fakeSpec = {
    name: 'test-action',
    action: {
      title: 'Тестовое действие',
      target: 'none',
      writes: false,
      isolation: 'checkout',
      prompt: 'commit',
      agent: { default: 'cc' },
      judge: { gate: 'none', role: 'acceptance' },
      precheck: () => ({ workspace: { project } }),
      context: () => ({ pattern: 'feat' }),
      goal: () => 'тест',
      verify: () => ({ head_sha: '123' }),
      result: () => ({ ok: true }),
    },
  };

  const fakeSpawn = () => {
    const events = createEventStream();
    events.push({
      t: 'log',
      stream: 'stdout',
      text: JSON.stringify({
        type: 'result',
        result: 'Всё сделано',
        total_cost_usd: 0.1234,
        usage: { input_tokens: 100, output_tokens: 50 },
        duration_ms: 1200,
      }),
    });
    return {
      events,
      result: Promise.resolve({ ok: true, code: 0 }),
      abort: () => {},
    };
  };

  const run = runAction(
    fakeSpec,
    { cfg: { agents: { cc: { bin: 'claude' } } } },
    {},
    {
      agent: 'cc',
      runsDir,
      costsRoot,
      noJudge: true,
      yes: true,
      spawnAgentImpl: fakeSpawn,
    },
  );

  const res = await run.result;
  assert.equal(res.ok, true);

  const metaPath = path.join(runsDir, run.id, 'meta.json');
  assert.ok(existsSync(metaPath));
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  assert.deepEqual(meta.agent_cost, {
    cost_usd: 0.1234,
    usage: { input_tokens: 100, output_tokens: 50 },
    duration_ms: 1200,
  });

  const costs = sumCosts({ root: costsRoot });
  assert.equal(costs.runs_count, 1);
  assert.equal(costs.agent_cost_usd, 0.1234);

  rmSync(root, { recursive: true, force: true });
});

test('engine: rate-limit агента даёт agent_rate_limited с retry_after', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'fs-harness-rate-test-'));
  const project = path.join(root, 'repo');
  initGitRepo(project);
  const runsDir = path.join(root, 'runs');

  const fakeSpec = {
    name: 'test-rate',
    action: {
      title: 'Тест лимита',
      target: 'none',
      writes: false,
      isolation: 'checkout',
      prompt: 'commit',
      agent: { default: 'cc' },
      judge: { gate: 'none', role: 'acceptance' },
      precheck: () => ({ workspace: { project } }),
      context: () => ({ pattern: 'feat' }),
      goal: () => 'тест',
      verify: () => ({ head_sha: '123' }),
      result: () => ({ ok: true }),
    },
  };

  const fakeSpawn = () => {
    const events = createEventStream();
    events.push({
      t: 'log',
      stream: 'stderr',
      text: 'Error: 429 Too Many Requests. Rate limit reached, retry after 90 seconds.',
    });
    return {
      events,
      result: Promise.resolve({ ok: false, code: 1 }),
      abort: () => {},
    };
  };

  const run = runAction(
    fakeSpec,
    { cfg: { agents: { cc: { bin: 'claude' } } } },
    {},
    {
      agent: 'cc',
      runsDir,
      noJudge: true,
      yes: true,
      spawnAgentImpl: fakeSpawn,
    },
  );

  await assert.rejects(
    async () => await run.result,
    (err) => {
      assert.equal(err.code, 'agent_rate_limited');
      assert.equal(err.retry_after, 90);
      return true;
    },
  );

  const metaPath = path.join(runsDir, run.id, 'meta.json');
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  assert.equal(meta.error.code, 'agent_rate_limited');
  assert.equal(meta.error.retry_after, 90);

  rmSync(root, { recursive: true, force: true });
});
