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
export function spawnAgent({ bin, args = [], cwd, env, signal, killGraceMs = 5000 }) {
  const events = createEventStream();
  const child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });

  const pipe = (stream, name) =>
    new Promise((resolve) => {
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      rl.on('line', (text) => events.push({ t: 'log', stream: name, text }));
      rl.on('close', resolve);
    });
  const drained = Promise.all([pipe(child.stdout, 'stdout'), pipe(child.stderr, 'stderr')]);

  let killTimer = null;
  const abort = () => {
    if (child.exitCode !== null || child.signalCode) return;
    child.kill('SIGTERM');
    killTimer = setTimeout(() => child.kill('SIGKILL'), killGraceMs);
    killTimer.unref?.();
  };
  if (signal) {
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  }

  const result = new Promise((resolve, reject) => {
    child.on('error', (err) => {
      events.push({ t: 'error', code: 'spawn_failed', message: err.message });
      events.close();
      reject(err);
    });
    child.on('close', async (code, sig) => {
      await drained;
      clearTimeout(killTimer);
      const done = { ok: code === 0, code, signal: sig };
      events.push({ t: 'done', ...done });
      events.close();
      resolve(done);
    });
  });

  return { events, result, abort };
}
