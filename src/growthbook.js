import { CliError } from './errors.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const backoff = (attempt, unit) => unit * 2 ** (attempt - 1); // 1с, 2с, 4с

// GrowthBook REST: фича-флаги. Форма та же, что у jira.js — один api() с ретраями,
// поверх методы. fetchImpl инжектируется ради тестов без сети.
export function createGrowthBook({ baseUrl, token, fetchImpl = fetch, sleepMs = 1000 } = {}) {
  if (!baseUrl) {
    throw new CliError('GrowthBook не настроен: нужен growthbook.baseUrl в конфиге (адрес API, не веб-интерфейса).', 1, 'config_invalid');
  }
  const root = baseUrl.replace(/\/+$/, '');

  async function api(path, { method = 'GET', body, retries = 3 } = {}) {
    let lastErr;
    for (let attempt = 1; attempt <= retries; attempt++) {
      let res;
      try {
        res = await fetchImpl(`${root}${path}`, {
          method,
          headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
      } catch (err) {
        lastErr = err;
        if (attempt === retries) throw new CliError(`GrowthBook недоступен: ${err.message}`, 1, 'api_failed');
        await sleep(backoff(attempt, sleepMs));
        continue;
      }
      if (res.ok) return res.status === 204 ? null : res.json();
      if (res.status === 401 || res.status === 403) {
        throw new CliError(`GrowthBook отклонил ключ (${res.status}). Проверь ~/.growthbook_apikey.`, 1, 'api_failed');
      }
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        await sleep(backoff(attempt, sleepMs));
        continue;
      }
      const detail = await errorText(res);
      throw new CliError(`GrowthBook ${method} ${path.replace(/\?.*$/, '')} → ${res.status}.${detail ? ` ${detail}` : ''}`, 1, 'api_failed');
    }
    throw new CliError(`GrowthBook ${method} ${path} не удался: ${lastErr?.message ?? 'нет ответа'}`, 1, 'api_failed');
  }

  return {
    api,

    // Постранично: флагов в проекте сотни, а limit у API 100.
    async features({ project, limit = 100, offset = 0 } = {}) {
      const q = new URLSearchParams({ limit: String(limit), offset: String(offset), ...(project ? { projectId: project } : {}) });
      const res = await api(`/api/v1/features?${q}`);
      return { features: res.features ?? [], total: res.total ?? 0, nextOffset: res.hasMore ? res.nextOffset : null };
    },

    feature: (id) => api(`/api/v1/features/${encodeURIComponent(id)}`).then((r) => r.feature ?? r),

    createFeature: (body) => api('/api/v1/features', { method: 'POST', body }).then((r) => r.feature ?? r),

    // Отдельный эндпоинт, а не PUT: включение флага в окружении требует причины для аудита.
    toggleFeature: (id, environments, reason) =>
      api(`/api/v1/features/${encodeURIComponent(id)}/toggle`, { method: 'POST', body: { reason, environments } }).then((r) => r.feature ?? r),
  };
}

async function errorText(res) {
  try {
    const body = await res.json();
    return body.message ?? body.error ?? '';
  } catch {
    return '';
  }
}

// Состояние флага по окружениям одной строкой: production=off dev=on.
export const envStates = (f) =>
  Object.entries(f?.environments ?? {}).map(([name, e]) => `${name}=${e.enabled ? 'on' : 'off'}`).join(' ');
