import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { Verdict } from '../schema.js';
import { readSecret } from '../../secrets.js';
import { CliError } from '../../errors.js';

// Один адаптер на всё OpenAI-совместимое: OpenRouter, DeepSeek, LM Studio.
// Отличаются только baseUrl, моделью и ключом.
export function buildBody(profile, { system, user, effort }) {
  const schema = profile.schema ?? 'json_schema';
  const format =
    schema === 'json_schema' ? { response_format: zodResponseFormat(Verdict, 'verdict') }
    : schema === 'json_object' ? { response_format: { type: 'json_object' } }
    : {}; // prompt — схему выпрашиваем текстом, как у cli
  return {
    model: profile.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    // effort у нас общий на адаптеры; кто не понимает reasoning_effort — игнорирует.
    ...(effort ? { reasoning_effort: effort } : {}),
    ...format,
  };
}

export function createOpenAIProvider(profile, { makeClient } = {}) {
  if (!profile.baseUrl) throw new CliError('Профиль судьи openai без baseUrl.', 1, 'config_invalid');
  if (!profile.model) throw new CliError('Профиль судьи openai без model.', 1, 'config_invalid');
  // Локальной LM Studio ключ не нужен, но SDK без apiKey не собирается.
  const client = (makeClient ?? ((o) => new OpenAI(o)))({
    apiKey: profile.secret ? readSecret(profile.secret) : 'local',
    baseURL: profile.baseUrl,
    maxRetries: profile.retries ?? 2,
  });

  return {
    name: 'openai',
    schemaStrength: profile.schema ?? 'json_schema',
    model: profile.model,

    async complete({ system, user, effort = profile.effort, signal, onDelta }) {
      let final;
      try {
        // Стрим, а не create: у undici headersTimeout 300 секунд, судья по большому
        // диффу на нестриминговом запросе в него упирается.
        const stream = client.chat.completions.stream(buildBody(profile, { system, user, effort }), { signal });
        if (onDelta) stream.on('content', (delta) => onDelta(delta));
        final = await stream.finalChatCompletion();
      } catch (err) {
        throw new CliError(`Судья (${profile.baseUrl}, ${profile.model}): ${err.message}`, 1, 'judge_failed');
      }

      return {
        text: final.choices?.[0]?.message?.content ?? '',
        model: final.model ?? profile.model,
        usage: final.usage ?? {},
        cost: final.usage?.cost ?? 0, // цену в usage кладёт OpenRouter; у остальных её нет
        sessionId: final.id ?? null,
      };
    },
  };
}
