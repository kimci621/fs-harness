# AGENTS.md — FS-Harness для AI-агентов

Устройство того, что в репозитории есть сейчас. Спецификация проекта и план работ — в [PLAN.md](PLAN.md), правила работы — в [CLAUDE.md](CLAUDE.md). Ты поддерживаешь или расширяешь `fsh` — читай этот файл целиком перед правками.

## Что это

CLI над `glab api` для работы с MR и пайплайнами GitLab плюс запуск AI-агента на конфликтах с приёмкой результата судьёй. Стек: Node.js ESM, зависимости ставятся через `npm ci`, из внешних программ нужны только `node`, `git` (≥2.38, ради `merge-tree --write-tree`), `glab` и `claude`. Весь вывод данных — JSON через `glab api`, никакого парсинга человекочитаемого вывода glab. Дизайн-решение зафиксировано в `docs/SPEC.md`.

## Карта файлов

```
bin/fsh.js        точка входа: import + main()
src/main.js             разбор argv, dispatch, help, обработка ошибок
src/glab.js             ВСЕ вызовы glab api. exec инжектируется (тесты)
src/resolve.js          поиск MR: по номеру или части имени ветки (неточный)
src/pipeline.js         ensureMRPipeline, findJob, deployJobName, mapLimit
src/config.js           ~/.config/gl-helper/config.json
src/ui.js               спиннер, live-таблица, waitJob (опрос джоб)
src/format.js           иконки статусов, humanize, таблицы, строки MR
src/errors.js           CliError (сообщение без stack trace)
src/commands/*.js       по файлу на команду: mrs, mr, jobs, run, deploy, conflict, commit, doctor, agent-guide, mr-comments
src/secrets.js          ключи: env → keychain (security) → ошибка с командой заведения
src/agent/spawn.js      запуск агента процессом: стрим строк, abort, SIGTERM→SIGKILL
src/agent/events.js     поток событий с pull-семантикой (буфер + курсор на итератор)
src/agent/journal.js    раны в ~/.local/state/fs-harness/runs/<id>/
src/judge/index.js      judge(): рубрика + профиль → вердикт, фолбэк, ремонтный round-trip
src/judge/schema.js     zod-схема вердикта, VERDICT_SHAPE, extractJson
src/judge/payload.js    что показывать судье в роли acceptance
src/judge/providers/    cli (процесс claude) и openai (всё OpenAI-совместимое)
src/prompts/judge/*.md  рубрики по ролям — файл на роль
src/engine.js           runAction: фазы действия, события, изоляция, гейт судьи; runActionCLI, judgeRun
src/actions/*.js        декларации действий: precheck/context/verify/publish и блок action
src/prompts.js          шаблоны: loadTemplate/renderTemplate/listTemplates/checkTemplates
src/registry.js         ЕДИНЫЙ реестр команд: dispatch, help, agent-guide и MCP tools/list генерируются из него
src/mcp.js              MCP-сервер (stdio): обработка JSON-RPC, инструменты берёт из registry
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
| `listOpenMRs(repo)` | `GET /merge_requests?state=opened&per_page=100&order_by=updated_at&sort=desc` |
| `getMR(repo, iid)` | `GET /merge_requests/{iid}` |
| `getDiscussions(repo, iid)` | `GET /merge_requests/{iid}/discussions?per_page=100` |
| `listMRPipelines(repo)` | `GET /pipelines?source=merge_request_event&per_page=100` |
| `getPipeline(repo, pid)` | `GET /pipelines/{pid}` |
| `getJobs(repo, pid)` | `GET /pipelines/{pid}/jobs?per_page=100` |
| `getJob(repo, jid)` | `GET /jobs/{jid}` |
| `playJob(repo, jid)` | `POST /jobs/{jid}/play` |
| `retryJob(repo, jid)` | `POST /jobs/{jid}/retry` — retry создаёт НОВУЮ джобу (новый id) |
| `createMRPipeline(repo, iid)` | `POST /merge_requests/{iid}/pipelines` |

Каждый вызов идёт с `--hostname <host из конфига>` (иначе glab выберет хост по git remote cwd — источник загадочных 404) и ретраями GET до 5 раз (флапающий GitLab).

## Действия (kind: 'action')

Действие — это запуск агента с проверкой судьёй. Оно **не пишется как команда**: пишется декларация
в `src/actions/<имя>.js`, а CLI-команду и MCP-инструмент из неё синтезирует `fromAction()` в реестре.
Порядок фаз один на все действия и живёт в `runAction`:

```
resolve target → precheck → (skip?) → context → isolate → prompt
  → agent → verify → judge → publish → cleanup
```

Блок `action`:

| Поле | Что это |
|---|---|
| `target` | `'mr'` \| `'issue'` \| `'none'` — что резолвить из первого аргумента |
| `writes` | меняет ли внешнее состояние; при `true` обязательны `publish` и гейт судьи |
| `isolation` | `'checkout'` \| `'ephemeral-worktree'` \| `'task-worktree'` |
| `prompt` | имя шаблона в `src/prompts/` |
| `judge` | `{gate: 'pre-push'\|'advisory'\|'none', role}` |
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

**Новая роль:** файл рубрики в `src/prompts/judge/`, запись в `judge.roles` в `DEFAULTS` (`config.js`), сборщик payload рядом с `buildAcceptancePayload`. Схема вердикта общая на все роли — не плоди вторую.

**Новый провайдер:** файл в `src/judge/providers/`, ветка в `createProvider`. Контракт один: `{name, schemaStrength, model, complete({system, user, effort, signal, onDelta}) → {text, model, usage, cost, sessionId}}`. Ошибки — `CliError(..., 'judge_failed')`, чтобы сработал фолбэк.

**Тесты судьи не ходят в сеть**: `judge()` принимает `makeProvider`, `createOpenAIProvider` — `makeClient`. Живая модель дёргается только руками.

## Режим агента (важно)

- `GL_HELPER_JSON=1` — все команды отдают JSON; side-effect команды — финальный результат `{ok:true, ...}` в stdout, прогресс в stderr. Ошибки: `{ok:false,error:{code,message}}` в stdout, exit ≠ 0.
- `GL_HELPER_YES=1` — авто-подтверждение (аналог -y).
- `--dry-run` — план без side-effect'ов для run/deploy/conflict/commit.
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

`run`/`deploy`/`conflict`/`commit`: финальный `{ok: true, ...}` с фактическим результатом (джобы, хэши, web_url); `--dry-run` — `{ok, dry_run, plan...}` без запусков. У `conflict` дополнительно `conflict_files: string[]` и `has_conflicts` — посчитанные `git merge-tree`, а не взятые из GitLab, `run` (id рана) и `judge: {decision, confidence, summary, profile, cost}` либо `{skipped: true}` при `--no-judge`.

Ошибки: `{ok:false, error:{code, message}}`; коды перечислены в `agent-guide`.

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
