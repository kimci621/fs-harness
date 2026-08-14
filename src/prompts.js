import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Промпт для команды commit. Если в корне git-репозитория лежит .llm-commit-pattern,
// его содержимое заменяет встроенный промпт (свои правила на других проектах).

const DEFAULT_PROMPT = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'prompts', 'commit.md'),
  'utf8',
).trim();

const FOOTER = [
  '',
  'Задача: сформируй сообщение коммита по паттерну выше, изучив изменения (git status, git diff, git diff --cached),',
  'и закоммить все изменения: git add -A && git commit -m "<сообщение>". Не пушь.',
  'В конце ответа покажи итоговое сообщение коммита и его хэш.',
].join('\n');

// Ищет .llm-commit-pattern: от startDir вверх до корня git-репозитория (где лежит .git).
export function findPatternFile(startDir) {
  let dir = path.resolve(startDir);
  for (;;) {
    if (existsSync(path.join(dir, '.git'))) {
      const candidate = path.join(dir, '.llm-commit-pattern');
      return existsSync(candidate) ? candidate : null;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Возвращает {source, prompt}: source — откуда взят промпт (путь файла или 'builtin').
export function commitPrompt(startDir) {
  const file = findPatternFile(startDir);
  if (file) {
    const body = readFileSync(file, 'utf8').trim();
    return { source: file, prompt: `${body}\n\n${FOOTER}` };
  }
  return { source: 'builtin', prompt: DEFAULT_PROMPT };
}
