import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { CliError } from '../errors.js';
import { expandHome } from '../config.js';
import { commitPrompt } from '../prompts.js';
import { confirm } from '../ui.js';
import { makeLogger, finish } from '../output.js';

// fsh commit [--agent claude|pi] [--project-dir <dir>] [-y] [--dry-run]
// Агент формирует сообщение коммита по паттерну (.llm-commit-pattern или встроенный)
// и коммитит все изменения. Push НЕ делает.
export async function cmdCommit(args, opts = {}) {
  const log = opts.asObject ? () => {} : makeLogger(opts.json);
  const agent = opts.agent;
  if (!['claude', 'pi'].includes(agent)) {
    throw new CliError(`Неизвестный агент "${agent}". Допустимо: claude, pi.`, 1, 'usage');
  }

  const dir = expandHome(opts.projectDir || process.cwd());
  if (!existsSync(path.join(dir, '.git'))) {
    throw new CliError(`"${dir}" не git-репозиторий. Укажи --project-dir.`, 1, 'usage');
  }

  const git = (a) => {
    try {
      return execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch (err) {
      throw new CliError(`git ${a.join(' ')} не удался: ${String(err.stderr || err.message).trim()}`, 1, 'git_failed');
    }
  };

  const branch = git(['branch', '--show-current']) || '(detached HEAD)';
  const { source, prompt } = commitPrompt(dir);

  if (opts.dryRun) {
    const plan = {
      ok: true,
      dry_run: true,
      dir,
      branch,
      agent,
      prompt_source: source,
      action: 'агент изучит изменения и выполнит: git add <явные пути> && git commit -m "<сообщение по паттерну>" (без push)',
    };
    if (opts.asObject) return plan;
    if (opts.json) {
      finish(true, plan);
    } else {
      log(`🔍 План коммита (dry-run)`);
      log(`   директория: ${dir}`);
      log(`   ветка: ${branch}`);
      log(`   агент: ${agent}`);
      log(`   промпт: ${source}`);
      log(`   действие: ${plan.action}`);
    }
    return;
  }

  log(`📝 Коммит: ${dir}`);
  log(`   Ветка: ${branch} · агент: ${agent} · промпт: ${source}`);

  if (!opts.yes && !opts.asObject && !confirm(`Запускаю агента ${agent}. Продолжить? [y/N] `)) {
    throw new CliError('Отменено.', 0, 'canceled');
  }

  const before = git(['rev-parse', 'HEAD']);
  log(`🤖 Запускаю ${agent}…`);
  const res = spawnSync(agent, [...(opts.agentArgs ?? []), '-p', prompt], {
    cwd: dir,
    stdio: 'inherit',
    env: { ...process.env, GL_HELPER_COMMIT: '1' },
  });
  if (res.error) throw new CliError(`Не удалось запустить ${agent}: ${res.error.message}`, 1, 'agent_failed');
  if (res.status !== 0) throw new CliError(`Агент ${agent} завершился с кодом ${res.status}.`, 1, 'agent_failed');

  const after = git(['rev-parse', 'HEAD']);
  if (after === before) {
    throw new CliError('Агент не создал коммит. Проверь git status вручную.', 1, 'no_commit');
  }
  const hash = after.slice(0, 12);
  const message = git(['log', '-1', '--pretty=%s']);
  log(`✅ Коммит создан: ${hash} ${message}`);
  const result = { ok: true, dir, branch, commit: { hash, message } };
  if (!opts.asObject) finish(opts.json, result);
  return result;
}
