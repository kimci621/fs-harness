import { spawnSync } from 'node:child_process';
import { GIT_MAX_BUFFER } from './workspace.js';

// Коды выхода проверок проекта снимаем сами. Судья по рубрике не верит словам агента,
// а до сих пор в фактах не было ни одного кода выхода — он честно упирался в это блокером.
export const CHECK_TIMEOUT_MS = 20 * 60 * 1000;

// Сколько раз добивать упавшую проверку. Один — потому что живой флейк (тест, зависящий
// от тайминга под параллельной нагрузкой) уже на втором заходе зелёный, а настоящую поломку
// лишний заход не спрячет: exit_code останется ненулевым и судья его увидит.
export const CHECK_RETRIES = 1;

export function runChecks(commands, cwd, { say = () => {}, tailLines = 15, timeout = CHECK_TIMEOUT_MS, retries = CHECK_RETRIES } = {}) {
  return commands.map((cmd) => {
    let attempts = 0;
    let firstExit = null;
    let res = null;
    let exitCode = null;
    for (;;) {
      attempts += 1;
      say(attempts === 1 ? `🧪 ${cmd}…` : `🔁 ${cmd}: повтор ${attempts}/${retries + 1}…`);
      res = spawnSync(cmd, { cwd, shell: true, encoding: 'utf8', timeout, maxBuffer: GIT_MAX_BUFFER });
      const timedOut = res.error?.code === 'ETIMEDOUT';
      exitCode = timedOut ? `таймаут ${Math.round(timeout / 60000)} мин` : res.status;
      if (firstExit === null) firstExit = exitCode;
      // Таймаут не повторяем: если не уложились в бюджет, второй заход сожжёт столько же зря.
      if (exitCode === 0 || timedOut || attempts > retries) break;
      say(`   ${cmd}: код ${exitCode} — пробую ещё раз (флейк?)`);
    }
    const out = `${res.stdout ?? ''}\n${res.stderr ?? ''}`.trim().split('\n').filter(Boolean);
    const flake = attempts > 1 && exitCode === 0 ? ` (со ${attempts}-й попытки — флейк)` : '';
    say(`   ${cmd}: ${exitCode === 0 ? `ok${flake}` : `код ${exitCode}`}`);
    return {
      cmd,
      exit_code: exitCode,
      // Повтор — часть факта, а не служебная мелочь: судья должен видеть, что проверка
      // была флейком, а не молча принять зелёный со второго раза за чистую работу.
      ...(attempts > 1 ? { attempts, first_exit_code: firstExit } : {}),
      tail: out.slice(-tailLines).join('\n'),
    };
  });
}

// Отдельная строка вместо пустого списка: судья должен видеть разницу между
// «проверки прогнаны и зелёные» и «проверок нет — их некому было запускать».
export function checksFact(commands, depsAvailable) {
  if (!commands.length) return 'не настроены (projects.<имя>.checks в конфиге)';
  if (!depsAvailable) return 'не прогонялись: в worktree нет node_modules';
  return null;
}
