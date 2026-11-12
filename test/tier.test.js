import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pickTier } from '../src/tier.js';
import { runAction, spawnSession } from '../src/engine.js';
import { createEventStream } from '../src/agent/events.js';
import { DEFAULTS } from '../src/config.js';

const cfg = { tiers: DEFAULTS.tiers, classify: DEFAULTS.classify, agents: DEFAULTS.agents };
const issue = { key: 'FD-1', fields: { summary: 'Поменять способ оплаты', description: 'рассрочка' } };
const answer = (choice) => async () => ({ tier: { choice, p: choice ? 0.9 : 0.4 } });

test('pickTier: уверенный ответ, неуверенный — medium, сбой и выключатель — null', async () => {
  assert.equal(await pickTier(issue, cfg, answer('hard')), 'hard');
  assert.equal(await pickTier(issue, cfg, answer(null)), 'medium');
  assert.equal(await pickTier(issue, cfg, async () => null), null);
  assert.equal(await pickTier(issue, { ...cfg, tiers: { ...cfg.tiers, enabled: false } }, answer('hard')), null);
});

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'fs-harness-tier-'));
  const project = path.join(root, 'repo');
  execFileSync('git', ['init', '-b', 'main', project], { stdio: 'ignore' });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e.st', 'commit', '--allow-empty', '-m', 'init'], { cwd: project, stdio: 'ignore' });
  const spec = {
    name: 'test-tier',
    action: {
      title: 'Тест уровней',
      target: 'issue',
      writes: false,
      isolation: 'checkout',
      prompt: 'commit',
      agent: { default: 'cc' },
      judge: { gate: 'none', role: 'acceptance' },
      precheck: () => ({ workspace: { project } }),
      context: () => ({ pattern: 'feat' }),
      goal: () => 'тест',
      verify: () => ({}),
      result: () => ({ ok: true }),
    },
  };
  const ctx = { cfg, jira: () => ({ issue: async () => issue }) };
  return { root, spec, ctx, runsDir: path.join(root, 'runs') };
}

const okSpawn = (bins) => ({ bin, args }) => {
  bins.push(`${bin} ${args.join(' ')}`);
  const events = createEventStream();
  events.push({ t: 'log', stream: 'stdout', text: JSON.stringify({ type: 'result', result: 'ok' }) });
  return { events, result: Promise.resolve({ ok: true, code: 0 }), abort: () => {} };
};

test('engine: агент задачи Jira берётся по уровню, флаг --agent роутер отключает', async () => {
  const { root, spec, ctx, runsDir } = setup();
  const bins = [];
  const base = { runsDir, noJudge: true, yes: true, cfg, classifyImpl: answer('easy'), spawnAgentImpl: okSpawn(bins) };

  const run = runAction(spec, ctx, { query: 'FD-1' }, { ...base, agent: 'cco' });
  await run.result;
  const meta = JSON.parse(readFileSync(path.join(runsDir, run.id, 'meta.json'), 'utf8'));
  assert.deepEqual([meta.agent, meta.tier], ['sonnet-low', 'easy']);
  assert.match(bins[0], /--model sonnet --effort low/);

  const explicit = runAction(spec, ctx, { query: 'FD-1' }, { ...base, agent: 'cc', agentExplicit: true });
  await explicit.result;
  const meta2 = JSON.parse(readFileSync(path.join(runsDir, explicit.id, 'meta.json'), 'utf8'));
  assert.deepEqual([meta2.agent, meta2.tier], ['cc', null]);
  rmSync(root, { recursive: true, force: true });
});

test('engine: рейт-лимит claude — ран доделывает фолбэк opencode', async () => {
  const { root, spec, ctx, runsDir } = setup();
  const bins = [];
  const ok = okSpawn(bins);
  const spawn = (p) => {
    if (p.bin !== 'claude') return ok(p);
    bins.push(`${p.bin} ${p.args.join(' ')}`);
    const events = createEventStream();
    events.push({ t: 'log', stream: 'stderr', text: 'Error: 429 rate limit, retry after 60 seconds.' });
    return { events, result: Promise.resolve({ ok: false, code: 1 }), abort: () => {} };
  };
  const run = runAction(spec, ctx, { query: 'FD-1' }, {
    runsDir, noJudge: true, yes: true, cfg, agent: 'cco', classifyImpl: answer('medium'), spawnAgentImpl: spawn,
  });
  await run.result;
  assert.equal(bins.length, 2);
  assert.match(bins[0], /^claude .*--effort xhigh/);
  assert.match(bins[1], /^opencode run .*deepseek-v4\.1-flash#max --format json$/);
  rmSync(root, { recursive: true, force: true });
});

// Событие error — провал даже при коде 0, а в сообщении текст ошибки модели.
test('spawnSession: opencode — ответ из последнего text, сессия из потока, error — провал с причиной', async () => {
  const lines = (...evs) => (p) => {
    const events = createEventStream();
    for (const ev of evs) events.push({ t: 'log', stream: 'stdout', text: JSON.stringify(ev) });
    calls.push(p);
    return { events, result: Promise.resolve({ ok: true, code: 0 }), abort: () => {} };
  };
  const calls = [];
  const x = (spawnAgentImpl) => ({ opts: { cfg, agent: 'opencode', spawnAgentImpl }, ws: { dir: '/tmp' } });

  const ok = x(lines(
    { type: 'text', sessionID: 'ses_1', part: { text: 'сначала гляну код' } },
    { type: 'tool_use', sessionID: 'ses_1', part: { tool: 'read', state: { input: { path: 'a.txt' } } } },
    { type: 'text', sessionID: 'ses_1', part: { text: 'готово' } },
  ));
  assert.equal(await spawnSession(ok, 'сделай'), 'готово');
  assert.equal(ok.sessionId, 'ses_1');
  assert.equal(calls[0].input, 'сделай');
  assert.ok(!calls[0].args.includes('--session'), 'на первом ходу id ещё нет');
  await spawnSession(ok, 'доделай', { resume: true });
  assert.deepEqual(calls[1].args.slice(-4), ['--session', 'ses_1', '--format', 'json']);

  const bad = x(lines({ type: 'error', sessionID: 'ses_2', error: { status: 402, message: 'нужно больше кредитов' } }));
  await assert.rejects(() => spawnSession(bad, 'сделай'), (e) => e.code === 'agent_failed' && /402 нужно больше кредитов/.test(e.message));
});
