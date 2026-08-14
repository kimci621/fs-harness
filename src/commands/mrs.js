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

export async function cmdMRS(g, repo, { json } = {}) {
  const mrs = await g.listOpenMRs(repo);
  if (!mrs.length) {
    console.log(`В ${repo} нет открытых MR.`);
    return;
  }

  const pipes = mrPipelineMap(await g.listMRPipelines(repo));

  const rows = await mapLimit(mrs, 6, async (mr) => {
    mr.head_pipeline = pipes[mr.iid] || null;
    let discussions = null;
    try {
      discussions = await g.getDiscussions(repo, mr.iid);
    } catch {
      // API тредов недоступен — покажем только общее число комментов.
    }
    return { mr, stats: commentStats(discussions, mr.user_notes_count) };
  });

  if (json) {
    console.log(JSON.stringify(rows.map(toJSON), null, 2));
    return;
  }

  const width = Math.min(process.stdout.columns || 160, 200);
  for (const { mr, stats } of rows) console.log(fmtMRRow(mr, stats, width));
}

export function toJSON({ mr, stats }) {
  return {
    iid: mr.iid,
    title: mr.title,
    draft: Boolean(mr.draft),
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
