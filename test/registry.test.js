import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS, findCommand, mcpTools, createCtx, withRepoHost } from '../src/registry.js';
import { buildAgentGuide } from '../src/commands/agent-guide.js';
import { CliError } from '../src/errors.js';

test('registry: у каждой команды есть имя, usage, описание и run', () => {
  for (const c of COMMANDS) {
    assert.ok(c.name, 'имя');
    assert.ok(c.usage, `usage у ${c.name}`);
    assert.ok(c.description, `description у ${c.name}`);
    assert.ok(c.example, `example у ${c.name}`);
    assert.equal(typeof c.run, 'function', `run у ${c.name}`);
  }
});

test('registry: имена уникальны', () => {
  const names = COMMANDS.map((c) => c.name);
  assert.equal(new Set(names).size, names.length);
});

test('registry: mcp-записи валидны (description, inputSchema, call)', () => {
  for (const c of COMMANDS.filter((x) => x.mcp)) {
    assert.ok(c.mcp.description, `mcp.description у ${c.name}`);
    assert.equal(c.mcp.inputSchema.type, 'object', `mcp.inputSchema у ${c.name}`);
    assert.equal(typeof c.mcp.call, 'function', `mcp.call у ${c.name}`);
  }
});

test('registry: mcpTools отдаёт только инструменты с mcp', () => {
  const ctx = createCtx({ cfg: { repo: 'r', agentArgs: {} }, g: {}, notify: () => {} });
  const tools = mcpTools(ctx);
  assert.equal(tools.length, COMMANDS.filter((c) => c.mcp).length);
  for (const t of tools) assert.equal(typeof t.handler, 'function');
});

test('registry: agent-guide содержит все команды', () => {
  const guide = buildAgentGuide(COMMANDS);
  for (const c of COMMANDS.filter((x) => x.name !== 'mcp')) {
    assert.ok(guide.includes(`fsh ${c.usage}`), `guide содержит ${c.name}`);
  }
});

test('registry: findCommand находит и отдаёт null для неизвестной', () => {
  assert.equal(findCommand('deploy').name, 'deploy');
  assert.equal(findCommand('nope'), null);
});

test('registry: withRepoHost — без repo/host понятная ошибка', () => {
  const ctx = createCtx({ cfg: { repo: '', host: '' }, g: {}, notify: () => {} });
  assert.throws(
    () => withRepoHost(ctx, () => 'не дойдёт'),
    (e) => e instanceof CliError && e.code === 'config_invalid' && /config init/.test(e.message),
  );
  assert.equal(withRepoHost(createCtx({ cfg: { repo: 'r/r', host: 'h' }, g: {}, notify: () => {} }), () => 'ok'), 'ok');
});
