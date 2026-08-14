import { resolveMR } from '../resolve.js';
import { ensureMRPipeline, findJob, startJob } from '../pipeline.js';
import { CliError } from '../errors.js';
import { waitJob } from '../ui.js';

// gl-helper run <джоба> <mr|ветка> [--watch]
export async function cmdRun(g, repo, args, { json, watch } = {}) {
  const [jobQuery, mrQuery] = args;
  if (!jobQuery || !mrQuery) throw new CliError('Использование: gl-helper run <джоба|id> <mr|ветка> [--watch]');

  const mr = await resolveMR(g, repo, mrQuery);
  const pipeline = await ensureMRPipeline(g, repo, mr);
  const jobs = await g.getJobs(repo, pipeline.id);
  const job = findJob(jobs, jobQuery);
  if (!job) {
    throw new CliError(`Джоба "${jobQuery}" не найдена в пайплайне #${pipeline.id}.\nДоступные: ${jobs.map((j) => j.name).join(', ')}`);
  }

  if (json) {
    console.log(JSON.stringify({ pipeline: pipeline.id, job: { id: job.id, name: job.name, status: job.status } }, null, 2));
  }

  if (job.status === 'manual' || job.status === 'failed' || job.status === 'canceled') {
    const started = await startJob(g, repo, job);
    console.log(`▶ ${job.name}: ${job.status} → ${started.status} (#${started.id})`);
    if (watch) {
      const final = await waitJob({ g, repo, pipelineId: pipeline.id, jobId: started.id, label: job.name });
      if (final.status !== 'success') {
        throw new CliError(`Джоба ${final.name} завершилась: ${final.status}`, final.status === 'failed' ? 1 : 0);
      }
      console.log(`✅ ${final.name} успешно завершена (${final.web_url})`);
    }
  } else {
    console.log(`ℹ ${job.name} (#${job.id}): ${job.status} — запуск не требуется.`);
  }
}
