import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS, ACTIONS, findCommand, mcpTools, createCtx, withProject, withRepoHost } from '../src/registry.js';
import { ISOLATION_MODES, JUDGE_GATES } from '../src/engine.js';
import { DEFAULTS } from '../src/config.js';
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

test('registry: withProject — без repo/host понятная ошибка, с двумя проектами подсказывает -P', () => {
  const ctx = createCtx({ cfg: { repo: '', host: '' }, g: {}, notify: () => {} });
  assert.throws(
    () => withProject(ctx, () => 'не дойдёт'),
    (e) => e instanceof CliError && e.code === 'config_invalid' && /config show/.test(e.message),
  );
  assert.throws(
    () => withProject(createCtx({ cfg: { repo: '', host: '', activeProject: 'a', projects: { a: {}, b: {} } }, g: {}, notify: () => {} }), () => 'нет'),
    (e) => /-P a \| b/.test(e.message) && /"a"/.test(e.message),
  );
  assert.equal(withProject(createCtx({ cfg: { repo: 'r/r', host: 'h' }, g: {}, notify: () => {} }), () => 'ok'), 'ok');
  assert.equal(withRepoHost, withProject); // старое имя живо
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
    assert.ok(DEFAULTS.agents[a.agent.default], `agent.default "${a.agent.default}" не описан в DEFAULTS.agents у ${c.name}`);
    if (a.writes) {
      assert.equal(typeof a.publish, 'function', `writes:true без publish у ${c.name}`);
      assert.notEqual(a.judge.gate, 'none', `writes:true без гейта у ${c.name}`);
    }
    // run и mcp не пишутся руками — их даёт fromAction.
    assert.equal(typeof c.run, 'function', `run у ${c.name}`);
    assert.equal(typeof c.mcp.call, 'function', `mcp.call у ${c.name}`);
  }
});

// Заглушки под каждое действие: нового действия без них тест не пропустит.
const MR = { iid: 7, title: 'MR', web_url: 'https://example.invalid/7', source_branch: 's', target_branch: 't' };
const STUBS = {
  conflict: { pre: { conflictFiles: ['src/a.ts'] } },
  threads: { pre: { threads: [{ id: 'aaa1', file: 'src/a.ts', line: 3, notes: [{ author: 'rev', body: 'тут утечка' }] }] } },
  review: { pre: { projectDir: '/tmp/p', files: [{ path: 'src/a.ts', kind: 'изменён' }], diff: 'diff', rules: { source: 'встроенные', text: 'правила' } } },
  analyze: {
    target: { key: 'FD-1', fields: { summary: 'Починить', status: { name: 'Open' }, description: 'текст' } },
    pre: { projectDir: '/tmp/p', comments: [], url: 'https://j.invalid/browse/FD-1' },
  },
};

test('registry: у промпта действия есть шаблон, и он объявляет ровно те переменные, что даёт context', () => {
  for (const c of ACTIONS) {
    const tpl = loadTemplate(c.action.prompt);
    assert.ok(Array.isArray(tpl.meta.vars), `vars во front-matter у ${c.action.prompt}`);
    assert.deepEqual(checkTemplates().filter((p) => p.name === c.action.prompt && p.level === 'error'), []);

    const stub = STUBS[c.name];
    assert.ok(stub, `нет заглушки для действия ${c.name} — добавь её в STUBS`);
    const vars = c.action.context({
      ctx: { repo: 'r/repo' },
      opts: { agent: 'claude' },
      target: stub.target ?? MR,
      pre: stub.pre,
      ws: { dir: '/tmp/wt', deps: { available: true } },
      run: { id: 'run-1', dir: '/tmp/run-1' },
      say: () => {},
    });
    // Ровно те: лишняя переменная в шаблоне — prompt_var_missing в проде, лишняя в context — мусор.
    assert.deepEqual(Object.keys(vars).sort(), [...tpl.meta.vars].sort(), `${c.action.prompt}: vars ↔ context`);
  }
});
