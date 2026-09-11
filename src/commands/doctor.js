import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createGlab } from '../glab.js';
import { loadConfig, CONFIG_PATH, expandHome } from '../config.js';
import { readSecret, addCommand } from '../secrets.js';

// fsh doctor — самодиагностика окружения: программы, конфиг, API, git, судья.
// Критично то, без чего fsh не работает вообще. Опциональное пишет, что из-за него недоступно.
// asObject — вернуть {ok, checks} без печати (MCP-режим).
export async function cmdDoctor({ repo, host, projectDir, json, asObject } = {}) {
  const checks = [];
  const add = (name, ok, detail, critical = false) => checks.push({ name, ok: Boolean(ok), critical, detail: detail ?? (ok ? 'ok' : '') });

  add('node', /^v(2[0-9]|[3-9]\d)\./.test(process.version), process.version, true);

  const gitVersion = tryExec('git', ['--version']);
  add('git', Boolean(gitVersion), gitVersion || 'не найден в PATH', true);
  // merge-tree --write-tree появился в git 2.38; на нём держится поиск конфликтов.
  add('git merge-tree', hasMergeTree(gitVersion), hasMergeTree(gitVersion) ? '--write-tree доступен' : 'нужен git >= 2.38: без --write-tree conflict не найдёт файлы', true);

  const glabVersion = tryExec('glab', ['--version']);
  add('glab', Boolean(glabVersion), glabVersion?.split('\n')[0] || 'не найден в PATH. Установка: brew install glab', true);

  add('claude', Boolean(tryExec('which', ['claude'])), tryExec('which', ['claude']) || 'не найден в PATH: без него не работают ни агент, ни судья', true);
  const pi = tryExec('which', ['pi']);
  add('pi', Boolean(pi), pi || 'не найден — недоступны только действия с agent: "pi"');

  let cfg = null;
  try {
    cfg = loadConfig();
    add('config', true, CONFIG_PATH);
  } catch (err) {
    add('config', false, err.message, true);
  }

  const targetRepo = repo || cfg?.repo;
  const targetHost = host || cfg?.host;
  if (glabVersion && targetHost) {
    // Именно --hostname: без него glab валится из-за любого другого незалогиненного инстанса.
    const auth = tryExec('glab', ['auth', 'status', '--hostname', targetHost]) !== null;
    add('glab auth', auth, auth ? `${targetHost}: авторизован` : `${targetHost}: нет токена — glab auth login --hostname ${targetHost}`, true);
  }
  if (targetRepo && targetHost) {
    try {
      const g = createGlab(undefined, { host: targetHost, sleepMs: 100 });
      const project = await g.api(targetRepo, '', { retries: 1 });
      add('api', true, `${targetHost} · проект "${targetRepo}" #${project?.id ?? '?'} доступен`, true);
    } catch (err) {
      add('api', false, `${targetHost} · "${targetRepo}": ${err.message}`, true);
    }
  } else {
    add('api', false, 'нет repo/host в конфиге — запусти fsh config init', true);
  }

  const dir = expandHome(projectDir || cfg?.projectDir || '~');
  add('projectDir', existsSync(path.join(dir, '.git')), `${dir}${existsSync(path.join(dir, '.git')) ? '' : ' — нет .git (conflict не заработает)'}`);

  // Судью проверяем только по профилям, реально назначенным ролям: про остальные молчим.
  for (const name of [...new Set(Object.values(cfg?.judge?.roles ?? {}).flat())]) {
    const p = cfg?.judge?.profiles?.[name];
    if (!p) {
      add(`судья ${name}`, false, 'роль ссылается на профиль, которого нет в judge.profiles', true);
      continue;
    }
    if (p.secret) {
      const has = readSecret(p.secret, { required: false });
      add(`ключ ${p.secret}`, Boolean(has), has ? `есть, профиль ${name}` : `нет. Заведи: ${addCommand(p.secret)}`);
    } else if (p.provider === 'openai') {
      const up = await reachable(p.baseUrl);
      add(`судья ${name}`, up, up ? p.baseUrl : `${p.baseUrl} не отвечает — роли с этим профилем уедут на следующий в списке`);
    }
  }

  const ok = checks.every((c) => !c.critical || c.ok);
  if (asObject) return { ok, checks };

  if (json) {
    console.log(JSON.stringify({ ok, checks }, null, 2));
    return ok ? 0 : 1;
  }

  const width = Math.max(...checks.map((c) => c.name.length));
  for (const c of checks) {
    console.log(`${c.ok ? '✅' : c.critical ? '❌' : '⚠️ '} ${c.name.padEnd(width)}  ${c.detail}`);
  }
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) {
    console.log(`\n${failed.filter((c) => c.critical).length} критических, ${failed.filter((c) => !c.critical).length} предупреждений.`);
  } else {
    console.log('\nВсё в порядке, fsh готов к работе.');
  }
  return ok ? 0 : 1;
}

function tryExec(bin, args) {
  try {
    return execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

export function hasMergeTree(versionLine) {
  const m = /git version (\d+)\.(\d+)/.exec(versionLine ?? '');
  return Boolean(m) && (Number(m[1]) > 2 || (Number(m[1]) === 2 && Number(m[2]) >= 38));
}

// Локальный бэкенд опционален: молчит — это предупреждение, а не провал.
async function reachable(baseUrl) {
  try {
    const url = new URL('models', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
    return (await fetch(url, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}
