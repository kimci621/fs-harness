import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Mustache from 'mustache';
import matter from 'gray-matter';
import { CliError } from './errors.js';

// В промптах живут код, markdown и дифф — HTML-экранирование их испортит.
Mustache.escape = (t) => t;

const BUILTIN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'prompts');
const USER_DIR = path.join(homedir(), '.config', 'fs-harness', 'prompts');

// Порядок переопределения, первое попадание: проектный → личный → встроенный.
export function templatePaths(name, { projectDir } = {}) {
  const rel = `${name}.md`;
  return [
    projectDir ? path.join(projectDir, '.fs-harness', 'prompts', rel) : null,
    path.join(USER_DIR, rel),
    path.join(BUILTIN_DIR, rel),
  ].filter(Boolean);
}

// Личный оверрайд: копия шаблона в ~/.config/fs-harness/prompts. Проектный каталог
// намеренно не трогаем — он лежит в чужом репозитории, туда пишет только человек.
export function userOverride(name, { projectDir } = {}) {
  const dest = path.join(USER_DIR, `${name}.md`);
  if (existsSync(dest)) return { path: dest, created: false };
  const tpl = loadTemplate(name, { projectDir });
  mkdirSync(path.dirname(dest), { recursive: true });
  copyFileSync(tpl.path, dest); // целиком, вместе с front-matter — иначе оверрайд потеряет vars
  return { path: dest, created: true };
}

export function dropUserOverride(name) {
  const dest = path.join(USER_DIR, `${name}.md`);
  if (!existsSync(dest)) return { path: dest, removed: false };
  rmSync(dest);
  return { path: dest, removed: true };
}

export function loadTemplate(name, { projectDir } = {}) {
  const tried = templatePaths(name, { projectDir });
  for (const p of tried) {
    if (!existsSync(p)) continue;
    const { data, content } = matter(readFileSync(p, 'utf8'));
    return { source: p.startsWith(BUILTIN_DIR) ? 'builtin' : p, path: p, meta: data ?? {}, body: content.trim() };
  }
  throw new CliError(`Нет шаблона промпта "${name}". Искал:\n  ${tried.join('\n  ')}`, 1, 'prompt_missing');
}

// Строгость — наш слой: mustache молча рендерит пропущенную переменную в пустоту,
// а промпт без переменной это испорченное задание агенту, а не мелочь.
export function renderTemplate(name, vars = {}, { projectDir, strict = true } = {}) {
  const tpl = loadTemplate(name, { projectDir });
  const declared = Array.isArray(tpl.meta.vars) ? tpl.meta.vars : [];
  const missing = declared.filter((v) => vars[v] === undefined);
  if (strict && missing.length) {
    throw new CliError(`Шаблон "${name}" (${tpl.source}) ждёт переменные, которых нет: ${missing.join(', ')}.`, 1, 'prompt_var_missing');
  }
  const used = [...new Set(tags(Mustache.parse(tpl.body)))];
  return {
    source: tpl.source,
    text: Mustache.render(tpl.body, vars).trim(),
    declared,
    used,
    missing,
    unused: declared.filter((v) => !used.includes(v)),
    undeclared: declared.length ? used.filter((v) => !declared.includes(v)) : [],
  };
}

export function listTemplates({ projectDir } = {}) {
  const names = new Set();
  for (const dir of [BUILTIN_DIR, USER_DIR, projectDir ? path.join(projectDir, '.fs-harness', 'prompts') : null]) {
    if (dir) collect(dir, '', names);
  }
  return [...names].sort().map((name) => {
    const { source, meta } = loadTemplate(name, { projectDir });
    return { name, source, overridden: source !== 'builtin', vars: Array.isArray(meta.vars) ? meta.vars : [] };
  });
}

// Имя шаблона включает подкаталог: actions/conflict, judge/acceptance.
function collect(dir, prefix, out) {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) collect(path.join(dir, e.name), `${prefix}${e.name}/`, out);
    else if (e.name.endsWith('.md')) out.add(`${prefix}${e.name.slice(0, -3)}`);
  }
}

// Секции вложенные, поэтому рекурсия: подтокены лежат в t[4].
function tags(tokens) {
  const out = [];
  for (const t of tokens) {
    if (['name', '&', '#', '^'].includes(t[0])) out.push(t[1]);
    if (Array.isArray(t[4])) out.push(...tags(t[4]));
  }
  return out;
}

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

// Возвращает {source, prompt}: source — откуда взят паттерн (путь файла или 'builtin').
// .llm-commit-pattern подменяет только паттерн сообщения, инструкция остаётся общей.
export function commitPrompt(startDir) {
  const file = findPatternFile(startDir);
  const pattern = file ? readFileSync(file, 'utf8').trim() : '';
  const { source, text } = renderTemplate('commit', { pattern }, { projectDir: startDir });
  return { source: file ?? source, prompt: text };
}

// Статическая проверка всех шаблонов: front-matter против тела. Гоняется в npm test,
// чтобы правка промпта (в том числе проектным оверрайдом) не уехала молча.
export function checkTemplates({ projectDir } = {}) {
  const problems = [];
  for (const { name } of listTemplates({ projectDir })) {
    let tpl;
    try {
      tpl = loadTemplate(name, { projectDir });
    } catch (err) {
      problems.push({ name, source: '?', level: 'error', message: err.message });
      continue;
    }
    let used;
    try {
      used = [...new Set(tags(Mustache.parse(tpl.body)))];
    } catch (err) {
      problems.push({ name, source: tpl.source, level: 'error', message: `не парсится как mustache: ${err.message}` });
      continue;
    }
    const declared = Array.isArray(tpl.meta.vars) ? tpl.meta.vars : null;
    if (!declared) {
      if (used.length) problems.push({ name, source: tpl.source, level: 'error', message: `использует ${used.map((v) => `{{${v}}}`).join(', ')}, но не объявляет vars во front-matter` });
      continue;
    }
    for (const v of used.filter((v) => !declared.includes(v))) {
      problems.push({ name, source: tpl.source, level: 'error', message: `использует {{${v}}}, не объявленную в vars` });
    }
    for (const v of declared.filter((v) => !used.includes(v))) {
      problems.push({ name, source: tpl.source, level: 'warn', message: `объявляет ${v} в vars, но нигде её не использует` });
    }
  }
  return problems;
}
