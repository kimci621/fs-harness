import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { expandHome } from '../config.js';
import { ensureMRPipeline, findJob, startJob } from '../pipeline.js';
import { waitJob } from '../ui.js';
import { jobJSON } from '../output.js';
import { ACCEPTANCE_PATHSPECS } from '../judge/payload.js';
import { makeGit } from '../engine.js';
import { CliError } from '../errors.js';

// Первая строка вывода merge-tree — OID результирующего дерева, а не имя файла.
// Не отбросить её — хэш уедет в промпт и агент пойдёт искать несуществующий файл.
export function parseMergeTree(stdout) {
  return String(stdout)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(1);
}

// Конфликт считаем сами, а не по полю GitLab: при has_conflicts: "unchecked" оно врёт
// «конфликтов нет». merge-tree отвечает точно и заодно даёт список файлов для промпта.
function conflictingFiles(projectDir, target, source) {
  try {
    execFileSync('git', ['merge-tree', '--write-tree', '--name-only', '--no-messages', target, source], {
      cwd: projectDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return []; // exit 0 — merge чистый
  } catch (err) {
    if (err.status === 1) return parseMergeTree(err.stdout); // exit 1 — конфликт, это ответ, а не ошибка
    throw new CliError(`git merge-tree не удался: ${String(err.stderr || err.message).trim()}`, 1, 'git_failed');
  }
}

export const conflictAction = {
  name: 'conflict',
  kind: 'action',
  usage: 'conflict <mr|ветка>',
  description: 'Решить конфликт силами AI-агента и запустить build',
  example: 'fsh conflict !2547 --agent pi',
  action: {
    title: 'Решить конфликт с target',
    target: 'mr',
    writes: true,
    isolation: 'ephemeral-worktree',
    prompt: 'actions/conflict',
    agent: { default: 'claude', allow: ['claude', 'pi'], pickByJudge: false },
    judge: { gate: 'pre-push', role: 'acceptance' },
    mcpDescription: 'Решить конфликт MR силами AI-агента (claude или pi, headless) во временном git worktree проекта, отдать результат судье и при approve запушить в ветку MR и запустить build. Ждёт завершения. Меняет код и GitLab; ветка target не трогается, force-push запрещён.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'номер MR или часть имени ветки' },
        agent: { type: 'string', enum: ['claude', 'pi'], description: 'какой агент решает конфликт' },
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
      const git = makeGit(projectDir);
      git(['fetch', 'origin', `${mr.source_branch}:refs/remotes/origin/${mr.source_branch}`, `${mr.target_branch}:refs/remotes/origin/${mr.target_branch}`]);
      const conflictFiles = conflictingFiles(projectDir, `origin/${mr.target_branch}`, `origin/${mr.source_branch}`);

      const slug = `gl-helper-${mr.iid}-${Date.now().toString(36)}`;
      const wt = path.join(projectDir, '.worktrees', slug);
      const skip = conflictFiles.length === 0;
      if (skip) say(`✅ В MR !${mr.iid} конфликтов нет (${mr.source_branch} → ${mr.target_branch}).`);

      return {
        projectDir,
        conflictFiles,
        wt,
        workspace: { projectDir, base: `origin/${mr.source_branch}`, slug },
        skip,
        reason: 'конфликтов нет',
        result: { ok: true, mr: mr.iid, has_conflicts: false, conflict_files: [], skipped: true },
        meta: {
          repo: ctx.repo,
          mr: mr.iid,
          source_branch: mr.source_branch,
          target_branch: mr.target_branch,
          project_dir: projectDir,
          conflict_files: conflictFiles,
        },
      };
    },

    dryRun({ opts, target: mr, pre }) {
      return {
        ok: true,
        dry_run: true,
        mr: mr.iid,
        source_branch: mr.source_branch,
        target_branch: mr.target_branch,
        has_conflicts: pre.conflictFiles.length > 0,
        conflict_files: pre.conflictFiles,
        agent: opts.agent,
        project_dir: pre.projectDir,
        worktree: pre.wt,
        steps: [
          `worktree add --detach ${pre.wt} origin/${mr.source_branch}`,
          `агент ${opts.agent}: git merge origin/${mr.target_branch}, решить конфликты, линт/тесты, коммит по правилам проекта`,
          opts.noJudge
            ? 'судья отключён (--no-judge)'
            : `судья (роль acceptance, профиль ${opts.judgeProfile ?? (opts.cfg?.judge?.roles?.acceptance ?? []).join(' → ')}): approve или push не произойдёт`,
          `push origin HEAD:${mr.source_branch}`,
          'запуск build-джобы в актуальном MR-пайплайне + ожидание',
          'удаление временного worktree',
        ],
      };
    },

    context({ ctx, opts, target: mr, pre, run, say }) {
      say(`🌿 MR !${mr.iid}: ${mr.source_branch} → ${mr.target_branch}`);
      say(`   Конфликт в ${pre.conflictFiles.length} файлах: ${pre.conflictFiles.join(', ')}`);
      say(`   Агент: ${opts.agent} · worktree: ${pre.wt}`);
      say(`   Ран: ${run.id}`);
      return {
        repo: ctx.repo,
        mr_iid: mr.iid,
        mr_title: mr.title,
        mr_url: mr.web_url,
        source_branch: mr.source_branch,
        target_branch: mr.target_branch,
        conflict_files: pre.conflictFiles.map((f) => `  ${f}`).join('\n'),
        conflict_count: pre.conflictFiles.length,
      };
    },

    goal: ({ target: mr, pre }) =>
      `Решить конфликт слияния в MR !${mr.iid} «${mr.title}»: ветка ${mr.source_branch} сливается с ${mr.target_branch}. ` +
      `Конфликтующие файлы (${pre.conflictFiles.length}): ${pre.conflictFiles.join(', ')}. ` +
      'Функциональность обеих сторон должна остаться рабочей, приоритет веток равный.',

    // Механические факты после агента. Ни одного «по словам агента».
    verify({ ws, pre }) {
      const { git, dir, base } = ws;
      const commitsAhead = Number(git(['rev-list', '--count', `${base}..HEAD`], dir));
      if (commitsAhead === 0) {
        throw new CliError(`Агент не создал коммитов в worktree (${dir}). Проверь вручную: git -C ${dir} status.`, 1, 'agent_failed');
      }
      return {
        commits_ahead: commitsAhead,
        head_sha: git(['rev-parse', 'HEAD'], dir),
        changed_files: git(['diff', '--name-only', `${base}..HEAD`], dir).split('\n').filter(Boolean),
        conflict_files: pre.conflictFiles,
        leftover_markers: git(['grep', '-l', '-E', '^(<{7}|={7}|>{7})', 'HEAD', '--', ...pre.conflictFiles], dir, { allowFail: true })
          .split('\n')
          .filter(Boolean)
          .map((l) => l.replace(/^HEAD:/, '')),
        diff: git(['diff', `${base}..HEAD`, '--', ...ACCEPTANCE_PATHSPECS], dir),
      };
    },

    // Единственное место, где происходит push. Зовётся только после approve.
    async publish({ ctx, opts, target: mr, ws, facts, say }) {
      const { g, repo } = ctx;
      say(`⬆ Пушу в ${mr.source_branch}…`);
      ws.git(['push', 'origin', `HEAD:${mr.source_branch}`], ws.dir);
      const remoteSha = ws.git(['ls-remote', 'origin', `refs/heads/${mr.source_branch}`]).split(/\s+/)[0] || '';
      if (remoteSha !== facts.head_sha) {
        throw new CliError(`Push прошёл, но origin на ${remoteSha.slice(0, 8)} вместо ${facts.head_sha.slice(0, 8)}. Кто-то запушил параллельно.`, 1, 'not_pushed');
      }
      say(`✅ Запушено в ${mr.source_branch} (${facts.head_sha.slice(0, 8)}).`);

      // Пайплайн build жмёт fsh, не агент.
      const freshMR = await g.getMR(repo, mr.iid);
      const pipeline = await ensureMRPipeline(g, repo, freshMR);
      const jobs = await g.getJobs(repo, pipeline.id);
      const build = findJob(jobs, opts.buildJob ?? 'build_image');
      if (!build) {
        throw new CliError(`Build-джоба "${opts.buildJob ?? 'build_image'}" не найдена в пайплайне #${pipeline.id}.\nДоступные: ${jobs.map((j) => j.name).join(', ')}`, 1, 'job_not_found');
      }
      say(`▶ Запускаю build: ${build.name} (#${build.id}) в пайплайне #${pipeline.id}`);
      const started = await startJob(g, repo, build);
      if (started) say(`   ${build.status} → ${started.status} (#${started.id})`);
      const final = await waitJob({
        g, repo, pipelineId: pipeline.id, jobId: (started ?? build).id,
        label: build.name, quiet: opts.quiet, onTick: opts.onTick,
      });
      if (final.status !== 'success') {
        throw new CliError(`Build завершился: ${final.status}.\nДетали: ${final.web_url}`, 1, 'build_failed');
      }
      return {
        pipeline: { id: pipeline.id, status: pipeline.status, web_url: pipeline.web_url },
        build: jobJSON(final, 'success'),
      };
    },

    renderPlan(plan, log) {
      log(`🔍 План конфликта (dry-run), MR !${plan.mr} ${plan.source_branch} → ${plan.target_branch}`);
      log(`   конфликт: ${plan.conflict_files.length ? `⚠ да, файлов ${plan.conflict_files.length}` : '✅ нет (ничего делать не нужно)'}`);
      plan.conflict_files.forEach((f) => log(`     ${f}`));
      log(`   worktree: ${plan.worktree}`);
      log(`   агент: ${plan.agent} (headless)`);
      plan.steps.forEach((s, i) => log(`   ${i + 1}. ${s}`));
    },

    result({ target: mr, run, pre, facts, verdict, published, say }) {
      say(`✅ Конфликт решён, MR !${mr.iid} обновлён, build успешен.`);
      return {
        ok: true,
        run: run.id,
        mr: mr.iid,
        head_sha: facts.head_sha,
        commits_ahead: facts.commits_ahead,
        conflict_files: pre.conflictFiles,
        judge: verdict
          ? { decision: verdict.decision, confidence: verdict.confidence, summary: verdict.summary, profile: verdict.meta.profile, cost: verdict.meta.cost }
          : { skipped: true },
        ...published,
      };
    },
  },
};
