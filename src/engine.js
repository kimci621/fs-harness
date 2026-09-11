import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { createEventStream } from './agent/events.js';
import { createRun, saveArtifact, readRun } from './agent/journal.js';
import { spawnAgent } from './agent/spawn.js';
import { renderTemplate } from './prompts.js';
import { judge, isApproved, formatVerdict } from './judge/index.js';
import { buildAcceptancePayload } from './judge/payload.js';
import { resolveMR } from './resolve.js';
import { expandHome } from './config.js';
import { acquireWorkspace, MODES as ISOLATION_MODES } from './workspace.js';
import { confirm } from './ui.js';
import { makeLogger, finish } from './output.js';
import { CliError } from './errors.js';

export { ISOLATION_MODES };
export const JUDGE_GATES = ['pre-push', 'advisory', 'none'];

// Движок действия. Порядок фаз один на все действия, различия живут в хуках декларации:
//   resolve target → precheck → (skip?) → context → isolate → prompt
//     → agent → verify → judge → publish → cleanup
//
// Возвращает AgentRun: { id, spec, on, [Symbol.asyncIterator], abort, result }.
// События (см. PLAN § B) — единственный источник вывода: CLI, MCP и TUI читают их, а не print.
export function runAction(spec, ctx, input, opts = {}) {
  const a = spec.action;
  const events = createEventStream();
  const ac = new AbortController();
  let runDir = null;
  let ws = null;
  let meta = null;
  let keep = Boolean(opts.keepWorktree);

  const emit = (ev) => events.push({ run: runDir?.id ?? null, ...ev });
  const x = {
    ctx,
    opts,
    input,
    signal: ac.signal,
    emit,
    say: (text) => emit({ t: 'log', stream: 'stdout', text }),
    phase: (name, status, detail) => emit({ t: 'phase', phase: name, status, detail }),
  };

  const result = go().then(
    (res) => {
      emit({ t: 'done', ok: true, result: res });
      events.close();
      return res;
    },
    (err) => {
      emit({ t: 'error', code: err.code ?? 'failed', message: err.message });
      events.close();
      throw err;
    },
  );

  async function go() {
    try {
      x.phase('context', 'start');
      x.target = a.target === 'none' ? null : await resolveMR(ctx.g, ctx.repo, input.query);
      x.pre = (await a.precheck(x)) ?? {};
      if (opts.dryRun) return a.dryRun(x);
      if (x.pre.skip) {
        x.phase('context', 'skip', x.pre.reason);
        return x.pre.result;
      }

      runDir = createRun(spec.name, { root: opts.runsDir });
      x.run = runDir;

      // Изоляция до контекста: промпту нужны и путь worktree, и доступность зависимостей.
      x.phase('isolate', 'start');
      ws = await acquireWorkspace({
        mode: a.isolation,
        action: spec.name,
        onEvent: x.say,
        deps: opts.cfg?.workspace?.deps,
        root: opts.cfg?.workspace?.root ? expandHome(opts.cfg.workspace.root) : undefined,
        ...x.pre.workspace,
      });
      x.ws = ws;
      x.before = a.isolation === 'checkout' ? ws.snapshot() : null;
      x.phase('isolate', 'done', ws.dir);

      x.vars = await a.context(x);
      x.phase('context', 'done');

      x.phase('prompt', 'start');
      const rendered = renderTemplate(a.prompt, x.vars, { projectDir: x.pre.projectDir });
      x.prompt = rendered.text;
      saveArtifact(runDir, 'prompt.md', rendered.text);
      meta = {
        id: runDir.id,
        action: spec.name,
        created_at: new Date().toISOString(),
        agent: x.opts.agent,
        prompt_source: rendered.source,
        worktree: ws.dir,
        branch: ws.branch,
        base: ws.base,
        base_sha: ws.baseSha,
        judge: { role: a.judge.role, profile: opts.judgeProfile ?? null },
        ...(x.pre.meta ?? {}),
      };
      saveArtifact(runDir, 'meta.json', meta);
      x.phase('prompt', 'done', rendered.source);

      if (!opts.yes && !opts.asObject && !confirm(`Запускаю агента ${opts.agent}. Продолжить? [y/N] `)) {
        throw new CliError('Отменено.', 0, 'canceled');
      }

      x.agentText = await runAgent(x);
      keep = true; // дальше в worktree лежит работа агента: любой провал ниже её не выбрасывает
      x.facts = await a.verify(x);
      if (x.before) ws.assertClean(x.before); // читающее действие не имеет права менять чекаут
      saveArtifact(runDir, 'agent.txt', x.agentText);
      saveArtifact(runDir, 'diff.patch', x.facts.diff ?? '');
      x.goal = a.goal(x);
      x.extra = a.judgeExtra ? a.judgeExtra(x) : '';
      saveArtifact(runDir, 'meta.json', {
        ...meta,
        head_sha: x.facts.head_sha,
        facts: { ...x.facts, diff: undefined },
        goal: x.goal,
        extra: x.extra,
      });
      x.phase('verify', 'done');

      x.verdict = await gate(x);
      x.published = (await a.publish(x)) ?? {};
      x.phase('publish', 'done');

      const res = a.result(x);
      keep = Boolean(opts.keepWorktree);
      saveArtifact(runDir, 'result.json', res);
      return res;
    } finally {
      // Без return: он проглатывал летящее исключение и действие возвращало undefined.
      if (ws) ws.cleanup(keep);
    }
  }

  // Гейт судьи. Любой исход кроме approve — push не происходит: бросаем.
  async function gate(x) {
    const { gate: mode, role } = a.judge;
    if (mode === 'none' || opts.noJudge) {
      if (a.writes) x.say('⚠ Судья отключён (--no-judge): push без приёмки.');
      return null;
    }
    x.phase('judge', 'start');
    x.say('⚖ Судья смотрит результат…');
    const verdict = await judge({
      role,
      cfg: opts.cfg,
      profile: opts.judgeProfile,
      signal: ac.signal,
      makeProvider: opts.makeProvider, // шов для тестов: судья без сети
      onDelta: (text) => emit({ t: 'delta', text }), // видно, что судья думает, а не завис
      payload: buildAcceptancePayload({
        goal: x.goal,
        facts: { ...x.facts, diff: undefined },
        extra: x.extra,
        diff: x.facts.diff,
        agentText: x.agentText,
      }),
    });
    saveArtifact(runDir, 'verdict.json', verdict);
    emit({ t: 'verdict', verdict });
    x.say(formatVerdict(verdict));
    x.phase('judge', 'done', verdict.decision);
    if (mode === 'pre-push' && !isApproved(verdict)) {
      throw new CliError(
        `${formatVerdict(verdict)}\n\nPush не сделан. Worktree сохранён: ${ws.dir}\nВердикт: ${runDir.dir}/verdict.json`,
        1,
        'judge_rejected',
      );
    }
    return verdict;
  }

  async function runAgent(x) {
    const agent = opts.agent;
    x.phase('agent', 'start', agent);
    x.say(`🤖 Запускаю ${agent}…`);
    const proc = spawnAgent({
      bin: agent,
      args: [...(opts.agentArgs ?? []), '-p', x.prompt],
      cwd: ws.dir,
      env: { ...process.env, GL_HELPER_MR: String(x.target?.iid ?? ''), GL_HELPER_REPO: ctx.repo },
      signal: ac.signal,
    });
    const out = [];
    proc.events.on((ev) => {
      if (ev.t !== 'log') return;
      if (ev.stream === 'stdout') out.push(ev.text);
      emit({ t: 'log', stream: ev.stream, text: ev.text });
    });
    let done;
    try {
      done = await proc.result;
    } catch (err) {
      throw new CliError(`Не удалось запустить ${agent}: ${err.message}`, 1, 'agent_failed');
    }
    if (!done.ok) throw new CliError(`Агент ${agent} завершился с кодом ${done.code}.`, 1, 'agent_failed');
    x.phase('agent', 'done');
    return out.join('\n');
  }

  return {
    get id() { return runDir?.id ?? null; },
    spec,
    on: (fn) => events.on(fn),
    [Symbol.asyncIterator]: () => events[Symbol.asyncIterator](),
    abort: () => ac.abort(),
    result,
  };
}

// CLI-обёртка над движком, одна на все действия: разбор аргументов, отрисовка событий,
// dry-run и --judge-only. Специфика действия живёт в его декларации, не здесь.
export async function runActionCLI(spec, ctx, args, opts = {}) {
  const a = spec.action;
  if (opts.judgeOnly) return judgeRun(opts.judgeOnly, opts);

  const [query] = args;
  if (a.target !== 'none' && !query) {
    throw new CliError(`Использование: fsh ${spec.usage}`, 1, 'usage');
  }
  if (!a.agent.allow.includes(opts.agent)) {
    throw new CliError(`Неизвестный агент "${opts.agent}". Допустимо: ${a.agent.allow.join(', ')}.`, 1, 'usage');
  }

  const log = opts.asObject ? () => {} : makeLogger(opts.json);
  const run = runAction(spec, ctx, { query }, opts);
  run.on((ev) => {
    if (ev.t === 'delta') return void (opts.json || process.stderr.write(ev.text)); // поток судьи, без переводов строк
    if (ev.t !== 'log') return;
    if (ev.stream === 'stderr') process.stderr.write(`${ev.text}\n`);
    else log(ev.text);
  });

  const result = await run.result;
  if (opts.asObject) return result;
  if (result?.dry_run && !opts.json) {
    a.renderPlan(result, log);
    return result;
  }
  finish(opts.json, result);
  return result;
}

// Прогнать судью по сохранённому рану. Работает по артефактам, а не по worktree:
// дифф и отчёт агента зафиксированы на диске, значит рубрики и провайдеров можно
// сравнивать на одном и том же материале даже после уборки worktree.
export async function judgeRun(runId, opts = {}) {
  const log = opts.asObject ? () => {} : makeLogger(opts.json);
  const saved = readRun(runId);
  const { meta } = saved;
  const diff = saved.read('diff.patch');
  if (diff === null) {
    throw new CliError(`У рана ${runId} нет diff.patch — судить нечего (ран не дошёл до verify).`, 1, 'run_incomplete');
  }

  log(`⚖ Судья по рану ${runId} (действие ${meta.action}, MR !${meta.mr})`);
  const verdict = await judge({
    role: meta.judge?.role ?? 'acceptance',
    cfg: opts.cfg,
    profile: opts.judgeProfile,
    payload: buildAcceptancePayload({
      goal: meta.goal,
      facts: meta.facts ?? {},
      extra: meta.extra ?? '',
      diff,
      agentText: saved.read('agent.txt') ?? '',
    }),
  });
  saveArtifact(saved, 'verdict.json', verdict);

  const result = { ok: true, run: runId, judge_only: true, mr: meta.mr, verdict };
  if (opts.asObject) return result;
  log(formatVerdict(verdict));
  finish(opts.json, result);
  return result;
}
