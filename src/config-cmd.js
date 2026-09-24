import { loadConfig, configInit, configPath, expandHome, migrateConfig, readRawConfig, writeMigrated, setConfigAgent } from './config.js';
import { agentNames } from './agents.js';
import { confirm } from './ui.js';
import { finish } from './output.js';
import { CliError } from './errors.js';

const AGENT_DESCRIPTIONS = {
  agy: 'Antigravity CLI (Google DeepMind / Antigravity)',
  claude: 'Claude Code (Anthropic по подписке / OAuth)',
  cc: 'Claude Code (алиас claude)',
  cco: 'Claude Code через OpenRouter (~/.openrouter_key)',
  ccd: 'Claude Code через DeepSeek (~/.deepseek_key)',
  ccq: 'Claude Code через Alibaba Qwen (~/.alibaba_key)',
};

// fsh config init|show|migrate|agent [имя]
export function cmdConfig(args, opts = {}) {
  const [sub, ...rest] = args;
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
  if (sub === 'agent') {
    return handleAgent(rest[0], opts);
  }
  if (sub === 'set' && rest[0] === 'agent') {
    return handleAgent(rest[1], opts);
  }
  console.log(`Использование: fsh config init|show|migrate|agent [имя]\nКонфиг: ${configPath()}`);
  return 0;
}

function handleAgent(rawName, opts = {}) {
  const name = rawName === 'co' ? 'cco' : rawName;
  const cfg = loadConfig(process.env, opts);
  const names = agentNames(cfg);
  if (!name) {
    const result = { ok: true, agent: cfg.agent, agents: names };
    if (opts.asObject) return result;
    if (opts.json) {
      finish(true, result);
      return 0;
    }
    console.log(`Текущий агент: ${cfg.agent}${cfg.activeProject ? ` (проект ${cfg.activeProject})` : ''}\n`);
    console.log('Доступные профили:');
    for (const n of names) {
      const active = n === cfg.agent ? '*' : ' ';
      const desc = AGENT_DESCRIPTIONS[n] ? ` - ${AGENT_DESCRIPTIONS[n]}` : '';
      console.log(`  ${active} ${n}${desc}`);
    }
    console.log('\nЧтобы сменить: fsh config agent <имя>');
    return 0;
  }
  if (!names.includes(name)) {
    throw new CliError(`Неизвестный агент "${name}". Доступны: ${names.join(', ')}.`, 1, 'usage');
  }
  setConfigAgent(name, { file: opts.file, project: opts.project });
  const result = { ok: true, agent: name, previous: cfg.agent };
  if (opts.asObject) return result;
  if (opts.json) {
    finish(true, result);
    return 0;
  }
  console.log(`Агент изменён на "${name}".`);
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
    `  backend:    ${cfg.backend ? `${cfg.backend.name} (${cfg.backend.dir})` : '—'}`,
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
