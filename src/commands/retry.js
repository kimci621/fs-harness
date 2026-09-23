import { readRun, runIsActive } from '../agent/journal.js';
import { findCommand } from '../registry.js';
import { CliError } from '../errors.js';

// fsh retry <runId> — повторить упавший ран с нуля: то же действие и та же цель,
// но новый worktree и новая сессия. Продолжение той же операции — это fsh resume.
export async function cmdRetry(ctx, args, opts = {}) {
  const runId = args[0];
  if (!runId) throw new CliError('Использование: fsh retry <runId>. Посмотреть раны: fsh runs.', 1, 'usage');
  const at = opts.runsDir ? { root: opts.runsDir } : {};
  const saved = readRun(runId, at);
  const m = saved.meta;

  // Шов для тестов: реестр подменяется, чтобы не поднимать настоящее действие.
  const find = opts.findCommand ?? findCommand;
  const entry = find(m.action);
  if (!entry?.action) {
    throw new CliError(`Ран ${runId} ссылается на неизвестное действие "${m.action}" — повторять нечего.`, 1, 'action_unknown');
  }
  if (runIsActive(m, saved.dir)) {
    throw new CliError(`Ран ${runId} ещё выполняется (pid ${m.pid}). Дождись или прерви его.`, 1, 'run_active');
  }
  const query = m.mr ? `!${m.mr}` : m.issue;
  if (entry.action.target !== 'none' && !query) {
    throw new CliError(`Ран ${runId} не привязан ни к MR, ни к задаче — повторять нечего.`, 1, 'run_not_retryable');
  }

  return entry.run(ctx, query ? [query] : [], { ...opts, agent: opts.agent || m.agent });
}
