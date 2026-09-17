import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { CliError } from '../errors.js';

export const RUNS_DIR = path.join(homedir(), '.local', 'state', 'fs-harness', 'runs');
export const MAX_ARCHIVES = 50;

// Удаляет старые архивы ранов сверх лимита keep (все архивы максимум 50 шт).
export function pruneRuns({ root = RUNS_DIR, keep = MAX_ARCHIVES } = {}) {
  if (!existsSync(root)) return [];
  const entries = readdirSync(root)
    .map((id) => {
      const dir = path.join(root, id);
      try {
        const stat = statSync(dir);
        if (!stat.isDirectory()) return null;
        let createdAt = stat.birthtimeMs;
        try {
          const meta = JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8'));
          if (meta.created_at) createdAt = new Date(meta.created_at).getTime();
        } catch {}
        return { id, dir, createdAt };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.createdAt - a.createdAt);

  const excess = entries.slice(keep);
  const deleted = [];
  for (const item of excess) {
    try {
      rmSync(item.dir, { recursive: true, force: true });
      deleted.push(item.id);
    } catch {}
  }
  return deleted;
}

// Каталог рана. meta.json не для красоты: без него --judge-only не на чем работать.
export function createRun(action, { root = RUNS_DIR, keep = MAX_ARCHIVES } = {}) {
  root = root || RUNS_DIR; // явный undefined из опций не должен обнулять дефолт
  pruneRuns({ root, keep: keep - 1 });
  const id = `${action}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const dir = path.join(root, id);
  mkdirSync(dir, { recursive: true });
  return { id, dir };
}

export function saveArtifact(run, name, content) {
  const body = typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n';
  writeFileSync(path.join(run.dir, name), body);
}

// Поток событий на диск: по строке JSON на событие. На этом держатся и вкладка
// «Раны» после перезапуска, и будущий replay — дельты судьи в файл не пишем, их
// сотни в секунду и они уже склеены в verdict.json.
export function appendEvent(run, event) {
  if (!run?.dir || event?.t === 'delta') return;
  appendFileSync(path.join(run.dir, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
}

export function readEvents(run) {
  const file = path.join(run.dir, 'events.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null; // оборванная строка недописанного рана — не повод падать
      }
    })
    .filter(Boolean);
}

// Список ранов, свежие первыми. Для вкладки «Раны»: читается meta.json, не весь ран.
export function listRuns({ root = RUNS_DIR, limit = MAX_ARCHIVES } = {}) {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((id) => {
      const dir = path.join(root, id);
      try {
        const meta = JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8'));
        const result = existsSync(path.join(dir, 'result.json')) ? JSON.parse(readFileSync(path.join(dir, 'result.json'), 'utf8')) : null;
        const verdict = existsSync(path.join(dir, 'verdict.json')) ? JSON.parse(readFileSync(path.join(dir, 'verdict.json'), 'utf8')) : null;
        return {
          id,
          dir,
          action: meta.action,
          mr: meta.mr ?? null,
          issue: meta.issue ?? null,
          created_at: meta.created_at ?? statSync(dir).birthtime.toISOString(),
          state: result ? 'done' : 'прерван',
          decision: verdict?.decision ?? null,
          cost: verdict?.meta?.cost ?? 0,
        };
      } catch {
        return null; // каталог без meta.json — ещё не ран
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, limit);
}

export function readRun(id, { root = RUNS_DIR } = {}) {
  const dir = path.join(root, id);
  if (!existsSync(path.join(dir, 'meta.json'))) {
    throw new CliError(`Ран "${id}" не найден: нет ${path.join(dir, 'meta.json')}.`, 1, 'run_not_found');
  }
  const read = (name) => {
    const p = path.join(dir, name);
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  };
  return { id, dir, meta: JSON.parse(read('meta.json')), read };
}
