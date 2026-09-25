import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../src/classify.js';

const cfg = {
  classify: { minP: 0.8, profiles: { jev: { baseUrl: 'http://x/decisions', model: 'm' } }, roles: { r: 'jev' } },
};
const Q = { a: { instructions: 'i', criteria: { yes: 'y', no: 'n' } } };
const reply = (answers, ok = true) => async () => ({ ok, json: async () => ({ answers }) });
const secret = () => 'k';

test('classify: выбор выше порога отдаётся, ниже — null', async () => {
  const hi = await classify({ role: 'r', state: 's', questions: Q, cfg, secret, fetchImpl: reply({ a: { choice: 'yes', probabilities: { yes: 0.9, no: 0.1 } } }) });
  assert.deepEqual(hi, { a: { choice: 'yes', p: 0.9 } });
  const lo = await classify({ role: 'r', state: 's', questions: Q, cfg, secret, fetchImpl: reply({ a: { choice: 'yes', probabilities: { yes: 0.6, no: 0.4 } } }) });
  assert.deepEqual(lo, { a: { choice: null, p: 0.6 } });
});

test('classify: роль без профиля, HTTP-ошибка, сеть, битый ответ — null', async () => {
  assert.equal(await classify({ role: 'нет', state: 's', questions: Q, cfg, secret }), null);
  assert.equal(await classify({ role: 'r', state: 's', questions: Q, cfg, secret, fetchImpl: reply({}, false) }), null);
  assert.equal(await classify({ role: 'r', state: 's', questions: Q, cfg, secret, fetchImpl: async () => { throw new Error('ECONNRESET'); } }), null);
  assert.equal(await classify({ role: 'r', state: 's', questions: Q, cfg, secret, fetchImpl: reply({}) }), null);
});

test('classify: запрос в формате decisions API', async () => {
  let body;
  await classify({
    role: 'r', state: 'x'.repeat(10000), questions: Q, cfg, secret,
    fetchImpl: async (_url, init) => { body = JSON.parse(init.body); return { ok: true, json: async () => ({ answers: { a: { choice: 'no', probabilities: { no: 1 } } } }) }; },
  });
  assert.equal(body.model, 'm');
  assert.equal(body.state.length, 8000);
  assert.deepEqual(body.questions.a, { type: 'choice', ...Q.a });
});
