import { resolveMR } from '../resolve.js';
import { commentStats, fmtMR } from '../format.js';
import { toJSON } from './mrs.js';

export async function cmdMR(g, repo, query, { json, asObject } = {}) {
  const mr = await resolveMR(g, repo, query);
  let discussions = null;
  try {
    discussions = await g.getDiscussions(repo, mr.iid);
  } catch {
    // Без тредов покажем только общее число.
  }
  const stats = commentStats(discussions, mr.user_notes_count);

  const result = { ok: true, ...toJSON({ mr, stats }) };
  if (asObject) return result;

  if (json) {
    // CLI --json: прежний формат (объект MR без обёртки ok)
    console.log(JSON.stringify(toJSON({ mr, stats }), null, 2));
    return result;
  }

  const stale = Boolean(mr.head_pipeline && mr.head_pipeline.sha && mr.head_pipeline.sha !== mr.sha);
  console.log(fmtMR(mr, stats, { stale }));
  return result;
}
