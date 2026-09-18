import { createGlab } from './glab.js';
import { loadConfig } from './config.js';
import { CliError } from './errors.js';
import { createCtx, findCommand, COMMANDS } from './registry.js';
import { formatErrorJSON } from './output.js';

const FLAGS_USAGE = `Флаги:
  -R, --repo <repo>       Репозиторий (дефолт из конфига / GL_HELPER_REPO)
  -P, --project <имя>     Проект из конфига (дефолт activeProject / FS_HARNESS_PROJECT)
  --host <hostname>       GitLab-хост (дефолт из конфига)
  --json                  Вывод в JSON (mrs, mr, jobs, run, deploy) — удобно агентам
  --agent <профиль>       Агент для действий и commit: cc (по умолчанию), ccq, cco, ccd, pi
                          Профили живут в конфиге, agents.<имя>. Можно и --agent=cc
  --project-dir <dir>     Каталог проекта для действий (worktree) и commit
  -B, --build-job <имя>   Имя build-джобы (deploy, conflict; дефолт build_image)
  -w, --watch             В run: ждать завершения джобы
  -y, --yes               В действиях и commit: не спрашивать подтверждение
  --keep-worktree         В действиях: не удалять временный worktree
  --rebuild               В deploy: перезапустить build и deploy, даже если они уже success
  --dry-run               План без запусков (run, deploy, действия, commit)
  --daemon                В watch: фоновый цикл по всем проектам; в doctor: проверки демона
  --no-judge              В действиях: пушить без приёмки судьёй
  --judge <профиль>       В действиях: разовая подмена профиля судьи
  --judge-only <runId>    В действиях: прогнать судью по сохранённому рану
  --for <mr|ветка>        В prompts show: отрендерить промпт на реальных данных MR
  --attach                В jira field: положить тот же --file ещё и вложением
  --out <каталог>         В jira attach get: куда сохранить (дефолт — текущий каталог)
  --post                  В task push: отписать в Mattermost, что задача уехала в ревью
  --channel <сценарий|id> В mm review и task push --post: разовая подмена канала
  --run <runId>           В ask: разбирать этот ран, а не последний упавший
  --author me|<ник>       В mrs: чьи MR
  --reviewer me|<ник>     В mrs: где ты (или кто-то) ревьюер
  --target <ветка>        В mrs: только MR в эту целевую ветку; в task push: куда открыть MR
  --label <метка>         В mrs: только с этой меткой
  --search <текст>        В mrs: поиск по названию и описанию
  --draft / --no-draft    В mrs: только черновики / только готовые
  --conflicts             В mrs: только конфликтующие
  --threads               В mrs: только с открытыми тредами
  --pipeline <статус>     В mrs: по статусу пайплайна (failed, success, running, none)
  --assignee me|<кто>     В mrs — исполнитель MR; в jira — чьи задачи (дефолт me)
  --sprint current|<имя>  В jira: только задачи спринта
  --component <значение>  В jira: фильтр по checkbox-полю «Компонент»
  --status <имя>          В jira: только задачи в этом статусе (дефолт — все незакрытые)
  --jql "<запрос>"        В jira: свой JQL вместо собранного из флагов
  --file <путь|->         В jira field/create: значение из файла или stdin
  --env <окружение>       В growthbook: окружение флага (дефолт growthbook.env)
  --type <тип>            В growthbook create: тип значения (boolean, string, number, json)
  --default <значение>    В growthbook create: дефолтное значение флага
  --check                 В init: сверить скилл в проекте с реестром, ничего не писать
  --resolved / --open     В mr-comments: только решённые / нерешённые треды

Режим агента (env):
  GL_HELPER_JSON=1        JSON-вывод и структурированные ошибки для агентов
  GL_HELPER_YES=1         Не спрашивать подтверждение (как -y)
  FS_HARNESS_PROJECT      Активный проект (как -P)`;

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

  if (opts.help || rest[0] === 'help') {
    console.log(buildUsage());
    return 0;
  }
  // Голый fsh в живом терминале — это TUI; в пайпе и в CI — справка.
  if (!rest.length) {
    if (!process.stdout.isTTY || opts.json) {
      console.log(buildUsage());
      return 0;
    }
    rest = ['tui'];
  }

  const [cmd, ...args] = rest;
  const entry = findCommand(cmd);
  if (!entry) {
    console.error(`Неизвестная команда "${cmd}".\n`);
    console.error(buildUsage());
    return 1;
  }

  try {
    const cfg = loadConfig(process.env, { project: opts.project });
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
      // Про мастера вспоминают только если о нём напомнить — и ровно там, где упало.
      // usage и canceled это не ошибки инструмента, по ним спрашивать нечего.
      if (!['usage', 'canceled'].includes(cliErr.code) && cmd !== 'ask') {
        console.error('   разобраться: fsh ask "почему упало"');
      }
    }
    return cliErr.exitCode ?? 1;
  }
}

function parseArgs(argv) {
  const opts = {
    json: false, repo: null, host: null, project: null, agent: null, projectDir: null, buildJob: null,
    watch: false, daemon: false, yes: false, keepWorktree: false, rebuild: false, dryRun: false,
    resolved: false, open: false, help: false,
    noJudge: false, judgeProfile: null, judgeOnly: null, for: null, file: null, env: null, check: false,
    attach: false, out: null, run: null, post: false, channel: null,
    type: null, default: null,
    assignee: null, sprint: null, component: null, status: null, jql: null,
    author: null, reviewer: null, target: null, label: null, search: null,
    draft: null, conflicts: false, threads: false, pipeline: null,
  };
  const rest = [];
  // --flag=value разбираем в --flag value до разбора: дальше все ветки работают как раньше.
  const av = argv.flatMap((a) => {
    const eq = /^--[a-z][a-z-]*=/.test(a) ? a.indexOf('=') : -1;
    return eq < 0 ? [a] : [a.slice(0, eq), a.slice(eq + 1)];
  });
  for (let i = 0; i < av.length; i++) {
    const a = av[i];
    if (a === '-R' || a === '--repo') opts.repo = av[++i];
    else if (a === '-P' || a === '--project') opts.project = av[++i];
    else if (a === '--host') opts.host = av[++i];
    else if (a === '--json') opts.json = true;
    else if (a === '--agent') opts.agent = av[++i];
    else if (a === '--project-dir') opts.projectDir = av[++i];
    else if (a === '-B' || a === '--build-job') opts.buildJob = av[++i];
    else if (a === '-w' || a === '--watch') opts.watch = true;
    else if (a === '-y' || a === '--yes') opts.yes = true;
    else if (a === '--keep-worktree') opts.keepWorktree = true;
    else if (a === '--rebuild') opts.rebuild = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--daemon') opts.daemon = true;
    else if (a === '--no-judge') opts.noJudge = true;
    else if (a === '--judge') opts.judgeProfile = av[++i];
    else if (a === '--judge-only') opts.judgeOnly = av[++i];
    else if (a === '--for') opts.for = av[++i];
    else if (a === '--file') opts.file = av[++i];
    else if (a === '--attach') opts.attach = true;
    else if (a === '--post') opts.post = true;
    else if (a === '--channel') opts.channel = av[++i];
    else if (a === '--out') opts.out = av[++i];
    else if (a === '--run') opts.run = av[++i];
    else if (a === '--env') opts.env = av[++i];
    else if (a === '--type') opts.type = av[++i];
    else if (a === '--default') opts.default = av[++i];
    else if (a === '--check') opts.check = true;
    else if (a === '--assignee') opts.assignee = av[++i];
    else if (a === '--sprint') opts.sprint = av[++i];
    else if (a === '--component') opts.component = av[++i];
    else if (a === '--status') opts.status = av[++i];
    else if (a === '--jql') opts.jql = av[++i];
    else if (a === '--author') opts.author = av[++i];
    else if (a === '--reviewer') opts.reviewer = av[++i];
    else if (a === '--target') opts.target = av[++i];
    else if (a === '--label') opts.label = av[++i];
    else if (a === '--search') opts.search = av[++i];
    else if (a === '--draft') opts.draft = true;
    else if (a === '--no-draft') opts.draft = false;
    else if (a === '--conflicts') opts.conflicts = true;
    else if (a === '--threads') opts.threads = true;
    else if (a === '--pipeline') opts.pipeline = av[++i];
    else if (a === '--resolved' || a === '-resolved') opts.resolved = true;
    else if (a === '--open' || a === '-open') opts.open = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (a.startsWith('-')) throw new CliError(`Неизвестный флаг "${a}". См. fsh help.`);
    else rest.push(a);
  }
  return { opts, rest };
}
