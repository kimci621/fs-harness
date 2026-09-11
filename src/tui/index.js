import { CliError } from '../errors.js';

// TUI стартует только в живом терминале: --json, MCP и пайпы обязаны остаться
// текстовыми. Никакого «умного» определения режима.
export async function startTUI(ctx, opts = {}) {
  if (opts.json || opts.asObject || !process.stdout.isTTY || !process.stdin.isTTY) {
    throw new CliError('TUI нужен живой терминал: без него пользуйся командами (fsh help).', 1, 'tui_requires_tty');
  }
  // Ink и react тянутся только здесь: CLI-запуск не должен платить за них стартом.
  const [{ render }, React, { App }] = await Promise.all([import('ink'), import('react'), import('./app.js')]);
  const app = render(React.createElement(App, { ctx, opts }), { exitOnCtrlC: true });
  await app.waitUntilExit();
  return 0;
}
