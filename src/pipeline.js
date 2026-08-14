import { CliError } from './errors.js';

// Head-пайплайн MR, если он соответствует текущему HEAD ветки; иначе создаём новый MR-пайплайн.
export async function ensureMRPipeline(g, repo, mr) {
  const head = mr.head_pipeline;
  if (head && (!head.sha || head.sha === mr.sha)) return head;
  const created = await g.createMRPipeline(repo, mr.iid);
  if (!created) throw new CliError(`Не удалось создать MR-пайплайн для !${mr.iid}.`);
  return created;
}

// Джоба по имени или id. Точное совпадение → по id → contains (если одно) → ошибка с вариантами.
export function findJob(jobs, name) {
  if (/^\d+$/.test(String(name))) {
    const byId = jobs.find((j) => String(j.id) === String(name));
    if (byId) return byId;
  }
  const exact = jobs.find((j) => j.name === name);
  if (exact) return exact;
  const contains = jobs.filter((j) => j.name.toLowerCase().includes(String(name).toLowerCase()));
  if (contains.length === 1) return contains[0];
  if (contains.length > 1) {
    throw new CliError(`"${name}" подходит нескольким джобам: ${contains.map((c) => c.name).join(', ')}. Укажи точное имя.`);
  }
  return null;
}

// Запускает джобу: manual → play (тот же id), failed/canceled → retry (новый id).
// Возвращает {id, status} актуальной джобы или null, если запуск не требовался.
export async function startJob(g, repo, job) {
  if (job.status === 'manual') {
    const played = await g.playJob(repo, job.id);
    return { id: job.id, status: played?.status ?? 'pending' };
  }
  if (job.status === 'failed' || job.status === 'canceled') {
    const retried = await g.retryJob(repo, job.id);
    return { id: retried?.id ?? job.id, status: retried?.status ?? 'pending' };
  }
  return null;
}

// Имя deploy-джобы: deploy (N пусто или 1) → deploy_dev, N=2..10 → deploy_devN.
export function deployJobName(n) {
  const num = Number(n);
  if (!n || Number.isNaN(num) || num <= 1) return 'deploy_dev';
  return `deploy_dev${num}`;
}

// Параллельный map с ограничением конкурентности.
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        out[i] = await fn(items[i], i);
      } catch (err) {
        out[i] = { error: err };
      }
    }
  });
  await Promise.all(workers);
  return out;
}
