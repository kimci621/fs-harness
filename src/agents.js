import { readFileSync } from 'node:fs';
import { DEFAULTS, expandHome } from './config.js';
import { CliError } from './errors.js';

// Профиль агента — это одна и та же программа claude с другим провайдером в env.
// В шелле у владельца это алиасы и функции (cc, ccq, cco, ccd); spawn их не видит,
// поэтому провайдер описывается здесь, а ключ читается из файла на месте запуска.
export function resolveAgent(cfg, name) {
  const target = (name === 'co' && !cfg?.agents?.co) ? 'cco' : name;
  const agents = allAgents(cfg);
  const profile = agents[target];
  if (!profile) {
    throw new CliError(`Неизвестный агент "${name}". Есть: ${Object.keys(agents).sort().join(', ')}.`, 1, 'usage');
  }
  // agentArgs остаётся: в старых конфигах флаги агента лежат там.
  const args = cfg?.agentArgs?.[target] ?? profile.args ?? [];
  const env = { ...(profile.env ?? {}) };
  if (profile.keyFile) env.ANTHROPIC_AUTH_TOKEN = readKey(expandHome(profile.keyFile), target);
  return { name: target, bin: profile.bin ?? target, args, env, family: profile.family ?? 'claude' };
}

export const agentNames = (cfg) => Object.keys(allAgents(cfg)).sort();

// Дефолтные профили подмешиваем здесь, а не только в loadConfig: ctx бывает собран руками.
const allAgents = (cfg) => ({ ...DEFAULTS.agents, ...(cfg?.agents ?? {}) });

function readKey(file, name) {
  try {
    const key = readFileSync(file, 'utf8').trim();
    if (key) return key;
  } catch {
    // пусто ниже
  }
  throw new CliError(`Агенту "${name}" нужен ключ в ${file}, а его там нет.`, 1, 'secret_missing');
}
