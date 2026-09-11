import { resolveMR } from '../resolve.js';
import { ensureMRPipeline, findJob, startJob, jobAction } from '../pipeline.js';
import { CliError } from '../errors.js';
import { waitJob } from '../ui.js';
import { makeLogger, finish, jobJSON } from '../output.js';

// fsh run <джоба> <mr|ветка> [--watch] [--dry-run]
export async function cmdRun(g, repo, args, { json, watch, dryRun = false, asObject, quiet = false, onTick } = {}) {
  const [jobQuery, mrQuery] = args;
  if (!jobQuery || !mrQuery) throw new CliError('Использование: fsh run <джоба|id> <mr|ветка> [--watch]', 1, 'usage');

  const log = asObject ? () => {} : makeLogger(json);
  const mr = await resolveMR(g, repo, mrQuery);
  const jobName = jobQuery;

  if (dryRun) {
    const pipeline = mr.head_pipeline && (!mr.head_pipeline.sha || mr.head_pipeline.sha === mr.sha)
      ? mr.head_pipeline
      : null;
    const jobs = pipeline ? await g.getJobs(repo, pipeline.id) : [];
    const job = findJob(jobs, jobName);
    const plan = job ? jobAction(job.status) : null;
    const result = {
      ok: true,
      dry_run: true,
      mr: mr.iid,
      pipeline: pipeline ? { id: pipeline.id, status: pipeline.status } : null,
      pipeline_will_be_created: !pipeline,
      job: job ? { ...jobJSON(job), plan } : { not_found: jobName },
    };
    if (asObject) return result;
    if (json) {
      finish(true, result);
    } else {
      log(`🔍 План (dry-run), MR !${mr.iid} ${mr.source_branch} → ${mr.target_branch}`);
      log(`   пайплайн: ${pipeline ? `#${pipeline.id} (${pipeline.status})` : 'будет создан новый MR-пайплайн'}`);
      if (!job) {
        log(`   джоба "${jobName}" не найдена${pipeline ? ` (доступные: ${jobs.map((j) => j.name).join(', ')})` : ''}`);
      } else {
        log(`   джоба: ${job.name} (#${job.id}, ${job.status}) → ${describePlan(plan)}`);
      }
    }
    return result;
  }

  const pipeline = await ensureMRPipeline(g, repo, mr);
  const jobs = await g.getJobs(repo, pipeline.id);
  const job = findJob(jobs, jobName);
  if (!job) {
    throw new CliError(`Джоба "${jobName}" не найдена в пайплайне #${pipeline.id}.\nДоступные: ${jobs.map((j) => j.name).join(', ')}`, 1, 'job_not_found');
  }

  if (job.status === 'manual' || job.status === 'failed' || job.status === 'canceled') {
    const started = await startJob(g, repo, job);
    log(`▶ ${job.name}: ${job.status} → ${started.status} (#${started.id})`);
    if (watch) {
      const final = await waitJob({ g, repo, pipelineId: pipeline.id, jobId: started.id, label: job.name, quiet, onTick });
      const result = { ok: true, pipeline: { id: pipeline.id }, job: jobJSON(final) };
      if (final.status !== 'success') {
        throw new CliError(`Джоба ${final.name} завершилась: ${final.status}`, 1, 'job_failed');
      }
      log(`✅ ${final.name} успешно завершена (${final.web_url})`);
      if (!asObject) finish(json, result);
      return result;
    }
    const result = { ok: true, pipeline: { id: pipeline.id }, job: jobJSON({ ...job, id: started.id, status: started.status }) };
    if (!asObject) finish(json, result);
    return result;
  }

  const result = { ok: true, pipeline: { id: pipeline.id }, job: jobJSON(job), skipped: true };
  log(`ℹ ${job.name} (#${job.id}): ${job.status} — запуск не требуется.`);
  if (!asObject) finish(json, result);
  return result;
}

function describePlan(plan) {
  if (!plan) return 'не найдена';
  if (plan.action === 'play') return 'play';
  if (plan.action === 'retry') return `retry (была ${plan.reason})`;
  return `ничего (${plan.reason})`;
}
