import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { expandHome } from '../config.js';
import { ensureMRPipeline, findJob, startJob } from '../pipeline.js';
import { waitJob } from '../ui.js';
import { jobJSON } from '../output.js';
import { ACCEPTANCE_PATHSPECS, truncate } from '../judge/payload.js';
import { runChecks, checksFact } from '../checks.js';
import { WORKTREE_ROOT } from '../workspace.js';
import { CliError } from '../errors.js';

export const ATTEMPTS_ROOT = path.join(homedir(), '.local', 'state', 'fs-harness', 'ci-fix');

export const attemptsFile = (repo, root = ATTEMPTS_ROOT) => path.join(root, `${repo.replace(/\//g, '%2F')}.json`);

export function readAttempts(file) {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {}; // битый файл равен пустому: хуже потерять счётчик, чем упасть на нём
  }
}

export function writeAttempts(file, state) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 2));
}

export const attemptKey = (iid, jobNames) => `${iid}:${[...jobNames].sort().join(',')}`;

// Пускать ли ещё одну попытку. Ключ — (MR, джобы), а sha лежит внутри записи:
// свой же push рождает новый sha, и если считать по (MR, джоба, sha), счётчик
// обнулялся бы каждый раз, а стабильно красный тест чинился бы вечно.
// Тот же sha второй раз — значит прошлая попытка ничего не сдвинула: стоп сразу.
export function attemptGate(state, key, sha, maxRetries) {
  const rec = state[key];
  if (!rec) return { allow: true, attempts: 0 };
  if ((rec.shas ?? []).includes(sha)) {
    return { allow: false, attempts: rec.attempts, reason: `коммит ${String(sha).slice(0, 8)} уже чинили, а джобы снова красные` };
  }
  if (rec.attempts >= maxRetries) {
    return { allow: false, attempts: rec.attempts, reason: `исчерпан лимит попыток (${rec.attempts} из ${maxRetries})` };
  }
  return { allow: true, attempts: rec.attempts };
}

export function recordAttempt(state, key, sha) {
  const rec = state[key] ?? { attempts: 0, shas: [] };
  return { ...state, [key]: { attempts: rec.attempts + 1, shas: [...rec.shas, sha], at: new Date().toISOString() } };
}

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const SECTION = /^section_(start|end):\d+:/;
const ERROR_LINE = /(error|failed|failing|✖|✘|✗|×|\bFAIL\b)/i;

// Выжимка из лога джобы. Лог бывает в мегабайты, в промпт и судье уходит хвост
// плюс строки с ошибками: по ним агент понимает, что именно упало.
export function summarizeTrace(trace, { tailLines = 120, maxErrors = 40 } = {}) {
  const lines = String(trace ?? '')
    .replace(/\r/g, '\n')
    .replace(ANSI, '')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l && !SECTION.test(l));
  return {
    lines: lines.length,
    errors: lines.filter((l) => ERROR_LINE.test(l)).slice(-maxErrors).join('\n'),
    tail: lines.slice(-tailLines).join('\n'),
  };
}

// Дифф ветки против target: три точки, то есть только то, что наделала сама ветка.
// Обрезается с явной пометкой — за полным агент сходит сам, worktree у него под рукой.
const BRANCH_DIFF_LINES = 800;
function branchDiff(ws, targetBranch) {
  const diff = ws.git(['diff', `origin/${targetBranch}...HEAD`], ws.dir, { allowFail: true });
  return diff ? truncate(diff, BRANCH_DIFF_LINES) : `(ветка не расходится с ${targetBranch} либо дифф посчитать не удалось)`;
}

const jobBlock = (j) => [`### ${j.name} (stage ${j.stage}, джоба #${j.id})`, j.url, '', j.errors ? `Строки с ошибками:\n${j.errors}\n` : '', `Хвост лога:\n${j.tail}`].filter(Boolean).join('\n');

export const ciFixAction = {
  name: 'ci-fix',
  kind: 'action',
  usage: 'ci-fix <mr|ветка>',
  description: 'Починить упавшие джобы пайплайна силами AI-агента и перезапустить их',
  example: 'fsh ci-fix !2547',
  action: {
    title: 'Починить упавший пайплайн',
    target: 'mr',
    writes: true,
    isolation: 'ephemeral-worktree',
    prompt: 'actions/ci-fix',
    agent: { default: 'cc', pickByJudge: false },
    judge: { gate: 'pre-push', role: 'ci-acceptance' },
    mcpDescription: 'Починить упавшие джобы пайплайна MR силами AI-агента (headless) во временном git worktree, отдать результат судье и при approve запушить фикс и перезапустить джобы. Ждёт завершения. Меняет код и GitLab. Работает только на своих MR; число попыток на MR ограничено.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'номер MR или часть имени ветки' },
        agent: { type: 'string', description: 'какой агент чинит (имя профиля из конфига: cc, ccq, cco, ccd, agy)' },
      },
      required: ['query'],
    },

    async precheck({ ctx, opts, target: mr, say }) {
      const projectDir = expandHome(opts.projectDir);
      if (!projectDir) {
        throw new CliError('Каталог проекта не настроен (projectDir пуст). Выполни fsh config init или передай --project-dir <путь к локальному репо>.', 1, 'config_invalid');
      }
      if (!existsSync(path.join(projectDir, '.git'))) {
        throw new CliError(`Каталог проекта ${projectDir} не является git-репозиторием. Укажи --project-dir.`, 1, 'config_invalid');
      }
      // Только свои MR: чужую ветку не чиним, даже если она красная.
      const me = await ctx.g.me();
      if (me?.username && mr.author?.username && me.username !== mr.author.username) {
        throw new CliError(`MR !${mr.iid} принадлежит ${mr.author.username}, а не тебе (${me.username}). Чужие ветки ci-fix не трогает.`, 1, 'not_author');
      }

      const skipped = (reason, extra = {}) => {
        say(`✅ ${reason}`);
        return { projectDir, skip: true, reason, result: { ok: true, mr: mr.iid, skipped: true, reason, ...extra } };
      };

      const pipeline = mr.head_pipeline;
      if (!pipeline) return skipped(`У MR !${mr.iid} нет пайплайна — чинить нечего.`);
      const jobs = await ctx.g.getJobs(ctx.repo, pipeline.id);
      const failed = jobs.filter((j) => j.status === 'failed' && !j.allow_failure);
      if (!failed.length) return skipped(`В пайплайне #${pipeline.id} нет упавших джоб (статус ${pipeline.status}).`);

      // Устаревший пайплайн чинить нечего: он про прошлый коммит, а worktree будет от нового.
      if (pipeline.sha && mr.sha && pipeline.sha !== mr.sha) {
        return skipped(`Пайплайн #${pipeline.id} устарел (${pipeline.sha.slice(0, 8)} против ${mr.sha.slice(0, 8)}) — его падение уже не про текущий код ветки.`);
      }

      const sha = pipeline.sha ?? mr.sha ?? '';
      const key = attemptKey(mr.iid, failed.map((j) => j.name));
      const file = opts.attemptsFile ?? attemptsFile(ctx.repo);
      const maxRetries = opts.cfg?.ci?.maxRetries ?? 2;
      const gate = attemptGate(readAttempts(file), key, sha, maxRetries);
      if (!gate.allow) {
        // Путь к счётчику — часть сообщения: иначе человеку, который сам прервал ран,
        // нечем объяснить отказ и негде его снять.
        return skipped(
          `MR !${mr.iid}: ${gate.reason}. Дальше — руками: ${pipeline.web_url}\n   Счётчик попыток: ${file}`,
          { hand_to_human: true, attempts: gate.attempts, failed_jobs: failed.map((j) => j.name) },
        );
      }

      const traces = [];
      for (const j of failed) {
        const trace = await ctx.g.getJobTrace(ctx.repo, j.id);
        traces.push({ id: j.id, name: j.name, stage: j.stage, url: j.web_url, ...summarizeTrace(trace) });
      }

      return {
        projectDir,
        pipeline,
        sha,
        failed: traces,
        attempts: { file, key, sha, max: maxRetries, done: gate.attempts },
        // target тоже фетчим: без него не посчитать дифф ветки для промпта.
        workspace: { project: projectDir, ref: mr.source_branch, baseRef: mr.target_branch, key: String(mr.iid), refs: [mr.source_branch, mr.target_branch] },
        meta: {
          repo: ctx.repo,
          mr: mr.iid,
          source_branch: mr.source_branch,
          pipeline: pipeline.id,
          pipeline_sha: sha,
          failed_jobs: traces.map((t) => t.name),
          attempt: gate.attempts + 1,
          project_dir: projectDir,
        },
      };
    },

    dryRun({ opts, target: mr, pre }) {
      return {
        ok: true,
        dry_run: true,
        mr: mr.iid,
        source_branch: mr.source_branch,
        pipeline: pre.pipeline?.id ?? null,
        failed_jobs: (pre.failed ?? []).map((j) => j.name),
        attempt: `${(pre.attempts?.done ?? 0) + 1} из ${pre.attempts?.max ?? 0}`,
        agent: opts.agent,
        project_dir: pre.projectDir,
        worktree_root: path.join(WORKTREE_ROOT, path.basename(pre.projectDir)),
        steps: [
          `worktree add --detach ${path.join(WORKTREE_ROOT, path.basename(pre.projectDir), `ci-fix-${mr.iid}-<ts>`)} origin/${mr.source_branch}`,
          `агент ${opts.agent}: разобрать логи упавших джоб, починить причину, прогнать проверки, закоммитить`,
          opts.noJudge
            ? 'судья отключён (--no-judge)'
            : `судья (роль ci-acceptance, профиль ${opts.judgeProfile ?? (opts.cfg?.judge?.roles?.['ci-acceptance'] ?? []).join(' → ')}): approve или push не произойдёт`,
          `push origin HEAD:${mr.source_branch}`,
          `перезапуск джоб (${(pre.failed ?? []).map((j) => j.name).join(', ')}) + ожидание`,
          'удаление временного worktree',
        ],
      };
    },

    context({ ctx, opts, target: mr, pre, ws, run, say }) {
      // Зависимостей нет — проверок не будет, и судья одобрит фикс, не увидев ни одной.
      // Для ci-fix это бессмысленно: причина падения как раз в том, что проверки красные.
      if (!ws.deps.available) {
        throw new CliError(
          `В worktree ${ws.dir} нет зависимостей (${ws.deps.reason ?? ws.deps.strategy}), значит проверки прогнать нечем, а судить фикс CI без них нельзя.\n` +
          'Поставь workspace.deps.strategy: "install" в конфиге (или почини node_modules в основном чекауте).',
          1,
          'deps_unavailable',
        );
      }
      // Попытку засчитываем здесь: precheck зовётся и на --dry-run, а тут уже точно поехали.
      writeAttempts(pre.attempts.file, recordAttempt(readAttempts(pre.attempts.file), pre.attempts.key, pre.attempts.sha));

      say(`🌿 MR !${mr.iid}: ${mr.source_branch} → ${mr.target_branch}, пайплайн #${pre.pipeline.id}`);
      say(`   Упало джоб: ${pre.failed.length} (${pre.failed.map((j) => j.name).join(', ')})`);
      say(`   Попытка ${pre.attempts.done + 1} из ${pre.attempts.max} · агент: ${opts.agent} · worktree: ${ws.dir}`);
      say(`   Ран: ${run.id}`);
      return {
        repo: ctx.repo,
        mr_iid: mr.iid,
        mr_title: mr.title,
        mr_url: mr.web_url,
        source_branch: mr.source_branch,
        target_branch: mr.target_branch,
        pipeline_id: pre.pipeline.id,
        pipeline_url: pre.pipeline.web_url,
        failed_count: pre.failed.length,
        failed_jobs: pre.failed.map((j) => `  ${j.name} (stage ${j.stage}, #${j.id})`).join('\n'),
        job_logs: pre.failed.map(jobBlock).join('\n\n'),
        branch_diff: branchDiff(ws, mr.target_branch),
        checks: (opts.cfg?.checks ?? []).map((c) => `  ${c}`).join('\n') || '  (в конфиге проекта проверок нет)',
        worktree: ws.dir,
      };
    },

    goal: ({ target: mr, pre }) =>
      `Починить упавшие джобы пайплайна #${pre.pipeline.id} в MR !${mr.iid} «${mr.title}» (ветка ${mr.source_branch}). ` +
      `Упали: ${pre.failed.map((j) => j.name).join(', ')}. ` +
      'Чинить нужно причину падения в коде ветки, а не отключать проверку, тест или правило линтера.',

    // Материал судье: что именно упало и что было в логах до фикса.
    judgeExtra: ({ pre }) =>
      ['Упавшие джобы и их логи (до фикса):', '', ...pre.failed.map((j) => truncate(jobBlock(j), 60))].join('\n'),

    verify({ ws, pre, opts, say }) {
      const { git, dir, base } = ws;
      const commitsAhead = Number(git(['rev-list', '--count', `${base}..HEAD`], dir));
      if (commitsAhead === 0) {
        throw new CliError(`Агент не создал коммитов в worktree (${dir}) — чинить пайплайн нечем. Проверь вручную: git -C ${dir} status.`, 1, 'agent_failed');
      }
      return {
        commits_ahead: commitsAhead,
        deps_available: ws.deps.available,
        head_sha: git(['rev-parse', 'HEAD'], dir),
        changed_files: git(['diff', '--name-only', `${base}..HEAD`], dir).split('\n').filter(Boolean),
        failed_jobs: pre.failed.map((j) => j.name),
        attempt: `${pre.attempts.done + 1} из ${pre.attempts.max}`,
        diff: git(['diff', `${base}..HEAD`, '--', ...ACCEPTANCE_PATHSPECS], dir),
        diff_title: 'Дифф фикса (base..HEAD)',
        checks: checksFact(opts.cfg?.checks ?? [], ws.deps.available) ?? runChecks(opts.cfg.checks, dir, { say }),
      };
    },

    async publish({ ctx, opts, target: mr, pre, ws, facts, say }) {
      const { g, repo } = ctx;
      say(`⬆ Пушу фикс в ${mr.source_branch}…`);
      ws.git(['push', 'origin', `HEAD:${mr.source_branch}`], ws.dir);
      const remoteSha = ws.git(['ls-remote', 'origin', `refs/heads/${mr.source_branch}`]).split(/\s+/)[0] || '';
      if (remoteSha !== facts.head_sha) {
        throw new CliError(`Push прошёл, но origin на ${remoteSha.slice(0, 8)} вместо ${facts.head_sha.slice(0, 8)}. Кто-то запушил параллельно.`, 1, 'not_pushed');
      }
      say(`✅ Запушено в ${mr.source_branch} (${facts.head_sha.slice(0, 8)}).`);

      const freshMR = await g.getMR(repo, mr.iid);
      const pipeline = await ensureMRPipeline(g, repo, freshMR);
      const jobs = await g.getJobs(repo, pipeline.id);
      const results = [];
      for (const name of pre.failed.map((j) => j.name)) {
        const job = findJob(jobs, name);
        if (!job) {
          say(`⚠ Джоба "${name}" в пайплайне #${pipeline.id} не нашлась — пропускаю.`);
          continue;
        }
        const started = await startJob(g, repo, job);
        say(`▶ ${name} (#${(started ?? job).id}) в пайплайне #${pipeline.id}${started ? `: ${job.status} → ${started.status}` : ''}`);
        const final = await waitJob({
          g, repo, pipelineId: pipeline.id, jobId: (started ?? job).id,
          label: name, quiet: opts.quiet, onTick: opts.onTick,
          onManual: (j) => startJob(g, repo, j),
          ...(opts.intervalMs ? { intervalMs: opts.intervalMs } : {}),
        });
        results.push(jobJSON(final, final.status));
      }
      const red = results.filter((r) => r.status !== 'success');
      if (red.length) {
        throw new CliError(
          `Фикс запушен, но джобы снова не зелёные: ${red.map((r) => `${r.name} (${r.status})`).join(', ')}.\nДетали: ${pipeline.web_url}`,
          1,
          'ci_still_failing',
        );
      }
      return {
        pipeline: { id: pipeline.id, status: pipeline.status, web_url: pipeline.web_url },
        jobs: results,
      };
    },

    renderPlan(plan, log) {
      log(`🔍 План починки CI (dry-run), MR !${plan.mr} (${plan.source_branch})`);
      log(`   пайплайн: ${plan.pipeline ?? 'нет'} · упало джоб: ${plan.failed_jobs.length}`);
      plan.failed_jobs.forEach((j) => log(`     ${j}`));
      log(`   попытка: ${plan.attempt}`);
      log(`   worktree: ${plan.worktree_root}/ci-fix-${plan.mr}-<ts>`);
      log(`   агент: ${plan.agent} (headless)`);
      plan.steps.forEach((s, i) => log(`   ${i + 1}. ${s}`));
    },

    result({ target: mr, run, pre, facts, verdict, published, say }) {
      say(`✅ Пайплайн MR !${mr.iid} починен, джобы зелёные.`);
      return {
        ok: true,
        run: run.id,
        mr: mr.iid,
        head_sha: facts.head_sha,
        commits_ahead: facts.commits_ahead,
        failed_jobs: pre.failed.map((j) => j.name),
        attempt: pre.attempts.done + 1,
        judge: verdict
          ? { decision: verdict.decision, confidence: verdict.confidence, summary: verdict.summary, profile: verdict.meta.profile, cost: verdict.meta.cost }
          : { skipped: true },
        ...published,
      };
    },
  },
};
