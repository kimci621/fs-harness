import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
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
      const detail = String(err.stderr || err.message).trim();
      throw new CliError(`git ${args.join(' ')} не удался: ${detail}${authHint(args, detail)}`, 1, 'git_failed');
    }
  };
}

// Отказ доступа к origin выглядит одинаково и в push, и в fetch: подсказываем, что чинить.
// Другие git-ошибки (non-fast-forward, ENOBUFS) не трогаем.
const ACCESS_DENIED = /HTTP Basic: Access denied|Authentication failed|could not read Username|Permission denied \(publickey\)/i;
export function authHint(args, detail) {
  if (!['push', 'fetch', 'ls-remote', 'clone'].includes(args[0])) return '';
  if (!ACCESS_DENIED.test(detail)) return '';
  return '\nПохоже, нет доступа к origin. Проверь: glab auth login, credential helper (git config --global credential.helper) или SSH-remote (git remote -v).';
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
    return workspace({ dir: project, branch: null, base, baseSha: revSha(git, base, project), created: false, git, deps: { available: true, strategy: 'checkout' }, cleanup: () => {} });
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
    baseSha: revSha(git, base, project),
    created: true,
    git,
    deps: { ...resolved, available: resolved.available && lockMatches(git, project, dir) },
    // task-worktree — заготовка под задачи Jira: живёт дольше рана, сама не убирается.
    cleanup: (keep) => {
      if (keep || mode === 'task-worktree') {
        onEvent(`📁 Worktree сохранён: ${dir}`);
        return;
      }
      removeWorktree(git, dir, branch, onEvent);
    },
  });
}

// Уборка worktree и ветки: одна на acquireWorkspace, gc и на доигрывание упавшего рана.
export function removeWorktree(gitOrProjectDir, dir, branch, onEvent = () => {}) {
  const git = typeof gitOrProjectDir === 'function' ? gitOrProjectDir : makeGit(gitOrProjectDir);
  try { git(['worktree', 'remove', '--force', dir]); } catch { /* уже удалён */ }
  try { git(['worktree', 'prune']); } catch { /* не критично */ }
  if (branch) {
    try { git(['branch', '-D', branch]); } catch { /* не критично */ }
  }
  if (existsSync(dir)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* не критично */ }
  }
  onEvent('🧹 Временный worktree и ветка удалены.');
}

// Переподключиться к worktree сохранённого рана: resume не создаёт изоляцию заново,
// а возвращает тот же объект, что acquireWorkspace. Ноль новых git-команд.
export function reopenWorkspace({
  mode = 'ephemeral-worktree',
  project,
  dir,
  branch,
  base,
  git = makeGit(project),
  deps = {},
  onEvent = () => {},
}) {
  return workspace({
    dir,
    branch,
    base,
    created: mode !== 'checkout',
    git,
    deps,
    cleanup: mode === 'checkout'
      ? () => {}
      : (keep) => {
          // task-worktree живёт дольше рана (AGENTS.md): resume/publish не сносит ветку задачи.
          if (keep || mode === 'task-worktree') {
            onEvent(`📁 Worktree сохранён: ${dir}`);
            return;
          }
          removeWorktree(git, dir, branch, onEvent);
        },
  });
}

// Переподключение к worktree сохранённого рана по его meta: одно место маппинга полей
// для resume и publish, чтобы они не разъехались.
export function reopenRunWorkspace(meta, action, { onEvent = () => {}, deps } = {}) {
  return reopenWorkspace({
    mode: meta.isolation ?? action.isolation,
    project: meta.project_dir,
    dir: meta.worktree,
    branch: meta.branch,
    base: meta.base,
    onEvent,
    deps: deps ?? { available: meta.facts?.deps_available ?? true },
  });
}

function revSha(git, ref, cwd) {
  try { return git(['rev-parse', ref], cwd); } catch { return null; }
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
