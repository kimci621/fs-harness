import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cmdMM } from '../src/commands/mm.js';

const ROOT = 'r'.repeat(26);
const T0 = Date.parse('2026-11-18T10:00:00Z');
const posts = Object.fromEntries([0, 1, 2, 3, 4].map((i) => {
  const id = i ? `p${i}`.padEnd(26, 'x') : ROOT;
  return [id, { id, root_id: i ? ROOT : '', user_id: 'u1', message: `m${i}`, create_at: T0 + i * 60_000 }];
}));
const ctx = { cfg: {}, mm: () => ({ thread: async () => ({ order: Object.keys(posts), posts }), usersByIds: async () => [{ id: 'u1', username: 'ann' }] }) };

test('mm thread --last N: только хвост, total — весь тред', async () => {
  const r = await cmdMM(ctx, ['thread', ROOT], { last: 2, asObject: true });
  assert.deepEqual(r.messages.map((m) => m.text), ['m3', 'm4']);
  assert.equal(r.total, 5);
  assert.equal(r.root_id, ROOT);
});

test('mm thread --since: сообщения с этого момента', async () => {
  const r = await cmdMM(ctx, ['thread', ROOT], { since: '2026-11-18T10:03:00Z', asObject: true });
  assert.deepEqual(r.messages.map((m) => m.text), ['m3', 'm4']);
  await assert.rejects(() => cmdMM(ctx, ['thread', ROOT], { since: 'вчера', asObject: true }), (e) => e.code === 'usage');
  await assert.rejects(() => cmdMM(ctx, ['thread', ROOT], { last: 0, asObject: true }), (e) => e.code === 'usage');
});
