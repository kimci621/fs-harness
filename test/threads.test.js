import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { threadsAction, openThreads, parseReplies, formatThreads } from '../src/actions/threads.js';
import { runActionCLI } from '../src/engine.js';
import { CliError } from '../src/errors.js';

let root;
let project;

before(() => {
  root = mkdtempSync(path.join(tmpdir(), 'fs-harness-threads-'));
  const origin = path.join(root, 'origin.git');
  project = path.join(root, 'project');
  const git = (args, cwd) =>
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=t@e.st', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  git(['init', '--bare', '-b', 'target', origin], root);
  git(['clone', origin, project], root);
  writeFileSync(path.join(project, 'f.txt'), 'база\n');
  git(['add', 'f.txt'], project);
  git(['commit', '-m', 'база'], project);
  git(['push', 'origin', 'target'], project);
  git(['checkout', '-b', 'source'], project);
  writeFileSync(path.join(project, 'f.txt'), 'правка\n');
  git(['commit', '-am', 'правка'], project);
  git(['push', 'origin', 'source'], project);
  git(['checkout', 'target'], project);
});

after(() => rmSync(root, { recursive: true, force: true }));

const note = (over = {}) => ({ resolvable: true, resolved: false, system: false, author: { username: 'rev' }, body: 'тут утечка', ...over });

const discussions = [
  { id: 'aaa1', notes: [note({ position: { new_path: 'src/a.ts', new_line: 12 } }), note({ author: { username: 'dev' }, body: 'поправлю' })] },
  { id: 'bbb2', notes: [note({ resolved: true })] },
  { id: 'ccc3', notes: [note({ system: true, resolvable: false, body: 'изменил статус' })] },
  { id: 'ddd4', notes: [note({ body: 'общий вопрос по MR' })] },
];

const fakeGitlab = (over = {}) => ({
  getMR: async () => ({ iid: 7, title: 'тестовый MR', web_url: 'https://example.invalid/mr/7', source_branch: 'source', target_branch: 'target' }),
  getDiscussions: async () => discussions,
  ...over,
});

test('openThreads: берёт только нерешённые и несистемные, тянет позицию', () => {
  const open = openThreads(discussions);
  assert.deepEqual(open.map((t) => t.id), ['aaa1', 'ddd4']);
  assert.deepEqual([open[0].file, open[0].line], ['src/a.ts', 12]);
  assert.equal(open[0].notes.length, 2);
  assert.equal(open[1].file, null);
  assert.deepEqual(openThreads(undefined), []);
  assert.match(formatThreads(open), /Тред aaa1[\s\S]*src\/a\.ts:12[\s\S]*rev: тут утечка/);
});

test('parseReplies: дубли схлопываются, чужой id помечен, resolve по умолчанию true', () => {
  const r = parseReplies('[{"id":"aaa1","reply":"поправил"},{"id":"aaa1","reply":"ещё раз"},{"id":"zzz","reply":"?","resolve":false}]', ['aaa1']);
  assert.equal(r.length, 2);
  assert.deepEqual([r[0].reply, r[0].resolve, r[0].known], ['поправил', true, true]);
  assert.deepEqual([r[1].resolve, r[1].known], [false, false]);
});

test('parseReplies: не-JSON, не-массив и запись без текста — agent_failed', () => {
  for (const bad of ['не json', '{"id":"a"}', '[{"id":"a"}]', '[{"reply":"есть текст"}]']) {
    assert.throws(() => parseReplies(bad, ['a']), (e) => e instanceof CliError && e.code === 'agent_failed', bad);
  }
});

test('threads --dry-run: в плане только открытые треды', async () => {
  const plan = await runActionCLI(threadsAction, { g: fakeGitlab(), repo: 'r/repo' }, ['7'], {
    agent: 'claude', projectDir: project, dryRun: true, asObject: true,
  });
  assert.equal(plan.threads_open, 2);
  assert.deepEqual(plan.threads.map((t) => t.id), ['aaa1', 'ddd4']);
});

test('threads: нет открытых тредов — skipped, агент не запускается', async () => {
  const res = await runActionCLI(threadsAction, { g: fakeGitlab({ getDiscussions: async () => [discussions[1]] }), repo: 'r/repo' }, ['7'], {
    agent: 'claude', projectDir: project, yes: true, asObject: true,
  });
  assert.deepEqual([res.skipped, res.threads_open], [true, 0]);
});

test('publish: без коммитов не пушит, чужой тред пропускает, резолвит только помеченные', async () => {
  const calls = [];
  const g = {
    replyDiscussion: async (_r, _i, id, body) => calls.push(['reply', id, body]),
    resolveDiscussion: async (_r, _i, id) => calls.push(['resolve', id]),
  };
  const facts = {
    commits_ahead: 0,
    replies: [
      { id: 'aaa1', reply: 'поправил', resolve: true, known: true },
      { id: 'ddd4', reply: 'так задумано', resolve: false, known: true },
      { id: 'zzz', reply: 'чужой', resolve: true, known: false },
    ],
  };
  const ws = { dir: project, git: () => assert.fail('push при нулевых коммитах') };
  const out = await threadsAction.action.publish({ ctx: { g, repo: 'r/repo' }, target: { iid: 7, source_branch: 'source' }, ws, facts, say: () => {} });
  assert.deepEqual(out.replied, ['aaa1', 'ddd4']);
  assert.deepEqual(out.resolved, ['aaa1']);
  assert.deepEqual(calls.map((c) => c[0]), ['reply', 'resolve', 'reply']);
});
