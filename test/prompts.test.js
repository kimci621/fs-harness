import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { commitPrompt, findPatternFile } from '../src/prompts.js';

function makeRepo(files = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'gl-helper-test-'));
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
    assert.match(prompt, /git add -A && git commit -m/);
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
    assert.match(prompt, /git add -A && git commit -m/); // футер с инструкцией всегда добавляется
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
