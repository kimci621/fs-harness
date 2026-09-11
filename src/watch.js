import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { cmdMRS } from './commands/mrs.js';
import { judge } from './judge/index.js';
import { statusIcon } from './format.js';

const STATE_ROOT = path.join(homedir(), '.local', 'state', 'fs-harness', 'watch');

export const stateFile = (repo, root = STATE_ROOT) => path.join(root, `${repo.replace(/\//g, '%2F')}.json`);

// Снимок — ровно то, что показывает fsh mrs: второго источника правды не заводим.
export async function snapshot(g, repo) {
  const { mrs } = await cmdMRS(g, repo, { asObject: true });
  return { at: new Date().toISOString(), repo, mrs };
}

export function readSnapshot(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null; // битый снимок равен отсутствию: следующий опрос перезапишет
  }
}

export function writeSnapshot(file, snap) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(snap, null, 2));
}

// Что изменилось против прошлого снимка. Первого снимка нет — событий нет:
// иначе первый же опрос вывалил бы в канал весь список открытых MR.
export function diffSnapshots(prev, next) {
  if (!prev) return [];
  const was = new Map(prev.mrs.map((m) => [m.iid, m]));
  const events = [];
  const push = (mr, kind, detail) => events.push({ id: `e${events.length + 1}`, source: 'gitlab', kind, mr: mr.iid, title: mr.title, url: mr.web_url, detail, age: mr.updated_at });

  for (const mr of next.mrs) {
    const old = was.get(mr.iid);
    if (!old) {
      push(mr, 'mr_new', `новый MR ${mr.source_branch} → ${mr.target_branch}`);
      continue;
    }
    const from = old.pipeline?.status ?? 'нет';
    const to = mr.pipeline?.status ?? 'нет';
    if (from !== to) push(mr, 'pipeline', `пайплайн ${from} → ${to} ${statusIcon(to)}`);
    const openNow = mr.comments?.open ?? 0;
    const openWas = old.comments?.open ?? 0;
    if (openNow > openWas) push(mr, 'threads', `новых открытых тредов: ${openNow - openWas} (было ${openWas}, стало ${openNow})`);
    if (mr.has_conflicts && !old.has_conflicts) push(mr, 'conflict', 'появился конфликт с целевой веткой');
  }
  for (const old of prev.mrs) {
    if (!next.mrs.some((m) => m.iid === old.iid)) push(old, 'mr_gone', 'MR закрыт или смержен');
  }
  return events;
}

// Батч судье: одна строка на событие, id — чтобы вердикт можно было разложить обратно.
export function triagePayload(events, repo) {
  return [
    `Репозиторий: ${repo}`,
    '',
    'События с прошлого опроса:',
    ...events.map((e) => `- ${e.id} · ${e.kind} · MR !${e.mr} «${e.title}» · ${e.detail} · обновлён ${e.age} · ${e.url}`),
  ].join('\n');
}

export const TRIAGE_LEVEL = { blocker: 'срочно', warning: 'к сведению', nit: 'шум' };

// Вердикт → что оставить. Судья кладёт id события в findings[].file; шум и всё,
// что он не упомянул, до канала не доходит.
export function keepEvents(events, verdict) {
  if (!verdict) return events.map((e) => ({ ...e, level: 'срочно', why: 'триаж не сработал' }));
  const byId = new Map((verdict.findings ?? []).map((f) => [f.file, f]));
  return events
    .map((e) => ({ ...e, finding: byId.get(e.id) }))
    .filter((e) => e.finding && e.finding.severity !== 'nit')
    .map((e) => ({ ...e, level: TRIAGE_LEVEL[e.finding.severity], why: e.finding.body }));
}

export function formatEvents(kept, { verdict } = {}) {
  if (!kept.length) return 'Ничего важного.';
  const lines = kept.map((e) => `- ${e.level}: MR !${e.mr} «${e.title}» — ${e.detail}${e.why ? ` (${e.why})` : ''}\n  ${e.url}`);
  return [verdict?.summary ? `${verdict.summary}` : '', ...lines].filter(Boolean).join('\n');
}

// Один опрос: снимок → дифф → триаж. Уведомляет вызывающий, запускать действия watcher не умеет.
export async function pollOnce({ g, repo, cfg, file = stateFile(repo), makeProvider, signal } = {}) {
  const prev = readSnapshot(file);
  const next = await snapshot(g, repo);
  const events = diffSnapshots(prev, next);
  writeSnapshot(file, next);

  let verdict = null;
  let triageError = null;
  if (events.length) {
    try {
      verdict = await judge({ role: 'event-triage', payload: triagePayload(events, repo), cfg, makeProvider, signal });
    } catch (err) {
      triageError = err.message; // без триажа шлём всё: терять сигнал хуже, чем шуметь
    }
  }
  return { first: !prev, events, kept: keepEvents(events, verdict), verdict, triageError, snapshot: next };
}
