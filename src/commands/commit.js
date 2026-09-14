import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { CliError } from '../errors.js';
import { expandHome } from '../config.js';
import { resolveAgent } from '../agents.js';
import { commitPrompt } from '../prompts.js';
import { confirm } from '../ui.js';
import { makeLogger, finish } from '../output.js';
import { makeGit } from '../workspace.js';

// fsh commit [--agent <профиль>] [--project-dir <dir>] [-y] [--dry-run]
// Агент формирует сообщение коммита по паттерну (.llm-commit-pattern или встроенный)
// и коммитит все изменения. Push НЕ делает.
export async function cmdCommit(args, opts = {}) {
  const log = opts.asObject ? () => {} : makeLogger(opts.json);
  const agent = resolveAgent(opts.cfg, opts.agent);

  const dir = expandHome(opts.projectDir || process.cwd());
  if (!existsSync(path.join(dir, '.git'))) {
    throw new CliError(`"${dir}" не git-репозиторий. Укажи --project-dir.`, 1, 'usage');
  }

  const git = makeGit(dir);

  const branch = git(['branch', '--show-current']) || '(detached HEAD)';
  const { source, prompt } = commitPrompt(dir);

  if (opts.dryRun) {
    const plan = {
      ok: true,
      dry_run: true,
      dir,
      branch,
      agent: agent.name,
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
      log(`   агент: ${agent.name}`);
      log(`   промпт: ${source}`);
      log(`   действие: ${plan.action}`);
    }
    return;
  }

  log(`📝 Коммит: ${dir}`);
  log(`   Ветка: ${branch} · агент: ${agent.name} · промпт: ${source}`);

  if (!opts.yes && !opts.asObject && !confirm(`Запускаю агента ${agent.name}. Продолжить? [y/N] `)) {
    throw new CliError('Отменено.', 0, 'canceled');
  }

  const before = git(['rev-parse', 'HEAD']);
  log(`🤖 Запускаю ${agent.name}…`);
  // Промпт в stdin, вывод агента остаётся на терминале.
  const res = spawnSync(agent.bin, [...agent.args, '-p'], {
    cwd: dir,
    input: prompt,
    stdio: ['pipe', 'inherit', 'inherit'],
    env: { ...process.env, ...agent.env, GL_HELPER_COMMIT: '1' },
  });
  if (res.error) throw new CliError(`Не удалось запустить ${agent.name}: ${res.error.message}`, 1, 'agent_failed');
  if (res.status !== 0) throw new CliError(`Агент ${agent.name} завершился с кодом ${res.status}.`, 1, 'agent_failed');

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
