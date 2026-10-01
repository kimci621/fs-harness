import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { cmdMRS } from './commands/mrs.js';
import { openThreads, awaitingReply } from './actions/threads.js';
import { mapLimit } from './pipeline.js';
import { envNames } from './secrets.js';

const STATE_ROOT = path.join(homedir(), '.local', 'state', 'fs-harness', 'watch');
// Снимок старого формата (до трёх событий) сравнивать не с чем: считаем его отсутствующим.
export const SNAPSHOT_VERSION = 2;
export const DEFAULT_BEHIND_THRESHOLD = 10;

export const stateFile = (repo, root = STATE_ROOT) => path.join(root, `${repo.replace(/\//g, '%2F')}.json`);

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

const firstLine = (s) => String(s ?? '').split('\n').find((l) => l.trim())?.trim() ?? '';

// Снимок моих открытых MR без черновиков: треды, ждущие моего ответа, файлы конфликта, отставание.
// probe(mr) → {files, behind} считает git локально; нет probe — эти поля null.
export async function snapshot(ctx, { probe = null, prev = null } = {}) {
  const { mrs } = await cmdMRS(ctx.g, ctx.repo, { asObject: true, author: 'me' });
  const me = (await ctx.g.me())?.username;
  const mine = mrs.filter((m) => !m.draft);
  const rows = await mapLimit(mine, 4, async (mr) => {
    const threads = awaitingReply(openThreads(await ctx.g.getDiscussions(ctx.repo, mr.iid)), me).map((t) => {
      const last = t.notes.at(-1) ?? {};
      return { id: t.id, last: last.created_at ?? null, author: last.author ?? '?', text: firstLine(last.body) };
    });
    const git = probe ? probe(mr) : {};
    return {
      iid: mr.iid, title: mr.title, url: mr.web_url, branch: mr.source_branch, target: mr.target_branch,
      threads, files: git.files ?? null, behind: git.behind ?? null,
    };
  });
  // Не посчитался MR — держим прошлое состояние, иначе следующий опрос выдал бы его старое за новое.
  const was = new Map((prev?.v === SNAPSHOT_VERSION ? prev.mrs : []).map((m) => [m.iid, m]));
  const errors = [];
  const out = rows.flatMap((r, i) => {
    if (!r.error) return [r];
    errors.push({ iid: mine[i].iid, error: r.error.message ?? String(r.error) });
    return was.has(mine[i].iid) ? [was.get(mine[i].iid)] : [];
  });
  return { v: SNAPSHOT_VERSION, at: new Date().toISOString(), repo: ctx.repo, mrs: out, errors };
}

// Три события на MR: новые треды ждут меня, появился конфликт, отставание перешло порог.
// Первого снимка нет — событий нет: иначе первый опрос вывалил бы в канал всё разом.
export function diffSnapshots(prev, next, { behindThreshold = DEFAULT_BEHIND_THRESHOLD } = {}) {
  if (prev?.v !== SNAPSHOT_VERSION) return [];
  const was = new Map(prev.mrs.map((m) => [m.iid, m]));
  const events = [];
  for (const mr of next.mrs) {
    const old = was.get(mr.iid);
    // Новый тред или новая реплика в старом: последняя заметка сменилась.
    const seen = new Map((old?.threads ?? []).map((t) => [t.id, t.last]));
    const threads = mr.threads.filter((t) => !seen.has(t.id) || seen.get(t.id) !== t.last);
    const conflict = mr.files?.length && !old?.files?.length ? mr.files : null;
    const behind = mr.behind >= behindThreshold && !(old?.behind >= behindThreshold) ? mr.behind : null;
    if (threads.length || conflict || behind != null) {
      const { iid, title, url, branch, target } = mr;
      events.push({ iid, title, url, branch, target, threads, conflict, behind });
    }
  }
  return events;
}

// Один опрос: снимок → дифф. Уведомляет вызывающий, ничего не запускает.
export async function pollOnce({ ctx, probe = null, file = stateFile(ctx.repo), behindThreshold } = {}) {
  const prev = readSnapshot(file);
  const next = await snapshot(ctx, { probe, prev });
  const events = diffSnapshots(prev, next, { behindThreshold });
  const { errors, ...toSave } = next;
  writeSnapshot(file, toSave);
  return { first: prev?.v !== SNAPSHOT_VERSION, events, errors, snapshot: toSave };
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
  return needed
    .filter(({ name }) => !envNames(name).some((n) => env[n]))
    .map((n) => ({ ...n, envName: envNames(n.name)[0] }));
}
