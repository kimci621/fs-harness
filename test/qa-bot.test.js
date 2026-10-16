import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  extractTaskKey,
  findTaskBranch,
  getBranchDiffStat,
  buildQaPrompt,
  parseQaResponse,
  markdownToTelegramHtml,
  formatBugAlert,
  splitTelegramMessage,
  handleQaUpdate,
  runAgyQuery,
  loadQaBotState,
  saveQaBotState,
  cmdQaBot,
} from '../src/commands/qa-bot.js';

test('extractTaskKey: находит ключ задачи Jira в любом регистре и контексте', () => {
  assert.equal(extractTaskKey('FD-8096'), 'FD-8096');
  assert.equal(extractTaskKey('Привет, посмотри задачу fd-8096 пожалуйста'), 'FD-8096');
  assert.equal(extractTaskKey('/task FD-1234'), 'FD-1234');
  assert.equal(extractTaskKey('ветка feature/PROJ-42-test'), 'PROJ-42');
  assert.equal(extractTaskKey('просто вопрос без задачи'), null);
  assert.equal(extractTaskKey(''), null);
  assert.equal(extractTaskKey(null), null);
});

test('findTaskBranch: находит ветку через gitImpl', () => {
  const fakeGit = (args) => {
    assert.deepEqual(args, ['branch', '-a', '--list', '*FD-8096*']);
    return '  dev\n* feature/FD-8096\n  remotes/origin/feature/FD-8096';
  };
  const branch = findTaskBranch('/fake', 'FD-8096', { gitImpl: fakeGit });
  assert.equal(branch, 'feature/FD-8096');

  const emptyGit = () => '';
  assert.equal(findTaskBranch('/fake', 'FD-9999', { gitImpl: emptyGit }), null);
});

test('getBranchDiffStat: запрашивает diff stat ветки', () => {
  const fakeGit = (args) => {
    if (args[2] === 'origin/dev...feature/test') {
      return ' file.ts | 10 ++\n 1 file changed';
    }
    return '';
  };
  const stat = getBranchDiffStat('/fake', 'feature/test', { gitImpl: fakeGit });
  assert.match(stat, /file\.ts/);
  assert.equal(getBranchDiffStat('/fake', null), null);
});

test('buildQaPrompt: содержит правила Read-Only, контекст задачи и блок обнаружения багов', () => {
  const prompt = buildQaPrompt({
    taskKey: 'FD-8096',
    taskSummary: 'Свой блок видео-отзывов',
    taskDescription: 'Acceptance Criteria: клик открывает видео',
    branch: 'feature/FD-8096',
    question: 'какой фича-флаг нужен?',
  });

  assert.match(prompt, /РЕЖИМ ТОЛЬКО ЧТЕНИЕ/);
  assert.match(prompt, /ЗАПРЕЩЕНО/);
  assert.match(prompt, /FD-8096/);
  assert.match(prompt, /Свой блок видео-отзывов/);
  assert.match(prompt, /feature\/FD-8096/);
  assert.match(prompt, /\[BUG_DETECTED\]/);
  assert.match(prompt, /какой фича-флаг нужен\?/);
});

test('parseQaResponse: разделяет ответ и блок бага', () => {
  const withoutBug = 'Для показа видео включи флаг video_reviews_enabled на dev.';
  assert.deepEqual(parseQaResponse(withoutBug), {
    hasBug: false,
    bugDetails: null,
    cleanResponse: withoutBug,
  });

  const withBug = `[BUG_DETECTED]
Суть бага: Кнопка скрыта на десктопе
Где в коде: ReviewWidget.vue:42
Ожидаемое vs фактическое: По AC кнопка должна быть видна
[/BUG_DETECTED]
Вот подробный разбор для тестировщика: кнопка не отображается из-за v-if.`;

  const parsed = parseQaResponse(withBug);
  assert.equal(parsed.hasBug, true);
  assert.match(parsed.bugDetails, /Кнопка скрыта на десктопе/);
  assert.match(parsed.cleanResponse, /Вот подробный разбор для тестировщика/);
  assert.doesNotMatch(parsed.cleanResponse, /\[BUG_DETECTED\]/);
});

test('markdownToTelegramHtml: конвертирует базовую разметку и экранирует спецсимволы', () => {
  const md = '**Жирный** текст и `код` с <тегами>:\n```js\nconst x = 1 < 2;\n```';
  const html = markdownToTelegramHtml(md);

  assert.match(html, /<b>Жирный<\/b>/);
  assert.match(html, /<code>код<\/code>/);
  assert.match(html, /&lt;тегами&gt;/);
  assert.match(html, /<pre><code>const x = 1 &lt; 2;\n<\/code><\/pre>/);
});

test('formatBugAlert: форматирует алерт с тегом разработчика и блоком цитаты', () => {
  const alert = formatBugAlert({
    taskKey: 'FD-8096',
    bugDetails: 'Сломан клик в карусели',
    cleanResponse: 'Разбор для QA: **ошибка** в хендлере',
    developerTag: '@amir_ltpf',
  });

  assert.match(alert, /@amir_ltpf/);
  assert.match(alert, /FD-8096/);
  assert.match(alert, /<blockquote>Сломан клик в карусели<\/blockquote>/);
  assert.match(alert, /<b>ошибка<\/b>/);
});

test('splitTelegramMessage: корректно бьёт длинные тексты по переносам строк', () => {
  const shortText = 'Короткий текст';
  assert.deepEqual(splitTelegramMessage(shortText, 100), [shortText]);

  const p1 = 'A'.repeat(60);
  const p2 = 'B'.repeat(60);
  const combined = `${p1}\n\n${p2}`;
  const parts = splitTelegramMessage(combined, 80);

  assert.equal(parts.length, 2);
  assert.equal(parts[0], p1);
  assert.equal(parts[1], p2);
});

test('handleQaUpdate: распознает команды и свободный текст в личке и группах', () => {
  const cmdUpdate = {
    message: {
      chat: { id: 100, type: 'private' },
      message_id: 1,
      from: { id: 50 },
      text: '/task FD-8096',
    },
  };
  assert.deepEqual(handleQaUpdate(cmdUpdate), {
    kind: 'command',
    name: 'task',
    args: ['FD-8096'],
    chatId: 100,
    messageId: 1,
    fromId: 50,
    isGroup: false,
  });

  const groupTextUpdate = {
    message: {
      chat: { id: -200, type: 'group' },
      message_id: 2,
      from: { id: 50 },
      text: '@qa_bot какой фича-флаг нужен?',
    },
  };
  const parsedGroup = handleQaUpdate(groupTextUpdate, { botUsername: 'qa_bot' });
  assert.equal(parsedGroup.kind, 'text');
  assert.equal(parsedGroup.text, 'какой фича-флаг нужен?');
  assert.equal(parsedGroup.isGroup, true);
});

test('runAgyQuery: парсит JSON ответ и извлекает conversation_id', async () => {
  const mockExec = async (cmd, args) => {
    assert.equal(cmd, 'agy');
    assert.ok(args.includes('--model'));
    assert.ok(args.includes('gemini-3.8-flash'));
    assert.ok(args.includes('--effort'));
    assert.ok(args.includes('medium'));
    return {
      stdout: JSON.stringify({
        conversation_id: 'conv-1234',
        response: 'Все условия выполнены.',
      }),
    };
  };

  const res = await runAgyQuery({
    prompt: 'test prompt',
    cwd: '/fake/dir',
    execImpl: mockExec,
  });

  assert.equal(res.conversationId, 'conv-1234');
  assert.equal(res.response, 'Все условия выполнены.');
});

test('loadQaBotState / saveQaBotState: сохраняет и читает состояние сессий', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'qa-bot-test-'));
  try {
    const initial = loadQaBotState(tmp);
    assert.deepEqual(initial, { offset: null, sessions: {} });

    saveQaBotState(tmp, {
      offset: 42,
      sessions: { 100: { taskKey: 'FD-8096', conversationId: 'c-1' } },
    });

    const loaded = loadQaBotState(tmp);
    assert.equal(loaded.offset, 42);
    assert.equal(loaded.sessions['100'].taskKey, 'FD-8096');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('cmdQaBot: /deploy be <ветка> <слот> — фоновый деплой бэкенда с итогом в чат', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'qa-bot-deploy-'));
  const sentMessages = [];
  const deployCalls = [];

  const mockFetch = async (url, init) => {
    const u = String(url);
    if (u.includes('getMe')) {
      return { ok: true, json: async () => ({ ok: true, result: { username: 'test_qa_bot' } }) };
    }
    if (u.includes('setMyCommands')) {
      const body = JSON.parse(init.body);
      assert.ok(body.commands.some((c) => c.command === 'deploy' && /бэкенд|be/.test(c.description)));
      return { ok: true, json: async () => ({ ok: true, result: true }) };
    }
    if (u.includes('getUpdates')) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          result: [
            {
              update_id: 1,
              message: {
                chat: { id: 100, type: 'private' },
                message_id: 1,
                from: { id: 50 },
                text: '/deploy be feature/FD-8096 3',
              },
            },
          ],
        }),
      };
    }
    if (u.includes('sendMessage')) {
      const body = JSON.parse(init.body);
      sentMessages.push(body);
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 99 } }) };
    }
    return { ok: true, json: async () => ({ ok: true, result: {} }) };
  };

  try {
    const res = await cmdQaBot(
      { token: 'test-token', projectDir: '/fake/dir' },
      {
        cycles: 1,
        fetchImpl: mockFetch,
        sleepImpl: async () => {},
        stateRoot: tmp,
        readSecretImpl: () => null,
        log: () => {},
        loadCfg: () => ({}),
        deployImpl: async (a) => {
          deployCalls.push(a);
          return { ok: true, mr: 3319, deploy: { web_url: 'https://gitlab/job/1' } };
        },
      }
    );

    assert.equal(res.ok, true);
    assert.equal(deployCalls.length, 1);
    assert.equal(deployCalls[0].query, 'feature/FD-8096');
    assert.equal(deployCalls[0].slot, 3);
    assert.equal(deployCalls[0].backend, true);

    assert.equal(sentMessages.length, 2);
    assert.match(sentMessages[0].text, /деплой бэкенда/);
    assert.match(sentMessages[0].text, /feature\/FD-8096/);
    assert.match(sentMessages[0].text, /dev3/);
    assert.match(sentMessages[1].text, /✅ Деплой бэкенда готов/);
    assert.match(sentMessages[1].text, /!3319/);
    assert.match(sentMessages[1].text, /gitlab\/job\/1/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('cmdQaBot: /deploy без аргументов — подсказка, без запуска', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'qa-bot-deploy-usage-'));
  const sentMessages = [];
  let deployCalled = false;

  const mockFetch = async (url, init) => {
    const u = String(url);
    if (u.includes('getMe')) {
      return { ok: true, json: async () => ({ ok: true, result: { username: 'test_qa_bot' } }) };
    }
    if (u.includes('getUpdates')) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          result: [
            {
              update_id: 1,
              message: {
                chat: { id: 100, type: 'private' },
                message_id: 1,
                from: { id: 50 },
                text: '/deploy',
              },
            },
          ],
        }),
      };
    }
    if (u.includes('sendMessage')) {
      const body = JSON.parse(init.body);
      sentMessages.push(body);
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 99 } }) };
    }
    return { ok: true, json: async () => ({ ok: true, result: {} }) };
  };

  try {
    await cmdQaBot(
      { token: 'test-token', projectDir: '/fake/dir' },
      {
        cycles: 1,
        fetchImpl: mockFetch,
        sleepImpl: async () => {},
        stateRoot: tmp,
        readSecretImpl: () => null,
        log: () => {},
        loadCfg: () => ({}),
        deployImpl: async () => { deployCalled = true; },
      }
    );
    assert.equal(deployCalled, false);
    assert.equal(sentMessages.length, 1);
    assert.match(sentMessages[0].text, /Использование/);
    assert.match(sentMessages[0].text, /\/deploy be/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('cmdQaBot: цикл обработки вопроса тестировщика', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'qa-bot-run-'));
  const sentMessages = [];

  const mockFetch = async (url, init) => {
    const u = String(url);
    if (u.includes('getMe')) {
      return { ok: true, json: async () => ({ ok: true, result: { username: 'test_qa_bot' } }) };
    }
    if (u.includes('getUpdates')) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          result: [
            {
              update_id: 1,
              message: {
                chat: { id: 100, type: 'private' },
                message_id: 1,
                from: { id: 50 },
                text: 'FD-8096',
              },
            },
          ],
        }),
      };
    }
    if (u.includes('sendMessage')) {
      const body = JSON.parse(init.body);
      sentMessages.push(body);
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 99 } }) };
    }
    return { ok: true, json: async () => ({ ok: true, result: {} }) };
  };

  try {
    const res = await cmdQaBot(
      { token: 'test-token', projectDir: '/fake/dir' },
      {
        cycles: 1,
        fetchImpl: mockFetch,
        sleepImpl: async () => {},
        stateRoot: tmp,
        readSecretImpl: () => null,
        log: () => {},
      }
    );

    assert.equal(res.ok, true);
    assert.equal(sentMessages.length, 1);
    assert.match(sentMessages[0].text, /Зафиксировал задачу/);
    assert.match(sentMessages[0].text, /FD-8096/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('cmdQaBot: обнаружение бага тегает разработчика и шлет алерт в dev chat', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'qa-bot-bug-'));
  const sentMessages = [];

  saveQaBotState(tmp, {
    offset: 1,
    sessions: {
      100: {
        taskKey: 'FD-8096',
        taskSummary: 'Тестовая задача',
        conversationId: 'prev-conv',
      },
    },
  });

  const mockFetch = async (url, init) => {
    const u = String(url);
    if (u.includes('getMe')) {
      return { ok: true, json: async () => ({ ok: true, result: { username: 'test_qa_bot' } }) };
    }
    if (u.includes('sendChatAction')) {
      return { ok: true, json: async () => ({ ok: true, result: true }) };
    }
    if (u.includes('getUpdates')) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          result: [
            {
              update_id: 2,
              message: {
                chat: { id: 100, type: 'group' },
                message_id: 2,
                from: { id: 50 },
                text: 'почему кнопка не нажимается?',
              },
            },
          ],
        }),
      };
    }
    if (u.includes('sendMessage')) {
      const body = JSON.parse(init.body);
      sentMessages.push({ method: 'sendMessage', ...body });
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 101 } }) };
    }
    if (u.includes('editMessageText')) {
      const body = JSON.parse(init.body);
      sentMessages.push({ method: 'editMessageText', ...body });
      return { ok: true, json: async () => ({ ok: true, result: { message_id: body.message_id } }) };
    }
    return { ok: true, json: async () => ({ ok: true, result: {} }) };
  };

  const mockExec = async () => ({
    stdout: JSON.stringify({
      conversation_id: 'new-conv',
      response: `[BUG_DETECTED]
Суть бага: Клик заблокирован disabled атрибутом
Где в коде: PayButton.vue:12
Ожидаемое vs фактическое: Кнопка должна быть активна
[/BUG_DETECTED]
Кнопка заблокирована атрибутом disabled:false.`,
    }),
  });

  try {
    const res = await cmdQaBot(
      { token: 'test-token', projectDir: '/fake/dir', tag: '@dev_amir' },
      {
        cycles: 1,
        fetchImpl: mockFetch,
        sleepImpl: async () => {},
        execImpl: mockExec,
        stateRoot: tmp,
        readSecretImpl: () => null,
        log: () => {},
        loadCfg: () => ({ telegram: { chat_id: '999999' } }),
      }
    );

    assert.equal(res.ok, true);
    // 1. Было послано статус-сообщение "Думаю…"
    const statusMsg = sentMessages.find((m) => m.method === 'sendMessage' && m.chat_id === 100);
    assert.ok(statusMsg);
    assert.equal(statusMsg.text, 'Думаю…');

    // 2. Статус-сообщение отредактировано на алерт с тегом разработчика
    const editedMsg = sentMessages.find((m) => m.method === 'editMessageText' && m.chat_id === 100);
    assert.ok(editedMsg);
    assert.match(editedMsg.text, /@dev_amir/);
    assert.match(editedMsg.text, /Клик заблокирован/);

    // 3. Разработчику в dev chat ушел отдельный алерт
    const devAlert = sentMessages.find((m) => m.method === 'sendMessage' && m.chat_id === '999999');
    assert.ok(devAlert);
    assert.match(devAlert.text, /QA-бот обнаружил баг/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
