import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveMR, similarity } from '../src/resolve.js';
import { CliError } from '../src/errors.js';

const MRS = [
  { iid: 2547, title: 'A', source_branch: 'feature/FD-7230', target_branch: 'dev' },
  { iid: 2546, title: 'B', source_branch: 'fix/main-banner-flicker', target_branch: 'dev' },
  { iid: 2545, title: 'C', source_branch: 'feature/special-offer-exercise-marathon-redirect', target_branch: 'dev' },
];

function fakeG(list = MRS) {
  return {
    listOpenMRs: async () => list,
    getMR: async (_repo, iid) => list.find((m) => m.iid === Number(iid)) || null,
  };
}

test('resolveMR: по номеру !2547', async () => {
  const mr = await resolveMR(fakeG(), 'r/repo', '!2547');
  assert.equal(mr.iid, 2547);
});

test('resolveMR: по части имени ветки (неточное)', async () => {
  const mr = await resolveMR(fakeG(), 'r/repo', 'banner-fl');
  assert.equal(mr.iid, 2546);
});

test('resolveMR: не найдена → ошибка с ближайшими', async () => {
  await assert.rejects(() => resolveMR(fakeG(), 'r/repo', 'premium'),
    (e) => e instanceof CliError && /не найдена/.test(e.message) && /main-banner/.test(e.message));
});

test('resolveMR: несколько совпадений → ошибка со списком', async () => {
  await assert.rejects(() => resolveMR(fakeG(), 'r/repo', 'feature'),
    (e) => e instanceof CliError && /нескольким MR/.test(e.message) && /2547/.test(e.message));
});

test('similarity: точное > префикс > подстрока', () => {
  assert.equal(similarity('fix/banner', 'fix/banner'), 1);
  assert.ok(similarity('fix/banner-x', 'fix/banner') > similarity('x-fix/banner', 'fix/banner'));
  assert.ok(similarity('xfixbannery', 'fix/banner') > 0.3);
});
