import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseClaudeLine, blockActivity, toolBrief } from '../src/agent/stream.js';
import { createCliProvider } from '../src/judge/providers/cli.js';

test('toolBrief: команда/файл/паттерн обрезаются до одной короткой строки', () => {
  assert.match(toolBrief('Bash', { command: 'npm test\nsecond line' }), /^Bash npm test$/);
  assert.equal(toolBrief('Edit', { file_path: '/a/b/c.ts' }), 'Edit /a/b/c.ts');
  assert.match(toolBrief('Read', { file_path: 'x'.repeat(300) }), /^Read x{160}…$/);
  assert.equal(toolBrief('Task'), 'Task'); // без аргументов — только имя
});

test('blockActivity: tool_use и text дают активность, прочие блоки — null', () => {
  assert.equal(blockActivity({ type: 'tool_use', name: 'Grep', input: { pattern: 'foo' } }), '🔧 Grep foo');
  assert.equal(blockActivity({ type: 'text', text: '  первая строка\nвторая' }), '💬 первая строка');
  assert.equal(blockActivity({ type: 'thinking' }), null);
  assert.equal(blockActivity({ type: 'text', text: '' }), null);
});

test('parseClaudeLine: активность из assistant, отчёт из result, мусор — passthrough', () => {
  const assistant = parseClaudeLine(JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm run lint' } }, { type: 'text', text: 'смотрю' }] },
  }));
  assert.match(assistant.activity, /🔧 Bash npm run lint · 💬 смотрю/);
  assert.equal(assistant.result, null);

  const result = parseClaudeLine(JSON.stringify({ type: 'result', subtype: 'success', result: 'готово', total_cost_usd: 0.5, session_id: 's1' }));
  assert.equal(result.result, 'готово');
  assert.equal(result.envelope.total_cost_usd, 0.5);

  // Не-JSON (текстовый режим агента или мусор) уходит насквозь, ничего не теряя.
  assert.equal(parseClaudeLine('просто строка').passthrough, 'просто строка');
  assert.equal(parseClaudeLine('{сломанный json').passthrough, '{сломанный json');
  assert.equal(parseClaudeLine('{"type":"system","subtype":"init"}').activity, null);
  assert.equal(parseClaudeLine('').passthrough, null);
});

// --- провайдер судьи через CLI: фейковый бинарь вместо claude, без сети ---

let dir;
before(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'fs-harness-judgecli-'));
  mkdirSync(path.join(dir, 'bin'), { recursive: true });
  writeFileSync(
    path.join(dir, 'bin', 'fakejudge'),
    [
      '#!/bin/sh',
      // аргументы в файл, stdin игнорируем; выдаём stream-json как настоящий claude
      'printf \'%s\\n\' "$*" > ' + path.join(dir, 'args.txt'),
      'echo \'{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"git log"}}]}}\'',
      'echo \'{"type":"result","subtype":"success","result":"{\\"decision\\":\\"approve\\"}","total_cost_usd":0.01,"session_id":"sid","usage":{"output_tokens":3},"modelUsage":{"claude-opus-4":{}}}\'',
    ].join('\n'),
    { mode: 0o755 },
  );
  writeFileSync(
    path.join(dir, 'bin', 'crashjudge'),
    '#!/bin/sh\necho падаю >&2\nexit 2\n',
    { mode: 0o755 },
  );
  process.env.PATH = `${path.join(dir, 'bin')}:${process.env.PATH}`;
});
after(() => rmSync(dir, { recursive: true, force: true }));

test('cli-провайдер: stream-json разбирается, активность течёт в onDelta, цена и сессия возвращаются', async () => {
  const provider = createCliProvider({ bin: 'fakejudge', model: 'opus' }, null);
  const deltas = [];
  const res = await provider.complete({ system: 'рубрика', user: 'задание', onDelta: (t) => deltas.push(t) });
  assert.equal(res.text, '{"decision":"approve"}');
  assert.equal(res.cost, 0.01);
  assert.equal(res.sessionId, 'sid');
  assert.equal(res.model, 'claude-opus-4');
  assert.deepEqual(res.usage, { output_tokens: 3 });
  assert.ok(deltas.some((d) => d.includes('git log')), deltas.join('|'));

  const args = readFileSync(path.join(dir, 'args.txt'), 'utf8');
  assert.match(args, /--restricted/);
  assert.match(args, /--output-format stream-json/);
  assert.match(args, /--model opus/);
  assert.match(args, /--append-system-prompt рубрика/);
  assert.match(args, /-p$/m);
});

test('cli-провайдер: падение процесса — judge_failed, а не креш', async () => {
  const provider = createCliProvider({ bin: 'crashjudge' }, null);
  await assert.rejects(() => provider.complete({ user: 'x' }), (e) => e.code === 'judge_failed' && /кодом 2/.test(e.message));
});
