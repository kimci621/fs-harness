import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_HELP } from '../src/commands/agent-guide.js';
import { COMMANDS } from '../src/registry.js';
import { matchFlow } from '../src/commands/flow.js';

const HIDDEN = ['bot', 'qa-bot', 'up', 'watch', 'worker', 'queue', 'tui', 'mcp', 'auto', 'prompts', 'worktrees', 'retry', 'resume', 'revise'];

test('help под Claude Code: короткая, без выравнивания, только живые команды', () => {
  const lines = AGENT_HELP.trim().split('\n');
  assert.ok(lines.length >= 25 && lines.length <= 40, `строк ${lines.length}`);
  assert.equal(/ {3,}/.test(AGENT_HELP), false, 'выравнивающие пробелы');
  const used = [...AGENT_HELP.matchAll(/fsh ([a-z-]+)/g)].map((m) => m[1]);
  const names = new Set([...COMMANDS.map((c) => c.name), 'help']);
  for (const name of used) assert.ok(names.has(name), `нет команды fsh ${name}`);
  for (const name of HIDDEN) assert.equal(used.includes(name), false, `скрытая команда fsh ${name}`);
  // Пишущие примеры — с -y, иначе вне Claude Code агент упрётся в подтверждение.
  for (const l of lines.filter((x) => / (move|comment|parent|create|post|reply|review|push|submit|toggle) /.test(x) && x.startsWith('fsh '))) {
    assert.match(l, / -y\b/, l);
  }
});

const FLOWS = [
  { name: 'take-task', description: 'Взять задачу Jira в работу — ветка, разбор, план, реализация, приёмка' },
  { name: 'push-task', description: 'Запушить задачу и открыть MR в целевую ветку' },
  { name: 'fill-jira', description: 'Заполнить обязательные поля задачи — Technical details for QA и Контент' },
  { name: 'review-mr', description: 'Сделать ревью чужого MR по ссылке на пост в Mattermost' },
];

test('flow show: по имени, по русскому названию, промах — ближайшие', () => {
  assert.equal(matchFlow(FLOWS, 'take-task').flow.name, 'take-task');
  assert.equal(matchFlow(FLOWS, 'взять задачу').flow.name, 'take-task');
  assert.equal(matchFlow(FLOWS, 'запушить').flow.name, 'push-task');
  assert.equal(matchFlow(FLOWS, 'заполнить поля').flow.name, 'fill-jira');
  const miss = matchFlow(FLOWS, 'задача');
  assert.equal(miss.flow, null);
  assert.ok(miss.near.includes('take-task') && miss.near.includes('push-task'));
  assert.deepEqual(matchFlow(FLOWS, 'деплой').near, []);
});
