import { homedir } from 'node:os';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CliError } from './errors.js';

// Путь конфига не меняется вслед за именем пакета: рабочий файл уже лежит в gl-helper,
// и переезд молча осиротил бы его. Новый путь читается первым, если владелец его завёл.
export const CONFIG_PATHS = [
  path.join(homedir(), '.config', 'fs-harness', 'config.json'),
  path.join(homedir(), '.config', 'gl-helper', 'config.json'),
];
export const CONFIG_PATH = CONFIG_PATHS[1];

export const configPath = () => CONFIG_PATHS.find(existsSync) ?? CONFIG_PATH;

const PROJECT_DEFAULT = { repo: '', host: '', dir: '', agent: 'cc', buildJob: '', targetBranch: '', branchPattern: 'feature/{key}', checks: [], jira: { baseUrl: '', email: '', projectKey: '', componentField: 'Компонент' }, growthbook: { baseUrl: '', project: '', env: 'production' }, dict: { baseUrl: '' } };

export const DEFAULTS = {
  version: 2,
  activeProject: '',
  // Пустые значения — намеренно: инструмент не привязан к конкретному GitLab.
  // Заполняются через fsh config init, конфиг или env (GL_HELPER_REPO / GL_HELPER_HOST).
  projects: {},
  agentArgs: {
    claude: ['--dangerously-skip-permissions'],
  },
  // Агент — это программа плюс провайдер в env. Claude Code один и тот же, меняются
  // baseUrl, модели и ключ; keyFile читается в момент запуска, в конфиге ключей нет.
  agents: {
    cc: { bin: 'claude', args: ['--dangerously-skip-permissions'] },
    claude: { bin: 'claude', args: ['--dangerously-skip-permissions'] }, // прежнее имя cc
    ccq: {
      bin: 'claude',
      args: ['--dangerously-skip-permissions'],
      keyFile: '~/.alibaba_key',
      env: {
        ANTHROPIC_BASE_URL: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic',
        ANTHROPIC_MODEL: 'qwen3.8-max',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'qwen3.6-flash',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'qwen3.8-max',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'qwen3.8-max',
        CLAUDE_CODE_SUBAGENT_MODEL: 'qwen3.7-max',
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: '983616',
      },
    },
    cco: {
      bin: 'claude',
      args: ['--dangerously-skip-permissions'],
      keyFile: '~/.openrouter_key',
      env: {
        ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
        ANTHROPIC_MODEL: 'z-ai/glm-5.3-flash',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'z-ai/glm-5.3-flash',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'z-ai/glm-5.3-flash',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'z-ai/glm-5.3-flash',
        CLAUDE_CODE_SUBAGENT_MODEL: 'z-ai/glm-5.3-flash',
      },
    },
    ccd: {
      bin: 'claude',
      args: ['--dangerously-skip-permissions'],
      keyFile: '~/.deepseek_key',
      env: {
        ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
        ANTHROPIC_MODEL: 'deepseek-v4-pro',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-flash',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-pro',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-pro',
        CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-flash',
      },
    },
    // Планировщик задач: claude на opus с максимальным reasoning effort.
    opus: { bin: 'claude', args: ['--dangerously-skip-permissions', '--model', 'opus', '--effort', 'xhigh'] },
    // agy (Antigravity CLI) — опционален: нет в PATH, мастер молча берёт cc.
    agy: { bin: 'agy', family: 'agy', args: ['--dangerously-skip-permissions'] },
    // Исполнитель задач: gemini flash high через agy.
    gemini: { bin: 'agy', family: 'agy', args: ['--dangerously-skip-permissions', '--model', 'gemini-3.8-flash-high'] },
  },
  // Мастер по самому fsh (fsh ask, клавиша A в TUI). Профиль из agents.
  chat: { agent: 'agy' },
  workspace: {
    root: '~/.local/state/fs-harness/worktrees',
    deps: { strategy: 'clone' },
  },
  // Watcher: опрос по команде и фоновый демон (fsh watch --daemon). enabled и intervalSeconds
  // можно переопределить на проект, ttlSeconds — окно дедупликации заданий в очереди.
  // 300 с, а не 60: один опрос большого репозитория занимает под минуту, и на 60 демон
  // опрашивал бы непрерывно.
  watch: { enabled: true, intervalSeconds: 300, ttlSeconds: 86400 },
  // Починка CI: сколько раз ci-fix возьмётся за один и тот же MR, прежде чем отдать его человеку.
  ci: { maxRetries: 2 },
  // Пустой chat_id / bot_token — уведомления просто не шлются: интеграция необязательная.
  // approvals — гейт pre-push ждёт кнопку в Telegram, а не пушит сам.
  // allowed_user_ids пуст — бот не стартует: пустой список это «никто», не «все».
  telegram: { chat_id: '', bot_token: '', allowed_user_ids: [], approvals: false },
  // Сообщения в рабочие чаты от имени человека. channels — канал на сценарий: ключ сценария
  // (review) → id канала. Пусто — команда mm просто не настроена.
  mattermost: { baseUrl: '', channels: {} },
  // Судья сменный, и профиль выбирается на каждую роль отдельно: роли различаются
  // по цене на порядки. Список у роли — фолбэк: первый ответивший выигрывает.
  judge: {
    enabled: true,
    maxRevise: 1, // сколько раз судья может вернуть работу агенту на доделку
    profiles: {
      'opus-cli': { provider: 'cli', bin: 'claude', model: 'opus', effort: 'xhigh' },
      'haiku-cli': { provider: 'cli', bin: 'claude', model: 'haiku', effort: 'medium' },
    },
    roles: {
      acceptance: ['opus-cli'],
      'task-acceptance': ['opus-cli'],
      'task-review': ['opus-cli'],
      'mr-review': ['opus-cli'],
      'ci-acceptance': ['opus-cli'],
      'model-pick': ['haiku-cli', 'opus-cli'],
      'event-triage': ['haiku-cli', 'opus-cli'],
    },
  },
};

// v1 → v2 в памяти. На диск ничего не пишется, пока владелец не скажет config migrate:
// старый конфиг обязан работать бесконечно.
export function migrateConfig(user) {
  if (user?.version === 2) return user;
  const { repo = '', host = '', projectDir = '', agent, jira, growthbook, dict, buildJob, targetBranch, checks, ...rest } = user ?? {};
  // Пустой v1 (конфига нет вовсе) не превращаем в проект-пустышку.
  if (!repo && !projectDir) return { version: 2, activeProject: '', projects: {}, ...rest };
  const name = path.basename(projectDir || '') || repo.split('/')[1] || repo;
  return {
    version: 2,
    activeProject: name,
    projects: {
      [name]: {
        repo,
        host,
        dir: projectDir,
        ...(agent ? { agent } : {}),
        ...(buildJob ? { buildJob } : {}),
        ...(targetBranch ? { targetBranch } : {}),
        ...(checks ? { checks } : {}),
        ...(jira ? { jira } : {}),
        ...(growthbook ? { growthbook } : {}),
        ...(dict ? { dict } : {}),
      },
    },
    ...rest,
  };
}

export function readRawConfig(file = configPath()) {
  const target = file || configPath();
  if (!target || !existsSync(target)) return null;
  try {
    return JSON.parse(readFileSync(target, 'utf8'));
  } catch (err) {
    throw new CliError(`Конфиг ${target} повреждён (${err.message}). Поправь или удали файл.`, 1, 'config_invalid');
  }
}

// Выбор активного проекта: -P > FS_HARNESS_PROJECT > activeProject > единственный.
export function pickProject(cfgV2, { project, env = process.env } = {}) {
  const names = Object.keys(cfgV2.projects ?? {});
  const wanted = project || env.FS_HARNESS_PROJECT || cfgV2.activeProject || (names.length === 1 ? names[0] : '');
  if (!wanted) return { name: '', project: { ...PROJECT_DEFAULT } };
  const found = cfgV2.projects?.[wanted];
  if (!found) {
    throw new CliError(
      `Проекта "${wanted}" нет в конфиге. Есть: ${names.join(', ') || '—'}.`,
      1,
      'config_invalid',
    );
  }
  return { name: wanted, project: { ...PROJECT_DEFAULT, ...found, jira: { ...PROJECT_DEFAULT.jira, ...(found.jira || {}) } } };
}

// Плоские поля (repo, host, projectDir, jira) — алиасы активного проекта:
// команды про мультипроектность не знают и знать не должны.
export function loadConfig(env = process.env, { project, file } = {}) {
  const targetFile = file || configPath();
  const raw = readRawConfig(targetFile);
  const v2 = migrateConfig(raw ?? {});
  const { name, project: p } = pickProject(v2, { project, env });

  const cfg = {
    version: 2,
    configPath: targetFile,
    activeProject: name,
    projects: v2.projects ?? {},
    project: p,
    repo: env.GL_HELPER_REPO || p.repo,
    host: env.GL_HELPER_HOST || p.host,
    projectDir: p.dir,
    agent: p.agent,
    // Команды проверки проекта: их коды выхода уходят судье вместо слов агента.
    checks: p.checks ?? PROJECT_DEFAULT.checks,
    buildJob: p.buildJob,
    targetBranch: p.targetBranch,
    branchPattern: p.branchPattern || PROJECT_DEFAULT.branchPattern,
    jira: p.jira,
    growthbook: { ...PROJECT_DEFAULT.growthbook, ...(p.growthbook || {}) },
    dict: { ...PROJECT_DEFAULT.dict, ...(p.dict || {}) },
    agentArgs: { ...DEFAULTS.agentArgs, ...(v2.agentArgs || {}) },
    agents: { ...DEFAULTS.agents, ...(v2.agents || {}) },
    workspace: {
      ...DEFAULTS.workspace,
      ...(v2.workspace || {}),
      deps: { ...DEFAULTS.workspace.deps, ...(v2.workspace?.deps || {}), ...(p.deps || {}) },
    },
    watch: { ...DEFAULTS.watch, ...(v2.watch || {}), ...(p.watch || {}) },
    ci: { ...DEFAULTS.ci, ...(v2.ci || {}), ...(p.ci || {}) },
    telegram: { ...DEFAULTS.telegram, ...(v2.telegram || {}), ...(p.telegram || {}) },
    mattermost: {
      ...DEFAULTS.mattermost,
      ...(v2.mattermost || {}),
      ...(p.mattermost || {}),
      // Каналы сливаем, а не перекрываем: у проекта свой review поверх общих сценариев.
      channels: { ...(v2.mattermost?.channels || {}), ...(p.mattermost?.channels || {}) },
    },
    judge: {
      ...DEFAULTS.judge,
      ...(v2.judge || {}),
      profiles: { ...DEFAULTS.judge.profiles, ...(v2.judge?.profiles || {}) },
      roles: { ...DEFAULTS.judge.roles, ...(v2.judge?.roles || {}) },
    },
  };
  return cfg;
}

export function expandHome(p) {
  return p.startsWith('~') ? path.join(homedir(), p.slice(1)) : p;
}

export function writeDefaultConfig(file = CONFIG_PATH) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ ...DEFAULTS, projects: { '<имя-проекта>': PROJECT_DEFAULT } }, null, 2) + '\n');
  return file;
}

export function configInit() {
  const file = configPath();
  if (existsSync(file)) {
    throw new CliError(`Конфиг уже есть: ${file}. Отредактируй его или удали перед повторным init.`, 1, 'config_invalid');
  }
  return writeDefaultConfig(file);
}

export function writeMigrated(file = configPath()) {
  const target = file || configPath();
  const raw = readRawConfig(target);
  if (!raw) throw new CliError(`Конфига нет: ${target}. Сначала fsh config init.`, 1, 'config_invalid');
  if (raw.version === 2) return { file: target, already: true };
  copyFileSync(target, `${target}.v1.bak`);
  writeFileSync(target, JSON.stringify(migrateConfig(raw), null, 2) + '\n');
  return { file: target, backup: `${target}.v1.bak` };
}

// Запись выбранного агента в рабочий конфиг (поддерживает v1 и v2).
export function setConfigAgent(name, { file = configPath(), project } = {}) {
  const target = file || configPath();
  const raw = readRawConfig(target);
  if (!raw) throw new CliError(`Конфига нет: ${target}. Сначала fsh config init.`, 1, 'config_invalid');
  if (raw.version === 2) {
    const projName = project || raw.activeProject || Object.keys(raw.projects ?? {})[0];
    if (projName && raw.projects?.[projName]) {
      raw.projects[projName].agent = name;
    }
    raw.agent = name;
  } else {
    raw.agent = name;
  }
  writeFileSync(target, JSON.stringify(raw, null, 2) + '\n');
  return { file: target, agent: name };
}

