import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  reviewAction,
  loadRules,
  formatChanges,
  buildDiffIndex,
  buildPosition,
  formatFindingComment,
  formatFallbackComment,
  formatSummaryComment,
} from '../src/actions/review.js';
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

test('buildDiffIndex & buildPosition: позиция для inline-дискуссии', () => {
  const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,3 +10,4 @@
 context line
-old line
+new line 1
+new line 2
 context 2`;

  const index = buildDiffIndex(diff);
  assert.ok(index['src/a.ts']);
  assert.equal(index['src/a.ts'].old_path, 'src/a.ts');

  const diffRefs = { base_sha: 'b1', start_sha: 's1', head_sha: 'h1' };

  // Добавленная строка
  const posAdded = buildPosition(diffRefs, { file: 'src/a.ts', line: 11 }, index);
  assert.deepEqual(posAdded, {
    base_sha: 'b1',
    start_sha: 's1',
    head_sha: 'h1',
    position_type: 'text',
    new_path: 'src/a.ts',
    old_path: 'src/a.ts',
    new_line: 11,
  });

  // Контекстная строка требует и new_line, и old_line
  const posContext = buildPosition(diffRefs, { file: 'src/a.ts', line: 10 }, index);
  assert.deepEqual(posContext, {
    base_sha: 'b1',
    start_sha: 's1',
    head_sha: 'h1',
    position_type: 'text',
    new_path: 'src/a.ts',
    old_path: 'src/a.ts',
    new_line: 10,
    old_line: 10,
  });

  // Строка вне диффа
  assert.equal(buildPosition(diffRefs, { file: 'src/a.ts', line: 99 }, index), null);
  // Неизвестный файл
  assert.equal(buildPosition(diffRefs, { file: 'src/unknown.ts', line: 1 }, index), null);
  // Без diff_refs
  assert.equal(buildPosition(null, { file: 'src/a.ts', line: 11 }, index), null);
});

test('formatFindingComment & formatSummaryComment', () => {
  const finding = { file: 'src/a.ts', line: 11, severity: 'blocker', body: 'Ошибка контракта' };
  assert.match(formatFindingComment(finding), /🚫 \*\*BLOCKER\*\*[\s\S]*Ошибка контракта/);
  assert.match(formatFallbackComment(finding), /🚫 \*\*BLOCKER\*\* \(`src\/a\.ts`, строка 11\)[\s\S]*Ошибка контракта/);

  const summary = formatSummaryComment({ summary: 'Всё хорошо' }, [
    finding,
    { file: 'src/a.ts', line: 12, severity: 'warning', body: 'Дублирование' },
  ]);
  assert.match(summary, /🤖 \*\*FS-Harness Code Review\*\*/);
  assert.match(summary, /Всё хорошо/);
  assert.match(summary, /🚫 \*\*BLOCKER\*\* 1/);
  assert.match(summary, /⚠ \*\*WARNING\*\* 1/);
});

test('review publish: без --post молчит, с --post отправляет inline и саммари', async () => {
  const diff = 'diff --git a/src/a.ts b/src/a.ts\n@@ -1,2 +1,2 @@\n context\n+new line\n';
  const discussions = [];
  const notes = [];
  const g = {
    createDiscussion: async (repo, iid, data) => {
      discussions.push(data);
      return { id: 'disc-' + discussions.length };
    },
    createNote: async (repo, iid, data) => {
      notes.push(data);
      return { id: notes.length };
    },
  };

  const verdict = {
    summary: 'Найдены проблемы',
    findings: [
      { file: 'src/a.ts', line: 2, severity: 'blocker', body: 'Блокер в строке 2' },
      { file: 'src/a.ts', line: 99, severity: 'nit', body: 'Замечание вне диффа' },
    ],
  };

  const ctx = { g, repo: 'r/repo' };
  const target = { iid: 10, diff_refs: { base_sha: 'b', start_sha: 's', head_sha: 'h' } };
  const pre = { diff };

  // Без --post
  const noPost = await reviewAction.action.publish({
    ctx, opts: { post: false }, target, pre, verdict, say: () => {},
  });
  assert.deepEqual(noPost, { posted: false, discussions: 0, notes: 0 });
  assert.equal(discussions.length, 0);
  assert.equal(notes.length, 0);

  // С --post
  const posted = await reviewAction.action.publish({
    ctx, opts: { post: true }, target, pre, verdict, say: () => {},
  });
  assert.equal(posted.posted, true);
  assert.equal(posted.discussions, 1);
  assert.equal(posted.notes, 2); // 1 фолбэк для строки 99 + 1 саммари
  assert.equal(discussions.length, 1);
  assert.equal(discussions[0].position.new_line, 2);
  assert.match(discussions[0].body, /🚫 \*\*BLOCKER\*\*/);
  assert.match(notes[0], /💬 \*\*NIT\*\* \(`src\/a\.ts`, строка 99\)/);
  assert.match(notes[1], /🤖 \*\*FS-Harness Code Review\*\*/);
});

test('analyze verify: с backend_refs.json, без него и с битым JSON', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fsh-refs-'));
  try {
    const pre = { comments: [] };

    // 1. Без файла
    const withoutFile = analyzeAction.action.verify({ pre, agentText: 'разбор', run: { dir } });
    assert.deepEqual(withoutFile.backend_refs, []);

    // 2. Валидный backend_refs.json
    writeFileSync(path.join(dir, 'backend_refs.json'), JSON.stringify([
      'app/Http/Controllers/UserController.php:42',
      'app/Http/Resources/UserResource.php:15',
    ]));
    const withFile = analyzeAction.action.verify({ pre, agentText: 'разбор', run: { dir } });
    assert.deepEqual(withFile.backend_refs, [
      'app/Http/Controllers/UserController.php:42',
      'app/Http/Resources/UserResource.php:15',
    ]);

    // 3. Битый JSON
    const warnings = [];
    writeFileSync(path.join(dir, 'backend_refs.json'), '{ invalid json');
    const broken = analyzeAction.action.verify({
      pre, agentText: 'разбор', run: { dir }, say: (msg) => warnings.push(msg),
    });
    assert.deepEqual(broken.backend_refs, []);
    assert.ok(warnings.some((w) => w.includes('backend_refs.json повреждён')));

    // 4. Не массив
    const notArrayWarnings = [];
    writeFileSync(path.join(dir, 'backend_refs.json'), JSON.stringify({ not: 'an array' }));
    const notArray = analyzeAction.action.verify({
      pre, agentText: 'разбор', run: { dir }, say: (msg) => notArrayWarnings.push(msg),
    });
    assert.deepEqual(notArray.backend_refs, []);
    assert.ok(notArrayWarnings.some((w) => w.includes('не является массивом')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

process.on('exit', () => rmSync(project, { recursive: true, force: true }));

