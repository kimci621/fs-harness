// fsh up — боты и демон watch на переднем плане одной командой, токены Telegram из файлов.
// Ctrl+C гасит всех; упал один — гасим остальных, чтобы не остаться с половиной.
import path from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { spawn as nodeSpawn } from 'node:child_process';
import { CliError } from '../errors.js';

export const TOKEN_FILE = path.join(homedir(), '.tg_fs_harness_bot');
export const QA_TOKEN_FILE = path.join(homedir(), '.tg_qa_bot');

export function cmdUp(opts = {}, deps = {}) {
  const {
    env = process.env,
    tokenFile = TOKEN_FILE,
    qaTokenFile = QA_TOKEN_FILE,
    spawn = nodeSpawn,
    argv = [process.execPath, process.argv[1]],
    onSignal = (sig, fn) => process.on(sig, fn),
    log = console.error,
  } = deps;

  let token = env.FS_HARNESS_TELEGRAM;
  if (!token) {
    if (!existsSync(tokenFile)) {
      throw new CliError(`Нет токена бота: положи его в ${tokenFile} или экспортируй FS_HARNESS_TELEGRAM.`, 1, 'secret_missing');
    }
    token = readFileSync(tokenFile, 'utf8').trim();
  }

  let qaToken = env.FS_HARNESS_QA_TELEGRAM;
  if (!qaToken && existsSync(qaTokenFile)) {
    try { qaToken = readFileSync(qaTokenFile, 'utf8').trim(); } catch {}
  }

  const childEnv = { ...env, FS_HARNESS_TELEGRAM: token };
  if (qaToken) {
    childEnv.FS_HARNESS_QA_TELEGRAM = qaToken;
  }

  const commandList = [['bot'], ['watch', '--daemon']];
  if (qaToken) {
    commandList.push(['qa-bot']);
  } else {
    log(`⚠️  fsh up: QA-бот пропущен — нет ${qaTokenFile} или FS_HARNESS_QA_TELEGRAM. Чтобы запускать и QA-бота, положи токен нового бота в ${qaTokenFile}.`);
  }

  const [node, script] = argv;
  const children = commandList.map((args) => ({
    name: args.join(' '),
    proc: spawn(node, [script, ...args], { env: childEnv, stdio: 'inherit' }),
  }));
  log(`fsh up: ${children.map((c) => `${c.name} (pid ${c.proc.pid})`).join(', ')}. Ctrl+C — остановить.`);

  let stopping = false;
  const stopAll = (sig = 'SIGTERM') => {
    stopping = true;
    for (const { proc } of children) if (proc.exitCode === null && proc.signalCode === null) proc.kill(sig);
  };
  onSignal('SIGINT', () => stopAll('SIGINT'));
  onSignal('SIGTERM', () => stopAll('SIGTERM'));

  return new Promise((resolve, reject) => {
    let left = children.length;
    let failed = false;
    for (const { name, proc } of children) {
      proc.on('exit', (code, signal) => {
        if (!stopping) {
          failed = true;
          log(`fsh up: ${name} завершился (${signal ?? `код ${code}`}) — гашу остальных.`);
          stopAll();
        }
        if (--left === 0) {
          if (failed) reject(new CliError('fsh up: процесс упал, остановлены все.', 1, 'child_failed'));
          else resolve({ ok: true });
        }
      });
    }
  });
}
