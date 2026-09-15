import { spawnAgent } from '../../agent/spawn.js';
import { resolveAgent } from '../../agents.js';
import { parseClaudeLine } from '../../agent/stream.js';
import { CliError } from '../../errors.js';

// Судья через claude CLI: процесс, а не HTTP. По подписке ключ не нужен, но profile.agent
// уводит судью на другой профиль провайдера (cc, ccq, cco, ccd) вместе с его env и ключом.
// Схему гарантировать не может, поэтому выпрашивает её текстом; проверяет всё равно judge().
export function createCliProvider(profile, cfg) {
  const agent = profile.agent ? resolveAgent(cfg, profile.agent) : null;
  const bin = agent?.bin ?? profile.bin ?? 'claude';

  return {
    name: 'cli',
    schemaStrength: 'prompt',
    model: profile.model ?? 'opus',

    async complete({ system, user, effort = profile.effort, signal, onDelta }) {
      // stream-json, а не json: в одиночном JSON судья молчит до самого конца, а его проверка
      // идёт минуты — без потока активности она неотличима от зависания (живой случай:
      // «судья завершился с кодом 143» после полной тишины).
      const args = ['--restricted', '--output-format', 'stream-json', '--verbose'];
      if (profile.model) args.push('--model', profile.model);
      if (effort) args.push('--effort', effort);
      if (system) args.push('--append-system-prompt', system);
      args.push('-p');

      // Задание уходит в stdin: дифф в приёмке бывает в сотни килобайт, argv столько не держит.
      // Флаги профиля агента не берём: у судьи свой набор, и --restricted с ними конфликтует.
      const run = spawnAgent({ bin, args, input: user, cwd: profile.cwd, env: agent ? { ...process.env, ...agent.env } : undefined, signal });
      let resultEnvelope = null;
      run.events.on((ev) => {
        if (ev.t !== 'log') return;
        if (ev.stream === 'stderr') {
          onDelta?.(ev.text); // предупреждения claude видны сразу, а не после проверки
          return;
        }
        const { activity, result, envelope, passthrough } = parseClaudeLine(ev.text);
        if (result !== null) {
          resultEnvelope = envelope ?? { result };
          return;
        }
        if (activity) onDelta?.(activity);
        else if (passthrough) onDelta?.(passthrough);
      });

      let done;
      try {
        done = await run.result;
      } catch (err) {
        throw new CliError(`Судья: не удалось запустить ${bin}: ${err.message}`, 1, 'judge_failed');
      }
      if (!done.ok) {
        const how = done.signal ? `прерван (${done.signal})` : `завершился с кодом ${done.code}`;
        throw new CliError(`Судья: ${bin} ${how}.`, 1, 'judge_failed');
      }
      if (!resultEnvelope) {
        throw new CliError(`Судья: ${bin} не вернул результата (--output-format stream-json).`, 1, 'judge_failed');
      }
      if (resultEnvelope.is_error || (resultEnvelope.subtype && resultEnvelope.subtype !== 'success')) {
        throw new CliError(
          `Судья: ${bin} отчитался ошибкой (${resultEnvelope.subtype ?? 'is_error'}). ${String(resultEnvelope.result ?? '').slice(0, 300)}`,
          1,
          'judge_failed',
        );
      }

      return {
        text: String(resultEnvelope.result ?? ''),
        model: resultEnvelope.modelUsage ? Object.keys(resultEnvelope.modelUsage)[0] : profile.model,
        usage: resultEnvelope.usage ?? {},
        cost: resultEnvelope.total_cost_usd ?? 0,
        sessionId: resultEnvelope.session_id,
      };
    },
  };
}
