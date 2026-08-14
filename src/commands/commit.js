import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { CliError } from '../errors.js';
import { expandHome } from '../config.js';
import { commitPrompt } from '../prompts.js';
import { confirm } from '../ui.js';

// gl-helper commit [--agent claude|pi] [--project-dir <dir>] [-y]
// Агент формирует сообщение коммита по паттерну (.llm-commit-pattern или встроенный)
// и коммитит все изменения. Push НЕ делает.
export async function cmdCommit(args, opts = {}) {
  const agent = opts.agent;
  if (!['claude', 'pi'].includes(agent)) {
    throw new CliError(`Неизвестный агент "${agent}". Допустимо: claude, pi.`);
  }

  const dir = expandHome(opts.projectDir || process.cwd());
  if (!existsSync(path.join(dir, '.git'))) {
    throw new CliError(`"${dir}" не git-репозиторий. Укажи --project-dir.`);
  }

  const git = (a) => {
    try {
      return execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch (err) {
      throw new CliError(`git ${a.join(' ')} не удался: ${String(err.stderr || err.message).trim()}`);
    }
  };

  const branch = git(['branch', '--show-current']) || '(detached HEAD)';
  const { source, prompt } = commitPrompt(dir);

  console.log(`📝 Коммит: ${dir}`);
  console.log(`   Ветка: ${branch} · агент: ${agent} · промпт: ${source}`);

  if (!opts.yes && !confirm(`Запускаю агента ${agent}. Продолжить? [y/N] `)) {
    throw new CliError('Отменено.', 0);
  }

  const before = git(['rev-parse', 'HEAD']);
  console.log(`🤖 Запускаю ${agent}…`);
  const res = spawnSync(agent, [...(opts.agentArgs ?? []), '-p', prompt], {
    cwd: dir,
    stdio: 'inherit',
    env: { ...process.env, GL_HELPER_COMMIT: '1' },
  });
  if (res.error) throw new CliError(`Не удалось запустить ${agent}: ${res.error.message}`);
  if (res.status !== 0) throw new CliError(`Агент ${agent} завершился с кодом ${res.status}.`);

  const after = git(['rev-parse', 'HEAD']);
  if (after === before) {
    throw new CliError('Агент не создал коммит. Проверь git status вручную.');
  }
  console.log(`✅ Коммит создан: ${git(['log', '-1', '--pretty=%h %s'])}`);
}
