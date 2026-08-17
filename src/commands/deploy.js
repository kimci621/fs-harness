import { resolveMR } from '../resolve.js';
import { ensureMRPipeline, findJob, deployJobName, startJob, jobAction } from '../pipeline.js';
import { CliError } from '../errors.js';
import { waitJob } from '../ui.js';
import { makeLogger, finish, jobJSON } from '../output.js';

// gl-helper deploy <mr|ветка> [N]
// build → ждём success → deploy_dev[ N] → ждём итог. --rebuild: перезапустить даже success.
// --dry-run: показать план без запусков.
export async function cmdDeploy(g, repo, args, { json, buildJob, intervalMs, rebuild = false, dryRun = false, asObject, quiet = false, onTick } = {}) {
  const [mrQuery, n] = args;
  if (!mrQuery) throw new CliError('Использование: gl-helper deploy <mr|ветка> [N]', 1, 'usage');

  const log = asObject ? () => {} : makeLogger(json);
  const jobName = buildJob || 'build_image';
  const mr = await resolveMR(g, repo, mrQuery);
  const deployName = deployJobName(n);
  const waitOpts = { g, repo, quiet, onTick, ...(intervalMs ? { intervalMs } : {}) };

  if (dryRun) {
    const pipeline = mr.head_pipeline && (!mr.head_pipeline.sha || mr.head_pipeline.sha === mr.sha)
      ? mr.head_pipeline
      : null;
    const jobs = pipeline ? await g.getJobs(repo, pipeline.id) : [];
    const build = findJob(jobs, jobName);
    const deploy = findJob(jobs, deployName);
    const buildPlan = build ? jobAction(build.status, { force: rebuild }) : null;
    const deployPlan = deploy ? jobAction(deploy.status, { force: rebuild }) : null;
    const result = {
      ok: true,
      dry_run: true,
      mr: mr.iid,
      pipeline: pipeline ? { id: pipeline.id, status: pipeline.status } : null,
      pipeline_will_be_created: !pipeline,
      build: build ? { ...jobJSON(build), plan: buildPlan } : { not_found: jobName },
      deploy: deploy ? { ...jobJSON(deploy), plan: deployPlan } : { not_found: deployName },
    };
    if (asObject) return result;
    if (json) {
      finish(true, result);
    } else {
      log(`🔍 План деплоя (dry-run), MR !${mr.iid} ${mr.source_branch} → ${mr.target_branch}`);
      log(`   пайплайн: ${pipeline ? `#${pipeline.id} (${pipeline.status})` : 'будет создан новый MR-пайплайн'}`);
      log(`   build: ${build ? `${build.name} (#${build.id}, ${build.status}) → ${describePlan(buildPlan)}` : `"${jobName}" не найдена`}`);
      log(`   deploy: ${deploy ? `${deploy.name} (#${deploy.id}, ${deploy.status}) → ${describePlan(deployPlan)}` : `"${deployName}" не найдена`}`);
    }
    return result;
  }

  const pipeline = await ensureMRPipeline(g, repo, mr);
  const waitFor = { ...waitOpts, pipelineId: pipeline.id };

  // 1. build
  let jobs = await g.getJobs(repo, pipeline.id);
  let build = findJob(jobs, jobName);
  if (!build) {
    throw new CliError(`Build-джоба "${jobName}" не найдена в пайплайне #${pipeline.id}.\nДоступные: ${jobs.map((j) => j.name).join(', ')}`, 1, 'job_not_found');
  }
  log(`▶ Сборка: ${build.name} (#${build.id})`);
  const started = await startJob(g, repo, build, { force: rebuild });
  const buildRun = started ?? { id: build.id };
  if (started) log(`   ${build.status} → ${started.status} (#${started.id})`);
  const buildFinal = await waitJob({ ...waitFor, jobId: buildRun.id, label: build.name });
  if (buildFinal.status !== 'success') {
    throw new CliError(`Build ${buildFinal.status} — деплой не запускаю.\nДетали: ${buildFinal.web_url}`, 1, 'build_failed');
  }
  log(`✅ Сборка успешна.`);

  // 2. deploy_dev[ N]
  jobs = await g.getJobs(repo, pipeline.id);
  const deploy = findJob(jobs, deployName);
  if (!deploy) {
    const deployJobs = jobs.filter((j) => /^deploy_dev\d*$/.test(j.name)).map((j) => j.name);
    throw new CliError(
      `Джоба "${deployName}" не найдена в пайплайне #${pipeline.id}.\nДоступные deploy-джобы: ${deployJobs.join(', ') || 'нет'}`,
      1,
      'job_not_found',
    );
  }
  log(`▶ Деплой: ${deploy.name} (#${deploy.id})`);
  const deployStarted = await startJob(g, repo, deploy, { force: rebuild });
  const deployRun = deployStarted ?? { id: deploy.id };
  if (deployStarted) log(`   ${deploy.status} → ${deployStarted.status} (#${deployStarted.id})`);
  const deployFinal = await waitJob({ ...waitFor, jobId: deployRun.id, label: deploy.name });
  if (deployFinal.status !== 'success') {
    throw new CliError(`Деплой завершился: ${deployFinal.status}.\nДетали: ${deployFinal.web_url}`, 1, 'deploy_failed');
  }
  log(`✅ Деплой ${deploy.name} успешен (${deployFinal.web_url})`);
  const result = {
    ok: true,
    mr: mr.iid,
    pipeline: { id: pipeline.id, status: pipeline.status, web_url: pipeline.web_url },
    build: jobJSON(buildFinal, 'success'),
    deploy: jobJSON(deployFinal, 'success'),
  };
  if (!asObject) finish(json, result);
  return result;
}

function describePlan(plan) {
  if (!plan) return 'не найдена';
  if (plan.action === 'play') return 'play';
  if (plan.action === 'retry') return plan.reason === 'force' ? 'retry (перезапуск, --rebuild)' : `retry (была ${plan.reason})`;
  return `ничего (${plan.reason})`;
}
