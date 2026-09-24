import { runWorker } from '../worker.js';
import { finish } from '../output.js';

// fsh worker — обработка заданий из очереди в параллельных слотах
export async function cmdWorker(ctx, args = [], opts = {}, deps = {}) {
  const once = Boolean(opts.once);
  const concurrency = opts.concurrency !== undefined
    ? Number(opts.concurrency)
    : (ctx.cfg?.workers?.concurrency ?? 2);

  const intervalSec = Math.max(5, Number(ctx.cfg?.watch?.intervalSeconds) || 60);
  const intervalMs = intervalSec * 1000;

  const runWorkerFn = deps.runWorker || runWorker;

  if (!opts.json && !opts.asObject) {
    console.log(`👷 Запуск воркера (параллельность: ${concurrency}, режим: ${once ? 'однократно' : 'демон'})…`);
  }

  const actionOpts = {
    ...(opts.dryRun ? { dryRun: true } : {}),
    ...(deps.actionOpts || {}),
  };

  await runWorkerFn({
    cfg: ctx.cfg,
    g: ctx.g,
    queueRoot: opts.queueRoot,
    locksRoot: opts.locksRoot,
    once,
    concurrency,
    intervalMs,
    log: (msg) => {
      if (!opts.json && !opts.asObject) console.log(msg);
    },
    signal: opts.signal,
    deps: {
      ...deps,
      actionOpts,
    },
  });

  const result = { ok: true, finished: true };
  if (opts.asObject) return result;
  if (opts.json) finish(true, result);
  return result;
}
