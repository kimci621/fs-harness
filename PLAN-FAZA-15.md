# PLAN-FAZA-15 - Очередь задач и параллельность

Инструкция для AI-агента. Выполняй шаги по порядку. Исходная формулировка - PLAN.md,
«Фаза 15» (строки 1457-1471). Зависимости: фаза 11 (очередь и её формат УЖЕ заданы там -
не переделывай). Критерий приёмки дословно:

> *Готово, когда:* несколько событий (конфликт в MR 1, упавший тест в MR 2) обрабатываются
> параллельно в изолированных каталогах, две задачи на одну ветку сериализуются локом, а
> `worktrees gc` чистит за собой.

Оценка: 2-3 дня. Порядок внутри фазы жёсткий: **уборщик worktree - ДО воркеров, а не после**
(PLAN 1461-1464: task-worktree сегодня не удаляется никогда, пул забьёт диск за сутки).

## Жёсткие ограничения

1. Ноль новых внешних программ. npm-зависимостей не нужно (локи - на файлах, не на
   сторонних пакетах: формат pid+mtime+протухание задан планом).
2. Воркеры вызывают действия СТРОГО с `yes: true` (SPEC, раздел «Очередь заданий»:
   движок спрашивает confirm, без stdin ответ «нет», задание тихо отменится).
3. Формат задания и ключ идемпотентности (`source:kind:(mr<iid>|<ключ>):sha`) УЖЕ
   зафиксированы в `src/queue.js` и docs/SPEC.md - не менять. Меняется только то, что
   задания начинает кто-то забирать.
4. Ошибки - CliError с кодами. Команды - только через registry.js. Тесты - node --test
   без сети. Комментарии на русском. Минимальный диф.

## §0. Что прочитать перед началом

- `PLAN.md` 1457-1471 (фаза 15), 1295-1333 (фаза 11 - что уже есть), 495-538 (§D изоляция).
- `src/queue.js` - целиком: `queueKey`, `jobFromEvent`, `enqueue` (дедуп по живому ключу),
  `listJobs`, `pruneQueue`, `clearQueue`. Забирает задания сейчас НИКТО - прямой комментарий
  в коде.
- `src/workspace.js` - целиком: `WORKTREE_ROOT`, `acquireWorkspace`, `cleanup(keep)`
  (task-worktree не удаляется НИКОГДА, строки ~76-85), стратегии deps.
- `src/commands/watch.js` - `cmdWatchDaemon`: deps-инъекции (`env, loadCfg, sleep, now,
  cycles, log`), обработка SIGINT/SIGTERM, перечитывание конфига каждый цикл. Это образец
  для воркер-цикла.
- `src/commands/queue.js` - `fsh queue list|clear` как образец маленькой команды.
- `src/agent/journal.js` - `MAX_ARCHIVES = 50` (хардкод, строка 7), `pruneRuns`.
- `src/engine.js` - что нужно runAction от вызывающего (opts.yes, opts.json, signal).
- `src/registry.js` - `ACTIONS` (действия по имени), `fromAction`.
- `test/queue.test.js`, `test/workspace.test.js` - паттерны (mkdtemp, настоящий git).

## Известные факты кода (сверено 2026-09-21)

- `ACTION_BY_KIND` в queue.js: `{conflict: 'conflict', threads: 'threads'}`; у `pipeline`
  action = null - в фазе 14 он станет `ci-fix`. Воркер обязан пропускать задания с
  `action: null`, не падать.
- `enqueue` НЕ атомарен относительно параллельных процессов (проверка живого файла, потом
  запись) - для одного демона хватает; пул воркеров читает, а не пишет, поэтому гонки
  постановки здесь не будет. Гонка - на ВЗЯТИИ задания: два воркера не должны взять одно.
- Ран = один вызов runAction, самодостаточный (свой AbortController, ws, runDir).
  Блокирующие места: `confirm()` (снимается yes:true) и `waitJob` в publish.
- Сироты worktree рождаются тремя путями: keep=true после ошибки/judge_rejected/Ctrl+C,
  все task-worktree, раны, удалённые pruneRuns, чей worktree остался (prune удаляет только
  каталог рана, worktree не трогает - смотри `pruneRuns`: rmSync только на runs/<id>).

---

# Часть 1. Уборщик worktree (первым, до воркеров)

## Шаг 1. Инвентаризация worktree

**Новый файл: `src/worktrees.js`.**

1.1. `listWorktrees({root = WORKTREE_ROOT, runsRoot, projectDirs})` - возвращает массив:

```
{dir, project, branch, action, key, age_days, size_mb?, status}
```

Источники: каталоги `<root>/<project>/<action>-<key>-<stamp>` на диске. `status`:
- `run-alive` - нашёлся ран в `runsRoot` с `meta.worktree === dir` и state
  `running`/`pending_approval` (трогать нельзя);
- `run-done` - ран есть, state done/failed/expired (кандидат по возрасту);
- `orphan` - рана нет вообще (прун съёл или ран не дописал meta);
- `task` - ветка не `fs-harness/*` (это task-worktree под задачу; кандидат по возрасту
  и состоянию задачи - MR мёрджен/закрыт или задача в Done).

`size_mb` не считай рекурсивно (дорого) - `du -sk` одним вызовом на каталог, и только по
запросу (флаг `--sizes`).

1.2. `gcWorktrees({root, runsRoot, olderThanDays = 7, dryRun, say})`: удаляет
`orphan` и `run-done` старше порога + `task`, чей MR закрыт/смёрджен (проверка через
`g.listOpenMRs({source_branch: branch})` - пусто и ветка не активна). Удаление = та же
последовательность, что `cleanup(false)` в workspace.js: `git worktree remove --force`,
`worktree prune`, `branch -D`. Вынеси её из workspace.js в экспортируемый
`removeWorktree(projectDir, dir, branch)` (если фаза 13 уже вынесла - переиспользуй,
не дублируй) и пользуйся в обоих местах.

**Тест: `test/worktrees.test.js` (новый)** - mkdtemp, настоящий git: создать 3 worktree
(под живой ран, под завершённый, сирота), `listWorktrees` классифицирует все три,
`gcWorktrees({dryRun: true})` ничего не удаляет, настоящий gc уносит сироту и done, живой
не трогает.

## Шаг 2. Команда `fsh worktrees list|gc`

**Новый файл: `src/commands/worktrees.js`** - по образцу commands/queue.js: `list`
(дефолт, таблица через format.js), `gc` (с confirm без `--yes`, `--dry-run` печатает план).
Поддержи `asObject`/`--json`. Регистрация в `COMMANDS` (registry.js), mcp-экспорт: только
`list` (gc - запись, из MCP с yes:true не отдаём).

**Тест: registry.test.js** подхватит запись сам; ручная проверка `node bin/fsh.js worktrees`.

## Шаг 3. Авто-gc

В `cmdWatchDaemon` (commands/watch.js) - раз в цикл (не чаще раза в час, метка в памяти
демона) зови `gcWorktrees({dryRun: false})` с порогом из конфига. Конфиг:
`DEFAULTS.workspace.gcOlderThanDays = 7` (config.js). Выключатель: 0 = не убирать никогда.

---

# Часть 2. Локи

## Шаг 4. Файловые локи

**Новый файл: `src/locks.js`.**

4.1. Ключ лока: `project + branch | MR` (PLAN дословно) - то есть строка
`<repo>:<branch>` или `<repo>:mr<iid>`, нормализуй как в queue.js (`[^\w.-]` → `_`).

4.2. `acquireLock({root = ~/.local/state/fs-harness/locks, key, pid = process.pid,
now, staleMs = 30*60*1000})`:
- файл `<root>/<key>.lock`, содержимое `{pid, at}`;
- файл есть и свежий (mtime < staleMs) и pid ЖИВ (`process.kill(pid, 0)`) - верни
  `{acquired: false, holder}`;
- файл протух или pid мёртв - перезапиши;
- захват атомарно: `fs.openSync(path, 'wx')` (эксклюзивное создание), при EEXIST -
  проверка протухания и `rmSync` + один повтор. Две попытки максимум, дальше not acquired;
- верни `{acquired: true, release()}`; release удаляет файл, только если там твой pid.

4.3. `listLocks({root, now})` - для диагностики и `fsh queue list` (колонка «лок»).

**Тест: `test/locks.test.js` (новый)** - второй acquire на тот же ключ отказан; release
освобождает; протухший (подмени mtime через `fs.utimesSync`) перехватывается; чужой живой
pid не отдаёт; мёртвый pid перехватывается.

---

# Часть 3. Воркеры

## Шаг 5. Ретеншн ранов в конфиг + прун по возрасту

**`src/agent/journal.js`**: `MAX_ARCHIVES` перестаёт быть хардкодом -
`pruneRuns({root, keep, olderThanDays})`, оба параметра приходят сверху. В engine.js вызов
`createRun` получает их из `opts.cfg.journal`: `DEFAULTS.journal = {maxRuns: 50,
maxAgeDays: 30}` (config.js). Прун по возрасту: каталог старше maxAgeDays удаляется даже
внутри keep (исключение - `pending_approval`, фаза 13). План дословно: «50 ранов на весь
пул вымоются за часы» - поэтому оба критерия.

**Тест: test/journal.test.js** - прун по числу, по возрасту, исключение pending_approval.

## Шаг 6. Воркер-цикл

**Новый файл: `src/worker.js`.**

6.1. `takeJob({queueRoot, locksRoot, now})`: `pruneQueue` + `listJobs` → для каждого с
непустым `action`: вычисли ключ лока (у задания есть `repo` и `mr` - `<repo>:mr<iid>`;
задание на задачу - `<repo>:<branch задачи>`) → `acquireLock` → занято - следующее;
свободно - верни `{job, release}`. Ни одного - null. Два воркера одно задание не возьмут
именно локом, а не удалением из очереди (задание удаляется ПОСЛЕ завершения - тогда
перезапуск воркера посреди рана не теряет задание, а TTL+дедуп не дают дублей).

6.2. `runWorker({cfg, g, queueRoot, locksRoot, once, concurrency = 2, log, signal, deps...})`
- цикл по образцу `cmdWatchDaemon` (те же инъекции, SIGINT/SIGTERM). Каждая итерация:
`takeJob` пока есть свободные слоты (< concurrency); на задание - `runAction` действия
`ACTIONS[job.action]` с аргументом `job.mr ?? job.task`, opts: `{yes: true, json: true,
quiet: true}`. После завершения (любым исходом): release лока; успех - удалить задание из
очереди (`rmSync(jobFile)` - экспортируй из queue.js маленький `removeJob(root, key)`);
ошибка - задание ОСТАЁТСЯ, но помечается `attempts++` (перезапись JSON); attempts >= 3 -
удалить и залогировать «задание снято после 3 попыток». Константа `JOB_MAX_ATTEMPTS = 3`
с комментарием.

6.3. Параллельность - внутри одного процесса (Promise-ы, не fork): runAction
самодостаточен. Изоляция каталогов - через сами действия (ephemeral-worktree), ничего
дополнительно.

**Тест: `test/worker.test.js` (новый)** - очередь с двумя заданиями на разные MR и одним
на тот же: два выполняются параллельно, третье ждёт лок (контроль порядка - через мок
runAction с ручными промисами); задание с action:null пропущено; attempts растёт, после 3
снимается; `once: true` завершает цикл.

## Шаг 7. Команда `fsh worker` и встраивание в демон

**Новый файл: `src/commands/worker.js`**: `fsh worker [--once] [--concurrency N]`.
Без флагов - бесконечный цикл с интервалом `watch.intervalSeconds` (тот же, что опрос:
задания появляются оттуда). Регистрация в COMMANDS (mcp - нет).

**Демон**: в `cmdWatchDaemon` после постановки в очередь - если `cfg.workers?.enabled`
(новая секция `DEFAULTS.workers = {enabled: false, concurrency: 2}`, дефолт ВЫКЛЮЧЕНО,
перечитывается каждый цикл) - прогнать воркер-итерации inline. Отдельный `fsh worker`
остаётся ручным режимом.

**Тест**: worker-цикл в демоне при `workers.enabled: false` не трогает очередь (критерий
«по умолчанию выключено» - тот же принцип, что automation в фазе 14).

---

# Финальная верификация

```bash
npm test
rm -rf node_modules && npm ci && npm test
node bin/fsh.js help                 # worktrees и worker в справке
node bin/fsh.js worktrees            # список (пусто - ок)
node bin/fsh.js worktrees gc --dry-run
node bin/fsh.js doctor               # зелёный
```

Живой прогон (с разрешения человека): положить в очередь два задания на разные MR
(`fsh watch` на репозитории с конфликтом и упавшим пайплайном), `fsh worker --once
--concurrency 2` - оба отработали параллельно, каталоги разные, в `git -C <проект> worktree
list` после - чисто (gc). Два задания на один MR - второе стартовало после release лока.
`fsh worktrees gc` после - убрал сирот.

# Документация

`AGENTS.md` (карта: `src/worktrees.js`, `src/locks.js`, `src/worker.js`,
`src/commands/worktrees.js`, `src/commands/worker.js`; секция очереди - воркеры появились),
`docs/SPEC.md` (раздел «Очередь заданий»: исполнитель появился, формат лока, attempts),
`PLAN.md` (статус фазы + расхождения), `README.md` (команды).
