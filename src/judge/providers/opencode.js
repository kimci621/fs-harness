import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnAgent } from '../../agent/spawn.js';
import { CliError } from '../../errors.js';

// Судья через opencode run: подписка OpenCode Go к API напрямую не пускает (нужна сессия opencode).
// Запуск в пустой папке с opencode.json без инструментов: иначе текст из диффа может запустить shell.
export function createOpencodeProvider(profile) {
  const bin = profile.bin ?? 'opencode';
  if (!profile.model) throw new CliError('Профиль судьи opencode без model (provider/model).', 1, 'config_invalid');

  return {
    name: 'opencode',
    schemaStrength: 'prompt',
    model: profile.model,

    async complete({ system, user, effort = profile.effort, signal, onDelta }) {
      const model = effort ? `${profile.model}#${effort}` : profile.model;
      const cwd = mkdtempSync(path.join(tmpdir(), 'fsh-judge-oc-'));
      writeFileSync(path.join(cwd, 'opencode.json'), '{"tools":{"*":false}}\n');
      const input = system ? `${system}\n\n${user}` : user;
      const run = spawnAgent({ bin, args: ['run', '-m', model, '--format', 'json', '--archived'], input, cwd, env: process.env, signal });

      const texts = [];
      const usage = { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0 };
      let cost = 0;
      let sessionId;
      let failure = null;
      run.events.on((ev) => {
        if (ev.t !== 'log') return;
        if (ev.stream === 'stderr') return onDelta?.(ev.text);
        let e;
        try { e = JSON.parse(ev.text); } catch { return onDelta?.(ev.text); }
        sessionId ??= e.sessionID;
        if (e.type === 'error') failure = e.error?.message ?? JSON.stringify(e.error);
        else if (e.type === 'text' && e.part?.text) texts.push(e.part.text);
        else if (e.type === 'step_finish') {
          const t = e.part?.tokens ?? {};
          usage.input_tokens += t.input ?? 0;
          usage.output_tokens += t.output ?? 0;
          usage.reasoning_tokens += t.reasoning ?? 0;
          cost += e.part?.cost ?? 0;
          onDelta?.('шаг судьи завершён');
        }
      });

      let done;
      try {
        done = await run.result;
      } catch (err) {
        throw new CliError(`Судья: не удалось запустить ${bin}: ${err.message}`, 1, 'judge_failed');
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
      if (failure) throw new CliError(`Судья (${model}): ${failure}`, 1, 'judge_failed');
      if (!done.ok) {
        const how = done.signal ? `прерван (${done.signal})` : `завершился с кодом ${done.code}`;
        throw new CliError(`Судья: ${bin} ${how}.`, 1, 'judge_failed');
      }
      if (!texts.length) throw new CliError(`Судья: ${bin} не вернул текста (--format json).`, 1, 'judge_failed');
      return { text: texts.join(''), model, usage, cost, sessionId };
    },
  };
}
