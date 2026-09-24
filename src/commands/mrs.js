import { commentStats, fmtMRRow } from '../format.js';
import { mapLimit } from '../pipeline.js';

// Свежий MR-пайплайн для каждого iid: {iid: {id, status, sha}}.
// Пайплайны приходят по id desc — первое совпадение ref и есть последний.
export function mrPipelineMap(pipelines) {
  const map = {};
  for (const p of pipelines) {
    const m = /^refs\/merge-requests\/(\d+)\/head$/.exec(p.ref || '');
    if (m && !map[m[1]]) map[m[1]] = { id: p.id, status: p.status, sha: p.sha };
  }
  return map;
}

const FILTER_KEYS = ['author', 'assignee', 'reviewer', 'target', 'label', 'search', 'draft', 'conflicts', 'threads', 'pipeline'];

// Команде прилетает весь объект флагов, поэтому «фильтры заданы?» считаем по своим ключам.
export const anyFilter = (f = {}) => FILTER_KEYS.some((k) => f[k] !== null && f[k] !== undefined && f[k] !== false && f[k] !== '');

// Фильтры: часть уходит в API, часть считается по уже полученным данным
// (конфликт, статус пайплайна и открытые треды в списке MR не приходят).
export async function buildMRParams(g, { author, assignee, reviewer, target, label, search, draft } = {}) {
  const who = async (v) => (v === 'me' ? (await g.me())?.username : v);
  return {
    author_username: await who(author),
    assignee_username: await who(assignee),
    reviewer_username: await who(reviewer),
    target_branch: target,
    labels: label,
    search,
    wip: draft === true ? 'yes' : draft === false ? 'no' : null,
  };
}

// Клиентские фильтры: их нет в API списка MR, зато данные уже под рукой.
export function applyLocalFilters(rows, { conflicts, pipeline, threads } = {}) {
  return rows.filter(({ mr, stats }) => {
    if (conflicts && !mr.has_conflicts) return false;
    if (threads && !(stats.open > 0)) return false;
    if (pipeline && (mr.head_pipeline?.status ?? 'none') !== pipeline) return false;
    return true;
  });
}

// asObject — вернуть данные без печати (MCP-режим).
export async function cmdMRS(g, repo, { json, asObject, ...filters } = {}) {
  const mrs = await g.listOpenMRs(repo, await buildMRParams(g, filters));
  if (!mrs.length) {
    const result = { ok: true, mrs: [] };
    if (asObject) return result;
    console.log(anyFilter(filters) ? 'Под фильтры не попал ни один MR.' : `В ${repo} нет открытых MR.`);
    return result;
  }

  const pipes = mrPipelineMap(await g.listMRPipelines(repo));

  const all = await mapLimit(mrs, 6, async (mr) => {
    mr.head_pipeline = pipes[mr.iid] || null;
    let discussions = null;
    if (mr.user_notes_count === 0) {
      discussions = [];
    } else {
      try {
        discussions = await g.getDiscussions(repo, mr.iid);
      } catch {
        // API тредов недоступен — покажем только общее число комментов.
      }
    }
    let approved = null;
    try {
      const a = await g.getApprovals(repo, mr.iid);
      approved = Boolean(a?.approved ?? a?.approved_by?.length);
    } catch {
      // approvals бывают выключены на проекте — тогда просто не показываем бейдж
    }
    return { mr, approved, stats: commentStats(discussions, mr.user_notes_count) };
  });

  const rows = applyLocalFilters(all, filters);
  const result = { ok: true, mrs: rows.map(toJSON) };
  if (asObject) return result;

  if (json) {
    console.log(JSON.stringify(result.mrs, null, 2));
    return result;
  }

  const width = Math.min(process.stdout.columns || 160, 200);
  for (const { mr, stats } of rows) console.log(fmtMRRow(mr, stats, width));
  if (!rows.length) console.log('Под фильтры не попал ни один MR.');
  return result;
}

export function toJSON({ mr, stats, approved = null }) {
  return {
    iid: mr.iid,
    title: mr.title,
    draft: Boolean(mr.draft),
    author: mr.author?.name ?? null,
    author_username: mr.author?.username ?? null,
    assignees: (mr.assignees ?? []).map((u) => ({ name: u.name, username: u.username })),
    reviewers: (mr.reviewers ?? []).map((u) => ({ name: u.name, username: u.username })),
    labels: mr.labels ?? [],
    approved,
    created_at: mr.created_at,
    sha: mr.sha ?? null,
    source_branch: mr.source_branch,
    target_branch: mr.target_branch,
    has_conflicts: mr.has_conflicts,
    pipeline: mr.head_pipeline ? { id: mr.head_pipeline.id, status: mr.head_pipeline.status } : null,
    pipeline_stale: Boolean(mr.head_pipeline?.sha && mr.sha && mr.head_pipeline.sha !== mr.sha),
    comments: stats,
    updated_at: mr.updated_at,
    web_url: mr.web_url,
  };
}
