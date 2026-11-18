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

// Сетевые коды, при которых повтор не поможет: DNS, отказ в соединении, запрет песочницы.
const NO_RETRY = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EPERM', 'EACCES', 'EHOSTUNREACH', 'ENETUNREACH']);

// fetch упал до ответа сервиса: это сеть, DNS или прокси, а не ошибка самого сервиса.
// retry — стоит ли повторять (обрыв да, нет DNS — нет).
export function netError(service, err, env = process.env) {
  const code = err?.cause?.code ?? err?.code ?? '';
  const proxy = (env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy) && env.NODE_USE_ENV_PROXY !== '1';
  const hint = proxy ? ' Стоит HTTPS_PROXY/HTTP_PROXY, а node его сам не берёт: повтори с NODE_USE_ENV_PROXY=1.' : '';
  const e = new CliError(`${service}: нет связи (сеть, DNS или прокси${code ? `, ${code}` : ''}): ${err?.message ?? err}.${hint}`, 1, 'api_failed');
  e.retry = !NO_RETRY.has(code);
  return e;
}
