import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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
