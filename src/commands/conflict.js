import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { resolveMR } from '../resolve.js';
import { CliError } from '../errors.js';
import { expandHome } from '../config.js';
import { ensureMRPipeline, findJob, startJob } from '../pipeline.js';
import { waitJob, confirm } from '../ui.js';
import { makeLogger, finish, jobJSON } from '../output.js';
import { spawnAgent } from '../agent/spawn.js';
import { createRun, saveArtifact, readRun } from '../agent/journal.js';
import { judge, isApproved, formatVerdict } from '../judge/index.js';
import { buildAcceptancePayload, ACCEPTANCE_PATHSPECS } from '../judge/payload.js';
import { renderTemplate } from '../prompts.js';

// Первая строка вывода merge-tree — OID результирующего дерева, а не имя файла.
// Не отбросить её — хэш уедет в промпт и агент пойдёт искать несуществующий файл.
export function parseMergeTree(stdout) {
  return String(stdout)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(1);
}

// fsh conflict <mr|ветка> [--agent claude|pi]
// Решает конфликт силами headless-агента во временном worktree, пушит в ветку MR,
// затем сам запускает build-джобу и ждёт её. Worktree всегда убирается (кроме аварийных случаев).
// --dry-run: показать план без каких-либо действий.
export async function cmdConflict(g, repo, args, opts = {}) {
  if (opts.judgeOnly) return cmdJudgeOnly(opts.judgeOnly, opts);

  const [mrQuery] = args;
  if (!mrQuery) throw new CliError('Использование: fsh conflict <mr|ветка> [--agent claude|pi] [-y]', 1, 'usage');

  const log = opts.asObject ? () => {} : makeLogger(opts.json);
  const agent = opts.agent;
  if (!['claude', 'pi'].includes(agent)) {
    throw new CliError(`Неизвестный агент "${agent}". Допустимо: claude, pi.`, 1, 'usage');
  }

  const mr = await resolveMR(g, repo, mrQuery);

  const projectDir = expandHome(opts.projectDir);
  if (!projectDir) {
    throw new CliError('Каталог проекта не настроен (projectDir пуст). Выполни fsh config init или передай --project-dir <путь к локальному репо>.', 1, 'config_invalid');
  }
  if (!existsSync(path.join(projectDir, '.git'))) {
    throw new CliError(`Каталог проекта ${projectDir} не является git-репозиторием. Укажи --project-dir.`, 1, 'config_invalid');
  }

  // allowFail — для команд, у которых ненулевой код это ответ, а не поломка (git grep).
  const git = (a, cwd = projectDir, { allowFail = false } = {}) => {
    try {
      return execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch (err) {
      if (allowFail) return String(err.stdout ?? '').trim();
      throw new CliError(`git ${a.join(' ')} не удался: ${String(err.stderr || err.message).trim()}`, 1, 'git_failed');
    }
  };

  // Конфликт считаем сами, а не по полю GitLab: при has_conflicts: "unchecked" оно врёт
  // «конфликтов нет». merge-tree отвечает точно и заодно даёт список файлов для промпта.
  const conflictingFiles = (target, source) => {
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
  };

  git(['fetch', 'origin', `${mr.source_branch}:refs/remotes/origin/${mr.source_branch}`, `${mr.target_branch}:refs/remotes/origin/${mr.target_branch}`]);
  const conflictFiles = conflictingFiles(`origin/${mr.target_branch}`, `origin/${mr.source_branch}`);

  const stamp = Date.now().toString(36);
  const branch = `gl-helper/${mr.iid}-${stamp}`;
  const wt = path.join(projectDir, '.worktrees', `gl-helper-${mr.iid}-${stamp}`);
  const base = `origin/${mr.source_branch}`;

  if (opts.dryRun) {
    const plan = {
      ok: true,
      dry_run: true,
      mr: mr.iid,
      has_conflicts: conflictFiles.length > 0,
      conflict_files: conflictFiles,
      agent,
      project_dir: projectDir,
      worktree: wt,
      steps: [
        `worktree add --detach ${wt} ${base}`,
        `агент ${agent}: git merge origin/${mr.target_branch}, решить конфликты, линт/тесты, коммит по правилам проекта`,
        opts.noJudge ? 'судья отключён (--no-judge)' : `судья (роль acceptance, профиль ${opts.judgeProfile ?? (opts.cfg?.judge?.roles?.acceptance ?? []).join(' → ')}): approve или push не произойдёт`,
        `push origin HEAD:${mr.source_branch}`,
        'запуск build-джобы в актуальном MR-пайплайне + ожидание',
        'удаление временного worktree',
      ],
    };
    if (opts.asObject) return plan;
    if (opts.json) {
      finish(true, plan);
    } else {
      log(`🔍 План конфликта (dry-run), MR !${mr.iid} ${mr.source_branch} → ${mr.target_branch}`);
      log(`   конфликт: ${conflictFiles.length ? `⚠ да, файлов ${conflictFiles.length}` : '✅ нет (ничего делать не нужно)'}`);
      conflictFiles.forEach((f) => log(`     ${f}`));
      log(`   worktree: ${wt}`);
      log(`   агент: ${agent} (headless)`);
      plan.steps.forEach((s, i) => log(`   ${i + 1}. ${s}`));
    }
    return;
  }

  if (!conflictFiles.length) {
    const result = { ok: true, mr: mr.iid, has_conflicts: false, conflict_files: [], skipped: true };
    if (opts.asObject) return result;
    log(`✅ В MR !${mr.iid} конфликтов нет (${mr.source_branch} → ${mr.target_branch}).`);
    finish(opts.json, result);
    return result;
  }

  const runDir = createRun('conflict');
  let wtCreated = false;
  let keep = Boolean(opts.keepWorktree);

  log(`🌿 MR !${mr.iid}: ${mr.source_branch} → ${mr.target_branch}`);
  log(`   Конфликт в ${conflictFiles.length} файлах: ${conflictFiles.join(', ')}`);
  log(`   Агент: ${agent} · worktree: ${wt}`);
  log(`   Ран: ${runDir.id}`);

  try {
    // Detached-worktree от origin/<source>, чтобы не трогать рабочую копию.
    git(['worktree', 'add', '--detach', wt, base]);
    wtCreated = true;
    git(['checkout', '-b', branch], wt);
    const baseSha = git(['rev-parse', base]);

    const prompt = renderTemplate('actions/conflict', conflictVars({ repo, mr, conflictFiles }), { projectDir }).text;
    saveArtifact(runDir, 'prompt.md', prompt);
    saveArtifact(runDir, 'meta.json', {
      id: runDir.id,
      action: 'conflict',
      created_at: new Date().toISOString(),
      repo,
      mr: mr.iid,
      source_branch: mr.source_branch,
      target_branch: mr.target_branch,
      project_dir: projectDir,
      worktree: wt,
      branch,
      base,
      base_sha: baseSha,
      agent,
      conflict_files: conflictFiles,
      judge: { role: 'acceptance' },
    });

    if (!opts.yes && !opts.asObject && !confirm(`Запускаю агента ${agent}. Продолжить? [y/N] `)) {
      throw new CliError('Отменено.', 0, 'canceled');
    }

    log(`🤖 Запускаю ${agent}…`);
    const run = spawnAgent({
      bin: agent,
      args: [...(opts.agentArgs ?? []), '-p', prompt],
      cwd: wt,
      env: { ...process.env, GL_HELPER_MR: String(mr.iid), GL_HELPER_REPO: repo },
    });
    const agentOut = [];
    run.events.on((ev) => {
      if (ev.t !== 'log') return;
      if (ev.stream === 'stderr') process.stderr.write(`${ev.text}\n`);
      else {
        agentOut.push(ev.text);
        log(ev.text);
      }
    });
    let done;
    try {
      done = await run.result;
    } catch (err) {
      throw new CliError(`Не удалось запустить ${agent}: ${err.message}`, 1, 'agent_failed');
    }
    if (!done.ok) throw new CliError(`Агент ${agent} завершился с кодом ${done.code}.`, 1, 'agent_failed');

    // verify: механические факты, снятые с git, а не слова агента.
    const facts = verify({ git, wt, base, conflictFiles });
    const agentText = agentOut.join('\n');
    saveArtifact(runDir, 'agent.txt', agentText);
    saveArtifact(runDir, 'diff.patch', facts.diff);
    saveArtifact(runDir, 'meta.json', {
      ...JSON.parse(readRun(runDir.id).read('meta.json')),
      head_sha: facts.head_sha,
      facts: { ...facts, diff: undefined },
      goal: goalOf(mr, conflictFiles),
    });

    // Гейт: push случается только после approve. До него в origin не ушло ничего.
    let verdict = null;
    if (opts.noJudge) {
      log('⚠ Судья отключён (--no-judge): push без приёмки.');
    } else {
      log('⚖ Судья смотрит результат…');
      verdict = await judge({
        role: 'acceptance',
        cfg: opts.cfg,
        profile: opts.judgeProfile,
        payload: buildAcceptancePayload({ goal: goalOf(mr, conflictFiles), facts: { ...facts, diff: undefined }, diff: facts.diff, agentText }),
      });
      saveArtifact(runDir, 'verdict.json', verdict);
      if (!opts.asObject) log(formatVerdict(verdict));
      if (!isApproved(verdict)) {
        keep = true;
        throw new CliError(
          `${formatVerdict(verdict)}\n\nPush не сделан. Worktree сохранён: ${wt}\nВердикт: ${runDir.dir}/verdict.json`,
          1,
          'judge_rejected',
        );
      }
    }

    // publish: единственное место, где происходит push.
    const published = await publish({ g, repo, mr, git, wt, log, opts, facts });

    log(`✅ Конфликт решён, MR !${mr.iid} обновлён, build успешен.`);
    const result = {
      ok: true,
      run: runDir.id,
      mr: mr.iid,
      head_sha: facts.head_sha,
      commits_ahead: facts.commits_ahead,
      conflict_files: conflictFiles,
      judge: verdict ? { decision: verdict.decision, confidence: verdict.confidence, summary: verdict.summary, profile: verdict.meta.profile, cost: verdict.meta.cost } : { skipped: true },
      ...published,
    };
    saveArtifact(runDir, 'result.json', result);
    if (!opts.asObject) finish(opts.json, result);
    return result;
  } finally {
    // Без return: он проглатывал летящее исключение и команда возвращала undefined.
    if (wtCreated) {
      if (keep) {
        log(`📁 Worktree сохранён: ${wt}`);
      } else {
        try { git(['worktree', 'remove', '--force', wt]); } catch { /* уже удалён */ }
        try { git(['worktree', 'prune']); } catch { /* не критично */ }
        try { git(['branch', '-D', branch]); } catch { /* не критично */ }
        log('🧹 Временный worktree и ветка удалены.');
      }
    }
  }
}

const goalOf = (mr, conflictFiles) =>
  `Решить конфликт слияния в MR !${mr.iid} «${mr.title}»: ветка ${mr.source_branch} сливается с ${mr.target_branch}. ` +
  `Конфликтующие файлы (${conflictFiles.length}): ${conflictFiles.join(', ')}. ` +
  'Функциональность обеих сторон должна остаться рабочей, приоритет веток равный.';

// Механические факты после агента. Ни одного «по словам агента».
function verify({ git, wt, base, conflictFiles }) {
  const commitsAhead = Number(git(['rev-list', '--count', `${base}..HEAD`], wt));
  if (commitsAhead === 0) {
    throw new CliError(`Агент не создал коммитов в worktree (${wt}). Проверь вручную: git -C ${wt} status.`, 1, 'agent_failed');
  }
  const changed = git(['diff', '--name-only', `${base}..HEAD`], wt).split('\n').filter(Boolean);
  const markers = git(['grep', '-l', '-E', '^(<{7}|={7}|>{7})', 'HEAD', '--', ...conflictFiles], wt, { allowFail: true })
    .split('\n')
    .filter(Boolean)
    .map((l) => l.replace(/^HEAD:/, ''));
  return {
    commits_ahead: commitsAhead,
    head_sha: git(['rev-parse', 'HEAD'], wt),
    changed_files: changed,
    conflict_files: conflictFiles,
    leftover_markers: markers,
    diff: git(['diff', `${base}..HEAD`, '--', ...ACCEPTANCE_PATHSPECS], wt),
  };
}

// publish: push и build. Зовётся только после approve.
async function publish({ g, repo, mr, git, wt, log, opts, facts }) {
  log(`⬆ Пушу в ${mr.source_branch}…`);
  git(['push', 'origin', `HEAD:${mr.source_branch}`], wt);
  const remoteSha = git(['ls-remote', 'origin', `refs/heads/${mr.source_branch}`]).split(/\s+/)[0] || '';
  if (remoteSha !== facts.head_sha) {
    throw new CliError(`Push прошёл, но origin на ${remoteSha.slice(0, 8)} вместо ${facts.head_sha.slice(0, 8)}. Кто-то запушил параллельно.`, 1, 'not_pushed');
  }
  log(`✅ Запушено в ${mr.source_branch} (${facts.head_sha.slice(0, 8)}).`);

  // Пайплайн build жмёт fsh, не агент.
  const freshMR = await g.getMR(repo, mr.iid);
  const pipeline = await ensureMRPipeline(g, repo, freshMR);
  const jobs = await g.getJobs(repo, pipeline.id);
  const build = findJob(jobs, opts.buildJob ?? 'build_image');
  if (!build) {
    throw new CliError(`Build-джоба "${opts.buildJob ?? 'build_image'}" не найдена в пайплайне #${pipeline.id}.\nДоступные: ${jobs.map((j) => j.name).join(', ')}`, 1, 'job_not_found');
  }
  log(`▶ Запускаю build: ${build.name} (#${build.id}) в пайплайне #${pipeline.id}`);
  const started = await startJob(g, repo, build);
  const buildRun = started ?? { id: build.id };
  if (started) log(`   ${build.status} → ${started.status} (#${started.id})`);
  const final = await waitJob({ g, repo, pipelineId: pipeline.id, jobId: buildRun.id, label: build.name, quiet: opts.quiet, onTick: opts.onTick });
  if (final.status !== 'success') {
    throw new CliError(`Build завершился: ${final.status}.\nДетали: ${final.web_url}`, 1, 'build_failed');
  }
  return {
    pipeline: { id: pipeline.id, status: pipeline.status, web_url: pipeline.web_url },
    build: jobJSON(final, 'success'),
  };
}

// Прогнать судью по сохранённому рану. Работает по артефактам, а не по worktree:
// дифф и отчёт агента зафиксированы на диске, значит рубрики и провайдеров можно
// сравнивать на одном и том же материале даже после уборки worktree.
export async function cmdJudgeOnly(runId, opts = {}) {
  const log = opts.asObject ? () => {} : makeLogger(opts.json);
  const saved = readRun(runId);
  const { meta } = saved;
  const diff = saved.read('diff.patch');
  if (diff === null) {
    throw new CliError(`У рана ${runId} нет diff.patch — судить нечего (ран не дошёл до verify).`, 1, 'run_incomplete');
  }

  log(`⚖ Судья по рану ${runId} (MR !${meta.mr}, ${meta.conflict_files?.length ?? 0} конфликтующих файлов)`);
  const verdict = await judge({
    role: meta.judge?.role ?? 'acceptance',
    cfg: opts.cfg,
    profile: opts.judgeProfile,
    payload: buildAcceptancePayload({
      goal: meta.goal,
      facts: meta.facts ?? {},
      diff,
      agentText: saved.read('agent.txt') ?? '',
    }),
  });
  saveArtifact(saved, 'verdict.json', verdict);

  const result = { ok: true, run: runId, judge_only: true, mr: meta.mr, verdict };
  if (opts.asObject) return result;
  log(formatVerdict(verdict));
  finish(opts.json, result);
  return result;
}

// Переменные шаблона actions/conflict. Списки собираются здесь, в шаблоне только подстановка.
export function conflictVars({ repo, mr, conflictFiles }) {
  return {
    repo,
    mr_iid: mr.iid,
    mr_title: mr.title,
    mr_url: mr.web_url,
    source_branch: mr.source_branch,
    target_branch: mr.target_branch,
    conflict_files: conflictFiles.map((f) => `  ${f}`).join('\n'),
    conflict_count: conflictFiles.length,
  };
}
