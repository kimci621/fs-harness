import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGrowthBook } from '../src/growthbook.js';
import { cmdGrowthBook } from '../src/commands/growthbook.js';

const gbWith = (status, body) => createGrowthBook({
  baseUrl: 'https://gb.invalid', token: 't', sleepMs: 1,
  fetchImpl: async () => ({ ok: status < 400, status, json: async () => body }),
});

test('growthbook 401/403: «не хватает прав на <действие>», без сырого JSON', async () => {
  const raw = { message: 'You do not have permission to perform this action', code: 'forbidden' };
  const cases = [
    [(gb) => gb.createFeature({ id: 'x' }), 'создание флага'],
    [(gb) => gb.toggleFeature('x', { production: true }, 'r'), 'включение и выключение флага'],
    [(gb) => gb.updateFeature('x', { defaultValue: '1' }), 'правку флага'],
    [(gb) => gb.deleteFeature('x'), 'удаление флага'],
    [(gb) => gb.features(), 'чтение флагов'],
  ];
  for (const [call, action] of cases) {
    for (const status of [401, 403]) {
      await assert.rejects(() => call(gbWith(status, raw)), (e) => {
        assert.match(e.message, new RegExp(`ключу GrowthBook не хватает прав на ${action}`));
        assert.doesNotMatch(e.message, /permission to perform|\{/);
        return e.code === 'api_failed';
      });
    }
  }
});

test('growthbook help: пример create, тело запроса, ключ и хост; правил и экспериментов нет', async () => {
  const ctx = { gb: () => { throw new Error('сеть не нужна'); }, cfg: { growthbook: { baseUrl: 'https://gb-api.invalid', project: 'prj_1', env: 'production' } } };
  const r = await cmdGrowthBook(ctx, ['help'], { asObject: true });
  assert.match(r.help, /fsh growthbook create \S+ off/);
  assert.match(r.help, /POST https:\/\/gb-api\.invalid\/api\/v1\/features/);
  assert.match(r.help, /"environments"/);
  assert.match(r.help, /Bearer/);
  assert.match(r.help, /FS_HARNESS_GROWTHBOOK/);
  assert.match(r.help, /правил[а-я]* и эксперимент/i);
});
