import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import React from 'react';
import { App } from '../src/tui/app.js';

const tick = (ms = 250) => new Promise((r) => setTimeout(r, ms));

const ISSUE = {
  key: 'FD-1',
  names: { customfield_1: 'Ответственный разработчик', customfield_2: 'Technical details for QA', customfield_3: 'Sprint' },
  fields: {
    summary: 'Починить', status: { name: 'В работе' }, issuetype: { name: 'Task' }, updated: new Date().toISOString(),
    assignee: { displayName: 'Амир' }, reporter: { displayName: 'Эмиль' }, priority: { name: 'Medium' }, labels: ['Frontend'],
    parent: { key: 'FD-0', fields: { summary: 'Эпик' } }, issuelinks: [],
    description: 'что сломалось', customfield_1: [{ displayName: 'Амир' }], customfield_2: 'проверить чекаут',
    customfield_3: [{ id: 4, name: 'Спринт 18', state: 'active', boardId: 7 }],
  },
};

const ctx = {
  repo: 'group/app',
  cfg: { activeProject: 'app', agent: 'claude', projectDir: '/tmp' },
  agentArgs: () => [],
  g: {
    listOpenMRs: async () => [
      {
        iid: 2547, title: 'fix: баннер', source_branch: 'fix/banner', target_branch: 'dev', has_conflicts: true, sha: 'abc',
        user_notes_count: 2, author: { name: 'Амир Латипов' }, labels: ['review'],
        created_at: new Date(Date.now() - 2 * 86400e3).toISOString(), updated_at: new Date().toISOString(),
        web_url: 'https://example.invalid/2547',
      },
    ],
    listMRPipelines: async () => [{ id: 7, ref: 'refs/merge-requests/2547/head', status: 'success', sha: 'abc' }],
    getDiscussions: async () => [
      { id: 'd1', resolvable: true, resolved: false, notes: [{ id: 1, resolvable: true, resolved: false, system: false, body: 'тут дыра' }] },
    ],
    getApprovals: async () => ({ approved: true, approved_by: [{ user: { name: 'Эмиль' } }] }),
    getJobs: async () => [
      { id: 11, name: 'build_image', stage: 'build', status: 'manual' },
      { id: 12, name: 'deploy_dev', stage: 'deploy_dev', status: 'manual' },
    ],
  },
  jira: () => ({
    searchJql: async () => ({ issues: [{ key: 'FD-1', fields: { summary: 'Починить', status: { name: 'В работе' }, updated: new Date().toISOString() } }] }),
    issue: async () => ISSUE,
    comments: async () => ({ comments: [{ author: { displayName: 'Эмиль' }, created: new Date().toISOString(), body: 'посмотри' }] }),
  }),
};

// Один рендер-тест на весь экран: htm-шаблоны иначе ломаются только у живого человека.
test('TUI: рисует MR, переключает вкладку и показывает помощь', async () => {
  const app = render(React.createElement(App, { ctx, opts: {} }));
  try {
    await tick();
    const first = app.lastFrame();
    assert.match(first, /fs-harness · app/);
    assert.match(first, /\[1\] MR/);
    // Строка MR двухэтажная, как в GitLab: заголовок с бейджами, под ним номер и автор.
    assert.match(first, /fix: баннер/);
    assert.match(first, /✅Approved/);
    assert.match(first, /💬0 of 1/);
    assert.match(first, /⚠конфликт/);
    assert.match(first, /!2547 · создан 2 дн назад · Амир/);
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

    app.stdin.write('f'); // фильтры списка MR
    await tick(150);
    assert.match(app.lastFrame(), /Фильтры списка MR/);
    assert.match(app.lastFrame(), /Только с конфликтом/);
    app.stdin.write('\u001B');
    await tick(150);

    app.stdin.write('2');
    await tick();
    const issues = app.lastFrame();
    assert.match(issues, /FD-1 · В работе · Починить/); // статус между ключом и названием
    assert.match(issues, /n проанализировать задачу/);
    assert.match(issues, /Assignee: Амир · Reporter: Эмиль/);
    assert.match(issues, /Ответственный разработчик: Амир/);
    assert.match(issues, /Sprint: Спринт 18 \(active\)/);
    assert.doesNotMatch(issues, /проверить чекаут/); // блок свёрнут

    app.stdin.write('e'); // раскрыть длинные поля
    await tick(150);
    assert.match(app.lastFrame(), /проверить чекаут/);

    app.stdin.write('c'); // комментарий: поле ввода вместо списка
    await tick(150);
    assert.match(app.lastFrame(), /FD-1: комментарий/);
    assert.match(app.lastFrame(), /Enter — опубликовать в Jira/);
    app.stdin.write('\u001B');
    await tick(150);

    app.stdin.write('?');
    await tick(150);
    assert.match(app.lastFrame(), /Клавиши/);
    assert.match(app.lastFrame(), /events\.jsonl/);
    assert.doesNotMatch(app.lastFrame(), /&lt;/); // htm не должен оставлять сущностей
  } finally {
    app.unmount();
  }
});
