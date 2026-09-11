import { createGlab } from './glab.js';
import { loadConfig } from './config.js';
import { CliError } from './errors.js';
import { createCtx, findCommand, COMMANDS } from './registry.js';
import { formatErrorJSON } from './output.js';

const FLAGS_USAGE = `Флаги:
  -R, --repo <repo>       Репозиторий (дефолт из конфига / GL_HELPER_REPO)
  --host <hostname>       GitLab-хост (дефолт из конфига)
  --json                  Вывод в JSON (mrs, mr, jobs, run, deploy) — удобно агентам
  --agent claude|pi       Агент для conflict/commit (дефолт из конфига)
  --project-dir <dir>     Каталог проекта для worktree (conflict) / коммита (commit)
  -B, --build-job <имя>   Имя build-джобы (deploy, conflict; дефолт build_image)
  -w, --watch             В run: ждать завершения джобы
  -y, --yes               В conflict/commit: не спрашивать подтверждение
  --keep-worktree         В conflict: не удалять временный worktree
  --rebuild               В deploy: перезапустить build и deploy, даже если они уже success
  --dry-run               План без запусков (run, deploy, conflict, commit)
  --no-judge              В conflict: пушить без приёмки судьёй
  --judge <профиль>       В conflict: разовая подмена профиля судьи
  --judge-only <runId>    В conflict: прогнать судью по сохранённому рану
  --for <mr|ветка>        В prompts show: отрендерить промпт на реальных данных MR
  --resolved / --open     В mr-comments: только решённые / нерешённые треды

Режим агента (env):
  GL_HELPER_JSON=1        JSON-вывод и структурированные ошибки для агентов
  GL_HELPER_YES=1         Не спрашивать подтверждение (как -y)`;

// USAGE генерируется из реестра — новую команду сюда добавлять не нужно.
function buildUsage() {
  const width = Math.max(...COMMANDS.map((c) => c.usage.length)) + 2;
  const commands = COMMANDS.map((c) => `  ${c.usage.padEnd(width)} ${c.description}`).join('\n');
  const examples = COMMANDS.map((c) => `  ${c.example}`).join('\n');
  return `fsh — обёртка над glab для работы с MR и пайплайнами.

Использование: fsh <команда> [аргументы] [флаги]

Команды:
${commands}
  help                    Эта справка

${FLAGS_USAGE}

Примеры:
${examples}
  fsh -R other/repo mrs --json
`;
}

export async function main(argv) {
  let opts;
  let rest;
  try {
    ({ opts, rest } = parseArgs(argv));
    // Режим агента через env: JSON-вывод и авто-подтверждение без флагов.
    if (process.env.GL_HELPER_JSON === '1') opts.json = true;
    if (process.env.GL_HELPER_YES === '1') opts.yes = true;
  } catch (err) {
    const cliErr = err instanceof CliError ? err : new CliError(String(err?.message || err));
    console.error(`\n❌ ${cliErr.message}`);
    return cliErr.exitCode ?? 1;
  }

  if (opts.help || !rest.length || rest[0] === 'help') {
    console.log(buildUsage());
    return 0;
  }

  const [cmd, ...args] = rest;
  const entry = findCommand(cmd);
  if (!entry) {
    console.error(`Неизвестная команда "${cmd}".\n`);
    console.error(buildUsage());
    return 1;
  }

  try {
    const cfg = loadConfig();
    const ctx = createCtx({
      g: createGlab(undefined, { host: opts.host || cfg.host }),
      cfg,
    });
    const result = await entry.run(ctx, args, opts);
    // doctor возвращает exit code; остальные команды — объект результата или ничего.
    return typeof result === 'number' ? result : 0;
  } catch (err) {
    const cliErr = err instanceof CliError ? err : new CliError(String(err?.message || err));
    if (opts.json) {
      console.log(formatErrorJSON(cliErr));
    } else {
      console.error(`\n❌ ${cliErr.message}`);
    }
    return cliErr.exitCode ?? 1;
  }
}

function parseArgs(argv) {
  const opts = {
    json: false, repo: null, host: null, agent: null, projectDir: null, buildJob: null,
    watch: false, yes: false, keepWorktree: false, rebuild: false, dryRun: false,
    resolved: false, open: false, help: false,
    noJudge: false, judgeProfile: null, judgeOnly: null, for: null,
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
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--no-judge') opts.noJudge = true;
    else if (a === '--judge') opts.judgeProfile = argv[++i];
    else if (a === '--judge-only') opts.judgeOnly = argv[++i];
    else if (a === '--for') opts.for = argv[++i];
    else if (a === '--resolved' || a === '-resolved') opts.resolved = true;
    else if (a === '--open' || a === '-open') opts.open = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (a.startsWith('-')) throw new CliError(`Неизвестный флаг "${a}". См. fsh help.`);
    else rest.push(a);
  }
  return { opts, rest };
}
