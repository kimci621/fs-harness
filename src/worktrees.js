import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { WORKTREE_ROOT, makeGit, removeWorktree } from './workspace.js';
import { RUNS_DIR } from './agent/journal.js';

// Инвентаризация каталогов worktree: статус, возраст, привязка к ранам.
export function listWorktrees({
  root = WORKTREE_ROOT,
  runsRoot = RUNS_DIR,
  projectDirs = [],
  now = Date.now(),
  sizes = false,
} = {}) {
  if (!existsSync(root)) return [];

  // Собираем мету всех ранов для сопоставления
  const runsByWorktree = new Map();
  if (existsSync(runsRoot)) {
    for (const id of readdirSync(runsRoot)) {
      const metaFile = path.join(runsRoot, id, 'meta.json');
      if (!existsSync(metaFile)) continue;
      try {
        const meta = JSON.parse(readFileSync(metaFile, 'utf8'));
        if (meta?.worktree) {
          const prev = runsByWorktree.get(meta.worktree);
          const isLive = meta.state === 'running' || meta.state === 'pending_approval';
          const prevLive = prev?.meta?.state === 'running' || prev?.meta?.state === 'pending_approval';
          if (!prev || (isLive && !prevLive) || (!prevLive && new Date(meta.created_at || 0) > new Date(prev.meta?.created_at || 0))) {
            runsByWorktree.set(meta.worktree, { id, meta });
          }
        }
      } catch {}
    }
  }

  const entries = [];
  for (const entry of readdirSync(root)) {
    const p = path.join(root, entry);
    let stat;
    try { stat = statSync(p); } catch { continue; }
    if (!stat.isDirectory()) continue;

    if (existsSync(path.join(p, '.git'))) {
      entries.push({ dir: p, project: entry, name: entry, stat });
    } else {
      for (const sub of readdirSync(p)) {
        const subPath = path.join(p, sub);
        try {
          const subStat = statSync(subPath);
          if (subStat.isDirectory()) {
            entries.push({ dir: subPath, project: entry, name: sub, stat: subStat });
          }
        } catch {}
      }
    }
  }

  const result = [];
  for (const item of entries) {
    const git = makeGit(item.dir);
    let branch = null;
    try {
      branch = git(['branch', '--show-current'], item.dir, { allowFail: true }).trim() || null;
    } catch {}

    const runInfo = runsByWorktree.get(item.dir);
    const meta = runInfo?.meta;
    if (!branch && meta?.branch) branch = meta.branch;
    if (!branch) branch = `fs-harness/${item.name}`;

    // Классификация статуса:
    // run-alive: живой ран (running / pending_approval)
    // task: ветка не fs-harness/* (task-worktree под задачу)
    // run-done: завершённый ран (done / failed / expired)
    // orphan: сирота (рана в журнале нет)
    let status = 'orphan';
    if (meta?.state === 'running' || meta?.state === 'pending_approval') {
      status = 'run-alive';
    } else if (branch && !branch.startsWith('fs-harness/')) {
      status = 'task';
    } else if (meta && ['done', 'failed', 'expired'].includes(meta.state)) {
      status = 'run-done';
    } else {
      status = 'orphan';
    }

    let action = 'unknown';
    let key = item.name;
    if (meta?.action) {
      action = meta.action;
      key = meta.key || meta.issue || meta.mr ? String(meta.key || meta.issue || meta.mr) : item.name;
    } else if (item.name.startsWith('ci-fix-')) {
      action = 'ci-fix';
      const rest = item.name.slice(7);
      const lastDash = rest.lastIndexOf('-');
      key = lastDash > 0 ? rest.slice(0, lastDash) : rest;
    } else {
      const parts = item.name.split('-');
      if (parts.length >= 3) {
        action = parts[0];
        key = parts.slice(1, -1).join('-');
      }
    }

    let createdMs = item.stat.birthtimeMs || item.stat.mtimeMs;
    if (meta?.created_at) {
      const t = new Date(meta.created_at).getTime();
      if (!Number.isNaN(t)) createdMs = t;
    }
    const age_days = Math.max(0, Math.floor((now - createdMs) / (24 * 3600 * 1000)));

    let size_mb;
    if (sizes) {
      try {
        const out = execFileSync('du', ['-sk', item.dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        const kb = parseInt(out.split(/\s+/)[0], 10);
        if (!Number.isNaN(kb)) size_mb = Math.round(kb / 1024);
      } catch {
        size_mb = null;
      }
    }

    result.push({
      dir: item.dir,
      project: item.project,
      branch,
      action,
      key,
      age_days,
      ...(sizes ? { size_mb } : {}),
      status,
    });
  }

  return result.sort((a, b) => b.age_days - a.age_days);
}

// Определение корневого репозитория по worktree каталогу
export function resolveProjectDir(dir, projectDirs = []) {
  if (projectDirs.length) {
    const byBase = projectDirs.find((p) => path.basename(dir).includes(path.basename(p)) || dir.includes(path.basename(p)));
    if (byBase) return byBase;
  }
  const gitFile = path.join(dir, '.git');
  if (existsSync(gitFile)) {
    try {
      const content = readFileSync(gitFile, 'utf8').trim();
      const match = content.match(/^gitdir:\s*(.+)$/m);
      if (match) {
        let gitDir = match[1].trim();
        if (!path.isAbsolute(gitDir)) gitDir = path.resolve(dir, gitDir);
        const commonDir = path.resolve(gitDir, '..', '..');
        return path.dirname(commonDir);
      }
    } catch {}
  }
  return projectDirs[0] || null;
}

// Очистка старых worktree: orphan и run-done старше olderThanDays,
// а также закрытые/смёрдженные task-worktree.
export async function gcWorktrees({
  root = WORKTREE_ROOT,
  runsRoot = RUNS_DIR,
  projectDirs = [],
  olderThanDays = 7,
  dryRun = false,
  g = null,
  repo = null,
  say = () => {},
  now = Date.now(),
} = {}) {
  const all = listWorktrees({ root, runsRoot, projectDirs, now, sizes: false });
  const candidates = [];

  for (const wt of all) {
    if (wt.status === 'run-alive') continue;

    if (wt.status === 'orphan' || wt.status === 'run-done') {
      if (wt.age_days >= olderThanDays) {
        candidates.push({ ...wt, reason: `${wt.status} старше ${olderThanDays} дн (${wt.age_days} дн)` });
      }
    } else if (wt.status === 'task') {
      let shouldDelete = false;
      if (g && typeof g.listOpenMRs === 'function') {
        try {
          const targetRepo = repo || wt.project;
          const openMRs = await g.listOpenMRs(targetRepo, { source_branch: wt.branch });
          if (Array.isArray(openMRs) && openMRs.length === 0) {
            shouldDelete = true;
          }
        } catch {}
      } else if (olderThanDays > 0 && wt.age_days >= olderThanDays) {
        shouldDelete = true;
      }
      if (shouldDelete) {
        candidates.push({ ...wt, reason: 'task: MR закрыт или смёрджен' });
      }
    }
  }

  if (dryRun) {
    return candidates;
  }

  const deleted = [];
  for (const wt of candidates) {
    const projDir = resolveProjectDir(wt.dir, projectDirs);
    try {
      removeWorktree(projDir || wt.dir, wt.dir, wt.branch, say);
      deleted.push(wt);
    } catch (err) {
      say(`⚠ Не удалось удалить worktree ${wt.dir}: ${err.message}`);
    }
  }
  return deleted;
}
