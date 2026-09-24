import { listJobs, pruneQueue, clearQueue } from '../queue.js';
import { listLocks, lockKey } from '../locks.js';
import { table } from '../format.js';
import { finish } from '../output.js';
import { confirm } from '../ui.js';
import { CliError } from '../errors.js';

// fsh queue — что watcher положил в очередь заданий. Исполнителя у неё пока нет
// (PLAN, фазы 12-15): это список того, что требует работы, а не планировщик.
export function cmdQueue(ctx, args, opts = {}) {
  const [sub = 'list', ...rest] = args;
  if (rest.length) throw new CliError('Использование: fsh queue [list|clear].', 1, 'usage');
  const root = opts.queueRoot;
  const at = root ? { root } : {};

  if (sub === 'clear') {
    if (!opts.yes && !opts.json && !confirm('Очистить очередь заданий? [y/N] ')) {
      throw new CliError('Отменено.', 1, 'canceled');
    }
    const keys = clearQueue(at);
    const result = { ok: true, cleared: keys.length, keys };
    if (opts.asObject) return result;
    if (opts.json) finish(true, result);
    else console.log(`Очередь очищена: заданий ${keys.length}.`);
    return result;
  }
  if (sub !== 'list') throw new CliError('Использование: fsh queue [list|clear].', 1, 'usage');

  pruneQueue(at);
  const jobs = listJobs(at);
  const activeLocks = listLocks({ root: opts.locksRoot }).filter((l) => !l.stale);
  const locksMap = new Map(activeLocks.map((l) => [l.key, l]));

  const jobsWithLocks = jobs.map((j) => {
    const key = lockKey({ repo: j.repo, mr: j.mr, branch: j.branch, task: j.task });
    const lock = locksMap.get(key) || null;
    return { ...j, lock: lock ? { pid: lock.pid, at: lock.at } : null };
  });

  const result = { ok: true, jobs: jobsWithLocks };
  if (opts.asObject) return result;
  if (opts.json) {
    finish(true, result);
    return result;
  }
  if (!jobs.length) {
    console.log('Очередь пуста.');
    return result;
  }
  console.log(table([
    ['ВИД', 'ПРОЕКТ', 'MR', 'ДЕЙСТВИЕ', 'ЛОК', 'ВАЖНОСТЬ', 'ЧТО'],
    ...jobsWithLocks.map((j) => [
      j.kind,
      j.project || '—',
      j.mr ? `!${j.mr}` : '—',
      j.action ?? '—',
      j.lock ? `🔒 pid:${j.lock.pid}` : '—',
      j.level ?? '—',
      j.detail,
    ]),
  ]));
  console.log(`\nВсего ${jobs.length}.`);
  return result;
}
