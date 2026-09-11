import { CliError } from './errors.js';

// Исходящие уведомления в Mattermost: incoming webhook и обычный POST, без бота и websocket.
// Адрес webhook сам по себе ключ, поэтому берётся из конфига и никуда не печатается.

// Одна строка про завершившийся ран: что делали, чем кончилось, почём.
export function runMessage({ action, target, ok, cost = 0, verdict, error, url }) {
  const parts = [`${ok ? '✅' : '❌'} ${action}${target ? ` ${target}` : ''}`];
  if (verdict) parts.push(`судья: ${verdict.decision} (${verdict.confidence.toFixed(2)})`);
  if (cost) parts.push(`$${cost.toFixed(4)}`);
  if (error) parts.push(error.split('\n')[0]);
  if (url) parts.push(url);
  return parts.join(' · ');
}

export async function postMattermost(webhook, text, { fetchImpl = fetch, signal } = {}) {
  let res;
  try {
    res = await fetchImpl(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal,
    });
  } catch (err) {
    throw new CliError(`Mattermost недоступен: ${err.message}`, 1, 'mattermost_failed');
  }
  if (!res.ok) throw new CliError(`Mattermost ответил ${res.status}.`, 1, 'mattermost_failed');
  return true;
}
