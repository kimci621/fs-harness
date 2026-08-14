import { resolveMR } from '../resolve.js';
import { commentStats, fmtMR } from '../format.js';
import { toJSON } from './mrs.js';

export async function cmdMR(g, repo, query, { json } = {}) {
  const mr = await resolveMR(g, repo, query);
  let discussions = null;
  try {
    discussions = await g.getDiscussions(repo, mr.iid);
  } catch {
    // Без тредов покажем только общее число.
  }
  const stats = commentStats(discussions, mr.user_notes_count);

  if (json) {
    console.log(JSON.stringify(toJSON({ mr, stats }), null, 2));
    return;
  }

  const stale = Boolean(mr.head_pipeline && mr.head_pipeline.sha && mr.head_pipeline.sha !== mr.sha);
  console.log(fmtMR(mr, stats, { stale }));
}
