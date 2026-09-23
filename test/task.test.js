import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cmdTask, branchFor, keyFromBranch, isProtected } from '../src/commands/task.js';

let root;
let project;

const git = (args, cwd = project) =>
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=t@e.st', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

const head = () => git(['rev-parse', '--abbrev-ref', 'HEAD']);

before(() => {
  root = mkdtempSync(path.join(tmpdir(), 'fs-harness-task-'));
  const origin = path.join(root, 'origin.git');
  project = path.join(root, 'project');
  git(['init', '--bare', '-b', 'dev', origin], root);
  git(['clone', origin, project], root);
  writeFileSync(path.join(project, 'f.txt'), 'база\n');
  git(['add', 'f.txt']);
  git(['commit', '-m', 'база']);
  git(['push', 'origin', 'dev']);
});

after(() => rmSync(root, { recursive: true, force: true }));

const ISSUE = { key: 'FD-1', fields: { summary: 'Починить', status: { name: 'К выполнению' } } };

// Контекст с поддельными Jira и GitLab: MR-ы живут в массиве, createMR в него добавляет.
function ctxWith({ mrs = [], created = [], posts = [] } = {}) {
  return {
    cfg: {
      projectDir: project, targetBranch: 'dev', branchPattern: 'feature/{key}',
      jira: { baseUrl: 'https://j.example' },
      mattermost: { baseUrl: 'https://mm.example', channels: { review: 'hn3e14mhebg9jmo5kmnzgbcque' } },
    },
    repo: 'g/p',
    jira: () => ({ issue: async () => ISSUE }),
    mm: () => ({ post: async (channel, message) => { posts.push({ channel, message }); return { id: 'p1' }; } }),
    g: {
      listOpenMRs: async () => mrs,
      createMR: async (repo, fields) => { created.push(fields); return { iid: 42, title: fields.title, web_url: 'https://gl/mr/42' }; },
    },
  };
}

test('task: имя ветки, ключ из ветки, защищённые ветки', () => {
  assert.equal(branchFor('FD-1'), 'feature/FD-1');
  assert.equal(branchFor('FD-1', 'task/{key}'), 'task/FD-1');
  assert.equal(keyFromBranch('feature/FD-7719'), 'FD-7719');
  assert.equal(keyFromBranch('feature/без-ключа'), null);
  assert.ok(isProtected('dev') && isProtected('master') && isProtected('rel/1.2'));
  assert.ok(isProtected('stage', 'stage'));
  assert.ok(!isProtected('feature/FD-1', 'dev'));
});

test('task start: создаёт ветку от origin/<target>, второй раз просто остаётся на ней', async () => {
  const ctx = ctxWith();
  const first = await cmdTask(ctx, ['start', 'FD-1'], { asObject: true, yes: true });
  assert.deepEqual([first.state, first.branch, first.base], ['created', 'feature/FD-1', 'origin/dev']);
  assert.equal(head(), 'feature/FD-1');
  assert.equal(first.issue.summary, 'Починить');

  const again = await cmdTask(ctx, ['start', 'FD-1'], { asObject: true, yes: true });
  assert.equal(again.state, 'already');

  git(['switch', 'dev']);
  const back = await cmdTask(ctx, ['start', 'FD-1'], { asObject: true, yes: true });
  assert.deepEqual([back.state, head()], ['switched', 'feature/FD-1']);
});

test('task start: dry-run показывает план и не трогает дерево', async () => {
  git(['switch', 'dev']);
  const dry = await cmdTask(ctxWith(), ['start', 'FD-2'], { asObject: true, dryRun: true });
  assert.deepEqual(dry.plan, ['git fetch origin dev', 'git switch -c feature/FD-2 origin/dev']);
  assert.equal(head(), 'dev');
});

test('task start: незакоммиченные правки останавливают переключение', async () => {
  git(['switch', 'dev']);
  writeFileSync(path.join(project, 'f.txt'), 'правка\n');
  await assert.rejects(
    () => cmdTask(ctxWith(), ['start', 'FD-3'], { asObject: true, yes: true }),
    (e) => e.code === 'dirty_checkout' && /f\.txt/.test(e.message),
  );
  assert.equal(head(), 'dev');
  git(['checkout', '--', 'f.txt']);
});

test('task push: пушит ветку и открывает MR в dev', async () => {
  const created = [];
  const ctx = ctxWith({ created });
  await cmdTask(ctx, ['start', 'FD-1'], { asObject: true, yes: true });
  writeFileSync(path.join(project, 'f.txt'), 'работа\n');
  git(['commit', '-am', 'работа']);

  const res = await cmdTask(ctx, ['push'], { asObject: true, yes: true });
  assert.deepEqual([res.commits_ahead, res.key, res.mr_created, res.mr.iid], [1, 'FD-1', true, 42]);
  assert.deepEqual(created[0], {
    source_branch: 'feature/FD-1',
    target_branch: 'dev',
    title: 'FD-1: Починить',
    description: 'https://j.example/browse/FD-1',
    remove_source_branch: true,
  });
  assert.equal(git(['rev-parse', 'origin/feature/FD-1']), git(['rev-parse', 'HEAD']));
});

test('task push --post: сообщение в Mattermost уходит только с флагом', async () => {
  const posts = [];
  const ctx = ctxWith({ mrs: [{ iid: 7, title: 'старый', web_url: 'https://gl/mr/7' }], posts });

  const plan = await cmdTask(ctx, ['push'], { asObject: true, yes: true, post: true, dryRun: true });
  assert.ok(plan.plan.some((l) => l.includes('Mattermost')));
  assert.equal(posts.length, 0);

  const quiet = await cmdTask(ctx, ['push'], { asObject: true, yes: true });
  assert.equal(quiet.posted, undefined);
  assert.equal(posts.length, 0);

  const res = await cmdTask(ctx, ['push'], { asObject: true, yes: true, post: true });
  assert.deepEqual(posts, [{
    channel: 'hn3e14mhebg9jmo5kmnzgbcque',
    message: 'старый\n• MR !7: https://gl/mr/7\n• Jira FD-1 https://j.example/browse/FD-1',
  }]);
  assert.equal(res.posted.scenario, 'review');
});

test('task push: уже открытый MR не дублируется', async () => {
  const created = [];
  const res = await cmdTask(ctxWith({ mrs: [{ iid: 7, title: 'старый', web_url: 'https://gl/mr/7' }], created }), ['push'], { asObject: true, yes: true });
  assert.deepEqual([res.mr_created, res.mr.iid, created.length], [false, 7, 0]);
});

test('task push: с защищённой ветки и без коммитов — отказ', async () => {
  await assert.rejects(
    () => cmdTask(ctxWith(), ['push'], { asObject: true, yes: true, target: 'feature/FD-1' }),
    (e) => e.code === 'usage' && /защищённой/.test(e.message),
  );
  git(['switch', '-c', 'feature/FD-9', 'origin/dev']);
  await assert.rejects(
    () => cmdTask(ctxWith(), ['push'], { asObject: true, yes: true }),
    (e) => e.code === 'no_commit',
  );
});

test('task submit: снимает черновик, переводит Jira, пишет в Mattermost', async () => {
  const posts = [];
  const updates = [];
  const moved = [];
  let done = false;
  const ctx = ctxWith({ mrs: [{ iid: 7, title: 'Draft: FD-1: Починить', web_url: 'https://gl/mr/7' }], posts });
  ctx.g.updateMR = async (repo, iid, fields) => { updates.push({ iid, fields }); return { iid, title: fields.title, web_url: 'https://gl/mr/7' }; };
  ctx.jira = () => ({
    transitions: async () => ({ transitions: [{ id: '31', name: 'В ревью', to: { name: 'Ревью' } }] }),
    issue: async () => ({ key: 'FD-1', names: {}, fields: { summary: 'Починить', status: { name: done ? 'Ревью' : 'В работе' } } }),
    transition: async (key, id) => { moved.push({ key, id }); done = true; },
  });

  const res = await cmdTask(ctx, ['submit', 'FD-1'], { asObject: true, yes: true });
  assert.equal(res.draft_removed, true);
  assert.deepEqual(updates, [{ iid: 7, fields: { title: 'FD-1: Починить' } }]);
  assert.deepEqual(moved, [{ key: 'FD-1', id: '31' }]);
  assert.deepEqual(res.jira, { from: 'В работе', to: 'Ревью', transition: 'В ревью' });
  assert.deepEqual(posts, [{
    channel: 'hn3e14mhebg9jmo5kmnzgbcque',
    message: 'FD-1: Починить\n• MR !7: https://gl/mr/7\n• Jira FD-1 https://j.example/browse/FD-1',
  }]);
});

test('task submit: обязательные поля перехода — отказ с подсказкой, MR не трогаем', async () => {
  const updates = [];
  const ctx = ctxWith({ mrs: [{ iid: 7, title: 'Draft: FD-1: Починить', web_url: 'https://gl/mr/7' }] });
  ctx.g.updateMR = async (...a) => { updates.push(a); };
  ctx.jira = () => ({
    transitions: async () => ({ transitions: [{ id: '31', name: 'В ревью', to: { name: 'Ревью' }, fields: { customfield_1: { required: true, name: 'Контент' } } }] }),
    issue: async () => ({ key: 'FD-1', names: {}, fields: { summary: 'Починить', status: { name: 'В работе' } } }),
    transition: async () => { throw new Error('переход не должен случиться'); },
  });

  await assert.rejects(
    () => cmdTask(ctx, ['submit', 'FD-1'], { asObject: true, yes: true }),
    (e) => e.code === 'jira_fields_missing' && /Контент/.test(e.message) && /jira field FD-1/.test(e.message),
  );
  assert.deepEqual(updates, [], 'черновик снят, хотя Jira не перевелась');
});

test('task submit: MR ищется по ветке задачи, даже если чекаут на dev', async () => {
  git(['switch', 'dev']);
  const seen = [];
  let moved = false;
  const ctx = ctxWith();
  ctx.g.listOpenMRs = async (repo, params) => {
    seen.push(params.source_branch);
    return params.source_branch === 'feature/FD-1' ? [{ iid: 9, title: 'Draft: FD-1: Починить', web_url: 'https://gl/mr/9' }] : [];
  };
  ctx.g.updateMR = async (repo, iid, fields) => ({ iid, title: fields.title, web_url: 'https://gl/mr/9' });
  ctx.jira = () => ({
    transitions: async () => ({ transitions: [{ id: '31', name: 'В ревью', to: { name: 'Ревью' } }] }),
    issue: async () => ({ key: 'FD-1', names: {}, fields: { summary: 'Починить', status: { name: moved ? 'Ревью' : 'В работе' } } }),
    transition: async () => { moved = true; },
  });

  const res = await cmdTask(ctx, ['submit', 'FD-1'], { asObject: true, yes: true });
  assert.equal(res.mr.iid, 9);
  assert.equal(res.branch, 'feature/FD-1');
  assert.ok(seen.includes('feature/FD-1'), 'MR не искали по ветке задачи');
});

test('task submit: без открытого MR — no_mr', async () => {
  const ctx = ctxWith({ mrs: [] });
  await assert.rejects(
    () => cmdTask(ctx, ['submit', 'FD-1'], { asObject: true, yes: true }),
    (e) => e.code === 'no_mr',
  );
});

test('task: неизвестный подкоманд — ошибка использования', async () => {
  await assert.rejects(() => cmdTask(ctxWith(), ['fly'], { asObject: true }), (e) => e.code === 'usage');
});

test('task judge: payload собирается из текста задачи, фактов и диффа', async () => {
  git(['switch', 'feature/FD-1']);
  const ctx = ctxWith();
  ctx.cfg.judge = { profiles: { p: { provider: 'cli', bin: 'claude' } }, roles: { 'task-acceptance': ['p'] } };
  ctx.jira = () => ({
    issue: async () => ({
      key: 'FD-1',
      names: { customfield_10242: 'Technical details for QA' },
      fields: { summary: 'Починить', description: 'надо починить', status: { name: 'В работе' }, customfield_10242: 'шаги' },
    }),
  });

  const dry = await cmdTask(ctx, ['judge'], { asObject: true, dryRun: true });
  assert.match(dry.payload, /FD-1: Починить/);
  assert.match(dry.payload, /Technical details for QA: заполнено/);
  assert.match(dry.payload, /Контент: пусто/);
  assert.match(dry.payload, /```diff/);
});

test('task judge: без изменений против целевой ветки — no_commit', async () => {
  git(['switch', '-c', 'feature/FD-8', 'origin/dev']);
  await assert.rejects(
    () => cmdTask(ctxWith(), ['judge'], { asObject: true }),
    (e) => e.code === 'no_commit',
  );
});
