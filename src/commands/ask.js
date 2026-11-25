import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync } from 'node:fs';
import { listRuns, readEvents, readRun, RUNS_DIR } from '../agent/journal.js';
import { resolveAgent } from '../agents.js';
import { renderTemplate } from '../prompts.js';
import { startChat } from '../chat.js';
import { CliError } from '../errors.js';

// Корень самого харнесса: мастер работает в нём, а не в проекте пользователя —
// чинить он должен fsh, и CLAUDE.md/AGENTS.md/PLAN.md лежат именно здесь.
export const HARNESS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const TAIL = 40; // хвост журнала в брифе: дальше промпт пухнет, а толку нет

const hhmmss = (at) => String(at ?? '').slice(11, 19);

// Событие рана → строка для брифа. logLine из tui/store.js не берём: он тянет fuse.js.
export function eventLine(e) {
  if (e.t === 'error') return `${hhmmss(e.at)} ❌ ${e.code ? `[${e.code}] ` : ''}${e.message ?? ''}`.trim();
  if (e.t === 'phase') return `${hhmmss(e.at)} фаза ${e.phase}${e.status ? ` ${e.status}` : ''}`;
  if (e.t === 'verdict') return `${hhmmss(e.at)} вердикт ${e.decision ?? ''} ${e.summary ?? ''}`.trim();
  if (e.t === 'log') return `${hhmmss(e.at)} ${e.text ?? ''}`.trim();
  return null;
}

// Последний ран с ошибкой; если таких нет — просто последний; каталог пуст — null.
export function lastFailedRun({ root = RUNS_DIR } = {}) {
  const runs = listRuns({ root });
  if (!runs.length) return null;
  let fallback = null;
  for (const r of runs) {
    const events = readEvents(r);
    const err = events.findLast?.((e) => e.t === 'error') ?? [...events].reverse().find((e) => e.t === 'error');
    const shaped = {
      id: r.id,
      dir: r.dir,
      action: r.action ?? '',
      created_at: r.created_at,
      error: err ? { code: err.code ?? '', message: err.message ?? '' } : null,
      tail: events.slice(-TAIL).map(eventLine).filter(Boolean),
    };
    if (err) return shaped;
    fallback ??= shaped;
  }
  return fallback;
}

// Артефакты рана перечисляем именами: агент прочитает сам, а в промпт они не влезут.
const artifactsOf = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f !== 'events.jsonl').sort() : []);

// Бриф мастеру. Конфиг сюда не попадает ни в каком виде: в нём живой токен Telegram.
export function buildAskBrief({ run, question, readOnly = false, repoDir = HARNESS_DIR }) {
  return renderTemplate('ask', {
    question: question ?? '',
    repo_dir: repoDir,
    run_id: run?.id ?? '',
    run_dir: run?.dir ?? '',
    action: run?.action ?? '',
    error_code: run?.error?.code ?? '',
    error_message: run?.error?.message ?? '',
    tail: (run?.tail ?? []).join('\n'),
    artifacts: run ? artifactsOf(run.dir).join(', ') : '',
    readonly: readOnly,
  }).text;
}

// Профиль мастера: --agent > chat.agent из конфига > opencode > cc.
// opencode опционален: нет в PATH - молча берём claude-профиль, дефолтный конфиг не ломается.
export function pickChatAgent(cfg, name) {
  const wanted = name || cfg?.chat?.agent || 'opencode';
  const agent = resolveAgent(cfg, wanted);
  if (!['opencode', 'agy'].includes(wanted) || hasBin(agent.bin)) return agent;
  return resolveAgent(cfg, 'cc');
}

// Кому задавать вопрос по очереди: выбранный, затем opencode (без него — claude) и claude.
// Явный --agent не подменяется: человек выбрал его сам.
export function askAgents(cfg, name) {
  const chain = name ? [pickChatAgent(cfg, name)] : [pickChatAgent(cfg, null), pickChatAgent(cfg, 'opencode'), resolveAgent(cfg, 'cc')];
  return chain.filter((a, i) => chain.findIndex((b) => b.name === a.name) === i);
}

// Агент не ответил (agy отказывает по региону, процесс закрылся) — спрашиваем следующего.
export async function askWithFallback(agents, ask, note) {
  for (const [i, agent] of agents.entries()) {
    try {
      return { agent, answer: await ask(agent) };
    } catch (err) {
      const next = agents[i + 1];
      if (err.code !== 'agent_failed' || !next) throw err;
      note(`⚠️ ${agent.name} не ответил (${err.message}), спрашиваю ${next.name}`);
    }
  }
}

function hasBin(bin) {
  if (bin.includes('/')) return existsSync(bin);
  return (process.env.PATH ?? '').split(path.delimiter).some((d) => d && existsSync(path.join(d, bin)));
}

// fsh ask [вопрос] [--run <id>] — мастер по самому fsh.
// С вопросом — один ход только на чтение. Без вопроса из TUI поднимается окно чата,
// из голого терминала — подсказка: диалога без вкладки у CLI нет.
export async function cmdAsk(ctx, args, opts = {}) {
  const question = args.join(' ').trim();
  if (!question) {
    throw new CliError('Использование: fsh ask "<вопрос>" [--run <id>]. Диалог с мастером — клавиша A в fsh tui.', 1, 'usage');
  }
  const run = opts.run ? shapeRun(readRun(opts.run)) : lastFailedRun();
  const quiet = opts.asObject || opts.json;
  const ask = async (agent) => {
    const chat = startChat({
      agent,
      cwd: HARNESS_DIR,
      env: { ...process.env, ...agent.env },
      readOnly: true, // без TTY правки не спрашивают и не показывают — только разбор
      onEvent: (e) => {
        if (!quiet && e.t === 'activity') process.stderr.write(`\r\x1b[K${e.text}\n`);
      },
    });
    try {
      return await chat.send(buildAskBrief({ run, question, readOnly: true }));
    } finally {
      chat.close();
    }
  };
  const { agent, answer } = await askWithFallback(askAgents(ctx.cfg, opts.agent), ask, (line) => process.stderr.write(`${line}\n`));
  const result = { ok: true, run: run?.id ?? null, error_code: run?.error?.code ?? null, agent: agent.name, answer };
  if (!quiet) console.log(answer);
  return result;
}

// readRun отдаёт сырой ран — приводим к той же форме, что lastFailedRun.
function shapeRun(r) {
  const events = readEvents(r);
  const err = [...events].reverse().find((e) => e.t === 'error');
  return {
    id: r.id,
    dir: r.dir,
    action: r.meta?.action ?? '',
    created_at: r.meta?.created_at ?? '',
    error: err ? { code: err.code ?? '', message: err.message ?? '' } : null,
    tail: events.slice(-TAIL).map(eventLine).filter(Boolean),
  };
}
