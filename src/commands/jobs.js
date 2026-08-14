import { resolveMR } from '../resolve.js';
import { statusIcon, table } from '../format.js';
import { ensureMRPipeline } from '../pipeline.js';

export async function cmdJobs(g, repo, query, { json } = {}) {
  const mr = await resolveMR(g, repo, query);
  const pipeline = await ensureMRPipeline(g, repo, mr);
  const jobs = await g.getJobs(repo, pipeline.id);

  if (json) {
    console.log(JSON.stringify({
      pipeline: { id: pipeline.id, status: pipeline.status, web_url: pipeline.web_url },
      jobs: jobs.map((j) => ({ id: j.id, name: j.name, stage: j.stage, status: j.status, web_url: j.web_url })),
    }, null, 2));
    return;
  }

  console.log(`Пайплайн #${pipeline.id} (MR !${mr.iid}): ${statusIcon(pipeline.status)} ${pipeline.status}`);
  if (!jobs.length) {
    console.log('Джоб нет.');
    return;
  }
  console.log(table([
    ['stage', 'job', 'status', 'id'],
    ...jobs.map((j) => [j.stage || '—', j.name, `${statusIcon(j.status)} ${j.status}`, `#${j.id}`]),
  ]));
}
