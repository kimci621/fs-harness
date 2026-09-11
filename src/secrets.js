import { execFileSync } from 'node:child_process';
import { CliError } from './errors.js';

export const KEYCHAIN_SERVICE = 'fs-harness';

// Уже настроенные на машине имена принимаем как алиасы: заводить второй ключ
// под то, что работает, смысла нет.
const ALIASES = {
  openrouter: ['OPENROUTER_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  jira: ['JIRA_API_TOKEN'],
  mattermost: ['MATTERMOST_TOKEN'],
};

export const envNames = (name) => [`FS_HARNESS_${name.toUpperCase().replace(/-/g, '_')}`, ...(ALIASES[name] || [])];

export const addCommand = (name) =>
  `security add-generic-password -s ${KEYCHAIN_SERVICE} -a ${name} -w '<ключ>'`;

// Лесенка: env → keychain → внятная ошибка с готовой командой заведения.
// required:false — вернуть null вместо ошибки (doctor спрашивает, а не требует).
export function readSecret(name, { env = process.env, required = true, exec = keychainRead } = {}) {
  for (const n of envNames(name)) {
    if (env[n]) return env[n];
  }
  const fromKeychain = exec(name);
  if (fromKeychain) return fromKeychain;
  if (!required) return null;
  throw new CliError(
    `Нет ключа "${name}". Заведи в keychain:\n  ${addCommand(name)}\nили экспортируй ${envNames(name)[0]}.`,
    1,
    'secret_missing',
  );
}

function keychainRead(name) {
  try {
    return execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', name, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null; // нет записи — это не ошибка, дальше по лесенке
  }
}
