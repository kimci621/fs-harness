import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  tgCall, getUpdates, sendButtons, answerCallbackQuery, editMessageReplyMarkup,
  sendApprovalRequest, isAllowed, handleUpdate, loadBotState, saveBotState, approvalNonce,
  escapeHtml, stripHtml, formatMRTelegram, formatMRCard, formatJobsTelegram,
  formatCommentsTelegram, formatTasksListTelegram, formatTaskCardTelegram,
  formatStatusTelegram, formatWatchTelegram, formatHelpTelegram, sendMessage,
} from '../src/tgbot.js';
import { createRun, saveArtifact } from '../src/agent/journal.js';

// Очередь ответов: каждый fetch берёт следующий payload.
function queueFetch(log = []) {
  const items = [];
  return {
    push(item) { items.push(item); },
    fetchImpl: async (url, init) => {
      log.push({ url, body: init?.body ? JSON.parse(init.body) : null });
      const item = items.shift() ?? { ok: true, result: true };
      if (item.error) return { ok: false, status: item.status ?? 400, json: async () => ({ ok: false, description: item.error }) };
      return { ok: true, status: 200, json: async () => ({ ok: true, result: item.result ?? true }) };
    },
  };
}

test('tgCall: URL метода, тело JSON, ошибка {ok:false} → telegram_failed', async () => {
  const log = [];
  const q = queueFetch(log);
  q.push({ result: { message_id: 1 } });
  const res = await tgCall('tok', 'sendMessage', { chat_id: '1', text: 'x' }, { fetchImpl: q.fetchImpl });
  assert.equal(res.message_id, 1);
  assert.equal(log[0].url, 'https://api.telegram.org/bottok/sendMessage');
  assert.deepEqual(log[0].body, { chat_id: '1', text: 'x' });

  q.push({ error: 'Too Many Requests' });
  await assert.rejects(
    () => tgCall('tok', 'getUpdates', {}, { fetchImpl: q.fetchImpl }),
    (e) => e.code === 'telegram_failed' && /Too Many Requests/.test(e.message),
  );
});

test('getUpdates: offset и timeout в теле', async () => {
  const log = [];
  const q = queueFetch(log);
  q.push({ result: [{ update_id: 5 }] });
  await getUpdates('tok', { offset: 10, timeout: 25, fetchImpl: q.fetchImpl });
  assert.deepEqual(log.at(-1).body, { timeout: 25, offset: 10 });

  q.push({ result: [] });
  await getUpdates('tok', { timeout: 0, fetchImpl: q.fetchImpl });
  assert.deepEqual(log.at(-1).body, { timeout: 0 }, 'без offset — начальный снос');
});

test('sendButtons: reply_markup с inline_keyboard, callback_data ≤ 64 байт', async () => {
  const log = [];
  const q = queueFetch(log);
  const nonce = approvalNonce();
  const runId = 'conflict-m1a2b-3c4d';
  const buttons = [[
    { text: 'Approve & Push', callback_data: `appr:${runId}:${nonce}` },
    { text: 'Revise', callback_data: `rev:${runId}:${nonce}` },
    { text: 'Reject', callback_data: `rej:${runId}:${nonce}` },
  ]];
  q.push({ result: { message_id: 42 } });
  await sendButtons('tok', '777', 'вердикт', buttons, { fetchImpl: q.fetchImpl });
  const kb = log[0].body.reply_markup.inline_keyboard;
  for (const row of kb) {
    for (const b of row) {
      assert.ok(Buffer.byteLength(b.callback_data, 'utf8') <= 64, `callback_data длиннее 64: ${b.callback_data}`);
    }
  }
  assert.match(kb[0][0].callback_data, /^appr:conflict-m1a2b-3c4d:[0-9a-f-]{36}$/);
});

test('answerCallbackQuery / editMessageReplyMarkup: правильные методы', async () => {
  const log = [];
  const q = queueFetch(log);
  await answerCallbackQuery('tok', 'cb-1', { text: 'ok', fetchImpl: q.fetchImpl });
  assert.equal(log.at(-1).url, 'https://api.telegram.org/bottok/answerCallbackQuery');
  assert.equal(log.at(-1).body.callback_query_id, 'cb-1');

  await editMessageReplyMarkup('tok', '777', 42, { reply_markup: null, fetchImpl: q.fetchImpl });
  assert.equal(log.at(-1).url, 'https://api.telegram.org/bottok/editMessageReplyMarkup');
  assert.equal(log.at(-1).body.reply_markup, null);
});

test('sendApprovalRequest: три кнопки, chat_id/message_id в meta.approval', async (t) => {
  const runsDir = mkdtempSync(path.join(tmpdir(), 'fs-harness-tg-approval-'));
  t.after(() => rmSync(runsDir, { recursive: true, force: true }));
  const run = createRun('conflict', { root: runsDir });
  const nonce = approvalNonce();
  saveArtifact(run, 'meta.json', {
    id: run.id, action: 'conflict', mr: 7, state: 'pending_approval',
    approval: { nonce, issued_at: new Date().toISOString(), run: run.id },
  });

  const log = [];
  const q = queueFetch(log);
  q.push({ result: { message_id: 99 } });
  const cfg = { telegram: { chat_id: '555', bot_token: 'tok-b' } };
  await sendApprovalRequest({
    cfg, run: run.id,
    meta: { action: 'conflict', mr: 7 },
    verdict: { decision: 'approve', confidence: 0.9, summary: 'ок', findings: [{ body: 'мелочь' }], meta: { cost: 0.1 } },
    nonce, fetchImpl: q.fetchImpl, runsRoot: runsDir,
  });
  const body = log[0].body;
  assert.equal(body.chat_id, '555');
  assert.equal(body.reply_markup.inline_keyboard[0].length, 3);
  assert.match(body.reply_markup.inline_keyboard[0][0].callback_data, new RegExp(`^appr:${run.id}:`));
  const meta = JSON.parse(readFileSync(path.join(run.dir, 'meta.json'), 'utf8'));
  assert.equal(meta.approval.chat_id, '555');
  assert.equal(meta.approval.message_id, 99);
});

test('isAllowed: пустой список — никто; по id — только свои', () => {
  assert.equal(isAllowed({ telegram: { allowed_user_ids: [] } }, 1), false);
  assert.equal(isAllowed({ telegram: { allowed_user_ids: [42] } }, 42), true);
  assert.equal(isAllowed({ telegram: { allowed_user_ids: [42] } }, '42'), true, 'id приходит строкой/числом');
  assert.equal(isAllowed({ telegram: { allowed_user_ids: [42] } }, 43), false);
  assert.equal(isAllowed({}, 1), false);
});

test('handleUpdate: чужие молча ignored, свои — command/callback', () => {
  const cfg = { telegram: { allowed_user_ids: [10] } };
  const fromStranger = { message: { text: '/mrs', chat: { id: 5 }, from: { id: 99 } } };
  assert.deepEqual(handleUpdate(fromStranger, { cfg }), { kind: 'ignored' });

  const fromSelf = { message: { text: '/run conflict !7', chat: { id: 5 }, from: { id: 10 } } };
  const cmd = handleUpdate(fromSelf, { cfg });
  assert.equal(cmd.kind, 'command');
  assert.equal(cmd.name, 'run');
  assert.deepEqual(cmd.args, ['conflict', '!7']);
  assert.equal(cmd.chatId, 5);

  const strangerBtn = {
    callback_query: {
      id: 'cb', data: 'appr:run-1:n1',
      from: { id: 99 }, message: { chat: { id: 5 }, message_id: 1 },
    },
  };
  assert.deepEqual(handleUpdate(strangerBtn, { cfg }), { kind: 'ignored' });

  const selfBtn = {
    callback_query: {
      id: 'cb', data: 'appr:run-1:n1',
      from: { id: 10 }, message: { chat: { id: 5 }, message_id: 1 },
    },
  };
  const cb = handleUpdate(selfBtn, { cfg });
  assert.equal(cb.kind, 'callback');
  assert.equal(cb.cmd, 'appr');
  assert.equal(cb.runId, 'run-1');
  assert.equal(cb.nonce, 'n1');
  assert.equal(cb.callbackId, 'cb');
  assert.equal(cb.messageId, 1);

  assert.deepEqual(handleUpdate({ message: { text: 'просто текст', from: { id: 10 } } }, { cfg }), { kind: 'ignored' });
  assert.deepEqual(handleUpdate({}, { cfg }), { kind: 'ignored' });
  // /mrs@BotName → имя без суффикса
  const at = handleUpdate({ message: { text: '/mrs@fs_bot', from: { id: 10 }, chat: { id: 5 } } }, { cfg });
  assert.equal(at.name, 'mrs');
});

test('load/saveBotState: roundtrip и пустой файл', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'fs-harness-bot-state-'));
  try {
    assert.deepEqual(loadBotState(root), {});
    saveBotState(root, { offset: 42 });
    assert.ok(existsSync(path.join(root, 'tgbot.json')));
    assert.deepEqual(loadBotState(root), { offset: 42 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('escapeHtml и stripHtml: экранирование и очистка тегов', () => {
  assert.equal(escapeHtml('<script>alert("test&foo")</script>'), '&lt;script&gt;alert("test&amp;foo")&lt;/script&gt;');
  assert.equal(stripHtml('<b>жирный</b> и <code>код</code>'), 'жирный и код');
});

test('formatMRTelegram и formatMRCard: читаемый вывод MR', () => {
  const mr = {
    iid: 123,
    title: 'Draft: Добавить баннер',
    draft: true,
    author: 'Иван',
    source_branch: 'feat/banner',
    target_branch: 'dev',
    pipeline: { id: 456, status: 'success' },
    comments: { total: 3, open: 1, resolved: 2 },
    has_conflicts: true,
    updated_at: new Date().toISOString(),
    web_url: 'https://gitlab.example/mr/123',
  };

  const listRow = formatMRTelegram(mr);
  assert.match(listRow, /!123 Добавить баннер/);
  assert.match(listRow, /href="https:\/\/gitlab\.example\/mr\/123"/);
  assert.match(listRow, /\[Draft\]/);
  assert.match(listRow, /feat\/banner/);
  assert.match(listRow, /Конфликт/);

  const card = formatMRCard(mr);
  assert.match(card, /!123 Добавить баннер/);
  assert.match(card, /Автор:.*Иван/);
  assert.match(card, /Пайплайн:.*success/);
  assert.match(card, /Комментарии:.*3 \(открыто: 1/);
});

test('formatJobsTelegram: оформление джоб пайплайна', () => {
  const res = {
    mr: 123,
    pipeline: { id: 456, status: 'failed', web_url: 'https://gitlab.example/pipes/456' },
    jobs: [
      { id: 1, name: 'lint', stage: 'test', status: 'success', web_url: 'https://gitlab.example/jobs/1' },
      { id: 2, name: 'build', stage: 'build', status: 'failed', web_url: 'https://gitlab.example/jobs/2' },
    ],
  };
  const text = formatJobsTelegram(res);
  assert.match(text, /Пайплайн.*#456.*для !123/);
  assert.match(text, /lint/);
  assert.match(text, /build/);
});

test('formatTasksListTelegram и formatTaskCardTelegram: карточки задач Jira', () => {
  const issues = [
    { key: 'FD-100', summary: 'Сделать кнопку', status: 'In Progress', priority: 'High' },
  ];
  const list = formatTasksListTelegram(issues, { cfg: { jira: { baseUrl: 'https://jira.example' } } });
  assert.match(list, /FD-100/);
  assert.match(list, /Сделать кнопку/);
  assert.match(list, /https:\/\/jira\.example\/browse\/FD-100/);

  const issue = {
    key: 'FD-100',
    summary: 'Сделать кнопку',
    status: 'In Progress',
    type: 'Task',
    priority: 'High',
    assignee: 'Алексей',
    description: 'Нужна синяя кнопка на главной',
    updated: new Date().toISOString(),
  };
  const comments = [{ author: 'Пётр', body: 'Дизайн согласован' }];
  const card = formatTaskCardTelegram(issue, comments, { cfg: { jira: { baseUrl: 'https://jira.example' } } });
  assert.match(card, /FD-100.*Сделать кнопку/);
  assert.match(card, /Исполнитель:.*Алексей/);
  assert.match(card, /синяя кнопка/);
  assert.match(card, /Дизайн согласован/);
});

test('formatStatusTelegram, formatWatchTelegram, formatHelpTelegram: оформление сводок', () => {
  const status = formatStatusTelegram([{ id: 'run-1', state: 'success', decision: 'approve' }], [{ id: 'job-1' }], 1);
  assert.match(status, /Состояние FS-Harness/);
  assert.match(status, /Заданий в очереди:.*1/);
  assert.match(status, /run-1/);

  const watch = formatWatchTelegram({ kept: [{ kind: 'pipeline', mr: 123, detail: 'пайплайн упал' }] });
  assert.match(watch, /Watcher.*важные события/);
  assert.match(watch, /pipeline.*!123.*пайплайн упал/);

  const help = formatHelpTelegram();
  assert.match(help, /FSH Telegram Bot/);
  assert.match(help, /\/mrs/);
  assert.match(help, /\/task/);
});

test('sendMessage: фолбэк на stripHtml при ошибке разметки Telegram', async () => {
  const log = [];
  let attempt = 0;
  const fetchImpl = async (url, init) => {
    attempt++;
    const body = JSON.parse(init.body);
    log.push({ attempt, body });
    if (attempt === 1) {
      return { ok: false, status: 400, json: async () => ({ ok: false, description: "Bad Request: can't parse entities: tag missing" }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 10 } }) };
  };

  const res = await sendMessage('tok', '123', '<b>сломанный тег', { fetchImpl });
  assert.equal(res.message_id, 10);
  assert.equal(log.length, 2);
  assert.equal(log[0].body.parse_mode, 'HTML');
  assert.equal(log[1].body.parse_mode, undefined);
  assert.equal(log[1].body.text, 'сломанный тег');
});

