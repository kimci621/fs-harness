import { QUEUE_ROOT, pruneQueue, listJobs, removeJob, updateJob } from './queue.js';
import { LOCKS_ROOT, acquireLock, lockKey } from './locks.js';
import { ACTIONS, createCtx } from './registry.js';
import { runActionCLI } from './engine.js';
import { loadConfig } from './config.js';
import { createGlab } from './glab.js';
import { CliError } from './errors.js';

// Максимум 3 попытки: если действие трижды падает с ошибкой — снимаем задание, чтобы не забивать очередь
export const JOB_MAX_ATTEMPTS = 3;

const stamp = (d = new Date()) => d.toISOString().slice(11, 19);

// Взять очередное готовое задание и захватить для него лок ветки/MR
export function takeJob({
  queueRoot = QUEUE_ROOT,
  locksRoot = LOCKS_ROOT,
  now = Date.now(),
  excludeKeys = new Set(),
} = {}) {
  pruneQueue({ root: queueRoot, now });
  const jobs = listJobs({ root: queueRoot, now });

  for (const job of jobs) {
    if (!job.action) continue;
    if (excludeKeys.has(job.key)) continue;

    const key = lockKey({ repo: job.repo, mr: job.mr, branch: job.branch, task: job.task });
    const lock = acquireLock({ root: locksRoot, key, now });
    if (lock.acquired) {
      return { job, lock, release: lock.release };
    }
  }
  return null;
}

// Запуск цикла воркеров: параллельная выборка и исполнение заданий из очереди
export async function runWorker({
  cfg,
  g,
  queueRoot = QUEUE_ROOT,
  locksRoot = LOCKS_ROOT,
  once = false,
  concurrency = 2,
  log = console.log,
  signal,
  intervalMs = 5000,
  deps = {},
} = {}) {
  const now = deps.now || (() => Date.now());
  const takeJobFn = deps.takeJob || takeJob;
  const runActionFn = deps.runAction || runActionCLI;
  const actionsList = deps.actions || ACTIONS;
  const actionMap = Object.fromEntries(actionsList.map((a) => [a.name, a]));

  const ctx = deps.ctx || createCtx({ g, cfg, notify: () => {} });

  let stopped = false;
  let wake = null;
  const stop = () => {
    stopped = true;
    wake?.();
  };

  if (signal) {
    if (signal.aborted) stopped = true;
    else signal.addEventListener('abort', stop, { once: true });
  }

  const activeJobs = new Map(); // key -> Promise
  const excludeKeys = new Set();
  const failedInThisPass = new Set();

  while (!stopped) {
    // Наполняем доступные слоты параллельности
    while (!stopped && activeJobs.size < concurrency) {
      const taken = takeJobFn({
        queueRoot,
        locksRoot,
        now: now(),
        excludeKeys: new Set([...excludeKeys, ...failedInThisPass]),
      });
      if (!taken) break;

      const { job, release } = taken;
      excludeKeys.add(job.key);

      const promise = (async () => {
        try {
          const spec = actionMap[job.action];
          if (!spec) {
            throw new CliError(`Действие "${job.action}" не найдено в реестре.`, 1, 'action_unknown');
          }
          log?.(`${stamp()} [worker] Старт ${job.action} для ${job.key}…`);
          const targetArg = job.mr ? String(job.mr) : (job.task ? String(job.task) : String(job.key));

          const jobCfg = (job.project && ctx.cfg?.projects?.[job.project])
            ? (deps.loadConfig || loadConfig)(process.env, { project: job.project })
            : (ctx.cfg || {});

          const jobCtx = deps.makeCtx
            ? deps.makeCtx(jobCfg)
            : (jobCfg === ctx.cfg
              ? ctx
              : createCtx({
                  g: (ctx.g && jobCfg.host === ctx.cfg?.host)
                    ? ctx.g
                    : (deps.createGlab || createGlab)(undefined, { host: jobCfg.host }),
                  cfg: jobCfg,
                  notify: () => {},
                }));

          const agent = deps.actionOpts?.agent || jobCfg.agent || spec.action?.agent?.default || 'cc';
          const projectDir = deps.actionOpts?.projectDir || jobCfg.projectDir || (jobCfg.activeProject && jobCfg.projects?.[jobCfg.activeProject]?.dir);

          const runOpts = {
            yes: true,
            json: true,
            quiet: true,
            signal,
            agent,
            projectDir,
            cfg: jobCfg,
            ...deps.actionOpts,
          };

          const runRes = runActionFn(
            spec,
            jobCtx,
            [targetArg],
            runOpts,
          );
          await (runRes?.result ?? runRes);
          removeJob(job.key, { root: queueRoot });
          log?.(`${stamp()} [worker] Задание ${job.key} выполнено успешно.`);
        } catch (err) {
          failedInThisPass.add(job.key);
          const attempts = (job.attempts || 0) + 1;
          if (attempts >= JOB_MAX_ATTEMPTS) {
            removeJob(job.key, { root: queueRoot });
            log?.(`${stamp()} [worker] Задание ${job.key} снято после ${JOB_MAX_ATTEMPTS} попыток: ${err.message}`);
          } else {
            updateJob(job.key, { attempts }, { root: queueRoot });
            log?.(`${stamp()} [worker] Задание ${job.key} упало (попытка ${attempts}/${JOB_MAX_ATTEMPTS}): ${err.message}`);
          }
        } finally {
          try { release(); } catch {}
          excludeKeys.delete(job.key);
        }
      })();

      activeJobs.set(job.key, promise);
      promise.finally(() => activeJobs.delete(job.key));
    }

    if (activeJobs.size > 0) {
      // Ждём освобождения хотя бы одного слота
      await Promise.race(activeJobs.values());
    } else {
      // Свободных заданий нет
      if (once) break;
      failedInThisPass.clear(); // новый цикл опроса после сна
      await new Promise((resolve) => {
        wake = resolve;
        const timer = setTimeout(resolve, intervalMs);
        if (timer.unref) timer.unref();
      });
      wake = null;
    }
  }

  // Перед выходом дожидаемся завершения уже запущенных задач
  if (activeJobs.size > 0) {
    await Promise.all(activeJobs.values());
  }
}
