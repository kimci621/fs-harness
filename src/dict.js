import { CliError } from './errors.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const backoff = (attempt, unit) => unit * 2 ** (attempt - 1); // 1с, 2с, 4с

// REST словаря бэкенда (system/dictionary-item). Форма та же, что у growthbook.js:
// один api() с ретраями, fetchImpl инжектируется ради тестов без сети.
// Аутентификация — заголовок rest-token, не Bearer.
export function createDict({ baseUrl, token, fetchImpl = fetch, sleepMs = 1000 } = {}) {
  if (!baseUrl) {
    throw new CliError('Словарь не настроен: нужен dict.baseUrl в конфиге — REST-корень бэкенда, например https://core.dev6.nwh.ru/rest/v4.', 1, 'config_invalid');
  }
  const root = baseUrl.replace(/\/+$/, '');

  async function api(path, { method = 'GET', body, retries = 3 } = {}) {
    let lastErr;
    for (let attempt = 1; attempt <= retries; attempt++) {
      let res;
      try {
        res = await fetchImpl(`${root}${path}`, {
          method,
          headers: { 'rest-token': token ?? '', accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
      } catch (err) {
        lastErr = err;
        if (attempt === retries) throw new CliError(`Словарь недоступен: ${err.message}`, 1, 'api_failed');
        await sleep(backoff(attempt, sleepMs));
        continue;
      }
      if (res.ok) return res.status === 204 ? null : res.json();
      if (res.status === 401 || res.status === 403) {
        throw new CliError(`Словарь отклонил запрос (${res.status}). Проверь rest-token: REST_TOKEN из .env бэкенда — в keychain (fs-harness/dict), в FS_HARNESS_DICT_TOKEN или в файл с REST_TOKEN=…`, 1, 'api_failed');
      }
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        await sleep(backoff(attempt, sleepMs));
        continue;
      }
      const detail = await errorText(res);
      throw new CliError(`Словарь ${method} ${path} → ${res.status}.${detail ? ` ${detail}` : ''}`, 1, 'api_failed');
    }
    throw new CliError(`Словарь ${method} ${path} не удался: ${lastErr?.message ?? 'нет ответа'}`, 1, 'api_failed');
  }

  return {
    api,

    languages: () => api('/system/language').then((r) => r.languages ?? r.data ?? []),

    // Список отдаётся по 15 записей на страницу, параметров per_page/limit нет.
    items: ({ page = 1 } = {}) =>
      api(`/system/dictionary-item?page=${page}`).then((r) => ({ items: r.dictionary_items ?? r.data ?? [], page: r.meta?.page ?? {} })),

    item: (id) => api(`/system/dictionary-item/${encodeURIComponent(id)}`).then((r) => r.dictionary_item ?? r),

    create: (body) => api('/system/dictionary-item', { method: 'POST', body }).then((r) => r.dictionary_item ?? r),

    // PUT требует все четыре поля разом — частичной правки API не умеет.
    update: (id, body) => api(`/system/dictionary-item/${encodeURIComponent(id)}`, { method: 'PUT', body }).then((r) => r.dictionary_item ?? r),

    remove: (id) => api(`/system/dictionary-item/${encodeURIComponent(id)}`, { method: 'DELETE' }),

    // После записи кэш словаря надо перестроить, иначе стенд ещё секунды показывает старое.
    refresh: () => api('/system/dictionary/refresh', { method: 'POST' }),
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
