import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { diffSnapshots, keepEvents, triagePayload, formatEvents, pollOnce, stateFile, daemonSecretIssues, daemonKeychainJudges } from '../src/watch.js';
import { cmdWatch, cmdWatchDaemon, serviceText, sleepFor } from '../src/commands/watch.js';
import { listJobs } from '../src/queue.js';

const mr = (over) => ({
  iid: 1, title: 'MR', source_branch: 'f', target_branch: 'dev', has_conflicts: false,
  pipeline: { id: 1, status: 'success' }, comments: { total: 0, open: 0, resolved: 0 },
  updated_at: '2026-09-11T10:00:00Z', web_url: 'https://gl/1', ...over,
});
const snap = (mrs) => ({ at: '2026-09-11T10:00:00Z', repo: 'a/b', mrs });

test('diff: первый снимок молчит, дальше видит пайплайн, треды, конфликт, приход и уход', () => {
  assert.deepEqual(diffSnapshots(null, snap([mr({})])), []);

  const prev = snap([mr({}), mr({ iid: 2, web_url: 'https://gl/2' })]);
  const next = snap([
    mr({ pipeline: { id: 2, status: 'failed' }, comments: { total: 3, open: 2, resolved: 1 }, has_conflicts: true }),
    mr({ iid: 3, web_url: 'https://gl/3' }),
  ]);
  const kinds = diffSnapshots(prev, next).map((e) => `${e.kind}:${e.mr}`);
  assert.deepEqual(kinds, ['pipeline:1', 'threads:1', 'conflict:1', 'mr_new:3', 'mr_gone:2']);
});

test('diff: без изменений событий нет, закрытые треды событием не считаются', () => {
  const prev = snap([mr({ comments: { total: 3, open: 2, resolved: 1 } })]);
  const next = snap([mr({ comments: { total: 3, open: 0, resolved: 3 } })]);
  assert.deepEqual(diffSnapshots(prev, next), []);
  assert.deepEqual(diffSnapshots(snap([mr({})]), snap([mr({})])), []);
});

test('триаж: nit и неупомянутые события до канала не доходят, провал триажа шлёт всё', () => {
  const events = diffSnapshots(snap([mr({}), mr({ iid: 2 })]), snap([
    mr({ pipeline: { id: 2, status: 'failed' } }),
    mr({ iid: 2, comments: { total: 1, open: 1, resolved: 0 } }),
  ]));
  assert.equal(events.length, 2);
  assert.match(triagePayload(events, 'a/b'), /e1 · pipeline · MR !1/);

  const verdict = {
    summary: 'один пайплайн упал',
    findings: [
      { severity: 'blocker', file: 'e1', line: 0, body: 'упал пайплайн' },
      { severity: 'nit', file: 'e2', line: 0, body: 'чужой тред' },
    ],
  };
  const kept = keepEvents(events, verdict);
  assert.deepEqual(kept.map((e) => [e.id, e.level]), [['e1', 'срочно']]);
  assert.match(formatEvents(kept, { verdict }), /срочно: MR !1/);

  // Судья недоступен — сигнал не теряем.
  assert.equal(keepEvents(events, null).length, 2);
  assert.equal(formatEvents([]), 'Ничего важного.');
});

test('pollOnce: первый опрос только пишет снимок, второй уже сравнивает и судит', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fs-harness-watch-'));
  const file = path.join(dir, 'state.json');
  let mrs = [mr({})];
  const g = {
    listOpenMRs: async () => mrs.map((m) => ({ ...m, sha: 'abc' })),
    listMRPipelines: async () => [],
    getDiscussions: async () => [],
  };
  const cfg = { judge: { profiles: { fake: { provider: 'fake' } }, roles: { 'event-triage': ['fake'] } } };
  const makeProvider = async () => ({
    name: 'fake',
    complete: async () => ({
      text: JSON.stringify({
        decision: 'reject', confidence: 0.8, summary: 'конфликт',
        findings: [{ severity: 'blocker', file: 'e1', line: 0, body: 'конфликт с dev' }],
        checks: [], next: { action: 'none', hint: '' },
      }),
      cost: 0,
    }),
  });

  const first = await pollOnce({ g, repo: 'a/b', cfg, file, makeProvider });
  assert.equal(first.first, true);
  assert.deepEqual(first.events, []);

  mrs = [mr({ has_conflicts: true })];
  const second = await pollOnce({ g, repo: 'a/b', cfg, file, makeProvider });
  assert.equal(second.first, false);
  assert.deepEqual(second.events.map((e) => e.kind), ['conflict']);
  assert.deepEqual(second.kept.map((e) => e.level), ['срочно']);
  rmSync(dir, { recursive: true, force: true });
});

test('stateFile: слеш в имени репозитория не создаёт вложенных каталогов', () => {
  assert.equal(path.basename(stateFile('a/b', '/tmp/x')), 'a%2Fb.json');
});

test('событие несёт sha: ключ идемпотентности собирается из снимка', () => {
  const events = diffSnapshots(snap([mr({ sha: 'aaa' })]), snap([mr({ sha: 'bbb', has_conflicts: true })]));
  assert.deepEqual(events.map((e) => [e.kind, e.sha]), [['conflict', 'bbb']]);
});

test('watch кладёт важные события в очередь и не плодит дубли на повторном опросе', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fs-harness-watch-'));
  const file = path.join(dir, 'state.json');
  const queueRoot = path.join(dir, 'queue');
  let mrs = [mr({ sha: 'aaa' })];
  const g = {
    listOpenMRs: async () => mrs.map((m) => ({ ...m })),
    listMRPipelines: async () => [],
    getDiscussions: async () => [],
  };
  const cfg = {
    activeProject: 'front',
    watch: { ttlSeconds: 3600 },
    judge: { enabled: false },
    telegram: { chat_id: '', bot_token: '' },
  };
  const ctx = { g, repo: 'a/b', cfg };

  await cmdWatch(ctx, { asObject: true, file, queueRoot });
  mrs = [mr({ sha: 'aaa', has_conflicts: true })];
  const second = await cmdWatch(ctx, { asObject: true, file, queueRoot });
  assert.deepEqual(second.queued, ['gitlab:conflict:mr1:aaa']);
  assert.equal(listJobs({ root: queueRoot })[0].action, 'conflict');

  // Тот же конфликт на том же коммите виден и следующим опросом, но задание уже есть.
  mrs = [mr({ sha: 'aaa' })];
  await cmdWatch(ctx, { asObject: true, file, queueRoot });
  mrs = [mr({ sha: 'aaa', has_conflicts: true })];
  const fourth = await cmdWatch(ctx, { asObject: true, file, queueRoot });
  assert.deepEqual(fourth.kept.map((e) => e.kind), ['conflict']);
  assert.deepEqual(fourth.queued, []);
  assert.equal(listJobs({ root: queueRoot }).length, 1);
  rmSync(dir, { recursive: true, force: true });
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
      return { events: [], kept: [], queued: [] };
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
  const cfgWithSecret = {
    projects: { front: {} },
    telegram: { chat_id: '1', bot_token: '' },
    judge: { roles: { 'event-triage': ['remote'] }, profiles: { remote: { provider: 'openai', secret: 'openrouter' } } },
  };
  const loadCfg = () => cfgWithSecret;
  await assert.rejects(
    cmdWatchDaemon({}, { env: {}, loadCfg, cycles: 1, log: () => {} }),
    (err) => err.code === 'secret_missing' && /FS_HARNESS_TELEGRAM/.test(err.message) && /FS_HARNESS_OPENROUTER/.test(err.message),
  );

  // Те же ключи в env — претензий нет.
  const env = { FS_HARNESS_TELEGRAM: 't', FS_HARNESS_OPENROUTER: 'k' };
  assert.deepEqual(daemonSecretIssues(cfgWithSecret, env), []);
  // Токен бота лежит в конфиге — keychain не при делах, env не требуется.
  assert.deepEqual(daemonSecretIssues({ telegram: { chat_id: '1', bot_token: 'x' } }, {}), []);
  assert.deepEqual(daemonKeychainJudges({ judge: { roles: { 'event-triage': ['opus-cli'] }, profiles: { 'opus-cli': { provider: 'cli' } } } }), ['opus-cli']);

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
  const cfg = { telegram: { chat_id: '1' }, judge: { roles: { 'event-triage': ['r'] }, profiles: { r: { secret: 'openrouter' } } } };
  const mac = serviceText(cfg, { platform: 'darwin', node: '/n', script: '/s/fsh.js', home: '/h', path: '/opt/homebrew/bin:/usr/bin' });
  assert.match(mac.file, /LaunchAgents\/com\.fitstars\.fs-harness\.watch\.plist$/);
  assert.match(mac.text, /<string>watch<\/string>\s*<string>--daemon<\/string>/);
  assert.match(mac.text, /FS_HARNESS_TELEGRAM/);
  assert.match(mac.text, /FS_HARNESS_OPENROUTER/);
  assert.match(mac.hint[0], /launchctl bootstrap/);
  // Без PATH launchd не найдёт glab: /usr/bin:/bin:/usr/sbin:/sbin — это всё, что он даёт.
  assert.match(mac.text, /<key>PATH<\/key><string>\/opt\/homebrew\/bin:\/usr\/bin<\/string>/);

  const linux = serviceText(cfg, { platform: 'linux', node: '/n', script: '/s/fsh.js', home: '/h', path: '/usr/local/bin' });
  assert.match(linux.text, /ExecStart=\/n \/s\/fsh\.js watch --daemon/);
  assert.match(linux.text, /Environment=PATH=\/usr\/local\/bin/);
  assert.match(linux.text, /Environment=FS_HARNESS_TELEGRAM=/);
});

test('diffSnapshots: отфильтровывает события автора=me и pipeline на своём sha', () => {
  const prev = snap([
    mr({ iid: 1, sha: 'my-sha-1', pipeline: { id: 1, status: 'running' } }),
    mr({ iid: 2, comments: { total: 1, open: 1, resolved: 0 }, author_username: 'my-user' }),
    mr({ iid: 3, comments: { total: 1, open: 1, resolved: 0 }, author_username: 'other-user' }),
  ]);
  const next = snap([
    mr({ iid: 1, sha: 'my-sha-1', pipeline: { id: 1, status: 'success' } }),
    mr({ iid: 2, comments: { total: 2, open: 2, resolved: 0 }, author_username: 'my-user' }),
    mr({ iid: 3, comments: { total: 2, open: 2, resolved: 0 }, author_username: 'other-user' }),
  ]);

  const events = diffSnapshots(prev, next, {
    meUsername: 'my-user',
    ignoredShas: ['my-sha-1'],
  });

  // Событие pipeline на ignoredSha отфильтровано
  assert.equal(events.some((e) => e.kind === 'pipeline' && e.mr === 1), false);
  // Событие threads от my-user отфильтровано
  assert.equal(events.some((e) => e.kind === 'threads' && e.mr === 2), false);
  // Событие threads от other-user осталось
  assert.equal(events.some((e) => e.kind === 'threads' && e.mr === 3), true);
});

test('демон: worker-цикл при workers.enabled: false не запускает воркер', async () => {
  let workerRan = false;
  const cfg = {
    projects: { front: {} },
    repo: 'org/front',
    watch: { enabled: true, intervalSeconds: 10 },
    workers: { enabled: false },
    judge: { roles: {}, profiles: {} },
    telegram: {},
  };
  await cmdWatchDaemon({}, {
    env: {},
    loadCfg: () => cfg,
    makeCtx: () => ({ cfg, repo: 'org/front' }),
    poll: async () => ({ events: [], kept: [], queued: [] }),
    sleep: async () => {},
    now: () => 0,
    cycles: 1,
    log: () => {},
    runWorkerImpl: async () => { workerRan = true; },
  });
  assert.equal(workerRan, false, 'воркер не запускался при workers.enabled: false');
});


