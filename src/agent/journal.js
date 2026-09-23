import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { CliError } from '../errors.js';

export const RUNS_DIR = path.join(homedir(), '.local', 'state', 'fs-harness', 'runs');
export const MAX_ARCHIVES = 50;

// Удаляет старые архивы ранов сверх лимита keep (все архивы максимум 50 шт).
// pending_approval не трогаем: ран ждёт кнопку, ретеншн его съесть не должен.
export function pruneRuns({ root = RUNS_DIR, keep = MAX_ARCHIVES } = {}) {
  if (!existsSync(root)) return [];
  const entries = readdirSync(root)
    .map((id) => {
      const dir = path.join(root, id);
      try {
        const stat = statSync(dir);
        if (!stat.isDirectory()) return null;
        let createdAt = stat.birthtimeMs;
        let state = null;
        try {
          const meta = JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8'));
          if (meta.created_at) createdAt = new Date(meta.created_at).getTime();
          state = meta.state ?? null;
        } catch {}
        return { id, dir, createdAt, state };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.createdAt - a.createdAt);

  const excess = entries.filter((e) => e.state !== 'pending_approval').slice(keep);
  const deleted = [];
  for (const item of excess) {
    try {
      rmSync(item.dir, { recursive: true, force: true });
      deleted.push(item.id);
    } catch {}
  }
  return deleted;
}

const APPROVAL_TTL_MS = 24 * 3600 * 1000;

// Просроченный аппрув гасим сами: сутки без кнопки — state expired, worktree убирает onExpired.
export function sweepExpiredApprovals({ root = RUNS_DIR, now = Date.now(), ttlMs = APPROVAL_TTL_MS, onExpired } = {}) {
  if (!existsSync(root)) return [];
  const expired = [];
  for (const id of readdirSync(root)) {
    const dir = path.join(root, id);
    let meta;
    try {
      meta = JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    } catch {
      continue;
    }
    if (meta.state !== 'pending_approval') continue;
    const issued = new Date(meta.approval?.issued_at ?? 0).getTime();
    if (!Number.isFinite(issued) || now - issued < ttlMs) continue;
    const run = { id, dir };
    patchRunMeta(run, { state: 'expired' });
    try { onExpired?.(run); } catch { /* уборка не должна ронять обход */ }
    expired.push(id);
  }
  return expired;
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

// Дописать поля в meta.json, не переписывая ран целиком. На этом держится состояние
// рана (running/failed/done) и хвост resume/retry: без него упавший ран неотличим от живого.
export function patchRunMeta(run, patch) {
  const dir = run?.dir ?? (run?.id ? path.join(run.root ?? RUNS_DIR, run.id) : null);
  if (!dir) return;
  const file = path.join(dir, 'meta.json');
  let meta = {};
  try {
    meta = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    // нет или битый meta — пишем только патч, ран всё равно нечитаем
  }
  writeFileSync(file, JSON.stringify({ ...meta, ...patch }, null, 2) + '\n');
}

export function setRunState(run, state) {
  patchRunMeta(run, { state });
}

// Живой ли процесс рана. pid может переиспользоваться, поэтому вместе с ним смотрим
// свежесть events.jsonl: молчащий ран без новых событий считаем завершённым.
// ponytail: окно 5 минут; если понадобится точнее — сверять start time процесса.
export function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function runIsActive(meta, dir, { now = Date.now(), staleMs = 300_000 } = {}) {
  if (!meta?.pid || !pidAlive(meta.pid)) return false;
  try {
    return now - statSync(path.join(dir, 'events.jsonl')).mtimeMs < staleMs;
  } catch {
    return false;
  }
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
          // Явное состояние из meta, а не догадка по файлам: нужно, чтобы отличить
          // живой ран от упавшего и показать код ошибки.
          state: meta.state ?? (result ? 'done' : 'прерван'),
          decision: verdict?.decision ?? null,
          cost: verdict?.meta?.cost ?? 0,
          error_code: meta.error?.code ?? null,
          error_message: meta.error?.message ?? null,
          worktree: meta.worktree ?? null,
          pid: meta.pid ?? null,
          resumable: Boolean(meta.session_id || meta.pre),
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
