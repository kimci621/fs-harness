import { homedir } from 'node:os';
import path from 'node:path';
import { pollOnce, formatEvents, daemonSecretIssues, daemonKeychainJudges } from '../watch.js';
import { getTelegramTarget, postTelegram } from '../notify.js';
import { enqueue, jobFromEvent, pruneQueue, DEFAULT_TTL_SECONDS } from '../queue.js';
import { loadConfig } from '../config.js';
import { createGlab } from '../glab.js';
import { createCtx } from '../registry.js';
import { CliError } from '../errors.js';

// fsh watch — один опрос: что изменилось с прошлого раза, что из этого важно.
// Действия по-прежнему не запускает: важные события кладутся в очередь заданий,
// а исполнителя у неё нет (PLAN, фазы 12-15).
export async function cmdWatch(ctx, { json, asObject, file, queueRoot } = {}) {
  const { first, events, kept, verdict, triageError, snapshot } = await pollOnce({
    g: ctx.g,
    repo: ctx.repo,
    cfg: ctx.cfg,
    ...(file ? { file } : {}),
  });

  const target = getTelegramTarget(ctx.cfg);
  let notified = false;
  if (target && kept.length) {
    try {
      await postTelegram(target, `*${ctx.repo}*\n${formatEvents(kept, { verdict })}`);
      notified = true;
    } catch (err) {
      console.error(`⚠ Уведомление не ушло: ${err.message}`);
    }
  }

  const queued = enqueueKept(kept, ctx, queueRoot);

  const result = {
    ok: true,
    first,
    mrs: snapshot.mrs.length,
    events: events.map(({ finding, ...e }) => e),
    kept: kept.map(({ finding, ...e }) => e),
    queued,
    triage: verdict ? { decision: verdict.decision, summary: verdict.summary, cost: verdict.meta?.cost ?? 0 } : null,
    triage_error: triageError,
    notified,
  };
  if (asObject) return result;
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  if (first) {
    console.log(`Первый снимок ${ctx.repo}: ${snapshot.mrs.length} открытых MR. Сравнивать пока не с чем.`);
    return result;
  }
  console.log(`${ctx.repo}: событий с прошлого опроса ${events.length}, важных ${kept.length}.`);
  if (triageError) console.log(`⚠ Триаж не сработал (${triageError}) — показываю всё.`);
  if (events.length) console.log(formatEvents(kept, { verdict }));
  if (queued.length) console.log(`В очередь заданий добавлено ${queued.length} (fsh queue).`);
  if (notified) console.log('Отправлено в Telegram.');
  return result;
}

// Важные события → задания. Дубль по ключу идемпотентности молча пропускается,
// поэтому один и тот же конфликт не ставится в очередь каждым опросом.
function enqueueKept(kept, ctx, root) {
  const ttlSeconds = ctx.cfg?.watch?.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  pruneQueue({ ...(root ? { root } : {}) });
  const queued = [];
  for (const e of kept) {
    const job = jobFromEvent(e, { project: ctx.cfg?.activeProject ?? '', repo: ctx.repo });
    const { added, key } = enqueue(job, { ...(root ? { root } : {}), ttlSeconds });
    if (added) queued.push(key);
  }
  return queued;
}

const stamp = (d = new Date()) => d.toISOString().slice(11, 19);

// fsh watch --daemon — тот же опрос по кругу и по всем проектам конфига.
// Конфиг перечитывается каждым циклом: выключатель проекта должен работать на ходу.
export async function cmdWatchDaemon(opts = {}, deps = {}) {
  const {
    env = process.env,
    loadCfg = loadConfig,
    makeCtx = defaultCtx,
    poll = cmdWatch,
    sleep = sleepFor,
    now = () => Date.now(),
    cycles = Infinity,
    log = console.log,
  } = deps;

  const names = Object.keys(loadCfg(env, {}).projects ?? {});
  if (!names.length) throw new CliError('В конфиге нет проектов — демону нечего опрашивать. См. fsh config show.', 1, 'config_invalid');

  const issues = startupIssues(names, { env, loadCfg });
  if (issues.length) {
    throw new CliError(
      'Демон не стартует: на залоченном экране keychain ключей не отдаёт, и он молча встанет ночью.\n' +
        issues.map((i) => `  export ${i.envName}=… — ${i.why}`).join('\n') +
        '\nПроверить целиком: fsh doctor --daemon. Готовый юнит с env: fsh watch install.',
      1,
      'secret_missing',
    );
  }

  let stopped = false;
  let wake = null;
  // Сигнал будит демон посреди сна: иначе остановка ждала бы целый интервал.
  const stop = () => { stopped = true; wake?.(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  const last = new Map();
  let cycle = 0;
  log(`${stamp()} watcher: проекты ${names.join(', ')}`);
  try {
    while (!stopped && cycle < cycles) {
      cycle++;
      let waitSec = 60;
      for (const name of Object.keys(loadCfg(env, {}).projects ?? {})) {
        if (stopped) break;
        const cfg = loadCfg(env, { project: name });
        const intervalSec = Math.max(10, Number(cfg.watch?.intervalSeconds) || 300);
        if (cfg.watch?.enabled === false) continue;
        // Ни разу не опрошенный проект опрашивается сразу: ждать интервал после старта незачем.
        const prev = last.get(name);
        if (prev !== undefined && prev + intervalSec * 1000 > now()) {
          waitSec = Math.min(waitSec, (prev + intervalSec * 1000 - now()) / 1000);
          continue;
        }
        last.set(name, now());
        waitSec = Math.min(waitSec, intervalSec);
        try {
          const r = await poll(makeCtx(cfg), { asObject: true, queueRoot: opts.queueRoot });
          log(`${stamp()} ${cfg.repo}: событий ${r.events.length}, важных ${r.kept.length}, в очередь ${r.queued.length}`);
        } catch (err) {
          // Опрос одного проекта упал — это не повод ронять демон: сеть моргает, токены протухают.
          log(`${stamp()} ${cfg.repo || name}: опрос упал — ${err.message}`);
        }
      }
      if (stopped) break;
      await Promise.race([sleep(Math.max(1, waitSec) * 1000), new Promise((r) => { wake = r; })]);
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
  log(`${stamp()} watcher остановлен.`);
  return { ok: true, cycles: cycle, projects: names };
}

// Секреты проверяются по всем проектам сразу: падать на третьем часу из-за второго проекта — глупо.
function startupIssues(names, { env, loadCfg }) {
  const byEnvName = new Map();
  for (const name of names) {
    for (const issue of daemonSecretIssues(loadCfg(env, { project: name }), env)) {
      if (!byEnvName.has(issue.envName)) byEnvName.set(issue.envName, issue);
    }
  }
  return [...byEnvName.values()];
}

const defaultCtx = (cfg) => createCtx({ g: createGlab(undefined, { host: cfg.host }), cfg });

// Таймер сна — единственное, что держит демон живым между опросами: с unref() цикл событий
// пустеет и node молча выходит с кодом 13 сразу после первого круга.
export const sleepFor = (ms) => new Promise((r) => { setTimeout(r, ms); });

// fsh watch install — печатаем юнит, а не ставим: ~/Library/LaunchAgents это глобальный
// конфиг, и трогать его сами мы не должны (CLAUDE.md).
export function serviceText(cfg = {}, { platform = process.platform, node = process.execPath, script = process.argv[1], home = homedir(), path: envPath = process.env.PATH } = {}) {
  const label = 'com.fitstars.fs-harness.watch';
  const logDir = path.join(home, '.local', 'state', 'fs-harness', 'watch');
  // В юнит попадают только секреты: chat_id и остальное демон и так читает из конфига.
  const secrets = [...new Set(daemonSecretIssues(cfg, {}).map((i) => i.envName))];
  // PATH обязателен: launchd даёт /usr/bin:/bin:/usr/sbin:/sbin, а glab лежит в homebrew —
  // без него демон на каждом опросе получает spawn glab ENOENT.
  const vars = [['PATH', envPath ?? ''], ...secrets.map((n) => [n, '<значение>'])];
  const xml = (v) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  if (platform === 'darwin') {
    const envBlock = `  <key>EnvironmentVariables</key>\n  <dict>\n${vars.map(([k, v]) => `    <key>${k}</key><string>${xml(v)}</string>`).join('\n')}\n  </dict>\n`;
    return {
      file: path.join(home, 'Library', 'LaunchAgents', `${label}.plist`),
      text: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>${script}</string>
    <string>watch</string>
    <string>--daemon</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
${envBlock}  <key>StandardOutPath</key><string>${path.join(logDir, 'daemon.log')}</string>
  <key>StandardErrorPath</key><string>${path.join(logDir, 'daemon.err.log')}</string>
</dict>
</plist>`,
      hint: [`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/${label}.plist`, `launchctl bootout gui/$(id -u)/${label}   # снять`],
    };
  }

  return {
    file: path.join(home, '.config', 'systemd', 'user', 'fsh-watch.service'),
    text: `[Unit]
Description=fsh watch — фоновый опрос MR

[Service]
ExecStart=${node} ${script} watch --daemon
Restart=always
RestartSec=30
${vars.map(([k, v]) => `Environment=${k}=${v}`).join('\n')}

[Install]
WantedBy=default.target`,
    hint: ['systemctl --user daemon-reload', 'systemctl --user enable --now fsh-watch.service', 'systemctl --user disable --now fsh-watch.service   # снять'],
  };
}

export function cmdWatchInstall(ctx, { json } = {}) {
  const unit = serviceText(ctx.cfg);
  const keychainJudges = daemonKeychainJudges(ctx.cfg);
  const result = { ok: true, file: unit.file, text: unit.text, hint: unit.hint, keychain_judges: keychainJudges };
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  console.log(`Сохрани в ${unit.file}:\n`);
  console.log(unit.text);
  console.log(`\nПотом:\n${unit.hint.map((h) => `  ${h}`).join('\n')}`);
  if (unit.text.includes('значение')) console.log('\nЗначения <значение> подставь сам: демон читает секреты только из env.');
  if (keychainJudges.length) {
    console.log(`Судья ${keychainJudges.join(', ')} ходит за токеном в keychain сам — на залоченном экране триаж молчит и события уйдут без разбора.`);
  }
  return result;
}
