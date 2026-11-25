import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { useEnvProxy } from '../src/main.js';

const noProxyApi = typeof http.setGlobalProxyFromEnv !== 'function' && 'нет http.setGlobalProxyFromEnv в этой версии Node';

test('прокси из HTTPS_PROXY/HTTP_PROXY: fetch fsh идёт через него', { skip: noProxyApi }, async () => {
  const seen = [];
  const srv = http.createServer((req, res) => { seen.push(req.url); res.end('{}'); });
  srv.on('connect', (req, sock) => { seen.push(`CONNECT ${req.url}`); sock.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const proxy = `http://127.0.0.1:${srv.address().port}`;
  const env = { HTTPS_PROXY: proxy, HTTP_PROXY: proxy };
  try {
    assert.equal(useEnvProxy(env), true);
    assert.equal(env.NODE_USE_ENV_PROXY, '1');
    await fetch('https://fsh-proxy-check.invalid/', { signal: AbortSignal.timeout(5000) }).catch(() => {});
    assert.deepEqual(seen, ['CONNECT fsh-proxy-check.invalid:443']);
  } finally {
    srv.close();
  }
});

test('без прокси в env ничего не включается', () => {
  assert.equal(useEnvProxy({}), false);
});
