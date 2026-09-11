import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { diffSnapshots, keepEvents, triagePayload, formatEvents, pollOnce, stateFile } from '../src/watch.js';

const mr = (over) => ({
  iid: 1, title: 'MR', source_branch: 'f', target_branch: 'dev', has_conflicts: false,
  pipeline: { id: 1, status: 'success' }, comments: { total: 0, open: 0, resolved: 0 },
  updated_at: '2026-09-11T10:00:00Z', web_url: 'https://gl/1', ...over,
});
const snap = (mrs) => ({ at: '2026-09-11T10:00:00Z', repo: 'a/b', mrs });

test('diff: первый снимок молчит, дальше видит пайплайн, треды, конфликт, приход и уход', () => {
  assert.deepEqual(diffSnapshots(null, snap([mr({})])), []);

  const prev = snap([mr({}), mr({ iid: 2, web_url: 'https://gl/2' })]);
  const next = snap([
    mr({ pipeline: { id: 2, status: 'failed' }, comments: { total: 3, open: 2, resolved: 1 }, has_conflicts: true }),
    mr({ iid: 3, web_url: 'https://gl/3' }),
  ]);
  const kinds = diffSnapshots(prev, next).map((e) => `${e.kind}:${e.mr}`);
  assert.deepEqual(kinds, ['pipeline:1', 'threads:1', 'conflict:1', 'mr_new:3', 'mr_gone:2']);
});

test('diff: без изменений событий нет, закрытые треды событием не считаются', () => {
  const prev = snap([mr({ comments: { total: 3, open: 2, resolved: 1 } })]);
  const next = snap([mr({ comments: { total: 3, open: 0, resolved: 3 } })]);
  assert.deepEqual(diffSnapshots(prev, next), []);
  assert.deepEqual(diffSnapshots(snap([mr({})]), snap([mr({})])), []);
});

test('триаж: nit и неупомянутые события до канала не доходят, провал триажа шлёт всё', () => {
  const events = diffSnapshots(snap([mr({}), mr({ iid: 2 })]), snap([
    mr({ pipeline: { id: 2, status: 'failed' } }),
    mr({ iid: 2, comments: { total: 1, open: 1, resolved: 0 } }),
  ]));
  assert.equal(events.length, 2);
  assert.match(triagePayload(events, 'a/b'), /e1 · pipeline · MR !1/);

  const verdict = {
    summary: 'один пайплайн упал',
    findings: [
      { severity: 'blocker', file: 'e1', line: 0, body: 'упал пайплайн' },
      { severity: 'nit', file: 'e2', line: 0, body: 'чужой тред' },
    ],
  };
  const kept = keepEvents(events, verdict);
  assert.deepEqual(kept.map((e) => [e.id, e.level]), [['e1', 'срочно']]);
  assert.match(formatEvents(kept, { verdict }), /срочно: MR !1/);

  // Судья недоступен — сигнал не теряем.
  assert.equal(keepEvents(events, null).length, 2);
  assert.equal(formatEvents([]), 'Ничего важного.');
});

test('pollOnce: первый опрос только пишет снимок, второй уже сравнивает и судит', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fs-harness-watch-'));
  const file = path.join(dir, 'state.json');
  let mrs = [mr({})];
  const g = {
    listOpenMRs: async () => mrs.map((m) => ({ ...m, sha: 'abc' })),
    listMRPipelines: async () => [],
    getDiscussions: async () => [],
  };
  const cfg = { judge: { profiles: { fake: { provider: 'fake' } }, roles: { 'event-triage': ['fake'] } } };
  const makeProvider = async () => ({
    name: 'fake',
    complete: async () => ({
      text: JSON.stringify({
        decision: 'reject', confidence: 0.8, summary: 'конфликт',
        findings: [{ severity: 'blocker', file: 'e1', line: 0, body: 'конфликт с dev' }],
        checks: [], next: { action: 'none', hint: '' },
      }),
      cost: 0,
    }),
  });

  const first = await pollOnce({ g, repo: 'a/b', cfg, file, makeProvider });
  assert.equal(first.first, true);
  assert.deepEqual(first.events, []);

  mrs = [mr({ has_conflicts: true })];
  const second = await pollOnce({ g, repo: 'a/b', cfg, file, makeProvider });
  assert.equal(second.first, false);
  assert.deepEqual(second.events.map((e) => e.kind), ['conflict']);
  assert.deepEqual(second.kept.map((e) => e.level), ['срочно']);
  rmSync(dir, { recursive: true, force: true });
});

test('stateFile: слеш в имени репозитория не создаёт вложенных каталогов', () => {
  assert.equal(path.basename(stateFile('a/b', '/tmp/x')), 'a%2Fb.json');
});
