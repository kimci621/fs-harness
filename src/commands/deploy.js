import { resolveMR } from '../resolve.js';
import { ensureMRPipeline, findJob, deployJobName } from '../pipeline.js';
import { CliError } from '../errors.js';
import { waitJob } from '../ui.js';

// gl-helper deploy <mr|ветка> [N]
// build → ждём success → deploy_dev[ N] → ждём итог.
export async function cmdDeploy(g, repo, args, { json, buildJob = 'build_image', intervalMs } = {}) {
  const [mrQuery, n] = args;
  if (!mrQuery) throw new CliError('Использование: gl-helper deploy <mr|ветка> [N]');

  const mr = await resolveMR(g, repo, mrQuery);
  const pipeline = await ensureMRPipeline(g, repo, mr);
  const deployName = deployJobName(n);
  const waitOpts = { g, repo, pipelineId: pipeline.id, ...(intervalMs ? { intervalMs } : {}) };

  if (json) console.log(JSON.stringify({ pipeline: pipeline.id, build_job: buildJob, deploy_job: deployName }, null, 2));

  // 1. build
  let jobs = await g.getJobs(repo, pipeline.id);
  let build = findJob(jobs, buildJob);
  if (!build) {
    throw new CliError(`Build-джоба "${buildJob}" не найдена в пайплайне #${pipeline.id}.\nДоступные: ${jobs.map((j) => j.name).join(', ')}`);
  }
  console.log(`▶ Сборка: ${build.name} (#${build.id})`);
  if (build.status === 'manual') {
    await g.playJob(repo, build.id);
  } else if (['success', 'failed', 'canceled', 'skipped'].includes(build.status)) {
    console.log(`ℹ ${build.name} уже в терминальном статусе: ${build.status}`);
  }
  const buildFinal = await waitJob({ ...waitOpts, jobId: build.id, label: build.name });
  if (buildFinal.status !== 'success') {
    throw new CliError(`Build ${buildFinal.status} — деплой не запускаю.\nДетали: ${buildFinal.web_url}`);
  }
  console.log(`✅ Сборка успешна.`);

  // 2. deploy_dev[ N]
  jobs = await g.getJobs(repo, pipeline.id);
  const deploy = findJob(jobs, deployName);
  if (!deploy) {
    const deployJobs = jobs.filter((j) => /^deploy_dev\d*$/.test(j.name)).map((j) => j.name);
    throw new CliError(
      `Джоба "${deployName}" не найдена в пайплайне #${pipeline.id}.\nДоступные deploy-джобы: ${deployJobs.join(', ') || 'нет'}`,
    );
  }
  console.log(`▶ Деплой: ${deploy.name} (#${deploy.id})`);
  if (deploy.status === 'manual') {
    await g.playJob(repo, deploy.id);
  }
  const deployFinal = await waitJob({ ...waitOpts, jobId: deploy.id, label: deploy.name });
  if (deployFinal.status !== 'success') {
    throw new CliError(`Деплой завершился: ${deployFinal.status}.\nДетали: ${deployFinal.web_url}`);
  }
  console.log(`✅ Деплой ${deploy.name} успешен (${deployFinal.web_url})`);
}
