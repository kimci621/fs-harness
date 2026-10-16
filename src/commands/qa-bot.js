import path from 'node:path';
import { homedir } from 'node:os';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig, expandHome } from '../config.js';
import { readSecret } from '../secrets.js';
import { CliError } from '../errors.js';
import { tgCall, getUpdates, sendMessage, editMessageText, deleteMessage, escapeHtml } from '../tgbot.js';
import { makeGit } from '../workspace.js';
import { createJira } from '../jira.js';
import { createGlab } from '../glab.js';
import { cmdDeploy } from './deploy.js';

const execFileAsync = promisify(execFile);
export const STATE_ROOT = path.join(homedir(), '.local', 'state', 'fs-harness');
export const QA_TOKEN_FILE = path.join(homedir(), '.tg_qa_bot');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    'СВЕРХВАЖНОЕ ПРАВИЛО — РЕЖИМ ТОЛЬКО ЧТЕНИЕ:',
    '1. ТЕБЕ СТРОГО ЗАПРЕЩЕНО изменять, создавать или удалять файлы.',
    '2. ЗАПРЕЩЕНО делать git commit, git push, git checkout, git merge, git reset.',
    '3. ЗАПРЕЩЕНО менять задачи в Jira или переключать флаги в GrowthBook.',
    '4. Ты можешь ТОЛЬКО ЧИТАТЬ код (view_file, поиск по коду, git diff/log/show, fsh growthbook list, fsh jira).',
    '5. Не делай слепой поиск по всей папке — исключай node_modules, .git, dist, build. Ищи целенаправленно.',
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
    '- Если вопрос про фича-флаг: укажи точное имя флага (из GrowthBook/кода) и его нужное состояние (on/off/вариант).',
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

export function markdownToTelegramHtml(markdown = '') {
  if (!markdown) return '';
  let text = escapeHtml(markdown);
  text = text.replace(/```(?:[a-zA-Z0-9_-]+)?\n([\s\S]*?)```/g, (_, code) => `<pre><code>${code}</code></pre>`);
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
  text = text.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  return text;
}

export function formatBugAlert({
  taskKey,
  bugDetails,
  cleanResponse,
  developerTag = '@amir_ltpf',
}) {
  const parts = [
    `🚨 <b>Внимание, обнаружен потенциальный баг!</b> ${developerTag}`,
    `По задаче <b>${escapeHtml(taskKey)}</b> в реализации найдено несоответствие:`,
    '',
    `<blockquote>${escapeHtml(bugDetails)}</blockquote>`,
    '',
    `👉 ${developerTag}, просьба подключиться и поправить баг вместе с тестировщиком.`,
    '',
    '━━━━━━━━━━━━━━━━━━━━',
    '📋 <b>Разбор для тестировщика:</b>',
    markdownToTelegramHtml(cleanResponse),
  ];
  return parts.join('\n');
}

export function splitTelegramMessage(text = '', maxLen = 3800) {
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

export function handleQaUpdate(u, { botUsername = '' } = {}) {
  const msg = u?.message;
  if (!msg) return { kind: 'ignored' };
  const rawText = typeof msg.text === 'string' ? msg.text.trim() : '';
  if (!rawText) return { kind: 'ignored' };

  const chatId = msg.chat?.id;
  const messageId = msg.message_id;
  const fromId = msg.from?.id;
  const isGroup = msg.chat?.type === 'group' || msg.chat?.type === 'supergroup';

  if (rawText.startsWith('/')) {
    const [rawCmd, ...args] = rawText.slice(1).split(/\s+/);
    const cmdName = rawCmd.split('@')[0].toLowerCase();
    return {
      kind: 'command',
      name: cmdName,
      args,
      chatId,
      messageId,
      fromId,
      isGroup,
    };
  }

  let text = rawText;
  if (botUsername && text.includes(`@${botUsername}`)) {
    text = text.replace(new RegExp(`@${botUsername}`, 'gi'), '').trim();
  }

  return {
    kind: 'text',
    text,
    chatId,
    messageId,
    fromId,
    isGroup,
  };
}

export async function runAgyQuery({
  prompt,
  conversationId = null,
  cwd,
  timeoutMs = 180000,
  execImpl = execFileAsync,
}) {
  const args = [
    '-p', prompt,
    '--model', 'gemini-3.8-flash',
    '--effort', 'medium',
    '--dangerously-skip-permissions',
    '--output-format', 'json',
  ];
  if (conversationId) {
    args.push('--conversation', conversationId);
  }

  const { stdout } = await execImpl('agy', args, {
    cwd,
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, CLAUDE_ROUTER_OFF: '1' },
  });

  const raw = stdout.trim();
  try {
    const parsed = JSON.parse(raw);
    return {
      conversationId: parsed.conversation_id || conversationId,
      response: parsed.response || raw,
    };
  } catch {
    const jsonMatch = raw.match(/\{[\s\S]*"conversation_id"[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          conversationId: parsed.conversation_id || conversationId,
          response: parsed.response || raw,
        };
      } catch {}
    }
    return {
      conversationId,
      response: raw,
    };
  }
}

export function loadQaBotState(root = STATE_ROOT) {
  try {
    return JSON.parse(readFileSync(path.join(root, 'qa-bot.json'), 'utf8'));
  } catch {
    return { offset: null, sessions: {} };
  }
}

export function saveQaBotState(root = STATE_ROOT, state = {}) {
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, 'qa-bot.json'), JSON.stringify(state, null, 2) + '\n');
}

export async function sendReply(token, chatId, text, { fetchImpl = fetch, parseMode = 'HTML' } = {}) {
  const chunks = splitTelegramMessage(text, 3800);
  for (const chunk of chunks) {
    await sendMessage(token, chatId, chunk, { fetchImpl, parseMode });
  }
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

// Меню команд бота (автодополнение «/» в Telegram): регистрируется при старте.
export const QA_BOT_COMMANDS = [
  { command: 'task', description: 'Зафиксировать задачу Jira (например, FD-8096)' },
  { command: 'current', description: 'Текущая активная задача' },
  { command: 'reset', description: 'Сбросить контекст задачи' },
  { command: 'deploy', description: 'Деплой ветки на dev-стенд: /deploy [be] <mr|ветка> [слот 1-10]' },
  { command: 'help', description: 'Справка' },
];

export async function cmdQaBot(opts = {}, deps = {}) {
  const {
    env = process.env,
    loadCfg = loadConfig,
    fetchImpl = fetch,
    sleepImpl = sleep,
    execImpl = execFileAsync,
    readSecretImpl = readSecret,
    stateRoot = STATE_ROOT,
    qaTokenFile = QA_TOKEN_FILE,
    log = console.log,
    cycles = Infinity,
    deployImpl = runQaDeploy,
  } = deps;

  const cfg = loadCfg(env, {});
  let token = opts.token || env.FS_HARNESS_QA_TELEGRAM || env.TELEGRAM_QA_BOT_TOKEN || cfg.telegram?.qa_bot_token;
  if (!token && existsSync(qaTokenFile)) {
    try { token = readFileSync(qaTokenFile, 'utf8').trim(); } catch {}
  }
  if (!token) {
    throw new CliError(`Нет токена для QA-бота: создай нового бота в @BotFather и положи токен в ${qaTokenFile} (или задай FS_HARNESS_QA_TELEGRAM).`, 1, 'secret_missing');
  }

  const developerTag = opts.tag || env.TELEGRAM_DEVELOPER_TAG || cfg.telegram?.developer_tag || '@amir_ltpf';
  const developerChatId = cfg.telegram?.chat_id || env.TELEGRAM_CHAT_ID || null;
  const projectDir = opts.projectDir || expandHome(cfg.projects?.['fitstars-frontend']?.dir || cfg.projectDir || process.cwd());

  let botInfo;
  try {
    botInfo = await tgCall(token, 'getMe', {}, { fetchImpl });
  } catch (err) {
    throw new CliError(`Не удалось авторизовать Telegram-бота: ${err.message}`, 1, 'telegram_failed');
  }

  const botUsername = botInfo?.username || '';
  log(`🤖 QA-бот @${botUsername} запущен в каталоге ${projectDir}`);
  log(`👤 Тег разработчика: ${developerTag}, алерт-чат: ${developerChatId || 'не задан'}`);

  // Регистрируем меню «/»: не критично, ошибка не мешает старту.
  try {
    await tgCall(token, 'setMyCommands', { commands: QA_BOT_COMMANDS }, { fetchImpl });
  } catch (e) {
    log(`⚠️ setMyCommands не прошёл: ${e.message}`);
  }

  const state = loadQaBotState(stateRoot);
  let offset = state.offset ?? null;
  const sessions = state.sessions || {};

  const save = () => {
    saveQaBotState(stateRoot, { offset, sessions });
  };

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

  let cycle = 0;
  try {
    while (!stopped && cycle < cycles) {
      cycle++;
      let updates;
      try {
        updates = await getUpdates(token, { offset, timeout: 25, fetchImpl });
      } catch (err) {
        log(`getUpdates ошибка: ${err.message}, повтор через 5с`);
        await sleepImpl(5000);
        continue;
      }

      for (const u of updates) {
        if (stopped) break;
        offset = u.update_id + 1;
        save();

        const parsed = handleQaUpdate(u, { botUsername });
        if (parsed.kind === 'ignored') continue;

        const chatId = parsed.chatId;
        const currentSession = sessions[chatId] || null;

        if (parsed.kind === 'command') {
          const { name, args } = parsed;

          if (name === 'start' || name === 'help') {
            const helpText = [
              `👋 <b>Привет! Я QA-ассистент разработчика (${developerTag}).</b>`,
              'Помогаю тестировщикам разобраться, как работает функционал, какие нужны фича-флаги, условия для отображения и проверяю код на баги.',
              '',
              '<b>Команды:</b>',
              '• <code>/task &lt;KEY&gt;</code> — зафиксировать/сменить задачу (например, <code>/task FD-8096</code>)',
              '• <code>/current</code> — показать текущую активную задачу',
              '• <code>/reset</code> — сбросить контекст задачи',
              '• <code>/deploy [be] &lt;mr|ветка&gt; [слот]</code> — задеплоить ветку на dev-стенд (1–10; <code>be</code> — бэкенд)',
              '• <code>/help</code> — эта справка',
              '',
              currentSession?.taskKey
                ? `📌 Сейчас активна задача: <b>${escapeHtml(currentSession.taskKey)}</b>`
                : 'По какой задаче вопрос? Назови номер задачи Jira (например, <code>FD-8096</code>).',
            ].join('\n');
            await sendReply(token, chatId, helpText, { fetchImpl });
            continue;
          }

          if (name === 'current') {
            if (!currentSession?.taskKey) {
              await sendReply(token, chatId, 'Сейчас нет активной задачи. Назови номер задачи Jira (например, <code>FD-8096</code>).', { fetchImpl });
            } else {
              const text = [
                `📌 <b>Активная задача:</b> <code>${escapeHtml(currentSession.taskKey)}</code>`,
                currentSession.taskSummary ? `📝 ${escapeHtml(currentSession.taskSummary)}` : '',
                currentSession.branch ? `🌿 Ветка: <code>${escapeHtml(currentSession.branch)}</code>` : '',
                '',
                'Задавай любой вопрос по этой задаче!',
              ].filter(Boolean).join('\n');
              await sendReply(token, chatId, text, { fetchImpl });
            }
            continue;
          }

          if (name === 'reset') {
            delete sessions[chatId];
            save();
            await sendReply(token, chatId, '🔄 Контекст задачи сброшен. По какой задаче вопрос?', { fetchImpl });
            continue;
          }

          if (name === 'task') {
            const rawKey = args[0]?.trim();
            const taskKey = extractTaskKey(rawKey || '');
            if (!taskKey) {
              await sendReply(token, chatId, 'Использование: <code>/task FD-8096</code>', { fetchImpl });
              continue;
            }

            await sendReply(token, chatId, `⏳ Подтягиваю данные по задаче <b>${taskKey}</b>…`, { fetchImpl });
            const jiraInfo = await fetchJiraTask({ cfg }, taskKey, { readSecretImpl });
            const branch = findTaskBranch(projectDir, taskKey);
            const diffStat = getBranchDiffStat(projectDir, branch);

            sessions[chatId] = {
              taskKey,
              taskSummary: jiraInfo.summary,
              taskDescription: jiraInfo.description,
              technicalDetails: jiraInfo.technicalDetails,
              branch: branch || '',
              diffStat: diffStat || '',
              conversationId: null,
              updatedAt: Date.now(),
            };
            save();

            const text = [
              `📌 <b>Зафиксировал задачу:</b> <code>${escapeHtml(taskKey)}</code>`,
              jiraInfo.summary ? `📝 ${escapeHtml(jiraInfo.summary)}` : '',
              branch ? `🌿 Ветка: <code>${escapeHtml(branch)}</code>` : '⚠️ Локальная ветка не найдена (будет проверен dev)',
              '',
              'Какой у тебя вопрос по этой задаче? (например: какой нужен фича-флаг, почему не отображается элемент, как проверить)',
            ].filter(Boolean).join('\n');
            await sendReply(token, chatId, text, { fetchImpl });
            continue;
          }

          if (name === 'deploy') {
            // /deploy [be|backend] <mr|ветка> [слот]
            let backend = false;
            let rest = args;
            if (args[0] && /^(be|backend|api)$/i.test(args[0])) {
              backend = true;
              rest = args.slice(1);
            }
            const [query, slotStr] = rest;
            if (!query) {
              await sendReply(token, chatId, [
                'Использование:',
                '• <code>/deploy &lt;mr|ветка&gt; [слот]</code> — фронт на dev-стенд',
                '• <code>/deploy be &lt;mr|ветка&gt; [слот]</code> — бэкенд',
                'Слот: 1–10 (по умолчанию 1). Например: <code>/deploy be FD-8096 3</code> → dev3.',
              ].join('\n'), { fetchImpl });
              continue;
            }
            let slot = 1;
            if (slotStr != null) {
              if (!/^\d+$/.test(slotStr) || Number(slotStr) < 1 || Number(slotStr) > 10) {
                await sendReply(token, chatId, 'Слот — число от 1 до 10 (например, <code>3</code> → dev3).', { fetchImpl });
                continue;
              }
              slot = Number(slotStr);
            }
            const label = backend ? 'бэкенда' : 'фронта';
            await sendReply(token, chatId, `🚀 Запускаю деплой ${label}: <code>${escapeHtml(query)}</code> → dev${slot}. Пришлю итог сюда.`, { fetchImpl });
            fire(async () => {
              try {
                const res = await deployImpl({ query, slot, backend, env, loadCfg });
                const link = res.deploy?.web_url || res.pipeline?.web_url || '';
                await sendReply(token, chatId, `✅ Деплой ${label} готов: MR <code>!${res.mr}</code> → dev${slot}${link ? `\n🔗 ${link}` : ''}`, { fetchImpl });
              } catch (e) {
                await sendReply(token, chatId, `❌ Деплой ${label} <code>${escapeHtml(query)}</code> упал:\n${escapeHtml(e.message)}`, { fetchImpl });
              }
            });
            continue;
          }
        }

        if (parsed.kind === 'text') {
          const userText = parsed.text;
          const detectedKey = extractTaskKey(userText);

          // Если переключили задачу или задача еще не была зафиксирована
          if (detectedKey && (!currentSession || detectedKey !== currentSession.taskKey)) {
            const jiraInfo = await fetchJiraTask({ cfg }, detectedKey, { readSecretImpl });
            const branch = findTaskBranch(projectDir, detectedKey);
            const diffStat = getBranchDiffStat(projectDir, branch);

            sessions[chatId] = {
              taskKey: detectedKey,
              taskSummary: jiraInfo.summary,
              taskDescription: jiraInfo.description,
              technicalDetails: jiraInfo.technicalDetails,
              branch: branch || '',
              diffStat: diffStat || '',
              conversationId: null,
              updatedAt: Date.now(),
            };
            save();

            // Если сообщение состояло ТОЛЬКО из ключа задачи:
            if (userText.trim().toUpperCase() === detectedKey) {
              const text = [
                `📌 <b>Зафиксировал задачу:</b> <code>${escapeHtml(detectedKey)}</code>`,
                jiraInfo.summary ? `📝 ${escapeHtml(jiraInfo.summary)}` : '',
                branch ? `🌿 Ветка: <code>${escapeHtml(branch)}</code>` : '',
                '',
                'Какой у тебя вопрос по этой задаче?',
              ].filter(Boolean).join('\n');
              await sendReply(token, chatId, text, { fetchImpl });
              continue;
            }
          }

          const activeSession = sessions[chatId];
          if (!activeSession?.taskKey) {
            await sendReply(
              token,
              chatId,
              'По какой задаче вопрос? Назови номер задачи Jira (например, <code>FD-8096</code>), чтобы я загрузил требования и код.',
              { fetchImpl }
            );
            continue;
          }

          // 1. Посылаем статус «Думаю…» в чат
          let statusMsg = null;
          try {
            statusMsg = await sendMessage(token, chatId, 'Думаю…', { fetchImpl, parseMode: null });
          } catch {}

          // 2. Фоновый typing indicator в Telegram
          let typingActive = true;
          const keepTyping = async () => {
            while (typingActive) {
              try {
                await tgCall(token, 'sendChatAction', { chat_id: chatId, action: 'typing' }, { fetchImpl });
              } catch {}
              await sleepImpl(4500);
            }
          };
          const typingPromise = keepTyping();

          const prompt = buildQaPrompt({
            taskKey: activeSession.taskKey,
            taskSummary: activeSession.taskSummary,
            taskDescription: activeSession.taskDescription,
            technicalDetails: activeSession.technicalDetails,
            branch: activeSession.branch,
            diffStat: activeSession.diffStat,
            question: userText,
          });

          let agyRes;
          try {
            agyRes = await runAgyQuery({
              prompt,
              conversationId: activeSession.conversationId,
              cwd: projectDir,
              execImpl,
            });
            activeSession.conversationId = agyRes.conversationId;
            save();
          } catch (err) {
            typingActive = false;
            await typingPromise;
            log(`Ошибка agy: ${err.message}`);
            const errText = `⚠️ Ошибка при анализе через AI-агента: ${escapeHtml(err.message)}`;
            if (statusMsg?.message_id) {
              try {
                await editMessageText(token, chatId, statusMsg.message_id, errText, { fetchImpl, parseMode: 'HTML' });
              } catch {
                await sendReply(token, chatId, errText, { fetchImpl });
              }
            } else {
              await sendReply(token, chatId, errText, { fetchImpl });
            }
            continue;
          } finally {
            typingActive = false;
            await typingPromise;
          }

          const { hasBug, bugDetails, cleanResponse } = parseQaResponse(agyRes.response);

          let finalChatText;
          if (hasBug) {
            finalChatText = formatBugAlert({
              taskKey: activeSession.taskKey,
              bugDetails,
              cleanResponse,
              developerTag,
            });
          } else {
            finalChatText = markdownToTelegramHtml(cleanResponse);
          }

          // Редактируем статус-сообщение «Думаю…» первым чанком ответа
          const chunks = splitTelegramMessage(finalChatText, 3800);
          let firstEdited = false;
          if (statusMsg?.message_id && chunks.length > 0) {
            try {
              await editMessageText(token, chatId, statusMsg.message_id, chunks[0], { fetchImpl, parseMode: 'HTML' });
              firstEdited = true;
            } catch {
              await deleteMessage(token, chatId, statusMsg.message_id, { fetchImpl }).catch(() => {});
            }
          }

          const remainingChunks = firstEdited ? chunks.slice(1) : chunks;
          for (const chunk of remainingChunks) {
            await sendMessage(token, chatId, chunk, { fetchImpl, parseMode: 'HTML' });
          }

          // Если баг и чат не личка разработчика — дублируем разработчику
          if (hasBug && developerChatId && String(chatId) !== String(developerChatId)) {
            try {
              const devAlert = [
                `🚨 <b>QA-бот обнаружил баг в задаче ${escapeHtml(activeSession.taskKey)}!</b>`,
                `Чат: <code>${chatId}</code>`,
                '',
                `<blockquote>${escapeHtml(bugDetails)}</blockquote>`,
                '',
                `Вопрос QA: <i>${escapeHtml(userText)}</i>`,
              ].join('\n');
              await sendReply(token, developerChatId, devAlert, { fetchImpl });
            } catch (e) {
              log(`Не удалось переслать алерт разработчику: ${e.message}`);
            }
          }
        }
      }
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await Promise.allSettled(pending);
  }

  log('QA-бот остановлен.');
  return { ok: true, cycles: cycle, offset };
}
