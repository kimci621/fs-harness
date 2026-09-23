# AGENTS.md — FS-Harness для AI-агентов

Устройство того, что в репозитории есть сейчас. Спецификация проекта и план работ — в [PLAN.md](PLAN.md), правила работы — в [CLAUDE.md](CLAUDE.md). Ты поддерживаешь или расширяешь `fsh` — читай этот файл целиком перед правками.

## Что это

CLI над `glab api` для работы с MR и пайплайнами GitLab плюс запуск AI-агента на конфликтах с приёмкой результата судьёй. Стек: Node.js ESM, зависимости ставятся через `npm ci`, из внешних программ нужны только `node`, `git` (≥2.38, ради `merge-tree --write-tree`), `glab` и `claude`. Весь вывод данных — JSON через `glab api`, никакого парсинга человекочитаемого вывода glab. Дизайн-решение зафиксировано в `docs/SPEC.md`.

## Карта файлов

```
bin/fsh.js        точка входа: import + main()
src/main.js             разбор argv, dispatch, help, обработка ошибок
src/glab.js             ВСЕ вызовы glab api. exec инжектируется (тесты). apiRaw — ответы не-JSON (лог джобы)
src/resolve.js          поиск MR: по номеру или части имени ветки (неточный)
src/pipeline.js         ensureMRPipeline, findJob, deployJobName, mapLimit
src/ui.js               спиннер, live-таблица, waitJob (опрос джоб)
src/format.js           иконки статусов, humanize, таблицы, строки MR
src/commands/*.js       по файлу на команду: mrs, mr, jobs, run, deploy, commit, doctor, ask, agent-guide, mr-comments, prompts, jira, task, growthbook, flow, init, mm, runs, retry, resume, publish, revise, bot, auto
src/costs.js          накопитель расходов по ранам и задачам (costs.jsonl), sumCosts / appendCost
src/auto.js           автоматика жизненного цикла задачи (auto/<KEY>.json), advanceTask, load/save/list/stopAuto
src/commands/auto.js  команда fsh auto: запуск, статус, остановка задачи в автомате
src/publish.js          publishRun/reviseRun: доигрывание pending_approval из meta.json, проверки HEAD/ls-remote/merge-tree, dodelka в той же сессии
src/tgbot.js            двусторонний Telegram: tgCall, getUpdates (long-polling), inline-кнопки, allowlist, handleUpdate, offset в tgbot.json
src/commands/bot.js     fsh bot: демон бота (цикл getUpdates, команды /mrs /watch /status /run, кнопки appr/rev/rej, sweepExpiredApprovals)
src/jira.js             Jira REST: чтение и записи (статус, спринт, комментарий, поле, вложения), fetch инжектируется (тесты)
src/commands/task.js    ветка задачи, push с открытием MR и submit (снять draft, Jira в ревью, пост в MM): гарды защищённых веток и грязного дерева
src/growthbook.js       GrowthBook REST: фича-флаги (list/get/create/toggle/delete), fetch инжектируется (тесты)
src/mattermost.js       Mattermost REST: вход по паролю, me, отправка в канал, fetch инжектируется (тесты)
src/dict.js             REST словаря бэкенда (rest-token): CRUD + refresh кэша, fetch инжектируется (тесты)
src/config.js           конфиг v1/v2 (~/.config/gl-helper/config.json), миграция v1 в памяти, выбор активного проекта
src/config-cmd.js       команда config: init/show/migrate (запись миграции на диск с .v1.bak)
src/workspace.js        makeGit и режимы изоляции (checkout, одноразовый worktree, worktree задачи) + стратегии node_modules
src/secrets.js          ключи: env → keychain (security) → файл (~/.growthbook_apikey, REST_TOKEN из .env бэкенда) → ошибка с командой заведения
src/notify.js           уведомления в Telegram: runMessage + postTelegram (Bot API), fetch инжектируется
src/watch.js            watcher: снимок MR, diffSnapshots, триаж ролью event-triage; состояние в ~/.local/state/fs-harness/watch; проверка секретов демона
src/queue.js            очередь заданий watcher: ключ идемпотентности (source:kind:mr:sha), TTL, чтение и уборка; ~/.local/state/fs-harness/queue
src/commands/watch.js   fsh watch: один опрос, --daemon (цикл по всем проектам), install (печать launchd/systemd-юнита)
src/agents.js           профили агента: имя → bin/args/env/keyFile, ключ читается при запуске
src/agent/spawn.js      запуск агента процессом: промпт в stdin, стрим строк, abort, SIGTERM→SIGKILL
src/agent/events.js     поток событий с pull-семантикой (буфер + курсор на итератор)
src/agent/stream.js     разбор stream-json: claude (type) и agy (event) — активность, дельты, отчёт
src/chat.js             многоходовый чат с агентом: живой процесс на NDJSON (claude, agy)
src/commands/ask.js     мастер по самому fsh: бриф об упавшем ране, выбор профиля, read-only из CLI
src/agent/journal.js    раны в ~/.local/state/fs-harness/runs/<id>/: meta.json (state/error/pid/pre), patchRunMeta/setRunState, listRuns, pidAlive/runIsActive
src/judge/index.js      judge(): рубрика + профиль → вердикт, фолбэк, ремонтный round-trip
src/judge/schema.js     zod-схема вердикта, VERDICT_SHAPE, extractJson
src/judge/payload.js    что показывать судье в роли acceptance
src/checks.js           коды выхода проверок проекта для судьи; упавшая проверка повторяется (флейк)
src/judge/providers/    cli (процесс claude) и openai (всё OpenAI-совместимое)
src/prompts/judge/*.md  рубрики по ролям — файл на роль
src/prompts/flows/*.md  сценарии работы для агента: протокол на файл, description во front-matter
src/engine.js           runAction: фазы действия, события, изоляция, гейт судьи; resumeOf — доигрывание упавшего рана в том же worktree/сессии; runActionCLI, judgeRun
src/publish.js          publish <runId>: доопубликовать упавший на push/build ран без агента и судьи; reconstructPre для ранов без meta.pre
src/actions/*.js        декларации действий (conflict, ci-fix, threads, review, analyze, implement): precheck/context/verify/publish и блок action
src/actions/implement.js реализация задачи Jira: план (opus) → код (gemini) → ревью судьёй (до 3) → push + черновик MR; в ревью отправляет fsh task submit
src/actions/ci-fix.js   починка упавших джоб: выжимка из логов, счётчик попыток в ~/.local/state/fs-harness/ci-fix
src/prompts.js          шаблоны: loadTemplate/renderTemplate/listTemplates/checkTemplates
src/registry.js         ЕДИНЫЙ реестр команд: dispatch, help, agent-guide и MCP tools/list генерируются из него
src/mcp.js              MCP-сервер (stdio): обработка JSON-RPC, инструменты берёт из registry
src/tui/store.js        TUI: чистое состояние и раскладка клавиш (reduce, keyIntent) — без ink
src/tui/app.js          TUI: экран на ink + htm (вкладки MR/задачи/история/промпты/флаги/словарь, лог, карточки ранов, панель пайплайна, CRUD-модалки флагов и словаря, вложения задачи, окно мастера)
src/tui/index.js        startTUI: проверка живого терминала, ленивый импорт ink/react
test/*.test.js          node --test, мокнутый exec — без сети
```

## Принципы

1. **Любая команда = чистые функции над объектом `g`** (экземпляр createGlab). Команды не обращаются к glab напрямую — только через `g.<метод>`. Так их можно тестировать моком.
2. **Люди и агенты — равные потребители**: читаемый вывод в stdout, анимации — в stderr, `--json` — стабильные поля для скриптов.
3. **Ошибки — через `CliError`** (из `src/errors.js`): печатается только сообщение, понятный совет «что делать», exit code 1 (или заданный). Никаких сырых stack trace.
4. **Ожидание — только через `waitJob`** из `ui.js`: опрос каждые 5с, живая таблица джоб пайплайна, таймаут 1ч. Терминальные статусы: success, failed, canceled, skipped.
5. **Комментарии в коде — на русском**, короткие, только «что делает».

## Карта «команда → вызовы glab» (glab.js)

| Метод `g` | glab api |
|---|---|
| `listOpenMRs(repo, params)` | `GET /merge_requests?state=opened&per_page=100&order_by=updated_at&sort=desc` + фильтры (`author_username`, `reviewer_username`, `target_branch`, `labels`, `search`, `wip`) |
| `me()` | `GET /user` — единственный непроектный путь, нужен для фильтров со значением `me` |
| `getMR(repo, iid)` | `GET /merge_requests/{iid}` |
| `getDiscussions(repo, iid)` | `GET /merge_requests/{iid}/discussions?per_page=100` |
| `listMRPipelines(repo)` | `GET /pipelines?source=merge_request_event&per_page=100` |
| `getPipeline(repo, pid)` | `GET /pipelines/{pid}` |
| `getJobs(repo, pid)` | `GET /pipelines/{pid}/jobs?per_page=100` |
| `getJob(repo, jid)` | `GET /jobs/{jid}` |
| `playJob(repo, jid)` | `POST /jobs/{jid}/play` |
| `retryJob(repo, jid)` | `POST /jobs/{jid}/retry` — retry создаёт НОВУЮ джобу (новый id) |
| `getJobTrace(repo, jid)` | `GET /jobs/{jid}/trace` — **не JSON**: идёт через `apiRaw`, обычный `api()` вернул бы `null` |
| `createMRPipeline(repo, iid)` | `POST /merge_requests/{iid}/pipelines` |
| `createDiscussion(repo, iid, fields)` | `POST /merge_requests/{iid}/discussions` |
| `createNote(repo, iid, body)` | `POST /merge_requests/{iid}/notes` |

Каждый вызов идёт с `--hostname <host из конфига>` (иначе glab выберет хост по git remote cwd — источник загадочных 404) и ретраями GET до 5 раз (флапающий GitLab).

## Действия (kind: 'action')

Действие — это запуск агента с проверкой судьёй. Оно **не пишется как команда**: пишется декларация
в `src/actions/<имя>.js`, а CLI-команду и MCP-инструмент из неё синтезирует `fromAction()` в реестре.
Порядок фаз один на все действия и живёт в `runAction`:

```
resolve target → precheck → (skip?) → context → isolate → plan? → prompt
  → agent → verify → judge → publish → cleanup
```

`plan` — необязательный шаг: отдельный агент (`action.plan.agent`) со своим шаблоном
(`action.plan.prompt`) и своей сессией до исполнителя, его текст уходит в переменную `plan`.
`judge.maxRevise` у действия перебивает общий (у implement — 3).

Блок `action`:

| Поле | Что это |
|---|---|
| `target` | `'mr'` \| `'issue'` \| `'none'` — что резолвить из первого аргумента |
| `writes` | меняет ли внешнее состояние; при `true` обязательны `publish` и гейт судьи |
| `isolation` | `'checkout'` \| `'ephemeral-worktree'` \| `'task-worktree'` |
| `prompt` | имя шаблона в `src/prompts/` |
| `plan` | `{agent, prompt}` — необязательный планировщик до исполнителя; его текст уходит в `plan` |
| `judge` | `{gate: 'pre-push'\|'advisory'\|'none', role, maxRevise?}` |
| `agent` | `{default}` — имя профиля из `agents` в конфиге, перебивается `--agent` |
| `precheck(x)` | до изоляции: посчитать факты, решить `skip`, отдать описание workspace |
| `dryRun(x)` / `renderPlan(plan, log)` | план без side-effect'ов и его отрисовка |
| `context(x)` | переменные промпта (списки собираются здесь, в шаблоне только подстановка) |
| `goal(x)` | одна фраза «что просили» — уходит судье |
| `verify(x)` | механические факты после агента; ни одного «по словам агента» |
| `publish(x)` | единственное место side-effect'ов, зовётся ТОЛЬКО после approve |
| `result(x)` | финальный объект для `--json` |

`x` — контекст рана: `{ctx, opts, input, target, pre, run, ws, vars, facts, verdict, published, say, emit, phase, signal}`.

Вывод идёт только событиями (`{t:'log'|'phase'|'verdict'|'done'|'error'}`), их рендерит
`runActionCLI`. Не печатай из хуков — используй `say`.

## Как добавить команду

**Единственное место регистрации — `src/registry.js`.** Добавил запись в `COMMANDS` → команда появилась в dispatch, help, agent-guide и MCP tools/list одновременно.

1. `src/commands/<имя>.js`: `export async function cmdX(g, repo, args, opts)`.
   - `args` — позиционные аргументы после команды; `opts` — флаги (словарь из `parseArgs` в main.js).
   - Для «найти MR по номеру/ветке» — `resolveMR(g, repo, query)`.
   - Для запуска джоб всегда используй `startJob(g, repo, job, {force})` из `pipeline.js`: manual → play, failed/canceled → retry, force — retry даже success. Возвращает актуальный `{id, status}` — retry меняет id, ждать нужно по нему.
   - `commit` — исключение: работает без `g` (только git + агент), сигнатура `cmdX(args, opts)`.
   - Поддержи `asObject: true` — вернуть результат объектом без печати (нужно MCP).
2. `src/registry.js`: запись в `COMMANDS` — name, usage, description, example, run(ctx, args, opts) и (для экспорта в MCP) `mcp: {description, inputSchema, call(ctx, args)}`.
3. Тесты: `test/<имя>.test.js` на чистую логику команды + `test/registry.test.js` проверит целостность записи автоматически.
4. Новый флаг — в `parseArgs` (main.js) и в `FLAGS_USAGE` там же.

Команда считается готовой, если: работает `--json` (для read-команд), ошибки — CliError с подсказкой, `npm test` зелёный, запись есть в registry (README-таблица — по желанию).

## Промпты для агентов

Шаблоны лежат в `src/prompts/` (`.md` с необязательным front-matter). Порядок переопределения,
первое попадание: `<projectDir>/.fs-harness/prompts/<имя>.md` → `~/.config/fs-harness/prompts/<имя>.md`
→ встроенный. Рендер — `mustache` с выключенным HTML-экранированием; объявленная в `vars`, но не
переданная переменная — `CliError('prompt_var_missing')`, а не тихая пустота.

`.llm-commit-pattern` в корне репозитория по-прежнему работает: он подменяет переменную `pattern`
в `commit.md`, то есть паттерн сообщения, а не всю инструкцию.

`checkTemplates()` сверяет front-matter с телом и гоняется в `npm test` — правка шаблона, потерявшая
переменную, падает на тестах, а не в проде.

## Судья

Приёмщик работы агента. Вызывается из пишущих действий **до** push и решает, пускать результат наружу или нет.

- `judge({role, payload, cfg, profile, signal, onDelta})` → вердикт с `meta` (профиль, модель, токены, цена). Бросает на любом провале.
- **Вызывающий обязан трактовать любой провал как «не approve»**: `isApproved(v)` и только потом push. Тихо пропускать нельзя — в этом весь смысл гейта.
- Роль → рубрика `src/prompts/judge/<role>.md` + список профилей из `cfg.judge.roles`. Список означает фолбэк по порядку: не ответил бэкенд — идём к следующему. Исключение — `judge_schema`: невалидная схема это беда модели, а не бэкенда, и сменой профиля не лечится.
- Схема проверяется всегда, что бы ни обещал провайдер. Провал → один ремонтный запрос с `error.issues` → второй провал → `CliError(..., 'judge_schema')`.

- Вердикт `revise` на гейте `pre-push` — не отказ: движок зовёт агента снова с `reviseMessage(verdict)` в ту же сессию (`SESSION_ARGS` в `engine.js`), пересобирает факты и судит заново, не больше `cfg.judge.maxRevise` раз (дефолт 1). Агента без записи в `SESSION_ARGS` на доделку не зовут: без сессии он начал бы с нуля.

**Новая роль:** файл рубрики в `src/prompts/judge/`, запись в `judge.roles` в `DEFAULTS` (`config.js`), сборщик payload рядом с `buildAcceptancePayload`. Схема вердикта общая на все роли — не плоди вторую.

**Новый провайдер:** файл в `src/judge/providers/`, ветка в `createProvider`. Контракт один: `{name, schemaStrength, model, complete({system, user, effort, signal, onDelta}) → {text, model, usage, cost, sessionId}}`. Ошибки — `CliError(..., 'judge_failed')`, чтобы сработал фолбэк.

**Тесты судьи не ходят в сеть**: `judge()` принимает `makeProvider`, `createOpenAIProvider` — `makeClient`. Живая модель дёргается только руками.

## Режим агента (важно)

- `GL_HELPER_JSON=1` — все команды отдают JSON; side-effect команды — финальный результат `{ok:true, ...}` в stdout, прогресс в stderr. Ошибки: `{ok:false,error:{code,message}}` в stdout, exit ≠ 0.
- `GL_HELPER_YES=1` — авто-подтверждение (аналог -y).
- `--dry-run` — план без side-effect'ов для run/deploy/действий/commit.
- `fsh agent-guide` — самодостаточная инструкция, которую агент запускает первой.
- В командах весь прогресс печатай через `makeLogger(json)` из `output.js`, итог — через `finish(json, obj)`. Ошибки — `CliError(msg, exitCode, code)` с машинным кодом.
- `asObject: true` в опциях команды — вернуть результат объектом без печати (так команды вызывает MCP-сервер). Никогда не печатай в stdout из MCP-режима: stdout занят протоколом.
- `quiet: true` и `onTick(text)` в `waitJob` — тихий режим ожидания с прогресс-нотификациями для MCP.

## MCP-сервер (src/mcp.js)

- Протокол: JSON-RPC 2.0 поверх stdio, **одно сообщение = одна строка JSON**. stdout — только протокол.
- Методы: `initialize`, `ping`, `tools/list`, `tools/call`. Нотификации игнорируются, при закрытии stdin сервер выходит.
- Инструменты описаны в `createMCPContext({cfg, g, notify})`: name, description (по нему модель маршрутизирует), inputSchema (JSON Schema), handler(args). Хендлеры вызывают команды с `asObject: true`.
- Ошибки инструмента: `{content:[{type:'text',...}], isError: true}` с `{ok:false,error:{code,message}}` в тексте.
- Добавить инструмент: строка в `tools` массива + тест в `test/mcp.test.js`.

## Контракт --json

`mrs`/`mr`: `{iid, title, draft, source_branch, target_branch, has_conflicts, pipeline: {id, status}|null, pipeline_stale, comments: {total, open, resolved}, updated_at, web_url}`.

`jobs`: `{pipeline: {id, status, web_url}, jobs: [{id, name, stage, status, web_url}]}`.

`review`: `{ok, run, mr, review: '<текст находок>', judge: {...}|{skipped:true}}`; `analyze`: `{ok, run, issue, analysis: '<текст разбора>'}`; `implement`: `{ok, run, issue, branch, target, head_sha, commits_ahead, mr: {iid, web_url, draft}, judge}`; `task submit`: `{ok, key, branch, mr, title, draft_removed, jira: {from, to, transition}, posted}`; `jira`: `{ok, issues:[...]}` либо `{ok, issue:{...}, comments:[...]}`.

`run`/`deploy`/`conflict`/`threads`/`commit`: финальный `{ok: true, ...}` с фактическим результатом (джобы, хэши, web_url); `--dry-run` — `{ok, dry_run, plan...}` без запусков. У `conflict` дополнительно `conflict_files: string[]` и `has_conflicts` — посчитанные `git merge-tree`, а не взятые из GitLab, `run` (id рана) и `judge: {decision, confidence, summary, profile, cost}` либо `{skipped: true}` при `--no-judge`. У `threads` — `threads_open`, `replied: string[]`, `resolved: string[]`, `commits_ahead` (ноль — норма: тред мог требовать только ответа).

Ошибки: `{ok:false, error:{code, message}}`; коды перечислены в `agent-guide`.

## Мастер по самому fsh (chat.js + commands/ask.js)

Диалог с агентом, который работает в каталоге **харнесса**, а не проекта: он читает `CLAUDE.md`,
`AGENTS.md`, `PLAN.md`, `docs/SPEC.md` и `src/` сам и правит их же.

- Вызов: клавиша `A` в TUI (окно поверх экрана, многоходовый разговор) и `fsh ask "<вопрос>"
  [--run <id>]` в CLI (один ход, только чтение). В хвосте любой ошибки, кроме `usage` и `canceled`,
  печатается `разобраться: fsh ask`.
- Транспорт выбирается по семейству профиля: `claude` и `agy` держат
  `--input-format stream-json` - **один живой процесс, NDJSON-строка на реплику**, контекст держит
  сам агент, id сессии не нужен. Отсюда `keepStdin` и `write()` в `spawnAgent`.
- Профиль: `--agent` > `chat.agent` в конфиге > `agy` > `cc`. **`agy` опционален**: нет в
  PATH - `pickChatAgent` молча берёт `cc`, дефолтный конфиг без него рабочий. Это и есть условие, на
  котором `agy` не нарушает ограничение №1.
- Права: окно в TUI работает профилем как есть (гейт - человек за клавиатурой, он видит каждый шаг),
  `fsh ask` без TTY снимает `--dangerously-skip-permissions` и ставит режим плана.
- **В бриф не попадает конфиг ни в каком виде**: в `telegram.bot_token` живой секрет. Кладутся
  только рантайм-факты рана (id, `code`, текст ошибки, 40 строк хвоста журнала, имена артефактов) —
  файлы репозитория агент читает сам и видит свежее.

## Уведомления в Telegram (notify.js + tgbot.js)

Исходящие уведомления (`runMessage` + `postTelegram`) идут в чат по завершении рана. При
`telegram.approvals: true` и заполненном `allowed_user_ids` гейт pre-push не пушит сам: ран
останавливается в `state: pending_approval`, worktree сохраняется, в Telegram уходят кнопки
Approve/Revise/Reject (callback_data `appr|rev|rej:<runId>:<nonce>`, nonce одноразовый).
Push делает `fsh publish <runId>` (перепроверяет HEAD и `ls-remote`), доделку в той же
сессии - `fsh revise <runId>`. Аппрув живёт сутки: `sweepExpiredApprovals` гасит просроченный
в `expired` и убирает worktree. Чужие `from.id` (не в allowlist) бот игнорирует молча.
Демон - `fsh bot` (long-polling `getUpdates`, offset в `~/.local/state/fs-harness/tgbot.json`).

## Сообщения в Mattermost (mattermost.js + commands/mm.js)

Сообщение в рабочий чат уходит **от имени человека**, а не от бота: в канале должно быть видно,
кто отправил задачу в ревью.

- **Токен сессионный, и это не выбор, а следствие.** На `mm.fitstars.ru` Personal Access Tokens
  выключены админом инстанса, а бот писал бы от себя. `fsh mm login` меняет пароль на токен сессии
  (заголовок `Token` в ответе `/users/login`) и кладёт токен в keychain. Пароль не хранится нигде.
  Сессия умирает при разлогине — 401 говорит об этом прямо и зовёт перелогиниться.
- **Канал на сценарий, а не на команду**: `mattermost.channels.<сценарий>` в конфиге. Сценарий в
  v1 один — `review`. Агент канал не выбирает, он называет сценарий.
- **Канал задаётся четырьмя способами**: сценарий из конфига, id, `команда/имя-канала` и голое имя
  канала. Разбирает это `channelId()`: id (26 символов `[a-z0-9]`) уходит насквозь без запроса,
  имя спрашивается у Mattermost, голое — перебором своих команд. В URL Mattermost лежит имя, а не
  id, поэтому без этого канал пришлось бы искать в devtools. `fsh mm channels [строка]` печатает
  свои каналы с их id.
- Запись в общий чат идёт по тем же правилам, что все записи харнесса: `--dry-run` печатает канал
  и текст, без `-y` спрашивает подтверждение.
- **MCP-инструмента у `mm` намеренно нет.** Вызовы из MCP идут с `yes: true`, то есть сообщение
  в общий канал ушло бы мимо человека.
- `fsh task push --post` зовёт ту же `postReview`, что и `fsh mm review`. Без флага пуш молчит:
  запись в чат не должна быть побочным эффектом пуша.

## Чеклист перед коммитом

```bash
npm test                          # все тесты
node bin/fsh.js help        # справка актуальна
node bin/fsh.js mrs         # smoke на реальном API (read-only)
node bin/fsh.js mr <ветка> --json
```

Деплой и play-джоб реальным API тестируй только по явной просьбе человека — они меняют состояние GitLab.

## Правила правки кода

- Минимальный диф: сначала тест/воспроизведение, потом фикс.
- Спиннеры/таблицы — только в `ui.js`, иконки/строки — только в `format.js`. Не дублируй.
- `waitJob` принимает `intervalMs` опционально — в тестах можно ускорить.
- Ноль новых внешних программ — это жёсткое ограничение. npm-библиотеки при этом можно: `npm ci` ставит всё, что нужно.
