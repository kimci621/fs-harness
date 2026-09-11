import readline from 'node:readline';
import { readFileSync } from 'node:fs';
import { createGlab } from './glab.js';
import { loadConfig } from './config.js';
import { createCtx, mcpTools } from './registry.js';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

// Инструменты берутся из единого реестра (src/registry.js): имя, description
// (по нему модель маршрутизирует), inputSchema (JSON Schema), handler.
export function createMCPContext({ cfg, g, notify }) {
  const ctx = createCtx({ cfg, g, notify });
  return { tools: mcpTools(ctx) };
}

// Обработка одного JSON-RPC запроса. Чистая функция — покрыта тестами.
export async function handleMessage(method, params, ctx) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(params?.protocolVersion) ? params.protocolVersion : '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'fs-harness', version: VERSION },
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
