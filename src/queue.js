import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

// Очередь заданий: что watcher увидел и что с этим надо сделать. Здесь она только копится —
// воркеров нет (PLAN, фаза 15). Формат и ключ идемпотентности задаются тут, чтобы воркер
// не изобретал их заново.
export const QUEUE_ROOT = path.join(homedir(), '.local', 'state', 'fs-harness', 'queue');
export const DEFAULT_TTL_SECONDS = 86400; // сутки: столько живёт дедуп одного и того же события

// Вид события → действие, которое его закрывает. pipeline ждёт ci-fix (фаза 12),
// поэтому у него пока null: задание в очереди есть, исполнителя нет.
export const ACTION_BY_KIND = { conflict: 'conflict', threads: 'threads' };

// Ключ идемпотентности: источник + вид + объект + sha. Тот же упавший пайплайн на том же
// sha ставится в очередь ровно один раз, сколько бы опросов его ни увидело.
export function queueKey({ source = 'gitlab', kind, mr, task, sha } = {}) {
  return [source, kind, task || (mr ? `mr${mr}` : 'none'), sha || 'nosha'].join(':');
}

export const jobFile = (key, root = QUEUE_ROOT) => path.join(root, `${key.replace(/[^\w.-]/g, '_')}.json`);

export function jobFromEvent(e, { project = '', repo = '' } = {}) {
  return {
    source: e.source ?? 'gitlab',
    kind: e.kind,
    project,
    repo,
    mr: e.mr ?? null,
    sha: e.sha ?? null,
    action: ACTION_BY_KIND[e.kind] ?? null,
    title: e.title ?? '',
    url: e.url ?? '',
    detail: e.detail ?? '',
    level: e.level ?? null,
  };
}

function readJob(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null; // битое задание равно отсутствию: перезапишется следующим событием
  }
}

// Ставит задание, если такого живого ещё нет. added:false — это дубль, а не ошибка.
export function enqueue(job, { root = QUEUE_ROOT, now = Date.now(), ttlSeconds = DEFAULT_TTL_SECONDS } = {}) {
  const key = job.key || queueKey(job);
  const file = jobFile(key, root);
  const existing = readJob(file);
  if (existing && new Date(existing.expires_at).getTime() > now) return { added: false, key, job: existing };

  const record = {
    ...job,
    key,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + ttlSeconds * 1000).toISOString(),
  };
  mkdirSync(root, { recursive: true });
  writeFileSync(file, JSON.stringify(record, null, 2));
  return { added: true, key, job: record };
}

// Живые задания, новые сверху. Протухшие не показываются, даже если файл ещё лежит.
export function listJobs({ root = QUEUE_ROOT, now = Date.now() } = {}) {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJob(path.join(root, f)))
    .filter((j) => j && new Date(j.expires_at).getTime() > now)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

// Уборка протухших файлов. Зовётся из тех же мест, где очередь и так читается.
export function pruneQueue({ root = QUEUE_ROOT, now = Date.now() } = {}) {
  if (!existsSync(root)) return [];
  const gone = [];
  for (const f of readdirSync(root).filter((n) => n.endsWith('.json'))) {
    const file = path.join(root, f);
    const job = readJob(file);
    if (job && new Date(job.expires_at).getTime() > now) continue;
    try {
      rmSync(file, { force: true });
      gone.push(job?.key ?? f);
    } catch {}
  }
  return gone;
}

export function clearQueue({ root = QUEUE_ROOT } = {}) {
  const keys = listJobs({ root }).map((j) => j.key);
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  return keys;
}

// Удаление задания из очереди по завершении
export function removeJob(first, second) {
  let r = QUEUE_ROOT;
  let k = first;
  if (typeof second === 'string') {
    r = first;
    k = second;
  } else if (second?.root) {
    r = second.root;
  }
  const file = jobFile(k, r);
  try {
    if (existsSync(file)) {
      rmSync(file, { force: true });
      return true;
    }
  } catch {}
  return false;
}

// Обновление полей задания (например, attempts при ошибке)
export function updateJob(first, second, third) {
  let r = QUEUE_ROOT;
  let k = first;
  let patch = second;
  if (typeof first === 'string' && typeof second === 'string' && typeof third === 'object') {
    r = first;
    k = second;
    patch = third;
  } else if (third?.root) {
    r = third.root;
  }
  const file = jobFile(k, r);
  const existing = readJob(file);
  if (!existing) return null;
  const updated = { ...existing, ...patch };
  writeFileSync(file, JSON.stringify(updated, null, 2) + '\n');
  return updated;
}
