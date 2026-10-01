import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pollOnce, daemonSecretIssues, DEFAULT_BEHIND_THRESHOLD } from '../watch.js';
import { getTelegramTarget } from '../notify.js';
import { sendButtons, sendMessage, formatWatchEvent, fixButtons, issueFixButton, stripHtml } from '../tgbot.js';
import { gitProbe } from './resolve-all.js';
import { loadConfig, expandHome } from '../config.js';
import { gcWorktrees } from '../worktrees.js';
import { createGlab } from '../glab.js';
import { createCtx } from '../registry.js';
import { listAuto, advanceTask } from '../auto.js';
import { CliError } from '../errors.js';

const BOT_STATE_ROOT = path.join(homedir(), '.local', 'state', 'fs-harness');

// fsh watch — один опрос моих MR: новые треды ко мне, появившийся конфликт, отставание через порог.
// Только уведомляет: одно сообщение на MR с кнопкой resolve-all для fsh bot. Очередь и воркер не трогает.
export async function cmdWatch(ctx, { json, asObject, file, probe, stateRoot = BOT_STATE_ROOT, fetchImpl = fetch } = {}) {
  const projectDir = expandHome(ctx.cfg?.projectDir || '');
  const gitOk = Boolean(projectDir) && existsSync(path.join(projectDir, '.git'));
  const usedProbe = probe ?? (gitOk ? gitProbe(projectDir) : null);
  const { first, events, errors, snapshot } = await pollOnce({
    ctx,
    probe: usedProbe,
    behindThreshold: Number(ctx.cfg?.watch?.behindThreshold) || DEFAULT_BEHIND_THRESHOLD,
    ...(file ? { file } : {}),
  });

  const target = getTelegramTarget(ctx.cfg);
  // Кнопку жмёт fsh bot, а он без allowlist не стартует: без списка кнопка была бы мёртвой.
  const withButton = (ctx.cfg?.telegram?.allowed_user_ids ?? []).length > 0;
  let notified = 0;
  for (const e of target ? events : []) {
    const text = formatWatchEvent(e, ctx.repo);
    try {
      if (withButton) {
        const nonce = issueFixButton(stateRoot, { project: ctx.cfg?.activeProject ?? '', repo: ctx.repo, iid: e.iid });
        await sendButtons(target.token, target.chatId, text, fixButtons(e.iid, nonce), { fetchImpl });
      } else {
        await sendMessage(target.token, target.chatId, text, { fetchImpl });
      }
      notified++;
    } catch (err) {
      console.error(`⚠ Уведомление по !${e.iid} не ушло: ${err.message}`);
    }
  }

  const result = { ok: true, first, mrs: snapshot.mrs.length, events, errors, git: Boolean(usedProbe), notified };
  if (asObject) return result;
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  if (!usedProbe) console.log('⚠ Каталог проекта не настроен (projectDir) — конфликт и отставание не считаются.');
  for (const er of errors) console.log(`⚠ !${er.iid}: не посчитать состояние — ${er.error}`);
  if (first) {
    console.log(`Первый снимок ${ctx.repo}: ${snapshot.mrs.length} моих открытых MR. Сравнивать пока не с чем.`);
    return result;
  }
  console.log(`${ctx.repo}: MR с событиями ${events.length}.`);
  for (const e of events) console.log(`\n${stripHtml(formatWatchEvent(e))}`);
  if (notified) console.log(`\nОтправлено в Telegram: ${notified}.`);
  return result;
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
  let lastGc = 0;
  let cycle = 0;
  log(`${stamp()} watcher: проекты ${names.join(', ')}`);
  try {
    while (!stopped && cycle < cycles) {
      cycle++;

      // Авто-gc worktree: не чаще раза в час
      const rootCfg = loadCfg(env, {});
      const gcDays = rootCfg.workspace?.gcOlderThanDays ?? 7;
      if (gcDays > 0 && now() - lastGc >= 3600_000) {
        lastGc = now();
        const gc = deps.gcWorktreesImpl || gcWorktrees;
        try {
          const projectDirs = Object.values(rootCfg.projects ?? {})
            .map((p) => (p.dir ? expandHome(p.dir) : null))
            .filter(Boolean);
          const cleaned = await gc({
            root: rootCfg.workspace?.root ? expandHome(rootCfg.workspace.root) : undefined,
            runsRoot: opts.runsDir ? expandHome(opts.runsDir) : undefined,
            projectDirs,
            olderThanDays: gcDays,
            dryRun: false,
            now: now(),
            say: (msg) => log(`${stamp()} ${msg}`),
          });
          if (cleaned?.length) {
            log(`${stamp()} gc: удалено ${cleaned.length} устаревших worktree`);
          }
        } catch (err) {
          log(`${stamp()} gc worktrees не удался: ${err.message}`);
        }
      }

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
          const r = await poll(makeCtx(cfg), { asObject: true });
          log(`${stamp()} ${cfg.repo}: MR с событиями ${r.events.length}, отправлено ${r.notified}`);
        } catch (err) {
          // Опрос одного проекта упал — это не повод ронять демон: сеть моргает, токены протухают.
          log(`${stamp()} ${cfg.repo || name}: опрос упал — ${err.message}`);
        }

        // Если включена автоматика и передан флаг --auto-execute — двигаем активные задачи
        if (cfg.automation?.enabled && opts.autoExecute) {
          const autoRoot = opts.autoRoot;
          const advance = deps.advanceTaskImpl || advanceTask;
          const activeTasks = listAuto(autoRoot).filter((t) =>
            ['start', 'implement', 'review', 'ci', 'threads', 'conflict'].includes(t.step),
          );
          for (const t of activeTasks) {
            if (stopped) break;
            try {
              log(`${stamp()} ${cfg.repo}: авто-шаг для ${t.key} (шаг ${t.step})…`);
              const adv = await advance(t.key, {
                cfg,
                ctx: makeCtx(cfg),
                root: autoRoot,
                runsDir: opts.runsDir,
                costsRoot: opts.costsRoot,
                makeProvider: deps.makeProvider,
                spawnAgentImpl: deps.spawnAgentImpl,
                fetchImpl: deps.fetchImpl,
                now,
              });
              if (adv.state?.step !== t.step) {
                log(`${stamp()} ${cfg.repo}: задача ${t.key} перешла ${t.step} → ${adv.state?.step}`);
              }
            } catch (aErr) {
              log(`${stamp()} ${cfg.repo}: ошибка автомата ${t.key} — ${aErr.message}`);
            }
          }

          if (cfg.jira?.baseUrl && cfg.automation?.autoStart) {
            try {
              const projectCtx = makeCtx(cfg);
              const knownKeys = new Set(listAuto(autoRoot).map((t) => t.key));
              const res = await projectCtx.jira().searchJql('assignee = currentUser() AND status = "В работе"');
              for (const iss of res.issues || []) {
                if (!knownKeys.has(iss.key)) {
                  log(`${stamp()} ${cfg.repo}: новая задача ${iss.key} «В работе», запускаю автомат…`);
                  await advance(iss.key, {
                    cfg,
                    ctx: projectCtx,
                    root: autoRoot,
                    runsDir: opts.runsDir,
                    costsRoot: opts.costsRoot,
                    makeProvider: deps.makeProvider,
                    spawnAgentImpl: deps.spawnAgentImpl,
                    fetchImpl: deps.fetchImpl,
                    now,
                  });
                }
              }
            } catch {
              // Игнорируем сбои поиска Jira
            }
          }
        }
      }
      if (stopped) break;
      const cancelSleep = {};
      await Promise.race([sleep(Math.max(1, waitSec) * 1000, cancelSleep), new Promise((r) => { wake = r; })]);
      cancelSleep.cancel?.();
      wake = null;
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
export const sleepFor = (ms, cancelHolder = {}) =>
  new Promise((r) => {
    const t = setTimeout(r, ms);
    cancelHolder.cancel = () => clearTimeout(t);
  });

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
  const result = { ok: true, file: unit.file, text: unit.text, hint: unit.hint };
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  // Сам юнит — в stdout, пояснения — в stderr: тогда `fsh watch install > <файл>` кладёт
  // ровно файл, а человек всё равно видит, что с ним делать.
  console.error(`Сохрани в ${unit.file}:\n`);
  console.log(unit.text);
  console.error(`\nПотом:\n${unit.hint.map((h) => `  ${h}`).join('\n')}`);
  if (unit.text.includes('значение')) console.error('\nЗначения <значение> подставь сам: демон читает секреты только из env.');
  return result;
}
