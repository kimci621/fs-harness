import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { resolveMR } from '../resolve.js';
import { CliError } from '../errors.js';
import { expandHome } from '../config.js';
import { ensureMRPipeline, findJob, startJob } from '../pipeline.js';
import { waitJob, confirm } from '../ui.js';

// gl-helper conflict <mr|ветка> [--agent claude|pi]
// Решает конфликт силами headless-агента во временном worktree, пушит в ветку MR,
// затем сам запускает build-джобу и ждёт её. Worktree всегда убирается (кроме аварийных случаев).
export async function cmdConflict(g, repo, args, opts = {}) {
  const [mrQuery] = args;
  if (!mrQuery) throw new CliError('Использование: gl-helper conflict <mr|ветка> [--agent claude|pi] [-y]');

  const agent = opts.agent;
  if (!['claude', 'pi'].includes(agent)) {
    throw new CliError(`Неизвестный агент "${agent}". Допустимо: claude, pi.`);
  }

  const mr = await resolveMR(g, repo, mrQuery);
  if (!mr.has_conflicts) {
    console.log(`✅ В MR !${mr.iid} конфликтов нет (${mr.source_branch} → ${mr.target_branch}).`);
    return;
  }

  const projectDir = expandHome(opts.projectDir);
  if (!existsSync(path.join(projectDir, '.git'))) {
    throw new CliError(`Каталог проекта ${projectDir} не является git-репозиторием. Укажи --project-dir.`);
  }

  const git = (a, cwd = projectDir) => {
    try {
      return execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch (err) {
      throw new CliError(`git ${a.join(' ')} не удался: ${String(err.stderr || err.message).trim()}`);
    }
  };

  const stamp = Date.now().toString(36);
  const branch = `gl-helper/${mr.iid}-${stamp}`;
  const wt = path.join(projectDir, '.worktrees', `gl-helper-${mr.iid}-${stamp}`);
  const base = `origin/${mr.source_branch}`;
  let wtCreated = false;
  let keep = Boolean(opts.keepWorktree);

  console.log(`🌿 MR !${mr.iid}: ${mr.source_branch} → ${mr.target_branch}`);
  console.log(`   Агент: ${agent} · worktree: ${wt}`);

  try {
    // Свежие ветки и detached-worktree от origin/<source>, чтобы не трогать рабочую копию.
    git(['fetch', 'origin', `${mr.source_branch}:refs/remotes/origin/${mr.source_branch}`, `${mr.target_branch}:refs/remotes/origin/${mr.target_branch}`]);
    git(['worktree', 'add', '--detach', wt, base]);
    wtCreated = true;
    git(['checkout', '-b', branch], wt);

    if (!opts.yes && !confirm(`Запускаю агента ${agent}. Продолжить? [y/N] `)) {
      throw new CliError('Отменено.', 0);
    }

    console.log(`🤖 Запускаю ${agent}…`);
    const extra = opts.agentArgs ?? [];
    const res = spawnSync(agent, [...extra, '-p', buildPrompt({ repo, mr })], {
      cwd: wt,
      stdio: 'inherit',
      env: { ...process.env, GL_HELPER_MR: String(mr.iid), GL_HELPER_REPO: repo },
    });
    if (res.error) throw new CliError(`Не удалось запустить ${agent}: ${res.error.message}`);
    if (res.status !== 0) throw new CliError(`Агент ${agent} завершился с кодом ${res.status}.`);

    // Проверяем результат: коммиты есть? запушено?
    const ahead = Number(git(['rev-list', '--count', `${base}..HEAD`], wt));
    if (ahead === 0) {
      throw new CliError(`Агент не создал коммитов в worktree (${wt}). Проверь вручную: git -C ${wt} status.`);
    }
    const headSha = git(['rev-parse', 'HEAD'], wt);
    const remoteSha = (git(['ls-remote', 'origin', `refs/heads/${mr.source_branch}`]).split(/\s+/)[0] || '');
    if (remoteSha !== headSha) {
      keep = true;
      throw new CliError(
        `Агент не запушл изменения (HEAD ${headSha.slice(0, 8)} ≠ origin ${remoteSha.slice(0, 8)}).\n` +
          `Запушь вручную: git -C ${wt} push origin HEAD:${mr.source_branch}\nWorktree сохранён: ${wt}`,
      );
    }
    console.log(`✅ Изменения запушены в ${mr.source_branch} (${headSha.slice(0, 8)}).`);

    // Пайплайн build жмёт gl-helper, не агент.
    const freshMR = await g.getMR(repo, mr.iid);
    const pipeline = await ensureMRPipeline(g, repo, freshMR);
    const jobs = await g.getJobs(repo, pipeline.id);
    const build = findJob(jobs, opts.buildJob ?? 'build_image');
    if (!build) {
      throw new CliError(`Build-джоба "${opts.buildJob ?? 'build_image'}" не найдена в пайплайне #${pipeline.id}.\nДоступные: ${jobs.map((j) => j.name).join(', ')}`);
    }
    console.log(`▶ Запускаю build: ${build.name} (#${build.id}) в пайплайне #${pipeline.id}`);
    const started = await startJob(g, repo, build);
    const buildRun = started ?? { id: build.id };
    if (started) console.log(`   ${build.status} → ${started.status} (#${started.id})`);
    const final = await waitJob({ g, repo, pipelineId: pipeline.id, jobId: buildRun.id, label: build.name });
    if (final.status !== 'success') {
      throw new CliError(`Build завершился: ${final.status}.\nДетали: ${final.web_url}`);
    }
    console.log(`✅ Конфликт решён, MR !${mr.iid} обновлён, build успешен.`);
  } finally {
    if (!wtCreated) return;
    if (keep) {
      console.log(`📁 Worktree сохранён: ${wt}`);
    } else {
      try { git(['worktree', 'remove', '--force', wt]); } catch { /* уже удалён */ }
      try { git(['worktree', 'prune']); } catch { /* не критично */ }
      try { git(['branch', '-D', branch]); } catch { /* не критично */ }
      console.log('🧹 Временный worktree и ветка удалены.');
    }
  }
}

function buildPrompt({ repo, mr }) {
  const source = mr.source_branch;
  const target = mr.target_branch;
  return [
    `Ты работаешь в GitLab-проекте ${repo}. Репозиторий уже склонирован в текущей директории — это временный git worktree с веткой на базе origin/${source}.`,
    '',
    `Задача: решить конфликт в MR !${mr.iid} «${mr.title}» (${mr.web_url}), ветка ${source} → ${target}.`,
    '',
    'Данные о MR получай через glab, например:',
    `  glab mr view ${mr.iid} -R ${repo}`,
    `  glab api 'projects/${repo}/merge_requests/${mr.iid}'`,
    '',
    'Шаги:',
    `1. Выполни "git merge origin/${target}" — конфликты появятся в твоей ветке.`,
    '2. Реши каждый конфликт внимательно и вручную: сохрани корректную функциональность обеих веток. Критерии приёмки — рабочий код и в текущей ветке, и в dev, приоритет равный. Запрещено бездумно брать всё из одной стороны (ours/theirs) и делать force-push.',
    '3. Проверь, что код рабочий: просмотри конфликтные файлы; если в проекте есть линт и unit-тесты, прогони их (npm run lint, npm run test) перед коммитом.',
    '4. Закоммить по правилам проекта: посмотри "git log --oneline -20" и повтори стиль сообщений коммита.',
    `5. Запушь: "git push origin HEAD:${source}" — это обновит MR. Ветку ${target} не трогай, лишних коммитов не создавай.`,
    '6. Если при merge конфликтов не оказалось — просто сообщи об этом, ничего не коммить и не пушь.',
    '',
    'В конце ответа кратко перечисли: какие файлы изменены, как решён каждый конфликт, что проверено, хэш последнего коммита.',
  ].join('\n');
}
