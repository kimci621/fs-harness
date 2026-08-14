// Анимации и живой вывод. Всё пишется в stderr, чтобы stdout (--json) оставался чистым.
import { statusIcon, fmtDuration } from './format.js';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const clearLine = '\r\x1b[K';

// Спиннер с таймером: spinner.start() / spinner.text('...') / spinner.stop('итог').
export function createSpinner(text) {
  let i = 0;
  let timer = null;
  let start = Date.now();
  let current = text;

  const draw = () => {
    const elapsed = Date.now() - start;
    process.stderr.write(`${clearLine}${FRAMES[i++ % FRAMES.length]} ${current} [${fmtDuration(elapsed)}]`);
  };

  return {
    start(t) {
      if (timer) return;
      if (t) current = t;
      start = Date.now();
      i = 0;
      draw();
      timer = setInterval(draw, 80);
    },
    text(t) {
      current = t;
      if (timer) draw();
    },
    stop(msg) {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
      process.stderr.write(`${clearLine}${msg ?? current}\n`);
    },
  };
}

const STATUS_COLOR = {
  success: '\x1b[32m',
  failed: '\x1b[31m',
  canceled: '\x1b[31m',
  running: '\x1b[34m',
  pending: '\x1b[33m',
  created: '\x1b[33m',
  manual: '\x1b[33m',
  preparing: '\x1b[33m',
  waiting_for_resource: '\x1b[33m',
  scheduled: '\x1b[33m',
};
const RESET = '\x1b[0m';

// Таблица с перерисовкой на месте: update() затирает предыдущий вывод.
export function createLiveTable(header, rows) {
  let drawn = 0;

  const render = () => {
    const widths = header.map((_, c) =>
      Math.max(header[c].length, ...rows.map((r) => String(r[c] ?? '').length)),
    );
    const line = (cells) =>
      cells.map((cell, c) => String(cell ?? '').padEnd(widths[c])).join('  ').trimEnd();
    return [line(header), ...rows.map(line)];
  };

  const draw = () => {
    if (drawn > 0) process.stderr.write(`\x1b[${drawn}A`);
    const lines = render();
    for (const l of lines) process.stderr.write(`\x1b[K${l}\n`);
    drawn = lines.length;
  };

  return {
    update(newRows) {
      rows = newRows;
      draw();
    },
    stop(msg) {
      if (drawn > 0) process.stderr.write(`\x1b[${drawn}A\x1b[J`);
      drawn = 0;
      if (msg !== undefined) process.stderr.write(`${msg}\n`);
    },
  };
}

// Строка джобы для live-таблицы.
export function jobRow(job) {
  return [job.stage || '—', job.name, coloredStatus(job.status), `#${job.id}`];
}

export function coloredStatus(status) {
  const color = STATUS_COLOR[status] || '';
  return `${color}${statusIcon(status)} ${status}${RESET}`;
}

export const JOB_TERMINAL = new Set(['success', 'failed', 'canceled', 'skipped']);
export const isTerminal = (status) => JOB_TERMINAL.has(status);

// Опрос джобы каждые intervalMs с живой таблицей всех джоб пайплайна.
// Возвращает финальный объект джобы.
export async function waitJob({ g, repo, pipelineId, jobId, intervalMs = 5000, timeoutMs = 60 * 60 * 1000, label }) {
  const table = createLiveTable(['stage', 'job', 'status', 'id'], []);
  const spinner = createSpinner('');
  const started = Date.now();

  while (true) {
    const jobs = await g.getJobs(repo, pipelineId);
    const job = jobs.find((j) => j.id === jobId) || (await g.getJob(repo, jobId));
    table.update(jobs.map(jobRow));
    spinner.start(`${label}: ${job.status}`);
    if (isTerminal(job.status)) {
      table.stop();
      spinner.stop(`${label}: ${coloredStatus(job.status)}`);
      return job;
    }
    if (Date.now() - started > timeoutMs) {
      table.stop();
      spinner.stop(`${label}: превышен таймаут ожидания`);
      throw new Error(`Джоба ${job.name} не завершилась за ${fmtDuration(timeoutMs)}.`);
    }
    await sleep(intervalMs);
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
