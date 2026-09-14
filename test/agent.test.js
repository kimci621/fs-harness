import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEventStream } from '../src/agent/events.js';
import { spawnAgent } from '../src/agent/spawn.js';

const drain = async (stream) => {
  const out = [];
  for await (const ev of stream) out.push(ev);
  return out;
};

test('createEventStream: подписка после старта не теряет ранние события', async () => {
  const s = createEventStream();
  s.push({ t: 'phase', phase: 'context' });
  s.push({ t: 'phase', phase: 'isolate' });
  s.close();
  const got = await drain(s);
  assert.deepEqual(got.map((e) => e.phase), ['context', 'isolate']);
});

test('createEventStream: итератор ждёт новых событий и завершается на close', async () => {
  const s = createEventStream();
  const collected = drain(s);
  s.push({ t: 'log', text: 'раз' });
  await Promise.resolve();
  s.push({ t: 'log', text: 'два' });
  s.close();
  assert.deepEqual((await collected).map((e) => e.text), ['раз', 'два']);
});

test('createEventStream: два итератора читают одно и то же', async () => {
  const s = createEventStream();
  const a = drain(s);
  const b = drain(s);
  s.push({ t: 'log', text: 'x' });
  s.close();
  assert.deepEqual((await a).length, 1);
  assert.deepEqual((await b).length, 1);
});

test('createEventStream: on() отдаёт только последующие события', async () => {
  const s = createEventStream();
  s.push({ t: 'log', text: 'до' });
  const seen = [];
  const off = s.on((ev) => seen.push(ev.text));
  s.push({ t: 'log', text: 'после' });
  off();
  s.push({ t: 'log', text: 'после отписки' });
  s.close();
  assert.deepEqual(seen, ['после']);
});

test('spawnAgent: stdout и stderr приходят построчно, в конце done', async () => {
  const script = 'process.stdout.write("первая\\nвторая\\n"); process.stderr.write("ошибка\\n");';
  const run = spawnAgent({ bin: process.execPath, args: ['-e', script] });
  const events = await drain(run.events);
  const done = await run.result;

  assert.equal(done.ok, true);
  assert.deepEqual(
    events.filter((e) => e.t === 'log' && e.stream === 'stdout').map((e) => e.text),
    ['первая', 'вторая'],
  );
  assert.deepEqual(
    events.filter((e) => e.t === 'log' && e.stream === 'stderr').map((e) => e.text),
    ['ошибка'],
  );
  assert.equal(events.at(-1).t, 'done');
});

test('spawnAgent: ненулевой код — ok:false, не исключение', async () => {
  const run = spawnAgent({ bin: process.execPath, args: ['-e', 'process.exit(3)'] });
  const done = await run.result;
  assert.deepEqual([done.ok, done.code], [false, 3]);
});

test('spawnAgent: несуществующий бинарь реджектит и шлёт error', async () => {
  const run = spawnAgent({ bin: 'fsh-такого-бинаря-нет', args: [] });
  const events = drain(run.events);
  await assert.rejects(() => run.result);
  assert.equal((await events).at(-1).code, 'spawn_failed');
});

test('spawnAgent: abort через AbortSignal валит процесс', async () => {
  const ctrl = new AbortController();
  const run = spawnAgent({
    bin: process.execPath,
    args: ['-e', 'setTimeout(() => {}, 60000)'],
    signal: ctrl.signal,
  });
  ctrl.abort();
  const done = await run.result;
  assert.equal(done.ok, false);
  assert.equal(done.signal, 'SIGTERM');
});

test('spawnAgent: input уезжает агенту в stdin, а не в argv', async () => {
  const script = 'let s=""; process.stdin.on("data",(c)=>s+=c).on("end",()=>process.stdout.write("прочитал "+s.length));';
  const big = 'я'.repeat(300000); // больше ARG_MAX, аргументом такое не передать
  const run = spawnAgent({ bin: process.execPath, args: ['-e', script], input: big });
  const events = await drain(run.events);
  assert.equal((await run.result).ok, true);
  assert.equal(events.find((e) => e.t === 'log')?.text, `прочитал ${big.length}`);
});
