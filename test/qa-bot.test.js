import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  extractTaskKey,
  findTaskBranch,
  getBranchDiffStat,
  buildQaPrompt,
  parseQaResponse,
  formatBugAlert,
  splitMessage,
  parseQaPost,
  runQaAgent,
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
  assert.match(prompt, /git show <ветка>:<путь>/);
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

test('formatBugAlert: Markdown, тег разработчика и цитата бага', () => {
  const alert = formatBugAlert({
    taskKey: 'FD-8096',
    bugDetails: 'Сломан клик в карусели\nв ReviewWidget.vue',
    cleanResponse: 'Разбор для QA: **ошибка** в хендлере',
    developer: 'amir.latipov',
  });
  assert.match(alert, /@amir\.latipov/);
  assert.match(alert, /\*\*FD-8096\*\*/);
  assert.match(alert, /^> Сломан клик в карусели\n> в ReviewWidget\.vue$/m);
  assert.match(alert, /\*\*ошибка\*\*/);
});

test('splitMessage: бьёт длинный текст по пустой строке', () => {
  assert.deepEqual(splitMessage('Короткий текст', 100), ['Короткий текст']);
  const p1 = 'A'.repeat(60);
  const p2 = 'B'.repeat(60);
  assert.deepEqual(splitMessage(`${p1}\n\n${p2}`, 80), [p1, p2]);
});

test('parseQaPost: команды через «!», остальное — вопрос', () => {
  assert.deepEqual(parseQaPost('!deploy be 3325 2'), { kind: 'command', name: 'deploy', args: ['be', '3325', '2'] });
  assert.deepEqual(parseQaPost('  !HELP '), { kind: 'command', name: 'help', args: [] });
  assert.deepEqual(parseQaPost('какой флаг нужен?'), { kind: 'text', text: 'какой флаг нужен?' });
  assert.deepEqual(parseQaPost('   '), { kind: 'ignored' });
});

test('runQaAgent: claude только на чтение, resume сессии, без обхода разрешений', async () => {
  let seen;
  const execImpl = async (cmd, args, opts) => {
    seen = { cmd, args, opts };
    return { stdout: JSON.stringify({ session_id: 's-2', result: 'Флаг video_reviews: on', is_error: false }) };
  };
  const res = await runQaAgent({ prompt: 'вопрос', sessionId: 's-1', cwd: '/fake', execImpl });
  assert.deepEqual(res, { sessionId: 's-2', response: 'Флаг video_reviews: on' });
  assert.equal(seen.cmd, 'claude');
  const arg = (flag) => seen.args[seen.args.indexOf(flag) + 1];
  assert.equal(arg('--model'), 'haiku');
  assert.equal(arg('--tools'), 'Read,Grep,Glob,Bash');
  assert.equal(arg('--permission-mode'), 'dontAsk');
  assert.equal(arg('--resume'), 's-1');
  assert.doesNotMatch(arg('--allowedTools'), /Bash\((?!git (log|diff|show)|fsh growthbook (list|get))/);
  assert.ok(!seen.args.some((a) => /dangerously|bypass/i.test(a)));
  assert.equal(seen.args.at(-1), 'вопрос', 'промпт — последним позиционным, после всех флагов');
  assert.equal(seen.opts.cwd, '/fake');

  const failing = async () => ({ stdout: JSON.stringify({ is_error: true, result: 'лимит' }) });
  await assert.rejects(runQaAgent({ prompt: 'x', cwd: '/f', execImpl: failing }), /лимит/);
});

test('loadQaBotState / saveQaBotState: since и сессии по каналу', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'qa-bot-test-'));
  try {
    assert.deepEqual(loadQaBotState(tmp), { since: null, sessions: {} });
    saveQaBotState(tmp, { since: 42, sessions: { dm1: { taskKey: 'FD-8096', sessionId: 'c-1' } } });
    const loaded = loadQaBotState(tmp);
    assert.equal(loaded.since, 42);
    assert.equal(loaded.sessions.dm1.taskKey, 'FD-8096');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// Фейковый Mattermost: бот qa_bot, личка dm1 с тестировщиком tester, разработчик dev.
const USERS = { tester: 'u-tester', dev: 'u-dev', stranger: 'u-stranger' };
function fakeMM(incoming, gb = () => assert.fail('GrowthBook не должен вызываться')) {
  const sent = [];
  const gbCalls = [];
  const patched = [];
  let n = 0;
  const json = (body) => ({ ok: true, status: 200, json: async () => body });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const p = u.pathname.replace('/api/v4', '');
    const body = init.body ? JSON.parse(init.body) : null;
    if (u.host === 'gb.invalid') {
      const call = { method: init.method || 'GET', path: u.pathname, body };
      gbCalls.push(call);
      return json(gb(call));
    }
    if (p === '/users/me') return json({ id: 'u-bot', username: 'qa_bot' });
    if (p === '/users/usernames') return json(body.filter((x) => USERS[x]).map((x) => ({ id: USERS[x], username: x })));
    if (p === '/users/ids') return json(body.map((id) => ({ id, username: Object.keys(USERS).find((k) => USERS[k] === id) })));
    if (p === '/users/me/channels') return json([{ id: 'dm1', type: 'D', last_post_at: 3000 }, { id: 'town', type: 'O', last_post_at: 3000 }]);
    if (p === '/channels/dm1/posts') {
      const since = Number(u.searchParams.get('since'));
      const posts = Object.fromEntries(incoming.filter((x) => x.create_at > since).map((x) => [x.id, { channel_id: 'dm1', ...x }]));
      return json({ order: Object.keys(posts), posts });
    }
    if (p === '/channels/direct') return json({ id: `dm-${body.join('-')}` });
    if (p === '/posts') { sent.push(body); return json({ id: `p${++n}` }); }
    if (p.endsWith('/patch')) { patched.push({ id: p.split('/')[2], ...body }); return json({}); }
    throw new Error(`неожиданный запрос ${init.method || 'GET'} ${p}`);
  };
  return { fetchImpl, sent, patched, gbCalls };
}

async function runBot(incoming, { state, exec, deploy, gb, qaBot = { allowed: ['tester'], developer: 'dev' } } = {}) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'qa-bot-mm-'));
  saveQaBotState(tmp, state ?? { since: 1000, sessions: {} });
  const mm = fakeMM(incoming, gb);
  const deployCalls = [];
  try {
    const res = await cmdQaBot({ projectDir: '/fake/dir' }, {
      cycles: 1,
      fetchImpl: mm.fetchImpl,
      sleepImpl: async () => {},
      stateRoot: tmp,
      readSecretImpl: (name) => ({ 'mattermost-qa': 'bot-token', growthbook: 'gb-token' })[name] ?? null,
      execImpl: exec ?? (async () => assert.fail('агент не должен запускаться')),
      deployImpl: async (a) => { deployCalls.push(a); return deploy?.(a) ?? { ok: true, mr: 3319, deploy: { web_url: 'https://gitlab/job/1' } }; },
      loadCfg: () => ({ mattermost: { baseUrl: 'https://mm.test', qaBot }, growthbook: { baseUrl: 'https://gb.invalid', project: 'prj_test', env: 'production' } }),
      log: () => {},
    });
    return { res, ...mm, deployCalls, state: loadQaBotState(tmp) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

test('cmdQaBot: !deploy be <ветка> <слот> — деплой бэкенда в фоне, итог в личку', async () => {
  const r = await runBot([{ id: 'a', user_id: USERS.tester, create_at: 2000, message: '!deploy be feature/FD-8096 3' }]);
  assert.deepEqual(r.deployCalls.map((c) => [c.query, c.slot, c.backend]), [['feature/FD-8096', 3, true]]);
  assert.equal(r.sent.length, 2);
  assert.match(r.sent[0].message, /деплой бэкенда: `feature\/FD-8096` → dev3/);
  assert.match(r.sent[1].message, /✅ Деплой бэкенда готов: MR `!3319`/);
  assert.match(r.sent[1].message, /gitlab\/job\/1/);
  assert.ok(r.sent.every((m) => m.channel_id === 'dm1'));
  assert.equal(r.state.since, 2000);
});

test('cmdQaBot: !deploy без аргументов — подсказка, без запуска', async () => {
  const r = await runBot([{ id: 'a', user_id: USERS.tester, create_at: 2000, message: '!deploy' }]);
  assert.equal(r.deployCalls.length, 0);
  assert.match(r.sent[0].message, /Использование/);
  assert.match(r.sent[0].message, /!deploy be/);
});

test('cmdQaBot: чужой пользователь — отказ, ни деплоя, ни агента', async () => {
  const r = await runBot([{ id: 'a', user_id: USERS.stranger, create_at: 2000, message: '!deploy be 3325 2' }]);
  assert.equal(r.deployCalls.length, 0);
  assert.equal(r.sent.length, 1);
  assert.match(r.sent[0].message, /Нет доступа/);
});

test('cmdQaBot: свои, системные, старые и правленные посты пропускаются', async () => {
  const r = await runBot([
    { id: 'own', user_id: 'u-bot', create_at: 2000, message: '!help' },
    { id: 'sys', user_id: USERS.tester, create_at: 2001, message: 'joined', type: 'system_join_channel' },
    { id: 'old', user_id: USERS.tester, create_at: 900, update_at: 2002, message: '!help' },
  ]);
  assert.equal(r.sent.length, 0);
});

test('cmdQaBot: сообщение из одного ключа — фиксирует задачу без агента', async () => {
  const r = await runBot([{ id: 'a', user_id: USERS.tester, create_at: 2000, message: 'FD-8096' }]);
  assert.equal(r.sent.length, 1);
  assert.match(r.sent[0].message, /Зафиксировал задачу/);
  assert.equal(r.state.sessions.dm1.taskKey, 'FD-8096');
});

test('cmdQaBot: баг — «Думаю…» правится на алерт, разработчику уходит личка от бота', async () => {
  const exec = async () => ({
    stdout: JSON.stringify({
      session_id: 'new-sess',
      result: '[BUG_DETECTED]\nСуть бага: Клик заблокирован disabled\nГде в коде: PayButton.vue:12\n[/BUG_DETECTED]\nКнопка заблокирована.',
    }),
  });
  const r = await runBot(
    [{ id: 'q', user_id: USERS.tester, create_at: 2000, message: 'почему кнопка не нажимается?' }],
    { exec, state: { since: 1000, sessions: { dm1: { taskKey: 'FD-8096', sessionId: 'old-sess' } } } },
  );
  assert.equal(r.sent[0].message, 'Думаю…');
  assert.equal(r.patched.length, 1);
  assert.equal(r.patched[0].id, 'p1', 'правится именно пост «Думаю…»');
  assert.match(r.patched[0].message, /@dev/);
  assert.match(r.patched[0].message, /> Суть бага: Клик заблокирован/);
  const devAlert = r.sent.find((m) => m.channel_id === 'dm-u-bot-u-dev');
  assert.ok(devAlert, 'алерт в личку разработчику');
  assert.match(devAlert.message, /QA-бот обнаружил баг в задаче FD-8096/);
  assert.equal(r.state.sessions.dm1.sessionId, 'new-sess');
});

const flag = (over = {}) => ({
  feature: { id: 'flag', valueType: 'boolean', defaultValue: 'false', environments: { production: { enabled: false }, dev: { enabled: false } }, ...over },
});
const say = (message) => [{ id: 'a', user_id: USERS.tester, create_at: 2000, message }];

test('cmdQaBot: !flag on <id> — включает в dev, production и loadtest по умолчанию не трогает', async () => {
  const r = await runBot(say('!flag on flag'), { gb: () => flag({ environments: { production: { enabled: false }, dev: { enabled: true } } }) });
  assert.deepEqual(r.gbCalls.map((c) => [c.method, c.path, c.body?.environments]), [['POST', '/api/v1/features/flag/toggle', { dev: true }]]);
  assert.match(r.sent[0].message, /✅ Флаг `flag`/);
  assert.match(r.sent[0].message, /dev=on/);
});

test('cmdQaBot: !flag в production — отказ без запросов в GrowthBook', async () => {
  const r = await runBot(say('!flag off flag production'));
  assert.equal(r.gbCalls.length, 0);
  assert.match(r.sent[0].message, /только в dev, loadtest/);
});

test('cmdQaBot: !flag set — только если флаг выключен вне dev/loadtest', async () => {
  const live = await runBot(say('!flag set flag true'), { gb: () => flag({ environments: { production: { enabled: true }, dev: { enabled: true } } }) });
  assert.equal(live.gbCalls.length, 1, 'только чтение флага');
  assert.match(live.sent[0].message, /включён в production/);
  assert.match(live.sent[0].message, /@dev/);

  const r = await runBot(say('!flag set flag true'), { gb: (c) => (c.method === 'POST' ? flag({ defaultValue: 'true' }) : flag()) });
  assert.deepEqual(r.gbCalls.at(-1), { method: 'POST', path: '/api/v1/features/flag', body: { defaultValue: 'true' } });
  assert.match(r.sent[0].message, /default `true`/);
});

test('cmdQaBot: !flag create — флаг включён в dev, ошибка GrowthBook уходит в личку', async () => {
  const r = await runBot(say('!flag create new-flag string control'), { gb: () => flag({ id: 'new-flag', valueType: 'string', defaultValue: 'control' }) });
  const { body } = r.gbCalls[0];
  assert.deepEqual([body.id, body.valueType, body.defaultValue, body.environments], ['new-flag', 'string', 'control', { dev: { enabled: true, rules: [] } }]);
  assert.match(r.sent[0].message, /✅ Флаг `new-flag`/);

  const bad = await runBot(say('!flag set flag yes'), { gb: () => flag() });
  assert.match(bad.sent[0].message, /❌ .*true или false/);
});
