import { spawnAgent } from '../../agent/spawn.js';
import { CliError } from '../../errors.js';

// Судья через claude CLI: процесс, а не HTTP. Ключ не нужен — идёт по подписке.
// Схему гарантировать не может, поэтому выпрашивает её текстом; проверяет всё равно judge().
export function createCliProvider(profile) {
  const bin = profile.bin ?? 'claude';

  return {
    name: 'cli',
    schemaStrength: 'prompt',
    model: profile.model ?? 'opus',

    async complete({ system, user, effort = profile.effort, signal, onDelta }) {
      const args = ['--restricted', '--output-format', 'json'];
      if (profile.model) args.push('--model', profile.model);
      if (effort) args.push('--effort', effort);
      if (system) args.push('--append-system-prompt', system);
      args.push('-p', user);

      const run = spawnAgent({ bin, args, cwd: profile.cwd, signal });
      const chunks = [];
      run.events.on((ev) => {
        if (ev.t !== 'log') return;
        if (ev.stream === 'stdout') chunks.push(ev.text);
        else onDelta?.(ev.text);
      });

      let done;
      try {
        done = await run.result;
      } catch (err) {
        throw new CliError(`Судья: не удалось запустить ${bin}: ${err.message}`, 1, 'judge_failed');
      }
      const stdout = chunks.join('\n');
      if (!done.ok) {
        throw new CliError(`Судья: ${bin} завершился с кодом ${done.code}.\n${stdout.slice(-500)}`, 1, 'judge_failed');
      }

      let envelope;
      try {
        envelope = JSON.parse(stdout);
      } catch {
        throw new CliError(`Судья: ${bin} вернул не JSON (--output-format json).\n${stdout.slice(0, 500)}`, 1, 'judge_failed');
      }
      if (envelope.is_error) {
        throw new CliError(`Судья: ${bin} отчитался ошибкой (${envelope.subtype}).`, 1, 'judge_failed');
      }

      return {
        text: String(envelope.result ?? ''),
        model: envelope.modelUsage ? Object.keys(envelope.modelUsage)[0] : profile.model,
        usage: envelope.usage ?? {},
        cost: envelope.total_cost_usd ?? 0,
        sessionId: envelope.session_id,
      };
    },
  };
}
