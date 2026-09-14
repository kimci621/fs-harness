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

const PROJECT_DEFAULT = { repo: '', host: '', dir: '', agent: 'cc', buildJob: '', targetBranch: '', branchPattern: 'feature/{key}', jira: { baseUrl: '', email: '', projectKey: '', componentField: 'Компонент' }, growthbook: { baseUrl: '', project: '', env: 'production' } };

export const DEFAULTS = {
  version: 2,
  activeProject: '',
  // Пустые значения — намеренно: инструмент не привязан к конкретному GitLab.
  // Заполняются через fsh config init, конфиг или env (GL_HELPER_REPO / GL_HELPER_HOST).
  projects: {},
  agentArgs: {
    claude: ['--dangerously-skip-permissions'],
    pi: [],
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
        ANTHROPIC_BASE_URL: 'https://openrouter.ai/api/v1',
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
    pi: { bin: 'pi', family: 'pi', args: [] },
  },
  workspace: {
    root: '~/.local/state/fs-harness/worktrees',
    deps: { strategy: 'clone' },
  },
  // Пустой webhook — уведомления просто не шлются: интеграция необязательная.
  mattermost: { webhook: '' },
  // Судья сменный, и профиль выбирается на каждую роль отдельно: роли различаются
  // по цене на порядки. Список у роли — фолбэк: первый ответивший выигрывает.
  judge: {
    enabled: true,
    maxRevise: 1, // сколько раз судья может вернуть работу агенту на доделку
    profiles: {
      'opus-cli': { provider: 'cli', bin: 'claude', model: 'opus', effort: 'xhigh' },
      'haiku-cli': { provider: 'cli', bin: 'claude', model: 'haiku', effort: 'medium' },
      local: { provider: 'openai', baseUrl: 'http://127.0.0.1:1234/v1', model: 'local-model' },
    },
    roles: {
      acceptance: ['opus-cli'],
      'task-acceptance': ['opus-cli'],
      'mr-review': ['opus-cli'],
      'model-pick': ['local', 'opus-cli'],
      'event-triage': ['local', 'opus-cli'],
    },
  },
};

// v1 → v2 в памяти. На диск ничего не пишется, пока владелец не скажет config migrate:
// старый конфиг обязан работать бесконечно.
export function migrateConfig(user) {
  if (user?.version === 2) return user;
  const { repo = '', host = '', projectDir = '', agent, jira, growthbook, buildJob, targetBranch, ...rest } = user ?? {};
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
        ...(jira ? { jira } : {}),
        ...(growthbook ? { growthbook } : {}),
      },
    },
    ...rest,
  };
}

export function readRawConfig(file = configPath()) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new CliError(`Конфиг ${file} повреждён (${err.message}). Поправь или удали файл.`, 1, 'config_invalid');
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
export function loadConfig(env = process.env, { project, file = configPath() } = {}) {
  const raw = readRawConfig(file);
  const v2 = migrateConfig(raw ?? {});
  const { name, project: p } = pickProject(v2, { project, env });

  const cfg = {
    version: 2,
    configPath: file,
    activeProject: name,
    projects: v2.projects ?? {},
    project: p,
    repo: env.GL_HELPER_REPO || p.repo,
    host: env.GL_HELPER_HOST || p.host,
    projectDir: p.dir,
    agent: p.agent,
    buildJob: p.buildJob,
    targetBranch: p.targetBranch,
    branchPattern: p.branchPattern || PROJECT_DEFAULT.branchPattern,
    jira: p.jira,
    growthbook: { ...PROJECT_DEFAULT.growthbook, ...(p.growthbook || {}) },
    agentArgs: { ...DEFAULTS.agentArgs, ...(v2.agentArgs || {}) },
    agents: { ...DEFAULTS.agents, ...(v2.agents || {}) },
    workspace: {
      ...DEFAULTS.workspace,
      ...(v2.workspace || {}),
      deps: { ...DEFAULTS.workspace.deps, ...(v2.workspace?.deps || {}), ...(p.deps || {}) },
    },
    mattermost: { ...DEFAULTS.mattermost, ...(v2.mattermost || {}), ...(p.mattermost || {}) },
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

// Запись v2 на диск: рядом остаётся .v1.bak, чтобы откат был копированием файла.
export function writeMigrated(file = configPath()) {
  const raw = readRawConfig(file);
  if (!raw) throw new CliError(`Конфига нет: ${file}. Сначала fsh config init.`, 1, 'config_invalid');
  if (raw.version === 2) return { file, already: true };
  copyFileSync(file, `${file}.v1.bak`);
  writeFileSync(file, JSON.stringify(migrateConfig(raw), null, 2) + '\n');
  return { file, backup: `${file}.v1.bak` };
}
