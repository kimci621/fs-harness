# PLAN-FAZA-14 - Сквозной оркестратор жизненного цикла задачи

Инструкция для AI-агента. Выполняй шаги по порядку. Исходная формулировка - PLAN.md,
«Фаза 14» (строки 1391-1455). Зависимости: фазы 11 (демон+очередь), 12 (ci-fix), 13
(publish/pending_approval) ДОЛЖНЫ быть закрыты до старта. Критерий приёмки дословно:

> *Готово, когда:* при `automation.enabled: false` (дефолт) ни одна задача не выполняется
> автоматически; при включении задача проходит цепочку от Jira до MR с реакцией на сбои, а
> перезапуск демона её не теряет.

Оценка: 5-7 дней. Три части: 14a (действие `implement`), 14b (учёт расхода), 14c (автомат).
Порядок обязателен: автомат без `implement` - пустая обёртка, без учёта расхода - без
предохранителей.

## Жёсткие ограничения

1. **Автовыполнение строго выключаемое и ПО УМОЛЧАНИЮ ВЫКЛЮЧЕНО.** Конфиг
   `automation: {enabled: false, ...}`, CLI-флаг `--auto-execute`. Без явного включения -
   ни одного автоматического шага. Это главный критерий фазы.
2. Ноль новых внешних программ. npm-зависимостей не нужно.
3. Ошибки - CliError с кодами. Команды - только через registry.js.
4. Воркеры/автомат зовут действия с `yes: true` (SPEC: движок спрашивает confirm, без stdin
   ответ «нет» - задание тихо отменится).
5. П. 4 «чего не делаем» (PLAN.md) НЕ отменяется: знание о том, ЧТО писать в поля Jira,
   живёт в скиллах проекта; харнесс знает только КУДА и КАК (`fsh jira field`).
6. Тесты - `node --test`, без сети; git - настоящие репозитории в mkdtemp (паттерн
   test/task.test.js); fetch/exec - инъекции.
7. Комментарии на русском. Минимальный диф.

## §0. Что прочитать перед началом

- `PLAN.md` 1391-1455 (фаза 14 целиком, включая развёрнутый шаг 9), 495-538 (§D изоляция),
  336-410 (§B движок).
- `src/actions/analyze.js` - образец декларации действия: все поля блока `action`
  (`title, target, writes, isolation, prompt, agent, judge, mcpDescription, inputSchema,
  precheck, dryRun, renderPlan, context, goal, verify, result`).
- `src/actions/ci-fix.js` - образец ПИШУЩЕГО действия: precheck с `meta`, workspace-дескриптор,
  verify с `runChecks`, publish с push + ls-remote + retry джоб, счётчик попыток.
- `src/commands/task.js` - целиком: `dirOf(ctx, opts)` (уже умеет `--project-dir`),
  `branchFor`, гарды `PROTECTED`/`dirty_checkout`/`no_commit`, порядок `start` и `push`,
  `task judge`.
- `src/workspace.js` - `MODES`, `task-worktree` (cleanup его НЕ удаляет никогда - это
  осознанно, уборщик - фаза 15).
- `src/engine.js` - resolveTarget для `target: 'issue'` (~348-353: `ctx.jira().issue(query)`),
  `runAgent` (envelope со стоимостью сейчас ВЫБРАСЫВАЕТСЯ, строки ~295-316), `collect()`.
- `src/agent/stream.js` - `parseClaudeLine`: на `type: 'result'` есть `envelope`
  (`session_id, total_cost_usd, usage, duration_ms`). У agy - свой envelope.
- `src/jira.js` - `issue()`, `transition()`, `editMeta`, `updateIssue`, `fieldByName`,
  `errorText` (как собирается тело 400 workflow-валидатора).
- `src/prompts/flows/take-task.md` - существующий протокол человеко-сессии (implement его
  НЕ заменяет, это отдельный сценарий).
- `src/prompts/actions/ci-fix.md` - образец промпта пишущего действия.
- `src/watch.js` - `diffSnapshots`: какие события рождаются; фильтра «свои события» НЕТ.
- `test/task.test.js`, `test/ci-fix.test.js`, `test/e2e-actions.test.js` - паттерны.

## Известные факты кода (сверено 2026-09-21)

- `task start`/`task push` УЖЕ умеют работать по переданному каталогу: `dirOf()` =
  `opts.projectDir || cfg.projectDir`, CLI-флаг `--project-dir` есть, MCP пробрасывает `dir`.
  Пункт плана «учатся работать по переданному каталогу» = рефактор в чистые функции + тест,
  а не новая механика.
- `acquireWorkspace` принимает `baseRef`, но НЕ использует его (`base = ref ? origin/ref :
  HEAD`). Имя ветки в worktree всегда `fs-harness/<action>-<key>-<stamp>` - для implement
  нужна `feature/{key}` по `branchPattern`, значит acquireWorkspace надо научить принимать
  явное имя ветки.
- Стоимость АГЕНТА (не судьи) сейчас теряется: engine деструктурирует из строки потока только
  `{activity, result, passthrough, session}`, `envelope` с `total_cost_usd`/`usage` не читается.
- `cfg.judge.roles['task-acceptance']` уже есть (используется в `task judge`).
- У задания очереди поле `action` уже проставляется: conflict/threads; у `pipeline` - null
  (ждало ci-fix - надо проставить).
- Кастомные поля Jira ищутся по ИМЕНИ через `expand=names` (`fieldByName`), не по customfield_*.

---

# Часть 14a. Действие `implement`

## Шаг 1. Рефактор task start/push в чистые функции

**Файл: `src/commands/task.js`.**

1.1. Вынеси из `cmdTask` тела подкоманд в экспортируемые функции:
`startTask(ctx, dir, key, opts)` и `pushTask(ctx, dir, opts)` - сигнатуры уже фактически такие
(dirOf вызывается внутри, замени на явный параметр `dir`). `cmdTask` оставляет только диспатч
и печать. Никакой смены поведения.

1.2. `pushTask` должен принимать `opts.skipConfirm` (сегодня confirm снимают `yes`/`asObject` -
это уже работает, просто убедись, что publish действия сможет позвать функцию с `yes: true`).

**Тест: `test/task.test.js`** - существующие тесты зелёные без правок логики (только импорты,
если переехали). Новый тест: `startTask`/`pushTask` вызванные с `dir` = отдельный клон - не
трогают cwd процесса (chdir нет, все git-вызовы с `-C dir` / cwd).

## Шаг 2. acquireWorkspace: явное имя ветки

**Файл: `src/workspace.js`.** В `acquireWorkspace` добавь опциональный параметр
`branch`: если передан - worktree создаётся на нём (`git worktree add <dir> -b <branch>
<base>` вместо генерированного `fs-harness/...`). Существующая ветка (повторный заход на
задачу): `git worktree add <dir> <branch>` без `-b`. Проверка существования -
`git rev-parse --verify <branch>` и `ls-remote --heads origin <branch>` (логика уже есть в
task.js start - не дублируй, переиспользуй через параметр или маленький helper).

**Тест: `test/workspace.test.js`** - worktree с явной веткой: создание новой, подключение
существующей, конфликт имён (ветка занята другим worktree - осмысленная CliError).

## Шаг 3. Декларация действия implement

**Новый файл: `src/actions/implement.js`** - по образцу ci-fix.js:

```
export const implementAction = {
  name: 'implement', kind: 'action',
  usage: 'implement <KEY>', 
  description: 'Реализовать задачу Jira: ветка, код, проверки, судья, MR',
  example: 'fsh implement FD-7655',
  action: {
    title: 'Реализация задачи',
    target: 'issue',          // engine сам резолвит через ctx.jira().issue()
    writes: true,
    isolation: 'task-worktree',
    prompt: 'actions/implement',
    agent: {default: 'cc'},
    judge: {gate: 'pre-push', role: 'acceptance'},
    ...
  }
}
```

3.1. `precheck(x)`: issue уже в `x.target` (engine резолвит). Проверь: ключ матчит
`/^[A-Z][A-Z0-9]+-\d+$/`; статус не «Done»/«Закрыт» (точные имена статусов возьми из живой
Jira через `fsh jira <KEY> --json`, не выдумывай). `skip`, если MR по ветке уже открыт и
зелёный (задача фактически сделана) - верни `skip: 'MR уже открыт: !<iid>'`. `meta`:
`{repo, issue: key, issue_summary, branch: branchFor(key, cfg.branchPattern), target_branch:
cfg.targetBranch, project_dir}`.

3.2. workspace-дескриптор: `{mode: 'task-worktree', project: projectDir, ref:
target_branch, branch: feature/<KEY> (шаг 2), key: <KEY>}`. baseRef - target_branch.

3.3. `context(x)`: переменные промпта - `issue_key, issue_summary, issue_status,
issue_description, issue_comments, issue_url, branch, target_branch, worktree,
deps_available, project_dir, checks` (список команд checks текстом). Комментарии задачи -
как в analyze.js (лимит, обрезка).

3.4. `goal(x)`: «Реализовать <KEY>: <summary> по описанию задачи».

3.5. `verify(x)`: `commits_ahead` (от origin/target), `head_sha`, `changed_files`, `diff`
(три точки), `deps_available`, `checks: checksFact(...) ?? runChecks(cfg.checks, ws.dir)`.
`commits_ahead === 0` - не провал сам по себе (агент мог решить, что код не нужен), но факт
у судьи перед глазами.

3.6. `publish(x)`: `pushTask(ctx, ws.dir, {...opts, yes: true})` (шаг 1). Он сам: rev-list,
существующий MR, createMR, push -u. Верни `{mr: {iid, web_url}, branch, pushed: head_sha}`.
`--post` (Mattermost) здесь НЕ зови - отдельное решение человека/оркестратора.

3.7. `dryRun`/`renderPlan`: ветка, worktree-путь, число команд checks, «после судьи: push +
MR в <target_branch>».

3.8. `result(x)`: `{ok: true, run, issue: key, mr, branch, judge}`.

**Регистрация: `src/registry.js`** - одна строка `fromAction(implementAction)` в COMMANDS
(рядом с conflict/threads). MCP-инструмент синтезируется автоматом - `mcpDescription` и
`inputSchema` (`{key: {type: 'string', description}}`) заполни.

## Шаг 4. Промпт `src/prompts/actions/implement.md`

Front-matter: `vars: [issue_key, issue_summary, issue_status, issue_description,
issue_comments, issue_url, branch, target_branch, worktree, deps_available, project_dir,
checks]`, `judge: acceptance`. Тело по образцу ci-fix.md: роль, задача, рабочий каталог
(worktree, НЕ живой чекаут), порядок работы (прочитай задачу → AGENTS.md проекта → реализация
→ прогони checks → коммиты в ветку `{{branch}}`), запреты (не пушить - push делает харнесс;
не трогать защищённые ветки; deps_available=false - не запускать npm install). Секция
«Если задача неясна» - остановись и напиши в финальном отчёте, чего не хватает (это уйдёт
судье).

`npm test` сам подхватит: `checkTemplates()` сверит vars с телом.

**Тест: `test/implement.test.js` (новый)** - по образцу test/ci-fix.test.js: precheck на
мок-jira, skip при открытом MR, context собирает все vars (прогон renderTemplate без
prompt_var_missing), verify на настоящем git в mkdtemp. E2E с мок-агентом - в
test/e2e-actions.test.js по существующему паттерну.

---

# Часть 14b. Учёт расхода

## Шаг 5. Стоимость агента перестаёт теряться

**Файл: `src/engine.js`**, `runAgent` (~295-316): деструктурируй `envelope` из строк потока
(claude: `type:'result'`; agy: свой envelope - смотри parseAgyLine). После завершения агента:
`x.agentCost = {cost_usd: envelope?.total_cost_usd ?? null, usage: envelope?.usage ?? null,
duration_ms: envelope?.duration_ms ?? null}`. В `collect()` пиши `agent_cost` в meta.json
рядом с `session_id`. Подписка (cc/opus-cli): `total_cost_usd` там ОЦЕНКА, не счёт - пиши
как есть, трактовка на уровне выше (шаг 6).

**Тест: `test/agent-stream.test.js` / e2e** - на записанном конверте result: meta.json
содержит `agent_cost.cost_usd`.

## Шаг 6. Накопитель на диске

**Новый файл: `src/costs.js`.**

6.1. `appendCost({root, record})` - JSONL в `~/.local/state/fs-harness/costs.jsonl`:
`{at, run, action, project, issue?, mr?, profile, agent_cost, judge_cost}`. Зовётся из
engine при завершении рана (done И error - потрачено в любом случае).

6.2. `sumCosts({root, issue?, since?})` - агрегат по задаче/времени. Читает JSONL целиком
(файл маленький, ротейшен не занимаемся - ponytail: при >10k строк читать медленно, тогда
ротация по месяцу).

6.3. Показ: `fsh auto status <KEY>` (шаг 8) печатает потраченное по задаче; в TUI вкладке
истории добавь колонку цены рана (agent+judge), если её ещё нет - одна строка в tui/app.js.

**Тест: `test/costs.test.js`** - append/sum с root в mkdtemp, фильтр по issue.

## Шаг 7. Рейт-лимит отдельно от провала

**Файл: `src/engine.js`** (или spawn.js - где читается stderr агента): распознавание
rate-limit по выходу агента. Практический критерий: ненулевой код И в stderr/stdout хвосте
есть /rate.?limit|429|overloaded/i (сверь с реальным выводом `claude` при лимите - сделай
один живой прогон руками и запиши точную строку в тест). Новый код ошибки
`agent_rate_limited` вместо общего `agent_failed`. В событие error клади `retry_after`, если
удалось вытащить из текста (секунды/время reset); не удалось - дефолт 30 мин, константа с
комментарием ponytail.

**Тест** - стрим с записанным rate-limit выводом даёт error.code === 'agent_rate_limited'.

---

# Часть 14c. Автомат

## Шаг 8. Конфиг, флаг, состояние на диске

**`src/config.js`**: `DEFAULTS.automation = {enabled: false, maxCostPerTask: 2.0,
maxRetries: 3, maxSteps: 30}`. Слияние верхнего уровня уже есть для соседних секций -
добавь `automation` в тот же список.

**`src/main.js`**: флаг `--auto-execute` в parseArgs (boolean) + строка в FLAGS_USAGE.

**Новый файл: `src/auto.js`.** Состояние задачи:
`~/.local/state/fs-harness/auto/<KEY>.json`:

```
{key, step: 'start|implement|review|ci|threads|conflict|jira|done|failed|paused',
 history: [{step, at, run?, ok, note}], spent_usd, attempts: {<step>: n}, paused_until?,
 mr?, branch?, worktree?, updated_at}
```

Функции: `loadAuto(root, key)`, `saveAuto(root, state)`, `listAuto(root)`,
`stopAuto(root, key)` (ставит step:'failed', note:'остановлено человеком'). Перезапуск демона
не теряет задачу ИМЕННО потому, что шаг вычисляется из этого файла, а не из памяти.

## Шаг 9. Стейт-машина `advanceTask`

**`src/auto.js` (продолжение).** `advanceTask(key, deps)` - один шаг машины, идемпотентный:
прочитал состояние → сверился с миром (Jira/GitLab) → сделал ровно один переход → записал.
Гарды на КАЖДЫЙ переход: `cfg.automation.enabled === true` (перечитывается каждый цикл, не на
старте!), `paused_until` не наступил, `attempts[step] < maxRetries`, `spent_usd <
maxCostPerTask` (только для профилей с ключом: подписка cc/opus-cli денег за вызов не тратит -
проверяй `agents[profile].keyFile`/`secret`, у подписочных профилей предохранители таймаут и
maxRetries), суммарная длина history < maxSteps. Любой гард - стоп с записью причины в state.

Переходы (номера по PLAN):

1. `start`: `startTask(ctx, dir, key)` - но в автомате НЕ живой чекаут: ветку готовит
   implement в своём task-worktree (шаг 2, 3.2). Значит шаг «создание ветки» здесь -
   просто проверка, что задача существует и переведена «В работе».
2. `implement`: `runAction(implementAction, ..., {yes: true, json: true})`. Ошибка
   `agent_rate_limited` (шаг 7) - `paused_until = now + retry_after`, попытка НЕ засчитывается.
   `judge_rejected` после maxRevise - стоп, зов человека (Telegram «судья отклонил дважды»).
3. `judge`: локальные checks уже внутри implement.verify; здесь - переход «В ревью»:
   3.1. агент прогоняет скиллы проекта (manual-qa → текст «Technical details for QA»,
        словарь/флаги → «Контент») - ОДИН вызов агента с промптом flows/fill-jira.md;
   3.2. тексты кладутся через существующую `fsh jira field <KEY> "<поле>" --file -`;
   3.3. POST перехода через `ctx.jira().transition`. Пришёл 400 - `errorText` уже даёт список
        недостающих полей: пишем его в history + Telegram «нужен человек: поля X, Y»,
        step paused до ручного вмешательства. Это ШТАТНЫЙ исход, не сбой (PLAN 1441-1443).
4. `ci`: мониторинг пайплайна MR: failed → запуск `ci-fix` действия (оно само с попытками).
5. `threads`: появились открытые треды → `threads` действие.
6. `conflict`: has_conflicts → `conflict` действие.
7. `done`: CI зелёный, треды закрыты - финальный статус Jira («Готово к тестированию»),
   Telegram-отчёт, step: done.

Шаги 4-6 срабатывают по событиям watcher'а (он уже кладёт их в очередь) - автомат подбирает
задания очереди по своим задачам. Связка: задание очереди с kind conflict/threads/pipeline
и MR известной auto-задачи → соответствующий переход.

## Шаг 10. Фильтр «не реагируем на свои события»

**Файл: `src/watch.js`.** В `diffSnapshots` или при постановке в очередь (`enqueueKept` в
commands/watch.js): отбрасывай события, порождённые самим харнессом: автор заметки/треда - я
(`g.me()` закэшируй на снимок), pipeline на sha, который записан в state автомата как наш же
push (`auto/<KEY>.json` → head_sha). Без этого ответ в тред родит событие «новые треды» и
цикл заведётся сам от себя (PLAN 1448-1450).

**Тест: `test/watch.test.js`** - событие от автора=me в очередь не попадает; pipeline на
нашем sha - тоже.

## Шаг 11. CLI и встраивание в демон

**Новый файл: `src/commands/auto.js`** - `fsh auto <KEY>` (взять задачу в автомат: создать
state, сделать первый шаг), `fsh auto status [KEY]` (таблица состояний, spent_usd из
costs.js), `fsh auto stop <KEY>`. Registry: без mcp-экспорта (запуск автомата - решение
человека).

**Встраивание в демон**: в `cmdWatchDaemon` (commands/watch.js) после опроса проекта: если
`cfg.automation.enabled && opts.autoExecute` - для каждой активной auto-задачи проекта один
`advanceTask`. Без `--auto-execute` демон автоматику НЕ крутит даже при enabled:true (двойной
предохранитель, PLAN 1416). Триггер «задача перешла В работе»: демон раз в цикл дёргает
`searchJql('assignee = currentUser() AND status = "В работе" AND key NOT IN (<уже в auto>)')`
- новые ключи НЕ стартуют автоматически, а предлагаются в Telegram («FD-X в работе, запустить
автомат? fsh auto FD-X»). Автостарт без человека - только если в конфиге
`automation.autoStart: true` (дефолт false). Это соответствует духу «выключаемо по
умолчанию».

**Тест: `test/auto.test.js` (новый)** - машина на моках: выключенная автоматика - ноль
вызовов действий (прямой критерий плана); rate-limit - paused_until, попытка не сгорела;
maxRetries исчерпан - стоп; перезапуск (новый вызов advanceTask без памяти) продолжает с
шага из файла; 400 от Jira - paused с записью полей, Telegram позван.

## Шаг 12. Документация

`AGENTS.md` (карта: `src/actions/implement.js`, `src/auto.js`, `src/costs.js`,
`src/commands/auto.js`), `docs/SPEC.md` (стейт-машина, коды `agent_rate_limited`,
`paused_until`), `PLAN.md` (статус фазы, расхождения), `README.md` (команды auto/implement).

---

# Финальная верификация

```bash
npm test
rm -rf node_modules && npm ci && npm test
node bin/fsh.js help                       # implement и auto в справке
node bin/fsh.js doctor                     # зелёный
node bin/fsh.js implement FD-XXX --dry-run # план без side-effect'ов
fsh auto status                            # пусто, не падает
```

Живой прогон (только с разрешения человека): `automation.enabled: false` - демон сутки
крутится, ноль автоматических действий (главный критерий). Затем включить на ОДНОЙ
тестовой задаче: `fsh auto FD-XXX` → задача доезжает до MR; перезапуск демона посреди -
продолжает; `fsh auto stop` - останавливает.
