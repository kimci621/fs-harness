import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadAuto, saveAuto, listAuto, stopAuto, advanceTask } from '../src/auto.js';
import { cmdAuto } from '../src/commands/auto.js';

test('auto: loadAuto, saveAuto, listAuto, stopAuto работают со стейтом на диске', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'fs-harness-auto-test-'));
  try {
    assert.equal(loadAuto(root, 'FD-101'), null);
    assert.deepEqual(listAuto(root), []);

    saveAuto(root, { key: 'FD-101', step: 'start', history: [] });
    saveAuto(root, { key: 'FD-102', step: 'implement', history: [] });

    const s1 = loadAuto(root, 'FD-101');
    assert.equal(s1.key, 'FD-101');
    assert.equal(s1.step, 'start');
    assert.ok(s1.updated_at);

    const list = listAuto(root);
    assert.equal(list.length, 2);
    assert.ok(list.some((x) => x.key === 'FD-101'));
    assert.ok(list.some((x) => x.key === 'FD-102'));

    const stopped = stopAuto(root, 'FD-101', 'тестовая остановка');
    assert.equal(stopped.step, 'failed');
    assert.equal(stopped.note, 'тестовая остановка');
    assert.equal(loadAuto(root, 'FD-101').step, 'failed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('advanceTask: гард выключенной автоматики — ноль действий без force', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'fs-harness-auto-guard-'));
  try {
    const res = await advanceTask('FD-201', {
      root,
      cfg: { automation: { enabled: false } },
    });
    assert.equal(res.ok, false);
    assert.equal(res.skipped, true);
    assert.equal(res.reason, 'automation_disabled');
    assert.equal(loadAuto(root, 'FD-201'), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('advanceTask: гард paused_until не даёт выполнять до истечения времени', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'fs-harness-auto-pause-'));
  try {
    const future = new Date(Date.now() + 60_000).toISOString();
    saveAuto(root, { key: 'FD-202', step: 'implement', paused_until: future, history: [] });

    const res = await advanceTask('FD-202', {
      root,
      cfg: { automation: { enabled: true } },
    });
    assert.equal(res.ok, true);
    assert.equal(res.paused, true);
    assert.equal(res.paused_until, future);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('advanceTask: гард maxRetries переводит в paused при исчерпании попыток', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'fs-harness-auto-retry-'));
  try {
    saveAuto(root, { key: 'FD-203', step: 'implement', attempts: { implement: 3 }, history: [] });

    const res = await advanceTask('FD-203', {
      root,
      cfg: { automation: { enabled: true, maxRetries: 3 } },
    });
    assert.equal(res.ok, false);
    assert.equal(res.stopped, true);
    assert.equal(res.reason, 'max_retries_exceeded');
    assert.equal(res.state.step, 'paused');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('advanceTask: шаг start переводит задачу в implement', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'fs-harness-auto-start-'));
  try {
    let transitioned = null;
    const ctx = {
      jira: () => ({
        issue: async (key) => ({ key, fields: { summary: 'Задача', status: { name: 'К выполнению' } } }),
        transition: async (key, name) => { transitioned = name; },
      }),
    };

    const res = await advanceTask('FD-301', {
      root,
      ctx,
      cfg: { automation: { enabled: true } },
    });

    assert.equal(res.ok, true);
    assert.equal(res.advanced, true);
    assert.equal(res.state.step, 'implement');
    assert.equal(transitioned, 'В работе');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('advanceTask: шаг review при ошибке полей переводит в paused и пишет note', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'fs-harness-auto-review-'));
  try {
    saveAuto(root, { key: 'FD-302', step: 'review', history: [] });
    const ctx = {
      jira: () => ({
        transition: async () => {
          throw new Error('Обязательные поля: customfield_10275 (Контент)');
        },
      }),
    };

    const res = await advanceTask('FD-302', {
      root,
      ctx,
      cfg: { automation: { enabled: true } },
    });

    assert.equal(res.ok, false);
    assert.equal(res.paused, true);
    assert.equal(res.state.step, 'paused');
    assert.match(res.state.note, /Контент/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cmdAuto: status и stop работают с флагами asObject', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'fs-harness-cmd-auto-'));
  try {
    saveAuto(root, { key: 'FD-401', step: 'implement', mr: 12, history: [] });

    const statusAll = await cmdAuto({}, ['status'], { autoRoot: root, asObject: true });
    assert.equal(statusAll.ok, true);
    assert.equal(statusAll.tasks.length, 1);
    assert.equal(statusAll.tasks[0].key, 'FD-401');

    const statusOne = await cmdAuto({}, ['status', 'FD-401'], { autoRoot: root, asObject: true });
    assert.equal(statusOne.ok, true);
    assert.equal(statusOne.task.mr, 12);

    const stop = await cmdAuto({}, ['stop', 'FD-401'], { autoRoot: root, asObject: true });
    assert.equal(stop.ok, true);
    assert.equal(stop.state.step, 'failed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('advanceTask: шаги ci -> threads -> conflict -> done проходят цепочку при зелёном пайплайне', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'fs-harness-auto-flow-'));
  try {
    saveAuto(root, { key: 'FD-501', step: 'ci', mr: 99, history: [] });

    const ctx = {
      repo: 'group/proj',
      g: {
        getMR: async () => ({
          iid: 99,
          web_url: 'https://gl/99',
          has_conflicts: false,
          pipeline: { status: 'success' },
        }),
        getDiscussions: async () => [],
      },
    };

    // ci -> threads
    const r1 = await advanceTask('FD-501', { root, ctx, cfg: { automation: { enabled: true } } });
    assert.equal(r1.ok, true);
    assert.equal(r1.state.step, 'threads');

    // threads -> conflict
    const r2 = await advanceTask('FD-501', { root, ctx, cfg: { automation: { enabled: true } } });
    assert.equal(r2.ok, true);
    assert.equal(r2.state.step, 'conflict');

    // conflict -> done
    const r3 = await advanceTask('FD-501', { root, ctx, cfg: { automation: { enabled: true } } });
    assert.equal(r3.ok, true);
    assert.equal(r3.state.step, 'done');
    assert.equal(r3.terminal, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

