// Ошибка для пользователя: сообщение печатается как есть, без stack trace.
// code — машинный код для агентов (--json): mr_not_found, api_failed, job_failed, …
export class CliError extends Error {
  constructor(message, exitCode = 1, code = 'error') {
    super(message);
    this.exitCode = exitCode;
    this.code = code;
  }
}

export function toCliError(err) {
  if (err instanceof CliError) return err;
  return new CliError(String(err.message || err));
}
