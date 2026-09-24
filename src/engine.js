import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createEventStream } from './agent/events.js';
import { parseClaudeLine, parseAgyLine } from './agent/stream.js';
import { createRun, saveArtifact, readRun, appendEvent, patchRunMeta, runIsActive, MAX_ARCHIVES } from './agent/journal.js';
import { appendCost } from './costs.js';
import { spawnAgent } from './agent/spawn.js';
import { renderTemplate } from './prompts.js';
import { judge, isApproved, formatVerdict } from './judge/index.js';
import { buildAcceptancePayload } from './judge/payload.js';
import { resolveMR } from './resolve.js';
import { ISSUE_KEY } from './jira.js';
import { expandHome } from './config.js';
import { acquireWorkspace, reopenRunWorkspace, MODES as ISOLATION_MODES } from './workspace.js';
import { resolveAgent } from './agents.js';
import { confirm } from './ui.js';
import { makeLogger, finish } from './output.js';
import { fmtDuration, hhmmss } from './format.js';
import { getTelegramTarget, postTelegram, runMessage } from './notify.js';
import { approvalNonce, sendApprovalRequest } from './tgbot.js';
import { CliError } from './errors.js';

export { ISOLATION_MODES };
export const JUDGE_GATES = ['pre-push', 'advisory', 'none'];

// Как агент продолжает свою же сессию: claude резюмит по --resume, agy — по --conversation.
// Агента вне списка на доделку не зовём: без сессии он начал бы с нуля и затёр бы сделанное.
// Сессия нужна, чтобы доделка после revise шла в тот же диалог, а не с чистого листа.
// Ключ — семейство агента: cc, ccq, cco, ccd это один и тот же Claude Code.
export const SESSION_ARGS = {
  claude: { start: (id) => ['--session-id', id], resume: (id) => ['--resume', id] },
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

// Что агент получает при доигрывании упавшего рана: тот же worktree, но сессия могла
// оборваться до init. Поэтому явно просим свериться с состоянием дерева, а не с памятью.
export function resumeMessage(error, extra) {
  const why = error ? `${error.code ? `[${error.code}] ` : ''}${error.message ?? ''}` : 'ран был прерван';
  return [
    `Прошлый запуск прервался: ${why}`,
    'Worktree тот же, твои правки на месте. Посмотри `git status` и `git diff`, продолжи с места остановки и закоммить.',
    'Push и force-push по-прежнему запрещены — их делает fs-harness после приёмки.',
    extra ? `\nУточнение от человека: ${extra}` : '',
  ].filter(Boolean).join('\n');
}

// Снимок precheck в meta.json. Кладём всё, что читают verify/publish/result при
// доигрывании, и выкидываем только то, что resume пересоздаёт сам (workspace) или что
// нужно лишь фазе context, которая на resume не зовётся (дифф ветки, блок логов джоб).
const PRE_DROP = ['workspace', 'result', 'branch_diff', 'job_logs'];
export function slimPre(pre) {
  if (!pre) return null;
  const out = {};
  for (const [k, v] of Object.entries(pre)) if (!PRE_DROP.includes(k)) out[k] = v;
  return out;
}

// Запуск агента в worktree. resume — продолжение сессии (revise), иначе новый ход.
// x несёт opts, ws, ctx, signal, emit, say, phase, sessions: так revise зовёт тот же код, что ран.
export async function spawnSession(x, text, { resume = false, agentName, sessionKey = 'main' } = {}) {
  const opts = x.opts ?? {};
  const ws = x.ws;
  const ctx = x.ctx ?? {};
  const emit = x.emit ?? (() => {});
  const agent = resolveAgent(opts.cfg, agentName ?? opts.agent);
  const session = SESSION_ARGS[agent.family];
  x.sessions ??= {};
  if (session && !x.sessions[sessionKey] && agent.family !== 'agy') x.sessions[sessionKey] = randomUUID();
  const sid = x.sessions[sessionKey];
  const sessionArgs = session ? (resume && sid ? session.resume(sid) : session.start(sid)) : [];
  const isAgy = agent.family === 'agy';
  const streamJson = isAgy || (agent.family === 'claude' && !agent.args.includes('--output-format'));
  const extraArgs =
    isAgy ? ['--input-format', 'stream-json', '--output-format', 'stream-json', '-p=']
    : streamJson ? ['--output-format', 'stream-json', '--verbose', '-p']
    : ['-p'];
  const input =
    isAgy
      ? `${JSON.stringify({ event: 'user', message: { role: 'user', content: text } })}\n`
      : text;

  x.phase?.('agent', 'start', agent.name);
  x.say?.(`🤖 ${resume ? 'Возвращаю задачу' : 'Запускаю'} ${agent.name}…`);
  const startedAt = Date.now();
  const spawn = x.opts?.spawnAgentImpl || spawnAgent;
  const proc = spawn({
    bin: agent.bin,
    args: [...agent.args, ...sessionArgs, ...extraArgs],
    input,
    cwd: ws.dir,
    env: { ...process.env, ...agent.env, GL_HELPER_MR: String(x.target?.iid ?? ''), GL_HELPER_REPO: ctx.repo ?? '' },
    signal: x.signal,
  });
  const out = [];
  const errOut = [];
  let resultText = null;
  let lastEnvelope = null;
  proc.events.on((ev) => {
    if (ev.t !== 'log') return;
    if (ev.stream === 'stderr') errOut.push(ev.text);
    if (ev.stream === 'stdout' && streamJson) {
      const parsed = isAgy ? parseAgyLine(ev.text) : parseClaudeLine(ev.text);
      const { activity, result, passthrough, session: sess, envelope } = parsed;
      if (envelope) lastEnvelope = envelope;
      if (sess && !x.sessions[sessionKey]) x.sessions[sessionKey] = sess;
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
  if (lastEnvelope) {
    const costUsd = isAgy
      ? (lastEnvelope.result?.cost ?? lastEnvelope.cost ?? null)
      : (lastEnvelope.total_cost_usd ?? null);
    const usage = isAgy
      ? (lastEnvelope.result?.usage ?? lastEnvelope.usage ?? null)
      : (lastEnvelope.usage ?? null);
    const durationMs = isAgy
      ? (lastEnvelope.result?.duration_ms ?? lastEnvelope.duration_ms ?? null)
      : (lastEnvelope.duration_ms ?? null);
    x.agentCost = {
      cost_usd: costUsd,
      usage,
      duration_ms: durationMs,
    };
  }
  if (!done.ok) {
    if (sessionKey === 'main') x.sessionId = x.sessions.main ?? null;
    const how = done.signal ? `прерван (${done.signal})` : `завершился с кодом ${done.code}`;
    const where = ws?.created ? `\nWorktree сохранён: ${ws.dir}` : '';
    const combined = [...errOut, ...out].join('\n');
    if (/rate.?limit|429|overloaded/i.test(combined)) {
      const retryAfter = extractRetryAfter(combined);
      const err = new CliError(`Агент ${agent.name} превысил рейт-лимит (retry after ${retryAfter}s).${where}`, 1, 'agent_rate_limited');
      err.retry_after = retryAfter;
      err.keepWorktree = true;
      throw err;
    }
    const err = new CliError(`Агент ${agent.name} ${how} за ${fmtDuration(Date.now() - startedAt)}.${where}`, 1, 'agent_failed');
    err.keepWorktree = true;
    throw err;
  }
  if (sessionKey === 'main') x.sessionId = x.sessions.main ?? null;
  x.phase?.('agent', 'done');
  return resultText ?? out.join('\n');
}

// Извлечение retry_after из текста ошибки провайдера (в секундах)
export function extractRetryAfter(text) {
  const mSec = String(text ?? '').match(/retry.?(?:after|in)\s*:?\s*(\d+)\s*(?:s|sec|seconds?)/i);
  if (mSec) return parseInt(mSec[1], 10);
  const mMin = String(text ?? '').match(/retry.?(?:after|in)\s*:?\s*(\d+)\s*(?:m|min|minutes?)/i);
  if (mMin) return parseInt(mMin[1], 10) * 60;
  // ponytail: дефолт 30 минут (1800с), если провайдер не указал явный интервал
  return 1800;
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
  let currentPhase = null; // на чём упали — уходит в meta.error.phase
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
    phase: (name, status, detail) => {
      if (status === 'start') currentPhase = name;
      emit({ t: 'phase', phase: name, status, detail });
    },
  };

  function recordRunCost() {
    if (!runDir) return;
    try {
      appendCost({
        root: opts.costsRoot,
        record: {
          at: new Date().toISOString(),
          run: runDir.id,
          action: spec.name,
          project: ctx.cfg?.activeProject ?? null,
          issue: x.target?.key ?? meta?.issue ?? null,
          mr: x.target?.iid ?? meta?.mr ?? null,
          profile: opts.agent,
          agent_cost: x.agentCost ?? null,
          judge_cost: x.verdict?.meta?.cost ?? null,
        },
      });
    } catch {
      // Не роняем ран из-за сбоя записи статистики расхода
    }
  }

  const result = go().then(
    async (res) => {
      // Кнопки аппрува и есть уведомление: вторая строка в чат не нужна.
      if (!res?.pending_approval) await notify(true);
      emit({ t: 'done', ok: true, result: res });
      events.close();
      recordRunCost();
      return res;
    },
    async (err) => {
      const code = err.code ?? 'failed';
      // Провал сохраняем как состояние рана: без него не отличить упавший ран от живого,
      // а id упавшего рана человек должен получить в хвосте ошибки.
      if (runDir) {
        patchRunMeta(runDir, {
          state: 'failed',
          pid: null,
          error: { code, message: err.message, retry_after: err.retry_after ?? null, phase: currentPhase, at: new Date().toISOString() },
          session_id: x.sessionId ?? x.sessions?.main ?? null,
          agent_cost: x.agentCost ?? null,
        });
        err.run = runDir.id;
        err.runDir = runDir.dir;
      }
      await notify(false, err);
      emit({ t: 'error', code, message: err.message, retry_after: err.retry_after ?? null });
      events.close();
      recordRunCost();
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
      if (opts.resumeOf) return await goResume();
      x.phase('context', 'start');
      x.target = await resolveTarget(a.target, ctx, input.query);
      x.pre = (await a.precheck(x)) ?? {};
      if (opts.dryRun) return a.dryRun(x);
      if (x.pre.skip) {
        x.phase('context', 'skip', x.pre.reason);
        return x.pre.result;
      }

      runDir = createRun(spec.name, {
        root: opts.runsDir,
        keep: opts.cfg?.journal?.maxRuns ?? MAX_ARCHIVES,
        olderThanDays: opts.cfg?.journal?.maxAgeDays ?? null,
      });
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

      if (!opts.yes && !opts.asObject && !confirm(`Запускаю агента ${opts.agent}. Продолжить? [y/N] `)) {
        throw new CliError('Отменено.', 0, 'canceled');
      }

      // Планировщик — отдельный агент и отдельная сессия до исполнителя. Его текст уходит
      // в переменную plan и в промпт исполнителя, а не в общий диалог с исполнителем.
      if (a.plan) {
        const planAgent = a.plan.agent ?? a.agent.default;
        x.phase('plan', 'start', planAgent);
        const planRendered = renderTemplate(a.plan.prompt, x.vars, { projectDir: x.pre.projectDir });
        saveArtifact(runDir, 'plan-prompt.md', planRendered.text);
        x.plan = await runAgent(x, { agentName: planAgent, prompt: planRendered.text, sessionKey: 'plan' });
        saveArtifact(runDir, 'plan.md', x.plan);
        x.phase('plan', 'done', planAgent);
        x.vars = { ...x.vars, plan: x.plan };
      }

      x.phase('prompt', 'start');
      const rendered = renderTemplate(a.prompt, x.vars, { projectDir: x.pre.projectDir });
      x.prompt = rendered.text;
      saveArtifact(runDir, 'prompt.md', rendered.text);
      meta = {
        id: runDir.id,
        action: spec.name,
        created_at: new Date().toISOString(),
        agent: x.opts.agent,
        plan_agent: a.plan ? (a.plan.agent ?? a.agent.default) : null,
        prompt_source: rendered.source,
        state: 'running',
        pid: process.pid,
        isolation: a.isolation,
        worktree: ws.dir,
        branch: ws.branch,
        base: ws.base,
        base_sha: ws.baseSha,
        pre: slimPre(x.pre),
        judge: { role: a.judge.role, profile: opts.judgeProfile ?? null },
        ...(x.pre.meta ?? {}),
      };
      saveArtifact(runDir, 'meta.json', meta);
      x.phase('prompt', 'done', rendered.source);

      x.agentText = await runAgent(x);
      keep = true; // дальше в worktree лежит работа агента: любой провал ниже её не выбрасывает
      await collect(x);

      x.verdict = await accept(x);
      const parked = await maybePark(x);
      if (parked) return parked;
      x.published = (a.publish ? await a.publish(x) : null) ?? {};
      x.phase('publish', 'done');

      const res = a.result(x);
      keep = Boolean(opts.keepWorktree);
      patchRunMeta(runDir, { state: 'done', pid: null, error: null, agent_cost: x.agentCost ?? null });
      saveArtifact(runDir, 'result.json', res);
      return res;
    } finally {
      // Без return: он проглатывал летящее исключение и действие возвращало undefined.
      if (ws) ws.cleanup(keep);
    }
  }

  // Доигрывание упавшего рана: тот же worktree и та же сессия агента, без повторного
  // precheck/context — агент получает текст о прерывании и продолжает с места остановки.
  // Дальше идёт обычный хвост accept → publish, поэтому будущий pending_approval
  // (фаза 13) resume унаследует бесплатно.
  async function goResume() {
    const saved = readRun(opts.resumeOf, { root: opts.runsDir });
    const m = saved.meta;
    if (runIsActive(m, saved.dir)) {
      throw new CliError(`Ран ${saved.id} ещё выполняется (pid ${m.pid}). Дождись или прерви его.`, 1, 'run_active');
    }
    const code = m.error?.code;
    if (!['agent_failed', 'canceled'].includes(code)) {
      const hint = String(code ?? '').startsWith('judge')
        ? `Пересуди: fsh ${m.action} --judge-only ${saved.id}.`
        : `Повтори с нуля: fsh retry ${saved.id}.`;
      throw new CliError(`Ран ${saved.id} упал на "${code ?? '?'}" — доигрывать агента нечего. ${hint}`, 1, 'resume_not_applicable');
    }
    if (!m.pre || !m.worktree || !existsSync(m.worktree)) {
      throw new CliError(`Ран ${saved.id} не доиграть: worktree ${m.worktree ?? '—'} не сохранён или удалён. Повтори с нуля: fsh retry ${saved.id}.`, 1, 'run_not_resumable');
    }
    if (a.target !== 'none' && !(m.issue ?? m.mr)) {
      throw new CliError(`Ран ${saved.id} не привязан к MR или задаче — доигрывать нечего.`, 1, 'run_not_resumable');
    }

    runDir = { id: saved.id, dir: saved.dir };
    x.run = runDir;
    meta = { ...m, error: null, state: 'running', pid: process.pid };
    x.pre = m.pre;
    x.plan = saved.read('plan.md') ?? null;

    x.phase('isolate', 'start');
    ws = reopenRunWorkspace(m, a, { onEvent: x.say });
    x.ws = ws;
    x.phase('isolate', 'done', ws.dir);

    x.target = a.target === 'none' ? null : await resolveTarget(a.target, ctx, m.issue ?? String(m.mr));
    x.phase('context', 'done');

    if (!opts.yes && !opts.asObject && !confirm(`Продолжаю агента ${opts.agent} в worktree рана. Продолжить? [y/N] `)) {
      throw new CliError('Отменено.', 0, 'canceled');
    }

    const msg = resumeMessage(m.error, opts.message);
    if (m.session_id) x.sessions = { main: m.session_id };
    x.agentText = m.session_id
      ? await runAgent(x, { resume: msg })
      : await runAgent(x, { prompt: msg });
    keep = true;
    await collect(x);

    x.verdict = await accept(x);
    const parked = await maybePark(x);
    if (parked) return parked;
    x.published = (a.publish ? await a.publish(x) : null) ?? {};
    x.phase('publish', 'done');

    const res = a.result(x);
    keep = Boolean(opts.keepWorktree);
    patchRunMeta(runDir, { state: 'done', pid: null, error: null, agent_cost: x.agentCost ?? null });
    saveArtifact(runDir, 'result.json', res);
    return res;
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
      agent_cost: x.agentCost ?? null,
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
    // maxRevise у действия перебивает общий: у implement ревью идёт до трёх раз.
    const maxRevise = a.judge.maxRevise ?? opts.cfg?.judge?.maxRevise ?? 1;
    const limit = a.judge.gate === 'pre-push' && SESSION_ARGS[resolveAgent(opts.cfg, opts.agent).family] ? maxRevise : 0;
    let verdict = await gate(x);
    for (let round = 1; verdict?.decision === 'revise' && round <= limit; round++) {
      x.say(`↻ Судья просит доделать (${round}/${limit}) — возвращаю задачу агенту.`);
      x.agentText = await runAgent(x, { resume: reviseMessage(verdict) });
      await collect(x);
      verdict = await gate(x);
    }
    if (a.judge.gate === 'pre-push' && verdict && !isApproved(verdict) && !interactiveGate()) {
      throw new CliError(
        `${formatVerdict(verdict)}\n\nPush не сделан. Worktree сохранён: ${ws.dir}\nВердикт: ${runDir.dir}/verdict.json`,
        1,
        'judge_rejected',
      );
    }
    return verdict;
  }

  // Интерактивный гейт: человек жмёт кнопку, процесс рана к этому моменту мёртв.
  function interactiveGate() {
    return a.writes
      && a.judge.gate === 'pre-push'
      && opts.cfg?.telegram?.approvals === true
      && getTelegramTarget(opts.cfg) !== null
      && !opts.noJudge;
  }

  // Останавливаем ран до publish. result.json не пишем — иначе список ранов покажет done.
  async function maybePark(x) {
    if (!interactiveGate() || !x.verdict) return null;
    const nonce = approvalNonce();
    const approval = {
      nonce,
      issued_at: new Date().toISOString(),
      run: runDir.id,
      action: spec.name,
    };
    patchRunMeta(runDir, { state: 'pending_approval', pid: null, error: null, approval });
    meta = { ...meta, state: 'pending_approval', approval, head_sha: x.facts?.head_sha ?? meta?.head_sha };
    keep = true;
    const sink = opts.approvalSink;
    if (sink) {
      try {
        await sink({ cfg: opts.cfg, run: runDir.id, meta, verdict: x.verdict, nonce, fetchImpl: opts.fetchImpl, say: x.say });
      } catch (e) {
        x.say(`⚠ Кнопки аппрува не ушли: ${e.message}. Ожидает аппрува: fsh publish ${runDir.id}`);
      }
    } else {
      x.say(`Ожидает аппрува: fsh publish ${runDir.id}`);
    }
    return {
      ok: true,
      pending_approval: true,
      run: runDir.id,
      mr: meta.mr ?? x.target?.iid ?? null,
      verdict: { decision: x.verdict.decision, confidence: x.verdict.confidence, summary: x.verdict.summary },
    };
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
  // agentName/prompt/sessionKey — для многошаговых флоу (планировщик): своя сессия на шаг,
  // чтобы resume после revise не уехал не тому агенту.
  async function runAgent(x, { resume = null, agentName = opts.agent, prompt = null, sessionKey = 'main' } = {}) {
    try {
      return await spawnSession(x, resume ?? prompt ?? x.prompt, { resume: Boolean(resume), agentName, sessionKey });
    } catch (err) {
      // Агент успел поработать: его правки в worktree не выбрасываем даже при провале.
      if (err.keepWorktree) keep = true;
      throw err;
    }
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
export async function resolveTarget(kind, ctx, query) {
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
  // resume работает по сохранённому рану, цель берётся из meta — query не нужен.
  if (!opts.resumeOf && a.target !== 'none' && !query) {
    throw new CliError(`Использование: fsh ${spec.usage}`, 1, 'usage');
  }
  resolveAgent(opts.cfg, opts.agent); // список агентов открытый: проверка — есть ли профиль в конфиге
  if (!opts.approvalSink) {
    opts = { ...opts, approvalSink: (info) => sendApprovalRequest({ ...info, runsRoot: opts.runsDir }) };
  }

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
