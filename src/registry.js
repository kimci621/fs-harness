import { cmdMRS } from './commands/mrs.js';
import { cmdMR } from './commands/mr.js';
import { cmdMRComments } from './commands/mr-comments.js';
import { cmdJobs } from './commands/jobs.js';
import { cmdRun } from './commands/run.js';
import { cmdDeploy } from './commands/deploy.js';
import { conflictAction } from './actions/conflict.js';
import { threadsAction } from './actions/threads.js';
import { reviewAction } from './actions/review.js';
import { analyzeAction } from './actions/analyze.js';
import { runActionCLI } from './engine.js';
import { cmdCommit } from './commands/commit.js';
import { cmdDoctor } from './commands/doctor.js';
import { cmdPrompts } from './commands/prompts.js';
import { cmdJira } from './commands/jira.js';
import { cmdWatch } from './commands/watch.js';
import { startTUI } from './tui/index.js';
import { createJira } from './jira.js';
import { readSecret } from './secrets.js';
import { buildAgentGuide, cmdAgentGuide } from './commands/agent-guide.js';
import { cmdConfig } from './config-cmd.js';
import { CliError } from './errors.js';

// Единый реестр команд — single source of truth для CLI и MCP.
// Добавил запись сюда → команда появляется в dispatch, help, agent-guide и MCP tools/list.
//
// Поля:
//   name        имя команды
//   usage       строка использования (для help/agent-guide)
//   description краткое описание для людей
//   example     пример для help
//   run(ctx, args, opts)  CLI-вызов (ctx: {g, repo, cfg, notify, agentArgs})
//   mcp         описание инструмента для MCP: {description, inputSchema, call(ctx, args)}
//               если mcp нет — инструмент не экспортируется
//   kind        'data' — обычная команда (по умолчанию); 'action' — agent-действие,
//               у него обязателен блок action, а run и mcp синтезирует fromAction()

export function createCtx({ g, cfg, notify }) {
  return {
    g,
    repo: cfg.repo,
    cfg,
    notify,
    agentArgs: (agent) => (cfg.agentArgs || {})[agent] || [],
    // Лениво: команды без Jira не должны требовать токен.
    jira: () => createJira({ ...cfg.jira, token: readSecret('jira') }),
  };
}

export const COMMANDS = [
  {
    name: 'mrs',
    usage: 'mrs',
    description: 'Все открытые MR: название, ветки, пайплайн, комменты, конфликты',
    example: 'fsh mrs',
    run: (ctx, args, opts) => withRepoHost(ctx, () => cmdMRS(ctx.g, ctx.repo, { json: opts.json })),
    mcp: {
      description: 'Список всех открытых MR: название, ветки, статус пайплайна, комментарии, конфликты. Только чтение.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      call: (ctx) => withRepoHost(ctx, () => cmdMRS(ctx.g, ctx.repo, { json: true, asObject: true })),
    },
  },
  {
    name: 'mr',
    usage: 'mr <ветка|номер>',
    description: 'Один MR в том же формате (часть имени ветки, неточный поиск)',
    example: 'fsh mr special-offer',
    run: (ctx, args, opts) => withRepoHost(ctx, () => cmdMR(ctx.g, ctx.repo, args[0], { json: opts.json })),
    mcp: {
      description: 'Один MR по номеру (!2547, 2547) или части имени ветки (неточный поиск). Только чтение.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'номер MR (!2547) или часть имени source-ветки' } },
        required: ['query'],
      },
      call: (ctx, a) => withRepoHost(ctx, () => cmdMR(ctx.g, ctx.repo, a.query, { json: true, asObject: true })),
    },
  },
  {
    name: 'mr-comments',
    usage: 'mr-comments <mr|ветка>',
    description: 'Комментарии MR (--resolved / --open)',
    example: 'fsh mr-comments fix/main-banner -open',
    run: (ctx, args, opts) => withRepoHost(ctx, () => cmdMRComments(ctx.g, ctx.repo, args, { json: opts.json, resolved: opts.resolved, open: opts.open })),
    mcp: {
      description: 'Комментарии MR, сгруппированные по тредам. filter: all — все, resolved — только решённые, open — нерешённые. Только чтение.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'номер MR (!2547) или часть имени ветки' },
          filter: { type: 'string', enum: ['all', 'resolved', 'open'], default: 'all' },
        },
        required: ['query'],
      },
      call: (ctx, a) => withRepoHost(ctx, () => cmdMRComments(ctx.g, ctx.repo, [a.query], {
        json: true, asObject: true,
        resolved: a.filter === 'resolved', open: a.filter === 'open',
      })),
    },
  },
  {
    name: 'jobs',
    usage: 'jobs <mr|ветка>',
    description: 'Джобы последнего MR-пайплайна (устаревший пайплайн пересоздаётся)',
    example: 'fsh jobs fix/main-banner',
    run: (ctx, args, opts) => withRepoHost(ctx, () => cmdJobs(ctx.g, ctx.repo, args[0], { json: opts.json })),
    mcp: {
      description: 'Джобы последнего MR-пайплайна: stage, имя, статус, id. Если head-пайплайн отсутствует или устарел (sha ≠ HEAD ветки), создаёт новый MR-пайплайн — то есть меняет состояние GitLab.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'номер MR или часть имени ветки' } },
        required: ['query'],
      },
      call: (ctx, a) => withRepoHost(ctx, () => cmdJobs(ctx.g, ctx.repo, a.query, { json: true, asObject: true })),
    },
  },
  {
    name: 'run',
    usage: 'run <джоба> <mr|ветка>',
    description: 'Запустить manual-джобу (по имени или id)',
    example: 'fsh run build_image fix/main-banner -w',
    run: (ctx, args, opts) => withRepoHost(ctx, () => cmdRun(ctx.g, ctx.repo, args, { json: opts.json, watch: opts.watch, dryRun: opts.dryRun })),
    mcp: {
      description: 'Запустить джобу (по имени или id) в последнем MR-пайплайне: manual → play, failed/canceled → retry. watch=true — дождаться завершения. Меняет состояние GitLab.',
      inputSchema: {
        type: 'object',
        properties: {
          job: { type: 'string', description: 'имя джобы (например build_image) или её id' },
          query: { type: 'string', description: 'номер MR или часть имени ветки' },
          watch: { type: 'boolean', default: false, description: 'ждать завершения джобы' },
        },
        required: ['job', 'query'],
      },
      call: (ctx, a) => withRepoHost(ctx, () => cmdRun(ctx.g, ctx.repo, [a.job, a.query], {
        json: true, asObject: true, quiet: true, yes: true, watch: Boolean(a.watch), onTick: ctx.notify,
      })),
    },
  },
  {
    name: 'deploy',
    usage: 'deploy <mr|ветка> [N]',
    description: 'build → ждать → deploy_dev (или deploy_dev2…10) → ждать',
    example: 'fsh deploy feat/premium-banner 3',
    run: (ctx, args, opts) => withRepoHost(ctx, () => cmdDeploy(ctx.g, ctx.repo, args, {
      json: opts.json, buildJob: opts.buildJob, rebuild: opts.rebuild, dryRun: opts.dryRun,
    })),
    mcp: {
      description: 'Деплой ветки MR: запустить build, дождаться success, затем deploy_dev (slot=1) или deploy_dev2..deploy_dev10 (slot=N) и дождаться. rebuild=true — перезапустить даже успешные джобы (перезаписать слот). Ждёт завершения. Меняет состояние GitLab.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'номер MR или часть имени ветки' },
          slot: { type: 'integer', minimum: 1, maximum: 10, default: 1, description: 'номер dev-слота: 1 → deploy_dev, 2..10 → deploy_devN' },
          rebuild: { type: 'boolean', default: false, description: 'перезапустить build и deploy даже при status=success' },
          build_job: { type: 'string', description: 'имя build-джобы (по умолчанию build_image)' },
        },
        required: ['query'],
      },
      call: (ctx, a) => withRepoHost(ctx, () => cmdDeploy(ctx.g, ctx.repo, [a.query, a.slot], {
        json: true, asObject: true, quiet: true, yes: true,
        rebuild: Boolean(a.rebuild), buildJob: a.build_job, onTick: ctx.notify,
      })),
    },
  },
  fromAction(conflictAction),
  fromAction(threadsAction),
  fromAction(reviewAction),
  fromAction(analyzeAction),
  {
    name: 'jira',
    usage: 'jira [mine|<KEY>|move <KEY> <статус>]',
    description: 'Задачи Jira: список с фильтрами, одна задача с комментариями, смена статуса',
    example: 'fsh jira mine --sprint current --component Frontend',
    run: (ctx, args, opts) => cmdJira(ctx, args, opts),
    mcp: {
      description: 'Прочитать Jira: без аргументов или с mine — открытые задачи на текущем пользователе; с ключом (FD-7647) — задача целиком с описанием и комментариями. Только чтение.',
      inputSchema: {
        type: 'object',
        properties: { key: { type: 'string', description: 'ключ задачи (FD-7647) или mine' } },
      },
      call: (ctx, a) => cmdJira(ctx, [a.key], { json: true, asObject: true }),
    },
  },
  {
    name: 'commit',
    usage: 'commit [--agent]',
    description: 'Сформировать и сделать коммит по паттерну (агент, без push)',
    example: 'fsh commit --agent pi',
    run: (ctx, args, opts) => {
      const agent = opts.agent || ctx.cfg.agent;
      return cmdCommit(args, {
        agent,
        projectDir: opts.projectDir,
        json: opts.json,
        yes: opts.yes,
        dryRun: opts.dryRun,
        agentArgs: ctx.agentArgs(agent),
      });
    },
    mcp: {
      description: 'Агент (claude или pi) изучает git diff, формирует сообщение коммита по паттерну проекта (.llm-commit-pattern или встроенный) и коммитит все изменения. Push не делает. Меняет локальный git-репозиторий.',
      inputSchema: {
        type: 'object',
        properties: {
          dir: { type: 'string', description: 'каталог репозитория (по умолчанию текущий)' },
          agent: { type: 'string', enum: ['claude', 'pi'] },
        },
      },
      call: (ctx, a) => {
        const agent = a.agent || ctx.cfg.agent;
        return cmdCommit([], {
          json: true, asObject: true, quiet: true, yes: true,
          agent, projectDir: a.dir, agentArgs: ctx.agentArgs(agent),
        });
      },
    },
  },
  {
    name: 'doctor',
    usage: 'doctor',
    description: 'Самодиагностика: glab, конфиг, API, git, агенты',
    example: 'fsh doctor',
    run: (ctx, args, opts) => cmdDoctor({
      repo: opts.repo || ctx.cfg.repo,
      host: opts.host || ctx.cfg.host,
      projectDir: opts.projectDir || ctx.cfg.projectDir,
      json: opts.json,
    }),
    mcp: {
      description: 'Самодиагностика: glab, конфиг, доступ к API, git-репозиторий, наличие агентов. Только чтение.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      call: (ctx) => cmdDoctor({ repo: ctx.cfg.repo, host: ctx.cfg.host, projectDir: ctx.cfg.projectDir, json: true, asObject: true }),
    },
  },
  {
    name: 'agent-guide',
    usage: 'agent-guide',
    description: 'Полная инструкция для AI-агентов (что читать первой)',
    example: 'fsh agent-guide',
    run: () => cmdAgentGuide(COMMANDS),
    mcp: {
      description: 'Полная инструкция по работе с fsh: команды, флаги, JSON-схемы, коды ошибок. Вызови первой, если не знаешь, как работать с инструментами.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      call: () => ({ ok: true, guide: buildAgentGuide(COMMANDS) }),
    },
  },
  {
    name: 'prompts',
    usage: 'prompts list|show <имя>|check|edit <имя>',
    description: 'Промпты действий: где лежат, что внутри, всё ли цело',
    example: 'fsh prompts show actions/conflict --for !2547',
    run: (ctx, args, opts) => cmdPrompts(ACTIONS, args, opts, ctx),
  },
  {
    name: 'config',
    usage: 'config init|show|migrate',
    description: 'Настроить/показать конфиг, перевести его на v2 (проекты)',
    example: 'fsh config show',
    run: (ctx, args, opts) => cmdConfig(args, opts),
  },
  {
    name: 'watch',
    usage: 'watch',
    description: 'Что изменилось в MR с прошлого опроса: триаж судьёй и уведомление в Mattermost',
    example: 'fsh watch',
    run: (ctx, args, opts) => withProject(ctx, () => cmdWatch(ctx, { json: opts.json })),
  },
  {
    name: 'tui',
    usage: 'tui',
    description: 'Полноэкранный режим: MR, задачи, раны и запуск действий с клавиши',
    example: 'fsh tui',
    run: (ctx, args, opts) => withProject(ctx, () => startTUI(ctx, opts)),
  },
  {
    name: 'mcp',
    usage: 'mcp',
    description: 'MCP-сервер (stdio): инструменты для AI-клиентов',
    example: 'claude mcp add fs-harness -- fsh mcp',
    run: async () => (await import('./mcp.js')).runMCPServer(),
  },
];

// Одна декларация действия → CLI-команда и MCP-инструмент. Руками их не пишут:
// два ручных вызова расходятся, а движок у них один.
export function fromAction(spec) {
  const a = spec.action;
  const optsFor = (ctx, opts, agent) => ({
    ...opts,
    agent,
    projectDir: opts.projectDir || ctx.cfg.projectDir,
    agentArgs: ctx.agentArgs(agent),
    cfg: ctx.cfg,
  });
  return {
    ...spec,
    run: (ctx, args, opts) => withRepoHost(ctx, () => {
      const agent = opts.agent || ctx.cfg.agent || a.agent.default;
      return runActionCLI(spec, ctx, args, optsFor(ctx, opts, agent));
    }),
    mcp: {
      description: a.mcpDescription,
      inputSchema: a.inputSchema,
      call: (ctx, args) => withRepoHost(ctx, () => {
        const agent = args.agent || ctx.cfg.agent || a.agent.default;
        return runActionCLI(spec, ctx, [args.query], {
          ...optsFor(ctx, { json: true, asObject: true, quiet: true, yes: true }, agent),
          onTick: ctx.notify,
        });
      }),
    },
  };
}

// Из ACTIONS TUI строит кнопки, а будущий HTTP — роуты.
export const ACTIONS = COMMANDS.filter((c) => c.kind === 'action');

export function findCommand(name) {
  return COMMANDS.find((c) => c.name === name) || null;
}

// Команды, которым нужны repo и host из конфига, оборачиваются этим гардом:
// без настроенного repo/host — понятная ошибка вместо «projects//merge_requests».
export function withProject(ctx, fn) {
  if (!ctx.repo || !ctx.cfg.host) {
    const known = Object.keys(ctx.cfg.projects ?? {});
    throw new CliError(
      `У проекта${ctx.cfg.activeProject ? ` "${ctx.cfg.activeProject}"` : ''} не заполнены repo или host. ` +
        `Поправь конфиг (fsh config show)${known.length > 1 ? `, выбери другой проект: -P ${known.join(' | ')}` : ''}, или передай -R <repo> --host <host>.`,
      1,
      'config_invalid',
    );
  }
  return fn();
}

// Старое имя оставлено алиасом: им пользуются записи реестра и внешние вызовы.
export const withRepoHost = withProject;

// Инструменты для MCP tools/list.
export function mcpTools(ctx) {
  return COMMANDS.filter((c) => c.mcp).map((c) => ({
    name: c.name,
    description: c.mcp.description,
    inputSchema: c.mcp.inputSchema,
    handler: (args) => c.mcp.call(ctx, args),
  }));
}
