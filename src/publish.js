import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { makeGit, reopenRunWorkspace, removeWorktree } from './workspace.js';
import { readRun, patchRunMeta, appendEvent, saveArtifact, runIsActive, sweepExpiredApprovals, RUNS_DIR } from './agent/journal.js';
import { resolveTarget, spawnSession, reviseMessage, SESSION_ARGS } from './engine.js';
import { isApproved, formatVerdict, judge } from './judge/index.js';
import { buildAcceptancePayload } from './judge/payload.js';
import { getTelegramTarget, postTelegram, runMessage } from './notify.js';
import { resolveAgent } from './agents.js';
import { approvalNonce, sendApprovalRequest } from './tgbot.js';
import { CliError } from './errors.js';

// Реконструкция снимка precheck для ранов, созданных до появления meta.pre.
// Возвращает null, если для действия восстановить нечего: лучше отказ, чем тихий неверный publish.
export function reconstructPre(action, meta, cfg = {}) {
  switch (action) {
    case 'implement': {
      if (!meta.branch || !meta.target_branch || !meta.issue) return null;
      const base = String(cfg.jira?.baseUrl ?? '').replace(/\/+$/, '');
      return { branch: meta.branch, target: meta.target_branch, url: base ? `${base}/browse/${meta.issue}` : '' };
    }
    case 'conflict':
      if (!meta.mr || !meta.source_branch) return null;
      return { conflictFiles: meta.conflict_files ?? [] };
    case 'ci-fix': {
      const names = meta.facts?.failed_jobs ?? meta.failed_jobs ?? [];
      if (!meta.mr || !names.length) return null;
      return {
        failed: names.map((name) => ({ name })),
        attempts: { done: Math.max(0, (meta.attempt ?? 1) - 1), max: cfg.ci?.maxRetries ?? 2 },
      };
    }
    case 'threads':
      // publish у threads читает только facts (commits_ahead/head_sha/replies) — pre пуст.
      return meta.facts?.replies ? {} : null;
    default:
      return null;
  }
}

// Цель для публикации: issue резолвим по-настоящему (нужен summary для заголовка MR),
// MR собираем из meta без сети — publish сам сходит в GitLab.
async function targetFor(kind, ctx, m) {
  if (kind === 'none') return null;
  if (kind === 'issue') {
    if (!m.issue) throw new CliError('В meta нет ключа задачи — публиковать нечего.', 1, 'run_not_publishable');
    return resolveTarget('issue', ctx, m.issue);
  }
  if (m.mr == null || !m.source_branch) throw new CliError('В meta нет MR или ветки — публиковать нечего.', 1, 'run_not_publishable');
  return { iid: m.mr, source_branch: m.source_branch, target_branch: m.target_branch, title: m.mr_title ?? '' };
}

function dropExpiredWorktree(run) {
  let meta;
  try { meta = JSON.parse(readFileSync(path.join(run.dir, 'meta.json'), 'utf8')); } catch { return; }
  if (!meta.project_dir || !meta.worktree) return;
  try { removeWorktree(makeGit(meta.project_dir), meta.worktree, meta.branch); } catch { /* уже нет */ }
}

function remoteHead(git, projectDir, branch) {
  let out = '';
  try { out = git(['ls-remote', 'origin', `refs/heads/${branch}`], projectDir); } catch { return null; }
  const sha = String(out).split(/\s+/)[0];
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

// exit 1 у merge-tree — конфликт, не ошибка git. Остальное не блокирует publish.
function conflictReappeared(dir, targetBranch) {
  try {
    execFileSync('git', ['fetch', 'origin', targetBranch], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    return false;
  }
  try {
    execFileSync('git', ['merge-tree', '--write-tree', '--name-only', '--no-messages', 'HEAD', `origin/${targetBranch}`], {
      cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return false;
  } catch (err) {
    return err.status === 1;
  }
}

export function approvalsOn(cfg) {
  return cfg?.telegram?.approvals === true && getTelegramTarget(cfg) !== null;
}

// Доопубликовать ран: либо ждущий кнопку (pending_approval), либо упавший на push/build.
// Второе уже было до фазы 13 — требовать только pending_approval сломало бы доопублик.
export async function publishRun(runId, deps = {}) {
  const { ctx, find, say = () => {}, runsDir, dryRun = false, fetchImpl, notify = true } = deps;
  const root = runsDir ?? RUNS_DIR;
  const expired = sweepExpiredApprovals({ root, onExpired: dropExpiredWorktree });
  const saved = readRun(runId, { root });
  const m = saved.meta;
  if (expired.includes(runId) || m.state === 'expired') {
    throw new CliError('Аппрув протух (TTL сутки). Worktree убран. Перезапусти действие.', 1, 'approval_expired');
  }
  if (m.state === 'rejected') throw new CliError(`Ран ${runId} отклонён.`, 1, 'run_not_pending');

  if (runIsActive(m, saved.dir)) throw new CliError(`Ран ${runId} ещё выполняется (pid ${m.pid}). Дождись или прерви его.`, 1, 'run_active');
  if (saved.read('result.json') !== null) throw new CliError(`Ран ${runId} уже опубликован (есть result.json).`, 1, 'already_published');

  const entry = find(m.action);
  if (!entry?.action || typeof entry.action.publish !== 'function') {
    throw new CliError(`Действие "${m.action}" ничего не публикует — публиковать нечего.`, 1, 'run_not_publishable');
  }
  const a = entry.action;

  let verdict = null;
  try {
    verdict = saved.read('verdict.json') ? JSON.parse(saved.read('verdict.json')) : null;
  } catch {
    verdict = null;
  }
  if (!verdict) {
    throw new CliError(`У рана ${runId} нет вердикта судьи — публиковать нечего. Пересуди: fsh ${m.action} --judge-only ${runId}.`, 1, 'run_not_approved');
  }
  if (a.judge.gate === 'pre-push' && !isApproved(verdict)) {
    throw new CliError(`Судья не одобрил публикацию: ${formatVerdict(verdict)}.\nДоиграть агента: fsh resume ${runId}.`, 1, 'run_not_approved');
  }

  if (!m.worktree || !existsSync(m.worktree)) throw new CliError(`Worktree ${m.worktree ?? '—'} не сохранён или удалён — публиковать не из чего.`, 1, 'worktree_gone');
  if (!m.project_dir || !m.head_sha) throw new CliError(`В meta рана ${runId} нет project_dir или head_sha — ран старый, работать не с чем.`, 1, 'run_not_publishable');

  const git = makeGit(m.project_dir);
  const head = git(['rev-parse', 'HEAD'], m.worktree);
  if (head !== m.head_sha) {
    throw new CliError(`Worktree ушёл вперёд: HEAD ${head.slice(0, 8)} ≠ ${m.head_sha.slice(0, 8)}. Кто-то коммитил после рана.`, 1, 'worktree_moved');
  }
  if (m.source_branch) {
    const remote = remoteHead(git, m.project_dir, m.source_branch);
    if (remote === m.head_sha) {
      throw new CliError(`origin/${m.source_branch} уже на ${m.head_sha.slice(0, 8)} — публиковать нечего.`, 1, 'already_published');
    }
    if (remote && m.base_sha && remote !== m.base_sha) {
      say(`⚠ origin/${m.source_branch} уехал вперёд от base (${remote.slice(0, 8)}).`);
    }
  }
  if (m.action === 'conflict' && m.target_branch && conflictReappeared(m.worktree, m.target_branch)) {
    throw new CliError('Пока ран ждал, target уехал: перезапусти conflict.', 1, 'conflict_reappeared');
  }

  const target = await targetFor(a.target, ctx, m);
  const pre = m.pre ?? reconstructPre(m.action, m, ctx.cfg);
  if (!pre) {
    throw new CliError(`Не восстановить контекст рана ${runId} (${m.action}): precheck не сохранён. Перезапусти действие: fsh retry ${runId}.`, 1, 'run_not_publishable');
  }

  if (dryRun) {
    return {
      ok: true, dry_run: true, run: runId, action: m.action, worktree: m.worktree, branch: m.branch,
      target: target?.iid ? `!${target.iid}` : target?.key ?? null,
      verdict: { decision: verdict.decision, confidence: verdict.confidence },
      pre_source: m.pre ? 'meta' : 'reconstructed',
    };
  }

  const ws = reopenRunWorkspace(m, a, { onEvent: say });
  const x = {
    ctx,
    opts: { ...(deps.opts ?? {}), cfg: ctx.cfg, yes: true },
    target,
    pre,
    ws,
    facts: { ...(m.facts ?? {}), head_sha: m.head_sha },
    verdict,
    run: { id: saved.id, dir: saved.dir },
    say,
    emit: () => {},
  };

  say(`⬆ Доопубликовываю ран ${runId} (${m.action}) из ${m.worktree}…`);
  x.published = (await a.publish(x)) ?? {};
  const res = a.result(x);

  appendEvent(saved, { t: 'done', ok: true, result: res });
  saveArtifact(saved, 'result.json', res);
  patchRunMeta(saved, { state: 'done', pid: null, error: null });
  // task-worktree и checkout здесь не удаляются — это делает cleanup по режиму.
  ws.cleanup(false);

  if (notify) {
    const tg = getTelegramTarget(ctx.cfg);
    if (tg) {
      const text = runMessage({
        action: m.action,
        target: m.issue ?? (m.mr ? `!${m.mr}` : ''),
        ok: true,
        cost: verdict?.meta?.cost ?? 0,
        verdict,
        url: x.published?.mr?.web_url ?? x.published?.pipeline?.web_url ?? target?.web_url ?? null,
      });
      try {
        await postTelegram(tg, text, { fetchImpl });
      } catch (e) {
        say(`⚠ Уведомление не ушло: ${e.message}`);
      }
    }
  }
  return res;
}

// Доделка в той же сессии: кнопка [Revise] и `fsh revise`. Старый nonce сгорает.
export async function reviseRun(runId, deps = {}) {
  const { ctx, find, say = () => {}, runsDir, fetchImpl, message, approvalSink, makeProvider } = deps;
  const spawn = deps.spawn ?? spawnSession;
  const root = runsDir ?? RUNS_DIR;
  const expired = sweepExpiredApprovals({ root, onExpired: dropExpiredWorktree });
  const saved = readRun(runId, { root });
  const m = saved.meta;
  if (expired.includes(runId) || m.state === 'expired') {
    throw new CliError('Аппрув протух (TTL сутки). Worktree убран. Перезапусти действие.', 1, 'approval_expired');
  }
  if (m.state !== 'pending_approval') {
    throw new CliError(`Ран ${runId} в состоянии «${m.state ?? 'нет'}» — доделывать нечего.`, 1, 'run_not_pending');
  }
  if (saved.read('result.json') !== null) throw new CliError(`Ран ${runId} уже опубликован.`, 1, 'already_published');
  if (!m.worktree || !existsSync(m.worktree)) {
    throw new CliError(`Worktree ${m.worktree ?? '—'} удалён, ран не доиграть. Перезапусти действие.`, 1, 'worktree_gone');
  }
  let verdict = null;
  try { verdict = saved.read('verdict.json') ? JSON.parse(saved.read('verdict.json')) : null; } catch { verdict = null; }
  if (!verdict) throw new CliError(`У рана ${runId} нет вердикта — доделывать не по чему.`, 1, 'run_not_approved');
  if (!m.session_id) throw new CliError('Ран старый, сессии нет; перезапусти действие.', 1, 'no_session');

  const entry = find(m.action);
  const a = entry?.action;
  if (!a || typeof a.verify !== 'function') throw new CliError(`Действие "${m.action}" не умеет доделку.`, 1, 'run_not_publishable');
  const agent = resolveAgent(ctx.cfg, m.agent);
  if (!SESSION_ARGS[agent.family]) throw new CliError('Ран старый, сессии нет; перезапусти действие.', 1, 'no_session');

  const ws = reopenRunWorkspace(m, a, { onEvent: say });
  const target = a.target === 'none' ? null : await targetFor(a.target, ctx, m);
  const text = [reviseMessage(verdict), message ? `Уточнение от человека: ${message}` : ''].filter(Boolean).join('\n');
  const x = {
    ctx,
    opts: { cfg: ctx.cfg, agent: m.agent, makeProvider },
    ws,
    target,
    signal: new AbortController().signal,
    emit: () => {},
    say,
    phase: () => {},
    sessions: { main: m.session_id },
    pre: m.pre ?? {},
    run: { id: saved.id, dir: saved.dir },
  };
  x.agentText = await spawn(x, text, { resume: true, agentName: m.agent });
  x.facts = await a.verify(x);
  const role = a.judge?.role ?? m.judge?.role ?? 'acceptance';
  const next = await judge({
    role,
    cfg: ctx.cfg,
    profile: m.judge?.profile ?? undefined,
    makeProvider,
    payload: a.judgePayload
      ? a.judgePayload(x)
      : buildAcceptancePayload({
          goal: a.goal ? a.goal(x) : m.goal,
          facts: { ...x.facts, diff: undefined, diff_title: undefined },
          extra: m.extra ?? '',
          diff: x.facts.diff,
          diffTitle: x.facts.diff_title,
          agentText: x.agentText,
        }),
  });
  saveArtifact(saved, 'verdict.json', next);
  x.verdict = next;
  patchRunMeta(saved, { head_sha: x.facts.head_sha, session_id: x.sessionId ?? m.session_id, facts: { ...(x.facts ?? {}), diff: undefined } });

  if (approvalsOn(ctx.cfg)) {
    const nonce = approvalNonce();
    const approval = { nonce, issued_at: new Date().toISOString(), run: saved.id, action: m.action };
    const meta = { ...m, state: 'pending_approval', approval, head_sha: x.facts.head_sha };
    patchRunMeta(saved, { state: 'pending_approval', pid: null, error: null, approval, head_sha: x.facts.head_sha });
    const sink = approvalSink ?? ((info) => sendApprovalRequest({ ...info, runsRoot: root }));
    try {
      await sink({ cfg: ctx.cfg, run: saved.id, meta, verdict: next, nonce, fetchImpl, say });
    } catch (e) {
      say(`⚠ Кнопки аппрува не ушли: ${e.message}. Ожидает аппрува: fsh publish ${saved.id}`);
    }
    return { ok: true, pending_approval: true, run: saved.id, nonce, verdict: { decision: next.decision, confidence: next.confidence, summary: next.summary } };
  }

  if (a.judge?.gate === 'pre-push' && !isApproved(next)) {
    throw new CliError(`${formatVerdict(next)}\n\nPush не сделан. Worktree сохранён: ${ws.dir}`, 1, 'judge_rejected');
  }
  x.published = (a.publish ? await a.publish(x) : null) ?? {};
  const res = a.result ? a.result(x) : { ok: true, run: saved.id };
  appendEvent(saved, { t: 'done', ok: true, result: res });
  saveArtifact(saved, 'result.json', res);
  patchRunMeta(saved, { state: 'done', pid: null, error: null });
  ws.cleanup(false);
  return res;
}
