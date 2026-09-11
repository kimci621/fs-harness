import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { reviewAction, loadRules, formatChanges } from '../src/actions/review.js';
import { analyzeAction, formatComments } from '../src/actions/analyze.js';
import { runActionCLI } from '../src/engine.js';

const CHANGES = [
  { new_path: 'src/a.ts', old_path: 'src/a.ts', diff: '@@ -1 +1 @@\n-a\n+b\n' },
  { new_path: 'src/new.ts', old_path: 'src/new.ts', new_file: true, diff: '@@ -0,0 +1 @@\n+новый\n' },
];

const project = (() => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fs-harness-read-'));
  execFileSync('git', ['init', '-q', dir]);
  return dir;
})();

test('review: правила берутся из проекта, а нет — встроенные', () => {
  assert.equal(loadRules(project).source, 'встроенные');
  const skill = path.join(project, '.claude', 'skills', 'mr-review');
  mkdirSync(skill, { recursive: true });
  writeFileSync(path.join(skill, 'SKILL.md'), 'правила проекта\n');
  const rules = loadRules(project);
  assert.match(rules.source, /SKILL\.md$/);
  assert.equal(rules.text, 'правила проекта');
});

test('formatChanges: заголовок как в git, новый файл помечен', () => {
  const { files, diff } = formatChanges(CHANGES);
  assert.deepEqual(files.map((f) => f.kind), ['изменён', 'новый']);
  assert.match(diff, /^diff --git a\/src\/a\.ts b\/src\/a\.ts/);
  assert.equal(formatChanges(undefined).files.length, 0);
});

test('review --dry-run: файлы и источник правил в плане', async () => {
  const g = {
    getMR: async () => ({ iid: 7, title: 'MR', web_url: 'u', source_branch: 's', target_branch: 't' }),
    getMRChanges: async () => ({ changes: CHANGES }),
  };
  const plan = await runActionCLI(reviewAction, { g, repo: 'r/repo' }, ['7'], {
    agent: 'claude', projectDir: project, dryRun: true, asObject: true,
  });
  assert.deepEqual(plan.files, ['src/a.ts', 'src/new.ts']);
  assert.match(plan.rules, /SKILL\.md$/);
});

test('review: пустой MR — skipped, агента не зовём', async () => {
  const g = {
    getMR: async () => ({ iid: 7, title: 'MR', web_url: 'u', source_branch: 's', target_branch: 't' }),
    getMRChanges: async () => ({ changes: [] }),
  };
  const res = await runActionCLI(reviewAction, { g, repo: 'r/repo' }, ['7'], {
    agent: 'claude', projectDir: project, yes: true, asObject: true,
  });
  assert.deepEqual([res.skipped, res.files], [true, 0]);
});

test('analyze --dry-run: задача из Jira, ключ проверяется по форме', async () => {
  const ctx = {
    cfg: { jira: { baseUrl: 'https://j.invalid' } },
    jira: () => ({
      issue: async (key) => ({ key, fields: { summary: 'Починить', status: { name: 'Open' } } }),
      comments: async () => ({ comments: [{ author: { displayName: 'PM' }, created: '2026-09-01T10:00:00.000+0300', body: 'вопрос' }] }),
    }),
  };
  const plan = await runActionCLI(analyzeAction, ctx, ['FD-7647'], {
    agent: 'claude', projectDir: project, dryRun: true, asObject: true,
  });
  assert.deepEqual([plan.issue, plan.comments], ['FD-7647', 1]);

  await assert.rejects(
    () => runActionCLI(analyzeAction, ctx, ['!2547'], { agent: 'claude', projectDir: project, dryRun: true, asObject: true }),
    (e) => e.code === 'usage',
  );
});

test('formatComments: пусто и с автором', () => {
  assert.equal(formatComments([]), 'Комментариев нет.');
  assert.match(formatComments([{ author: { displayName: 'PM' }, created: '2026-09-01T10:00:00.000+0300', body: ' текст ' }]), /\*\*PM\*\*[\s\S]*текст/);
});

process.on('exit', () => rmSync(project, { recursive: true, force: true }));
