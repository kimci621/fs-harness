import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cmdTask } from '../src/commands/task.js';

let root;
let project;
const git = (args, cwd = project) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e.st', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

before(() => {
  root = mkdtempSync(path.join(tmpdir(), 'fsh-submit-'));
  project = path.join(root, 'project');
  git(['init', '-b', 'feature/FD-1', project], root);
  writeFileSync(path.join(project, 'f.txt'), 'x\n');
  git(['add', 'f.txt']);
  git(['commit', '-m', 'x']);
});
after(() => rmSync(root, { recursive: true, force: true }));

const CH = 'hn3e14mhebg9jmo5kmnzgbcque';
const ME = 'm'.repeat(26);
const READY_MR = { iid: 7, has_conflicts: false, blocking_discussions_resolved: true, head_pipeline: { status: 'success' }, merge_status: 'can_be_merged', detailed_merge_status: 'mergeable' };

function ctxWith({ channelPosts = [], mr = READY_MR } = {}) {
  const posts = [];
  const updates = [];
  let done = false;
  const ctx = {
    cfg: {
      projectDir: project, targetBranch: 'dev', branchPattern: 'feature/{key}',
      jira: { baseUrl: 'https://j.example' },
      mattermost: { baseUrl: 'https://mm.example', channels: { review: CH } },
    },
    repo: 'g/p',
    jira: () => ({
      transitions: async () => ({ transitions: [{ id: '31', name: 'В ревью', to: { name: 'Ревью' } }] }),
      issue: async () => ({ key: 'FD-1', names: {}, fields: { summary: 'Починить', status: { name: done ? 'Ревью' : 'В работе' } } }),
      transition: async () => { done = true; },
    }),
    mm: () => ({
      me: async () => ({ id: ME }),
      channelPosts: async () => ({ order: channelPosts.map((p) => p.id), posts: Object.fromEntries(channelPosts.map((p) => [p.id, p])) }),
      teams: async () => [{ id: 't1', name: 'fitstars' }],
      channel: async () => ({ id: CH, team_id: 't1' }),
      post: async (channel, message) => { posts.push({ channel, message }); return { id: 'n'.repeat(26) }; },
    }),
    g: {
      listOpenMRs: async () => [{ iid: 7, title: 'Draft: FD-1: Починить', web_url: 'https://gl/mr/7' }],
      getMR: async () => mr,
      updateMR: async (repo, iid, fields) => { updates.push(fields); return { iid, title: fields.title }; },
    },
  };
  return { ctx, posts, updates };
}

const OLD = 'o'.repeat(26);

test('task submit повторно: свой пост про задачу уже есть — второго не публикуем, печатаем его ссылку', async () => {
  const { ctx, posts } = ctxWith({ channelPosts: [{ id: OLD, root_id: '', user_id: ME, message: 'FD-1: Починить\n• MR: x' }] });
  const res = await cmdTask(ctx, ['submit', 'FD-1'], { asObject: true, yes: true });
  assert.deepEqual(posts, []);
  assert.equal(res.posted.existed, true);
  assert.match(res.steps.find((s) => s.step === 'Mattermost').note, new RegExp(`уже есть: https://mm.example/fitstars/pl/${OLD}`));
});

test('task submit: чужой пост или пост про другую задачу — публикуем как обычно', async () => {
  const { ctx, posts } = ctxWith({ channelPosts: [
    { id: OLD, root_id: '', user_id: 'x'.repeat(26), message: 'FD-1: Починить' },
    { id: 'q'.repeat(26), root_id: '', user_id: ME, message: 'FD-10: другое' },
  ] });
  const res = await cmdTask(ctx, ['submit', 'FD-1'], { asObject: true, yes: true });
  assert.equal(posts.length, 1);
  assert.equal(res.posted.existed, undefined);
});

test('task submit: has_conflicts=false, но GitLab ещё проверяет слияние — черновик не снимаем', async () => {
  for (const st of [
    { merge_status: 'unchecked', detailed_merge_status: 'unchecked' },
    { merge_status: 'checking', detailed_merge_status: 'checking' },
    { merge_status: 'cannot_be_merged_recheck', detailed_merge_status: 'conflict' },
  ]) {
    const { ctx, updates } = ctxWith({ mr: { ...READY_MR, ...st, has_conflicts: false } });
    const res = await cmdTask(ctx, ['submit', 'FD-1'], { asObject: true, yes: true });
    assert.equal(res.draft_removed, false, st.merge_status);
    assert.deepEqual(updates, []);
    assert.match(res.steps.find((s) => s.step === 'MR').note, /GitLab ещё проверяет слияние/);
  }
});

test('task submit: не удалось проверить, был ли пост, — пост не шлём, команда падает с подсказкой', async () => {
  const { ctx, posts } = ctxWith();
  const mm = ctx.mm;
  ctx.mm = () => ({ ...mm(), channelPosts: async () => { throw new Error('MM 502'); } });
  await assert.rejects(
    () => cmdTask(ctx, ['submit', 'FD-1'], { asObject: true, yes: true }),
    (e) => e.code === 'api_failed' && e.exitCode === 1 && /MM 502/.test(e.message) && /fsh mm review FD-1/.test(e.message),
  );
  assert.deepEqual(posts, []);
});

test('task submit: detailed_merge_status=preparing — черновик не снимаем', async () => {
  const { ctx, updates } = ctxWith({ mr: { ...READY_MR, merge_status: 'can_be_merged', detailed_merge_status: 'preparing' } });
  const res = await cmdTask(ctx, ['submit', 'FD-1'], { asObject: true, yes: true });
  assert.equal(res.draft_removed, false);
  assert.deepEqual(updates, []);
});
