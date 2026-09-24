import path from 'node:path';
import { listWorktrees, gcWorktrees } from '../worktrees.js';
import { expandHome } from '../config.js';
import { table } from '../format.js';
import { finish } from '../output.js';
import { confirm } from '../ui.js';
import { CliError } from '../errors.js';

// fsh worktrees — управление временными каталогами worktree.
export async function cmdWorktrees(ctx, args = [], opts = {}) {
  const [sub = 'list', ...rest] = args;
  if (rest.length) {
    throw new CliError('Использование: fsh worktrees [list|gc] [--sizes] [--older-than N] [--dry-run].', 1, 'usage');
  }

  const root = opts.root
    ? expandHome(opts.root)
    : (ctx.cfg?.workspace?.root ? expandHome(ctx.cfg.workspace.root) : undefined);
  const runsRoot = opts.runsDir ? expandHome(opts.runsDir) : undefined;
  const projectDirs = Object.values(ctx.cfg?.projects ?? {})
    .map((p) => (p.dir ? expandHome(p.dir) : null))
    .filter(Boolean);

  if (sub === 'gc') {
    const olderThanDays = opts['older-than'] !== undefined
      ? Number(opts['older-than'])
      : (ctx.cfg?.workspace?.gcOlderThanDays ?? 7);
    const dryRun = Boolean(opts['dry-run'] || opts.dryRun);

    if (dryRun) {
      const candidates = await gcWorktrees({
        root,
        runsRoot,
        projectDirs,
        olderThanDays,
        dryRun: true,
        g: ctx.g,
        repo: ctx.repo,
      });
      const result = { ok: true, dry_run: true, count: candidates.length, worktrees: candidates };
      if (opts.asObject) return result;
      if (opts.json) {
        finish(true, result);
        return result;
      }
      if (!candidates.length) {
        console.log('Worktree для очистки не найдено.');
        return result;
      }
      console.log(`🔍 План очистки worktree (${candidates.length}):\n`);
      console.log(table([
        ['КАТАЛОГ', 'ПРОЕКТ', 'ВЕТКА', 'СТАТУС', 'ВОЗРАСТ (дн)', 'ПРИЧИНА'],
        ...candidates.map((w) => [
          path.basename(w.dir),
          w.project || '—',
          w.branch || '—',
          w.status,
          String(w.age_days),
          w.reason,
        ]),
      ]));
      return result;
    }

    const candidates = await gcWorktrees({
      root,
      runsRoot,
      projectDirs,
      olderThanDays,
      dryRun: true,
      g: ctx.g,
      repo: ctx.repo,
    });

    if (!candidates.length) {
      const result = { ok: true, cleaned: 0, worktrees: [] };
      if (opts.asObject) return result;
      if (opts.json) finish(true, result);
      else console.log('Worktree для очистки не найдено.');
      return result;
    }

    if (!opts.yes && !opts.json && !confirm(`Удалить ${candidates.length} worktree? [y/N] `)) {
      throw new CliError('Отменено.', 1, 'canceled');
    }

    const deleted = await gcWorktrees({
      root,
      runsRoot,
      projectDirs,
      olderThanDays,
      dryRun: false,
      g: ctx.g,
      repo: ctx.repo,
      say: (msg) => { if (!opts.json) console.log(msg); },
    });

    const result = { ok: true, cleaned: deleted.length, worktrees: deleted };
    if (opts.asObject) return result;
    if (opts.json) {
      finish(true, result);
      return result;
    }
    console.log(`Очищено worktree: ${deleted.length}.`);
    return result;
  }

  if (sub !== 'list') {
    throw new CliError('Использование: fsh worktrees [list|gc] [--sizes] [--older-than N] [--dry-run].', 1, 'usage');
  }

  const sizes = Boolean(opts.sizes);
  const list = listWorktrees({ root, runsRoot, projectDirs, sizes });
  const result = { ok: true, worktrees: list };
  if (opts.asObject) return result;
  if (opts.json) {
    finish(true, result);
    return result;
  }
  if (!list.length) {
    console.log('Временных worktree нет.');
    return result;
  }

  const headers = ['КАТАЛОГ', 'ПРОЕКТ', 'ВЕТКА', 'ДЕЙСТВИЕ', 'СТАТУС', 'ВОЗРАСТ'];
  if (sizes) headers.push('РАЗМЕР');

  console.log(table([
    headers,
    ...list.map((w) => {
      const row = [
        path.basename(w.dir),
        w.project || '—',
        w.branch || '—',
        w.action || '—',
        w.status,
        `${w.age_days} дн`,
      ];
      if (sizes) row.push(w.size_mb !== null && w.size_mb !== undefined ? `${w.size_mb} MB` : '—');
      return row;
    }),
  ]));
  return result;
}
