import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cmdBot } from '../src/commands/bot.js';
import { createRun, saveArtifact } from '../src/agent/journal.js';
import { createEventStream } from '../src/agent/events.js';

let root;
let origin;
let project;
let runsDir;
let stateRoot;

const git = (args, cwd) =>
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=t@e.st', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

before(() => {
  root = mkdtempSync(path.join(tmpdir(), 'fs-harness-bot-'));
  origin = path.join(root, 'origin.git');
  project = path.join(root, 'project');
  runsDir = path.join(root, 'runs');
  stateRoot = path.join(root, 'state');
  git(['init', '--bare', '-b', 'main', origin], root);
  git(['clone', origin, project], root);
  writeFileSync(path.join(project, 'f.txt'), 'база\n');
  git(['add', 'f.txt'], project);
  git(['commit', '-m', 'база'], project);
  git(['push', 'origin', 'main'], project);
});

after(() => rmSync(root, { recursive: true, force: true }));

const MY_ID = 10;
const cfgBase = () => ({
  repo: 'r/repo',
  host: 'gitlab.example',
  projectDir: project,
  projects: { p: { repo: 'r/repo' } },
  telegram: { chat_id: '555', bot_token: 'tok-b', approvals: true, allowed_user_ids: [MY_ID] },
  watch: { enabled: false },
  agents: { echo: { bin: 'echo' }, claude: { bin: 'claude' } },
});

// fetchImpl-очередь: getUpdates и sendMessage/answerCallback из одного лога.
function makeFetch() {
  const log = [];
  const updatesQueue = [];
  const results = new Map(); // method → result or default
  return {
    log,
    pushUpdates(list) { updatesQueue.push(list); },
    setResult(method, result) { results.set(method, result); },
    fetchImpl: async (url, init) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      const method = /\/bot[^/]+\/([^/?]+)/.exec(url)?.[1] ?? '?';
      log.push({ method, url, body });
      if (method === 'getUpdates') {
        const list = updatesQueue.shift() ?? [];
        return { ok: true, status: 200, json: async () => ({ ok: true, result: list }) };
      }
      const r = results.has(method) ? results.get(method) : true;
      return { ok: true, status: 200, json: async () => ({ ok: true, result: r }) };
    },
  };
}

const sleep = async () => {};
const log = () => {};

test('bot: нет allowlist — не стартует; нет токена — тоже', async () => {
  const noAllow = { ...cfgBase(), telegram: { chat_id: '1', bot_token: 't', allowed_user_ids: [] } };
  await assert.rejects(
    () => cmdBot({}, { env: {}, loadCfg: () => noAllow, cycles: 1, log, sleep, fetchImpl: makeFetch().fetchImpl }),
    (e) => e.code === 'config_invalid' && /allowed_user_ids/.test(e.message) && /userinfobot/.test(e.message),
  );
  const noToken = { ...cfgBase(), telegram: { chat_id: '1', bot_token: '', allowed_user_ids: [1] } };
  await assert.rejects(
    () => cmdBot({}, { env: {}, loadCfg: () => noToken, cycles: 1, log, sleep, fetchImpl: makeFetch().fetchImpl, readSecretImpl: () => null }),
    (e) => e.code === 'config_invalid' && /bot_token/.test(e.message),
  );
});

test('bot: /mrs от чужого — ноль исходящих; от своего — один sendMessage', async () => {
  const f = makeFetch();
  const localState = mkdtempSync(path.join(tmpdir(), 'fs-harness-bot-st0-'));
  // Первый getUpdates — начальный снос без offset (пустой), потом уже апдейты.
  f.pushUpdates([]);
  f.pushUpdates([
    { update_id: 1, message: { text: '/mrs', chat: { id: 5 }, from: { id: 999 } } },
    { update_id: 2, message: { text: '/mrs', chat: { id: 5 }, from: { id: MY_ID } } },
  ]);
  f.pushUpdates([]); // второй цикл — пусто
  f.setResult('sendMessage', { message_id: 1 });

  let mrsCalls = 0;
  await cmdBot({}, {
    env: {},
    loadCfg: () => cfgBase(),
    fetchImpl: f.fetchImpl,
    sleep,
    log,
    cycles: 2,
    runsDir,
    stateRoot: localState,
    commands: {
      mrs: async () => {
        mrsCalls++;
        return { mrs: [{ iid: 7, title: 'Один', pipeline: { status: 'success' } }] };
      },
    },
  });

  assert.equal(mrsCalls, 1, 'чужой /mrs не должен был дойти до команды');
  const sends = f.log.filter((x) => x.method === 'sendMessage');
  assert.equal(sends.length, 1, 'только свой /mrs ответил');
  assert.match(sends[0].body.text, /!7 Один/);
  assert.equal(sends[0].body.chat_id, 5, 'отвечаем в чат, откуда пришло сообщение');
  rmSync(localState, { recursive: true, force: true });
});

test('bot: протухший nonce — «Устарело», publish не зван; верный — publish один раз, повтор — «Устарело»', async () => {
  const f = makeFetch();
  f.setResult('sendMessage', { message_id: 2 });
  f.setResult('editMessageReplyMarkup', true);
  // Свежий offset: предыдущий тест уже писал в общий stateRoot.
  const localState = mkdtempSync(path.join(tmpdir(), 'fs-harness-bot-st-'));

  // worktree для рана
  const wt = path.join(root, 'wt-rev');
  git(['worktree', 'add', '--detach', wt, 'origin/main'], project);

  const good = createRun('conflict', { root: runsDir });
  const head = git(['rev-parse', 'HEAD'], wt);
  saveArtifact(good, 'meta.json', {
    id: good.id, action: 'conflict', mr: 7, source_branch: 'main', target_branch: 'main',
    worktree: wt, project_dir: project, branch: null, base: 'origin/main', head_sha: head,
    state: 'pending_approval', facts: {}, pre: { conflictFiles: [] },
    approval: { nonce: 'nonce-good', issued_at: new Date().toISOString(), run: good.id, chat_id: '555', message_id: 2 },
  });
  saveArtifact(good, 'verdict.json', {
    decision: 'approve', confidence: 0.9, summary: 'ок', findings: [], checks: [],
    next: { action: 'push', hint: '' }, meta: { cost: 0.1 },
  });

  const publishes = [];
  // Начальный снос без offset, затем цикл 1: протухший + верный; цикл 2: повтор nonce.
  f.pushUpdates([]);
  f.pushUpdates([
    { update_id: 10, callback_query: { id: 'c1', data: `appr:${good.id}:nonce-bad`, from: { id: MY_ID }, message: { chat: { id: 555 }, message_id: 2 } } },
    { update_id: 11, callback_query: { id: 'c2', data: `appr:${good.id}:nonce-good`, from: { id: MY_ID }, message: { chat: { id: 555 }, message_id: 2 } } },
  ]);
  f.pushUpdates([
    { update_id: 12, callback_query: { id: 'c3', data: `appr:${good.id}:nonce-good`, from: { id: MY_ID }, message: { chat: { id: 555 }, message_id: 2 } } },
  ]);

  await cmdBot({}, {
    env: {},
    loadCfg: () => cfgBase(),
    fetchImpl: f.fetchImpl,
    sleep,
    log,
    cycles: 2,
    runsDir,
    stateRoot: localState,
    makeCtx: (cfg) => ({ g: {}, repo: cfg.repo, cfg, jira: () => ({}) }),
    publish: async (runId, deps) => {
      publishes.push({ runId, deps });
      return { ok: true, run: runId, pushed: true };
    },
    revise: async () => { throw new Error('не ждали revise'); },
    commands: {
      mrs: async () => ({ mrs: [] }),
    },
  });

  const answers = f.log.filter((x) => x.method === 'answerCallbackQuery');
  assert.equal(publishes.length, 1, `publish ровно один раз, было ${publishes.length}`);
  assert.equal(publishes[0].runId, good.id);

  const texts = answers.map((a) => a.body.text);
  assert.ok(texts.some((t) => /Устарело/.test(t)), `нет «Устарело»: ${texts.join(' | ')}`);
  assert.ok(texts.some((t) => /Публикую/.test(t)), `нет «Публикую»: ${texts.join(' | ')}`);
  // c1 (bad) — Устарело; c2 — Публикую; c3 (тот же nonce, уже обнулён) — Устарело
  assert.equal(texts.filter((t) => /Устарело/.test(t)).length, 2, texts.join(' | '));

  const meta = JSON.parse(readFileSync(path.join(good.dir, 'meta.json'), 'utf8'));
  assert.equal(meta.approval.nonce, null, 'nonce обнулён до publish');
  rmSync(localState, { recursive: true, force: true });
});

test('bot: чужой callback молча ignored — ни одного answerCallbackQuery', async () => {
  const f = makeFetch();
  const localState = mkdtempSync(path.join(tmpdir(), 'fs-harness-bot-st2-'));
  f.pushUpdates([]); // начальный снос
  f.pushUpdates([
    { update_id: 20, callback_query: { id: 'c9', data: 'appr:run-x:n', from: { id: 999 }, message: { chat: { id: 5 }, message_id: 1 } } },
  ]);
  f.pushUpdates([]);
  const publishes = [];
  await cmdBot({}, {
    env: {},
    loadCfg: () => cfgBase(),
    fetchImpl: f.fetchImpl,
    sleep,
    log,
    cycles: 2,
    runsDir,
    stateRoot: localState,
    publish: async (id) => { publishes.push(id); },
  });
  assert.equal(publishes.length, 0);
  assert.equal(f.log.filter((x) => x.method === 'answerCallbackQuery').length, 0);
  assert.equal(f.log.filter((x) => x.method === 'sendMessage').length, 0);
});

test('bot: reject — state rejected, worktree убран, кнопки сняты', async () => {
  const f = makeFetch();
  const localState = mkdtempSync(path.join(tmpdir(), 'fs-harness-bot-st3-'));
  f.setResult('sendMessage', { message_id: 3 });
  f.setResult('editMessageReplyMarkup', true);
  const wt = path.join(root, 'wt-rej');
  git(['worktree', 'add', '--detach', wt, 'origin/main'], project);

  const run = createRun('conflict', { root: runsDir });
  saveArtifact(run, 'meta.json', {
    id: run.id, action: 'conflict', mr: 8, worktree: wt, project_dir: project,
    branch: null, base: 'origin/main', head_sha: git(['rev-parse', 'HEAD'], wt),
    state: 'pending_approval', facts: {},
    approval: { nonce: 'n-rej', issued_at: new Date().toISOString(), run: run.id },
  });
  f.pushUpdates([]); // начальный снос
  f.pushUpdates([
    { update_id: 30, callback_query: { id: 'cr', data: `rej:${run.id}:n-rej`, from: { id: MY_ID }, message: { chat: { id: 555 }, message_id: 3 } } },
  ]);
  f.pushUpdates([]);

  await cmdBot({}, {
    env: {},
    loadCfg: () => cfgBase(),
    fetchImpl: f.fetchImpl,
    sleep,
    log,
    cycles: 2,
    runsDir,
    stateRoot: localState,
    publish: async () => { throw new Error('publish не должен быть зван'); },
    revise: async () => { throw new Error('revise не должен быть зван'); },
  });

  const meta = JSON.parse(readFileSync(path.join(run.dir, 'meta.json'), 'utf8'));
  assert.equal(meta.state, 'rejected');
  assert.equal(existsSync(wt), false, 'worktree должен быть убран');
  const answers = f.log.filter((x) => x.method === 'answerCallbackQuery');
  assert.ok(answers.some((a) => /Отклонено/.test(a.body.text)));
  const edits = f.log.filter((x) => x.method === 'editMessageReplyMarkup');
  assert.ok(edits.length >= 1, 'кнопки сняты');
  rmSync(localState, { recursive: true, force: true });
});

test('bot: команды MR (/mr, /jobs, /comments, /deploy)', async () => {
  const f = makeFetch();
  const localState = mkdtempSync(path.join(tmpdir(), 'fs-harness-bot-mr-'));
  f.pushUpdates([]); // начальный снос
  f.pushUpdates([
    { update_id: 40, message: { text: '/mr 123', chat: { id: 5 }, from: { id: MY_ID } } },
    { update_id: 41, message: { text: '/jobs 123', chat: { id: 5 }, from: { id: MY_ID } } },
    { update_id: 42, message: { text: '/comments 123', chat: { id: 5 }, from: { id: MY_ID } } },
    { update_id: 43, message: { text: '/deploy 123 2', chat: { id: 5 }, from: { id: MY_ID } } },
  ]);
  f.pushUpdates([]);
  f.setResult('sendMessage', { message_id: 10 });

  let deployCalled = null;
  await cmdBot({}, {
    env: {},
    loadCfg: () => cfgBase(),
    fetchImpl: f.fetchImpl,
    sleep,
    log,
    cycles: 2,
    runsDir,
    stateRoot: localState,
    commands: {
      mr: async (q) => ({
        iid: Number(q),
        title: 'Тестовый MR',
        source_branch: 'feat/test',
        target_branch: 'dev',
        pipeline: { id: 999, status: 'success' },
        comments: { total: 2, open: 1, resolved: 1 },
        updated_at: new Date().toISOString(),
      }),
      jobs: async (q) => ({
        mr: Number(q),
        pipeline: { id: 999, status: 'success' },
        jobs: [{ id: 11, name: 'unit_tests', stage: 'test', status: 'success' }],
      }),
      comments: async (q) => ({
        mr: Number(q),
        total: 1,
        open: 1,
        resolved: 0,
        discussions: [{ notes: [{ author: 'bob', body: 'Поправь стиль' }] }],
      }),
      deploy: async (q, slot) => {
        deployCalled = { q, slot };
      },
    },
  });

  const sends = f.log.filter((x) => x.method === 'sendMessage');
  assert.ok(sends.some((s) => s.body.text.includes('Тестовый MR')));
  assert.ok(sends.some((s) => s.body.text.includes('unit_tests')));
  assert.ok(sends.some((s) => s.body.text.includes('Поправь стиль')));
  assert.ok(sends.some((s) => s.body.text.includes('Запускаю деплой')));
  assert.deepEqual(deployCalled, { q: '123', slot: 2 });
  rmSync(localState, { recursive: true, force: true });
});

test('bot: команды задач Jira (/tasks, /task, /task start, /task move)', async () => {
  const f = makeFetch();
  const localState = mkdtempSync(path.join(tmpdir(), 'fs-harness-bot-task-'));
  f.pushUpdates([]); // начальный снос
  f.pushUpdates([
    { update_id: 50, message: { text: '/tasks', chat: { id: 5 }, from: { id: MY_ID } } },
    { update_id: 51, message: { text: '/task FD-7719', chat: { id: 5 }, from: { id: MY_ID } } },
    { update_id: 52, message: { text: '/task start FD-7719', chat: { id: 5 }, from: { id: MY_ID } } },
    { update_id: 53, message: { text: '/task move FD-7719 Done', chat: { id: 5 }, from: { id: MY_ID } } },
    { update_id: 54, message: { text: '/help', chat: { id: 5 }, from: { id: MY_ID } } },
  ]);
  f.pushUpdates([]);
  f.setResult('sendMessage', { message_id: 11 });

  let moveCalled = null;
  await cmdBot({}, {
    env: {},
    loadCfg: () => cfgBase(),
    fetchImpl: f.fetchImpl,
    sleep,
    log,
    cycles: 2,
    runsDir,
    stateRoot: localState,
    commands: {
      tasks: async () => ({
        issues: [{ key: 'FD-7719', summary: 'Починить баг', status: 'Open', priority: 'Medium' }],
      }),
      jira: async (args) => {
        if (args[0] === 'move') {
          moveCalled = { key: args[1], to: args[2] };
          return { key: args[1], from: 'In Progress', to: args[2] };
        }
        return {
          issue: { key: args[0], summary: 'Починить баг', status: 'Open', type: 'Bug', priority: 'High', description: 'Баг авторизации' },
          comments: [],
        };
      },
      task: async (args) => {
        if (args[0] === 'start') {
          return { key: args[1], branch: `feature/${args[1]}`, target: 'dev', state: 'created' };
        }
        return {};
      },
    },
  });

  const sends = f.log.filter((x) => x.method === 'sendMessage');
  assert.ok(sends.some((s) => s.body.text.includes('FD-7719') && s.body.text.includes('Мои задачи')));
  assert.ok(sends.some((s) => s.body.text.includes('Баг авторизации')));
  assert.ok(sends.some((s) => s.body.text.includes('ветка <code>feature/FD-7719</code> готова')));
  assert.ok(sends.some((s) => s.body.text.includes('In Progress') && s.body.text.includes('Done')));
  assert.ok(sends.some((s) => s.body.text.includes('FSH Telegram Bot')));
  assert.deepEqual(moveCalled, { key: 'FD-7719', to: 'Done' });
  rmSync(localState, { recursive: true, force: true });
});

test('bot: команда /agent — вызов автономного агента в проекте', async () => {
  const f = makeFetch();
  const localState = mkdtempSync(path.join(tmpdir(), 'fs-harness-bot-agent-'));
  f.pushUpdates([]); // начальный снос
  f.pushUpdates([
    { update_id: 60, message: { text: '/agent', chat: { id: 5 }, from: { id: MY_ID } } },
    { update_id: 61, message: { text: '/agent почини баг в коде', chat: { id: 5 }, from: { id: MY_ID } } },
    { update_id: 62, message: { text: '/agent cc сделай рефакторинг', chat: { id: 5 }, from: { id: MY_ID } } },
  ]);
  f.pushUpdates([]);
  f.setResult('sendMessage', { message_id: 20 });

  let agentCalls = [];
  await cmdBot({}, {
    env: {},
    loadCfg: () => cfgBase(),
    fetchImpl: f.fetchImpl,
    sleep,
    log,
    cycles: 2,
    runsDir,
    stateRoot: localState,
    commands: {
      agent: async ({ agent, prompt, projectDir }) => {
        agentCalls.push({ agent, prompt, projectDir });
        return { text: `Успешно сделано: ${prompt}` };
      },
    },
  });

  const sends = f.log.filter((x) => x.method === 'sendMessage');
  assert.ok(sends.some((s) => s.body.text.includes('Использование: /agent')));
  assert.ok(sends.some((s) => s.body.text.includes('Запускаю агента') && s.body.text.includes('почини баг в коде')));
  assert.ok(sends.some((s) => s.body.text.includes('Успешно сделано: почини баг в коде')));
  assert.equal(agentCalls.length, 2);
  assert.equal(agentCalls[0].agent, 'agy');
  assert.equal(agentCalls[0].prompt, 'почини баг в коде');
  assert.equal(agentCalls[1].agent, 'cc');
  assert.equal(agentCalls[1].prompt, 'сделай рефакторинг');
  rmSync(localState, { recursive: true, force: true });
});

test('bot: runAgentViaBot через spawnAgentImpl — стрим и отчёт', async () => {
  const f = makeFetch();
  const localState = mkdtempSync(path.join(tmpdir(), 'fs-harness-bot-agent-spawn-'));
  f.pushUpdates([]); // начальный снос
  f.pushUpdates([
    { update_id: 70, message: { text: '/agent напиши код', chat: { id: 5 }, from: { id: MY_ID } } },
  ]);
  f.pushUpdates([]);
  f.setResult('sendMessage', { message_id: 25 });

  let spawnOpts = null;
  const fakeSpawn = (opts) => {
    spawnOpts = opts;
    const events = createEventStream();
    events.push({
      t: 'log',
      stream: 'stdout',
      text: JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'Код написан, тесты зеленые' } }),
    });
    return {
      events,
      result: Promise.resolve({ ok: true, code: 0 }),
      abort: () => {},
    };
  };

  await cmdBot({}, {
    env: {},
    loadCfg: () => cfgBase(),
    fetchImpl: f.fetchImpl,
    sleep,
    log,
    cycles: 2,
    runsDir,
    stateRoot: localState,
    spawnAgentImpl: fakeSpawn,
  });

  const sends = f.log.filter((x) => x.method === 'sendMessage');
  assert.ok(sends.some((s) => s.body.text.includes('Код написан, тесты зеленые')));
  assert.equal(spawnOpts.cwd, project);
  assert.ok(spawnOpts.input.includes('Ты автономный AI-разработчик'));
  assert.ok(spawnOpts.input.includes('напиши код'));
  rmSync(localState, { recursive: true, force: true });
});


