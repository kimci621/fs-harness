import { existsSync } from 'node:fs';
import { readRun, runIsActive } from '../agent/journal.js';
import { runActionCLI } from '../engine.js';
import { findCommand, withRepoHost } from '../registry.js';
import { finish } from '../output.js';
import { CliError } from '../errors.js';

// Коды, при которых агент не дошёл до приёмки: только их и доигрываем.
// Судейские и публикационные провалы доигрываются иначе (--judge-only / retry).
const RESUMABLE = ['agent_failed', 'canceled'];

// fsh resume <runId> — продолжить ту же операцию: тот же worktree и та же сессия агента,
// без повторного precheck. Дальше обычный ход: verify → судья → publish.
export async function cmdResume(ctx, args, opts = {}) {
  const runId = args[0];
  if (!runId) throw new CliError('Использование: fsh resume <runId> [--message "<текст>"]. Посмотреть раны: fsh runs.', 1, 'usage');
  const at = opts.runsDir ? { root: opts.runsDir } : {};
  const saved = readRun(runId, at);
  const m = saved.meta;

  const entry = findCommand(m.action);
  if (!entry?.action) {
    throw new CliError(`Ран ${runId} ссылается на неизвестное действие "${m.action}" — доигрывать нечего.`, 1, 'action_unknown');
  }
  if (runIsActive(m, saved.dir)) {
    throw new CliError(`Ран ${runId} ещё выполняется (pid ${m.pid}). Дождись или прерви его.`, 1, 'run_active');
  }
  const code = m.error?.code;
  if (!RESUMABLE.includes(code)) {
    const hint = String(code ?? '').startsWith('judge')
      ? `Пересуди: fsh ${m.action} --judge-only ${runId}.`
      : `Повтори с нуля: fsh retry ${runId}.`;
    throw new CliError(`Ран ${runId} упал на "${code ?? '—'}" — доигрывать агента нечего. ${hint}`, 1, 'resume_not_applicable');
  }
  if (!m.pre || !m.worktree || !existsSync(m.worktree)) {
    throw new CliError(`Ран ${runId} не доиграть: worktree ${m.worktree ?? '—'} не сохранён или удалён. Повтори с нуля: fsh retry ${runId}.`, 1, 'run_not_resumable');
  }

  const agent = opts.agent || m.agent;
  // --dry-run не спавнит агента: показываем, что именно доиграем.
  if (opts.dryRun) {
    const result = { ok: true, dry_run: true, run: runId, action: m.action, worktree: m.worktree, agent, error: m.error ?? null };
    if (opts.asObject) return result;
    if (opts.json) {
      finish(true, result);
      return result;
    }
    console.log(`🔍 Продолжить ран ${runId} (${m.action}) в ${m.worktree}, агент ${agent}.`);
    console.log(`   прошлая ошибка: [${code}] ${m.error?.message ?? ''}`);
    return result;
  }

  return withRepoHost(ctx, () => runActionCLI(entry, ctx, [], {
    ...opts,
    resumeOf: runId,
    agent: opts.agent || m.agent,
    cfg: ctx.cfg,
    projectDir: opts.projectDir || ctx.cfg.projectDir,
  }));
}
