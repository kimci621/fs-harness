import { loadConfig, configInit, CONFIG_PATH, expandHome } from './config.js';

// fsh config init|show
export function cmdConfig(args) {
  const [sub] = args;
  if (sub === 'init') {
    const p = configInit();
    console.log(`Создан ${p}.\nОтредактируй repo, projectDir, agent под свои нужды.`);
    return 0;
  }
  if (sub === 'show') {
    console.log(requireConfig());
    return 0;
  }
  console.log(`Использование: fsh config init|show\nКонфиг: ${CONFIG_PATH}`);
  return 0;
}

function requireConfig() {
  const cfg = loadConfig();
  return [
    `Конфиг: ${CONFIG_PATH}`,
    `  repo:       ${cfg.repo}`,
    `  host:       ${cfg.host}`,
    `  projectDir: ${cfg.projectDir} (${expandHome(cfg.projectDir)})`,
    `  agent:      ${cfg.agent}`,
    `  agentArgs:  ${JSON.stringify(cfg.agentArgs)}`,
  ].join('\n');
}
