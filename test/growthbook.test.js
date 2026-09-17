import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGrowthBook, envStates } from '../src/growthbook.js';
import { cmdGrowthBook } from '../src/commands/growthbook.js';

// Подменённый fetch: отдаёт заготовленные ответы по порядку и пишет, что спрашивали.
function fakeFetch(responses) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null, headers: init.headers });
    const r = responses.shift();
    return { ok: r.status < 400, status: r.status, json: async () => r.body };
  };
  return { impl, calls };
}

const gbWith = (responses) => {
  const { impl, calls } = fakeFetch(responses);
  return { gb: createGrowthBook({ baseUrl: 'https://gb.invalid/', token: 'secret_x', fetchImpl: impl, sleepMs: 1 }), calls };
};

const feature = (over = {}) => ({
  id: 'flag', valueType: 'boolean', defaultValue: 'false', tags: ['web'],
  environments: { production: { enabled: false }, dev: { enabled: true } },
  ...over,
});

const ctxWith = (gb, over = {}) => ({ gb: () => gb, cfg: { growthbook: { baseUrl: 'https://gb.invalid', project: '', env: 'production', ...over } } });

test('growthbook: Bearer-ключ и обрезанный хвост baseUrl', async () => {
  const { gb, calls } = gbWith([{ status: 200, body: { features: [feature()], total: 1, hasMore: false } }]);
  await gb.features();
  assert.equal(calls[0].headers.authorization, 'Bearer secret_x');
  assert.match(calls[0].url, /^https:\/\/gb\.invalid\/api\/v1\/features\?limit=100&offset=0$/);
});

test('growthbook: отклонённый ключ — понятная ошибка, 5xx повторяется', async () => {
  const { gb } = gbWith([{ status: 403, body: {} }]);
  await assert.rejects(() => gb.features(), (e) => e.code === 'api_failed' && /growthbook_apikey/.test(e.message));

  const retry = gbWith([{ status: 500, body: {} }, { status: 200, body: { features: [], total: 0 } }]);
  assert.deepEqual((await retry.gb.features()).features, []);
  assert.equal(retry.calls.length, 2);
});

test('growthbook list: страницы склеиваются, архивные не показываются', async () => {
  const { gb, calls } = gbWith([
    { status: 200, body: { features: [feature({ id: 'a' }), feature({ id: 'old', archived: true })], total: 3, hasMore: true, nextOffset: 100 } },
    { status: 200, body: { features: [feature({ id: 'b' })], total: 3, hasMore: false } },
  ]);
  const res = await cmdGrowthBook(ctxWith(gb), ['list'], { asObject: true });
  assert.deepEqual(res.flags.map((f) => f.id), ['a', 'b']);
  assert.match(calls[1].url, /offset=100/);
  assert.equal(res.flags[0].envs, 'production=off dev=on');
});

test('growthbook toggle: POST с причиной, read-back ловит несработавшее переключение', async () => {
  const { gb, calls } = gbWith([{ status: 200, body: { feature: feature({ environments: { production: { enabled: true }, dev: { enabled: true } } }) } }]);
  const res = await cmdGrowthBook(ctxWith(gb), ['toggle', 'flag', 'on'], { asObject: true, yes: true });
  assert.deepEqual([res.toggled, res.env, res.enabled], ['flag', 'production', true]);
  assert.equal(calls[0].method, 'POST');
  assert.match(calls[0].url, /\/api\/v1\/features\/flag\/toggle$/);
  assert.deepEqual(calls[0].body.environments, { production: true });
  assert.match(calls[0].body.reason, /fsh/);

  const stuck = gbWith([{ status: 200, body: { feature: feature() } }]);
  await assert.rejects(
    () => cmdGrowthBook(ctxWith(stuck.gb), ['toggle', 'flag', 'on'], { asObject: true, yes: true }),
    (e) => e.code === 'api_failed' && /остался off/.test(e.message),
  );

  const noEnv = gbWith([{ status: 200, body: { feature: feature() } }]);
  await assert.rejects(
    () => cmdGrowthBook(ctxWith(noEnv.gb, { env: 'stage' }), ['toggle', 'flag', 'on'], { asObject: true, yes: true }),
    (e) => e.code === 'api_failed' && /Есть: production, dev/.test(e.message),
  );
});

test('growthbook: dry-run ничего не отправляет, кривой вызов — usage', async () => {
  const { gb, calls } = gbWith([]);
  const dry = await cmdGrowthBook(ctxWith(gb), ['toggle', 'flag', 'off'], { asObject: true, dryRun: true });
  assert.deepEqual([dry.dry_run, dry.toggled, dry.enabled], [true, 'flag', false]);
  const dryNew = await cmdGrowthBook(ctxWith(gb), ['create', 'flag', 'on'], { asObject: true, dryRun: true });
  assert.deepEqual(dryNew.body.environments, { production: { enabled: true, rules: [] } });
  assert.equal(calls.length, 0);

  await assert.rejects(() => cmdGrowthBook(ctxWith(gb), ['toggle', 'flag'], { asObject: true }), (e) => e.code === 'usage');
  await assert.rejects(() => cmdGrowthBook(ctxWith(gb), ['drop', 'flag'], { asObject: true }), (e) => e.code === 'usage');
});

test('growthbook create: у каждого окружения обязателен пустой rules (иначе 400 от API)', async () => {
  const { gb, calls } = gbWith([{ status: 200, body: { feature: feature({ id: 'new-flag', environments: { production: { enabled: true, rules: [] } } }) } }]);
  const res = await cmdGrowthBook(ctxWith(gb), ['create', 'new-flag', 'on'], { asObject: true, yes: true });
  assert.equal(res.created, 'new-flag');
  assert.equal(calls[0].method, 'POST');
  assert.match(calls[0].url, /\/api\/v1\/features$/);
  assert.deepEqual(calls[0].body.environments, { production: { enabled: true, rules: [] } });
});

test('growthbook create: поддержка --type и --default', async () => {
  const { gb, calls } = gbWith([{ status: 200, body: { feature: feature({ id: 'str-flag', valueType: 'string', defaultValue: 'control' }) } }]);
  const res = await cmdGrowthBook(ctxWith(gb), ['create', 'str-flag', 'off'], { asObject: true, yes: true, type: 'string', default: 'control' });
  assert.equal(res.created, 'str-flag');
  assert.equal(calls[0].body.valueType, 'string');
  assert.equal(calls[0].body.defaultValue, 'control');
});

test('growthbook delete: DELETE-запрос, dry-run без сети, нет id — usage', async () => {
  const { gb, calls } = gbWith([{ status: 200, body: { deletedId: 'flag' } }]);
  const dry = await cmdGrowthBook(ctxWith(gb), ['delete', 'flag'], { asObject: true, dryRun: true });
  assert.deepEqual([dry.ok, dry.dry_run, dry.deleted], [true, true, 'flag']);
  assert.equal(calls.length, 0);

  const res = await cmdGrowthBook(ctxWith(gb), ['delete', 'flag'], { asObject: true, yes: true });
  assert.deepEqual(res, { ok: true, deleted: 'flag' });
  assert.equal(calls[0].method, 'DELETE');
  assert.match(calls[0].url, /\/api\/v1\/features\/flag$/);

  // API не подтвердил удаление — ошибка, а не тихий успех.
  const bad = gbWith([{ status: 200, body: {} }]);
  await assert.rejects(
    () => cmdGrowthBook(ctxWith(bad.gb), ['delete', 'flag'], { asObject: true, yes: true }),
    (e) => e.code === 'api_failed' && /не подтвердил/.test(e.message),
  );

  await assert.rejects(() => cmdGrowthBook(ctxWith(gb), ['delete'], { asObject: true }), (e) => e.code === 'usage');
  await assert.rejects(() => cmdGrowthBook(ctxWith(gb), ['drop', 'flag'], { asObject: true }), (e) => e.code === 'usage');
});

test('envStates: состояние по окружениям одной строкой', () => {
  assert.equal(envStates(feature()), 'production=off dev=on');
  assert.equal(envStates({}), '');
});
