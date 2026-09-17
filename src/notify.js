import { CliError } from './errors.js';
import { readSecret } from './secrets.js';

// Исходящие уведомления в Telegram: отправка сообщений через Bot API (sendMessage).

// Одна строка про завершившийся ран: что делали, чем кончилось, почём.
export function runMessage({ action, target, ok, cost = 0, verdict, error, url }) {
  const parts = [`${ok ? '✅' : '❌'} ${action}${target ? ` ${target}` : ''}`];
  if (verdict) parts.push(`судья: ${verdict.decision} (${verdict.confidence.toFixed(2)})`);
  if (cost) parts.push(`$${cost.toFixed(4)}`);
  if (error) parts.push(error.split('\n')[0]);
  if (url) parts.push(url);
  return parts.join(' · ');
}

// Извлекает токен бота и chat_id из конфига/env/keychain. Если хотя бы одного нет — возвращает null.
export function getTelegramTarget(cfg = {}, { env = process.env, readSecretImpl = readSecret } = {}) {
  const tg = cfg.telegram || {};
  const chatId = tg.chat_id || env.TELEGRAM_CHAT_ID;
  const token = tg.bot_token || readSecretImpl('telegram', { env, required: false });
  if (!chatId || !token) return null;
  return { chatId, token };
}

export async function postTelegram({ token, chatId }, text, { fetchImpl = fetch, signal } = {}) {
  let res;
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal,
    });
  } catch (err) {
    throw new CliError(`Telegram недоступен: ${err.message}`, 1, 'telegram_failed');
  }
  if (!res.ok) {
    const errText = (await res.text?.().catch(() => '')) ?? '';
    let desc = '';
    try {
      desc = JSON.parse(errText).description;
    } catch {}
    throw new CliError(`Telegram ответил ${res.status}${desc ? `: ${desc}` : ''}.`, 1, 'telegram_failed');
  }
  return true;
}
