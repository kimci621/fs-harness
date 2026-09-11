import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Verdict, extractJson } from '../src/judge/schema.js';
import { judge, pickProfiles, isApproved, formatVerdict } from '../src/judge/index.js';
import { readSecret, addCommand } from '../src/secrets.js';
import { truncate, buildAcceptancePayload } from '../src/judge/payload.js';
import { CliError } from '../src/errors.js';

const GOOD = {
  decision: 'approve',
  confidence: 0.8,
  summary: 'Обе стороны живы.',
  findings: [],
  checks: [{ name: 'маркеры конфликта', pass: true, note: 'в диффе не встречаются' }],
  next: { action: 'push', hint: '' },
};

const profiles = { fake: { provider: 'fake' }, second: { provider: 'fake' } };
const cfg = { judge: { profiles, roles: { acceptance: ['fake'] } } };
const cfgFallback = { judge: { profiles, roles: { acceptance: ['fake', 'second'] } } };

// Провайдер отдаёт заготовленные ответы по порядку и считает вызовы.
function fakeProvider(texts) {
  const calls = [];
  const makeProvider = async () => ({
    name: 'fake',
    complete: async ({ user }) => {
      calls.push(user);
      const text = texts.shift();
      if (text instanceof Error) throw text;
      return { text, cost: 0.01, usage: { input_tokens: 1 }, model: 'fake-1' };
    },
  });
  return { makeProvider, calls };
}

test('extractJson: забор, голый объект, мусор вокруг, невалид', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('Вот вердикт:\n{"a":1}\nготово'), { a: 1 });
  assert.equal(extractJson('просто текст без json'), null);
  assert.equal(extractJson(''), null);
});

test('Verdict: кривое decision не проходит схему', () => {
  assert.equal(Verdict.safeParse(GOOD).success, true);
  assert.equal(Verdict.safeParse({ ...GOOD, decision: 'ok' }).success, false);
  assert.equal(Verdict.safeParse({ ...GOOD, confidence: 2 }).success, false);
  assert.equal(Verdict.safeParse({ ...GOOD, findings: [{ severity: 'oops', file: 'a', line: 1, body: 'b' }] }).success, false);
});

test('judge: валидный вердикт получает meta с профилем и ценой', async () => {
  const { makeProvider } = fakeProvider([JSON.stringify(GOOD)]);
  const v = await judge({ role: 'acceptance', payload: 'p', cfg, makeProvider });
  assert.equal(v.decision, 'approve');
  assert.equal(v.meta.profile, 'fake');
  assert.equal(v.meta.role, 'acceptance');
  assert.equal(v.meta.cost, 0.01);
  assert.ok(isApproved(v));
});

test('judge: один ремонтный round-trip чинит кривой ответ', async () => {
  const { makeProvider, calls } = fakeProvider(['не json вообще', JSON.stringify(GOOD)]);
  const v = await judge({ role: 'acceptance', payload: 'p', cfg, makeProvider });
  assert.equal(v.decision, 'approve');
  assert.equal(calls.length, 2);
  assert.match(calls[1], /не прошёл валидацию схемы/);
  assert.equal(v.meta.cost, 0.02); // цена обоих вызовов
});

test('judge: невалидный JSON дважды — ошибка judge_schema, а не approve', async () => {
  const { makeProvider } = fakeProvider(['мусор', '{"decision":"approve"}']);
  await assert.rejects(
    () => judge({ role: 'acceptance', payload: 'p', cfg, makeProvider }),
    (err) => err instanceof CliError && err.code === 'judge_schema',
  );
});

test('judge: схема не лечится сменой профиля — фолбэк не срабатывает', async () => {
  const { makeProvider, calls } = fakeProvider(['мусор', 'опять мусор', JSON.stringify(GOOD)]);
  await assert.rejects(
    () => judge({ role: 'acceptance', payload: 'p', cfg: cfgFallback, makeProvider }),
    (err) => err.code === 'judge_schema',
  );
  assert.equal(calls.length, 2); // первый вызов + ремонт, до второго профиля не дошло
});

test('judge: падение бэкенда уводит на следующий профиль роли', async () => {
  const boom = new CliError('LM Studio молчит', 1, 'judge_failed');
  const { makeProvider } = fakeProvider([boom, JSON.stringify(GOOD)]);
  const v = await judge({ role: 'acceptance', payload: 'p', cfg: cfgFallback, makeProvider });
  assert.equal(v.meta.profile, 'second');
});

test('pickProfiles: override, список, неназначенная роль', () => {
  assert.deepEqual(pickProfiles('acceptance', cfg), ['fake']);
  assert.deepEqual(pickProfiles('acceptance', cfg, 'other'), ['other']);
  assert.deepEqual(pickProfiles('acceptance', cfgFallback), ['fake', 'second']);
  assert.throws(() => pickProfiles('нет-такой', cfg), (e) => e.code === 'config_invalid');
});

test('formatVerdict: решение, цена и находки в одной строке каждая', () => {
  const out = formatVerdict({ ...GOOD, decision: 'reject', findings: [{ severity: 'blocker', file: 'a.ts', line: 12, body: 'взята одна сторона' }], meta: { profile: 'opus-cli', cost: 0.42 } });
  assert.match(out, /reject/);
  assert.match(out, /\$0\.4200/);
  assert.match(out, /a\.ts:12 — взята одна сторона/);
});

test('secrets: env выигрывает у keychain, алиас работает, без ключа — команда заведения', () => {
  const never = () => null;
  assert.equal(readSecret('openrouter', { env: { FS_HARNESS_OPENROUTER: 'из-env' }, exec: never }), 'из-env');
  assert.equal(readSecret('deepseek', { env: { DEEPSEEK_API_KEY: 'алиас' }, exec: never }), 'алиас');
  assert.equal(readSecret('openrouter', { env: {}, exec: () => 'из-keychain' }), 'из-keychain');
  assert.equal(readSecret('jira', { env: {}, exec: never, required: false }), null);
  assert.throws(
    () => readSecret('jira', { env: {}, exec: never }),
    (e) => e.code === 'secret_missing' && e.message.includes(addCommand('jira')),
  );
});

test('payload: обрезка видна судье, а не тихая', () => {
  const long = Array.from({ length: 10 }, (_, i) => `строка ${i}`).join('\n');
  assert.equal(truncate(long, 20), long);
  const cut = truncate(long, 3);
  assert.match(cut, /обрезано 7 строк из 10/);

  const payload = buildAcceptancePayload({ goal: 'цель', facts: { commits_ahead: 1, leftover_markers: [] }, diff: 'diff тут', agentText: 'отчёт' });
  assert.match(payload, /## Задача, которую решал агент/);
  assert.match(payload, /- commits_ahead: 1/);
  assert.match(payload, /- leftover_markers: —/);
  assert.match(payload, /```diff/);
});
