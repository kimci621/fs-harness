import { CliError } from './errors.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const backoff = (attempt, unit) => unit * 2 ** (attempt - 1); // 1с, 2с, 4с

// Mattermost REST: вход по логину и паролю, кто я, отправка сообщения.
// Форма та же, что у jira.js и growthbook.js — один api() с ретраями, поверх методы.
// fetchImpl инжектируется ради тестов без сети.
//
// Токен сессионный, а не бота: на self-hosted инстансе Personal Access Tokens выключены,
// и это единственный способ писать в чат от имени человека, а не от имени приложения.
export function createMattermost({ baseUrl, token = '', fetchImpl = fetch, sleepMs = 1000 } = {}) {
  if (!baseUrl) {
    throw new CliError('Mattermost не настроен: нужен mattermost.baseUrl в конфиге.', 1, 'config_invalid');
  }
  const root = baseUrl.replace(/\/+$/, '');

  // withRes — отдать сам ответ, а не тело: токен сессии приходит заголовком Token, а не в JSON.
  async function api(path, { method = 'GET', body, auth = true, withRes = false, allow404 = false, retries = 3 } = {}) {
    if (auth && !token) {
      throw new CliError('Нет токена Mattermost. Получи его: fsh mm login.', 1, 'secret_missing');
    }
    let lastErr;
    for (let attempt = 1; attempt <= retries; attempt++) {
      let res;
      try {
        res = await fetchImpl(`${root}/api/v4${path}`, {
          method,
          headers: {
            accept: 'application/json',
            ...(auth ? { authorization: `Bearer ${token}` } : {}),
            ...(body ? { 'content-type': 'application/json' } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
      } catch (err) {
        lastErr = err;
        if (attempt === retries) throw new CliError(`Mattermost недоступен: ${err.message}`, 1, 'api_failed');
        await sleep(backoff(attempt, sleepMs));
        continue;
      }
      if (res.ok) return withRes ? res : res.status === 204 ? null : res.json();
      if (allow404 && res.status === 404) return null;
      if (res.status === 401 || res.status === 403) {
        throw new CliError(
          `Mattermost отклонил токен (${res.status}). Сессия протухает при разлогине — получи новый: fsh mm login.`,
          1,
          'api_failed',
        );
      }
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        await sleep(backoff(attempt, sleepMs));
        continue;
      }
      throw new CliError(`Mattermost ${method} ${path} → ${res.status}.${await errorText(res)}`, 1, 'api_failed');
    }
    throw new CliError(`Mattermost ${method} ${path} не удался: ${lastErr?.message ?? 'нет ответа'}`, 1, 'api_failed');
  }

  return {
    api,

    me: () => api('/users/me'),

    channel: (id) => api(`/channels/${id}`),

    teams: () => api('/users/me/teams'),

    // Каналы, в которых я состою: искать по всем каналам инстанса прав нет, да и незачем.
    myChannels: (teamId) => api(`/users/me/teams/${teamId}/channels`),

    // Имя канала из URL (frontend-merge-requests), а не отображаемое. Нет такого — null.
    channelByName: (team, name) => api(`/teams/name/${team}/channels/name/${name}`, { allow404: true }),

    // Токен сессии отдаётся заголовком Token, тело — это профиль вошедшего.
    async login({ loginId, password, mfa }) {
      const res = await api('/users/login', {
        method: 'POST',
        auth: false,
        withRes: true,
        retries: 1, // пароль не повторяем: на второй попытке инстанс считает это перебором
        body: { login_id: loginId, password, ...(mfa ? { token: mfa } : {}) },
      });
      const fresh = res.headers?.get?.('token') ?? '';
      if (!fresh) {
        throw new CliError('Mattermost принял вход, но не отдал токен сессии (заголовок Token пуст).', 1, 'api_failed');
      }
      return { token: fresh, user: await res.json() };
    },

    // rootId — ответ в тред; без него сообщение уходит в канал отдельным постом.
    post: (channelId, message, { rootId = '' } = {}) =>
      api('/posts', { method: 'POST', body: { channel_id: channelId, message, ...(rootId ? { root_id: rootId } : {}) } }),
  };
}

// Сообщение о том, что задача уехала в ревью. Первой строчкой — заголовок задачи (как в GitLab),
// затем ссылки на MR и Jira.
export function reviewMessage({ iid, mrUrl, key, issueUrl, title }) {
  const lines = [];
  const cleanTitle = String(title ?? '').replace(/^\s*(draft|wip):\s*/i, '').trim();
  if (cleanTitle) lines.push(cleanTitle);
  if (iid && mrUrl) lines.push(`• MR !${iid}: ${mrUrl}`);
  if (key && issueUrl) lines.push(`• Jira ${key} ${issueUrl}`);
  if (!lines.length) throw new CliError('Нечего отправлять: нет ни MR, ни задачи.', 1, 'usage');
  return lines.join('\n');
}

async function errorText(res) {
  try {
    const { message = '', id = '' } = await res.json();
    return message ? ` ${message}${id ? ` (${id})` : ''}` : '';
  } catch {
    return '';
  }
}
