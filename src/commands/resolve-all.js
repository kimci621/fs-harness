import { existsSync } from 'node:fs';
import path from 'node:path';
import { cmdMRS } from './mrs.js';
import { cmdMM } from './mm.js';
import { conflictAction, conflictingFiles, behindCount } from '../actions/conflict.js';
import { threadsAction, openThreads, awaitingReply } from '../actions/threads.js';
import { runActionCLI } from '../engine.js';
import { mapLimit } from '../pipeline.js';
import { acquireLock, lockKey } from '../locks.js';
import { readRun } from '../agent/journal.js';
import { keyFromBranch } from '../jira.js';
import { expandHome } from '../config.js';
import { makeGit } from '../workspace.js';
import { makeLogger, finish } from '../output.js';
import { confirm } from '../ui.js';
import { CliError } from '../errors.js';

// Конфликт и отставание считаем локально, как conflict: поле GitLab при "unchecked" врёт.
export function gitProbe(projectDir) {
  const git = makeGit(projectDir);
  return (mr) => {
    const { source_branch: src, target_branch: tgt } = mr;
    git(['fetch', 'origin', `${src}:refs/remotes/origin/${src}`, `${tgt}:refs/remotes/origin/${tgt}`]);
    const files = conflictingFiles(projectDir, `origin/${tgt}`, `origin/${src}`);
    return { conflicts: files.length, files, behind: behindCount(git, src, tgt) };
  };
}

export function planSteps(c) {
  return [
    c.conflicts ? `conflict: ${c.conflicts} файлов в конфликте с ${c.target}` : c.behind ? `sync: merge ${c.target} (отстаёт на ${c.behind})` : null,
    c.threads ? `threads: ${c.threads} открытых тредов` : null,
    `mm reply ${keyFromBranch(c.branch) ?? '(ключа задачи в ветке нет)'}, если что-то запушено или отвечено`,
  ].filter(Boolean);
}

// Мои открытые MR, кроме черновиков, где есть работа: открытые треды, конфликт или отставание от target.
export async function findCandidates(ctx, probe, only = []) {
  const { mrs } = await cmdMRS(ctx.g, ctx.repo, { asObject: true, author: 'me' });
  const picked = new Set(only.map((a) => Number(String(a).replace(/^!/, ''))));
  const me = (await ctx.g.me())?.username;
  const rows = await mapLimit(mrs.filter((mr) => !mr.draft && (!picked.size || picked.has(mr.iid))), 4, async (mr) => {
    const base = { iid: mr.iid, branch: mr.source_branch, target: mr.target_branch };
    try {
      const threads = awaitingReply(openThreads(await ctx.g.getDiscussions(ctx.repo, mr.iid)), me).length;
      return { ...base, threads, ...probe(mr) };
    } catch (err) {
      return { ...base, error: err.message, code: err.code ?? 'failed' };
    }
  });
  return rows.filter((c) => c.error || c.threads || c.conflicts || c.behind).map((c) => (c.error ? c : { ...c, steps: planSteps(c) }));
}

// Провал действия: id рана, где упало и чем доигрывать. Дошёл до verify, но не судья — значит publish.
export function failure(err, runsDir) {
  const out = { status: 'failed', code: err.code ?? 'failed', error: err.message };
  if (!err.run) return out;
  let verified = false;
  try {
    verified = Boolean(readRun(err.run, { root: runsDir }).meta?.head_sha);
  } catch {}
  const phase = String(out.code).startsWith('judge') ? 'judge' : verified ? 'publish' : 'agent';
  const hint = phase === 'publish' ? `fsh publish ${err.run}` : phase === 'agent' ? `fsh resume ${err.run}` : `fsh runs show ${err.run}`;
  return { ...out, runId: err.run, phase, hint };
}

export function mmText(target, sync, threads) {
  const parts = [];
  if (sync.status === 'done') parts.push(`ветка обновлена от ${target} (${String(sync.head_sha ?? '').slice(0, 8)})`);
  if (threads.status === 'done') {
    parts.push(`отвечено тредов ревью: ${threads.replied.length}` + (threads.commits_ahead
      ? `, правки: ${threads.commits_ahead} коммит(ов), HEAD ${String(threads.head_sha ?? '').slice(0, 8)}`
      : ', без правок кода'));
  }
  const text = parts.join('; ');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

async function runStep(env, spec, iid, extra) {
  try {
    const res = await env.runAction(spec, env.ctx, [String(iid)], { ...env.optsFor(spec), ...extra });
    if (res?.pending_approval) return { status: 'pending', runId: res.run, hint: `fsh publish ${res.run}` };
    if (res?.skipped) return { status: 'skipped' };
    return { status: 'done', runId: res.run, res };
  } catch (err) {
    return failure(err, env.runsDir);
  }
}

// Цепочка одного MR под локом: sync/conflict → threads (от уже обновлённой ветки) → реплика в MM.
export async function processMR(c, env) {
  const entry = { iid: c.iid, branch: c.branch, target: c.target };
  const lock = acquireLock({ root: env.locksRoot, key: lockKey({ repo: env.ctx.repo, mr: c.iid }) });
  if (!lock.acquired) {
    return { ...entry, sync: { status: 'locked' }, threads: { status: 'locked' }, mm: { status: 'not_needed' }, error: `MR занят другим процессом (pid ${lock.holder?.pid ?? '?'})` };
  }
  try {
    let sync = { status: 'not_needed' };
    if (c.conflicts || c.behind) {
      const r = await runStep(env, conflictAction, c.iid, { sync: true });
      sync = r.res ? { status: r.status, runId: r.runId, head_sha: r.res.head_sha } : r;
    }

    let threads = { status: 'not_needed' };
    // Недоехавший sync ждёт человека: пуш тредов поверх сломал бы fsh publish его рана.
    if (c.threads && ['failed', 'pending'].includes(sync.status)) threads = { status: 'blocked' };
    else if (c.threads) {
      const r = await runStep(env, threadsAction, c.iid, {});
      threads = r.res
        ? { status: r.status, runId: r.runId, replied: r.res.replied ?? [], resolved: r.res.resolved ?? [], commits_ahead: r.res.commits_ahead ?? 0, head_sha: r.res.head_sha }
        : r;
    }

    let mm = { status: 'not_needed' };
    if (sync.status === 'done' || (threads.status === 'done' && (threads.replied.length || threads.commits_ahead))) {
      const key = keyFromBranch(c.branch);
      if (!key) mm = { status: 'no_key' };
      else {
        try {
          await env.mm(env.ctx, ['reply', key, mmText(c.target, sync, threads)], { asObject: true, yes: true });
          mm = { status: 'sent', key };
        } catch (err) {
          mm = { status: err.code === 'not_found' ? 'not_found' : 'failed', key, error: err.message };
        }
      }
    }
    return { ...entry, sync, threads, mm };
  } finally {
    lock.release();
  }
}

const bad = (e) => e.error || ['failed', 'locked'].includes(e.sync?.status) || ['failed', 'locked'].includes(e.threads?.status);

function summary(e, log) {
  if (!e.sync) return log(`❌ !${e.iid} ${e.branch}: ${e.error}`);
  const part = (name, s) => `${name} ${s.status}${s.replied ? ` (${s.replied.length} ответов)` : ''}`;
  log(`${bad(e) ? '❌' : '✅'} !${e.iid} ${e.branch} → ${e.target}: ${part('sync', e.sync)} · ${part('threads', e.threads)} · mm ${e.mm.status}`);
  for (const [name, s] of [['sync', e.sync], ['threads', e.threads], ['mm', e.mm]]) {
    if (s.error) log(`     ${name}: ${s.error.split('\n')[0]}${s.phase ? ` (фаза ${s.phase})` : ''}`);
    if (s.hint) log(`     дальше: ${s.hint}`);
  }
  if (e.error) log(`     ${e.error}`);
}

// fsh resolve-all — все мои открытые MR разом. deps — швы для тестов.
export async function cmdResolveAll(ctx, opts = {}, deps = {}) {
  const log = opts.asObject ? () => {} : makeLogger(opts.json);
  const { dryRun, concurrency, only = [], manual, ...rest } = opts;
  const projectDir = expandHome(opts.projectDir || ctx.cfg?.projectDir || '');
  const probe = deps.probe ?? (() => {
    if (!projectDir || !existsSync(path.join(projectDir, '.git'))) {
      throw new CliError('Каталог проекта не настроен или не является git-репозиторием. Выполни fsh config init или передай --project-dir.', 1, 'config_invalid');
    }
    return gitProbe(projectDir);
  })();

  const candidates = await findCandidates(ctx, probe, only);
  const broken = candidates.filter((c) => c.error);
  const todo = candidates.filter((c) => !c.error);
  if (dryRun && candidates.length) log('🔍 План resolve-all (dry-run), ничего не запускается:');
  if (!candidates.length) log('✅ Работы нет: у моих открытых MR нет открытых тредов, конфликтов и отставания.');
  for (const c of todo) log(`• !${c.iid} ${c.branch} → ${c.target}: ${c.steps.join('; ')}`);
  for (const c of broken) log(`❌ !${c.iid} ${c.branch}: не посчитать состояние — ${c.error}`);

  if (dryRun) {
    const result = { ok: true, dry_run: true, mrs: candidates };
    finish(opts.json && !opts.asObject, result);
    return result;
  }
  if (todo.length && !opts.yes && !opts.asObject && !confirm(`Запускаю resolve-all для ${todo.length} MR. Продолжить? [y/N] `)) {
    throw new CliError('Отменено.', 0, 'canceled');
  }

  const env = {
    ctx,
    runAction: deps.runAction ?? runActionCLI,
    mm: deps.mm ?? cmdMM,
    locksRoot: deps.locksRoot,
    runsDir: opts.runsDir,
    optsFor: (spec) => ({
      ...rest,
      agent: opts.agent || ctx.cfg?.agent || spec.action.agent.default,
      agentExplicit: Boolean(opts.agent),
      projectDir,
      cfg: ctx.cfg,
      yes: true,
      json: true,
      asObject: true,
      // Полный цикл без кнопки Telegram: гейтом остаётся судья. --manual возвращает кнопку.
      noApprovals: !manual,
      onlyAwaiting: true,
    }),
  };
  const limit = Number(concurrency) > 0 ? Number(concurrency) : ctx.cfg?.workers?.concurrency ?? 2;
  const done = await mapLimit(todo, limit, async (c) => {
    log(`▶ !${c.iid} ${c.branch}…`);
    return processMR(c, env);
  });
  // mapLimit глотает исключение в {error}: MR всё равно должен попасть в отчёт.
  const mrs = [
    ...done.map((e, i) => (e.iid ? e : { iid: todo[i].iid, branch: todo[i].branch, error: e.error?.message ?? String(e.error) })),
    ...broken.map(({ iid, branch, error }) => ({ iid, branch, error })),
  ];
  const result = { ok: !mrs.some(bad), mrs };
  if (!opts.asObject && !opts.json) {
    log('');
    mrs.forEach((e) => summary(e, log));
  }
  finish(opts.json && !opts.asObject, result);
  return result;
}
