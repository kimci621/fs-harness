import readline from 'node:readline';
import { readFileSync } from 'node:fs';
import { createGlab } from './glab.js';
import { loadConfig } from './config.js';
import { cmdMRS } from './commands/mrs.js';
import { cmdMR } from './commands/mr.js';
import { cmdMRComments } from './commands/mr-comments.js';
import { cmdJobs } from './commands/jobs.js';
import { cmdRun } from './commands/run.js';
import { cmdDeploy } from './commands/deploy.js';
import { cmdConflict } from './commands/conflict.js';
import { cmdCommit } from './commands/commit.js';
import { cmdDoctor } from './commands/doctor.js';
import { AGENT_GUIDE } from './commands/agent-guide.js';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

// Реестр инструментов: name, description (по нему модель решает, что вызывать),
// inputSchema (JSON Schema, клиент валидирует аргументы), handler(args) → результат.
// Все side-effect инструменты ждут завершения и возвращают финальный {ok, ...}.
export function createMCPContext({ cfg, g, notify }) {
  const agentArgs = (agent) => (cfg.agentArgs || {})[agent] || [];
  const quietOpts = { json: true, asObject: true, quiet: true, yes: true };

  const tools = [
    {
      name: 'mrs',
      description: 'Список всех открытых MR: название, ветки, статус пайплайна, комментарии, конфликты. Только чтение.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: () => cmdMRS(g, cfg.repo, { json: true, asObject: true }),
    },
    {
      name: 'mr',
      description: 'Один MR по номеру (!2547, 2547) или части имени ветки (неточный поиск). Только чтение.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'номер MR (!2547) или часть имени source-ветки' } },
        required: ['query'],
      },
      handler: (a) => cmdMR(g, cfg.repo, a.query, { json: true, asObject: true }),
    },
    {
      name: 'mr_comments',
      description: 'Комментарии MR, сгруппированные по тредам. filter: all — все, resolved — только решённые, open — нерешённые. Только чтение.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'номер MR (!2547) или часть имени ветки' },
          filter: { type: 'string', enum: ['all', 'resolved', 'open'], default: 'all' },
        },
        required: ['query'],
      },
      handler: (a) => cmdMRComments(g, cfg.repo, [a.query], {
        json: true, asObject: true,
        resolved: a.filter === 'resolved', open: a.filter === 'open',
      }),
    },
    {
      name: 'jobs',
      description: 'Джобы последнего MR-пайплайна: stage, имя, статус, id. Только чтение.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'номер MR или часть имени ветки' } },
        required: ['query'],
      },
      handler: (a) => cmdJobs(g, cfg.repo, a.query, { json: true, asObject: true }),
    },
    {
      name: 'run',
      description: 'Запустить джобу (по имени или id) в последнем MR-пайплайне: manual → play, failed/canceled → retry. watch=true — дождаться завершения и вернуть финальный статус. Меняет состояние GitLab.',
      inputSchema: {
        type: 'object',
        properties: {
          job: { type: 'string', description: 'имя джобы (например build_image) или её id' },
          query: { type: 'string', description: 'номер MR или часть имени ветки' },
          watch: { type: 'boolean', default: false, description: 'ждать завершения джобы' },
        },
        required: ['job', 'query'],
      },
      handler: (a) => cmdRun(g, cfg.repo, [a.job, a.query], {
        ...quietOpts, watch: Boolean(a.watch), onTick: notify,
      }),
    },
    {
      name: 'deploy',
      description: 'Деплой ветки MR: запустить build, дождаться success, затем запустить deploy_dev (slot=1) или deploy_dev2..deploy_dev10 (slot=N) и дождаться. rebuild=true — перезапустить даже уже успешные джобы (перезаписать слот). Ждёт завершения, возвращает финальный статус. Меняет состояние GitLab.',
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
      handler: (a) => cmdDeploy(g, cfg.repo, [a.query, a.slot], {
        ...quietOpts, rebuild: Boolean(a.rebuild), buildJob: a.build_job, onTick: notify,
      }),
    },
    {
      name: 'conflict',
      description: 'Решить конфликт MR силами AI-агента (claude или pi, headless) во временном git worktree проекта, запушить в ветку MR и запустить build-джобу. Ждёт завершения. Меняет код и GitLab; ветка target не трогается, force-push запрещён.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'номер MR или часть имени ветки' },
          agent: { type: 'string', enum: ['claude', 'pi'], description: 'какой агент решает конфликт' },
        },
        required: ['query'],
      },
      handler: (a) => cmdConflict(g, cfg.repo, [a.query], {
        ...quietOpts, agent: a.agent || cfg.agent, projectDir: cfg.projectDir,
        agentArgs: agentArgs(a.agent || cfg.agent), onTick: notify,
      }),
    },
    {
      name: 'commit',
      description: 'Агент (claude или pi) изучает git diff, формирует сообщение коммита по паттерну проекта (.llm-commit-pattern или встроенный) и коммитит все изменения. Push не делает. Меняет локальный git-репозиторий.',
      inputSchema: {
        type: 'object',
        properties: {
          dir: { type: 'string', description: 'каталог репозитория (по умолчанию текущий)' },
          agent: { type: 'string', enum: ['claude', 'pi'] },
        },
      },
      handler: (a) => cmdCommit([], {
        ...quietOpts, agent: a.agent || cfg.agent, projectDir: a.dir,
        agentArgs: agentArgs(a.agent || cfg.agent),
      }),
    },
    {
      name: 'doctor',
      description: 'Самодиагностика: glab, конфиг, доступ к API, git-репозиторий, наличие агентов. Только чтение.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: () => cmdDoctor({ repo: cfg.repo, host: cfg.host, projectDir: cfg.projectDir, json: true, asObject: true }),
    },
    {
      name: 'agent_guide',
      description: 'Полная инструкция по работе с gl-helper: команды, флаги, JSON-схемы, коды ошибок. Вызови первой, если не знаешь, как работать с инструментами.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: () => ({ ok: true, guide: AGENT_GUIDE }),
    },
  ];
  return { tools };
}

// Обработка одного JSON-RPC запроса. Чистая функция — покрыта тестами.
export async function handleMessage(method, params, ctx) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(params?.protocolVersion) ? params.protocolVersion : '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'gl-helper', version: VERSION },
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: ctx.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
    case 'tools/call':
      return await callTool(params, ctx);
    default:
      throw new Error(`неизвестный метод: ${method}`);
  }
}

async function callTool(params, ctx) {
  const tool = ctx.tools.find((t) => t.name === params?.name);
  if (!tool) throw new Error(`неизвестный инструмент: ${params?.name}`);
  try {
    const result = await tool.handler(params?.arguments || {});
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    const code = typeof err?.code === 'string' ? err.code : 'error';
    const body = { ok: false, error: { code, message: String(err?.message || err) } };
    return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], isError: true };
  }
}

// stdio-цикл: строка = одно JSON-RPC сообщение. stdout занят только протоколом.
export async function runMCPServer() {
  const cfg = loadConfig();
  const g = createGlab(undefined, { host: cfg.host });
  const write = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
  const notify = (text) => write({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'log', data: { text } } });
  const ctx = createMCPContext({ cfg, g, notify });

  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // не JSON — пропускаем, stdout не трогаем
    }
    if (msg.id === undefined || msg.id === null) return; // нотификации игнорируем
    try {
      const result = await handleMessage(msg.method, msg.params || {}, ctx);
      write({ jsonrpc: '2.0', id: msg.id, result });
    } catch (err) {
      write({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(err?.message || err) } });
    }
  });

  // Держим процесс живым, пока клиент не закроет stdin.
  rl.on('close', () => process.exit(0));
  await new Promise(() => {});
}
