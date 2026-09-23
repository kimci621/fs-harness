import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig, migrateConfig, pickProject, writeMigrated, setConfigAgent } from '../src/config.js';
import { cmdConfig } from '../src/config-cmd.js';

const V1 = {
  repo: 'group/app',
  host: 'gitlab.example',
  projectDir: '~/Projects/app-frontend',
  agent: 'cco',
  agentArgs: { claude: ['--flag'] },
  jira: { baseUrl: 'https://j.example', email: 'me@e.st' },
  judge: { roles: { acceptance: ['haiku-cli'] } },
};

const V2 = {
  version: 2,
  activeProject: 'app',
  projects: {
    app: { repo: 'group/app', host: 'gitlab.example', dir: '~/app', jira: { baseUrl: 'https://j.example' } },
    other: { repo: 'group/other', host: 'gitlab.example', dir: '~/other', agent: 'cco', deps: { strategy: 'none' } },
  },
};

const withFile = (obj, fn) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fs-harness-cfg-'));
  const file = path.join(dir, 'config.json');
  writeFileSync(file, JSON.stringify(obj, null, 2));
  try {
    return fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test('миграция v1: имя проекта из каталога, поля переезжают внутрь', () => {
  const v2 = migrateConfig(V1);
  assert.equal(v2.version, 2);
  assert.equal(v2.activeProject, 'app-frontend');
  assert.deepEqual(v2.projects['app-frontend'].repo, 'group/app');
  assert.equal(v2.projects['app-frontend'].dir, '~/Projects/app-frontend');
  assert.equal(v2.projects['app-frontend'].agent, 'cco');
  assert.equal(v2.projects['app-frontend'].jira.baseUrl, 'https://j.example');
  // Общие настройки остаются наверху, а не растекаются по проектам.
  assert.deepEqual(v2.agentArgs, V1.agentArgs);
  assert.deepEqual(v2.judge, V1.judge);
  assert.equal(v2.projects['app-frontend'].agentArgs, undefined);
});

test('миграция: v2 не трогаем, пустой конфиг не рождает проект-пустышку', () => {
  assert.equal(migrateConfig(V2), V2);
  assert.deepEqual(migrateConfig({}).projects, {});
  assert.equal(migrateConfig({}).activeProject, '');
});

test('v1-конфиг читается как раньше: плоские поля на месте', () => {
  withFile(V1, (file) => {
    const cfg = loadConfig({}, { file });
    assert.equal(cfg.repo, 'group/app');
    assert.equal(cfg.host, 'gitlab.example');
    assert.equal(cfg.projectDir, '~/Projects/app-frontend');
    assert.equal(cfg.agent, 'cco');
    assert.equal(cfg.jira.email, 'me@e.st');
    assert.deepEqual(cfg.judge.roles.acceptance, ['haiku-cli']);
    assert.deepEqual(cfg.agentArgs.claude, ['--flag']);
  });
});

test('v2: -P переключает проект, его deps перебивают общие', () => {
  withFile(V2, (file) => {
    const active = loadConfig({}, { file });
    assert.deepEqual([active.activeProject, active.repo], ['app', 'group/app']);
    assert.equal(active.workspace.deps.strategy, 'clone');

    const other = loadConfig({}, { file, project: 'other' });
    assert.deepEqual([other.activeProject, other.repo, other.agent], ['other', 'group/other', 'cco']);
    assert.equal(other.workspace.deps.strategy, 'none');

    const byEnv = loadConfig({ FS_HARNESS_PROJECT: 'other' }, { file });
    assert.equal(byEnv.activeProject, 'other');
    // Флаг сильнее env.
    assert.equal(loadConfig({ FS_HARNESS_PROJECT: 'other' }, { file, project: 'app' }).activeProject, 'app');
  });
});

test('неизвестный проект — понятная ошибка со списком', () => {
  withFile(V2, (file) => {
    assert.throws(
      () => loadConfig({}, { file, project: 'нет-такого' }),
      (e) => e.code === 'config_invalid' && /app, other/.test(e.message),
    );
  });
});

test('pickProject: единственный проект активен без activeProject', () => {
  const one = { version: 2, projects: { solo: { repo: 'g/solo' } } };
  assert.equal(pickProject(one, { env: {} }).name, 'solo');
  assert.equal(pickProject({ version: 2, projects: {} }, { env: {} }).name, '');
});

test('config migrate: пишет v2 и оставляет .v1.bak рядом', () => {
  withFile(V1, (file) => {
    const { backup } = writeMigrated(file);
    assert.ok(existsSync(backup));
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 2);
    assert.equal(JSON.parse(readFileSync(backup, 'utf8')).repo, 'group/app');
    assert.equal(writeMigrated(file).already, true); // повторный вызов — no-op
  });
});

test('setConfigAgent: обновляет v1 и v2 конфиг', () => {
  withFile(V1, (file) => {
    setConfigAgent('agy', { file });
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(raw.agent, 'agy');
  });

  withFile(V2, (file) => {
    setConfigAgent('agy', { file });
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(raw.agent, 'agy');
    assert.equal(raw.projects.app.agent, 'agy');
  });
});

test('cmdConfig agent: просмотр и смена активного агента', () => {
  withFile(V2, (file) => {
    const list = cmdConfig(['agent'], { file, asObject: true });
    assert.equal(list.ok, true);
    assert.ok(list.agents.includes('agy'));
    assert.ok(list.agents.includes('claude'));

    const changed = cmdConfig(['agent', 'agy'], { file, asObject: true });
    assert.equal(changed.ok, true);
    assert.equal(changed.agent, 'agy');

    const cfg = loadConfig({}, { file });
    assert.equal(cfg.agent, 'agy');

    assert.throws(
      () => cmdConfig(['agent', 'nonexistent_agent'], { file }),
      (e) => e.code === 'usage',
    );
  });
});

