import { publishRun } from '../publish.js';
import { findCommand } from '../registry.js';
import { finish } from '../output.js';
import { CliError } from '../errors.js';

// fsh publish <runId> — доопубликовать упавший на push/build ран, не гоняя агента и судью заново.
export async function cmdPublish(ctx, args, opts = {}) {
  const runId = args[0];
  if (!runId) throw new CliError('Использование: fsh publish <runId> [--dry-run]. Посмотреть раны: fsh runs.', 1, 'usage');

  const say = opts.asObject
    ? () => {}
    : (text) => (opts.json ? process.stderr.write(`${text}\n`) : console.log(text));

  const res = await publishRun(runId, {
    ctx,
    find: findCommand,
    say,
    runsDir: opts.runsDir,
    dryRun: opts.dryRun,
    fetchImpl: opts.fetchImpl,
    opts,
  });

  if (opts.asObject) return res;
  if (res.dry_run) {
    if (opts.json) {
      finish(true, res);
      return res;
    }
    console.log(`🔍 Публикация рана ${res.run} (${res.action}) из ${res.worktree}`);
    console.log(`   цель: ${res.target ?? '—'} · вердикт: ${res.verdict?.decision ?? '—'} · pre: ${res.pre_source}`);
    return res;
  }
  finish(opts.json, res);
  return res;
}
