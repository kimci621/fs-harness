import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createGlab } from '../glab.js';
import { createJira } from '../jira.js';
import { createGrowthBook } from '../growthbook.js';
import { createMattermost } from '../mattermost.js';
import { loadConfig, CONFIG_PATH, expandHome } from '../config.js';
import { readSecret, addCommand } from '../secrets.js';
import { daemonSecretIssues, daemonKeychainJudges } from '../watch.js';
import { cmdInit } from './init.js';

// fsh doctor — самодиагностика окружения: программы, конфиг, API, git, судья.
// Критично то, без чего fsh не работает вообще. Опциональное пишет, что из-за него недоступно.
// asObject — вернуть {ok, checks} без печати (MCP-режим).
export async function cmdDoctor({ repo, host, projectDir, json, asObject, commands, daemon } = {}) {
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
  // agy опционален: без него мастер (fsh ask, клавиша A) берёт профиль cc.
  const agy = tryExec('which', ['agy']);
  add('agy', Boolean(agy), agy || 'не найден — мастер fsh будет работать на профиле cc');

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

  if (cfg?.backend) {
    const bDir = expandHome(cfg.backend.dir || '');
    const bGit = existsSync(path.join(bDir, '.git'));
    add('бэкенд', bGit, `${cfg.backend.name} → ${bDir}${bGit ? '' : ' — нет .git или каталог не существует'}`);
  }

  // Профили агентов: смотрим только те, которым нужен ключ на диске — остальные идут по подписке.
  for (const [name, a] of Object.entries(cfg?.agents ?? {})) {
    if (!a?.keyFile) continue;
    const file = expandHome(a.keyFile);
    add(`агент ${name}`, existsSync(file), existsSync(file) ? file : `нет ключа в ${file} — профиль недоступен`);
  }

  // Скилл в проекте проверяем, только если он уже поставлен: молчаливое требование
  // ставить его в каждый проект — не наше дело.
  if (commands && existsSync(path.join(dir, '.claude', 'skills', 'fsh', 'SKILL.md'))) {
    const { state } = cmdInit(commands, { cfg }, { projectDir: dir, check: true, asObject: true });
    add('скилл fsh', state === 'current', state === 'current' ? `${dir}/.claude/skills/fsh` : 'устарел (реестр изменился) — обнови: fsh init');
  }

  // Jira опциональна: пока не настроена, молчим — про неё спросит только analyze.
  if (cfg?.jira?.baseUrl) {
    const token = readSecret('jira', { required: false });
    if (!token) {
      add('jira', false, `токена нет. Заведи: ${addCommand('jira')}`);
    } else {
      try {
        const me = await createJira({ ...cfg.jira, token }).myself();
        add('jira', true, `${cfg.jira.baseUrl} · ${me?.displayName ?? me?.accountId ?? 'ok'}`);
      } catch (err) {
        add('jira', false, `${cfg.jira.baseUrl}: ${err.message}`);
      }
    }
  }

  // GrowthBook тоже опционален: не настроен — молчим, про него спросит только growthbook.
  if (cfg?.growthbook?.baseUrl) {
    const token = readSecret('growthbook', { required: false });
    if (!token) {
      add('growthbook', false, 'ключа нет. Положи secret_… в ~/.growthbook_apikey');
    } else {
      try {
        const { total } = await createGrowthBook({ ...cfg.growthbook, token }).features({ limit: 1 });
        add('growthbook', true, `${cfg.growthbook.baseUrl} · флагов ${total}`);
      } catch (err) {
        add('growthbook', false, `${cfg.growthbook.baseUrl}: ${err.message}`);
      }
    }
  }

  // Telegram проверяется по наличию токена и chat_id.
  const tg = cfg?.telegram;
  const hasToken = tg?.bot_token || readSecret('telegram', { required: false });
  const hasChatId = tg?.chat_id || process.env.TELEGRAM_CHAT_ID;
  if (hasToken || hasChatId || tg?.approvals || (tg?.allowed_user_ids ?? []).length) {
    const ok = Boolean(hasToken && hasChatId);
    let msg = 'настроен (токен и chat_id заданы)';
    if (!hasToken) msg = `есть chat_id, но нет токена бота. Заведи: ${addCommand('telegram')}`;
    else if (!hasChatId) msg = 'есть токен, но не задан chat_id в конфиге (telegram.chat_id)';
    add('telegram', ok, msg);
  }

  // Кнопки аппрува бесполезны без allowlist: ран встанет в pending_approval, а нажать никто не сможет.
  if (tg?.approvals || (tg?.allowed_user_ids ?? []).length) {
    const allowed = (tg?.allowed_user_ids ?? []).filter((x) => x !== null && x !== undefined && x !== '');
    add('telegram bot', allowed.length > 0,
      allowed.length
        ? `allowlist: ${allowed.join(', ')} · approvals: ${tg?.approvals ? 'вкл' : 'выкл'}`
        : 'telegram.allowed_user_ids пуст — fsh bot не стартует, кнопки нажать нечем. Узнай id у @userinfobot',
      Boolean(tg?.approvals));
  }

  // Mattermost опционален: не настроен — молчим. Токен сессионный и протухает при разлогине,
  // поэтому дёргаем /users/me, а не ограничиваемся его наличием.
  if (cfg?.mattermost?.baseUrl) {
    const token = readSecret('mattermost', { required: false });
    const channels = Object.keys(cfg.mattermost.channels ?? {});
    if (!token) {
      add('mattermost', false, 'токена нет — получи: fsh mm login <логин>');
    } else {
      try {
        const me = await createMattermost({ ...cfg.mattermost, token, sleepMs: 100 }).me();
        add('mattermost', true, `${cfg.mattermost.baseUrl} · ${me?.username ?? 'ok'} · сценарии: ${channels.join(', ') || '—'}`);
      } catch (err) {
        add('mattermost', false, `${cfg.mattermost.baseUrl}: ${err.message}`);
      }
    }
  }

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

  // --daemon: отдельный блок про фоновый режим. Ключ из keychain на залоченном экране
  // не достать, поэтому демону нужны те же секреты в env.
  if (daemon && cfg) {
    const names = Object.keys(cfg.projects ?? {});
    const watched = names.filter((name) => loadConfig(process.env, { project: name }).watch?.enabled !== false);
    add('демон: проекты', watched.length > 0, watched.length ? `опрашиваются: ${watched.join(', ')}` : 'ни одного проекта с watch.enabled — демону нечего делать', true);

    const issues = [];
    for (const name of names) {
      for (const i of daemonSecretIssues(loadConfig(process.env, { project: name }), process.env)) {
        if (!issues.some((x) => x.envName === i.envName)) issues.push(i);
      }
    }
    add('демон: секреты', issues.length === 0, issues.length ? `нет в env: ${issues.map((i) => `${i.envName} (${i.why})`).join(', ')}` : 'всё нужное читается из env', true);

    const cliJudges = daemonKeychainJudges(cfg);
    if (cliJudges.length) {
      add('демон: триаж', false, `профиль ${cliJudges.join(', ')} берёт OAuth-токен claude из keychain — на залоченном экране триаж молчит, события уйдут в канал без разбора`);
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
