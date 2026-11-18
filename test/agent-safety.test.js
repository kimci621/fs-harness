import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cmdInit } from '../src/commands/init.js';
import { cmdQueue } from '../src/commands/queue.js';
import { cmdGrowthBook } from '../src/commands/growthbook.js';
import { cmdJira } from '../src/commands/jira.js';
import { COMMANDS } from '../src/registry.js';
import { netError } from '../src/errors.js';
import { exitCodeFor } from '../src/main.js';
import { CliError } from '../src/errors.js';

// Под Claude Code обратимое подтверждается само; здесь — то, что агент сам себе подтверждать не должен.
async function underClaude(fn) {
  const saved = process.env.CLAUDECODE;
  process.env.CLAUDECODE = '1';
  try { return await fn(); } finally { saved === undefined ? delete process.env.CLAUDECODE : (process.env.CLAUDECODE = saved); }
}
const canceled = (e) => e.code === 'canceled';

test('init под Claude Code без -y: разрешение Bash(fsh:*) агент себе не выдаёт', () => underClaude(() => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fsh-init-'));
  assert.throws(() => cmdInit(COMMANDS, { cfg: {} }, { projectDir: dir }), canceled);
  assert.equal(existsSync(path.join(dir, '.claude/settings.local.json')), false);
  rmSync(dir, { recursive: true, force: true });
}));

test('queue clear: --json без -y не очищает', () => underClaude(() => {
  const root = mkdtempSync(path.join(tmpdir(), 'fsh-q-'));
  assert.throws(() => cmdQueue({}, ['clear'], { json: true, queueRoot: root }), canceled);
  rmSync(root, { recursive: true, force: true });
}));

const gbCtx = (env) => ({
  gb: () => ({ toggleFeature: async () => { throw new Error('записи быть не должно'); }, feature: async () => ({ valueType: 'string', defaultValue: 'A' }), updateFeature: async () => { throw new Error('записи быть не должно'); } }),
  cfg: { growthbook: { env } },
});

test('growthbook под Claude Code: production и default без -y не трогаются, dev — да', async () => underClaude(async () => {
  await assert.rejects(() => cmdGrowthBook(gbCtx('production'), ['toggle', 'flag', 'on'], {}), canceled);
  await assert.rejects(() => cmdGrowthBook(gbCtx('dev'), ['set', 'flag', 'B'], {}), canceled);
  const ok = {
    gb: () => ({ toggleFeature: async () => ({ id: 'flag', environments: { dev: { enabled: true } } }) }),
    cfg: { growthbook: { env: 'dev' } },
  };
  const res = await cmdGrowthBook(ok, ['toggle', 'flag', 'on'], {});
  assert.equal(res.enabled, true);
}));

test('jira search без запроса и show без ключа — usage, а не «мои задачи»/undefined', async () => {
  const ctx = { cfg: {}, jira: () => ({ searchJql: async () => { throw new Error('запроса быть не должно'); } }) };
  await assert.rejects(() => cmdJira(ctx, ['search', ''], { asObject: true }), (e) => e.code === 'usage');
  await assert.rejects(() => cmdJira(ctx, ['search', ' '], { asObject: true }), (e) => e.code === 'usage');
  const help = await cmdJira(ctx, ['show'], { asObject: true });
  assert.match(help.usage, /fsh jira show <KEY>/);
});

test('сеть: временный сбой DNS (EAI_AGAIN) повторяется, нет хоста — нет', () => {
  assert.equal(netError('Jira', { cause: { code: 'EAI_AGAIN' } }, {}).retry, true);
  assert.equal(netError('Jira', { cause: { code: 'ENOTFOUND' } }, {}).retry, false);
});

test('отмена без терминала — код выхода 1: агент не примет отказ за успех', () => {
  const err = new CliError('Отменено.', 0, 'canceled');
  assert.equal(exitCodeFor(err, { tty: false }), 1);
  assert.equal(exitCodeFor(err, { tty: true }), 0);
  assert.equal(exitCodeFor(new CliError('x', 1, 'usage'), { tty: false }), 1);
});
