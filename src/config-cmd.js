import { loadConfig, configInit, configPath, expandHome, migrateConfig, readRawConfig, writeMigrated } from './config.js';
import { agentNames } from './agents.js';
import { confirm } from './ui.js';
import { CliError } from './errors.js';

// fsh config init|show|migrate
export function cmdConfig(args, opts = {}) {
  const [sub] = args;
  if (sub === 'init') {
    const p = configInit();
    console.log(`Создан ${p}.\nЗаполни projects.<имя>: repo, host, dir, и укажи activeProject.`);
    return 0;
  }
  if (sub === 'show') {
    console.log(show(opts));
    return 0;
  }
  if (sub === 'migrate') return migrate(opts);
  console.log(`Использование: fsh config init|show|migrate\nКонфиг: ${configPath()}`);
  return 0;
}

function show({ project }) {
  const cfg = loadConfig(process.env, { project });
  const others = Object.keys(cfg.projects).filter((n) => n !== cfg.activeProject);
  return [
    `Конфиг: ${cfg.configPath}${readRawConfig(cfg.configPath)?.version === 2 ? '' : ' (v1, мигрирован в памяти — fsh config migrate запишет на диск)'}`,
    `Проект: ${cfg.activeProject || '—'}${others.length ? ` (ещё есть: ${others.join(', ')})` : ''}`,
    `  repo:       ${cfg.repo}`,
    `  host:       ${cfg.host}`,
    `  dir:        ${cfg.projectDir}${cfg.projectDir ? ` (${expandHome(cfg.projectDir)})` : ''}`,
    `  agent:      ${cfg.agent} (профили: ${agentNames(cfg).join(', ')})`,
    `  jira:       ${cfg.jira.baseUrl || '—'}`,
    `  checks:     ${cfg.checks.length ? cfg.checks.join(', ') : '— (коды выхода судье не уходят)'}`,
    `  agentArgs:  ${JSON.stringify(cfg.agentArgs)}`,
  ].join('\n');
}

// Миграция на диск — единственное место, где мы трогаем чужой рабочий файл.
// Поэтому сначала дифф, потом вопрос, и рядом остаётся .v1.bak.
function migrate({ yes }) {
  const file = configPath();
  const raw = readRawConfig(file);
  if (!raw) throw new CliError(`Конфига нет: ${file}. Сначала fsh config init.`, 1, 'config_invalid');
  if (raw.version === 2) {
    console.log(`${file} уже v2, мигрировать нечего.`);
    return 0;
  }
  console.log(`Было (${file}):\n${JSON.stringify(raw, null, 2)}\n`);
  console.log(`Станет:\n${JSON.stringify(migrateConfig(raw), null, 2)}\n`);
  if (!yes && !confirm('Записать? Старый файл останется рядом как .v1.bak [y/N] ')) {
    console.log('Отменено. Конфиг не тронут — v1 работает и так.');
    return 0;
  }
  const { backup } = writeMigrated(file);
  console.log(`Готово. Бэкап: ${backup}`);
  return 0;
}
