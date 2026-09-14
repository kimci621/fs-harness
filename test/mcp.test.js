import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleMessage, createMCPContext } from '../src/mcp.js';
import { CliError } from '../src/errors.js';

const FAKE_MR = {
  iid: 2547, title: 'T', draft: false, source_branch: 'feature/FD-7230', target_branch: 'dev',
  has_conflicts: false, user_notes_count: 0, head_pipeline: null, sha: 'abc',
  updated_at: '2026-08-14T10:00:00Z', web_url: 'https://x/y/-/merge_requests/2547',
};

function fakeCtx() {
  const g = {
    listOpenMRs: async () => [],
    getMR: async () => FAKE_MR,
    getDiscussions: async () => [],
  };
  const cfg = {
    repo: 'fitstars/fitstars-nuxt',
    host: 'fitstars.gitlab.yandexcloud.net',
    projectDir: '~/Projects/fitstars-frontend',
    agent: 'claude',
    agentArgs: { claude: [], pi: [] },
  };
  return createMCPContext({ cfg, g, notify: () => {} });
}

test('mcp: initialize — протокол, capabilities, serverInfo', async () => {
  const ctx = fakeCtx();
  const r = await handleMessage('initialize', { protocolVersion: '2025-06-18' }, ctx);
  assert.equal(r.protocolVersion, '2025-06-18');
  assert.ok(r.capabilities.tools);
  assert.equal(r.serverInfo.name, 'fs-harness');
});

test('mcp: initialize с неизвестной версией → 2024-11-05', async () => {
  const ctx = fakeCtx();
  const r = await handleMessage('initialize', { protocolVersion: '2099-01-01' }, ctx);
  assert.equal(r.protocolVersion, '2024-11-05');
});

test('mcp: tools/list — все инструменты с inputSchema', async () => {
  const ctx = fakeCtx();
  const r = await handleMessage('tools/list', {}, ctx);
  const names = r.tools.map((t) => t.name);
  assert.deepEqual(names, ['mrs', 'mr', 'mr-comments', 'jobs', 'run', 'deploy', 'conflict', 'threads', 'review', 'analyze', 'jira', 'task', 'growthbook', 'commit', 'flow', 'doctor', 'agent-guide']);
  for (const t of r.tools) assert.equal(t.inputSchema.type, 'object');
});

test('mcp: tools/call mr — структурированный результат', async () => {
  const ctx = fakeCtx();
  const r = await handleMessage('tools/call', { name: 'mr', arguments: { query: '2547' } }, ctx);
  assert.equal(r.isError, undefined);
  const data = JSON.parse(r.content[0].text);
  assert.equal(data.ok, true);
  assert.equal(data.iid, 2547);
  assert.equal(data.source_branch, 'feature/FD-7230');
});

test('mcp: tools/call с ошибкой → isError и {ok:false,error}', async () => {
  const ctx = fakeCtx();
  ctx.tools.push({
    name: 'broken',
    description: 't',
    inputSchema: { type: 'object', properties: {} },
    handler: () => { throw new CliError('сломалось', 1, 'test_fail'); },
  });
  const r = await handleMessage('tools/call', { name: 'broken', arguments: {} }, ctx);
  assert.equal(r.isError, true);
  const data = JSON.parse(r.content[0].text);
  assert.deepEqual(data, { ok: false, error: { code: 'test_fail', message: 'сломалось' } });
});

test('mcp: неизвестный инструмент/метод → ошибка', async () => {
  const ctx = fakeCtx();
  await assert.rejects(() => handleMessage('tools/call', { name: 'nope' }, ctx), /неизвестный инструмент/);
  await assert.rejects(() => handleMessage('whatever', {}, ctx), /неизвестный метод/);
});

test('mcp: ping', async () => {
  assert.deepEqual(await handleMessage('ping', {}, fakeCtx()), {});
});
