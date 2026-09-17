import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { CliError } from './errors.js';

export const KEYCHAIN_SERVICE = 'fs-harness';

// Уже настроенные на машине имена принимаем как алиасы: заводить второй ключ
// под то, что работает, смысла нет.
const ALIASES = {
  openrouter: ['OPENROUTER_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  jira: ['JIRA_API_TOKEN'],
  telegram: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_TOKEN'],
};

// Ключ, который на машине уже лежит файлом и используется другими инструментами владельца.
// Заводить ему вторую копию в keychain — значит развести две правды.
const FILES = { growthbook: path.join(homedir(), '.growthbook_apikey') };

// Токен словаря и так лежит в .env бэкенда: читаем его оттуда, а не заводим вторую правду.
const ENV_FILES = { dict: path.join(homedir(), 'Projects', 'fitstars-api4', '.env') };

function readEnvFileValue(file, name) {
  try {
    const line = readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith(`${name}=`));
    return line ? line.slice(name.length + 1).trim().replace(/^"|"$/g, '') : null;
  } catch {
    return null; // нет файла — не беда, дальше по лесенке
  }
}

export const envNames = (name) => [`FS_HARNESS_${name.toUpperCase().replace(/-/g, '_')}`, ...(ALIASES[name] || [])];

export const addCommand = (name) =>
  `security add-generic-password -s ${KEYCHAIN_SERVICE} -a ${name} -w '<ключ>'`;

// Лесенка: env → keychain → файл из FILES → .env из ENV_FILES → внятная ошибка.
// required:false — вернуть null вместо ошибки (doctor спрашивает, а не требует).
export function readSecret(name, { env = process.env, required = true, exec = keychainRead } = {}) {
  for (const n of envNames(name)) {
    if (env[n]) return env[n];
  }
  const fromKeychain = exec(name);
  if (fromKeychain) return fromKeychain;
  const fromFile = name in FILES ? readFile(FILES[name]) : null;
  if (fromFile) return fromFile;
  const fromEnvFile = ENV_FILES[name] ? readEnvFileValue(ENV_FILES[name], 'REST_TOKEN') : null;
  if (fromEnvFile) return fromEnvFile;
  if (!required) return null;
  const where = FILES[name]
    ? `положи в ${FILES[name]}, заведи в keychain:\n  ${addCommand(name)}`
    : ENV_FILES[name]
      ? `укажи REST_TOKEN в ${ENV_FILES[name]} или заведи в keychain:\n  ${addCommand(name)}`
      : `заведи в keychain:\n  ${addCommand(name)}`;
  throw new CliError(
    `Нет ключа "${name}". ${where}\nили экспортируй ${envNames(name)[0]}.`,
    1,
    'secret_missing',
  );
}

// Запись ключа в keychain: нужна там, где ключ добывает сама команда (fsh mm login),
// а не человек руками. -U перезаписывает существующую запись.
// ponytail: значение уходит аргументом, то есть на секунду видно в `ps`. Машина личная,
// ключ сессионный; если это перестанет устраивать — writeSecret переводится на файл-посредник.
export function writeSecret(name, value, { exec = keychainWrite } = {}) {
  if (!value) throw new CliError(`Нечего писать в keychain под именем "${name}": пустое значение.`, 1, 'usage');
  exec(name, value);
  return { service: KEYCHAIN_SERVICE, account: name };
}

function keychainWrite(name, value) {
  try {
    execFileSync('security', ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', name, '-w', value], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (err) {
    throw new CliError(`Не удалось записать ключ "${name}" в keychain: ${err.message}`, 1, 'secret_missing');
  }
}

function readFile(file) {
  try {
    return file ? readFileSync(file, 'utf8').trim() : null;
  } catch {
    return null; // нет файла — это не ошибка, дальше по лесенке
  }
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
