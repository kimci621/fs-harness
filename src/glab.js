import { execFileSync } from 'node:child_process';
import { CliError } from './errors.js';

// Все обращения к GitLab идут через `glab api` (JSON). exec инжектируется для тестов.
export function createGlab(run = defaultRun, { sleepMs = 1000, host } = {}) {
  const api = async (repo, path, { method = 'GET', retries = method === 'GET' ? 5 : 2 } = {}) => {
    const args = ['api'];
    if (host) args.push('--hostname', host);
    args.push(`projects/${encodeURIComponent(repo)}${path}`);
    if (method !== 'GET') args.push('-X', method);
    let lastErr;
    for (let attempt = 1; attempt <= retries; attempt++) {
      let out;
      try {
        out = run('glab', args);
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
        throw new CliError(`glab api ${method} ${path.replace(/\?.*$/, '')} не удался${hint}`);
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

    listOpenMRs: (repo) =>
      api(repo, '/merge_requests?state=opened&per_page=100&order_by=updated_at&sort=desc') || [],

    getMR: (repo, iid) => api(repo, `/merge_requests/${iid}`),

    // Все MR-пайплайны (source=merge_request_event), отсортированы по id desc.
    listMRPipelines: (repo) => api(repo, '/pipelines?source=merge_request_event&per_page=100') || [],

    getDiscussions: (repo, iid) => api(repo, `/merge_requests/${iid}/discussions?per_page=100`),

    getPipeline: (repo, pid) => api(repo, `/pipelines/${pid}`),

    getJobs: (repo, pid) => api(repo, `/pipelines/${pid}/jobs?per_page=100`) || [],

    getJob: (repo, jid) => api(repo, `/jobs/${jid}`),

    playJob: (repo, jid) => api(repo, `/jobs/${jid}/play`, { method: 'POST' }),

    createMRPipeline: (repo, iid) => api(repo, `/merge_requests/${iid}/pipelines`, { method: 'POST' }),
  };
}

export function defaultRun(bin, args) {
  return execFileSync(bin, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
