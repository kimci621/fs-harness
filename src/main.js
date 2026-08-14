import { createGlab } from './glab.js';
import { loadConfig, configInit, CONFIG_PATH, expandHome } from './config.js';
import { CliError } from './errors.js';
import { cmdMRS } from './commands/mrs.js';
import { cmdMR } from './commands/mr.js';
import { cmdJobs } from './commands/jobs.js';
import { cmdRun } from './commands/run.js';
import { cmdDeploy } from './commands/deploy.js';
import { cmdConflict } from './commands/conflict.js';
import { cmdCommit } from './commands/commit.js';

const USAGE = `gl-helper — обёртка над glab для работы с MR и пайплайнами.

Использование: gl-helper <команда> [аргументы] [флаги]

Команды:
  mrs                     Все открытые MR: название, ветки, пайплайн, комменты, конфликты
  mr <ветка|номер>        Один MR в том же формате (часть имени ветки, неточный поиск)
  conflict <mr|ветка>     Решить конфликт силами AI-агента и запустить build
  jobs <mr|ветка>         Джобы последнего MR-пайплайна
  run <джоба> <mr|ветка>  Запустить manual-джобу (по имени или id)
  deploy <mr|ветка> [N]   build → ждать → deploy_dev (или deploy_dev2…10) → ждать
  commit [--agent]        Сформировать и сделать коммит по паттерну (агент, без push)
  config init|show        Настроить/показать ~/.config/gl-helper/config.json
  help                    Эта справка

Флаги:
  -R, --repo <repo>       Репозиторий (дефолт из конфига / GL_HELPER_REPO)
  --host <hostname>       GitLab-хост (дефолт из конфига)
  --json                  Вывод в JSON (mrs, mr, jobs, run, deploy) — удобно агентам
  --agent claude|pi       Агент для conflict/commit (дефолт из конфига)
  --project-dir <dir>     Каталог проекта для worktree (conflict) / коммита (commit)
  -B, --build-job <имя>   Имя build-джобы (deploy, conflict; дефолт build_image)
  -w, --watch             В run: ждать завершения джобы
  -y, --yes               В conflict: не спрашивать подтверждение
  --keep-worktree         В conflict: не удалять временный worktree
  --rebuild               В deploy: перезапустить build и deploy, даже если они уже success

Примеры:
  gl-helper mrs
  gl-helper mr special-offer
  gl-helper conflict !2547 --agent pi
  gl-helper commit --agent pi
  gl-helper jobs fix/main-banner
  gl-helper run build_image fix/main-banner -w
  gl-helper deploy feat/premium-banner 3
  gl-helper -R other/repo mrs --json
`;

export async function main(argv) {
  let opts;
  let rest;
  try {
    ({ opts, rest } = parseArgs(argv));
  } catch (err) {
    const cliErr = err instanceof CliError ? err : new CliError(String(err?.message || err));
    console.error(`\n❌ ${cliErr.message}`);
    return cliErr.exitCode ?? 1;
  }

  if (opts.help || !rest.length || rest[0] === 'help') {
    console.log(USAGE);
    return 0;
  }

  const [cmd, ...args] = rest;
  const cfg = loadConfig();
  const repo = opts.repo || cfg.repo;

  try {
    if (cmd === 'config') {
      return cmdConfig(args);
    }

    const g = createGlab(undefined, { host: opts.host || cfg.host });
    switch (cmd) {
      case 'mrs':
        await cmdMRS(g, repo, { json: opts.json });
        return 0;
      case 'mr':
        await cmdMR(g, repo, args[0], { json: opts.json });
        return 0;
      case 'jobs':
        await cmdJobs(g, repo, args[0], { json: opts.json });
        return 0;
      case 'run':
        await cmdRun(g, repo, args, { json: opts.json, watch: opts.watch });
        return 0;
      case 'deploy':
        await cmdDeploy(g, repo, args, { json: opts.json, buildJob: opts.buildJob, rebuild: opts.rebuild });
        return 0;
      case 'conflict':
        await cmdConflict(g, repo, args, {
          agent: opts.agent || cfg.agent,
          projectDir: opts.projectDir || cfg.projectDir,
          buildJob: opts.buildJob,
          yes: opts.yes,
          keepWorktree: opts.keepWorktree,
          agentArgs: (cfg.agentArgs || {})[opts.agent || cfg.agent] || [],
        });
        return 0;
      case 'commit':
        await cmdCommit(args, {
          agent: opts.agent || cfg.agent,
          projectDir: opts.projectDir,
          yes: opts.yes,
          agentArgs: (cfg.agentArgs || {})[opts.agent || cfg.agent] || [],
        });
        return 0;
      default:
        console.error(`Неизвестная команда "${cmd}".\n`);
        console.error(USAGE);
        return 1;
    }
  } catch (err) {
    const cliErr = err instanceof CliError ? err : new CliError(String(err?.message || err));
    console.error(`\n❌ ${cliErr.message}`);
    return cliErr.exitCode ?? 1;
  }
}

function cmdConfig(args) {
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
  console.log(`Использование: gl-helper config init|show\nКонфиг: ${CONFIG_PATH}`);
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

function parseArgs(argv) {
  const opts = {
    json: false, repo: null, host: null, agent: null, projectDir: null, buildJob: null,
    watch: false, yes: false, keepWorktree: false, rebuild: false, help: false,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-R' || a === '--repo') opts.repo = argv[++i];
    else if (a === '--host') opts.host = argv[++i];
    else if (a === '--json') opts.json = true;
    else if (a === '--agent') opts.agent = argv[++i];
    else if (a === '--project-dir') opts.projectDir = argv[++i];
    else if (a === '-B' || a === '--build-job') opts.buildJob = argv[++i];
    else if (a === '-w' || a === '--watch') opts.watch = true;
    else if (a === '-y' || a === '--yes') opts.yes = true;
    else if (a === '--keep-worktree') opts.keepWorktree = true;
    else if (a === '--rebuild') opts.rebuild = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (a.startsWith('-')) throw new CliError(`Неизвестный флаг "${a}". См. gl-helper help.`);
    else rest.push(a);
  }
  return { opts, rest };
}
