import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { commitPrompt, findPatternFile, loadTemplate, renderTemplate, listTemplates, templatePaths, checkTemplates } from '../src/prompts.js';

function makeRepo(files = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'fsh-test-'));
  mkdirSync(path.join(dir, '.git'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

test('commitPrompt: без .llm-commit-pattern — встроенный промпт', () => {
  const dir = makeRepo();
  try {
    const { source, prompt } = commitPrompt(dir);
    assert.equal(source, 'builtin');
    assert.match(prompt, /<имя текущей ветки>/);
    assert.match(prompt, /ЯВНЫМИ путями/);
    assert.match(prompt, /Никогда не используй git add -A/); // указания добавить всё быть не должно
    assert.doesNotMatch(prompt, /git add -A &&/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('commitPrompt: .llm-commit-pattern в корне репо заменяет промпт', () => {
  const dir = makeRepo({ '.llm-commit-pattern': 'FIT-123: <тип>: <описание>' });
  try {
    const { source, prompt } = commitPrompt(dir);
    assert.equal(source, path.join(dir, '.llm-commit-pattern'));
    assert.match(prompt, /FIT-123: <тип>: <описание>/);
    assert.doesNotMatch(prompt, /<имя текущей ветки>/); // встроенный паттерн заменён, а не добавлен
    assert.match(prompt, /Изучи изменения/); // инструкция остаётся общей
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('findPatternFile: ищет вверх от подкаталога до корня репо', () => {
  const dir = makeRepo({ '.llm-commit-pattern': 'X' });
  try {
    const sub = path.join(dir, 'apps', 'web');
    mkdirSync(sub, { recursive: true });
    assert.equal(findPatternFile(sub), path.join(dir, '.llm-commit-pattern'));
    assert.equal(findPatternFile(dir), path.join(dir, '.llm-commit-pattern'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('findPatternFile: без файла — null, не выходит выше корня репо', () => {
  const dir = makeRepo();
  try {
    const sub = path.join(dir, 'apps');
    mkdirSync(sub, { recursive: true });
    assert.equal(findPatternFile(sub), null);
    assert.equal(findPatternFile(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('templatePaths: проект → личный → встроенный', () => {
  const paths = templatePaths('actions/x', { projectDir: '/p' });
  assert.equal(paths.length, 3);
  assert.equal(paths[0], '/p/.fs-harness/prompts/actions/x.md');
  assert.match(paths[1], /\.config\/fs-harness\/prompts\/actions\/x\.md$/);
  assert.match(paths[2], /src\/prompts\/actions\/x\.md$/);
  assert.equal(templatePaths('x').length, 2); // без projectDir проектного слоя нет
});

test('loadTemplate: проектный оверрайд перебивает встроенный, front-matter разобран', () => {
  const dir = makeRepo();
  try {
    assert.equal(loadTemplate('commit').source, 'builtin');
    mkdirSync(path.join(dir, '.fs-harness', 'prompts'), { recursive: true });
    writeFileSync(path.join(dir, '.fs-harness', 'prompts', 'commit.md'), '---\nvars: [pattern]\n---\nмой коммит {{pattern}}');
    const t = loadTemplate('commit', { projectDir: dir });
    assert.equal(t.source, path.join(dir, '.fs-harness', 'prompts', 'commit.md'));
    assert.deepEqual(t.meta.vars, ['pattern']);
    assert.equal(t.body, 'мой коммит {{pattern}}');
    assert.throws(() => loadTemplate('нет-такого'), (e) => e.code === 'prompt_missing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('renderTemplate: блоки, без HTML-экранирования, строгость по vars', () => {
  const dir = makeRepo();
  const file = path.join(dir, '.fs-harness', 'prompts', 't.md');
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '---\nvars: [a, deps]\n---\n{{a}}\n{{#deps}}есть{{/deps}}{{^deps}}нет{{/deps}}');
    const on = renderTemplate('t', { a: 'x && y <z>', deps: true }, { projectDir: dir });
    assert.equal(on.text, 'x && y <z>\nесть'); // кавычки и амперсанды доезжают как есть
    assert.deepEqual(on.used.sort(), ['a', 'deps']);
    assert.equal(renderTemplate('t', { a: 'x', deps: false }, { projectDir: dir }).text, 'x\nнет');
    assert.throws(
      () => renderTemplate('t', { a: 'x' }, { projectDir: dir }),
      (e) => e.code === 'prompt_var_missing' && e.message.includes('deps'),
    );
    // Объявлена, но не использована — повод предупредить, а не падать.
    writeFileSync(file, '---\nvars: [a, лишняя]\n---\n{{a}}');
    assert.deepEqual(renderTemplate('t', { a: 'x', 'лишняя': 1 }, { projectDir: dir }).unused, ['лишняя']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listTemplates: встроенные видны, проектный помечен как переопределённый', () => {
  const dir = makeRepo();
  try {
    const names = listTemplates().map((t) => t.name);
    assert.ok(names.includes('commit'));
    assert.ok(names.includes('judge/acceptance'));
    mkdirSync(path.join(dir, '.fs-harness', 'prompts'), { recursive: true });
    writeFileSync(path.join(dir, '.fs-harness', 'prompts', 'commit.md'), 'мой');
    const commit = listTemplates({ projectDir: dir }).find((t) => t.name === 'commit');
    assert.equal(commit.overridden, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkTemplates: встроенные шаблоны без ошибок, кривой оверрайд ловится', () => {
  assert.deepEqual(checkTemplates().filter((p) => p.level === 'error'), []);
  const dir = makeRepo();
  try {
    mkdirSync(path.join(dir, '.fs-harness', 'prompts'), { recursive: true });
    writeFileSync(path.join(dir, '.fs-harness', 'prompts', 'commit.md'), '---\nvars: [pattern]\n---\n{{pattern}} {{забыли}}');
    const errs = checkTemplates({ projectDir: dir }).filter((p) => p.level === 'error');
    assert.equal(errs.length, 1);
    assert.match(errs[0].message, /\{\{забыли\}\}/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('analyze: с backend_dir содержит блок бэкенда, без него — скрывает', () => {
  const baseVars = {
    issue_key: 'FD-1234',
    issue_summary: 'Тестовая задача',
    issue_status: 'Open',
    issue_description: 'Описание',
    issue_comments: 'Комментариев нет.',
    issue_url: 'https://j.example/FD-1234',
    project_dir: '/path/to/frontend',
    run_dir: '/path/to/run',
  };

  const withBe = renderTemplate('actions/analyze', {
    ...baseVars,
    backend_dir: '/path/to/backend',
    backend_repo: 'org/backend',
  });
  assert.match(withBe.text, /Бэкенд этого проекта: \/path\/to\/backend/);
  assert.match(withBe.text, /backend_refs\.json/);

  const withoutBe = renderTemplate('actions/analyze', {
    ...baseVars,
    backend_dir: '',
    backend_repo: '',
  });
  assert.doesNotMatch(withoutBe.text, /Бэкенд этого проекта/);
  assert.doesNotMatch(withoutBe.text, /backend_refs\.json/);
});

