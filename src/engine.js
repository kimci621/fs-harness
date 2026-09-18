import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createEventStream } from './agent/events.js';
import { parseClaudeLine, parseAgyLine } from './agent/stream.js';
import { createRun, saveArtifact, readRun, appendEvent } from './agent/journal.js';
import { spawnAgent } from './agent/spawn.js';
import { renderTemplate } from './prompts.js';
import { judge, isApproved, formatVerdict } from './judge/index.js';
import { buildAcceptancePayload } from './judge/payload.js';
import { resolveMR } from './resolve.js';
import { ISSUE_KEY } from './jira.js';
import { expandHome } from './config.js';
import { acquireWorkspace, MODES as ISOLATION_MODES } from './workspace.js';
import { resolveAgent } from './agents.js';
import { confirm } from './ui.js';
import { makeLogger, finish } from './output.js';
import { fmtDuration, hhmmss } from './format.js';
import { getTelegramTarget, postTelegram, runMessage } from './notify.js';
import { CliError } from './errors.js';

export { ISOLATION_MODES };
export const JUDGE_GATES = ['pre-push', 'advisory', 'none'];

// Как агент продолжает свою же сессию: claude резюмит по --resume, pi — тем же --session-id.
// Агента вне списка на доделку не зовём: без сессии он начал бы с нуля и затёр бы сделанное.
// Сессия нужна, чтобы доделка после revise шла в тот же диалог, а не с чистого листа.
// Ключ — семейство агента: cc, ccq, cco, ccd это один и тот же Claude Code.
export const SESSION_ARGS = {
  claude: { start: (id) => ['--session-id', id], resume: (id) => ['--resume', id] },
  pi: { start: (id) => ['--session-id', id], resume: (id) => ['--session-id', id] },
  agy: { start: () => [], resume: (id) => ['--conversation', id] },
};

// Что агент получает вместе с просьбой доделать: решение судьи, находки и границы.
export function reviseMessage(verdict) {
  const findings = (verdict.findings ?? []).map(
    (f) => `- [${f.severity}] ${f.file}${f.line ? `:${f.line}` : ''} — ${f.body}`,
  );
  return [
    `Приёмка вернула работу на доделку: ${verdict.summary}`,
    ...findings,
    verdict.next?.hint ? `Подсказка: ${verdict.next.hint}` : '',
    'Доделай в этом же worktree и закоммить. Push и force-push по-прежнему запрещены.',
  ].filter(Boolean).join('\n');
}

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

  // at ставится здесь, а не только в журнале: рендереру CLI нужны метки времени на каждой строке.
  const emit = (ev) => {
    const full = { at: new Date().toISOString(), run: runDir?.id ?? null, ...ev };
    appendEvent(runDir, full);
    events.push(full);
  };
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
    async (res) => {
      await notify(true);
      emit({ t: 'done', ok: true, result: res });
      events.close();
      return res;
    },
    async (err) => {
      await notify(false, err);
      emit({ t: 'error', code: err.code ?? 'failed', message: err.message });
      events.close();
      throw err;
    },
  );

  // Уведомление о завершении рана. Не настроен Telegram — молчим; упал POST — это строка
  // в логе, а не провал действия: работа агента уже сделана.
  async function notify(ok, err) {
    const target = getTelegramTarget(opts.cfg);
    if (!target || !runDir) return;
    const text = runMessage({
      action: spec.name,
      target: x.target?.iid ? `!${x.target.iid}` : x.target?.key ?? '',
      ok,
      cost: x.verdict?.meta?.cost ?? 0,
      verdict: x.verdict,
      error: err?.message,
      url: x.target?.web_url ?? null,
    });
    try {
      await postTelegram(target, text, { fetchImpl: opts.fetchImpl, signal: ac.signal });
    } catch (e) {
      emit({ t: 'log', stream: 'stderr', text: `⚠ Уведомление не ушло: ${e.message}` });
    }
  }

  async function go() {
    try {
      x.phase('context', 'start');
      x.target = await resolveTarget(a.target, ctx, input.query);
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
      await collect(x);

      x.verdict = await accept(x);
      x.published = (a.publish ? await a.publish(x) : null) ?? {};
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

  // Факты о результате агента: снимаются заново после каждого его захода.
  async function collect(x) {
    x.facts = await a.verify(x);
    if (x.before) ws.assertClean(x.before); // читающее действие не имеет права менять чекаут
    saveArtifact(runDir, 'agent.txt', x.agentText);
    saveArtifact(runDir, 'diff.patch', x.facts.diff ?? '');
    x.goal = a.goal(x);
    x.extra = a.judgeExtra ? a.judgeExtra(x) : '';
    saveArtifact(runDir, 'meta.json', {
      ...meta,
      session_id: x.sessionId ?? null,
      head_sha: x.facts.head_sha,
      facts: { ...x.facts, diff: undefined },
      goal: x.goal,
      extra: x.extra,
    });
    x.phase('verify', 'done');
  }

  // Приёмка: вердикт revise возвращает работу агенту в ту же сессию, не дальше maxRevise раз.
  // Любой другой исход кроме approve на гейте pre-push закрывает push.
  async function accept(x) {
    // Доделка нужна только гейту: advisory нечего останавливать, перезапуск агента лишь жжёт деньги.
    const limit = a.judge.gate === 'pre-push' && SESSION_ARGS[resolveAgent(opts.cfg, opts.agent).family] ? (opts.cfg?.judge?.maxRevise ?? 1) : 0;
    let verdict = await gate(x);
    for (let round = 1; verdict?.decision === 'revise' && round <= limit; round++) {
      x.say(`↻ Судья просит доделать (${round}/${limit}) — возвращаю задачу агенту.`);
      x.agentText = await runAgent(x, reviseMessage(verdict));
      await collect(x);
      verdict = await gate(x);
    }
    if (a.judge.gate === 'pre-push' && verdict && !isApproved(verdict)) {
      throw new CliError(
        `${formatVerdict(verdict)}\n\nPush не сделан. Worktree сохранён: ${ws.dir}\nВердикт: ${runDir.dir}/verdict.json`,
        1,
        'judge_rejected',
      );
    }
    return verdict;
  }

  // Один заход судьи. Решение не трактует: это дело accept().
  async function gate(x) {
    const { gate: mode, role } = a.judge;
    if (mode === 'none' || opts.noJudge || opts.cfg?.judge?.enabled === false) {
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
      payload: a.judgePayload
        ? a.judgePayload(x)
        : buildAcceptancePayload({
            goal: x.goal,
            facts: { ...x.facts, diff: undefined, diff_title: undefined },
            extra: x.extra,
            diff: x.facts.diff,
            diffTitle: x.facts.diff_title,
            agentText: x.agentText,
          }),
    });
    saveArtifact(runDir, 'verdict.json', verdict);
    emit({ t: 'verdict', verdict });
    x.say(formatVerdict(verdict));
    x.phase('judge', 'done', verdict.decision);
    return verdict;
  }

  // resume — текст доделки: тот же агент продолжает свою сессию, а не начинает заново.
  async function runAgent(x, resume = null) {
    const agent = resolveAgent(opts.cfg, opts.agent);
    const session = SESSION_ARGS[agent.family];
    if (session && !x.sessionId && agent.family !== 'agy') x.sessionId = randomUUID();
    const sessionArgs = session ? (resume && x.sessionId ? session.resume(x.sessionId) : session.start(x.sessionId)) : [];
    // stream-json: без него headless-агент молчит до самого конца, и долгая работа
    // неотличима от зависания. claude и agy держат стрим со своими флагами и разбором.
    const isAgy = agent.family === 'agy';
    const streamJson = isAgy || (agent.family === 'claude' && !agent.args.includes('--output-format'));
    const extraArgs =
      isAgy ? ['--input-format', 'stream-json', '--output-format', 'stream-json', '-p=']
      : streamJson ? ['--output-format', 'stream-json', '--verbose', '-p']
      : ['-p'];
    const input =
      isAgy
        ? `${JSON.stringify({ event: 'user', message: { role: 'user', content: resume ?? x.prompt } })}\n`
        : (resume ?? x.prompt);

    x.phase('agent', 'start', agent.name);
    x.say(`🤖 ${resume ? 'Возвращаю задачу' : 'Запускаю'} ${agent.name}…`);
    const startedAt = Date.now();
    const proc = spawnAgent({
      bin: agent.bin,
      args: [...agent.args, ...sessionArgs, ...extraArgs],
      input,
      cwd: ws.dir,
      env: { ...process.env, ...agent.env, GL_HELPER_MR: String(x.target?.iid ?? ''), GL_HELPER_REPO: ctx.repo },
      signal: ac.signal,
    });
    const out = [];
    let resultText = null; // финальный отчёт из события result потока stream-json
    proc.events.on((ev) => {
      if (ev.t !== 'log') return;
      if (ev.stream === 'stdout' && streamJson) {
        const { activity, result, passthrough, session: sess } = isAgy ? parseAgyLine(ev.text) : parseClaudeLine(ev.text);
        if (sess && !x.sessionId) x.sessionId = sess;
        if (result !== null) {
          resultText = result;
          return;
        }
        if (activity) {
          emit({ t: 'log', stream: 'activity', text: activity });
          return;
        }
        if (passthrough) {
          out.push(passthrough);
          emit({ t: 'log', stream: 'stdout', text: passthrough });
        }
        return;
      }
      if (ev.stream === 'stdout') out.push(ev.text);
      emit({ t: 'log', stream: ev.stream, text: ev.text });
    });
    let done;
    try {
      done = await proc.result;
    } catch (err) {
      throw new CliError(`Не удалось запустить ${agent.name}: ${err.message}`, 1, 'agent_failed');
    }
    if (!done.ok) {
      // Агент успел поработать: его правки в worktree не выбрасываем даже при провале.
      keep = true;
      const how = done.signal ? `прерван (${done.signal})` : `завершился с кодом ${done.code}`;
      const where = ws?.created ? `\nWorktree сохранён: ${ws.dir}` : '';
      throw new CliError(`Агент ${agent.name} ${how} за ${fmtDuration(Date.now() - startedAt)}.${where}`, 1, 'agent_failed');
    }
    x.phase('agent', 'done'); // длительность фазы считает рендерер по времени старта
    return resultText ?? out.join('\n');
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

// Цель действия: MR, задача Jira или ничего. Ключ задачи — по форме, а не по флагу.
async function resolveTarget(kind, ctx, query) {
  if (kind === 'none') return null;
  if (kind === 'mr') return resolveMR(ctx.g, ctx.repo, query);
  if (kind === 'issue') {
    if (!ISSUE_KEY.test(String(query ?? ''))) {
      throw new CliError(`"${query}" не похоже на ключ задачи Jira (FD-7647).`, 1, 'usage');
    }
    return ctx.jira().issue(query);
  }
  throw new CliError(`Неизвестный тип цели действия: ${kind}.`, 1, 'config_invalid');
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
  resolveAgent(opts.cfg, opts.agent); // список агентов открытый: проверка — есть ли профиль в конфиге

  // Рендер событий: время на каждой строке, длительности фаз, сердцебиение на долгих фазах.
  // Тихие режимы (MCP, asObject) ничего не печатают — stdout там занят протоколом/результатом.
  const silent = Boolean(opts.asObject || opts.quiet);
  const stamp = hhmmss; // метка времени как в журнале рана
  // Единственная точка человеческого вывода: в json-режиме прогресс уходит в stderr.
  const emitLine = (text, at = null) => {
    if (silent) return;
    const line = `${stamp(at)} ${text}`;
    if (opts.json) process.stderr.write(`${line}\n`);
    else console.log(line);
  };

  const run = runAction(spec, ctx, { query }, opts);
  const phaseStarted = new Map(); // имя фазы → момент старта, для длительности на done
  let current = null; // открытая фаза для сердцебиения
  let lastActivity = null; // чем агент был занят в последний раз — для сердцебиения
  let lastEventAt = Date.now();
  const HEARTBEAT_EVERY_MS = 30_000;
  const HEARTBEAT_AFTER_MS = 45_000; // тише этого — значит есть повод напомнить о себе
  const heartbeat = silent
    ? null
    : setInterval(() => {
        if (!current || Date.now() - lastEventAt < HEARTBEAT_AFTER_MS) return;
        const what = lastActivity ? `последнее: ${lastActivity}` : 'событий пока не было';
        emitLine(`⏳ ${current.phase}: идёт ${fmtDuration(Date.now() - current.at)}, ${what}`);
      }, HEARTBEAT_EVERY_MS);
  heartbeat?.unref?.();

  // Ctrl+C — не сырой kill: останавливаем агента и судью, движок сохраняет worktree
  // с работой и печатает внятную ошибку. Второй Ctrl+C — жёсткий выход.
  let interrupts = 0;
  const onSigInt = () => {
    interrupts += 1;
    if (interrupts > 1) process.exit(130);
    emitLine('⏹ Прерываю: останавливаю агента и судью, сохраняю worktree…');
    run.abort();
  };
  if (!silent) process.on('SIGINT', onSigInt);

  run.on((ev) => {
    lastEventAt = Date.now();
    if (ev.t === 'delta') {
      // Поток судьи: приходят готовые строки — печатаем с меткой времени, а не в одну моргающую строку.
      for (const l of String(ev.text).split('\n').filter(Boolean)) emitLine(`  ⚙ ${l}`, ev.at);
      return;
    }
    if (ev.t === 'phase') {
      if (ev.status === 'start') {
        phaseStarted.set(ev.phase, Date.now());
        current = { phase: ev.phase, at: Date.now() };
        emitLine(`▶ ${ev.phase}…`, ev.at);
        return;
      }
      current = null;
      if (ev.status !== 'done') return;
      const from = phaseStarted.get(ev.phase);
      const took = from ? ` за ${fmtDuration(Date.now() - from)}` : '';
      emitLine(`✓ ${ev.phase}${took}${ev.detail ? ` — ${ev.detail}` : ''}`, ev.at);
      return;
    }
    if (ev.t !== 'log') return;
    if (ev.stream === 'stderr') {
      if (!silent) process.stderr.write(`${stamp(ev.at)} ${ev.text}\n`);
      return;
    }
    if (ev.stream === 'activity') {
      lastActivity = ev.text;
      emitLine(`  · ${ev.text}`, ev.at);
      return;
    }
    emitLine(ev.text, ev.at);
  });

  let result;
  try {
    result = await run.result;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (!silent) process.removeListener('SIGINT', onSigInt);
  }
  if (opts.asObject) return result;
  if (result?.dry_run && !opts.json) {
    a.renderPlan(result, (t) => emitLine(t));
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
  const saved = readRun(runId, { root: opts.runsDir });
  const { meta } = saved;
  const diff = saved.read('diff.patch');
  if (diff === null) {
    throw new CliError(`У рана ${runId} нет diff.patch — судить нечего (ран не дошёл до verify).`, 1, 'run_incomplete');
  }

  const stamp = hhmmss; // те же метки, что и в рендере действий
  log(`${stamp()} ⚖ Судья по рану ${runId} (действие ${meta.action}, MR !${meta.mr})`);
  const verdict = await judge({
    role: meta.judge?.role ?? 'acceptance',
    cfg: opts.cfg,
    profile: opts.judgeProfile,
    makeProvider: opts.makeProvider, // шов для тестов: судья без сети
    // Поток размышлений судьи в лог: без него минуты проверки выглядят зависанием
    // (живой случай: «судья завершился с кодом 143» после полной тишины).
    onDelta: (text) => {
      for (const l of String(text).split('\n').filter(Boolean)) log(`${stamp()}   ⚙ ${l}`);
    },
    payload: buildAcceptancePayload({
      goal: meta.goal,
      facts: { ...(meta.facts ?? {}), diff_title: undefined },
      extra: meta.extra ?? '',
      diff,
      diffTitle: meta.facts?.diff_title,
      agentText: saved.read('agent.txt') ?? '',
    }),
  });
  saveArtifact(saved, 'verdict.json', verdict);

  const result = { ok: true, run: runId, judge_only: true, mr: meta.mr, verdict };
  if (opts.asObject) return result;
  log(`${stamp()} ⏱ Судья думал ${fmtDuration(verdict.meta.duration_ms ?? 0)}`);
  log(formatVerdict(verdict));
  finish(opts.json, result);
  return result;
}
