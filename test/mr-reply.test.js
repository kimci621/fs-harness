import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cmdMRComments } from '../src/commands/mr-comments.js';
import { cmdMRThread } from '../src/commands/mr-thread.js';

const ID1 = 'a'.repeat(40);
const ID2 = 'b'.repeat(40);
const DISCUSSIONS = [
  { id: 'sys', resolvable: false, notes: [{ id: 9, author: { username: 'bot' }, body: 'x', system: true }] },
  { id: ID1, resolvable: true, resolved: false, notes: [{ id: 1, author: { username: 'u1' }, body: 'поправь', system: false }] },
  { id: ID2, resolvable: false, notes: [{ id: 2, author: { username: 'u2' }, body: 'коммент', system: false }] },
];

const fakeG = () => {
  const calls = [];
  return {
    calls,
    getMR: async () => ({ iid: 7 }),
    getDiscussions: async () => DISCUSSIONS,
    replyDiscussion: async (repo, iid, id, body) => { calls.push(['reply', iid, id, body]); return { id: 55 }; },
    resolveDiscussion: async (repo, iid, id) => { calls.push(['resolve', iid, id]); return {}; },
  };
};

test('mr-comments: номер треда стабилен под фильтром и в выводе полный id', async () => {
  const g = fakeG();
  const all = await cmdMRComments(g, 'repo', ['7'], { asObject: true });
  const open = await cmdMRComments(g, 'repo', ['7'], { open: true, resolved: false, asObject: true });
  assert.deepEqual(all.discussions.map((d) => [d.n, d.id]), [[1, ID1], [2, ID2]]);
  assert.deepEqual(open.discussions.map((d) => d.n), [1, 2]);

  const lines = [];
  const orig = console.log;
  console.log = (s) => lines.push(String(s));
  try { await cmdMRComments(g, 'repo', ['7'], {}); } finally { console.log = orig; }
  assert.ok(lines.some((l) => l.includes(`#1`) && l.includes(ID1)), lines.join('\n'));
});

test('mr reply: тред по #N, текст аргументом уходит в replyDiscussion', async () => {
  const g = fakeG();
  const r = await cmdMRThread(g, 'repo', 'reply', ['7', '#1', 'Поправил,', 'спасибо'], { yes: true, asObject: true });
  assert.deepEqual(g.calls, [['reply', 7, ID1, 'Поправил, спасибо']]);
  assert.equal(r.thread.id, ID1);
  assert.equal(r.note_id, 55);
});

test('mr reply: тред по полному id и текст из --file', async () => {
  const g = fakeG();
  const dir = mkdtempSync(path.join(tmpdir(), 'fsh-reply-'));
  const file = path.join(dir, 'r.md');
  writeFileSync(file, 'строка 1\nстрока 2\n');
  await cmdMRThread(g, 'repo', 'reply', ['7', ID2], { file, yes: true, asObject: true });
  assert.deepEqual(g.calls, [['reply', 7, ID2, 'строка 1\nстрока 2']]);
});

test('mr reply: неизвестный тред и пустой текст — понятные ошибки без записи', async () => {
  const g = fakeG();
  await assert.rejects(() => cmdMRThread(g, 'repo', 'reply', ['7', '#5', 'x'], { yes: true, asObject: true }), (e) => e.code === 'not_found');
  await assert.rejects(() => cmdMRThread(g, 'repo', 'reply', ['7', '#1'], { yes: true, asObject: true }), (e) => e.code === 'usage');
  assert.equal(g.calls.length, 0);
});

test('mr reply --dry-run ничего не пишет', async () => {
  const g = fakeG();
  const r = await cmdMRThread(g, 'repo', 'reply', ['7', '1', 'x'], { dryRun: true, asObject: true });
  assert.equal(r.dry_run, true);
  assert.equal(g.calls.length, 0);
});

test('mr resolve: резолвит через resolveDiscussion, обычный коммент не резолвится', async () => {
  const g = fakeG();
  const r = await cmdMRThread(g, 'repo', 'resolve', ['7', '#1'], { yes: true, asObject: true });
  assert.deepEqual(g.calls, [['resolve', 7, ID1]]);
  assert.equal(r.resolved, true);
  await assert.rejects(() => cmdMRThread(g, 'repo', 'resolve', ['7', '#2'], { yes: true, asObject: true }), (e) => e.code === 'usage');
});
