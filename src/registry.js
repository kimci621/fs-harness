import { cmdMRS } from './commands/mrs.js';
import { cmdMR } from './commands/mr.js';
import { cmdMRComments } from './commands/mr-comments.js';
import { cmdJobs } from './commands/jobs.js';
import { cmdRun } from './commands/run.js';
import { cmdDeploy } from './commands/deploy.js';
import { cmdConflict } from './commands/conflict.js';
import { cmdCommit } from './commands/commit.js';
import { cmdDoctor } from './commands/doctor.js';
import { buildAgentGuide, cmdAgentGuide } from './commands/agent-guide.js';
import { cmdConfig } from './config-cmd.js';

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

export function createCtx({ g, cfg, notify }) {
  return {
    g,
    repo: cfg.repo,
    cfg,
    notify,
    agentArgs: (agent) => (cfg.agentArgs || {})[agent] || [],
  };
}

export const COMMANDS = [
  {
    name: 'mrs',
    usage: 'mrs',
    description: 'Все открытые MR: название, ветки, пайплайн, комменты, конфликты',
    example: 'gl-helper mrs',
    run: (ctx, args, opts) => cmdMRS(ctx.g, ctx.repo, { json: opts.json }),
    mcp: {
      description: 'Список всех открытых MR: название, ветки, статус пайплайна, комментарии, конфликты. Только чтение.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      call: (ctx) => cmdMRS(ctx.g, ctx.repo, { json: true, asObject: true }),
    },
  },
  {
    name: 'mr',
    usage: 'mr <ветка|номер>',
    description: 'Один MR в том же формате (часть имени ветки, неточный поиск)',
    example: 'gl-helper mr special-offer',
    run: (ctx, args, opts) => cmdMR(ctx.g, ctx.repo, args[0], { json: opts.json }),
    mcp: {
      description: 'Один MR по номеру (!2547, 2547) или части имени ветки (неточный поиск). Только чтение.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'номер MR (!2547) или часть имени source-ветки' } },
        required: ['query'],
      },
      call: (ctx, a) => cmdMR(ctx.g, ctx.repo, a.query, { json: true, asObject: true }),
    },
  },
  {
    name: 'mr-comments',
    usage: 'mr-comments <mr|ветка>',
    description: 'Комментарии MR (--resolved / --open)',
    example: 'gl-helper mr-comments fix/main-banner -open',
    run: (ctx, args, opts) => cmdMRComments(ctx.g, ctx.repo, args, { json: opts.json, resolved: opts.resolved, open: opts.open }),
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
      call: (ctx, a) => cmdMRComments(ctx.g, ctx.repo, [a.query], {
        json: true, asObject: true,
        resolved: a.filter === 'resolved', open: a.filter === 'open',
      }),
    },
  },
  {
    name: 'jobs',
    usage: 'jobs <mr|ветка>',
    description: 'Джобы последнего MR-пайплайна',
    example: 'gl-helper jobs fix/main-banner',
    run: (ctx, args, opts) => cmdJobs(ctx.g, ctx.repo, args[0], { json: opts.json }),
    mcp: {
      description: 'Джобы последнего MR-пайплайна: stage, имя, статус, id. Только чтение.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'номер MR или часть имени ветки' } },
        required: ['query'],
      },
      call: (ctx, a) => cmdJobs(ctx.g, ctx.repo, a.query, { json: true, asObject: true }),
    },
  },
  {
    name: 'run',
    usage: 'run <джоба> <mr|ветка>',
    description: 'Запустить manual-джобу (по имени или id)',
    example: 'gl-helper run build_image fix/main-banner -w',
    run: (ctx, args, opts) => cmdRun(ctx.g, ctx.repo, args, { json: opts.json, watch: opts.watch, dryRun: opts.dryRun }),
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
      call: (ctx, a) => cmdRun(ctx.g, ctx.repo, [a.job, a.query], {
        json: true, asObject: true, quiet: true, yes: true, watch: Boolean(a.watch), onTick: ctx.notify,
      }),
    },
  },
  {
    name: 'deploy',
    usage: 'deploy <mr|ветка> [N]',
    description: 'build → ждать → deploy_dev (или deploy_dev2…10) → ждать',
    example: 'gl-helper deploy feat/premium-banner 3',
    run: (ctx, args, opts) => cmdDeploy(ctx.g, ctx.repo, args, {
      json: opts.json, buildJob: opts.buildJob, rebuild: opts.rebuild, dryRun: opts.dryRun,
    }),
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
      call: (ctx, a) => cmdDeploy(ctx.g, ctx.repo, [a.query, a.slot], {
        json: true, asObject: true, quiet: true, yes: true,
        rebuild: Boolean(a.rebuild), buildJob: a.build_job, onTick: ctx.notify,
      }),
    },
  },
  {
    name: 'conflict',
    usage: 'conflict <mr|ветка>',
    description: 'Решить конфликт силами AI-агента и запустить build',
    example: 'gl-helper conflict !2547 --agent pi',
    run: (ctx, args, opts) => {
      const agent = opts.agent || ctx.cfg.agent;
      return cmdConflict(ctx.g, ctx.repo, args, {
        agent,
        projectDir: opts.projectDir || ctx.cfg.projectDir,
        buildJob: opts.buildJob,
        json: opts.json,
        yes: opts.yes,
        keepWorktree: opts.keepWorktree,
        dryRun: opts.dryRun,
        agentArgs: ctx.agentArgs(agent),
      });
    },
    mcp: {
      description: 'Решить конфликт MR силами AI-агента (claude или pi, headless) во временном git worktree проекта, запушить в ветку MR и запустить build. Ждёт завершения. Меняет код и GitLab; ветка target не трогается, force-push запрещён.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'номер MR или часть имени ветки' },
          agent: { type: 'string', enum: ['claude', 'pi'], description: 'какой агент решает конфликт' },
        },
        required: ['query'],
      },
      call: (ctx, a) => {
        const agent = a.agent || ctx.cfg.agent;
        return cmdConflict(ctx.g, ctx.repo, [a.query], {
          json: true, asObject: true, quiet: true, yes: true,
          agent, projectDir: ctx.cfg.projectDir, agentArgs: ctx.agentArgs(agent), onTick: ctx.notify,
        });
      },
    },
  },
  {
    name: 'commit',
    usage: 'commit [--agent]',
    description: 'Сформировать и сделать коммит по паттерну (агент, без push)',
    example: 'gl-helper commit --agent pi',
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
    example: 'gl-helper doctor',
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
    example: 'gl-helper agent-guide',
    run: () => cmdAgentGuide(COMMANDS),
    mcp: {
      description: 'Полная инструкция по работе с gl-helper: команды, флаги, JSON-схемы, коды ошибок. Вызови первой, если не знаешь, как работать с инструментами.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      call: () => ({ ok: true, guide: buildAgentGuide(COMMANDS) }),
    },
  },
  {
    name: 'config',
    usage: 'config init|show',
    description: 'Настроить/показать ~/.config/gl-helper/config.json',
    example: 'gl-helper config init',
    run: (ctx, args) => cmdConfig(args),
  },
  {
    name: 'mcp',
    usage: 'mcp',
    description: 'MCP-сервер (stdio): инструменты для AI-клиентов',
    example: 'claude mcp add gl-helper -- gl-helper mcp',
    run: async () => (await import('./mcp.js')).runMCPServer(),
  },
];

export function findCommand(name) {
  return COMMANDS.find((c) => c.name === name) || null;
}

// Инструменты для MCP tools/list.
export function mcpTools(ctx) {
  return COMMANDS.filter((c) => c.mcp).map((c) => ({
    name: c.name,
    description: c.mcp.description,
    inputSchema: c.mcp.inputSchema,
    handler: (args) => c.mcp.call(ctx, args),
  }));
}
