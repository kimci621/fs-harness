import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { listFlows } from './flow.js';
import { expandHome } from '../config.js';
import { finish } from '../output.js';
import { confirm } from '../ui.js';
import { CliError } from '../errors.js';

const SKILL_REL = path.join('.claude', 'skills', 'fsh', 'SKILL.md');
const SETTINGS_REL = path.join('.claude', 'settings.local.json');
const PERMISSION = 'Bash(fsh:*)';

// Блок для CLAUDE.md проекта печатается, а не вписывается: CLAUDE.md — файл человека,
// в нём порядок разделов и формулировки его, и чинить их за него не наше дело.
export const CLAUDE_BLOCK = `## Задачи Jira и GitLab: fsh

Механику вокруг задачи делает \`fsh\` (FS-Harness), а не самодельные вызовы git и curl:
ветка задачи, MR, поля Jira, фича-флаги. Список команд и сценарии — скилл \`fsh\`
(\`.claude/skills/fsh/SKILL.md\`) и \`fsh agent-guide\`.

Прежде чем выполнять сценарий целиком, разверни его протокол: \`fsh flow show take-task\`.`;

// Скилл генерируется из реестра: список команд и сценариев не должен расходиться
// с тем, что в харнессе есть на самом деле.
export function buildSkill(commands, { projectDir } = {}) {
  const cmds = commands.filter((c) => c.name !== 'mcp').map((c) => `- \`fsh ${c.usage}\` — ${c.description}`).join('\n');
  const flows = listFlows({ projectDir }).map((f) => `- \`fsh flow show ${f.name}\` — ${f.description}`).join('\n');
  return `---
name: fsh
description: Use when работаешь с задачей Jira или merge request — «возьми FD-XXXX в работу», «запушь задачу», «заполни поля в джире», «покажи мои задачи», «что с MR», «включи фича-флаг». Команды fsh для ветки задачи, MR, полей Jira и фича-флагов GrowthBook плюс пошаговые сценарии.
---

# fsh — механика вокруг задачи

\`fsh\` уже стоит в PATH. Он делает механическую часть работы: находит задачу, заводит ветку,
пушит, открывает MR, пишет поля Jira, переключает фича-флаги. Решения принимаешь ты, руками git и
curl эти шаги не повторяешь.

Все команды понимают \`--json\` (машинный вывод и структурированные ошибки), пишущие — \`--dry-run\`
(печатает план, ничего не делает) и \`-y\` (не спрашивать подтверждение).

## Сценарии

Перед тем как выполнять сценарий, разверни его протокол — там точные шаги и команды:

${flows}

## Команды

${cmds}

Полная инструкция со схемами ответов и кодами ошибок: \`fsh agent-guide\`.

## Правила

- Ветку задачи заводит \`fsh task start\`, а не \`git switch -c\`: имя ветки и база берутся из конфига
  проекта, а незакоммиченные правки останавливают переключение.
- Пушишь только по прямой просьбе человека и только через \`fsh task push\`. Ни \`--force\`, ни
  переписывания истории.
- Статус задачи в Jira \`fsh\` не двигает: переход с обязательными полями умеет скилл проекта.
- Не уверен, что команда сделает — запусти её с \`--dry-run\` и покажи план человеку.
`;
}

// fsh init — поставить скилл в проект. --check сравнивает, не переписывая.
export function cmdInit(commands, ctx, opts = {}) {
  const dir = expandHome(opts.projectDir || ctx.cfg?.projectDir || '');
  if (!dir) throw new CliError('Не задан каталог проекта: --project-dir или projects.<имя>.dir в конфиге.', 1, 'config_invalid');
  if (!existsSync(dir)) throw new CliError(`Каталога ${dir} нет.`, 1, 'config_invalid');

  const file = path.join(dir, SKILL_REL);
  const want = buildSkill(commands, { projectDir: dir });
  const have = existsSync(file) ? readFileSync(file, 'utf8') : null;
  const state = have === null ? 'missing' : have === want ? 'current' : 'stale';

  if (opts.check) {
    const result = { ok: state === 'current', dir, skill: file, state };
    if (opts.asObject) return result;
    if (opts.json) return finish(result.ok, result);
    console.log(state === 'current' ? `Скилл fsh на месте и актуален: ${file}`
      : state === 'stale' ? `Скилл fsh устарел (реестр изменился): ${file}\nОбнови: fsh init`
        : `Скилла fsh в проекте нет. Поставь: fsh init`);
    return result;
  }

  const settings = path.join(dir, SETTINGS_REL);
  const perm = permissionState(settings);
  if (opts.dryRun) {
    const result = { ok: true, dry_run: true, dir, skill: file, state, permission: perm, plan: plan(state, perm, file, settings) };
    if (opts.asObject) return result;
    if (opts.json) return finish(true, result);
    for (const line of result.plan) console.log(`  ${line}`);
    return result;
  }
  if (state === 'current' && perm === 'present') {
    const result = { ok: true, dir, skill: file, state, permission: perm, changed: false };
    if (!opts.asObject && !opts.json) console.log(`Всё на месте: ${file}`);
    return opts.json ? finish(true, result) : result;
  }
  if (!opts.yes && !opts.asObject && !confirm(`Записать скилл в ${file}${perm === 'present' ? '' : ` и разрешение ${PERMISSION} в ${settings}`}? [y/N] `)) {
    throw new CliError('Отменено.', 0, 'canceled');
  }

  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, want);
  if (perm !== 'present') addPermission(settings);

  const result = { ok: true, dir, skill: file, state, permission: 'present', changed: true, claude_block: CLAUDE_BLOCK };
  if (opts.asObject) return result;
  if (opts.json) return finish(true, result);
  console.log(`Скилл записан: ${file}`);
  if (perm !== 'present') console.log(`Разрешение ${PERMISSION} добавлено в ${settings}`);
  console.log(`\nДобавь в ${path.join(dir, 'CLAUDE.md')} (сам, это твой файл):\n\n${CLAUDE_BLOCK}\n`);
  return result;
}

const permissionState = (file) => {
  const json = readJson(file);
  if (!json) return 'missing';
  return (json.permissions?.allow ?? []).includes(PERMISSION) ? 'present' : 'absent';
};

// settings.local.json — личный файл, он исключён из git проекта. Общий settings.json
// не трогаем: он поедет в чужой коммит.
function addPermission(file) {
  const json = readJson(file) ?? {};
  const permissions = json.permissions ?? {};
  permissions.allow = [...(permissions.allow ?? []), PERMISSION];
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ ...json, permissions }, null, 2)}\n`);
}

function readJson(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new CliError(`${file} повреждён (${err.message}). Поправь файл или убери его.`, 1, 'config_invalid');
  }
}

const plan = (state, perm, file, settings) => [
  state === 'current' ? `скилл актуален: ${file}` : `${state === 'missing' ? 'записать' : 'обновить'} ${file}`,
  perm === 'present' ? `разрешение ${PERMISSION} уже есть` : `добавить ${PERMISSION} в ${settings}`,
  'напечатать блок для CLAUDE.md проекта',
];
