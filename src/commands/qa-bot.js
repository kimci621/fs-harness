// fsh qa-bot — бот тестировщика в личке Mattermost: контекст задачи Jira и ветки,
// ответы агента только на чтение, тег разработчика при баге, деплой на dev-стенд, фича-флаги.
import path from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig, expandHome } from '../config.js';
import { readSecret } from '../secrets.js';
import { CliError } from '../errors.js';
import { createMattermost } from '../mattermost.js';
import { makeGit } from '../workspace.js';
import { createJira } from '../jira.js';
import { createGlab } from '../glab.js';
import { cmdDeploy } from './deploy.js';
import { createGrowthBook } from '../growthbook.js';
import { cmdGrowthBook } from './growthbook.js';

const execFileAsync = promisify(execFile);
export const STATE_ROOT = path.join(homedir(), '.local', 'state', 'fs-harness');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Агент только читает: других инструментов у него нет, Bash — только перечисленные команды.
// Флагами agy так не ограничить: он сам выходит из песочницы, поэтому здесь claude.
const AGENT_TOOLS = 'Read,Grep,Glob,Bash';
const AGENT_BASH = ['git log', 'git diff', 'git show', 'fsh growthbook list', 'fsh growthbook get']
  .map((c) => `Bash(${c}:*)`).join(',');

// Флаги тестировщик пишет только сюда: production через бота не трогается.
const QA_FLAG_ENVS = ['dev', 'loadtest'];

// Лимит поста в MM — 16383 символа, берём с запасом.
const MAX_POST = 15000;

export function extractTaskKey(text) {
  if (typeof text !== 'string') return null;
  const match = text.match(/\b([A-Za-z]+-\d+)\b/);
  return match ? match[1].toUpperCase() : null;
}

export function findTaskBranch(projectDir, taskKey, { gitImpl } = {}) {
  try {
    const git = typeof gitImpl === 'function' ? gitImpl : makeGit(projectDir);
    const out = git(['branch', '-a', '--list', `*${taskKey}*`], projectDir, { allowFail: true });
    if (!out) return null;
    const lines = out.split('\n').map((l) => l.trim().replace(/^[*+]\s+/, '')).filter(Boolean);
    const matching = lines.filter((l) => l.toLowerCase().includes(taskKey.toLowerCase()));
    if (!matching.length) return null;
    const local = matching.find((l) => !l.startsWith('remotes/'));
    return local || matching[0].replace(/^remotes\/origin\//, '');
  } catch {
    return null;
  }
}

export function getBranchDiffStat(projectDir, branch, { gitImpl } = {}) {
  if (!branch) return null;
  try {
    const git = typeof gitImpl === 'function' ? gitImpl : makeGit(projectDir);
    let stat = git(['diff', '--stat', `origin/dev...${branch}`], projectDir, { allowFail: true });
    if (!stat) {
      stat = git(['diff', '--stat', `dev...${branch}`], projectDir, { allowFail: true });
    }
    return stat ? stat.trim() : null;
  } catch {
    return null;
  }
}

export function buildQaPrompt({
  taskKey,
  taskSummary = '',
  taskDescription = '',
  technicalDetails = '',
  branch = '',
  diffStat = '',
  question = '',
}) {
  return [
    'Ты AI-ассистент разработчика в репозитории fitstars-frontend, помогающий тестировщику (QA).',
    'Твоя задача: ответить на вопросы тестировщика ясно, конкретно и по делу на русском языке.',
    '',
    'РЕЖИМ ТОЛЬКО ЧТЕНИЕ:',
    '1. Доступны только Read, Grep, Glob и команды git log, git diff, git show, fsh growthbook list, fsh growthbook get. Остальное заблокировано.',
    '2. Ветку задачи не переключай: код ветки читай через git show <ветка>:<путь> и git diff.',
    '3. Не делай слепой поиск по всей папке — исключай node_modules, .git, dist, build. Ищи целенаправленно.',
    '',
    'КОНТЕКСТ ЗАДАЧИ:',
    `Ключ задачи: ${taskKey}`,
    taskSummary ? `Название задачи: ${taskSummary}` : '',
    branch ? `Ветка в git: ${branch}` : '',
    diffStat ? `Изменённые файлы:\n${diffStat}` : '',
    taskDescription ? `\nОписание задачи и Acceptance Criteria:\n${taskDescription}` : '',
    technicalDetails ? `\nТехнические детали для QA:\n${technicalDetails}` : '',
    '',
    'ВОПРОС ТЕСТИРОВЩИКА:',
    question,
    '',
    'ИНСТРУКЦИЯ ПО ОТВЕТУ:',
    '- Ответ уходит в Mattermost: пиши в Markdown.',
    '- Если вопрос про фича-флаг: укажи точное имя флага (из GrowthBook/кода) и его нужное состояние (on/off/вариант).',
    '  Флаг тестировщик переключает сам командой бота: `!flag on <имя>` (dev), `!flag set <имя> <значение>`.',
    '- Если вопрос "почему не отображается" или "как сделать так, чтобы показалось": найди в коде точные условия показа (v-if, гварды, проверки полей/ролей/тарифов/разрешения экрана) и объясни, что требуется.',
    '- Если в ходе анализа кода ты обнаруживаешь РЕАЛЬНЫЙ БАГ в коде (несоответствие требованиям задачи/AC, логическую ошибку, поломанную верстку/клики, опечатку):',
    '  ОБЯЗАТЕЛЬНО начни свой ответ со специального блока:',
    '  [BUG_DETECTED]',
    '  Суть бага: <краткое и точное описание>',
    '  Где в коде: <путь к файлу и строки>',
    '  Ожидаемое vs фактическое поведение: <почему это баг относительно требований>',
    '  [/BUG_DETECTED]',
    '  После этого блока дай тестировщику подробный разбор ситуации.',
    '- Если баг не обнаружен, отвечай прямо, дружелюбно и понятно без блока [BUG_DETECTED].',
  ].filter(Boolean).join('\n');
}

export function parseQaResponse(response = '') {
  const bugMatch = response.match(/\[BUG_DETECTED\]([\s\S]*?)\[\/BUG_DETECTED\]/i);
  if (!bugMatch) {
    return {
      hasBug: false,
      bugDetails: null,
      cleanResponse: response.trim(),
    };
  }
  const bugDetails = bugMatch[1].trim();
  const cleanResponse = response.replace(/\[BUG_DETECTED\][\s\S]*?\[\/BUG_DETECTED\]/i, '').trim();
  return {
    hasBug: true,
    bugDetails,
    cleanResponse,
  };
}

const quote = (text) => text.split('\n').map((l) => `> ${l}`).join('\n');

export function formatBugAlert({ taskKey, bugDetails, cleanResponse, developer = '' }) {
  const tag = developer ? `@${developer}` : 'разработчик';
  return [
    `🚨 **Внимание, обнаружен потенциальный баг!** ${developer ? tag : ''}`.trim(),
    `По задаче **${taskKey}** в реализации найдено несоответствие:`,
    '',
    quote(bugDetails),
    '',
    `👉 ${tag}, просьба подключиться и поправить баг вместе с тестировщиком.`,
    '',
    '---',
    '📋 **Разбор для тестировщика:**',
    cleanResponse,
  ].join('\n');
}

export function splitMessage(text = '', maxLen = MAX_POST) {
  if (text.length <= maxLen) return [text];
  const parts = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let splitIdx = remaining.lastIndexOf('\n\n', maxLen);
    if (splitIdx === -1 || splitIdx < maxLen / 2) {
      splitIdx = remaining.lastIndexOf('\n', maxLen);
    }
    if (splitIdx === -1 || splitIdx < maxLen / 2) {
      splitIdx = remaining.lastIndexOf(' ', maxLen);
    }
    if (splitIdx === -1 || splitIdx < maxLen / 2) {
      splitIdx = maxLen;
    }
    parts.push(remaining.slice(0, splitIdx).trim());
    remaining = remaining.slice(splitIdx).trim();
  }
  if (remaining.length) parts.push(remaining);
  return parts;
}

// Слэш-команды MM перехватывает сам сервер («команда не найдена»), поэтому команды бота — через «!».
export function parseQaPost(message = '') {
  const text = typeof message === 'string' ? message.trim() : '';
  if (!text) return { kind: 'ignored' };
  if (text.startsWith('!')) {
    const [rawCmd, ...args] = text.slice(1).split(/\s+/);
    return { kind: 'command', name: rawCmd.toLowerCase(), args };
  }
  return { kind: 'text', text };
}

export async function runQaAgent({
  prompt,
  sessionId = null,
  cwd,
  timeoutMs = 300000,
  execImpl = execFileAsync,
}) {
  const args = [
    '-p',
    '--model', 'haiku',
    '--tools', AGENT_TOOLS,
    '--allowedTools', AGENT_BASH,
    '--permission-mode', 'dontAsk',
    // Свои allow-правила и хуки из настроек пользователя агенту не нужны: они шире read-only.
    '--setting-sources', '',
    '--strict-mcp-config',
    '--output-format', 'json',
    ...(sessionId ? ['--resume', sessionId] : []),
    prompt,
  ];
  const { stdout } = await execImpl('claude', args, {
    cwd,
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, CLAUDE_ROUTER_OFF: '1' },
  });
  let out;
  try {
    out = JSON.parse(stdout);
  } catch {
    throw new Error(`агент вернул не JSON: ${stdout.trim().slice(0, 200)}`);
  }
  if (out.is_error) throw new Error(out.result || 'агент завершился с ошибкой');
  return { sessionId: out.session_id || sessionId, response: out.result || '' };
}

export function loadQaBotState(root = STATE_ROOT) {
  try {
    return JSON.parse(readFileSync(path.join(root, 'qa-bot.json'), 'utf8'));
  } catch {
    return { since: null, sessions: {} };
  }
}

export function saveQaBotState(root = STATE_ROOT, state = {}) {
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, 'qa-bot.json'), JSON.stringify(state, null, 2) + '\n');
}

// Деплой ветки/MR на dev-стенд: фронт (активный проект) или его бэкенд.
export async function runQaDeploy({ env = process.env, loadCfg = loadConfig, query, slot, backend = false }) {
  const active = loadCfg(env, {});
  let cfg = active;
  let project = active.activeProject || 'frontend';
  if (backend) {
    const backendName = active.backend?.name;
    if (!backendName) {
      throw new CliError('У активного проекта не задан бэкенд (projects.<имя>.backend в конфиге).', 1, 'config_invalid');
    }
    cfg = loadCfg(env, { project: backendName });
    project = backendName;
  }
  if (!cfg.repo) throw new CliError(`Не задан repo для проекта "${project}".`, 1, 'config_invalid');
  const g = createGlab(undefined, { host: cfg.host });
  const res = await cmdDeploy(g, cfg.repo, [query, slot], {
    asObject: true,
    quiet: true,
    buildJob: cfg.buildJob || undefined,
  });
  return { project, ...res };
}

export async function fetchJiraTask(ctx, taskKey, { readSecretImpl = readSecret } = {}) {
  try {
    const token = readSecretImpl('jira', { required: false });
    if (!token || !ctx.cfg?.jira?.baseUrl) return { summary: '', description: '', technicalDetails: '' };
    const j = ctx.jira ? ctx.jira() : createJira({ ...ctx.cfg.jira, token });
    const issue = await j.issue(taskKey);
    const summary = issue.fields?.summary || '';
    const description = issue.renderedFields?.description || issue.fields?.description || '';
    let technicalDetails = '';
    const names = issue.names || {};
    for (const [id, label] of Object.entries(names)) {
      if (/technical.*qa|техническ.*qa|детали.*qa/i.test(label)) {
        technicalDetails = issue.fields?.[id] || '';
        break;
      }
    }
    return { summary, description, technicalDetails };
  } catch {
    return { summary: '', description: '', technicalDetails: '' };
  }
}

export async function cmdQaBot(opts = {}, deps = {}) {
  const {
    env = process.env,
    loadCfg = loadConfig,
    fetchImpl = fetch,
    sleepImpl = sleep,
    execImpl = execFileAsync,
    readSecretImpl = readSecret,
    stateRoot = STATE_ROOT,
    log = console.log,
    cycles = Infinity,
    intervalMs = 3000,
    deployImpl = runQaDeploy,
  } = deps;

  const cfg = loadCfg(env, {});
  const qaCfg = cfg.mattermost?.qaBot || {};
  const developer = qaCfg.developer || '';
  const allowedNames = qaCfg.allowed || [];
  const token = readSecretImpl('mattermost-qa', { required: false });
  if (!token) {
    throw new CliError('Нет токена QA-бота: положи токен бота Mattermost в ~/.mm_qa_growth_bot_key или экспортируй FS_HARNESS_MATTERMOST_QA.', 1, 'secret_missing');
  }
  const mm = createMattermost({ ...cfg.mattermost, token, fetchImpl });
  // Ключ GrowthBook читается при первой !flag: без него бот работает, нет только флагов.
  const gbCtx = { cfg, gb: () => createGrowthBook({ ...cfg.growthbook, token: readSecretImpl('growthbook'), fetchImpl }) };
  const projectDir = opts.projectDir || expandHome(cfg.projects?.['fitstars-frontend']?.dir || cfg.projectDir || process.cwd());

  const me = await mm.me();
  // Логины → id один раз на старте: в постах MM только user_id.
  const names = [...new Set([...allowedNames, ...(developer ? [developer] : [])])];
  const users = names.length ? await mm.usersByUsernames(names) : [];
  const idByName = new Map(users.map((u) => [u.username, u.id]));
  const allowed = new Set(allowedNames.map((n) => idByName.get(n)).filter(Boolean));
  const developerId = developer ? idByName.get(developer) : null;
  const unknown = names.filter((n) => !idByName.has(n));
  if (unknown.length) log(`⚠️ В Mattermost нет пользователей: ${unknown.join(', ')}`);

  log(`🤖 QA-бот @${me.username} запущен в каталоге ${projectDir}`);
  log(`👤 Разработчик: ${developer ? `@${developer}` : 'не задан'}, доступ: ${allowedNames.join(', ') || 'никому (mattermost.qaBot.allowed пуст)'}`);

  const state = loadQaBotState(stateRoot);
  // Первый запуск не разгребает старую переписку: только то, что пришло после старта.
  let since = state.since ?? Date.now();
  const sessions = state.sessions || {};
  const save = () => saveQaBotState(stateRoot, { since, sessions });

  let stopped = false;
  const stop = () => { stopped = true; };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  // Деплой идёт минутами и не должен блокировать опрос: убираем в фон, дожидаемся на выходе.
  const pending = new Set();
  const fire = (fn) => {
    const p = Promise.resolve().then(fn).catch((e) => {
      log(`фоновая задача упала: ${e.message}`);
    });
    pending.add(p);
    p.finally(() => pending.delete(p));
    return p;
  };

  const reply = async (channelId, text) => {
    for (const chunk of splitMessage(text)) await mm.post(channelId, chunk);
  };

  async function loadTask(channelId, taskKey) {
    const jiraInfo = await fetchJiraTask({ cfg }, taskKey, { readSecretImpl });
    const branch = findTaskBranch(projectDir, taskKey);
    const diffStat = getBranchDiffStat(projectDir, branch);
    sessions[channelId] = {
      taskKey,
      taskSummary: jiraInfo.summary,
      taskDescription: jiraInfo.description,
      technicalDetails: jiraInfo.technicalDetails,
      branch: branch || '',
      diffStat: diffStat || '',
      sessionId: null,
      updatedAt: Date.now(),
    };
    save();
    return sessions[channelId];
  }

  async function handleCommand(channelId, { name, args }) {
    const session = sessions[channelId] || null;

    if (name === 'help' || name === 'start') {
      await reply(channelId, [
        `👋 **Привет! Я QA-ассистент разработчика${developer ? ` (@${developer})` : ''}.**`,
        'Помогаю тестировщикам разобраться, как работает функционал, какие нужны фича-флаги, условия для отображения, и проверяю код на баги.',
        '',
        '**Команды:**',
        '- `!task <KEY>` — зафиксировать или сменить задачу (например, `!task FD-8096`)',
        '- `!current` — показать текущую задачу',
        '- `!reset` — сбросить контекст задачи',
        '- `!deploy [be] <mr|ветка> [слот]` — задеплоить ветку на dev-стенд (1–10; `be` — бэкенд)',
        '- `!flag <id>` — флаг GrowthBook; `!flag create <id> [тип] [дефолт]`, `!flag on|off <id> [dev|loadtest]`, `!flag set <id> <значение>`',
        '- `!help` — эта справка',
        '',
        session?.taskKey
          ? `📌 Сейчас активна задача: **${session.taskKey}**`
          : 'По какой задаче вопрос? Назови номер задачи Jira (например, `FD-8096`).',
      ].join('\n'));
      return;
    }

    if (name === 'current') {
      if (!session?.taskKey) {
        await reply(channelId, 'Сейчас нет активной задачи. Назови номер задачи Jira (например, `FD-8096`).');
        return;
      }
      await reply(channelId, [
        `📌 **Активная задача:** \`${session.taskKey}\``,
        session.taskSummary ? `📝 ${session.taskSummary}` : '',
        session.branch ? `🌿 Ветка: \`${session.branch}\`` : '',
        '',
        'Задавай любой вопрос по этой задаче!',
      ].filter(Boolean).join('\n'));
      return;
    }

    if (name === 'reset') {
      delete sessions[channelId];
      save();
      await reply(channelId, '🔄 Контекст задачи сброшен. По какой задаче вопрос?');
      return;
    }

    if (name === 'task') {
      const taskKey = extractTaskKey(args[0] || '');
      if (!taskKey) {
        await reply(channelId, 'Использование: `!task FD-8096`');
        return;
      }
      await reply(channelId, `⏳ Подтягиваю данные по задаче **${taskKey}**…`);
      const s = await loadTask(channelId, taskKey);
      await reply(channelId, [
        `📌 **Зафиксировал задачу:** \`${taskKey}\``,
        s.taskSummary ? `📝 ${s.taskSummary}` : '',
        s.branch ? `🌿 Ветка: \`${s.branch}\`` : '⚠️ Локальная ветка не найдена (будет проверен dev)',
        '',
        'Какой у тебя вопрос по этой задаче? (например: какой нужен фича-флаг, почему не отображается элемент, как проверить)',
      ].filter(Boolean).join('\n'));
      return;
    }

    if (name === 'deploy') {
      // !deploy [be|backend] <mr|ветка> [слот]
      let backend = false;
      let rest = args;
      if (args[0] && /^(be|backend|api)$/i.test(args[0])) {
        backend = true;
        rest = args.slice(1);
      }
      const [query, slotStr] = rest;
      if (!query) {
        await reply(channelId, [
          'Использование:',
          '- `!deploy <mr|ветка> [слот]` — фронт на dev-стенд',
          '- `!deploy be <mr|ветка> [слот]` — бэкенд',
          'Слот: 1–10 (по умолчанию 1). Например: `!deploy be FD-8096 3` → dev3.',
        ].join('\n'));
        return;
      }
      let slot = 1;
      if (slotStr != null) {
        if (!/^\d+$/.test(slotStr) || Number(slotStr) < 1 || Number(slotStr) > 10) {
          await reply(channelId, 'Слот — число от 1 до 10 (например, `3` → dev3).');
          return;
        }
        slot = Number(slotStr);
      }
      const label = backend ? 'бэкенда' : 'фронта';
      await reply(channelId, `🚀 Запускаю деплой ${label}: \`${query}\` → dev${slot}. Пришлю итог сюда.`);
      fire(async () => {
        try {
          const res = await deployImpl({ query, slot, backend, env, loadCfg });
          const link = res.deploy?.web_url || res.pipeline?.web_url || '';
          await reply(channelId, `✅ Деплой ${label} готов: MR \`!${res.mr}\` → dev${slot}${link ? `\n🔗 ${link}` : ''}`);
        } catch (e) {
          await reply(channelId, `❌ Деплой ${label} \`${query}\` упал:\n${e.message}`);
        }
      });
      return;
    }

    if (name === 'flag') {
      try {
        await reply(channelId, await handleFlag(args));
      } catch (e) {
        await reply(channelId, `❌ ${e.message}`);
      }
      return;
    }

    await reply(channelId, `Не знаю команду \`!${name}\`. Список: \`!help\``);
  }

  // !flag <id> | create <id> [тип] [дефолт] | on|off <id> [окружение] | set <id> <значение>
  async function handleFlag([sub, id, ...rest]) {
    const usage = [
      'Использование:',
      '- `!flag <id>` — показать флаг',
      '- `!flag create <id> [boolean|string|number|json] [дефолт]` — создать, включён в dev',
      `- \`!flag on|off <id> [${QA_FLAG_ENVS.join('|')}]\` — включить или выключить (по умолчанию dev)`,
      '- `!flag set <id> <значение>` — дефолтное значение',
    ].join('\n');
    const gb = (args, opts = {}) => cmdGrowthBook(gbCtx, args, { asObject: true, ...opts });
    const done = (f) => `✅ Флаг \`${f.id}\` · ${f.type} · default \`${f.default}\`\n${f.envs}`;

    if (!sub) return usage;
    if (!['create', 'on', 'off', 'set'].includes(sub)) return done((await gb(['get', sub])).flag);
    if (!id) return usage;

    if (sub === 'create') {
      const [type, value] = rest;
      return done((await gb(['create', id, 'on'], { env: QA_FLAG_ENVS[0], type, default: value })).flag);
    }
    if (sub === 'set') {
      if (!rest.length) return usage;
      // Дефолт общий для всех окружений: правка не должна доехать до включённого прода.
      const f = await gbCtx.gb().feature(id);
      const live = Object.entries(f.environments ?? {}).filter(([e, v]) => v.enabled && !QA_FLAG_ENVS.includes(e)).map(([e]) => e);
      if (live.length) return `⛔ Флаг \`${id}\` включён в ${live.join(', ')}: дефолт поменяется и там. Попроси ${developer ? `@${developer}` : 'разработчика'}.`;
      return done((await gb(['set', id, rest.join(' ')])).flag);
    }
    const env = rest[0] || QA_FLAG_ENVS[0];
    if (!QA_FLAG_ENVS.includes(env)) return `⛔ Через бота флаги переключаются только в ${QA_FLAG_ENVS.join(', ')}.`;
    return done((await gb(['toggle', id, sub], { env })).flag);
  }

  async function handleQuestion(channelId, post, userText) {
    const detectedKey = extractTaskKey(userText);
    const current = sessions[channelId];
    if (detectedKey && detectedKey !== current?.taskKey) {
      const s = await loadTask(channelId, detectedKey);
      // Сообщение — только ключ задачи: зафиксировали и ждём вопрос.
      if (userText.trim().toUpperCase() === detectedKey) {
        await reply(channelId, [
          `📌 **Зафиксировал задачу:** \`${detectedKey}\``,
          s.taskSummary ? `📝 ${s.taskSummary}` : '',
          s.branch ? `🌿 Ветка: \`${s.branch}\`` : '',
          '',
          'Какой у тебя вопрос по этой задаче?',
        ].filter(Boolean).join('\n'));
        return;
      }
    }

    const session = sessions[channelId];
    if (!session?.taskKey) {
      await reply(channelId, 'По какой задаче вопрос? Назови номер задачи Jira (например, `FD-8096`), чтобы я загрузил требования и код.');
      return;
    }

    const status = await mm.post(channelId, 'Думаю…');
    let res;
    try {
      res = await runQaAgent({
        prompt: buildQaPrompt({ ...session, question: userText }),
        sessionId: session.sessionId,
        cwd: projectDir,
        execImpl,
      });
      session.sessionId = res.sessionId;
      save();
    } catch (err) {
      log(`Ошибка агента: ${err.message}`);
      await mm.patchPost(status.id, `⚠️ Ошибка при анализе через AI-агента: ${err.message}`);
      return;
    }

    const { hasBug, bugDetails, cleanResponse } = parseQaResponse(res.response);
    const text = hasBug
      ? formatBugAlert({ taskKey: session.taskKey, bugDetails, cleanResponse, developer })
      : cleanResponse;
    const [first, ...restChunks] = splitMessage(text);
    await mm.patchPost(status.id, first);
    for (const chunk of restChunks) await mm.post(channelId, chunk);

    // В личке тестировщика упоминание разработчика не будит: дублируем ему в личку с ботом.
    if (hasBug && developerId && post.user_id !== developerId) {
      try {
        const dm = await mm.directChannel(me.id, developerId);
        await reply(dm.id, [
          `🚨 **QA-бот обнаружил баг в задаче ${session.taskKey}!**`,
          '',
          quote(bugDetails),
          '',
          `Вопрос QA: _${userText}_`,
        ].join('\n'));
      } catch (e) {
        log(`Не удалось переслать алерт разработчику: ${e.message}`);
      }
    }
  }

  async function handlePost(post) {
    const channelId = post.channel_id;
    if (!allowed.has(post.user_id)) {
      const [who] = await mm.usersByIds([post.user_id]).catch(() => []);
      log(`⛔ Нет доступа: @${who?.username ?? post.user_id} — добавь логин в mattermost.qaBot.allowed`);
      await reply(channelId, `⛔ Нет доступа к QA-боту. Попроси ${developer ? `@${developer}` : 'разработчика'} добавить тебя.`);
      return;
    }
    const parsed = parseQaPost(post.message);
    if (parsed.kind === 'command') await handleCommand(channelId, parsed);
    else if (parsed.kind === 'text') await handleQuestion(channelId, post, parsed.text);
  }

  let cycle = 0;
  try {
    while (!stopped && cycle < cycles) {
      cycle++;
      let posts = [];
      try {
        const channels = await mm.allMyChannels();
        // ponytail: опрос по каналу на каждую личку с новыми постами; при сотне тестировщиков — вебсокет MM.
        for (const c of channels.filter((ch) => ch.type === 'D' && ch.last_post_at > since)) {
          const page = await mm.postsSince(c.id, since);
          posts.push(...Object.values(page.posts || {}));
        }
      } catch (err) {
        log(`Mattermost: ${err.message}, повтор через 5с`);
        await sleepImpl(5000);
        continue;
      }
      // since отдаёт и правки старых постов: берём только новые, не свои и не системные.
      posts = posts
        .filter((p) => p.create_at > since && p.user_id !== me.id && !p.type && !p.delete_at)
        .sort((a, b) => a.create_at - b.create_at);

      for (const post of posts) {
        if (stopped) break;
        since = post.create_at;
        save();
        try {
          await handlePost(post);
        } catch (err) {
          log(`Пост ${post.id}: ${err.message}`);
        }
      }
      if (cycle < cycles) await sleepImpl(intervalMs);
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await Promise.allSettled(pending);
  }

  log('QA-бот остановлен.');
  return { ok: true, cycles: cycle, since };
}
