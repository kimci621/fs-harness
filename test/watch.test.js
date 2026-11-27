import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { diffSnapshots, pollOnce, stateFile, daemonSecretIssues, SNAPSHOT_VERSION } from '../src/watch.js';
import { cmdWatch, cmdWatchDaemon, serviceText, sleepFor } from '../src/commands/watch.js';
import { findFixButton } from '../src/tgbot.js';

const row = (over) => ({ iid: 1, title: 'MR', url: 'https://gl/1', branch: 'feature/FD-1', target: 'dev', threads: [], files: [], behind: 0, ...over });
const snap = (mrs) => ({ v: SNAPSHOT_VERSION, at: '2026-10-01T10:00:00Z', repo: 'a/b', mrs });
const th = (id, last, author = 'rev', text = 'поправь') => ({ id, last, author, text });

test('diff: первый снимок и снимок старого формата молчат', () => {
  assert.deepEqual(diffSnapshots(null, snap([row({ threads: [th('d1', 't1')] })])), []);
  assert.deepEqual(diffSnapshots({ at: 'x', repo: 'a/b', mrs: [] }, snap([row({ threads: [th('d1', 't1')] })])), []);
});

test('diff: новый тред и новая реплика ревьюера в старом — событие, тот же тред — нет', () => {
  const prev = snap([row({ threads: [th('d1', 't1')] })]);
  assert.deepEqual(diffSnapshots(prev, snap([row({ threads: [th('d1', 't1')] })])), []);
  const [e] = diffSnapshots(prev, snap([row({ threads: [th('d1', 't2', 'rev', 'ещё раз'), th('d2', 't3')] })]));
  assert.deepEqual(e.threads.map((t) => t.id), ['d1', 'd2']);
  assert.equal(e.conflict, null);
  assert.equal(e.behind, null);
});

test('diff: конфликт появился — событие с файлами, висит дальше — нет', () => {
  const [e] = diffSnapshots(snap([row({})]), snap([row({ files: ['a.js', 'b.vue'] })]));
  assert.deepEqual(e.conflict, ['a.js', 'b.vue']);
  assert.deepEqual(diffSnapshots(snap([row({ files: ['a.js'] })]), snap([row({ files: ['a.js', 'c.js'] })])), []);
});

test('diff: отставание срабатывает на переходе через порог: 9→10 есть, 12→15 нет', () => {
  const [e] = diffSnapshots(snap([row({ behind: 9 })]), snap([row({ behind: 10 })]));
  assert.equal(e.behind, 10);
  assert.deepEqual(diffSnapshots(snap([row({ behind: 12 })]), snap([row({ behind: 15 })])), []);
  // Порог на проект.
  assert.equal(diffSnapshots(snap([row({ behind: 2 })]), snap([row({ behind: 3 })]), { behindThreshold: 3 })[0].behind, 3);
  // Новый MR: прошлого состояния нет, считаем от нуля.
  assert.equal(diffSnapshots(snap([]), snap([row({ iid: 7, behind: 11 })]))[0].iid, 7);
});

// Фейковый GitLab: мои MR, треды и пайплайн меняются между опросами.
const fakeG = (state) => ({
  me: async () => ({ username: 'me' }),
  listOpenMRs: async () => state.mrs.map((m) => ({ ...m })),
  listMRPipelines: async (repo, iid) => (state.pipeline ? [{ id: 1, status: state.pipeline, sha: 'x' }] : []),
  getApprovals: async () => ({}),
  getDiscussions: async (repo, iid) => state.discussions[iid] ?? [],
});
const note = (author, created_at, body = 'поправь тут\nподробности') => ({ resolvable: true, resolved: false, system: false, author: { username: author }, created_at, body });
const MR = (iid, over = {}) => ({ iid, title: `MR ${iid}`, source_branch: `feature/FD-${iid}`, target_branch: 'dev', web_url: `https://gl/${iid}`, user_notes_count: 1, ...over });

test('pollOnce: чужой тред — событие, мой последний — нет, пайплайн и черновик — не события', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fs-harness-watch-'));
  const file = path.join(dir, 'state.json');
  const state = { mrs: [MR(1), MR(2), MR(3, { draft: true })], discussions: {}, pipeline: 'running' };
  const ctx = { g: fakeG(state), repo: 'a/b', cfg: {} };
  const git = { 1: { files: [], behind: 0 }, 2: { files: [], behind: 0 }, 3: { files: ['x'], behind: 50 } };
  const probe = (mr) => git[mr.iid];

  const first = await pollOnce({ ctx, probe, file });
  assert.equal(first.first, true);
  assert.deepEqual(first.events, []);

  state.pipeline = 'failed';
  state.discussions = {
    1: [{ id: 'd1', notes: [note('rev', 't1')] }],
    2: [{ id: 'd2', notes: [note('rev', 't1'), note('me', 't2')] }],
    3: [{ id: 'd3', notes: [note('rev', 't1')] }],
  };
  const second = await pollOnce({ ctx, probe, file });
  assert.deepEqual(second.events.map((e) => e.iid), [1]);
  assert.deepEqual(second.events[0].threads, [{ id: 'd1', last: 't1', author: 'rev', text: 'поправь тут' }]);

  // Ревьюер ответил мне в треде d2 — тред снова ждёт меня.
  state.discussions[2] = [{ id: 'd2', notes: [note('rev', 't1'), note('me', 't2'), note('rev', 't3', 'не согласен')] }];
  const third = await pollOnce({ ctx, probe, file });
  assert.deepEqual(third.events.map((e) => [e.iid, e.threads[0].text]), [[2, 'не согласен']]);
  rmSync(dir, { recursive: true, force: true });
});

test('pollOnce: MR, который не посчитался, держит прошлое состояние и не даёт ложных событий', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fs-harness-watch-'));
  const file = path.join(dir, 'state.json');
  const state = { mrs: [MR(1)], discussions: { 1: [{ id: 'd1', notes: [note('rev', 't1')] }] } };
  const ctx = { g: fakeG(state), repo: 'a/b', cfg: {} };
  let broken = false;
  const probe = () => { if (broken) throw new Error('fetch упал'); return { files: [], behind: 0 }; };
  await pollOnce({ ctx, probe, file });
  broken = true;
  const r = await pollOnce({ ctx, probe, file });
  assert.deepEqual(r.events, []);
  assert.equal(r.errors[0].iid, 1);
  broken = false;
  assert.deepEqual((await pollOnce({ ctx, probe, file })).events, []);
  rmSync(dir, { recursive: true, force: true });
});

test('watch: одно сообщение на MR с кнопкой fix:<iid>:<nonce>, nonce находит бот', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fs-harness-watch-'));
  const file = path.join(dir, 'state.json');
  const stateRoot = path.join(dir, 'st');
  const state = { mrs: [MR(5)], discussions: {} };
  const git = { files: [], behind: 3 };
  const ctx = {
    g: fakeG(state), repo: 'a/b',
    cfg: { activeProject: 'front', watch: { behindThreshold: 10 }, telegram: { chat_id: '42', bot_token: 'tok', allowed_user_ids: [1] } },
  };
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push({ method: /\/bot[^/]+\/(\w+)/.exec(url)[1], body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
  const opts = { asObject: true, file, stateRoot, fetchImpl, probe: () => git };

  await cmdWatch(ctx, opts);
  assert.equal(sent.length, 0);
  state.discussions[5] = [{ id: 'd1', notes: [note('rev', 't1', 'тут гонка')] }, { id: 'd2', notes: [note('rev2', 't2')] }];
  git.files = ['a.js'];
  git.behind = 12;
  const r = await cmdWatch(ctx, opts);
  assert.equal(r.notified, 1);
  assert.equal(sent.length, 1, 'одно сообщение на MR, а не на событие');
  const { body } = sent[0];
  assert.equal(body.chat_id, '42');
  assert.match(body.text, /!5/);
  assert.match(body.text, /feature\/FD-5.*→.*dev/);
  assert.match(body.text, /https:\/\/gl\/5/);
  assert.match(body.text, /@rev: тут гонка/);
  assert.match(body.text, /Конфликт с dev.*a\.js/);
  assert.match(body.text, /на 12 коммит/);
  const [btn] = body.reply_markup.inline_keyboard[0];
  assert.equal(btn.text, '🔧 Обновить и разобрать');
  const [cmd, iid, nonce] = btn.callback_data.split(':');
  assert.deepEqual([cmd, iid], ['fix', '5']);
  assert.ok(Buffer.byteLength(btn.callback_data) <= 64);
  assert.deepEqual(findFixButton(stateRoot, 5, nonce), { project: 'front', repo: 'a/b', iid: 5, at: findFixButton(stateRoot, 5, nonce).at });
  assert.equal(findFixButton(stateRoot, 6, nonce), null, 'nonce привязан к iid');

  // Без allowlist бот не стартует — кнопку не вешаем.
  ctx.cfg.telegram.allowed_user_ids = [];
  state.discussions[5].push({ id: 'd3', notes: [note('rev', 't3')] });
  await cmdWatch(ctx, opts);
  assert.equal(sent[1].body.reply_markup, undefined);
  rmSync(dir, { recursive: true, force: true });
});

test('stateFile: слеш в имени репозитория не создаёт вложенных каталогов', () => {
  assert.equal(path.basename(stateFile('a/b', '/tmp/x')), 'a%2Fb.json');
});

test('демон: обходит все проекты, уважает свой интервал и выключатель, падение опроса не роняет цикл', async () => {
  const projects = { front: {}, back: {}, off: {} };
  const watchOf = { front: { enabled: true, intervalSeconds: 10 }, back: { enabled: true, intervalSeconds: 3600 }, off: { enabled: false, intervalSeconds: 10 } };
  const loadCfg = (env, { project } = {}) => ({
    projects,
    activeProject: project ?? '',
    repo: project ? `org/${project}` : '',
    watch: watchOf[project] ?? { enabled: true, intervalSeconds: 60 },
    judge: { roles: {}, profiles: {} },
    telegram: {},
  });

  const polled = [];
  let clock = 0;
  const res = await cmdWatchDaemon({}, {
    env: {},
    loadCfg,
    makeCtx: (cfg) => ({ cfg, repo: cfg.repo }),
    poll: async (ctx) => {
      polled.push(`${ctx.repo}@${clock}`);
      if (ctx.repo === 'org/back') throw new Error('сеть моргнула');
      return { events: [], notified: 0 };
    },
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    cycles: 3,
    log: () => {},
  });

  assert.equal(res.cycles, 3);
  // off выключен и не опрашивается; back с часовым интервалом — только раз; front — каждый цикл.
  assert.deepEqual(polled, ['org/front@0', 'org/back@0', 'org/front@10000', 'org/front@20000']);
});

test('демон: без секретов в env не стартует, а без проектов — тем более', async () => {
  const cfgWithSecret = { projects: { front: {} }, telegram: { chat_id: '1', bot_token: '' } };
  const loadCfg = () => cfgWithSecret;
  await assert.rejects(
    cmdWatchDaemon({}, { env: {}, loadCfg, cycles: 1, log: () => {} }),
    (err) => err.code === 'secret_missing' && /FS_HARNESS_TELEGRAM/.test(err.message),
  );

  // Те же ключи в env — претензий нет.
  const env = { FS_HARNESS_TELEGRAM: 't' };
  assert.deepEqual(daemonSecretIssues(cfgWithSecret, env), []);
  // Токен бота лежит в конфиге — keychain не при делах, env не требуется.
  assert.deepEqual(daemonSecretIssues({ telegram: { chat_id: '1', bot_token: 'x' } }, {}), []);

  await assert.rejects(
    cmdWatchDaemon({}, { env: {}, loadCfg: () => ({ projects: {} }), cycles: 1, log: () => {} }),
    (err) => err.code === 'config_invalid',
  );
});

test('сон демона держит цикл событий: с unref процесс молча выходил с кодом 13', async () => {
  const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
  const before = timers();
  const p = sleepFor(20);
  assert.equal(timers(), before + 1);
  await p;
});

test('watch install: юнит зовёт fsh watch --daemon, несёт PATH и просит секреты в env', () => {
  const cfg = { telegram: { chat_id: '1' } };
  const mac = serviceText(cfg, { platform: 'darwin', node: '/n', script: '/s/fsh.js', home: '/h', path: '/opt/homebrew/bin:/usr/bin' });
  assert.match(mac.file, /LaunchAgents\/com\.fitstars\.fs-harness\.watch\.plist$/);
  assert.match(mac.text, /<string>watch<\/string>\s*<string>--daemon<\/string>/);
  assert.match(mac.text, /FS_HARNESS_TELEGRAM/);
  assert.match(mac.hint[0], /launchctl bootstrap/);
  // Без PATH launchd не найдёт glab: /usr/bin:/bin:/usr/sbin:/sbin — это всё, что он даёт.
  assert.match(mac.text, /<key>PATH<\/key><string>\/opt\/homebrew\/bin:\/usr\/bin<\/string>/);

  const linux = serviceText(cfg, { platform: 'linux', node: '/n', script: '/s/fsh.js', home: '/h', path: '/usr/local/bin' });
  assert.match(linux.text, /ExecStart=\/n \/s\/fsh\.js watch --daemon/);
  assert.match(linux.text, /Environment=PATH=\/usr\/local\/bin/);
  assert.match(linux.text, /Environment=FS_HARNESS_TELEGRAM=/);
});


test('демон: только уведомляет — воркер не зовёт даже при workers.enabled: true', async () => {
  let workerRan = false;
  const cfg = { projects: { front: {} }, repo: 'org/front', watch: { enabled: true, intervalSeconds: 10 }, workers: { enabled: true }, telegram: {} };
  await cmdWatchDaemon({}, {
    env: {},
    loadCfg: () => cfg,
    makeCtx: () => ({ cfg, repo: 'org/front' }),
    poll: async () => ({ events: [], notified: 0 }),
    sleep: async () => {},
    now: () => 0,
    cycles: 1,
    log: () => {},
    runWorkerImpl: async () => { workerRan = true; },
  });
  assert.equal(workerRan, false);
});

test('демон: автостарт ищет задачи «В работе» по JQL и запускает автомат на новых', async () => {
  const autoRoot = mkdtempSync(path.join(tmpdir(), 'fsh-auto-'));
  const loadCfg = (env, { project } = {}) => ({
    projects: { front: {} },
    repo: 'org/front',
    watch: { enabled: true, intervalSeconds: 60 },
    jira: { baseUrl: 'https://jira' },
    automation: { enabled: true, autoStart: true },
    judge: { roles: {}, profiles: {} },
    telegram: {},
  });
  const queries = [];
  const started = [];
  await cmdWatchDaemon({ autoExecute: true, autoRoot }, {
    env: {},
    loadCfg,
    makeCtx: (cfg) => ({ cfg, repo: cfg.repo, jira: () => ({ searchJql: async (q) => { queries.push(q); return { issues: [{ key: 'FD-7' }] }; } }) }),
    poll: async () => ({ events: [], notified: 0 }),
    advanceTaskImpl: async (key) => { started.push(key); return { state: {} }; },
    sleep: async () => {},
    cycles: 1,
    log: () => {},
  });
  rmSync(autoRoot, { recursive: true, force: true });
  assert.match(queries[0]?.jql ?? '', /assignee = currentUser\(\)/);
  assert.deepEqual(started, ['FD-7']);
});

// Событие уже в снимке, поэтому упавший разбор сам не повторится: сообщение обязано это сказать.
test('демон: упавший autoResolve — в сообщении, что сам не повторит, и команда с проектом', async () => {
  const loadCfg = (env, { project } = {}) => ({
    projects: { front: {} }, activeProject: project ?? '', repo: 'org/front',
    watch: { enabled: true, intervalSeconds: 10, autoResolve: true }, judge: { roles: {}, profiles: {} }, telegram: {},
  });
  const said = [];
  const results = [
    { ok: false, mrs: [{ iid: 7, sync: { status: 'failed', error: 'agy упал' }, threads: { status: 'blocked' }, mm: { status: 'not_needed' } }] },
    new Error('сеть'),
  ];
  let clock = 0;
  await cmdWatchDaemon({}, {
    env: {}, loadCfg, makeCtx: (cfg) => ({ cfg, repo: cfg.repo }),
    poll: async () => ({ events: [{ iid: 7 }], notified: 1 }),
    resolveAllImpl: async () => { const r = results.shift(); if (r instanceof Error) throw r; return r; },
    sayImpl: async (cfg, text) => said.push(text),
    runWaitsImpl: async () => {},
    sleep: async (ms) => { clock += ms; await new Promise((r) => setImmediate(r)); },
    now: () => clock, cycles: 2, log: () => {},
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(said.length, 2);
  for (const t of said) {
    assert.match(t, /Сам больше не возьмусь/);
    assert.match(t, /fsh resolve-all 7 -P front/);
  }
});

test('демон: autoResolve сам зовёт resolve-all по событию, повтор MR в очередь не встаёт, без флага — только сообщение', async () => {
  const projects = { front: {}, back: {} };
  const loadCfg = (env, { project } = {}) => ({
    projects,
    activeProject: project ?? '',
    repo: project ? `org/${project}` : '',
    watch: { enabled: true, intervalSeconds: 10, autoResolve: project === 'front' },
    judge: { roles: {}, profiles: {} },
    telegram: {},
  });
  const resolved = [];
  const said = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  let clock = 0;
  await cmdWatchDaemon({}, {
    env: {},
    loadCfg,
    makeCtx: (cfg) => ({ cfg, repo: cfg.repo }),
    // Каждый круг оба проекта приносят событие по !7: первый разбор ещё идёт, когда приходит второе.
    poll: async () => ({ events: [{ iid: 7 }], notified: 1 }),
    resolveAllImpl: async (ctx, opts) => {
      resolved.push(`${ctx.repo}!${opts.only[0]}`);
      await gate;
      return { ok: true, mrs: [] };
    },
    sayImpl: async (cfg, text) => said.push(text),
    runWaitsImpl: async () => {},
    sleep: async (ms) => { clock += ms; if (clock >= 30000) release(); },
    now: () => clock,
    cycles: 3,
    log: () => {},
  });
  assert.deepEqual(resolved, ['org/front!7']);
  assert.equal(said.length, 1);
  assert.match(said[0], /!7: работы нет/);
});

// Временный сбой (упал процесс агента, рейт-лимит, MR занят) демон повторяет сам, но не больше двух раз.
const autoCfg = (telegram = {}) => (env, { project } = {}) => ({
  projects: { front: {} }, activeProject: project ?? '', repo: 'org/front',
  watch: { enabled: true, intervalSeconds: 10, autoResolve: true }, judge: { roles: {}, profiles: {} }, telegram,
});
const failed = (sync) => ({ ok: false, mrs: [{ iid: 7, sync: { status: 'failed', error: 'упал', ...sync }, threads: { status: 'not_needed' }, mm: { status: 'not_needed' } }] });
const runDaemon = async ({ results, telegram, events = () => [{ iid: 7 }], cycles = 1, stateRoot, loadCfg, sayImpl }) => {
  const said = [];
  const scheduled = [];
  const cancelled = [];
  const calls = [];
  let clock = 0;
  await cmdWatchDaemon({}, {
    env: {}, loadCfg: loadCfg ?? autoCfg(telegram), makeCtx: (cfg) => ({ cfg, repo: cfg.repo }),
    poll: async () => ({ events: events(), notified: 1 }),
    resolveAllImpl: async () => { calls.push(clock); return results.shift(); },
    sayImpl: async (cfg, text, buttons) => { said.push({ text, buttons }); await sayImpl?.(text); },
    schedule: (fn, ms) => { const s = { fn, ms }; scheduled.push(s); return () => cancelled.push(s); },
    stateRoot,
    runWaitsImpl: async () => {},
    sleep: async (ms) => { clock += ms; await new Promise((r) => setImmediate(r)); },
    now: () => clock, cycles, log: () => {},
  });
  return { said, scheduled, cancelled, calls };
};
const settle = () => new Promise((r) => setTimeout(r, 20));

test('демон: временный сбой повторяется через 5 минут, после двух повторов — «не возьмусь» с кнопкой «Повторить»', async () => {
  const stateRoot = mkdtempSync(path.join(tmpdir(), 'fs-harness-retry-'));
  const results = [failed({ transient: true }), failed({ transient: true }), failed({ transient: true })];
  const d = await runDaemon({ results, telegram: { allowed_user_ids: [1] }, stateRoot });
  assert.equal(d.scheduled.length, 1);
  assert.equal(d.scheduled[0].ms, 5 * 60_000);
  assert.match(d.said[0].text, /повторю сам через 5 мин \(повтор 1 из 2\)/);
  assert.equal(d.said[0].buttons, undefined, 'пока повтор впереди, кнопка не нужна');
  d.scheduled[0].fn();
  await settle();
  assert.equal(d.scheduled.length, 2);
  assert.match(d.said[1].text, /повтор 2 из 2/);
  d.scheduled[1].fn();
  await settle();
  assert.equal(d.scheduled.length, 2, 'третьего повтора нет');
  assert.equal(d.said.length, 3);
  assert.match(d.said[2].text, /Сам больше не возьмусь/);
  const [[btn]] = d.said[2].buttons;
  assert.equal(btn.text, '🔁 Повторить');
  assert.match(btn.callback_data, /^fix:7:/);
  assert.ok(findFixButton(stateRoot, 7, btn.callback_data.split(':')[2]), 'nonce кнопки не выдан');
  rmSync(stateRoot, { recursive: true, force: true });
});

test('демон: результат плох (нет коммитов, судья) — повтора нет; без allowlist — без кнопки', async () => {
  const d = await runDaemon({ results: [failed({ code: 'agent_failed' })] });
  await settle();
  assert.equal(d.scheduled.length, 0);
  assert.match(d.said[0].text, /Сам больше не возьмусь/);
  assert.equal(d.said[0].buttons, undefined);
});

test('демон: рейт-лимит ждёт retry_after, MR занят — тоже временный', async () => {
  const d = await runDaemon({ results: [failed({ transient: true, retry_after: 1800 })] });
  await settle();
  assert.equal(d.scheduled[0].ms, 1800_000);
  const locked = { ok: false, mrs: [{ iid: 7, sync: { status: 'locked' }, threads: { status: 'locked' }, mm: { status: 'not_needed' }, error: 'MR занят' }] };
  const l = await runDaemon({ results: [locked] });
  await settle();
  assert.equal(l.scheduled.length, 1);
});

test('демон: новое событие по MR отменяет отложенный повтор, остановка снимает таймеры', async () => {
  let n = 0;
  const results = [failed({ transient: true }), failed({ transient: true })];
  const d = await runDaemon({ results, events: () => (n++ < 2 ? [{ iid: 7 }] : []), cycles: 2 });
  await settle();
  assert.equal(d.calls.length, 2, 'новое событие запускает разбор сразу');
  assert.equal(d.scheduled.length, 2);
  assert.deepEqual(d.cancelled, [d.scheduled[0], d.scheduled[1]], 'первый повтор отменён событием, второй — остановкой');
});

test('демон: кнопку выдать не удалось — итог уходит без кнопки, очередь живёт дальше', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fs-harness-retry-'));
  writeFileSync(path.join(dir, 'file'), 'x');
  let n = 0;
  const d = await runDaemon({
    results: [failed({ code: 'agent_failed' }), failed({ code: 'agent_failed' })],
    telegram: { allowed_user_ids: [1] }, stateRoot: path.join(dir, 'file', 'state'),
    events: () => (n++ === 0 ? [{ iid: 7 }] : [{ iid: 8 }]), cycles: 2,
  });
  assert.equal(d.calls.length, 2, 'второй MR разобран');
  assert.equal(d.said[0].buttons, undefined);
  assert.match(d.said[0].text, /Доделать руками/);
  rmSync(dir, { recursive: true, force: true });
});

test('демон: новое событие, пока повтор ждёт в очереди, сбрасывает счёт повторов', async () => {
  const said = [];
  const scheduled = [];
  const calls = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  let cycle = 0;
  const evs = [[{ iid: 7 }], [{ iid: 9 }], [{ iid: 7 }]];
  const tick = () => new Promise((r) => setTimeout(r, 5));
  await cmdWatchDaemon({}, {
    env: {}, loadCfg: autoCfg(), makeCtx: (cfg) => ({ cfg, repo: cfg.repo }),
    poll: async () => ({ events: evs[cycle++] ?? [], notified: 0 }),
    resolveAllImpl: async (ctx, o) => {
      calls.push(o.only[0]);
      if (o.only[0] === 9) { await gate; return { ok: true, mrs: [] }; }
      return failed({ transient: true });
    },
    sayImpl: async (cfg, text) => said.push(text),
    schedule: (fn) => { scheduled.push(fn); return () => {}; },
    runWaitsImpl: async () => {},
    // цикл 2: !9 занял очередь, повтор !7 встал за ним; цикл 3: новое событие по !7, потом !9 отпускаем
    sleep: async () => { await tick(); if (cycle === 2) scheduled[0](); if (cycle === 3) release(); await tick(); },
    now: () => cycle * 20_000, cycles: 4, log: () => {},
  });
  await tick();
  assert.deepEqual(calls, [7, 9, 7]);
  assert.match(said.at(-1), /повтор 1 из 2/);
});

test('демон: повтор не идёт, если autoResolve выключили, пока он ждал', async () => {
  let off = false;
  const loadCfg = (env, o) => {
    const cfg = autoCfg()(env, o);
    if (off) cfg.watch.autoResolve = false;
    return cfg;
  };
  const d = await runDaemon({ results: [failed({ transient: true }), failed({ transient: true })], loadCfg });
  off = true;
  d.scheduled[0].fn();
  await settle();
  assert.equal(d.calls.length, 1);
});

test('демон: сообщение «повторю» не ушло — повтор всё равно взведён, «не возьмусь» не шлётся', async () => {
  const d = await runDaemon({
    results: [failed({ transient: true })],
    sayImpl: async (text) => { if (/повторю сам/.test(text)) throw new Error('telegram 502'); },
  });
  await settle();
  assert.equal(d.scheduled.length, 1);
  assert.equal(d.cancelled.length, 1, 'таймер снят только остановкой демона');
  assert.ok(!d.said.some((s) => /Сам больше не возьмусь/.test(s.text)));
});

test('демон: конфиг сломали, пока повтор ждал, — повтор отменён, демон не падает', async () => {
  let broken = false;
  const loadCfg = (env, o) => {
    if (broken && o?.project) throw new Error('Проекта "front" нет в конфиге');
    return autoCfg()(env, o);
  };
  const d = await runDaemon({ results: [failed({ transient: true })], loadCfg });
  broken = true;
  assert.doesNotThrow(() => d.scheduled[0].fn());
  await settle();
  assert.equal(d.calls.length, 1);
});

test('демон: сбой уборки локов не роняет цикл, корень локов берётся из deps', async () => {
  const cfg = { projects: { front: {} }, repo: 'org/front', watch: { enabled: true, intervalSeconds: 10 }, telegram: {} };
  const roots = [];
  const logs = [];
  await cmdWatchDaemon({}, {
    env: {},
    loadCfg: () => cfg,
    makeCtx: () => ({ cfg, repo: 'org/front' }),
    poll: async () => ({ events: [], notified: 0 }),
    sleep: async () => {},
    now: () => 10 * 3600_000,
    cycles: 1,
    log: (m) => logs.push(m),
    gcWorktreesImpl: async () => [],
    locksRoot: '/нет/такого',
    gcLocksImpl: ({ root }) => { roots.push(root); throw new Error('ENOTDIR'); },
  });
  assert.deepEqual(roots, ['/нет/такого']);
  assert.ok(logs.some((m) => /gc locks не удался: ENOTDIR/.test(m)), logs.join('\n'));
});
