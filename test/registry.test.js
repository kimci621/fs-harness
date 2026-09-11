import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS, ACTIONS, findCommand, mcpTools, createCtx, withRepoHost } from '../src/registry.js';
import { ISOLATION_MODES, JUDGE_GATES } from '../src/engine.js';
import { loadTemplate, checkTemplates } from '../src/prompts.js';
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

test('registry: декларации действий валидны и синтезируют run/mcp', () => {
  assert.ok(ACTIONS.length, 'хотя бы одно действие');
  for (const c of ACTIONS) {
    const a = c.action;
    assert.ok(a.prompt, `action.prompt у ${c.name}`);
    assert.ok(ISOLATION_MODES.includes(a.isolation), `isolation у ${c.name}: ${a.isolation}`);
    assert.ok(JUDGE_GATES.includes(a.judge.gate), `judge.gate у ${c.name}: ${a.judge.gate}`);
    assert.equal(typeof a.context, 'function', `context у ${c.name}`);
    assert.equal(typeof a.verify, 'function', `verify у ${c.name}`);
    assert.ok(a.agent.allow.includes(a.agent.default), `agent.default вне allow у ${c.name}`);
    if (a.writes) {
      assert.equal(typeof a.publish, 'function', `writes:true без publish у ${c.name}`);
      assert.notEqual(a.judge.gate, 'none', `writes:true без гейта у ${c.name}`);
    }
    // run и mcp не пишутся руками — их даёт fromAction.
    assert.equal(typeof c.run, 'function', `run у ${c.name}`);
    assert.equal(typeof c.mcp.call, 'function', `mcp.call у ${c.name}`);
  }
});

test('registry: у промпта действия есть шаблон, и он объявляет ровно те переменные, что даёт context', () => {
  for (const c of ACTIONS) {
    const tpl = loadTemplate(c.action.prompt);
    assert.ok(Array.isArray(tpl.meta.vars), `vars во front-matter у ${c.action.prompt}`);
    assert.deepEqual(checkTemplates().filter((p) => p.name === c.action.prompt && p.level === 'error'), []);
  }
});
