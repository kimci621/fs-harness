// Ошибка для пользователя: сообщение печатается как есть, без stack trace.
export class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

export function toCliError(err) {
  if (err instanceof CliError) return err;
  return new CliError(String(err.message || err));
}
