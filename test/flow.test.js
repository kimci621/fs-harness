import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listFlows, cmdFlow } from '../src/commands/flow.js';
import { buildAgentGuide } from '../src/commands/agent-guide.js';
import { COMMANDS } from '../src/registry.js';

test('flows: сценарии на месте и с описаниями', () => {
  const flows = listFlows();
  assert.deepEqual(flows.map((f) => f.name).sort(), ['fill-jira', 'push-task', 'take-task']);
  for (const f of flows) assert.ok(f.description, `у сценария ${f.name} нет description во front-matter`);
});

// Главный тест шага: протокол, зовущий несуществующую команду, отправит агента в стену.
test('flows: каждая упомянутая команда fsh есть в реестре', () => {
  const names = new Set(COMMANDS.map((c) => c.name));
  for (const flow of listFlows()) {
    const used = [...flow.body.matchAll(/^\s*fsh ([a-z-]+)/gm)].map((m) => m[1]);
    assert.ok(used.length, `в сценарии ${flow.name} нет ни одной команды fsh`);
    for (const cmd of new Set(used)) {
      assert.ok(names.has(cmd), `сценарий ${flow.name} зовёт "fsh ${cmd}", а такой команды в реестре нет`);
    }
  }
});

test('flow show: текст протокола, неизвестное имя — usage со списком', () => {
  const res = cmdFlow(['show', 'take-task'], { asObject: true });
  assert.match(res.body, /# Сценарий: взять задачу в работу/);
  assert.throws(() => cmdFlow(['show', 'нет-такого'], { asObject: true }), (e) => e.code === 'usage' && /take-task/.test(e.message));
  assert.throws(() => cmdFlow(['run'], { asObject: true }), (e) => e.code === 'usage');
  assert.deepEqual(cmdFlow(['list'], { asObject: true }).flows.map((f) => f.name).sort(), ['fill-jira', 'push-task', 'take-task']);
});

test('agent-guide: сценарии попадают в гайд', () => {
  const guide = buildAgentGuide(COMMANDS);
  assert.match(guide, /## Сценарии/);
  assert.match(guide, /fsh flow show take-task/);
  assert.doesNotMatch(guide, /\{\{FLOWS\}\}/);
});
