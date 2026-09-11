import { homedir } from 'node:os';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CliError } from './errors.js';

export const CONFIG_PATH = path.join(homedir(), '.config', 'gl-helper', 'config.json');

export const DEFAULTS = {
  // Пустые значения — намеренно: инструмент не привязан к конкретному GitLab.
  // Заполняются через fsh config init, конфиг или env (GL_HELPER_REPO / GL_HELPER_HOST).
  repo: process.env.GL_HELPER_REPO || '',
  host: process.env.GL_HELPER_HOST || '',
  projectDir: '',
  agent: 'claude',
  agentArgs: {
    claude: ['--dangerously-skip-permissions'],
    pi: [],
  },
  // Судья сменный, и профиль выбирается на каждую роль отдельно: роли различаются
  // по цене на порядки. Список у роли — фолбэк: первый ответивший выигрывает.
  judge: {
    profiles: {
      'opus-cli': { provider: 'cli', bin: 'claude', model: 'opus', effort: 'xhigh' },
      'haiku-cli': { provider: 'cli', bin: 'claude', model: 'haiku', effort: 'medium' },
      local: { provider: 'openai', baseUrl: 'http://127.0.0.1:1234/v1', model: 'local-model' },
    },
    roles: {
      acceptance: ['opus-cli'],
      'mr-review': ['opus-cli'],
      'model-pick': ['local', 'opus-cli'],
      'event-triage': ['local', 'opus-cli'],
    },
  },
};

export function loadConfig(env = process.env) {
  const cfg = {
    ...DEFAULTS,
    agentArgs: { ...DEFAULTS.agentArgs },
    judge: { profiles: { ...DEFAULTS.judge.profiles }, roles: { ...DEFAULTS.judge.roles } },
  };
  if (existsSync(CONFIG_PATH)) {
    try {
      const user = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
      cfg.repo = user.repo || cfg.repo;
      cfg.host = user.host || cfg.host;
      cfg.projectDir = user.projectDir || cfg.projectDir;
      cfg.agent = user.agent || cfg.agent;
      cfg.agentArgs = { ...cfg.agentArgs, ...(user.agentArgs || {}) };
      cfg.judge = {
        profiles: { ...cfg.judge.profiles, ...(user.judge?.profiles || {}) },
        roles: { ...cfg.judge.roles, ...(user.judge?.roles || {}) },
      };
    } catch (err) {
      throw new CliError(`Конфиг ${CONFIG_PATH} повреждён (${err.message}). Поправь или удали файл.`);
    }
  }
  if (env.GL_HELPER_REPO) cfg.repo = env.GL_HELPER_REPO;
  if (env.GL_HELPER_HOST) cfg.host = env.GL_HELPER_HOST;
  return cfg;
}

export function expandHome(p) {
  return p.startsWith('~') ? path.join(homedir(), p.slice(1)) : p;
}

export function writeDefaultConfig() {
  mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2) + '\n');
  return CONFIG_PATH;
}

export function configInit() {
  if (existsSync(CONFIG_PATH)) {
    throw new CliError(`Конфиг уже есть: ${CONFIG_PATH}. Отредактируй его или удали перед повторным init.`);
  }
  return writeDefaultConfig();
}
