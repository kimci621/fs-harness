import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import React from 'react';
import { App } from '../src/tui/app.js';

const tick = (ms = 250) => new Promise((r) => setTimeout(r, ms));

const ctx = {
  repo: 'group/app',
  cfg: { activeProject: 'app', agent: 'claude', projectDir: '/tmp' },
  agentArgs: () => [],
  g: {
    listOpenMRs: async () => [
      { iid: 2547, title: 'fix: баннер', source_branch: 'fix/banner', target_branch: 'dev', has_conflicts: true, sha: 'abc', user_notes_count: 2, updated_at: new Date().toISOString(), web_url: 'https://example.invalid/2547' },
    ],
    listMRPipelines: async () => [{ id: 7, ref: 'refs/merge-requests/2547/head', status: 'success', sha: 'abc' }],
    getDiscussions: async () => [
      { id: 'd1', resolvable: true, resolved: false, notes: [{ id: 1, resolvable: true, resolved: false, system: false, body: 'тут дыра' }] },
    ],
    getJobs: async () => [
      { id: 11, name: 'build_image', stage: 'build', status: 'manual' },
      { id: 12, name: 'deploy_dev', stage: 'deploy_dev', status: 'manual' },
    ],
  },
  jira: () => ({ searchJql: async () => ({ issues: [{ key: 'FD-1', fields: { summary: 'Починить', status: { name: 'Open' }, updated: new Date().toISOString() } }] }) }),
};

// Один рендер-тест на весь экран: htm-шаблоны иначе ломаются только у живого человека.
test('TUI: рисует MR, переключает вкладку и показывает помощь', async () => {
  const app = render(React.createElement(App, { ctx, opts: {} }));
  try {
    await tick();
    const first = app.lastFrame();
    assert.match(first, /fs-harness · app/);
    assert.match(first, /\[1\] MR/);
    assert.match(first, /!2547 ⚠ 💬1/); // конфликт и открытый тред видно прямо в строке
    assert.match(first, /fix: баннер/);
    assert.match(first, /fix\/banner → dev/);
    assert.match(first, /лог пуст/);

    app.stdin.write('p'); // панель пайплайна: те же джобы, что показывает GitLab
    await tick(150);
    assert.match(app.lastFrame(), /пайплайн #7/);
    assert.match(app.lastFrame(), /build\s+build_image/);
    assert.match(app.lastFrame(), /deploy_dev\s+deploy_dev/);
    app.stdin.write('\u001B'); // Esc закрывает панель
    await tick(150);
    assert.doesNotMatch(app.lastFrame(), /Enter — запустить/);

    app.stdin.write('2');
    await tick();
    assert.match(app.lastFrame(), /FD-1 Починить/);
    assert.match(app.lastFrame(), /n разбор/);

    app.stdin.write('?');
    await tick(150);
    assert.match(app.lastFrame(), /Клавиши/);
    assert.match(app.lastFrame(), /events\.jsonl/);
    assert.doesNotMatch(app.lastFrame(), /&lt;/); // htm не должен оставлять сущностей
  } finally {
    app.unmount();
  }
});
