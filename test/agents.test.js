import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveAgent, agentNames } from '../src/agents.js';
import { DEFAULTS } from '../src/config.js';

test('resolveAgent: дефолтный cc — это claude без чужого env', () => {
  const a = resolveAgent({}, 'cc');
  assert.equal(a.bin, 'claude');
  assert.equal(a.family, 'claude');
  assert.deepEqual(a.env, {});
  assert.ok(a.args.includes('--dangerously-skip-permissions'));
});

test('resolveAgent: профиль провайдера отдаёт свой baseUrl и модель', () => {
  const a = resolveAgent({ agents: { ...DEFAULTS.agents, ccq: { ...DEFAULTS.agents.ccq, keyFile: undefined } } }, 'ccq');
  assert.equal(a.bin, 'claude'); // та же программа, другой провайдер
  assert.match(a.env.ANTHROPIC_BASE_URL, /aliyuncs\.com/);
});

test('resolveAgent: ключ читается из файла в токен, а не хранится в конфиге', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fsh-agents-'));
  const file = path.join(dir, 'key');
  writeFileSync(file, 'secret_123\n');
  const a = resolveAgent({ agents: { x: { bin: 'claude', keyFile: file } } }, 'x');
  assert.equal(a.env.ANTHROPIC_AUTH_TOKEN, 'secret_123');
});

test('resolveAgent: нет файла с ключом — понятная ошибка, а не запуск без токена', () => {
  const cfg = { agents: { x: { bin: 'claude', keyFile: '/нет/такого/файла' } } };
  assert.throws(() => resolveAgent(cfg, 'x'), (e) => e.code === 'secret_missing');
});

test('resolveAgent: неизвестное имя перечисляет то, что есть', () => {
  assert.throws(() => resolveAgent({}, 'ccx'), (e) => e.code === 'usage' && /cc, ccd, cco, ccq/.test(e.message));
});

test('agentNames: профили из конфига добавляются к дефолтным', () => {
  assert.ok(agentNames({ agents: { мой: { bin: 'claude' } } }).includes('мой'));
  assert.ok(agentNames({}).includes('cc'));
});

test('resolveAgent: старый agentArgs всё ещё перебивает args профиля', () => {
  const a = resolveAgent({ agentArgs: { cc: ['--flag'] } }, 'cc');
  assert.deepEqual(a.args, ['--flag']);
});

test('--agent=значение разбирается наравне с --agent значение', () => {
  const bin = path.join(import.meta.dirname, '..', 'bin', 'fsh.js');
  const res = spawnSync(process.execPath, [bin, 'commit', '--agent=нетпрофиля', '--dry-run'], { encoding: 'utf8' });
  assert.match(res.stdout + res.stderr, /Неизвестный агент "нетпрофиля"/);
});

test('resolveAgent: co работает как алиас cco', () => {
  const a = resolveAgent({ agents: { cco: { bin: 'claude' } } }, 'co');
  assert.equal(a.name, 'cco');
  assert.equal(a.bin, 'claude');
});

