import { execFile } from 'node:child_process';
import { CliError } from './errors.js';

// Все обращения к GitLab идут через `glab api` (JSON). exec инжектируется для тестов.
export function createGlab(run = defaultRun, { sleepMs = 1000, host } = {}) {
  const api = async (repo, path, { method = 'GET', retries = method === 'GET' ? 5 : 2, input } = {}) => {
    const args = ['api'];
    if (host) args.push('--hostname', host);
    // repo=null — путь не проектный (например /user): подставлять projects/ туда нельзя.
    args.push(repo ? `projects/${encodeURIComponent(repo)}${path}` : path.replace(/^\//, ''));
    if (method !== 'GET') args.push('-X', method);
    // Тело только через stdin: --field ломает многострочный markdown, а на GET
    // уходит в query независимо от --input, что нам как раз не надо.
    if (input !== undefined) args.push('--input', '-');
    let lastErr;
    for (let attempt = 1; attempt <= retries; attempt++) {
      let out;
      try {
        out = await run('glab', args, { input });
      } catch (err) {
        lastErr = err;
        const stderr = String(err.stderr || err.message || '').trim();
        if (attempt < retries) {
          const delay = 1000 * 2 ** (attempt - 1); // 1с, 2с, 4с, 8с
          process.stderr.write(`\r\x1b[K⏳ GitLab ответил ошибкой (${stderr.split('\n')[0]}), попытка ${attempt}/${retries}, повтор через ${delay / 1000}с…\n`);
          await sleep((delay * sleepMs) / 1000);
          continue;
        }
        const hint = stderr ? `\n  glab: ${stderr.split('\n').slice(-3).join('\n  ')}` : '';
        throw new CliError(`glab api ${method} ${path.replace(/\?.*$/, '')} не удался${hint}`, 1, 'api_failed');
      }
      try {
        return JSON.parse(out);
      } catch {
        return null;
      }
    }
    const stderr = String(lastErr?.stderr || '').trim();
    throw new CliError(`glab api ${method} ${path.replace(/\?.*$/, '')} не удался\n  glab: ${stderr}`);
  };

  return {
    api,

    // Фильтры уходят в API как есть: серверная фильтрация дешевле выкачивания сотни MR.
    listOpenMRs: (repo, params = {}) => {
      const q = new URLSearchParams({ state: 'opened', per_page: '100', order_by: 'updated_at', sort: 'desc' });
      for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== '') q.set(k, String(v));
      return api(repo, `/merge_requests?${q}`) || [];
    },

    me: () => api(null, '/user'),

    getMR: (repo, iid) => api(repo, `/merge_requests/${iid}`),

    // Все MR-пайплайны (source=merge_request_event), отсортированы по id desc.
    listMRPipelines: (repo) => api(repo, '/pipelines?source=merge_request_event&per_page=100') || [],

    getDiscussions: (repo, iid) => api(repo, `/merge_requests/${iid}/discussions?per_page=100`),

    getApprovals: (repo, iid) => api(repo, `/merge_requests/${iid}/approvals`),

    // Дифф MR берём из API, а не из локального git: review работает в живом
    // чекауте и не имеет права фетчить чужие ветки.
    getMRChanges: (repo, iid) => api(repo, `/merge_requests/${iid}/changes`),

    getPipeline: (repo, pid) => api(repo, `/pipelines/${pid}`),

    getJobs: (repo, pid) => api(repo, `/pipelines/${pid}/jobs?per_page=100`) || [],

    getJob: (repo, jid) => api(repo, `/jobs/${jid}`),

    playJob: (repo, jid) => api(repo, `/jobs/${jid}/play`, { method: 'POST' }),

    retryJob: (repo, jid) => api(repo, `/jobs/${jid}/retry`, { method: 'POST' }),

    createMRPipeline: (repo, iid) => api(repo, `/merge_requests/${iid}/pipelines`, { method: 'POST' }),

    // Ответ в тред. Read-back обязателен: тихо потерянный ответ хуже явной ошибки.
    async replyDiscussion(repo, iid, discussionId, body) {
      const note = await api(repo, `/merge_requests/${iid}/discussions/${discussionId}/notes`, {
        method: 'POST',
        input: JSON.stringify({ body }),
      });
      if (!note?.id) throw new CliError(`Ответ в тред ${discussionId} не создан: GitLab не вернул заметку.`, 1, 'api_failed');
      const back = await api(repo, `/merge_requests/${iid}/discussions/${discussionId}`);
      if (!back?.notes?.some((n) => n.id === note.id)) {
        throw new CliError(`Ответ в тред ${discussionId} отправлен, но при перечитывании его там нет.`, 1, 'api_failed');
      }
      return note;
    },

    // Резолв только query-параметром: --field resolved=true уходит в тело, GitLab его
    // игнорирует и возвращает exit 0 — молчаливый no-op.
    async resolveDiscussion(repo, iid, discussionId) {
      await api(repo, `/merge_requests/${iid}/discussions/${discussionId}?resolved=true`, { method: 'PUT' });
      const back = await api(repo, `/merge_requests/${iid}/discussions/${discussionId}`);
      const resolved = back?.notes?.every((n) => n.system || n.resolved);
      if (!resolved) throw new CliError(`Тред ${discussionId} не зарезолвился: после PUT он всё ещё открыт.`, 1, 'api_failed');
      return back;
    },
  };
}

// input — тело запроса в stdin (для `glab api --input -`): многострочный markdown
// иначе не проходит через --field.
// Асинхронно, и это принципиально: execFileSync держит event loop, а с ним TUI не
// перерисовывается и не слышит клавиш — экран выглядит зависшим на всё время запроса.
export function defaultRun(bin, args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve(stdout);
    });
    child.stdin?.end(input ?? '');
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
