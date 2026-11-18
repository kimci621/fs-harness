import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cmdMM } from '../src/commands/mm.js';

const POST = 'p'.repeat(26);
const ME = 'u'.repeat(26);

const fakeCtx = (owner = ME) => {
  const calls = [];
  return {
    calls,
    cfg: { mattermost: { baseUrl: 'https://mm.invalid' } },
    mm: () => ({
      me: async () => ({ id: ME }),
      getPost: async (id) => (id === POST ? { id, user_id: owner, channel_id: 'c'.repeat(26), message: 'старый' } : null),
      patchPost: async (id, message) => { calls.push(['patch', id, message]); return { id, message }; },
      deletePost: async (id) => { calls.push(['delete', id]); return { status: 'OK' }; },
    }),
  };
};

test('mm edit: permalink разбирается, текст уходит в patchPost', async () => {
  const ctx = fakeCtx();
  const r = await cmdMM(ctx, ['edit', `https://mm.invalid/team/pl/${POST}`, 'новый', 'текст'], { yes: true, asObject: true });
  assert.deepEqual(ctx.calls, [['patch', POST, 'новый текст']]);
  assert.equal(r.post_id, POST);
});

test('mm delete: по id поста, с -y удаляет', async () => {
  const ctx = fakeCtx();
  const r = await cmdMM(ctx, ['delete', POST], { yes: true, asObject: true });
  assert.deepEqual(ctx.calls, [['delete', POST]]);
  assert.equal(r.deleted, POST);
});

test('mm delete: необратимое — под CLAUDECODE без -y отказ, ничего не удалено', async () => {
  const saved = process.env.CLAUDECODE;
  process.env.CLAUDECODE = '1';
  try {
    const ctx = fakeCtx();
    await assert.rejects(() => cmdMM(ctx, ['delete', POST], { json: true }), (e) => e.code === 'canceled');
    assert.equal(ctx.calls.length, 0);
  } finally {
    saved === undefined ? delete process.env.CLAUDECODE : (process.env.CLAUDECODE = saved);
  }
});

test('mm edit/delete: чужой пост не трогаем, кривая ссылка — usage', async () => {
  const ctx = fakeCtx('x'.repeat(26));
  await assert.rejects(() => cmdMM(ctx, ['edit', POST, 'x'], { yes: true, asObject: true }), (e) => e.code === 'usage');
  await assert.rejects(() => cmdMM(ctx, ['delete', POST], { yes: true, asObject: true }), (e) => e.code === 'usage');
  await assert.rejects(() => cmdMM(ctx, ['delete', 'not-a-link'], { yes: true, asObject: true }), (e) => e.code === 'usage');
  assert.equal(ctx.calls.length, 0);
});

test('mm edit --dry-run ничего не пишет', async () => {
  const ctx = fakeCtx();
  const r = await cmdMM(ctx, ['edit', POST, 'x'], { dryRun: true, asObject: true });
  assert.equal(r.dry_run, true);
  assert.equal(ctx.calls.length, 0);
});
