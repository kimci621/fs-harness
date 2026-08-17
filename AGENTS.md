# AGENTS.md — gl-helper для AI-агентов

Единственный входной файл репозитория. Ты поддерживаешь или расширяешь `gl-helper` — читай этот файл целиком перед правками.

## Что это

CLI-обёртка над `glab api` для работы с MR и пайплайнами GitLab. Стек: Node.js ESM, **ноль npm-зависимостей**, только системные `node`, `glab`, `git`. Весь вывод данных — JSON через `glab api`, никакого парсинга человекочитаемого вывода glab. Дизайн-решение зафиксировано в `docs/SPEC.md`.

## Карта файлов

```
bin/gl-helper.js        точка входа: import + main()
src/main.js             разбор argv, dispatch, help, обработка ошибок
src/glab.js             ВСЕ вызовы glab api. exec инжектируется (тесты)
src/resolve.js          поиск MR: по номеру или части имени ветки (неточный)
src/pipeline.js         ensureMRPipeline, findJob, deployJobName, mapLimit
src/config.js           ~/.config/gl-helper/config.json
src/ui.js               спиннер, live-таблица, waitJob (опрос джоб)
src/format.js           иконки статусов, humanize, таблицы, строки MR
src/errors.js           CliError (сообщение без stack trace)
src/commands/*.js       по файлу на команду: mrs, mr, jobs, run, deploy, conflict, commit, doctor, agent-guide, mr-comments
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

Промпты лежат отдельно от кода в `src/prompts/` (`.md`-файлы) — их можно править без правки логики. Для `commit` действует оверрайд проектом: если в корне git-репозитория есть файл `.llm-commit-pattern`, его содержимое заменяет встроенный промпт (см. `src/prompts.js`).

## Режим агента (важно)

- `GL_HELPER_JSON=1` — все команды отдают JSON; side-effect команды — финальный результат `{ok:true, ...}` в stdout, прогресс в stderr. Ошибки: `{ok:false,error:{code,message}}` в stdout, exit ≠ 0.
- `GL_HELPER_YES=1` — авто-подтверждение (аналог -y).
- `--dry-run` — план без side-effect'ов для run/deploy/conflict/commit.
- `gl-helper agent-guide` — самодостаточная инструкция, которую агент запускает первой.
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

`run`/`deploy`/`conflict`/`commit`: финальный `{ok: true, ...}` с фактическим результатом (джобы, хэши, web_url); `--dry-run` — `{ok, dry_run, plan...}` без запусков.

Ошибки: `{ok:false, error:{code, message}}`; коды перечислены в `agent-guide`.

## Чеклист перед коммитом

```bash
npm test                          # все тесты
node bin/gl-helper.js help        # справка актуальна
node bin/gl-helper.js mrs         # smoke на реальном API (read-only)
node bin/gl-helper.js mr <ветка> --json
```

Деплой и play-джоб реальным API тестируй только по явной просьбе человека — они меняют состояние GitLab.

## Правила правки кода

- Минимальный диф: сначала тест/воспроизведение, потом фикс.
- Спиннеры/таблицы — только в `ui.js`, иконки/строки — только в `format.js`. Не дублируй.
- `waitJob` принимает `intervalMs` опционально — в тестах можно ускорить.
- Не добавляй npm-зависимости без острой нужды — это осознанное требование (работает где угодно без install).
