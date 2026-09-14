import { createCliProvider } from './cli.js';
import { CliError } from '../../errors.js';

// Провайдеров два: cli (процесс claude) и openai (всё OpenAI-совместимое —
// OpenRouter, DeepSeek, LM Studio, различаются только baseUrl и ключом).
// openai грузится динамически: без него фаза 1 закрывается, а SDK тянуть зря не хочется.
export async function createProvider(profile, cfg) {
  if (!profile || typeof profile !== 'object') {
    throw new CliError('Профиль судьи не задан.', 1, 'config_invalid');
  }
  if (profile.provider === 'cli') return createCliProvider(profile, cfg);
  if (profile.provider === 'openai') {
    const { createOpenAIProvider } = await import('./openai.js');
    return createOpenAIProvider(profile);
  }
  throw new CliError(`Неизвестный провайдер судьи "${profile.provider}". Допустимо: cli, openai.`, 1, 'config_invalid');
}
