import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJira } from '../src/jira.js';
import { createMattermost } from '../src/mattermost.js';

// fetch падает так же, как undici: TypeError('fetch failed') с причиной в cause.
const failing = (code) => {
  const calls = { n: 0 };
  const impl = async () => {
    calls.n++;
    throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });
  };
  return { impl, calls };
};

const clients = {
  Jira: (impl) => createJira({ baseUrl: 'https://j.invalid', email: 'e', token: 't', fetchImpl: impl, sleepMs: 1 }).myself(),
  Mattermost: (impl) => createMattermost({ baseUrl: 'https://mm.invalid', token: 't', fetchImpl: impl, sleepMs: 1 }).me(),
};

for (const [name, call] of Object.entries(clients)) {
  test(`${name}: нет сети/DNS/прокси — сразу ошибка без повторов, с подсказкой про прокси`, async () => {
    const saved = [process.env.HTTPS_PROXY, process.env.NODE_USE_ENV_PROXY];
    process.env.HTTPS_PROXY = 'http://127.0.0.1:9';
    delete process.env.NODE_USE_ENV_PROXY;
    try {
      const { impl, calls } = failing('ENOTFOUND');
      await assert.rejects(() => call(impl), (e) => e.code === 'api_failed' && /нет связи/.test(e.message) && /ENOTFOUND/.test(e.message) && /NODE_USE_ENV_PROXY=1/.test(e.message));
      assert.equal(calls.n, 1);
      for (const code of ['ECONNREFUSED', 'EPERM']) {
        const f = failing(code);
        await assert.rejects(() => call(f.impl));
        assert.equal(f.calls.n, 1, code);
      }
    } finally {
      saved[0] === undefined ? delete process.env.HTTPS_PROXY : (process.env.HTTPS_PROXY = saved[0]);
      saved[1] === undefined ? delete process.env.NODE_USE_ENV_PROXY : (process.env.NODE_USE_ENV_PROXY = saved[1]);
    }
  });

  test(`${name}: обрыв соединения повторяется, как раньше`, async () => {
    const { impl, calls } = failing('ECONNRESET');
    await assert.rejects(() => call(impl), (e) => /нет связи/.test(e.message));
    assert.ok(calls.n > 1);
  });
}
