import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { cmdMRS } from './commands/mrs.js';
import { judge } from './judge/index.js';
import { statusIcon } from './format.js';
import { envNames } from './secrets.js';

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
  // sha нужен ключу идемпотентности очереди: одно и то же событие на одном и том же коммите — одно задание.
  const push = (mr, kind, detail) => events.push({ id: `e${events.length + 1}`, source: 'gitlab', kind, mr: mr.iid, sha: mr.sha ?? null, title: mr.title, url: mr.web_url, detail, age: mr.updated_at });

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

// Демон работает и ночью, а на залоченном экране `security` ключей не отдаёт: секреты обязаны
// читаться из env, иначе он будет молча падать до утра. Возвращает то, чего в env не хватает.
export function daemonSecretIssues(cfg = {}, env = process.env) {
  const needed = [];
  const tg = cfg.telegram ?? {};
  // Токен в конфиге keychain не трогает — тогда и требовать его из env незачем.
  if ((tg.chat_id || env.TELEGRAM_CHAT_ID) && !tg.bot_token) {
    needed.push({ name: 'telegram', why: tg.approvals ? 'бот и уведомления' : 'уведомления watcher' });
  }
  for (const profile of cfg.judge?.roles?.['event-triage'] ?? []) {
    const p = cfg.judge?.profiles?.[profile];
    if (p?.secret) needed.push({ name: p.secret, why: `триаж событий (профиль ${profile})` });
  }
  return needed
    .filter(({ name }) => !envNames(name).some((n) => env[n]))
    .map((n) => ({ ...n, envName: envNames(n.name)[0] }));
}

// Профили судьи, которые ходят за токеном в keychain сами (claude по OAuth). Запретить их
// нельзя — под подпиской другого пути нет, но знать про это надо: на залоченном экране
// триаж отвалится, и события уйдут в канал без разбора.
export function daemonKeychainJudges(cfg = {}) {
  return (cfg.judge?.roles?.['event-triage'] ?? []).filter((name) => {
    const p = cfg.judge?.profiles?.[name];
    return p?.provider === 'cli' && !p.secret;
  });
}
