import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cmdInit, cmdInitEverywhere, readInitDirs, buildSkill, CLAUDE_BLOCK } from '../src/commands/init.js';
import { COMMANDS } from '../src/registry.js';

const ctx = { cfg: {} };
const fresh = () => mkdtempSync(path.join(tmpdir(), 'fsh-init-'));

test('init: скилл генерируется из реестра — команды и сценарии внутри', () => {
  const skill = buildSkill(COMMANDS);
  assert.match(skill, /^---\nname: fsh\n/);
  for (const c of ['task start', 'jira', 'growthbook', 'flow']) assert.ok(skill.includes(`fsh ${c}`), `нет ${c}`);
  assert.match(skill, /fsh flow show take-task/);
});

// description — единственное, по чему сессия решает, грузить скилл. Без ключа задачи,
// MR и фича-флагов в триггерах он не подхватится там, где нужен.
test('init: в description скилла есть триггеры на задачу, MR и флаги', () => {
  const description = buildSkill(COMMANDS).match(/^description: (.+)$/m)[1];
  for (const trigger of ['FD-1234', 'merge request', 'в работу', 'запушь', 'MR', 'флаг']) {
    assert.ok(description.includes(trigger), `в description нет триггера "${trigger}"`);
  }
});

test('init: пишет скилл и разрешение, второй запуск ничего не меняет', () => {
  const dir = fresh();
  const res = cmdInit(COMMANDS, ctx, { projectDir: dir, asObject: true, yes: true });
  assert.deepEqual([res.state, res.changed, res.permission], ['missing', true, 'present']);
  assert.equal(readFileSync(path.join(dir, '.claude/skills/fsh/SKILL.md'), 'utf8'), buildSkill(COMMANDS, { projectDir: dir }));
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, '.claude/settings.local.json'), 'utf8')).permissions.allow, ['Bash(fsh:*)']);
  assert.ok(res.claude_block === CLAUDE_BLOCK);

  const again = cmdInit(COMMANDS, ctx, { projectDir: dir, asObject: true, yes: true });
  assert.deepEqual([again.state, again.changed], ['current', false]);
  rmSync(dir, { recursive: true, force: true });
});

test('init: чужой settings.local.json не затирается, общий settings.json не трогается', () => {
  const dir = fresh();
  mkdirSync(path.join(dir, '.claude'), { recursive: true });
  writeFileSync(path.join(dir, '.claude/settings.local.json'), JSON.stringify({ outputStyle: 'мой', permissions: { allow: ['Bash(git:*)'], deny: ['Bash(rm:*)'] } }));
  writeFileSync(path.join(dir, '.claude/settings.json'), '{"hooks":{}}');
  cmdInit(COMMANDS, ctx, { projectDir: dir, asObject: true, yes: true });
  const local = JSON.parse(readFileSync(path.join(dir, '.claude/settings.local.json'), 'utf8'));
  assert.deepEqual(local.permissions.allow, ['Bash(git:*)', 'Bash(fsh:*)']);
  assert.deepEqual(local.permissions.deny, ['Bash(rm:*)']);
  assert.equal(local.outputStyle, 'мой');
  assert.equal(readFileSync(path.join(dir, '.claude/settings.json'), 'utf8'), '{"hooks":{}}');
  rmSync(dir, { recursive: true, force: true });
});

test('init --check: видит отсутствие и устаревание, ничего не пишет', () => {
  const dir = fresh();
  assert.deepEqual(cmdInit(COMMANDS, ctx, { projectDir: dir, check: true, asObject: true }).state, 'missing');
  assert.ok(!existsSync(path.join(dir, '.claude')));

  cmdInit(COMMANDS, ctx, { projectDir: dir, asObject: true, yes: true });
  writeFileSync(path.join(dir, '.claude/skills/fsh/SKILL.md'), 'старьё');
  const stale = cmdInit(COMMANDS, ctx, { projectDir: dir, check: true, asObject: true });
  assert.deepEqual([stale.ok, stale.state], [false, 'stale']);
  assert.equal(readFileSync(path.join(dir, '.claude/skills/fsh/SKILL.md'), 'utf8'), 'старьё');
  rmSync(dir, { recursive: true, force: true });
});

test('init: dry-run печатает план, несуществующий каталог — ошибка', () => {
  const dir = fresh();
  const dry = cmdInit(COMMANDS, ctx, { projectDir: dir, dryRun: true, asObject: true });
  assert.equal(dry.dry_run, true);
  assert.ok(dry.plan.some((l) => /записать/.test(l)) && dry.plan.some((l) => /Bash\(fsh:\*\)/.test(l)));
  assert.ok(!existsSync(path.join(dir, '.claude')));
  assert.throws(() => cmdInit(COMMANDS, ctx, { projectDir: path.join(dir, 'нет'), asObject: true, yes: true }), (e) => e.code === 'config_invalid');
  assert.throws(() => cmdInit(COMMANDS, { cfg: {} }, { asObject: true, yes: true }), (e) => e.code === 'config_invalid');
  rmSync(dir, { recursive: true, force: true });
});

test('скилл: пишущие примеры в таблице — с -y, новые возможности jira названы', () => {
  const skill = buildSkill(COMMANDS);
  const table = skill.split('## Когда именно брать fsh')[1].split('## Чего fsh не делает')[0];
  const examples = [...table.matchAll(/`(fsh [^`]+)`/g)].map((m) => m[1]);
  for (const ex of examples.filter((e) => / (move|toggle|comment|parent|create) /.test(e) || / field .*(--file|--append)/.test(e))) {
    assert.match(ex, / -y$/, ex);
  }
  for (const piece of ['fsh jira field FD-1234 "Technical details for QA"`', '--append', 'fsh jira parent', '--parent', '--sprint', '--assignee', 'comment FD-1234 --file']) {
    assert.ok(table.includes(piece), piece);
  }
});

test('init everywhere: init запоминает каталог, everywhere обновляет все и сообщает о пропавшем', () => {
  const root = fresh();
  const dirsFile = path.join(root, 'cfg', 'init-dirs.json');
  const a = path.join(root, 'a');
  const b = path.join(root, 'b');
  mkdirSync(a);
  mkdirSync(b);
  cmdInit(COMMANDS, ctx, { projectDir: a, asObject: true, yes: true, dirsFile });
  cmdInit(COMMANDS, ctx, { projectDir: b, asObject: true, yes: true, dirsFile });
  cmdInit(COMMANDS, ctx, { projectDir: a, asObject: true, yes: true, dirsFile });
  assert.deepEqual(readInitDirs(dirsFile), [a, b]);

  writeFileSync(path.join(a, '.claude/skills/fsh/SKILL.md'), 'старьё');
  const check = cmdInitEverywhere(COMMANDS, { check: true, asObject: true, dirsFile });
  assert.deepEqual(check.results.map((r) => r.state), ['stale', 'current']);
  assert.equal(readFileSync(path.join(a, '.claude/skills/fsh/SKILL.md'), 'utf8'), 'старьё');

  const res = cmdInitEverywhere(COMMANDS, { asObject: true, dirsFile });
  assert.equal(res.ok, true);
  assert.deepEqual(res.results.map((r) => r.changed), [true, false]);
  assert.equal(readFileSync(path.join(a, '.claude/skills/fsh/SKILL.md'), 'utf8'), buildSkill(COMMANDS, { projectDir: a }));

  rmSync(b, { recursive: true });
  const gone = cmdInitEverywhere(COMMANDS, { asObject: true, dirsFile });
  assert.deepEqual([gone.ok, gone.results[0].ok, gone.results[1].ok], [false, true, false]);
  assert.match(gone.results[1].error, /нет/);
  assert.deepEqual(readInitDirs(dirsFile), [a, b]);
  rmSync(root, { recursive: true, force: true });
});

test('init everywhere: пустой или кривой список — ошибка config_invalid', () => {
  const root = fresh();
  const dirsFile = path.join(root, 'init-dirs.json');
  assert.throws(() => cmdInitEverywhere(COMMANDS, { asObject: true, dirsFile }), (e) => e.code === 'config_invalid');
  writeFileSync(dirsFile, '{"dirs":"не массив"}');
  assert.throws(() => cmdInitEverywhere(COMMANDS, { asObject: true, dirsFile }), (e) => e.code === 'config_invalid');
  rmSync(root, { recursive: true, force: true });
});

test('init: битый список каталогов останавливает init до записи скилла', () => {
  const root = fresh();
  const dir = path.join(root, 'p');
  mkdirSync(dir);
  const dirsFile = path.join(root, 'init-dirs.json');
  writeFileSync(dirsFile, '{');
  assert.throws(() => cmdInit(COMMANDS, ctx, { projectDir: dir, asObject: true, yes: true, dirsFile }), (e) => e.code === 'config_invalid');
  assert.ok(!existsSync(path.join(dir, '.claude')));
  rmSync(root, { recursive: true, force: true });
});
