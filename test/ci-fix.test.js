import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ciFixAction,
  attemptGate,
  attemptKey,
  recordAttempt,
  readAttempts,
  writeAttempts,
  summarizeTrace,
} from '../src/actions/ci-fix.js';
import { CliError } from '../src/errors.js';

const a = ciFixAction.action;

// Лог джобы как его отдаёт GitLab: ANSI, \r, секции.
const TRACE = [
  'section_start:1700000000:step_script\r\x1b[0K\x1b[32;1m$ npm run lint\x1b[0;m',
  'Running lint…',
  ...Array.from({ length: 200 }, (_, i) => `noise ${i}`),
  '/app/src/foo.ts',
  '  12:5  error  Unexpected any  @typescript-eslint/no-explicit-any',
  '\x1b[31m✖ 1 problem (1 error, 0 warnings)\x1b[0m',
  'section_end:1700000042:step_script\r\x1b[0K',
].join('\n');

test('summarizeTrace: снимает ANSI и секции, отдаёт хвост и строки с ошибками', () => {
  const s = summarizeTrace(TRACE, { tailLines: 5 });
  assert.doesNotMatch(s.tail, /\x1b|section_(start|end):/);
  assert.match(s.errors, /Unexpected any/);
  assert.match(s.errors, /✖ 1 problem/);
  assert.equal(s.tail.split('\n').length, 5);
  assert.ok(s.lines > 200);
});

test('summarizeTrace: пустой лог не роняет', () => {
  assert.deepEqual(summarizeTrace(null), { lines: 0, errors: '', tail: '' });
});

test('attemptGate: первая попытка проходит, лимит останавливает', () => {
  const key = attemptKey(42, ['test', 'lint']);
  assert.equal(key, '42:lint,test'); // порядок джоб не должен плодить ключи
  let state = {};
  assert.equal(attemptGate(state, key, 'sha1', 2).allow, true);

  state = recordAttempt(state, key, 'sha1');
  const second = attemptGate(state, key, 'sha2', 2);
  assert.equal(second.allow, true, 'после первой попытки на новом sha можно ещё раз');

  state = recordAttempt(state, key, 'sha2');
  const third = attemptGate(state, key, 'sha3', 2);
  assert.equal(third.allow, false);
  assert.match(third.reason, /лимит попыток \(2 из 2\)/);
});

test('attemptGate: тот же sha второй раз — стоп сразу, лимит не ждём', () => {
  const key = attemptKey(7, ['test']);
  const state = recordAttempt({}, key, 'sha1');
  const gate = attemptGate(state, key, 'sha1', 5);
  assert.equal(gate.allow, false);
  assert.match(gate.reason, /уже чинили/);
});

test('attempts: файл переживает запись и чтение, битый равен пустому', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fs-harness-cifix-'));
  try {
    const file = path.join(dir, 'sub', 'repo.json');
    assert.deepEqual(readAttempts(file), {});
    writeAttempts(file, recordAttempt({}, '1:lint', 'sha1'));
    assert.equal(readAttempts(file)['1:lint'].attempts, 1);
    assert.deepEqual(readAttempts(file)['1:lint'].shas, ['sha1']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Общий контекст precheck: g с нужными ответами, MR автора a.latipov.
function fixture({ jobs = [], head_pipeline = { id: 9, sha: 'sha1', status: 'failed', web_url: 'u' }, me = 'a.latipov', attemptsFile } = {}) {
  const mr = { iid: 42, title: 'фикс', web_url: 'u', source_branch: 'feature/x', target_branch: 'dev', sha: 'sha1', author: { username: 'a.latipov' }, head_pipeline };
  const g = {
    me: async () => ({ username: me }),
    getJobs: async () => jobs,
    getJobTrace: async () => TRACE,
  };
  return {
    ctx: { g, repo: 'r/repo' },
    opts: { projectDir: process.cwd(), cfg: { ci: { maxRetries: 2 } }, attemptsFile },
    target: mr,
    say: () => {},
  };
}

test('precheck: чужой MR не чиним', async () => {
  const x = fixture({ me: 'someone.else' });
  await assert.rejects(() => a.precheck(x), (e) => e instanceof CliError && e.code === 'not_author');
});

test('precheck: нет пайплайна или нет упавших джоб — skip', async () => {
  const noPipe = await a.precheck(fixture({ head_pipeline: null }));
  assert.equal(noPipe.skip, true);

  const green = await a.precheck(fixture({ jobs: [{ id: 1, name: 'lint', status: 'success' }] }));
  assert.equal(green.skip, true);

  const allowed = await a.precheck(fixture({ jobs: [{ id: 1, name: 'flaky', status: 'failed', allow_failure: true }] }));
  assert.equal(allowed.skip, true, 'allow_failure не считается падением');
});

test('precheck: устаревший пайплайн — skip, он про прошлый коммит', async () => {
  const x = fixture({
    jobs: [{ id: 5, name: 'lint', status: 'failed' }],
    head_pipeline: { id: 9, sha: 'старый', status: 'failed', web_url: 'u' },
  });
  const pre = await a.precheck(x);
  assert.equal(pre.skip, true);
  assert.match(pre.reason, /устарел/);
});

test('precheck: упавшая джоба — работаем, логи собраны', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fs-harness-cifix-'));
  try {
    const file = path.join(dir, 'repo.json');
    const pre = await a.precheck(fixture({ jobs: [{ id: 5, name: 'lint', stage: 'test', status: 'failed', web_url: 'j' }], attemptsFile: file }));
    assert.ok(!pre.skip);
    assert.equal(pre.failed.length, 1);
    assert.match(pre.failed[0].errors, /Unexpected any/);
    assert.equal(pre.attempts.key, '42:lint');
    assert.equal(pre.meta.attempt, 1);
    assert.deepEqual(pre.workspace.refs, ['feature/x', 'dev'], 'target нужен для диффа ветки');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('precheck: исчерпанный лимит — skip с hand_to_human, а не новый заход агента', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fs-harness-cifix-'));
  try {
    const file = path.join(dir, 'repo.json');
    writeAttempts(file, recordAttempt(recordAttempt({}, '42:lint', 'sha0'), '42:lint', 'sha1'));
    const pre = await a.precheck(fixture({ jobs: [{ id: 5, name: 'lint', stage: 'test', status: 'failed' }], attemptsFile: file }));
    assert.equal(pre.skip, true);
    assert.equal(pre.result.hand_to_human, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('context: без зависимостей фикс не судим — падаем до агента', () => {
  const x = {
    ...fixture(),
    ws: { dir: '/tmp/wt', deps: { available: false, strategy: 'clone', reason: 'lock разошёлся' }, git: () => '' },
    pre: { attempts: { file: '/tmp/nope.json', key: '42:lint', sha: 'sha1', max: 2, done: 0 }, pipeline: { id: 9 }, failed: [] },
    run: { id: 'r1' },
  };
  assert.throws(() => a.context(x), (e) => e instanceof CliError && e.code === 'deps_unavailable');
});

test('verify: без коммитов агента чинить нечего', () => {
  const git = (args) => (args[0] === 'rev-list' ? '0' : '');
  assert.throws(
    () => a.verify({ ws: { git, dir: '/tmp/wt', base: 'origin/x', deps: { available: true } }, pre: { failed: [], attempts: { done: 0, max: 2 } }, opts: { cfg: { checks: [] } }, say: () => {} }),
    (e) => e instanceof CliError && e.code === 'agent_failed',
  );
});

test('декларация: пишущее действие с гейтом судьи и своей ролью', () => {
  assert.equal(a.writes, true);
  assert.equal(a.judge.gate, 'pre-push');
  assert.equal(a.judge.role, 'ci-acceptance');
  assert.equal(typeof a.publish, 'function');
});
