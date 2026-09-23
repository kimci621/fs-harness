import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { CliError } from './errors.js';
import { getTelegramTarget, runMessage } from './notify.js';
import { patchRunMeta, readRun, RUNS_DIR } from './agent/journal.js';
import { cleanTitle, statusIcon, humanize, truncate } from './format.js';

// Двусторонний Telegram-бот: long-polling getUpdates, inline-кнопки, allowlist.
// Транспорт свой, notify.js не трогаем: postTelegram остаётся на исходящие уведомления.

// callback_data ограничен 64 байтами — runId+nonce влезают, но тест это держит на контроле.
export function approvalNonce() {
  return randomUUID();
}

// Экранирование спецсимволов HTML для Telegram Bot API
export function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Удаление HTML-тегов для безопасного фолбэка при ошибках разметки Telegram
export function stripHtml(str = '') {
  return String(str).replace(/<[^>]*>/g, '');
}

export async function tgCall(token, method, body = {}, { fetchImpl = fetch, signal } = {}) {
  let res;
  try {
    res = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    throw new CliError(`Telegram ${method}: ${err.message}`, 1, 'telegram_failed');
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    // ниже поймаем по ok/статусу
  }
  if (!res.ok || !json?.ok) {
    const desc = json?.description ?? `HTTP ${res.status}`;
    throw new CliError(`Telegram ${method}: ${desc}`, 1, 'telegram_failed');
  }
  return json.result;
}

export function getUpdates(token, { offset, timeout = 25, fetchImpl = fetch, signal } = {}) {
  const body = { timeout };
  if (offset != null) body.offset = offset;
  return tgCall(token, 'getUpdates', body, { fetchImpl, signal });
}

export async function sendButtons(token, chatId, text, buttons, { fetchImpl = fetch, signal, parseMode = 'HTML' } = {}) {
  const body = { chat_id: chatId, text, reply_markup: { inline_keyboard: buttons } };
  if (parseMode) body.parse_mode = parseMode;
  try {
    return await tgCall(token, 'sendMessage', body, { fetchImpl, signal });
  } catch (err) {
    if (parseMode && /can't parse entities/i.test(err.message)) {
      const fallbackBody = { chat_id: chatId, text: stripHtml(text), reply_markup: { inline_keyboard: buttons } };
      return await tgCall(token, 'sendMessage', fallbackBody, { fetchImpl, signal });
    }
    throw err;
  }
}

export function answerCallbackQuery(token, callbackId, { text, fetchImpl = fetch, signal } = {}) {
  return tgCall(token, 'answerCallbackQuery', { callback_query_id: callbackId, text: text ?? '' }, { fetchImpl, signal });
}

export function editMessageReplyMarkup(token, chatId, messageId, { reply_markup = null, fetchImpl = fetch, signal } = {}) {
  return tgCall(token, 'editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup }, { fetchImpl, signal });
}

export async function sendMessage(token, chatId, text, { fetchImpl = fetch, signal, parseMode = 'HTML' } = {}) {
  const body = { chat_id: chatId, text };
  if (parseMode) body.parse_mode = parseMode;
  try {
    return await tgCall(token, 'sendMessage', body, { fetchImpl, signal });
  } catch (err) {
    if (parseMode && /can't parse entities/i.test(err.message)) {
      return await tgCall(token, 'sendMessage', { chat_id: chatId, text: stripHtml(text) }, { fetchImpl, signal });
    }
    throw err;
  }
}

// approvalSink движка: структурированный текст с вердиктом + три кнопки.
export async function sendApprovalRequest({ cfg, run, meta, verdict, nonce, fetchImpl = fetch, say = () => {}, runsRoot } = {}) {
  const target = getTelegramTarget(cfg);
  if (!target) throw new CliError('Telegram не настроен (telegram.chat_id и telegram.bot_token).', 1, 'config_invalid');
  const buttons = [[
    { text: 'Approve & Push', callback_data: `appr:${run}:${nonce}` },
    { text: 'Revise', callback_data: `rev:${run}:${nonce}` },
    { text: 'Reject', callback_data: `rej:${run}:${nonce}` },
  ]];
  for (const row of buttons) {
    for (const b of row) {
      if (Buffer.byteLength(b.callback_data, 'utf8') > 64) {
        throw new CliError('callback_data длиннее 64 байт — кнопка не влезет.', 1, 'config_invalid');
      }
    }
  }
  const targetStr = meta.mr != null ? `!${meta.mr}` : (meta.issue ?? '');
  const firstFinding = (verdict?.findings ?? []).map((f) => f.body)[0] ?? '';
  const verdictIcon = verdict?.decision === 'approve' ? '✅' : verdict?.decision === 'revise' ? '🔄' : '❌';
  const text = [
    `🎯 <b>Требуется аппрув:</b> <code>${escapeHtml(meta.action)}</code> <b>${escapeHtml(targetStr)}</b>`,
    verdict ? `⚖️ <b>Судья:</b> ${verdictIcon} <b>${escapeHtml(verdict.decision)}</b> (уверенность: ${(verdict.confidence ?? 0).toFixed(2)})` : '',
    verdict?.meta?.cost ? `💰 <b>Стоимость:</b> $${verdict.meta.cost.toFixed(4)}` : '',
    verdict?.summary ? `📝 <b>Резюме:</b>\n${escapeHtml(verdict.summary)}` : '',
    firstFinding ? `⚠️ <b>Замечание:</b>\n${escapeHtml(firstFinding)}` : '',
  ].filter(Boolean).join('\n\n');
  const msg = await sendButtons(target.token, target.chatId, text, buttons, { fetchImpl });
  const root = runsRoot ?? RUNS_DIR;
  try {
    const saved = readRun(run, { root });
    patchRunMeta({ id: run, root }, { approval: { ...(saved.meta.approval ?? {}), chat_id: target.chatId, message_id: msg.message_id } });
  } catch (e) {
    say(`⚠ Не записал message_id: ${e.message}`);
  }
  return msg;
}

// Пустой allowlist — никто не допущен. Бот без списка не стартует (команда bot).
export function isAllowed(cfg, id) {
  const list = cfg?.telegram?.allowed_user_ids ?? [];
  return list.some((n) => Number(n) === Number(id));
}

// Чистый разбор update. Чужие — молча ignored, ни одного ответа наружу.
export function handleUpdate(u, { cfg }) {
  if (u?.callback_query) {
    const cq = u.callback_query;
    if (!isAllowed(cfg, cq.from?.id)) return { kind: 'ignored' };
    const parts = String(cq.data ?? '').split(':');
    if (parts.length !== 3 || !['appr', 'rev', 'rej'].includes(parts[0])) return { kind: 'ignored' };
    return {
      kind: 'callback',
      cmd: parts[0],
      runId: parts[1],
      nonce: parts[2],
      chatId: cq.message?.chat?.id ?? null,
      messageId: cq.message?.message_id ?? null,
      callbackId: cq.id,
      fromId: cq.from?.id,
    };
  }
  const text = u?.message?.text;
  if (typeof text === 'string' && text.startsWith('/')) {
    if (!isAllowed(cfg, u.message.from?.id)) return { kind: 'ignored' };
    const [rawName, ...args] = text.slice(1).split(/\s+/);
    return {
      kind: 'command',
      name: rawName.split('@')[0],
      args,
      chatId: u.message.chat?.id ?? null,
      fromId: u.message.from?.id,
    };
  }
  return { kind: 'ignored' };
}

export function loadBotState(root) {
  try {
    return JSON.parse(readFileSync(path.join(root, 'tgbot.json'), 'utf8'));
  } catch {
    return {};
  }
}

export function saveBotState(root, state) {
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, 'tgbot.json'), JSON.stringify(state, null, 2) + '\n');
}

// Форматирование одного MR для списка /mrs в Telegram
export function formatMRTelegram(m) {
  const title = escapeHtml(cleanTitle(m));
  const link = m.web_url ? `<a href="${m.web_url}">!${m.iid} ${title}</a>` : `!${m.iid} ${title}`;
  const draftBadge = m.draft ? ' <code>[Draft]</code>' : '';
  const pipeIcon = statusIcon(m.pipeline?.status);
  const pipeText = m.pipeline?.status ? `${pipeIcon} ${escapeHtml(m.pipeline.status)}` : '—';
  const commentsText = m.comments?.total != null ? `💬 ${m.comments.total}${m.comments.open ? ` (открыто: ${m.comments.open})` : ''}` : '';
  const conflictText = m.has_conflicts ? ' · ⚠️ Конфликт' : '';
  const branches = (m.source_branch && m.target_branch)
    ? `\n🔀 <code>${escapeHtml(m.source_branch)}</code> ➔ <code>${escapeHtml(m.target_branch)}</code>`
    : '';

  return [
    `🔹 <b>${link}</b>${draftBadge}${branches}`,
    `⚙️ ${pipeText}${commentsText ? ` · ${commentsText}` : ''}${conflictText}`,
  ].join('\n');
}

// Карточка одного MR (/mr <id|branch>)
export function formatMRCard(mr) {
  const title = escapeHtml(cleanTitle(mr));
  const link = mr.web_url ? `<a href="${mr.web_url}">!${mr.iid} ${title}</a>` : `!${mr.iid} ${title}`;
  const draftBadge = mr.draft ? ' <code>[Draft]</code>' : '';
  const author = escapeHtml(mr.author || mr.author_username || '—');
  const pipe = mr.pipeline
    ? `${statusIcon(mr.pipeline.status)} <b>${escapeHtml(mr.pipeline.status)}</b> (#${mr.pipeline.id ?? '—'})${mr.pipeline_stale ? ' ⚠️ <i>(устарел)</i>' : ''}`
    : '— нет';
  const comm = mr.comments
    ? `${mr.comments.total ?? 0} (открыто: ${mr.comments.open ?? 0}, решено: ${mr.comments.resolved ?? 0})`
    : '0';
  const conflict = mr.has_conflicts ? '⚠️ <b>Есть конфликты</b>' : '✅ <b>Нет конфликтов</b>';
  const time = humanize(mr.updated_at);

  const lines = [
    `📌 <b>${link}</b>${draftBadge}`,
    '',
    `👤 <b>Автор:</b> ${author}`,
  ];
  if (mr.source_branch && mr.target_branch) {
    lines.push(`🌿 <b>Ветки:</b> <code>${escapeHtml(mr.source_branch)}</code> ➔ <code>${escapeHtml(mr.target_branch)}</code>`);
  }
  lines.push(
    `⚙️ <b>Пайплайн:</b> ${pipe}`,
    `💬 <b>Комментарии:</b> ${comm}`,
    `⚡ <b>Конфликты:</b> ${conflict}`,
    `🕒 <b>Обновлён:</b> ${time}`,
  );
  return lines.join('\n');
}

// Список джоб пайплайна (/jobs <id|branch>)
export function formatJobsTelegram(res) {
  const pipeLink = res.pipeline?.web_url
    ? `<a href="${res.pipeline.web_url}">#${res.pipeline.id}</a>`
    : `#${res.pipeline?.id ?? '—'}`;
  const status = res.pipeline?.status ?? '—';
  const header = `⚙️ <b>Пайплайн ${pipeLink} для !${res.mr}:</b> ${statusIcon(status)} <b>${escapeHtml(status)}</b>`;
  if (!res.jobs?.length) {
    return `${header}\n\n<i>Джоб нет.</i>`;
  }
  const rows = res.jobs.map((j) => {
    const icon = statusIcon(j.status);
    const name = j.web_url ? `<a href="${j.web_url}">${escapeHtml(j.name)}</a>` : escapeHtml(j.name);
    return `${icon} <code>${escapeHtml(j.stage || '—')}</code> / ${name} (<code>#${j.id}</code>)`;
  });
  return `${header}\n\n${rows.join('\n')}`;
}

// Комментарии и треды (/comments <id|branch>)
export function formatCommentsTelegram(res) {
  const header = `💬 <b>Комментарии !${res.mr}</b> (всего: ${res.total ?? 0}, открыто: ${res.open ?? 0}, решено: ${res.resolved ?? 0}):`;
  if (!res.discussions?.length) {
    return `${header}\n\n<i>Комментариев нет.</i>`;
  }
  const items = res.discussions.slice(0, 8).map((d) => {
    const first = d.notes?.[0];
    const author = escapeHtml(first?.author || '—');
    const text = escapeHtml(truncate(first?.body || '', 180));
    const status = d.resolved ? '✅ <i>решено</i>' : '⏳ <i>открыто</i>';
    return `▫️ <b>@${author}</b> [${status}]:\n${text}`;
  });
  return `${header}\n\n${items.join('\n\n')}`;
}

// Список задач Jira (/tasks)
export function formatTasksListTelegram(issues, ctx) {
  if (!issues?.length) {
    return '🎫 <b>Задачи в Jira:</b>\n\n<i>Открытых задач на тебе нет.</i>';
  }
  const header = `🎫 <b>Мои задачи в Jira (${issues.length}):</b>`;
  const baseUrl = ctx?.cfg?.jira?.baseUrl || '';
  const rows = issues.slice(0, 10).map((i) => {
    const url = baseUrl ? `${baseUrl.replace(/\/+$/, '')}/browse/${i.key}` : '';
    const link = url ? `<a href="${url}">${i.key}</a>` : `<b>${i.key}</b>`;
    const status = escapeHtml(i.status || '—');
    const priority = escapeHtml(i.priority || '—');
    const summary = escapeHtml(truncate(i.summary || '', 100));
    return `▫️ <b>${link}</b> [<code>${status}</code>] · ${priority}\n${summary}`;
  });
  return `${header}\n\n${rows.join('\n\n')}`;
}

// Карточка одной задачи Jira (/task <KEY>)
export function formatTaskCardTelegram(issue, comments = [], ctx) {
  const baseUrl = ctx?.cfg?.jira?.baseUrl || '';
  const url = issue.url || (baseUrl ? `${baseUrl.replace(/\/+$/, '')}/browse/${issue.key}` : '');
  const link = url ? `<a href="${url}">${issue.key}</a>` : `<b>${issue.key}</b>`;
  const summary = escapeHtml(issue.summary || '');
  const lines = [
    `🎫 <b>${link}: ${summary}</b>`,
    '',
    `📊 <b>Статус:</b> <code>${escapeHtml(issue.status || '—')}</code> | <b>Тип:</b> ${escapeHtml(issue.type || '—')} | <b>Приоритет:</b> ${escapeHtml(issue.priority || '—')}`,
    `👤 <b>Исполнитель:</b> ${escapeHtml(issue.assignee || 'без исполнителя')}`,
  ];
  if (issue.updated) {
    lines.push(`🕒 <b>Обновлено:</b> ${humanize(issue.updated)}`);
  }
  if (issue.description) {
    lines.push('', `📝 <b>Описание:</b>\n${escapeHtml(truncate(issue.description.trim(), 350))}`);
  }
  if (comments?.length) {
    lines.push('', `💬 <b>Последние комментарии (${comments.length}):</b>`);
    const recent = comments.slice(-2);
    for (const c of recent) {
      lines.push(`• <b>@${escapeHtml(c.author || '—')}</b>: ${escapeHtml(truncate((c.body || '').trim(), 140))}`);
    }
  }
  return lines.join('\n');
}

// Статус харнесса (/status)
export function formatStatusTelegram(runs = [], jobs = [], pending = 0) {
  const header = '📊 <b>Состояние FS-Harness</b>';
  const stats = [
    `⏳ <b>Заданий в очереди:</b> ${jobs.length}`,
    `🔔 <b>Ждут аппрува:</b> ${pending}`,
  ].join('\n');
  const runsSection = runs.length
    ? `<b>Последние раны:</b>\n` + runs.map((r) => {
        const icon = r.state === 'success' || r.decision === 'approve' ? '✅'
          : r.state === 'pending_approval' ? '⏳'
          : r.state === 'failed' || r.decision === 'reject' ? '❌'
          : '▫️';
        const dec = r.decision ? ` (${escapeHtml(r.decision)})` : '';
        return `${icon} <code>${escapeHtml(r.id)}</code> — ${escapeHtml(r.state)}${dec}`;
      }).join('\n')
    : '<i>Ранов пока нет.</i>';
  return `${header}\n\n${stats}\n\n${runsSection}`;
}

// Результаты watcher (/watch)
export function formatWatchTelegram(r) {
  const kept = r.kept ?? [];
  if (!kept.length) {
    return '👁 <b>Watcher:</b> изменений нет, всё тихо.';
  }
  const lines = kept.map((e) => {
    const mrStr = e.mr ? ` (!${e.mr})` : '';
    return `▫️ <b>${escapeHtml(e.kind)}</b>${mrStr}: ${escapeHtml(e.detail || e.title || '')}`;
  });
  return `👁 <b>Watcher — важные события (${kept.length}):</b>\n\n${lines.join('\n')}`;
}

// Справка по командам (/help)
export function formatHelpTelegram() {
  return [
    '🤖 <b>FSH Telegram Bot</b>',
    '',
    '<b>Работа с Merge Requests:</b>',
    '• /mrs [фильтр] — список открытых MR',
    '  <i>Фильтры: mine, rev, draft, failed, conflict</i>',
    '• /mr &lt;номер|ветка&gt; — подробная карточка MR',
    '• /jobs &lt;номер|ветка&gt; — джобы пайплайна',
    '• /comments &lt;номер|ветка&gt; — комментарии и треды',
    '• /deploy &lt;номер|ветка&gt; [слот] — задеплоить MR (dev / dev2..10)',
    '',
    '<b>Работа с задачами (Jira & Task):</b>',
    '• /tasks — мои открытые задачи в Jira',
    '• /task &lt;KEY&gt; — карточка задачи Jira',
    '• /task start &lt;KEY&gt; — взять задачу в работу (создать ветку)',
    '• /task push [KEY] — запушить ветку и открыть MR',
    '• /task submit [KEY] — снять Draft и отправить в ревью',
    '• /task move &lt;KEY&gt; &lt;статус&gt; — перевести задачу в статус',
    '• /task comment &lt;KEY&gt; &lt;текст&gt; — оставить комментарий в Jira',
    '',
    '<b>AI-действия:</b>',
    '• /review &lt;mr&gt; — код-ревью MR',
    '• /conflict &lt;mr&gt; — разрешить конфликты с целевой веткой',
    '• /ci_fix &lt;mr&gt; — починить упавший CI',
    '• /implement &lt;KEY&gt; — реализовать задачу Jira',
    '• /analyze &lt;KEY&gt; — проанализировать задачу Jira',
    '• /agent [профиль] &lt;задача&gt; - запустить автономного агента (код + fsh)',
    '• /run &lt;действие&gt; &lt;цель&gt; — запустить любое действие',
    '',
    '<b>Мониторинг:</b>',
    '• /status — статус очереди и последних ранов',
    '• /watch — проверить изменения в репозитории',
  ].join('\n');
}
