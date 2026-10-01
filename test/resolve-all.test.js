import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cmdResolveAll, findCandidates } from '../src/commands/resolve-all.js';
import { CliError } from '../src/errors.js';

const root = mkdtempSync(path.join(tmpdir(), 'fs-harness-resolve-all-'));
after(() => rmSync(root, { recursive: true, force: true }));

const openNote = { resolvable: true, resolved: false, system: false, body: 'поправь', author: { username: 'rev' } };
const closedNote = { ...openNote, resolved: true };

// Пять MR: треды, конфликт, отставание, ничего, черновик с тредами. Ветки с ключом задачи — для MM.
const MRS = [
  { iid: 1, source_branch: 'feature/FD-1', target_branch: 'dev', user_notes_count: 1 },
  { iid: 2, source_branch: 'feature/FD-2', target_branch: 'feature/FD-9', user_notes_count: 1 },
  { iid: 3, source_branch: 'feature/FD-3', target_branch: 'dev', user_notes_count: 1 },
  { iid: 4, source_branch: 'feature/FD-4', target_branch: 'dev', user_notes_count: 1 },
  { iid: 5, source_branch: 'feature/FD-5', target_branch: 'dev', user_notes_count: 1, draft: true },
];
const STATE = { 1: { conflicts: 0, behind: 0 }, 2: { conflicts: 2, behind: 5 }, 3: { conflicts: 0, behind: 3 }, 4: { conflicts: 0, behind: 0 }, 5: { conflicts: 1, behind: 3 } };

const fakeG = () => ({
  me: async () => ({ username: 'me' }),
  listOpenMRs: async () => MRS.map((m) => ({ ...m })),
  listMRPipelines: async () => [],
  getApprovals: async () => ({}),
  getDiscussions: async (repo, iid) => [{ id: `d${iid}`, notes: [iid === 1 || iid === 5 ? openNote : closedNote] }],
});
const ctx = () => ({ g: fakeG(), repo: 'r/repo', cfg: { workers: { concurrency: 2 } } });
const probe = (mr) => STATE[mr.iid];
let n = 0;
const locksRoot = () => path.join(root, `locks-${n++}`);

test('resolve-all: кандидаты — треды, конфликт или отставание; MR без работы и черновик не берутся', async () => {
  const c = await findCandidates(ctx(), probe);
  assert.deepEqual(c.map((x) => x.iid), [1, 2, 3]);
  assert.deepEqual([c[0].threads, c[1].conflicts, c[2].behind], [1, 2, 3]);
  assert.equal(c[1].target, 'feature/FD-9'); // target у каждого MR свой
  assert.ok(c[2].steps.some((s) => /sync: merge dev/.test(s)));
});

test('resolve-all !3: берётся только названный MR', async () => {
  const c = await findCandidates(ctx(), probe, ['!3']);
  assert.deepEqual(c.map((x) => x.iid), [3]);
});

test('resolve-all --dry-run: план есть, ничего не запускается', async () => {
  const boom = async () => { throw new Error('не должен вызываться'); };
  const res = await cmdResolveAll(ctx(), { dryRun: true, asObject: true }, { probe, runAction: boom, mm: boom, locksRoot: locksRoot() });
  assert.equal(res.dry_run, true);
  assert.deepEqual(res.mrs.map((m) => m.iid), [1, 2, 3]);
});

test('resolve-all: внутри MR sync строго до threads, в MM одна реплика', async () => {
  const calls = [];
  const posts = [];
  const g = fakeG();
  g.getDiscussions = async (repo, iid) => [{ id: `d${iid}`, notes: [openNote] }];
  const runAction = async (spec, c, [iid], o) => {
    calls.push(`${spec.name}:${iid}:start:${Boolean(o.sync)}`);
    await new Promise((r) => setTimeout(r, spec.name === 'conflict' ? 20 : 1));
    calls.push(`${spec.name}:${iid}:end`);
    return spec.name === 'conflict'
      ? { ok: true, run: `c${iid}`, head_sha: 'abcdef1234567890' }
      : { ok: true, run: `t${iid}`, replied: [`d${iid}`], resolved: [], commits_ahead: 1, head_sha: '1234567890abcdef' };
  };
  const mm = async (c, args) => { posts.push(args); return { ok: true }; };
  const res = await cmdResolveAll({ ...ctx(), g }, { yes: true, asObject: true }, { probe: () => ({ conflicts: 0, behind: 2 }), runAction, mm, locksRoot: locksRoot() });
  assert.equal(res.ok, true);
  for (const iid of [1, 2, 3, 4]) {
    const mine = calls.filter((x) => x.includes(`:${iid}:`));
    assert.deepEqual(mine, [`conflict:${iid}:start:true`, `conflict:${iid}:end`, `threads:${iid}:start:false`, `threads:${iid}:end`]);
  }
  const first = res.mrs.find((m) => m.iid === 1);
  assert.deepEqual([first.sync.status, first.sync.runId, first.threads.status, first.threads.replied, first.mm.status], ['done', 'c1', 'done', ['d1'], 'sent']);
  assert.equal(posts.length, 4);
  assert.equal(posts[0][0], 'reply');
  assert.match(posts.find((p) => p[1] === 'FD-1')[2], /обновлена от dev.*отвечено тредов ревью: 1/);
});

test('resolve-all: падение одного MR не валит остальные, в отчёте runId и подсказка', async () => {
  const runAction = async (spec, c, [iid]) => {
    if (iid === '2') throw Object.assign(new CliError('Судья: revise', 1, 'judge_rejected'), { run: 'conflict-x' });
    if (spec.name === 'conflict') return { ok: true, run: `c${iid}`, head_sha: 'abcdef12' };
    return { ok: true, run: `t${iid}`, replied: ['d1'], commits_ahead: 0, head_sha: 'x' };
  };
  const res = await cmdResolveAll(ctx(), { yes: true, asObject: true, runsDir: path.join(root, 'runs') }, { probe, runAction, mm: async () => ({ ok: true }), locksRoot: locksRoot() });
  assert.equal(res.ok, false);
  const [one, two, three] = res.mrs;
  assert.deepEqual([one.threads.status, three.sync.status], ['done', 'done']);
  assert.deepEqual([two.sync.status, two.sync.runId, two.sync.phase, two.sync.code], ['failed', 'conflict-x', 'judge', 'judge_rejected']);
  assert.ok(two.sync.hint.includes('conflict-x'));
  assert.equal(two.mm.status, 'not_needed');
});

test('resolve-all: MM not_found — пометка в отчёте, MR не падает', async () => {
  const runAction = async (spec, c, [iid]) => (spec.name === 'conflict'
    ? { ok: true, run: `c${iid}`, head_sha: 'abcdef12' }
    : { ok: true, run: `t${iid}`, replied: ['d1'], commits_ahead: 0, head_sha: 'x' });
  const mm = async () => { throw new CliError('нет поста', 1, 'not_found'); };
  const res = await cmdResolveAll(ctx(), { yes: true, asObject: true }, { probe, runAction, mm, locksRoot: locksRoot() });
  assert.equal(res.ok, true);
  assert.ok(res.mrs.every((m) => m.mm.status === 'not_found'));
});

test('resolve-all: пропущенные действия не зовут MM', async () => {
  const runAction = async () => ({ ok: true, skipped: true });
  const mm = async () => { throw new Error('не должен вызываться'); };
  const res = await cmdResolveAll(ctx(), { yes: true, asObject: true }, { probe, runAction, mm, locksRoot: locksRoot() });
  assert.equal(res.ok, true);
  assert.ok(res.mrs.every((m) => m.mm.status === 'not_needed'));
});

test('resolve-all: по умолчанию без кнопки Telegram, --manual её возвращает', async () => {
  for (const manual of [false, true]) {
    const seen = [];
    const runAction = async (spec, c, args, o) => { seen.push(o.noApprovals); return { skipped: true }; };
    await cmdResolveAll(ctx(), { yes: true, asObject: true, manual, only: ['3'] }, { probe, runAction, mm: async () => ({}), locksRoot: locksRoot() });
    assert.ok(seen.length > 0);
    assert.ok(seen.every((v) => v === !manual));
  }
});

test('resolve-all: тред, где я ответил последним, работой не считается', async () => {
  const g = fakeG();
  const mine = { ...openNote, author: { username: 'me' } };
  g.getDiscussions = async (repo, iid) => [{ id: `d${iid}`, notes: iid === 1 ? [openNote, mine] : [closedNote] }];
  const c = await findCandidates({ ...ctx(), g }, probe);
  assert.deepEqual(c.map((x) => x.iid), [2, 3]);
});
