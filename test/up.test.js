import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cmdUp } from '../src/commands/up.js';

const fakeSpawn = (calls) => (node, args, opts) => {
  const p = new EventEmitter();
  Object.assign(p, { pid: calls.length + 1, exitCode: null, signalCode: null, killed: [] });
  p.kill = (sig) => { p.killed.push(sig); p.signalCode = sig; queueMicrotask(() => p.emit('exit', null, sig)); };
  calls.push({ args, env: opts.env, p });
  return p;
};

test('up: токен из файла уходит в env бота и демона, Ctrl+C гасит обоих', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fsh-up-'));
  const tokenFile = path.join(dir, 'tok');
  writeFileSync(tokenFile, '123:abc\n');
  const calls = [];
  const signals = {};
  const done = cmdUp({}, { env: {}, tokenFile, spawn: fakeSpawn(calls), argv: ['node', 'fsh'], onSignal: (s, fn) => { signals[s] = fn; }, log: () => {} });
  assert.deepEqual(calls.map((c) => c.args), [['fsh', 'bot'], ['fsh', 'watch', '--daemon']]);
  assert.ok(calls.every((c) => c.env.FS_HARNESS_TELEGRAM === '123:abc'));
  signals.SIGINT();
  assert.deepEqual(await done, { ok: true });
  assert.ok(calls.every((c) => c.p.killed[0] === 'SIGINT'));
  rmSync(dir, { recursive: true, force: true });
});

test('up: упал один — второй погашен, команда падает', async () => {
  const calls = [];
  const done = cmdUp({}, { env: { FS_HARNESS_TELEGRAM: 't' }, spawn: fakeSpawn(calls), argv: ['node', 'fsh'], onSignal: () => {}, log: () => {} });
  calls[0].p.exitCode = 1;
  calls[0].p.emit('exit', 1, null);
  await assert.rejects(done, { code: 'child_failed' });
  assert.deepEqual(calls[1].p.killed, ['SIGTERM']);
});

test('up: нет ни файла, ни env — понятная ошибка', () => {
  assert.throws(() => cmdUp({}, { env: {}, tokenFile: '/nonexistent/tok', spawn: () => assert.fail() }), { code: 'secret_missing' });
});
