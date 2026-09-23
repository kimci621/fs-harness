import path from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { loadConfig, expandHome } from '../config.js';
import { createGlab } from '../glab.js';
import { createCtx, findCommand, ACTIONS } from '../registry.js';
import { getTelegramTarget } from '../notify.js';
import { publishRun, reviseRun } from '../publish.js';
import { runActionCLI } from '../engine.js';
import { readRun, patchRunMeta, listRuns, sweepExpiredApprovals, RUNS_DIR } from '../agent/journal.js';
import { spawnAgent } from '../agent/spawn.js';
import { resolveAgent } from '../agents.js';
import { parseClaudeLine, parseAgyLine } from '../agent/stream.js';
import { listJobs } from '../queue.js';
import { removeWorktree, makeGit } from '../workspace.js';
import {
  getUpdates, handleUpdate, answerCallbackQuery, editMessageReplyMarkup,
  loadBotState, saveBotState, sendMessage,
  escapeHtml, formatMRTelegram, formatMRCard, formatJobsTelegram,
  formatCommentsTelegram, formatTasksListTelegram, formatTaskCardTelegram,
  formatStatusTelegram, formatWatchTelegram, formatHelpTelegram,
} from '../tgbot.js';
import { cmdMRS, anyFilter } from './mrs.js';
import { cmdMR } from './mr.js';
import { cmdJobs } from './jobs.js';
import { cmdMRComments } from './mr-comments.js';
import { cmdDeploy } from './deploy.js';
import { cmdJira } from './jira.js';
import { cmdTask } from './task.js';
import { cmdWatch, sleepFor } from './watch.js';
import { ISSUE_KEY } from '../jira.js';
import { CliError } from '../errors.js';

const STATE_ROOT = path.join(homedir(), '.local', 'state', 'fs-harness');

const defaultCtx = (cfg) => createCtx({ g: createGlab(undefined, { host: cfg.host }), cfg });

// fsh bot — long-polling демон: команды из чата и кнопки аппрува.
// allowlist обязателен: без telegram.allowed_user_ids бот не стартует.
export async function cmdBot(opts = {}, deps = {}) {
  const {
    env = process.env,
    loadCfg = loadConfig,
    makeCtx = defaultCtx,
    fetchImpl = fetch,
    sleep = sleepFor,
    now = () => Date.now(),
    cycles = Infinity,
    log = console.log,
    runsDir,
    stateRoot = STATE_ROOT,
    publish = publishRun,
    revise = reviseRun,
    commands = {},
    spawnAgentImpl = spawnAgent,
  } = deps;

  let cfg = loadCfg(env, {});
  const target = getTelegramTarget(cfg, { env, readSecretImpl: deps.readSecretImpl });
  if (!target) {
    throw new CliError('Заведи telegram.bot_token и telegram.chat_id в конфиге (или env TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID).', 1, 'config_invalid');
  }
  if (!Array.isArray(cfg.telegram?.allowed_user_ids) || cfg.telegram.allowed_user_ids.length === 0) {
    throw new CliError('Бот без allowlist не стартует: telegram.allowed_user_ids: [<твой id>]. Твой id узнай у @userinfobot.', 1, 'config_invalid');
  }

  let stopped = false;
  let wake = null;
  const activeAgents = new Set();
  const stop = () => {
    stopped = true;
    for (const a of activeAgents) a.abort?.();
    wake?.();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  // Долгие publish/revise не держат long-polling: кладём в очередь, дожидаемся на выходе.
  const pending = [];
  const fire = (fn) => {
    const p = Promise.resolve().then(fn).catch((e) => {
      log(`${stamp()} фоновая операция упала: ${e.message}`);
    });
    pending.push(p);
    return p;
  };

  const tg = () => getTelegramTarget(loadCfg(env, {})) ?? target;
  const sayTo = async (chatId, text) => {
    try {
      await sendMessage(tg().token, chatId, text, { fetchImpl });
    } catch (e) {
      log(`${stamp()} ответ не ушёл: ${e.message}`);
    }
  };

  const ctxFor = () => makeCtx(loadCfg(env, {}));

  // Начальный снос хвоста: старые апдейты и протухшие кнопки проглатываем один раз.
  let offset = loadBotState(stateRoot).offset ?? null;
  if (offset == null) {
    try {
      const batch = await getUpdates(target.token, { timeout: 0, fetchImpl });
      offset = batch.reduce((m, u) => Math.max(m, u.update_id + 1), 0) || 0;
      saveBotState(stateRoot, { offset });
    } catch (e) {
      log(`${stamp()} начальный getUpdates упал — ${e.message}; повтор через 5с`);
      await sleep(5000);
    }
  }

  let cycle = 0;
  log(`${stamp()} бот: long-polling, allowlist ${cfg.telegram.allowed_user_ids.join(', ')}`);
  try {
    while (!stopped && cycle < cycles) {
      cycle++;
      const c = loadCfg(env, {}); // allowlist и approvals читаем на ходу
      const t = getTelegramTarget(c);
      if (!t) {
        log(`${stamp()} telegram пропал из конфига — жду`);
        await sleep(5000);
        continue;
      }

      sweepExpiredApprovals({
        root: runsDir ?? RUNS_DIR,
        now: now(),
        onExpired: (run) => {
          try {
            const m = JSON.parse(readRun(run.id, { root: runsDir ?? RUNS_DIR }).read('meta.json'));
            if (m.worktree && m.project_dir) removeWorktree(makeGit(m.project_dir), m.worktree, m.branch);
            if (m.approval?.chat_id) {
              fire(() => sayTo(m.approval.chat_id, `Аппрув рана ${run.id} протух, worktree убран.`));
            }
          } catch { /* уборка уже сделана/не нужна */ }
        },
      });

      let updates;
      try {
        updates = await getUpdates(t.token, { offset, timeout: 25, fetchImpl });
      } catch (e) {
        // Сеть моргает — демон не падает, как и watcher.
        log(`${stamp()} getUpdates упал — ${e.message}; повтор через 5с`);
        await sleep(5000);
        continue;
      }

      for (const u of updates) {
        if (stopped) break;
        offset = u.update_id + 1;
        try {
          await handleOne(u, { c, t, log, fire, sayTo, ctxFor, commands, publish, revise, runsDir, fetchImpl, now, env, loadCfg, makeCtx, sleep, spawnAgentImpl, activeAgents });
        } catch (e) {
          log(`${stamp()} update ${u.update_id} упал: ${e.message}`);
        }
        saveBotState(stateRoot, { offset: u.update_id + 1 });
      }

      if (stopped) break;
      // getUpdates сам ждёт 25с; если пусто — короткий сон для ритма цикла.
      if (!updates?.length) await Promise.race([sleep(200), new Promise((r) => { wake = r; })]);
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await Promise.allSettled(pending);
  }
  log(`${stamp()} бот остановлен.`);
  return { ok: true, cycles: cycle, offset };
}

const stamp = () => new Date().toISOString().slice(11, 19);

// Один update: команда, кнопка или молчание. Всё долгое уходит в fire().
async function handleOne(u, d) {
  const { c, t, log, fire, sayTo, ctxFor, commands, publish, revise, runsDir, fetchImpl, spawnAgentImpl, activeAgents } = d;
  const parsed = handleUpdate(u, { cfg: c });
  if (parsed.kind === 'ignored') return;

  if (parsed.kind === 'command') {
    await runCommand(parsed, { c, t, sayTo, ctxFor, commands, log, fire, runsDir, fetchImpl, spawnAgentImpl, activeAgents });
    return;
  }

  await runCallback(parsed, { c, t, sayTo, fire, publish, revise, runsDir, fetchImpl, log, makeCtx: d.makeCtx });
}

function parseMRFilters(args = []) {
  const f = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i].toLowerCase();
    if (a === 'mine' || a === 'my' || a === 'me') f.author = 'me';
    else if (a === 'rev' || a === 'reviewer') f.reviewer = 'me';
    else if (a === 'draft') f.draft = true;
    else if (a === 'ready' || a === 'nodraft') f.draft = false;
    else if (a === 'failed' || a === 'running' || a === 'success') f.pipeline = a;
    else if (a === 'conflict' || a === 'conflicts') f.conflicts = true;
    else if (a === 'threads') f.threads = true;
    else if (!f.search) f.search = args.slice(i).join(' ');
  }
  return f;
}

async function runActionViaBot(actionName, query, d, parsed) {
  const { sayTo, ctxFor, fire, runsDir, fetchImpl } = d;
  const entry = ACTIONS.find((x) => x.name === actionName);
  if (!entry) return;

  await sayTo(parsed.chatId, `▶ Запускаю <b>${escapeHtml(actionName)}</b> для <code>${escapeHtml(query)}</code>…`);
  fire(async () => {
    try {
      const ctx = ctxFor();
      const res = await runActionCLI(entry, ctx, [query], {
        cfg: ctx.cfg,
        projectDir: ctx.cfg.projectDir,
        agent: ctx.cfg.agent,
        yes: true,
        json: true,
        asObject: true,
        quiet: true,
        runsDir,
        fetchImpl,
        approvalSink: undefined,
      });
      const text = res?.pending_approval
        ? `⏳ <b>${escapeHtml(entry.name)}</b> ждёт аппрува (ран <code>${res.run}</code>):\nИспользуй кнопки в чате или <code>fsh publish ${res.run}</code>`
        : `✅ <b>${escapeHtml(entry.name)}</b> готов!${res?.run ? ` (ран <code>${res.run}</code>)` : ''}`;
      await sayTo(parsed.chatId, text);
    } catch (e) {
      await sayTo(parsed.chatId, `❌ <b>${escapeHtml(entry.name)}</b>: ${escapeHtml(e.message)}`);
    }
  });
}

async function runCommand(parsed, d) {
  const { c, t, sayTo, ctxFor, commands, log, fire, runsDir, fetchImpl } = d;
  const { name, args, chatId } = parsed;
  const reply = (text) => sayTo(chatId, text);

  try {
    if (name === 'help' || name === 'start') {
      await reply(formatHelpTelegram());
      return;
    }

    if (name === 'mrs') {
      const filters = parseMRFilters(args);
      const r = commands.mrs
        ? await commands.mrs(filters)
        : await (async () => {
            const ctx = ctxFor();
            return cmdMRS(ctx.g, ctx.repo, { asObject: true, ...filters });
          })();
      const rows = (r.mrs ?? []).slice(0, 10);
      if (!rows.length) {
        await reply(anyFilter(filters) ? '<i>Под фильтры не попал ни один MR.</i>' : '<i>Открытых MR нет.</i>');
        return;
      }
      const items = rows.map(formatMRTelegram);
      await reply(`📋 <b>Открытые MR (${rows.length}):</b>\n\n${items.join('\n\n')}`);
      return;
    }

    if (name === 'mr' || /^\d+$/.test(name)) {
      const query = name === 'mr' ? args[0] : name;
      if (!query) {
        await reply('Использование: /mr <номер|ветка>');
        return;
      }
      const ctx = ctxFor();
      const mr = commands.mr
        ? await commands.mr(query)
        : await cmdMR(ctx.g, ctx.repo, query, { asObject: true });
      await reply(formatMRCard(mr));
      return;
    }

    if (name === 'jobs') {
      const query = args[0];
      if (!query) {
        await reply('Использование: /jobs <номер|ветка>');
        return;
      }
      const ctx = ctxFor();
      const res = commands.jobs
        ? await commands.jobs(query)
        : await cmdJobs(ctx.g, ctx.repo, query, { asObject: true });
      await reply(formatJobsTelegram(res));
      return;
    }

    if (name === 'comments' || name === 'threads' || name === 'mr_comments') {
      const query = args[0];
      if (!query) {
        await reply('Использование: /comments <номер|ветка>');
        return;
      }
      const ctx = ctxFor();
      const res = commands.comments
        ? await commands.comments(query)
        : await cmdMRComments(ctx.g, ctx.repo, [query], { asObject: true });
      await reply(formatCommentsTelegram(res));
      return;
    }

    if (name === 'deploy') {
      const [query, slotStr] = args;
      if (!query) {
        await reply('Использование: /deploy <номер|ветка> [слот]');
        return;
      }
      const slot = slotStr ? parseInt(slotStr, 10) : 1;
      await reply(`🚀 Запускаю деплой <b>${escapeHtml(query)}</b> (слот ${slot})…`);
      fire(async () => {
        try {
          const ctx = ctxFor();
          if (commands.deploy) {
            await commands.deploy(query, slot);
          } else {
            await cmdDeploy(ctx.g, ctx.repo, [query, slot], { asObject: true, quiet: true, yes: true });
          }
          await sayTo(chatId, `✅ Деплой <b>${escapeHtml(query)}</b> (слот ${slot}) успешно завершён!`);
        } catch (e) {
          await sayTo(chatId, `❌ Деплой <b>${escapeHtml(query)}</b> упал: ${escapeHtml(e.message)}`);
        }
      });
      return;
    }

    if (name === 'tasks') {
      const ctx = ctxFor();
      const res = commands.tasks
        ? await commands.tasks()
        : await cmdJira(ctx, ['mine'], { asObject: true });
      await reply(formatTasksListTelegram(res.issues ?? [], ctx));
      return;
    }

    if (name === 'task' || name === 'jira' || ISSUE_KEY.test(name.toUpperCase())) {
      const ctx = ctxFor();
      if (ISSUE_KEY.test(name.toUpperCase())) {
        const key = name.toUpperCase();
        const res = commands.jira
          ? await commands.jira([key])
          : await cmdJira(ctx, [key], { asObject: true });
        await reply(formatTaskCardTelegram(res.issue, res.comments, ctx));
        return;
      }

      const [sub, ...rest] = args;
      if (!sub || sub === 'mine' || sub === 'list') {
        const res = commands.tasks
          ? await commands.tasks()
          : await cmdJira(ctx, ['mine'], { asObject: true });
        await reply(formatTasksListTelegram(res.issues ?? [], ctx));
        return;
      }

      if (ISSUE_KEY.test(sub.toUpperCase()) && rest.length === 0) {
        const key = sub.toUpperCase();
        const res = commands.jira
          ? await commands.jira([key])
          : await cmdJira(ctx, [key], { asObject: true });
        await reply(formatTaskCardTelegram(res.issue, res.comments, ctx));
        return;
      }

      if (sub === 'start') {
        const key = rest[0]?.toUpperCase();
        if (!key || !ISSUE_KEY.test(key)) {
          await reply('Использование: /task start <KEY>');
          return;
        }
        const res = commands.task
          ? await commands.task(['start', key])
          : await cmdTask(ctx, ['start', key], { asObject: true });
        await reply(`🌿 <b>${key}</b>: ветка <code>${escapeHtml(res.branch)}</code> готова (состояние: ${res.state}, цель: <code>${escapeHtml(res.target)}</code>).`);
        return;
      }

      if (sub === 'push') {
        const key = rest[0]?.toUpperCase();
        await reply(`⏳ Пушу задачу ${key ? `<b>${key}</b>` : ''}…`);
        fire(async () => {
          try {
            const res = commands.task
              ? await commands.task(['push', key].filter(Boolean))
              : await cmdTask(ctx, ['push', key].filter(Boolean), { asObject: true, yes: true });
            const mrLink = res.mr?.web_url ? `<a href="${res.mr.web_url}">!${res.mr.iid}</a>` : `!${res.mr?.iid}`;
            await sayTo(chatId, `🚀 Ветка <code>${escapeHtml(res.branch)}</code> запушена!\n📌 MR: <b>${mrLink}</b> (${escapeHtml(res.target)})`);
          } catch (e) {
            await sayTo(chatId, `❌ push ${key || ''} упал: ${escapeHtml(e.message)}`);
          }
        });
        return;
      }

      if (sub === 'submit') {
        const key = rest[0]?.toUpperCase();
        await reply(`⏳ Отправляю задачу ${key ? `<b>${key}</b>` : ''} в ревью…`);
        fire(async () => {
          try {
            const res = commands.task
              ? await commands.task(['submit', key].filter(Boolean))
              : await cmdTask(ctx, ['submit', key].filter(Boolean), { asObject: true, yes: true });
            const mrLink = res.mr?.web_url ? `<a href="${res.mr.web_url}">!${res.mr.iid}</a>` : `!${res.mr?.iid}`;
            await sayTo(chatId, `✅ <b>${res.key}</b> отправлена в ревью!\nDraft снят с ${mrLink}, Jira: <code>${res.jira.from} ➔ ${res.jira.to}</code>${res.posted ? ', пост в MM отправлен' : ''}`);
          } catch (e) {
            await sayTo(chatId, `❌ submit ${key || ''} упал: ${escapeHtml(e.message)}`);
          }
        });
        return;
      }

      if (sub === 'move') {
        const [keyRaw, ...statusParts] = rest;
        const key = keyRaw?.toUpperCase();
        const toStatus = statusParts.join(' ');
        if (!key || !toStatus) {
          await reply('Использование: /task move <KEY> <статус>');
          return;
        }
        const res = commands.jira
          ? await commands.jira(['move', key, toStatus])
          : await cmdJira(ctx, ['move', key, toStatus], { asObject: true });
        await reply(`🔄 <b>${key}</b>: переход <code>${escapeHtml(res.from)}</code> ➔ <code>${escapeHtml(res.to)}</code> выполнен.`);
        return;
      }

      if (sub === 'comment') {
        const [keyRaw, ...textParts] = rest;
        const key = keyRaw?.toUpperCase();
        const text = textParts.join(' ');
        if (!key || !text) {
          await reply('Использование: /task comment <KEY> <текст>');
          return;
        }
        const res = commands.jira
          ? await commands.jira(['comment', key, text])
          : await cmdJira(ctx, ['comment', key, text], { asObject: true });
        await reply(`💬 Комментарий к <b>${key}</b> опубликован (#${res.comment_id}).`);
        return;
      }

      await reply('Использование: /tasks | /task <KEY> | /task start <KEY> | /task push [KEY] | /task submit [KEY] | /task move <KEY> <статус> | /task comment <KEY> <текст>');
      return;
    }

    const actionAliases = {
      review: 'review',
      conflict: 'conflict',
      ci_fix: 'ci-fix',
      cifix: 'ci-fix',
      implement: 'implement',
      analyze: 'analyze',
    };
    if (actionAliases[name]) {
      const actionName = actionAliases[name];
      const query = args.join(' ');
      if (!query) {
        await reply(`Использование: /${name} <${actionName === 'implement' || actionName === 'analyze' ? 'KEY' : 'mr|ветка'}>`);
        return;
      }
      await runActionViaBot(actionName, query, d, parsed);
      return;
    }

    if (name === 'watch') {
      const r = commands.watch
        ? await commands.watch()
        : await cmdWatch(ctxFor(), { asObject: true });
      await reply(formatWatchTelegram(r));
      return;
    }

    if (name === 'status') {
      const runs = listRuns({ ...(runsDir ? { root: runsDir } : {}), limit: 5 });
      const jobs = listJobs();
      const pending = listRuns({ ...(runsDir ? { root: runsDir } : {}), limit: 100 })
        .filter((r) => r.state === 'pending_approval').length;
      await reply(formatStatusTelegram(runs, jobs, pending));
      return;
    }

    if (name === 'run') {
      const [actionName, ...rest] = args;
      const entry = ACTIONS.find((x) => x.name === actionName);
      if (!entry || entry.action.target === 'none') {
        const list = ACTIONS.filter((x) => x.action.target !== 'none').map((x) => x.name).join(', ');
        await reply(`Действие «${actionName ?? ''}» недоступно. Есть: ${list}`);
        return;
      }
      const query = rest.join(' ');
      if (!query) {
        await reply(`Использование: /run ${actionName} <mr|ветка|ключ>`);
        return;
      }
      await runActionViaBot(actionName, query, d, parsed);
      return;
    }

    if (name === 'agent') {
      const knownAgents = ['cc', 'co', 'cco', 'agy', 'gemini', 'opus', 'claude'];
      let agentName = null;
      let promptParts = args;

      if (args[0] === '--agent' && args[1]) {
        agentName = args[1];
        promptParts = args.slice(2);
      } else if (args[0] && knownAgents.includes(args[0].toLowerCase())) {
        agentName = args[0].toLowerCase();
        promptParts = args.slice(1);
      }

      const prompt = promptParts.join(' ').trim();
      if (!prompt) {
        await reply(
          'Использование: /agent [профиль] <задача>\n\n' +
          'Примеры:\n' +
          '• /agent сделай рефакторинг Header.vue\n' +
          '• /agent cc посмотри открытые MR через fsh и создай ветку\n' +
          '• /agent agy запусти тесты и закоммить через fsh'
        );
        return;
      }

      const activeAgent = agentName || c.agent || 'agy';
      const projectDir = expandHome(c.projectDir || process.cwd());
      const promptPreview = prompt.length > 200 ? `${prompt.slice(0, 200)}…` : prompt;

      if (commands.agent) {
        await reply(`🤖 Запускаю агента <b>${escapeHtml(activeAgent)}</b> в <code>${escapeHtml(projectDir)}</code>…\n\n<i>${escapeHtml(promptPreview)}</i>`);
        fire(async () => {
          try {
            const res = await commands.agent({ agent: activeAgent, prompt, projectDir, cfg: c });
            const text = typeof res === 'string' ? res : (res?.text || 'Готово.');
            await sayTo(chatId, `✅ <b>Агент ${escapeHtml(activeAgent)} завершил задачу:</b>\n\n${escapeHtml(text)}`);
          } catch (e) {
            await sayTo(chatId, `❌ <b>Агент ${escapeHtml(activeAgent)}:</b> ${escapeHtml(e.message)}`);
          }
        });
        return;
      }

      await runAgentViaBot({ agentName: activeAgent, prompt, projectDir, d, parsed });
      return;
    }

    await reply('Неизвестная команда. Введи /help для списка доступных команд.');
  } catch (e) {
    log(`${stamp()} команда ${name} упала: ${e.message}`);
    await reply(`❌ Ошибка: ${escapeHtml(e.message)}`);
  }
}

async function runAgentViaBot({ agentName, prompt, projectDir, d, parsed }) {
  const { sayTo, c, fire, spawnAgentImpl = spawnAgent, activeAgents } = d;
  const chatId = parsed.chatId;

  if (!existsSync(projectDir)) {
    await sayTo(chatId, `❌ Каталог проекта не найден: <code>${escapeHtml(projectDir)}</code>`);
    return;
  }

  let agent;
  try {
    agent = resolveAgent(c, agentName);
  } catch (err) {
    await sayTo(chatId, `❌ ${escapeHtml(err.message)}`);
    return;
  }

  const promptPreview = prompt.length > 200 ? `${prompt.slice(0, 200)}…` : prompt;
  await sayTo(chatId, `🤖 Запускаю агента <b>${escapeHtml(agent.name)}</b> в <code>${escapeHtml(projectDir)}</code>…\n\n<i>${escapeHtml(promptPreview)}</i>`);

  fire(async () => {
    try {
      const isAgy = agent.family === 'agy';
      const streamJson = isAgy || (agent.family === 'claude' && !agent.args.includes('--output-format'));
      const extraArgs =
        isAgy ? ['--input-format', 'stream-json', '--output-format', 'stream-json', '-p=']
        : streamJson ? ['--output-format', 'stream-json', '--verbose', '-p']
        : ['-p'];

      const fullPrompt = [
        'Ты автономный AI-разработчик в проекте fitstars-frontend.',
        'Рабочая директория: текущий каталог проекта.',
        'Тебе доступны любые действия: чтение и изменение файлов, запуск команд в терминале (npm, git, тесты, линтеры) и CLI утилита `fsh` (FS-Harness).',
        'Справка по fsh: `fsh agent-guide`, `fsh mrs`, `fsh mr <id>`, `fsh jobs <id>`, `fsh deploy <id>`, `fsh task start|push|submit`, `fsh jira <KEY>`, `fsh commit`.',
        '',
        'Задача от пользователя:',
        prompt,
        '',
        'Выполни задачу полностью и дай краткий структурированный отчёт о том, что было сделано.',
      ].join('\n');

      const input = isAgy
        ? `${JSON.stringify({ event: 'user', message: { role: 'user', content: fullPrompt } })}\n`
        : fullPrompt;

      const proc = spawnAgentImpl({
        bin: agent.bin,
        args: [...agent.args, ...extraArgs],
        input,
        cwd: projectDir,
        env: {
          ...process.env,
          ...agent.env,
          GL_HELPER_REPO: c.repo || '',
          GL_HELPER_HOST: c.host || '',
          FS_HARNESS_PROJECT: c.activeProject || '',
        },
      });

      if (activeAgents) activeAgents.add(proc);

      const out = [];
      let resultText = null;

      proc.events?.on?.((ev) => {
        if (ev.t !== 'log') return;
        if (ev.stream === 'stdout' && streamJson) {
          const parsedLine = isAgy ? parseAgyLine(ev.text) : parseClaudeLine(ev.text);
          if (parsedLine.result !== null) {
            resultText = parsedLine.result;
            return;
          }
          if (parsedLine.passthrough) {
            out.push(parsedLine.passthrough);
          }
          return;
        }
        if (ev.stream === 'stdout') out.push(ev.text);
      });

      let done;
      try {
        done = await proc.result;
      } finally {
        if (activeAgents) activeAgents.delete(proc);
      }

      if (!done?.ok) {
        const how = done?.signal ? `прерван (${done.signal})` : `код ${done?.code ?? '?'}`;
        const tail = out.slice(-10).join('\n');
        await sayTo(chatId, `❌ <b>Агент ${escapeHtml(agent.name)}:</b> ${how}${tail ? `\n\n<pre>${escapeHtml(tail)}</pre>` : ''}`);
        return;
      }

      const answer = (resultText || out.join('\n') || 'Задача выполнена.').trim();
      const MAX_LEN = 3500;
      const formatted = answer.length > MAX_LEN ? `${answer.slice(0, MAX_LEN)}\n… (ответ обрезан)` : answer;
      await sayTo(chatId, `✅ <b>Агент ${escapeHtml(agent.name)} завершил задачу:</b>\n\n${escapeHtml(formatted)}`);
    } catch (e) {
      await sayTo(chatId, `❌ <b>Агент ${escapeHtml(agent.name)} упал:</b> ${escapeHtml(e.message)}`);
    }
  });
}

async function runCallback(cb, d) {
  const { c, t, sayTo, fire, publish, revise, runsDir, fetchImpl, log } = d;
  const root = runsDir ?? RUNS_DIR;

  let saved;
  try {
    saved = readRun(cb.runId, { root });
  } catch {
    await answerCallbackQuery(t.token, cb.callbackId, { text: 'Ран не найден', fetchImpl }).catch(() => {});
    return;
  }
  const m = saved.meta;
  const nonce = m.approval?.nonce;
  const okState = m.state === 'pending_approval' && nonce && nonce === cb.nonce;
  if (!okState) {
    await answerCallbackQuery(t.token, cb.callbackId, { text: 'Устарело или уже обработано', fetchImpl }).catch(() => {});
    if (cb.chatId != null && cb.messageId != null) {
      await editMessageReplyMarkup(t.token, cb.chatId, cb.messageId, { reply_markup: null, fetchImpl }).catch(() => {});
    }
    return;
  }

  // Одноразовость до начала работы: упали посреди publish — кнопка уже мертва.
  patchRunMeta({ id: cb.runId, root }, { approval: { ...(m.approval ?? {}), nonce: null } });

  if (cb.cmd === 'rej') {
    patchRunMeta({ id: cb.runId, root }, { state: 'rejected' });
    if (m.worktree && m.project_dir) {
      try { removeWorktree(makeGit(m.project_dir), m.worktree, m.branch); } catch { /* уже нет */ }
    }
    await answerCallbackQuery(t.token, cb.callbackId, { text: 'Отклонено', fetchImpl }).catch(() => {});
    if (cb.chatId != null && cb.messageId != null) {
      await editMessageReplyMarkup(t.token, cb.chatId, cb.messageId, { reply_markup: null, fetchImpl }).catch(() => {});
    }
    await sayTo(cb.chatId, `🚫 Ран <code>${cb.runId}</code> отклонён, worktree убран.`);
    return;
  }

  if (cb.cmd === 'appr') {
    await answerCallbackQuery(t.token, cb.callbackId, { text: 'Публикую…', fetchImpl }).catch(() => {});
    fire(async () => {
      try {
        const ctx = makeCtxLike(c, d);
        const res = await publish(cb.runId, { ctx, find: findCommand, runsDir, fetchImpl, opts: { yes: true, json: true } });
        if (cb.chatId != null && cb.messageId != null) {
          await editMessageReplyMarkup(t.token, cb.chatId, cb.messageId, { reply_markup: null, fetchImpl }).catch(() => {});
        }
        await sayTo(cb.chatId, `✅ Ран <code>${cb.runId}</code> опубликован!`);
      } catch (e) {
        await sayTo(cb.chatId, `❌ publish <code>${cb.runId}</code>: ${escapeHtml(e.message)}`);
      }
    });
    return;
  }

  if (cb.cmd === 'rev') {
    await answerCallbackQuery(t.token, cb.callbackId, { text: 'Отправил на доделку', fetchImpl }).catch(() => {});
    fire(async () => {
      try {
        const ctx = makeCtxLike(c, d);
        await revise(cb.runId, { ctx, find: findCommand, runsDir, fetchImpl, approvalSink: undefined });
        if (cb.chatId != null && cb.messageId != null) {
          await editMessageReplyMarkup(t.token, cb.chatId, cb.messageId, { reply_markup: null, fetchImpl }).catch(() => {});
        }
        await sayTo(cb.chatId, `↻ Ран <code>${cb.runId}</code> ушёл на доделку.`);
      } catch (e) {
        await sayTo(cb.chatId, `❌ revise <code>${cb.runId}</code>: ${escapeHtml(e.message)}`);
      }
    });
  }
}

// ctx для publish/revise в демоне: тот же makeCtx, что и для команд.
function makeCtxLike(c, d) {
  return d.makeCtx ? d.makeCtx(c) : defaultCtx(c);
}
