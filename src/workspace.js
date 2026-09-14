import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { CliError } from './errors.js';

// Дефолтный буфер execFileSync — мегабайт, а дифф ветки после мержа target легко больше:
// на нём ран падал с ENOBUFS уже после работы агента.
export const GIT_MAX_BUFFER = 64 * 1024 * 1024;

// git с рабочим каталогом по умолчанию.
// allowFail — для команд, у которых ненулевой код это ответ, а не поломка (git grep).
export function makeGit(defaultCwd) {
  return (args, cwd = defaultCwd, { allowFail = false } = {}) => {
    try {
      return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: GIT_MAX_BUFFER }).trim();
    } catch (err) {
      if (allowFail) return String(err.stdout ?? '').trim();
      throw new CliError(`git ${args.join(' ')} не удался: ${String(err.stderr || err.message).trim()}`, 1, 'git_failed');
    }
  };
}

export const MODES = ['checkout', 'ephemeral-worktree', 'task-worktree'];
export const DEPS_STRATEGIES = ['clone', 'link', 'install', 'none'];

// Рут worktree вне репозитория: в $projectDir/.worktrees чужие файлы видны git status
// основного чекаута и лезут в чужие сборки. Том тот же, git worktree это устраивает.
export const WORKTREE_ROOT = path.join(homedir(), '.local', 'state', 'fs-harness', 'worktrees');

// Изоляция как сервис. Возвращает {dir, branch, base, created, deps, git, snapshot, cleanup}.
export async function acquireWorkspace({
  mode,
  action,
  project,
  ref,
  baseRef,
  key,
  refs = [],
  deps = {},
  root = WORKTREE_ROOT,
  onEvent = () => {},
}) {
  if (!MODES.includes(mode)) throw new CliError(`Неизвестный режим изоляции "${mode}". Допустимо: ${MODES.join(', ')}.`, 1, 'config_invalid');
  const git = makeGit(project);
  const base = ref ? `origin/${ref}` : 'HEAD';

  if (mode === 'checkout') {
    return workspace({ dir: project, branch: null, base, created: false, git, deps: { available: true, strategy: 'checkout' }, cleanup: () => {} });
  }

  if (refs.length) git(['fetch', 'origin', ...refs.map((r) => `${r}:refs/remotes/origin/${r}`)]);

  const stamp = Date.now().toString(36);
  const name = `${action}-${key}-${stamp}`;
  const dir = path.join(root, path.basename(project), name);
  const branch = `fs-harness/${name}`;
  try {
    mkdirSync(path.dirname(dir), { recursive: true });
  } catch (err) {
    throw new CliError(`Не удалось создать рут worktree ${path.dirname(dir)}: ${err.message}`, 1, 'workspace_failed');
  }
  git(['worktree', 'add', '--detach', dir, base]);
  git(['checkout', '-b', branch], dir);

  const resolved = provideDeps(deps.strategy ?? 'clone', project, dir, onEvent);

  return workspace({
    dir,
    branch,
    base,
    created: true,
    git,
    deps: { ...resolved, available: resolved.available && lockMatches(git, project, dir) },
    // task-worktree — заготовка под задачи Jira: живёт дольше рана, сама не убирается.
    cleanup: (keep) => {
      if (keep || mode === 'task-worktree') {
        onEvent(`📁 Worktree сохранён: ${dir}`);
        return;
      }
      try { git(['worktree', 'remove', '--force', dir]); } catch { /* уже удалён */ }
      try { git(['worktree', 'prune']); } catch { /* не критично */ }
      try { git(['branch', '-D', branch]); } catch { /* не критично */ }
      onEvent('🧹 Временный worktree и ветка удалены.');
    },
  });
}

function workspace(w) {
  return {
    ...w,
    // Снимок для режима checkout: читающее действие не имеет права ничего менять.
    snapshot: () => `${w.git(['rev-parse', 'HEAD'], w.dir)}\n${w.git(['status', '--porcelain'], w.dir)}`,
    assertClean(before) {
      if (this.snapshot() !== before) {
        throw new CliError(`Действие изменило рабочий чекаут ${w.dir}, хотя не должно было. Проверь: git -C ${w.dir} status.`, 1, 'dirty_checkout');
      }
    },
  };
}

// node_modules в worktree. cp -Rc — APFS clonefile: секунды и ноль байт, при этом
// полная изоляция (общий .cache не мешает параллельным ранам).
function provideDeps(strategy, project, dir, onEvent) {
  if (!DEPS_STRATEGIES.includes(strategy)) throw new CliError(`Неизвестная стратегия deps "${strategy}". Допустимо: ${DEPS_STRATEGIES.join(', ')}.`, 1, 'config_invalid');
  const src = path.join(project, 'node_modules');
  if (strategy === 'none') return { available: false, strategy, reason: 'strategy: none' };
  if (strategy !== 'install' && !existsSync(src)) return { available: false, strategy, reason: 'в основном чекауте нет node_modules' };

  const dest = path.join(dir, 'node_modules');
  try {
    if (strategy === 'link') symlinkSync(src, dest);
    else if (strategy === 'install') execFileSync('npm', ['ci', '--prefer-offline'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    else execFileSync('cp', ['-Rc', src, dest], { stdio: ['ignore', 'pipe', 'pipe'] });
    return { available: true, strategy };
  } catch (err) {
    // Не падаем: без зависимостей агент просто не гоняет линт, и об этом ему говорит промпт.
    const reason = String(err.stderr || err.message).trim().split('\n')[0];
    onEvent(`⚠ node_modules не перенесены (${strategy}): ${reason}. Линт и тесты агенту будут запрещены.`);
    return { available: false, strategy, reason };
  }
}

// Зависимости годны, только если lock-файл ветки совпал с основным чекаутом.
function lockMatches(git, project, dir) {
  const hash = (cwd) => {
    try {
      return git(['hash-object', 'package-lock.json'], cwd);
    } catch {
      return null; // нет lock-файла — сравнивать нечего
    }
  };
  return hash(project) === hash(dir);
}
