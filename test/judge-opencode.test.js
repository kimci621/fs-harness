import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createProvider } from '../src/judge/providers/index.js';

let dir;
before(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'fsh-oc-'));
  mkdirSync(path.join(dir, 'bin'));
  // Фейковый opencode: пишет argv, stdin и конфиг рабочей папки, отвечает потоком событий --format json.
  writeFileSync(path.join(dir, 'bin', 'fakeoc'), [
    '#!/bin/sh',
    `echo "$@" > ${dir}/args.txt`,
    `cat > ${dir}/stdin.txt`,
    `cat opencode.json > ${dir}/cfg.txt`,
    'echo \'{"type":"step_start","sessionID":"ses1"}\'',
    'echo \'{"type":"text","sessionID":"ses1","part":{"type":"text","text":"{\\"decision\\":"}}\'',
    'echo \'{"type":"text","sessionID":"ses1","part":{"type":"text","text":"\\"approve\\"}"}}\'',
    'echo \'{"type":"step_finish","sessionID":"ses1","part":{"tokens":{"input":100,"output":5,"reasoning":7},"cost":0.002}}\'',
  ].join('\n'), { mode: 0o755 });
  writeFileSync(path.join(dir, 'bin', 'erroc'), '#!/bin/sh\ncat >/dev/null\necho \'{"type":"error","error":{"message":"Model unavailable"}}\'\n', { mode: 0o755 });
});
after(() => rmSync(dir, { recursive: true, force: true }));

test('opencode-провайдер: модель с вариантом, задание в stdin, инструменты выключены, текст и токены собраны', async () => {
  const p = await createProvider({ provider: 'opencode', bin: path.join(dir, 'bin', 'fakeoc'), model: 'opencode-go/deepseek-v4.1-flash', effort: 'max' });
  const res = await p.complete({ system: 'рубрика', user: 'задание' });
  assert.equal(res.text, '{"decision":"approve"}');
  assert.equal(res.sessionId, 'ses1');
  assert.equal(res.cost, 0.002);
  assert.deepEqual(res.usage, { input_tokens: 100, output_tokens: 5, reasoning_tokens: 7 });
  assert.match(readFileSync(path.join(dir, 'args.txt'), 'utf8'), /^run -m opencode-go\/deepseek-v4\.1-flash#max --format json --archived$/m);
  assert.equal(readFileSync(path.join(dir, 'stdin.txt'), 'utf8'), 'рубрика\n\nзадание');
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'cfg.txt'), 'utf8')), { tools: { '*': false } });
});

test('opencode-провайдер: событие error — judge_failed с текстом ошибки', async () => {
  const p = await createProvider({ provider: 'opencode', bin: path.join(dir, 'bin', 'erroc'), model: 'x/y' });
  await assert.rejects(() => p.complete({ user: 'x' }), (e) => e.code === 'judge_failed' && /Model unavailable/.test(e.message));
});
