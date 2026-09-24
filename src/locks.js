import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const LOCKS_ROOT = path.join(homedir(), '.local', 'state', 'fs-harness', 'locks');
export const DEFAULT_STALE_MS = 30 * 60 * 1000; // 30 минут

// Ключ лока: <repo>:<branch> или <repo>:mr<iid>
export function lockKey(target) {
  let raw;
  if (typeof target === 'string') {
    raw = target;
  } else {
    const repo = target?.repo || '';
    if (target?.mr) raw = `${repo}:mr${target.mr}`;
    else if (target?.branch) raw = `${repo}:${target.branch}`;
    else if (target?.task) raw = `${repo}:${target.task}`;
    else raw = repo || 'unknown';
  }
  return raw.replace(/[^\w.-]/g, '_');
}

export const lockFile = (key, root = LOCKS_ROOT) => path.join(root, `${lockKey(key)}.lock`);

export function isPidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// Захват файлового лока атомарно через openSync('wx')
export function acquireLock({
  root = LOCKS_ROOT,
  key,
  pid = process.pid,
  now = Date.now(),
  staleMs = DEFAULT_STALE_MS,
} = {}) {
  const normKey = lockKey(key);
  mkdirSync(root, { recursive: true });
  const file = lockFile(normKey, root);

  function tryWriteExclusive() {
    try {
      const record = { pid, at: new Date(now).toISOString() };
      writeFileSync(file, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
      return { success: true };
    } catch (err) {
      if (err.code === 'EEXIST') return { success: false, code: 'EEXIST' };
      throw err;
    }
  }

  function readHolder() {
    try {
      const stat = statSync(file);
      const content = readFileSync(file, 'utf8');
      const data = JSON.parse(content);
      return { ...data, mtimeMs: stat.mtimeMs };
    } catch {
      return null;
    }
  }

  // Попытка 1
  const first = tryWriteExclusive();
  if (first.success) {
    return {
      acquired: true,
      key: normKey,
      file,
      release: () => releaseLock({ root, key: normKey, pid }),
    };
  }

  // Файл существует: проверяем держателя
  const holder = readHolder();
  const isStale = !holder || (now - (holder.mtimeMs || new Date(holder.at || 0).getTime()) >= staleMs);
  const alive = holder ? isPidAlive(holder.pid) : false;

  if (!isStale && alive) {
    return { acquired: false, key: normKey, holder };
  }

  // Протух или pid мёртв — удаляем и пробуем повторно
  try {
    rmSync(file, { force: true });
  } catch {}

  // Попытка 2
  const second = tryWriteExclusive();
  if (second.success) {
    return {
      acquired: true,
      key: normKey,
      file,
      release: () => releaseLock({ root, key: normKey, pid }),
    };
  }

  const latestHolder = readHolder();
  return { acquired: false, key: normKey, holder: latestHolder };
}

// Освобождение лока: удаляет файл, только если там указан переданный pid
export function releaseLock({ root = LOCKS_ROOT, key, pid = process.pid } = {}) {
  const normKey = lockKey(key);
  const file = lockFile(normKey, root);
  try {
    if (!existsSync(file)) return false;
    const content = JSON.parse(readFileSync(file, 'utf8'));
    if (content.pid === pid) {
      rmSync(file, { force: true });
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// Диагностический список активных и протухших локов
export function listLocks({ root = LOCKS_ROOT, now = Date.now(), staleMs = DEFAULT_STALE_MS } = {}) {
  if (!existsSync(root)) return [];
  const files = readdirSync(root).filter((f) => f.endsWith('.lock'));
  const locks = [];
  for (const f of files) {
    const file = path.join(root, f);
    const key = f.slice(0, -5);
    try {
      const stat = statSync(file);
      const data = JSON.parse(readFileSync(file, 'utf8'));
      const alive = isPidAlive(data.pid);
      const mtimeMs = stat.mtimeMs;
      const stale = (now - mtimeMs >= staleMs) || !alive;
      locks.push({
        key,
        file,
        pid: data.pid,
        at: data.at,
        alive,
        stale,
      });
    } catch {}
  }
  return locks;
}
