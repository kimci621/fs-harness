import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import React from 'react';
import { App } from '../src/tui/app.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

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
  g: {
    listOpenMRs: async () => [
      {
        iid: 2547, title: 'fix: баннер', source_branch: 'fix/banner', target_branch: 'dev', has_conflicts: true, sha: 'abc',
        user_notes_count: 2, author: { name: 'Амир Латипов', username: 'amir' }, labels: ['review'], reviewers: [], assignees: [],
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
    app.stdin.write('\r'); // значение автора выбирается из списка, а не печатается
    await tick(150);
    assert.match(app.lastFrame(), /Фильтр: Автор/);
    assert.match(app.lastFrame(), /— любой/);
    assert.match(app.lastFrame(), /Амир Латипов/);
    app.stdin.write('\u001B'); // назад к списку полей
    await tick(150);
    assert.match(app.lastFrame(), /Фильтры списка MR/);
    app.stdin.write('\u001B');
    await tick(150);

    app.stdin.write('/'); // поиск по списку: с опечаткой и со счётчиком найденного
    await tick(100);
    for (const ch of 'банер') { app.stdin.write(ch); await tick(30); }
    await tick(150);
    assert.match(app.lastFrame(), /\/ банер/);
    assert.match(app.lastFrame(), /1 из 1/);
    assert.match(app.lastFrame(), /fix: баннер/);
    app.stdin.write('\u001B');
    await tick(100);

    app.stdin.write('2');
    await tick();
    const issues = app.lastFrame();
    assert.match(issues, /FD-1 · В работе · нету/); // ключ, статус и исполнитель первой строкой
    assert.match(issues, /│\s+Починить/); // название отдельной строкой под ключом
    assert.match(issues, /─{10}/); // бледная линия между строками списка
    assert.match(issues, /n проанализировать · s статус/);
    assert.match(issues, /Assignee {2}Амир/);
    assert.match(issues, /Ответственный разработчик {2}Амир/);
    assert.match(issues, /Sprint {4}Спринт 18 \(active\)/);
    assert.doesNotMatch(issues, /проверить чекаут/); // блок свёрнут

    app.stdin.write('e'); // раскрыть длинные поля
    await tick(150);
    assert.match(app.lastFrame(), /▾ Описание/);
    app.stdin.write('\t'); // фокус на карточку и прокрутка до нижних блоков
    for (let i = 0; i < 12; i++) { app.stdin.write('j'); await tick(10); }
    await tick(100);
    assert.match(app.lastFrame(), /проверить чекаут/);
    app.stdin.write('\t');
    await tick(50);

    app.stdin.write('c'); // комментарий: поле ввода вместо списка
    await tick(150);
    assert.match(app.lastFrame(), /FD-1: комментарий/);
    assert.match(app.lastFrame(), /Enter — опубликовать в Jira/);
    app.stdin.write('\u001B');
    await tick(150);

    app.stdin.write('4'); // промпты: список встроенных шаблонов и текст выбранного
    await tick(200);
    assert.match(app.lastFrame(), /actions\/analyze/);
    assert.match(app.lastFrame(), /источник {2}встроенный/);
    assert.match(app.lastFrame(), /e сделать свой/);

    app.stdin.write('?');
    await tick(150);
    assert.match(app.lastFrame(), /Клавиши/);
    assert.match(app.lastFrame(), /events\.jsonl/);
    assert.doesNotMatch(app.lastFrame(), /&lt;/); // htm не должен оставлять сущностей
  } finally {
    app.unmount();
  }
});

// Медленный GitLab: пока запрос идёт, экран обязан сказать, чем он занят.
test('TUI: видно, что именно грузится, и панель открывается сразу', async () => {
  const slow = (value, ms) => () => new Promise((r) => setTimeout(() => r(value), ms));
  const ctxSlow = {
    ...ctx,
    g: { ...ctx.g, listOpenMRs: slow(await ctx.g.listOpenMRs(), 600), getJobs: slow(await ctx.g.getJobs(), 600) },
  };
  const app = render(React.createElement(App, { ctx: ctxSlow, opts: {} }));
  try {
    await tick(150);
    assert.match(app.lastFrame(), /список MR/); // подпись занятости в шапке
    assert.match(app.lastFrame(), /загружаю…/);
    await tick(1200);
    assert.doesNotMatch(app.lastFrame(), /список MR…/);

    app.stdin.write('p'); // панель пайплайна открывается до того, как приедут джобы
    await tick(150);
    assert.match(app.lastFrame(), /загружаю джобы…/);
    assert.match(app.lastFrame(), /джобы пайплайна/);
    await tick(1200);
    assert.match(app.lastFrame(), /build_image/);
    assert.doesNotMatch(app.lastFrame(), /загружаю джобы/);
  } finally {
    app.unmount();
  }
});

// Узкое окно: две колонки по 38 знаков нечитаемы, поэтому остаётся одна.
test('TUI: на узком терминале колонка одна и Tab переключает список ↔ карточку', async () => {
  const app = render(React.createElement(App, { ctx, opts: {} }));
  try {
    await tick(400);
    assert.match(app.lastFrame(), /!2547 fix: баннер/); // широко: список и карточка рядом
    const resize = (columns, rows) => {
      Object.defineProperty(app.stdout, 'columns', { value: columns, configurable: true });
      Object.defineProperty(app.stdout, 'rows', { value: rows, configurable: true });
      app.stdout.emit('resize');
    };
    resize(76, 24);
    await tick(200);
    assert.match(app.lastFrame(), /fix: баннер/);
    assert.doesNotMatch(app.lastFrame(), /ветка {3}fix\/banner/); // карточки не видно

    app.stdin.write('\t');
    await tick(200);
    assert.match(app.lastFrame(), /ветка {3}fix\/banner → dev/);
    assert.doesNotMatch(app.lastFrame(), /!2547 · создан/); // теперь спрятан список
  } finally {
    app.unmount();
  }
});

// Правка поля задачи: список полей из editmeta, значения из allowedValues или из людей проекта.
test('TUI: E правит поле задачи — выбор поля, выбор значения, один PUT', async () => {
  // Вместо vim — крошечный sh-скрипт: это настоящий внешний редактор, только быстрый.
  const fake = path.join(mkdtempSync(path.join(tmpdir(), 'fsh-test-')), 'editor.sh');
  writeFileSync(fake, "printf '\\nи ещё строка' >> \"$1\"\n");
  process.env.EDITOR = `/bin/sh ${fake}`;
  const puts = [];
  const ctxEdit = {
    ...ctx,
    jira: () => ({
      ...ctx.jira(),
      editMeta: async () => ({
        fields: {
          assignee: { name: 'Assignee', schema: { type: 'user' } },
          priority: { name: 'Priority', schema: { type: 'priority' }, allowedValues: [{ id: '2', name: 'High' }, { id: '3', name: 'Medium' }] },
          labels: { name: 'Labels', schema: { type: 'array', items: 'string' } }, // Jira не перечисляет — вводим руками
          summary: { name: 'Summary', schema: { type: 'string' } },
          description: { name: 'Description', schema: { type: 'string', system: 'description' } }, // многострочное — уходит в $EDITOR
          attachment: { name: 'Attachment', schema: { type: 'array', items: 'attachment' } }, // заполнить нечем — не показываем
        },
      }),
      assignableUsers: async () => [{ accountId: 'a1', displayName: 'Амир' }, { accountId: 'a2', displayName: 'Эмиль' }],
      updateIssue: async (key, fields) => { puts.push({ key, fields }); return null; },
    }),
  };
  const app = render(React.createElement(App, { ctx: ctxEdit, opts: {} }));
  try {
    await tick(300);
    app.stdin.write('2');
    await tick(300);
    app.stdin.write('E');
    await tick(200);
    assert.match(app.lastFrame(), /FD-1: изменить поле/);
    assert.match(app.lastFrame(), /Assignee/);
    assert.match(app.lastFrame(), /Priority/);
    assert.match(app.lastFrame(), /Summary/); // обычный текст тоже правится
    assert.doesNotMatch(app.lastFrame(), /Attachment/); // а вот вложение заполнить нечем

    app.stdin.write('\r'); // Assignee → люди проекта
    await tick(250);
    assert.match(app.lastFrame(), /FD-1 · Assignee/);
    assert.match(app.lastFrame(), /— очистить/);
    assert.match(app.lastFrame(), /Эмиль/);

    app.stdin.write('j'); await tick(60);
    app.stdin.write('j'); await tick(60); // «— очистить» → Амир → Эмиль
    app.stdin.write('\r');
    await tick(300);
    assert.deepEqual(puts, [{ key: 'FD-1', fields: { assignee: { accountId: 'a2' } } }]);
    assert.match(app.lastFrame(), /Assignee: Эмиль/); // видно в логе

    app.stdin.write('E'); // Labels: список строк, его набирают через запятую
    await tick(250);
    app.stdin.write('j'); await tick(60);
    app.stdin.write('j'); await tick(60);
    app.stdin.write('j'); await tick(60); // Assignee → Priority → Description → Labels
    assert.match(app.lastFrame(), /Labels/);
    app.stdin.write('\r');
    await tick(200);
    assert.match(app.lastFrame(), /через запятую/);
    assert.match(app.lastFrame(), /Frontend/); // текущее значение подставлено, а не пустое поле
    for (const ch of ', ui') { app.stdin.write(ch); await tick(25); }
    app.stdin.write('\r');
    await tick(300);
    assert.deepEqual(puts[1], { key: 'FD-1', fields: { labels: ['Frontend', 'ui'] } });

    // Описание многострочное, поэтому уходит в $EDITOR: TUI отпускает ввод и ждёт его.
    app.stdin.write('E');
    await tick(250);
    app.stdin.write('j'); await tick(60);
    app.stdin.write('j'); await tick(60); // Assignee → Priority → Description
    assert.match(app.lastFrame(), /Description/);
    app.stdin.write('\r');
    await tick(600); // $EDITOR — отдельный процесс, ему надо дать отработать
    assert.deepEqual(puts[2], { key: 'FD-1', fields: { description: 'что сломалось\nи ещё строка' } });
    assert.match(app.lastFrame(), /Description: что сломалось/); // в логе первая строка
  } finally {
    app.unmount();
  }
});

// Родитель: в строке списка от него виден только ключ, p открывает его окном со всеми подзадачами.
test('TUI: p открывает родителя задачи со всеми подзадачами', async () => {
  const kid = { key: 'FD-1', fields: { summary: 'Починить', status: { name: 'В работе' }, updated: new Date().toISOString(), parent: { key: 'FD-0', fields: { summary: 'Эпик' } } } };
  const ctxParent = {
    ...ctx,
    jira: () => ({
      ...ctx.jira(),
      searchJql: async ({ jql }) => (/parent = FD-0/.test(jql)
        ? { issues: [kid, { key: 'FD-9', fields: { summary: 'Промокоды', status: { name: 'К выполнению' } } }] }
        : { issues: [kid] }),
      issue: async () => ({ key: 'FD-0', names: {}, fields: { summary: 'Эпик', status: { name: 'В работе' }, assignee: { displayName: 'Эмиль' }, issuelinks: [] } }),
    }),
  };
  const app = render(React.createElement(App, { ctx: ctxParent, opts: {} }));
  try {
    await tick(300);
    app.stdin.write('2');
    await tick(300);
    assert.match(app.lastFrame(), /↑ FD-0/); // родитель приглушённо в строке списка

    app.stdin.write('p');
    await tick(400);
    assert.match(app.lastFrame(), /подзадач: 2/);
    assert.match(app.lastFrame(), /FD-9 +К выполнению +нету · Промокоды/); // без исполнителя — «нету»

    app.stdin.write('\u001B');
    await tick(150);
    assert.doesNotMatch(app.lastFrame(), /подзадач: 2/); // Esc закрывает окно
  } finally {
    app.unmount();
  }
});

// Поля MR правятся так же, как поля задачи: список полей с текущими значениями, потом значение.
test('TUI: E правит поля MR — текст, флаг и ревьюеры по логинам', async () => {
  const puts = [];
  const ctxMR = {
    ...ctx,
    g: {
      ...ctx.g,
      members: async () => [{ id: 5, name: 'Эмиль', username: 'emil' }, { id: 6, name: 'Амир', username: 'amir' }],
      branches: async () => [{ name: 'dev' }, { name: 'master' }],
      updateMR: async (repo, iid, fields) => { puts.push({ iid, fields }); return { iid }; },
    },
  };
  const app = render(React.createElement(App, { ctx: ctxMR, opts: {} }));
  try {
    await tick(300);
    app.stdin.write('E');
    await tick(200);
    assert.match(app.lastFrame(), /Title {2,}fix: баннер/); // видно, что правишь
    assert.match(app.lastFrame(), /Target branch {2,}dev/);
    assert.match(app.lastFrame(), /Squash при мерже {2,}нет/);

    app.stdin.write('\r'); // Title — обычный текст
    await tick(200);
    for (const ch of '!') { app.stdin.write(ch); await tick(25); }
    app.stdin.write('\r');
    await tick(300);
    assert.deepEqual(puts[0], { iid: 2547, fields: { title: 'fix: баннер!' } });

    app.stdin.write('E'); // Reviewers — логины через запятую, id ищем среди участников
    await tick(200);
    app.stdin.write('j'); await tick(60);
    app.stdin.write('j'); await tick(60);
    app.stdin.write('j'); await tick(60); // Title → Description → Assignee → Reviewers
    app.stdin.write('\r');
    await tick(200);
    for (const ch of 'emil') { app.stdin.write(ch); await tick(25); }
    app.stdin.write('\r');
    await tick(300);
    assert.deepEqual(puts[1], { iid: 2547, fields: { reviewer_ids: [5] } });

    app.stdin.write('E'); // Squash — флаг, переключается без лишних окон
    await tick(200);
    for (let i = 0; i < 6; i++) { app.stdin.write('j'); await tick(40); }
    app.stdin.write('\r');
    await tick(300);
    assert.deepEqual(puts[2], { iid: 2547, fields: { squash: true } });
  } finally {
    app.unmount();
  }
});

// Задачи по умолчанию мои, но фильтруются как в самом Jira — значения приходят оттуда же.
test('TUI: f на задачах — assignee «все» перезапрашивает список другим JQL', async () => {
  const jqls = [];
  const ctxJira = {
    ...ctx,
    cfg: { ...ctx.cfg, jira: { projectKey: 'FD', componentField: 'Компонент' } },
    jira: () => ({
      ...ctx.jira(),
      searchJql: async ({ jql }) => { jqls.push(jql); return { issues: [{ key: 'FD-1', fields: { summary: 'Починить', status: { name: 'В работе' }, updated: new Date().toISOString() } }] }; },
      projectUsers: async () => [{ accountId: 'a2', displayName: 'Эмиль Латыпов' }],
    }),
  };
  const app = render(React.createElement(App, { ctx: ctxJira, opts: {} }));
  try {
    await tick(300);
    app.stdin.write('2');
    await tick(300);
    assert.match(jqls[0], /assignee = currentUser\(\)/); // по умолчанию только мои

    app.stdin.write('f');
    await tick(150);
    assert.match(app.lastFrame(), /Фильтры списка задач/);
    assert.match(app.lastFrame(), /Assignee {2,}я/);
    assert.match(app.lastFrame(), /Свой JQL/);

    app.stdin.write('\r'); // варианты assignee: я, все, люди проекта
    await tick(250);
    assert.match(app.lastFrame(), /Эмиль Латыпов/);
    app.stdin.write('j'); await tick(60);
    app.stdin.write('\r'); // «все»
    await tick(200);
    assert.match(app.lastFrame(), /Assignee {2,}все/);

    app.stdin.write('\u001B'); // Esc — применить и перечитать список
    await tick(300);
    assert.doesNotMatch(jqls.at(-1), /assignee/);
    assert.match(jqls.at(-1), /statusCategory != Done/);
  } finally {
    app.unmount();
  }
});

// Доска: колонки настоящие, из конфигурации доски Jira; H/L двигает карточку переходом статуса.
test('TUI: v рисует доску, H/L переносит карточку, v возвращает список', async () => {
  const moved = [];
  const iss = (key, sid, name, summary) => ({ key, fields: { summary, status: { id: sid, name }, updated: new Date().toISOString() } });
  const columns = [
    { name: 'To do', statuses: [{ id: '1' }] },
    { name: 'Design', statuses: [{ id: '8' }] }, // пустая
    { name: 'Development', statuses: [{ id: '3' }] },
  ];
  const ctxBoard = {
    ...ctx,
    cfg: { ...ctx.cfg, jira: { projectKey: 'FD' } },
    jira: () => ({
      ...ctx.jira(),
      searchJql: async () => ({ issues: [iss('FD-1', '1', 'К выполнению', 'чекаут'), iss('FD-2', '3', 'В работе', 'промокоды')] }),
      boards: async () => ({ values: [{ id: 7, name: 'FitStars' }] }),
      boardConfig: async () => ({ columnConfig: { columns } }),
      transitions: async () => ({ transitions: [{ id: '11', name: 'В работу', to: { id: '3', name: 'В работе' } }] }),
      transition: async (key, id) => { moved.push([key, id]); return null; },
    }),
  };
  const app = render(React.createElement(App, { ctx: ctxBoard, opts: {} }));
  try {
    await tick(300);
    app.stdin.write('2');
    await tick(300);
    app.stdin.write('v');
    await tick(400);
    assert.match(app.lastFrame(), /To do 1/);
    assert.match(app.lastFrame(), /Development 1/);
    assert.doesNotMatch(app.lastFrame(), /Design/); // пустая колонка скрыта
    assert.match(app.lastFrame(), /▌FD-1/);

    app.stdin.write('L'); // перенести карточку в соседнюю колонку
    await tick(400);
    assert.deepEqual(moved, [['FD-1', '11']]);

    app.stdin.write('v');
    await tick(300);
    assert.match(app.lastFrame(), /FD-1 · К выполнению/); // снова список
  } finally {
    app.unmount();
  }
});
