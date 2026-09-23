import { reviseRun } from '../publish.js';
import { findCommand } from '../registry.js';
import { finish } from '../output.js';
import { CliError } from '../errors.js';

// fsh revise <runId> — доделка в той же сессии: агент продолжает диалог, потом судья.
// При approvals:true ран снова встаёт в pending_approval с новым nonce.
export async function cmdRevise(ctx, args, opts = {}) {
  const runId = args[0];
  if (!runId) throw new CliError('Использование: fsh revise <runId> [--message "<текст>"]. Посмотреть раны: fsh runs.', 1, 'usage');

  const say = opts.asObject
    ? () => {}
    : (text) => (opts.json ? process.stderr.write(`${text}\n`) : console.log(text));

  const res = await reviseRun(runId, {
    ctx,
    find: findCommand,
    say,
    runsDir: opts.runsDir,
    fetchImpl: opts.fetchImpl,
    message: opts.message,
    approvalSink: opts.approvalSink,
    makeProvider: opts.makeProvider,
  });

  if (opts.asObject) return res;
  finish(opts.json, res);
  return res;
}
