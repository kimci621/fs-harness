import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createEventStream } from './events.js';

// Асинхронный запуск агента со стримом вывода. stdio:'inherit' больше нигде:
// строки идут событиями, а кто их рисует — дело потребителя (логгер, журнал, TUI).
//
// Возвращает { events, result, abort }:
//   events — поток {t:'log'|'done'|'error'}
//   result — промис {ok, code, signal}; на провале спавна реджектится
//   abort() — SIGTERM, через killGraceMs SIGKILL
//
// input — промпт в stdin. Аргументом он не идёт: дифф в задании судьи бывает в сотни
// килобайт, а argv на macOS ограничен мегабайтом на весь вызов.
export function spawnAgent({ bin, args = [], cwd, env, signal, input = null, keepStdin = false, killGraceMs = 5000 }) {
  const events = createEventStream();
  const child = spawn(bin, args, {
    cwd,
    env,
    detached: process.platform !== 'win32',
    stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  if (input !== null) {
    child.stdin.on('error', () => {}); // агент мог закрыться раньше, чем дочитал: это не наша авария
    // keepStdin — чат: ходов много, поток ввода закрывать нельзя, реплики дописываются write().
    if (keepStdin) { if (input) child.stdin.write(input); }
    else child.stdin.end(input);
  }

  const pipe = (stream, name) =>
    new Promise((resolve) => {
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      rl.on('line', (text) => events.push({ t: 'log', stream: name, text }));
      rl.on('close', resolve);
    });
  const drained = Promise.all([pipe(child.stdout, 'stdout'), pipe(child.stderr, 'stderr')]);

  const killProc = (sig) => {
    if (child.exitCode !== null || child.signalCode) return;
    try {
      if (process.platform !== 'win32' && child.pid) {
        process.kill(-child.pid, sig);
        return;
      }
    } catch {}
    try { child.kill(sig); } catch {}
  };

  let killTimer = null;
  const abort = () => {
    killProc('SIGTERM');
    if (!killTimer) {
      killTimer = setTimeout(() => killProc('SIGKILL'), killGraceMs);
      killTimer.unref?.();
    }
  };
  const cleanupSignal = () => {
    if (signal) signal.removeEventListener('abort', abort);
  };
  if (signal) {
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  }

  const result = new Promise((resolve, reject) => {
    child.on('error', (err) => {
      cleanupSignal();
      clearTimeout(killTimer);
      events.push({ t: 'error', code: 'spawn_failed', message: err.message });
      events.close();
      reject(err);
    });
    child.on('close', async (code, sig) => {
      cleanupSignal();
      await drained;
      clearTimeout(killTimer);
      const done = { ok: code === 0, code, signal: sig };
      events.push({ t: 'done', ...done });
      events.close();
      resolve(done);
    });
  });

  return { events, result, abort, write: (text) => child.stdin?.write(text), end: () => child.stdin?.end() };
}
