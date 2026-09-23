// Вывод в двух режимах: человеческом и --json.
// В json-режиме весь прогресс уходит в stderr, а stdout содержит только финальный JSON.

// Логгер прогресса: в json-режиме пишет в stderr, чтобы не портить stdout.
export function makeLogger(json) {
  return json
    ? (...parts) => process.stderr.write(parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ') + '\n')
    : (...parts) => console.log(...parts);
}

// Финальный результат команды: в json-режиме — JSON в stdout, иначе — ничего
// (человеческий вывод уже сделан логгером).
export function finish(json, obj) {
  if (json) console.log(JSON.stringify(obj, null, 2));
}

// Структурированная ошибка для агентов: {ok:false, error:{code, message}}.
// Упавший ран добавляет run/run_dir — по ним агент зовёт resume/retry/ask.
export function formatErrorJSON(err) {
  const code = err?.code && typeof err.code === 'string' ? err.code : 'error';
  const error = { code, message: String(err?.message || err) };
  if (err?.run) error.run = err.run;
  if (err?.runDir) error.run_dir = err.runDir;
  return JSON.stringify({ ok: false, error }, null, 2);
}

// JSON-представление джобы в результатах.
export function jobJSON(job, status = job?.status) {
  return {
    id: job?.id,
    name: job?.name,
    status,
    web_url: job?.web_url,
  };
}
