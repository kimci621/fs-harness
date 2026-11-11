// fsh wait — список «жду ответа» на один день: тред Mattermost или комментарии задачи Jira.
// Проверяет его демон watch: ответ пришёл — сообщение в Telegram и пункт снят; день сменился — снят молча.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { CliError } from './errors.js';
import { postIdFrom } from './commands/mm.js';
import { getTelegramTarget } from './notify.js';
import { sendMessage } from './tgbot.js';

export const WAITS_FILE = path.join(homedir(), '.local', 'state', 'fs-harness', 'waits.json');
const JIRA_KEY = /^[A-Z][A-Z0-9]+-\d+$/;

export const today = (ms = Date.now()) => new Date(ms).toLocaleDateString('sv');

export function readWaits(file = WAITS_FILE) {
  if (!existsSync(file)) return [];
  try {
    const list = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function writeWaits(list, file = WAITS_FILE) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(list, null, 2)}\n`);
}

export function makeWait(kind, ref, { project = '', from = null, note = '', now = Date.now() } = {}) {
  const usage = 'fsh wait add mm <permalink> | jira <KEY> [--from ник] [--note текст]';
  let target;
  if (kind === 'mm') target = postIdFrom(ref, usage);
  else if (kind === 'jira') target = String(ref ?? '').trim().toUpperCase();
  if (!target || (kind === 'jira' && !JIRA_KEY.test(target))) throw new CliError(`Использование: ${usage}.`, 1, 'usage');
  return { id: randomBytes(3).toString('hex'), kind, target, url: String(ref), project, from, note, day: today(now), since: now };
}

// Ответ — сообщение после since не от меня; с --from только от этого человека.
const matchesFrom = (from, ...names) => !from || names.some((n) => n && n.toLowerCase().includes(from.toLowerCase()));

export async function findReply(w, { mm, jira }) {
  if (w.kind === 'mm') {
    const me = await mm.me();
    const { posts = {} } = await mm.thread(w.target);
    const fresh = Object.values(posts).filter((p) => p.create_at > w.since && p.user_id !== me.id).sort((a, b) => a.create_at - b.create_at);
    if (!fresh.length) return null;
    const users = Object.fromEntries((await mm.usersByIds([...new Set(fresh.map((p) => p.user_id))])).map((u) => [u.id, u.username]));
    const hit = fresh.find((p) => matchesFrom(w.from, users[p.user_id]));
    return hit ? { author: users[hit.user_id] ?? hit.user_id, text: hit.message ?? '' } : null;
  }
  // ponytail: comments() отдаёт первые 50 — в задаче с длинной историей свежий ответ не увидим; тогда orderBy=-created.
  const me = await jira.myself();
  const { comments = [] } = await jira.comments(w.target);
  const hit = comments.find((c) => Date.parse(c.created) > w.since && c.author?.accountId !== me.accountId
    && matchesFrom(w.from, c.author?.displayName, c.author?.emailAddress));
  return hit ? { author: hit.author?.displayName ?? '?', text: typeof hit.body === 'string' ? hit.body : '' } : null;
}

// Один проход: просроченные снимаются, отвеченные уходят в notify и тоже снимаются, сбой оставляет пункт.
export async function checkWaits(list, { clientsFor, notify, now = Date.now(), log = () => {} }) {
  const keep = [];
  const done = [];
  for (const w of list) {
    if (w.day !== today(now)) { log(`wait ${w.id}: день прошёл, снят`); continue; }
    try {
      const reply = await findReply(w, clientsFor(w));
      if (!reply) { keep.push(w); continue; }
      await notify(w, reply);
      done.push({ ...w, reply });
    } catch (err) {
      log(`wait ${w.id}: проверка упала — ${err.message}`);
      keep.push(w);
    }
  }
  return { keep, done };
}

export function replyText(w, reply) {
  const where = w.kind === 'jira' ? w.target : 'тред Mattermost';
  const text = reply.text.replace(/\s+/g, ' ').slice(0, 300);
  return `Ответ в ${where} от ${reply.author}${w.note ? ` (${w.note})` : ''}:\n${text}\n${w.url}`;
}

// Шаг демона: файл пуст — ни сети, ни записи.
export async function runWaits({ loadCfg, env, makeCtx, file = WAITS_FILE, now = Date.now(), log = () => {}, fetchImpl }) {
  const list = readWaits(file);
  if (!list.length) return { keep: [], done: [] };
  const target = getTelegramTarget(loadCfg(env, {}));
  const ctxOf = (w) => makeCtx(loadCfg(env, w.project ? { project: w.project } : {}));
  const res = await checkWaits(list, {
    now,
    log,
    clientsFor: (w) => { const c = ctxOf(w); return { mm: w.kind === 'mm' ? c.mm() : null, jira: w.kind === 'jira' ? c.jira() : null }; },
    notify: async (w, reply) => {
      if (!target) throw new Error('нет Telegram в конфиге');
      await sendMessage(target.token, target.chatId, replyText(w, reply), { parseMode: '', ...(fetchImpl ? { fetchImpl } : {}) });
    },
  });
  // Перечитываем: пока шла проверка, мог добавиться новый пункт.
  const handled = new Set(list.map((w) => w.id));
  const keptIds = new Set(res.keep.map((w) => w.id));
  writeWaits(readWaits(file).filter((w) => !handled.has(w.id) || keptIds.has(w.id)), file);
  for (const d of res.done) log(`wait ${d.id}: ответ от ${d.reply.author}, снят`);
  return res;
}

export async function cmdWait(ctx, [sub = 'list', kind, ref], opts = {}, { file = WAITS_FILE, now = Date.now() } = {}) {
  const list = readWaits(file);
  if (sub === 'add') {
    const w = makeWait(kind, ref, { project: ctx.cfg?.activeProject ?? '', from: opts.from, note: opts.note, now });
    writeWaits([...list, w], file);
    return { ok: true, added: w };
  }
  if (sub === 'rm') {
    const id = kind;
    if (!list.some((w) => w.id === id)) throw new CliError(`Ожидания ${id ?? ''} нет. Список: fsh wait list.`, 1, 'not_found');
    writeWaits(list.filter((w) => w.id !== id), file);
    return { ok: true, removed: id };
  }
  if (sub === 'list') return { ok: true, waits: list };
  throw new CliError('Использование: fsh wait add|list|rm.', 1, 'usage');
}

export function renderWait(r) {
  if (r.added) console.log(`Жду до конца ${r.added.day}: ${r.added.kind} ${r.added.target}${r.added.from ? ` от ${r.added.from}` : ''} (id ${r.added.id}). Проверяет fsh up.`);
  else if (r.removed) console.log(`Снято: ${r.removed}`);
  else if (!r.waits.length) console.log('Ожиданий нет.');
  else for (const w of r.waits) console.log(`${w.id}  ${w.day}  ${w.kind} ${w.target}${w.from ? ` от ${w.from}` : ''}${w.note ? `  ${w.note}` : ''}`);
}
