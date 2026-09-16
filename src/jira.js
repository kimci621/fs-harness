import { CliError } from './errors.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Jira REST: чтение плюс записи — статус, спринт, комментарий, поля, создание и удаление задачи.
// fetchImpl инжектируется ради тестов без сети.
// Форма та же, что у glab.js: один низкоуровневый api() с ретраями, поверх — методы.
export function createJira({ baseUrl, email, token, fetchImpl = fetch, sleepMs = 1000 } = {}) {
  if (!baseUrl || !email) {
    throw new CliError('Jira не настроена: нужны jira.baseUrl и jira.email в конфиге (fsh config init).', 1, 'config_invalid');
  }
  const root = baseUrl.replace(/\/+$/, '');
  const auth = `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;

  // Какой поиск понял инстанс, запоминаем: пробовать обе ветки на каждый вызов незачем.
  let searchPath = null;

  async function api(path, { method = 'GET', body, retries = 4, allow404 = false } = {}) {
    let lastErr;
    for (let attempt = 1; attempt <= retries; attempt++) {
      let res;
      try {
        res = await fetchImpl(`${root}${path}`, {
          method,
          headers: { authorization: auth, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
      } catch (err) {
        lastErr = err;
        if (attempt === retries) throw new CliError(`Jira недоступна: ${err.message}`, 1, 'api_failed');
        await sleep(backoff(attempt, sleepMs));
        continue;
      }
      if (res.ok) return res.status === 204 ? null : res.json();
      if (allow404 && (res.status === 404 || res.status === 410)) return { gone: true };
      if (res.status === 401 || res.status === 403) {
        throw new CliError(`Jira отклонила токен (${res.status}). Проверь ключ: security find-generic-password -s fs-harness -a jira -w`, 1, 'api_failed');
      }
      // 429 и 5xx — ждём и повторяем, Retry-After уважаем.
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const after = Number(res.headers?.get?.('retry-after'));
        const delay = Number.isFinite(after) && after > 0 ? after * sleepMs : backoff(attempt, sleepMs);
        process.stderr.write(`\r\x1b[K⏳ Jira ответила ${res.status}, попытка ${attempt}/${retries}, повтор через ${Math.round(delay / sleepMs)}с…\n`);
        await sleep(delay);
        continue;
      }
      // Тело ошибки Jira несёт список обязательных полей — без него 400 не диагностируется.
      const detail = await errorText(res);
      throw new CliError(`Jira ${method} ${path.replace(/\?.*$/, '')} → ${res.status}.${detail ? ` ${detail}` : ''}`, 1, 'api_failed');
    }
    throw new CliError(`Jira ${method} ${path} не удался: ${lastErr?.message ?? 'нет ответа'}`, 1, 'api_failed');
  }

  return {
    api,

    myself: () => api('/rest/api/3/myself'),

    // Новый /search/jql есть не на всех инстансах: 404/410 уводит на старый GET /search.
    async searchJql({ jql, fields = ['summary', 'status', 'updated', 'issuetype', 'priority'], max = 50, cursor } = {}) {
      if (searchPath !== '/rest/api/3/search') {
        const res = await api('/rest/api/3/search/jql', {
          method: 'POST',
          body: { jql, fields, maxResults: max, ...(cursor ? { nextPageToken: cursor } : {}) },
          allow404: searchPath === null,
        });
        if (!res?.gone) {
          searchPath = '/rest/api/3/search/jql';
          return { issues: res.issues ?? [], cursor: res.nextPageToken ?? null };
        }
        searchPath = '/rest/api/3/search';
      }
      const q = new URLSearchParams({ jql, fields: fields.join(','), maxResults: String(max), startAt: String(cursor ?? 0) });
      const res = await api(`/rest/api/3/search?${q}`);
      const next = (res.startAt ?? 0) + (res.issues?.length ?? 0);
      return { issues: res.issues ?? [], cursor: next < (res.total ?? 0) ? next : null };
    },

    // v2, а не v3: description приходит текстом, а не ADF-деревом — флаттенер не нужен.
    // expand=names даёт карту id → имя поля: кастомные поля ищутся по названию,
    // а не по customfield_10341, который в каждом проекте свой.
    issue: (key) => api(`/rest/api/2/issue/${encodeURIComponent(key)}?expand=renderedFields,names`),

    comments: (key) => api(`/rest/api/2/issue/${encodeURIComponent(key)}/comment?maxResults=50`),

    transitions: (key) => api(`/rest/api/2/issue/${encodeURIComponent(key)}/transitions`),

    // Запись 1. Ответ пустой (204), новый статус проверяем чтением.
    transition: (key, id) =>
      api(`/rest/api/2/issue/${encodeURIComponent(key)}/transitions`, { method: 'POST', body: { transition: { id: String(id) } }, retries: 1 }),

    // Статусы проекта приходят пачками по типам задач — имена дублируются, их дедуплицирует вызов.
    statuses: (projectKey) => api(`/rest/api/2/project/${encodeURIComponent(projectKey)}/statuses`),

    projectUsers: (projectKey) =>
      api(`/rest/api/2/user/assignable/search?project=${encodeURIComponent(projectKey)}&maxResults=50`),

    // Доски и спринты живут в отдельном agile-API, в /rest/api их нет.
    boards: (projectKey) => api(`/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(projectKey)}&maxResults=50`),

    // Колонки доски — не статусы проекта: это настройка доски, и именно её человек видит в Jira.
    boardConfig: (boardId) => api(`/rest/agile/1.0/board/${boardId}/configuration`),

    sprints: (boardId) => api(`/rest/agile/1.0/board/${boardId}/sprint?state=active,future&maxResults=50`),

    // Запись 2. Через agile-API, а не PUT поля: id спринтового customfield у каждого проекта свой.
    moveToSprint: (sprintId, keys) =>
      api(`/rest/agile/1.0/sprint/${sprintId}/issue`, { method: 'POST', body: { issues: keys }, retries: 1 }),

    // Запись 3. v2 принимает тело комментария обычным текстом, ADF собирать не надо.
    addComment: (key, text) =>
      api(`/rest/api/2/issue/${encodeURIComponent(key)}/comment`, { method: 'POST', body: { body: text }, retries: 1 }),

    // Что у этой задачи вообще разрешено править и чем: схема поля и, если есть,
    // готовый список значений. Без него форму значения пришлось бы угадывать.
    editMeta: (key) => api(`/rest/api/2/issue/${encodeURIComponent(key)}/editmeta`),

    assignableUsers: (key) =>
      api(`/rest/api/2/user/assignable/search?issueKey=${encodeURIComponent(key)}&maxResults=50`),

    // Запись 4. Одним PUT правится любое поле — форму значения берём из editmeta.
    updateIssue: (key, fields) =>
      api(`/rest/api/2/issue/${encodeURIComponent(key)}`, { method: 'PUT', body: { fields }, retries: 1 }),

    // Типы задач проекта для создания: createmeta отдаёт id, который нужен в POST.
    // С полями (expand) — только когда они нужны: id customfield_* у каждого проекта свой,
    // без createmeta их не узнать, а editmeta в creating-контексте не работает (нет задачи).
    createTypes: (projectKey) =>
      api(`/rest/api/2/issue/createmeta?projectKeys=${encodeURIComponent(projectKey)}&expand=projects`)
        .then((meta) => meta?.projects?.[0]?.issuetypes ?? []),

    createMeta: (projectKey, issueTypeId) =>
      api(
        `/rest/api/2/issue/createmeta?projectKeys=${encodeURIComponent(projectKey)}&issuetypeIds=${encodeURIComponent(issueTypeId)}&expand=projects.issuetypes.fields`,
      ).then((meta) => meta?.projects?.[0]?.issuetypes?.[0] ?? null),

    // Запись 5. Создание: Jira сама скажет, каких полей не хватило (см. errorText).
    createIssue: (fields) => api('/rest/api/2/issue', { method: 'POST', body: { fields }, retries: 1 }),

    // Запись 6. Удаление необратимо, 204 = удалена.
    deleteIssue: (key) =>
      api(`/rest/api/2/issue/${encodeURIComponent(key)}`, { method: 'DELETE', retries: 1, allow404: true }),
  };
}

// Из ответа Jira достаём errorMessages и errors: по ним видно, какого поля не хватило.
async function errorText(res) {
  try {
    const body = await res.json();
    const fields = Object.entries(body.errors ?? {}).map(([k, v]) => `${k}: ${v}`);
    return [...(body.errorMessages ?? []), ...fields].join('; ');
  } catch {
    return '';
  }
}

const backoff = (attempt, unit) => unit * 2 ** (attempt - 1); // 1с, 2с, 4с

export const ISSUE_KEY = /^[A-Z][A-Z0-9]+-\d+$/;

// Кастомные поля ищем по названию: id вида customfield_10341 в каждом проекте свой,
// а expand=names отдаёт карту id → имя ровно для этой задачи.
export function fieldByName(issue, name) {
  const entry = Object.entries(issue?.names ?? {}).find(([, n]) => n === name);
  return entry ? issue.fields?.[entry[0]] : undefined;
}

// id поля по названию: без него PUT некуда адресовать — customfield_* в каждом проекте свой.
export function fieldIdByName(issue, name) {
  return Object.entries(issue?.names ?? {}).find(([, n]) => n === name)?.[0] ?? null;
}

// Чем править поле, говорит его схема из editmeta: готовый список, строка, число
// или внешний редактор. null — значит нечем (вложения, связи, трекинг времени).
export function editKind(meta) {
  const s = meta?.schema ?? {};
  if (meta?.allowedValues?.length || s.type === 'user' || s.items === 'user') return 'pick';
  if (s.type === 'array' && s.items === 'string') return 'list';
  if (s.type === 'string') return s.system === 'description' || s.system === 'environment' || /textarea/.test(s.custom ?? '') ? 'editor' : 'text';
  if (s.type === 'number') return 'number';
  if (s.type === 'date' || s.type === 'datetime') return 'text';
  return null;
}

// Форма значения для PUT считается по схеме из editmeta, а не угадывается по текущему значению:
// пустое поле не подсказывает, ждёт оно объект или массив.
export function editValueFor(meta, option) {
  const type = meta?.schema?.type;
  const items = meta?.schema?.items;
  if (option === null) return type === 'array' ? [] : null;
  const one = items === 'user' || type === 'user'
    ? { accountId: option.accountId }
    : items === 'string' ? option.value : { id: String(option.id) };
  return type === 'array' ? [one] : one;
}

// Значение поля Jira в строку: люди, опции, спринты и просто текст приходят по-разному.
export function fieldText(v) {
  if (v === null || v === undefined || v === '') return '';
  if (Array.isArray(v)) return v.map(fieldText).filter(Boolean).join(', ');
  if (typeof v === 'object') return v.displayName ?? v.name ?? v.value ?? v.key ?? '';
  return String(v);
}

// Спринты задачи без закрытых: закрытые копятся годами и в карточке только шумят.
export const openSprints = (v) => (Array.isArray(v) ? v : []).filter((s) => s && s.state !== 'closed');

