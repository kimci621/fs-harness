import { spawnSync } from 'node:child_process';
import { GIT_MAX_BUFFER } from './workspace.js';

// Коды выхода проверок проекта снимаем сами. Судья по рубрике не верит словам агента,
// а до сих пор в фактах не было ни одного кода выхода — он честно упирался в это блокером.
export const CHECK_TIMEOUT_MS = 20 * 60 * 1000;

export function runChecks(commands, cwd, { say = () => {}, tailLines = 15, timeout = CHECK_TIMEOUT_MS } = {}) {
  return commands.map((cmd) => {
    say(`🧪 ${cmd}…`);
    const res = spawnSync(cmd, { cwd, shell: true, encoding: 'utf8', timeout, maxBuffer: GIT_MAX_BUFFER });
    const exitCode = res.error?.code === 'ETIMEDOUT' ? `таймаут ${Math.round(timeout / 60000)} мин` : res.status;
    const out = `${res.stdout ?? ''}\n${res.stderr ?? ''}`.trim().split('\n').filter(Boolean);
    say(`   ${cmd}: ${exitCode === 0 ? 'ok' : `код ${exitCode}`}`);
    return { cmd, exit_code: exitCode, tail: out.slice(-tailLines).join('\n') };
  });
}

// Отдельная строка вместо пустого списка: судья должен видеть разницу между
// «проверки прогнаны и зелёные» и «проверок нет — их некому было запускать».
export function checksFact(commands, depsAvailable) {
  if (!commands.length) return 'не настроены (projects.<имя>.checks в конфиге)';
  if (!depsAvailable) return 'не прогонялись: в worktree нет node_modules';
  return null;
}
