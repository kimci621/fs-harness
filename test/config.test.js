import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig, migrateConfig, pickProject, writeMigrated, setConfigAgent, resolveProject } from '../src/config.js';
import { cmdConfig } from '../src/config-cmd.js';
import { cmdJira } from '../src/commands/jira.js';
import { createJira } from '../src/jira.js';

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

test('resolveProject: с backend, без backend, битая ссылка и цикл', () => {
  const cfg = {
    version: 2,
    projects: {
      frontend: { repo: 'org/fe', dir: '~/fe', backend: 'backend' },
      backend: { repo: 'org/be', dir: '~/be' },
      solo: { repo: 'org/solo', dir: '~/solo' },
      broken: { repo: 'org/broken', dir: '~/broken', backend: 'nonexistent' },
      cycleA: { repo: 'org/a', dir: '~/a', backend: 'cycleB' },
      cycleB: { repo: 'org/b', dir: '~/b', backend: 'cycleA' },
    },
  };

  const fe = resolveProject(cfg, 'frontend');
  assert.equal(fe.name, 'frontend');
  assert.equal(fe.backend?.name, 'backend');
  assert.equal(fe.backend?.repo, 'org/be');
  assert.match(fe.backend?.dir, /\/be$/);

  const solo = resolveProject(cfg, 'solo');
  assert.equal(solo.name, 'solo');
  assert.equal(solo.backend, null);

  assert.throws(
    () => resolveProject(cfg, 'broken'),
    (e) => e.code === 'config_invalid' && /projects\.broken\.backend/.test(e.message),
  );

  assert.throws(
    () => resolveProject(cfg, 'cycleA'),
    (e) => e.code === 'config_invalid' && /Цикл бэкенда/.test(e.message),
  );
});

test('loadConfig: backend на плоском уровне конфига и выбор -P', () => {
  const withBe = {
    version: 2,
    activeProject: 'fe',
    projects: {
      fe: { repo: 'org/fe', host: 'gitlab.example', dir: '~/fe', backend: 'be' },
      be: { repo: 'org/be', host: 'gitlab.example', dir: '~/be' },
    },
  };
  withFile(withBe, (file) => {
    const cfg = loadConfig({}, { file });
    assert.equal(cfg.backend?.name, 'be');
    assert.equal(cfg.backend?.repo, 'org/be');

    const beOnly = loadConfig({}, { file, project: 'be' });
    assert.equal(beOnly.backend, null);
    assert.equal(beOnly.activeProject, 'be');
    assert.equal(beOnly.repo, 'org/be');
  });
});

test('проект без jira: вызов jira падает с config_invalid', async () => {
  const withoutJira = {
    version: 2,
    projects: {
      be: { repo: 'org/be', host: 'gitlab.example', dir: '~/be' },
    },
  };
  await withFile(withoutJira, async (file) => {
    const cfg = loadConfig({}, { file, project: 'be' });
    const ctx = { cfg, jira: () => createJira({ ...cfg.jira }) };
    await assert.rejects(
      () => cmdJira(ctx, []),
      (e) => e.code === 'config_invalid',
    );
  });
});


