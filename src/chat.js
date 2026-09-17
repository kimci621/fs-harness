import { randomUUID } from 'node:crypto';
import { spawnAgent } from './agent/spawn.js';
import { parseClaudeLine, parseAgyLine } from './agent/stream.js';
import { CliError } from './errors.js';

// Чат с агентом: многоходовый диалог без своей машинерии сессий.
//
// Два транспорта, разница не в нашем удобстве, а в том, что умеют сами CLI:
//   stream — claude и agy принимают --input-format stream-json: один живой процесс,
//            NDJSON-строка на реплику, контекст держит сам агент. Id сессии не нужен.
//   spawn  — pi потокового ввода не умеет: ход = отдельный процесс с тем же --session-id.
//
// readOnly — режим «объясни, не трогай»: у каждого семейства свой флаг, общего нет.
export const WIRE = {
  claude: {
    mode: 'stream',
    args: ['--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '-p'],
    readOnly: ['--permission-mode', 'plan', '--permission-prompts', 'none'],
    resume: (id) => ['--resume', id],
    line: (text) => `${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`,
    parse: parseClaudeLine,
  },
  // Порядок важен: -p= у agy забирает следующий аргумент как промпт, поэтому он последний.
  agy: {
    mode: 'stream',
    args: ['--input-format', 'stream-json', '--output-format', 'stream-json', '--print-timeout', '30m', '-p='],
    readOnly: ['--mode', 'plan'],
    resume: (id) => ['--conversation', id],
    line: (text) => `${JSON.stringify({ event: 'user', message: { role: 'user', content: text } })}\n`,
    parse: parseAgyLine,
  },
  pi: {
    mode: 'spawn',
    args: ['-p'],
    readOnly: null,
    resume: (id) => ['--session-id', id],
    parse: parseClaudeLine,
  },
};

// Живой чат. onEvent получает {t:'activity'|'delta'|'answer'|'error', text}.
// send(text) резолвится финальным текстом ответа; ходы идут строго по одному.
export function startChat({ agent, cwd, env, readOnly = false, onEvent = () => {}, spawnImpl = spawnAgent }) {
  const wire = WIRE[agent.family];
  if (!wire) throw new CliError(`Чат не умеет семейство «${agent.family}» (профиль ${agent.name}). Есть: ${Object.keys(WIRE).join(', ')}.`, 1, 'usage');
  if (readOnly && !wire.readOnly) {
    throw new CliError(`Профиль ${agent.name} (${agent.family}) не умеет режим только чтения. Для вопроса без TTY возьми --agent с семейством claude или agy.`, 1, 'usage');
  }

  // В read-only снимаем обход разрешений из профиля: иначе флаг режима ничего не значит.
  const profileArgs = readOnly ? agent.args.filter((a) => a !== '--dangerously-skip-permissions') : agent.args;
  const baseArgs = [...profileArgs, ...(readOnly ? wire.readOnly : []), ...wire.args];

  let session = wire.mode === 'spawn' ? randomUUID() : null;
  let started = false; // была ли уже реплика: только со второй нужен resume
  let proc = null;
  let pending = null;
  let turnText = ''; // текст хода для семейств без события result (pi печатает просто текстом)

  const settle = (fn, value) => {
    const p = pending;
    pending = null;
    if (p) p[fn](value);
  };

  function consume(line) {
    const m = wire.parse(line);
    if (m.session && !session) session = m.session;
    if (m.passthrough) {
      turnText += (turnText ? '\n' : '') + m.passthrough;
      onEvent({ t: 'activity', text: m.passthrough });
    }
    if (m.activity) onEvent({ t: 'activity', text: m.activity });
    if (m.delta) onEvent({ t: 'delta', text: m.delta });
    if (m.error) {
      onEvent({ t: 'error', text: m.error });
      return settle('reject', new CliError(m.error, 1, 'agent_failed'));
    }
    if (m.result !== null && m.result !== undefined) {
      onEvent({ t: 'answer', text: m.result });
      settle('resolve', m.result);
    }
  }

  function launch(input) {
    const args = [...baseArgs, ...(started && session ? wire.resume(session) : [])];
    const p = spawnImpl({ bin: agent.bin, args, cwd, env, input, keepStdin: wire.mode === 'stream' });
    p.events.on((e) => {
      if (e.t === 'log' && e.stream === 'stdout') return consume(e.text);
      if (e.t === 'log') return void onEvent({ t: 'activity', text: e.text });
      // Процесс умер, не ответив: реплика висла бы вечно, поэтому обрываем явно.
      if (e.t === 'done' || e.t === 'error') {
        if (wire.mode === 'stream') proc = null;
        // Семейство без события result (pi) отвечает просто текстом — он и есть ответ хода.
        if (e.ok && turnText) return void settle('resolve', turnText);
        settle('reject', new CliError(`Агент ${agent.name} закрылся, не ответив${e.code ? ` (код ${e.code})` : ''}.`, 1, 'agent_failed'));
      }
    });
    p.result.catch(() => {}); // провал уже разобран событием
    return p;
  }

  return {
    get session() {
      return session;
    },

    send(text) {
      if (pending) throw new CliError('Предыдущая реплика ещё в работе.', 1, 'usage');
      turnText = '';
      const answer = new Promise((resolve, reject) => {
        pending = { resolve, reject };
      });
      if (wire.mode === 'spawn') {
        launch(text);
      } else {
        // Процесс мог умереть между ходами (таймаут, падение) — поднимаем и продолжаем сессию.
        if (!proc) proc = launch('');
        proc.write(wire.line(text));
      }
      started = true;
      return answer;
    },

    // Закрываем ввод, а не бьём по процессу: убитый на живом stdin агент ругается в stderr.
    // Если он не ушёл сам за пару секунд — тогда уже SIGTERM.
    close() {
      const p = proc;
      proc = null;
      if (p) {
        p.end?.();
        const t = setTimeout(() => p.abort(), 2000);
        t.unref?.();
        p.result?.then(() => clearTimeout(t), () => clearTimeout(t));
      }
      settle('reject', new CliError('Чат закрыт.', 0, 'canceled'));
    },
  };
}
