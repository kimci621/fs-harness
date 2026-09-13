# FS-Harness

Персональный харнесс разработчика: одна поверхность, с которой видно задачи и MR, и на которой
каждое действие это запуск агента с готовым контекстным промптом и проверкой результата судьёй.

Статус: план. Кода нет.

---

## Context

Работа размазана по трём несвязанным поверхностям. Jira живёт в браузере и доступна агенту только
через MCP Atlassian внутри claude-сессии. GitLab закрыт `gl-helper` (CLI + MCP), но он ничего не
помнит между вызовами: о новом треде в MR узнаёшь случайно, о конфликте с dev - когда придёшь
мерджить. Скиллы проекта (24 штуки в `.claude/skills/`) запускаются руками из чата, и контекст для
них каждый раз собираешь сам.

**Ядро харнесса это не дашборд.** Ядро - движок «действие → контекстный промпт → запуск агента →
механическая проверка → вердикт судьи → применение». Нажал «решить конфликт» - агент получил промпт,
где уже подставлены ветки, задача, список конфликтующих файлов и критерии приёмки, и ушёл работать в
изолированный worktree. Результат перед применением смотрит судья. Дашборд это поверхность, с
которой движок дёргают, и в v1 он текстовый.

---

## Решения (зафиксированы)

| Вопрос | Решение |
| --- | --- |
| База кода | Форк `gl-helper`, переезжает в `~/Projects/FS-Harness`, растим внутри него |
| Поверхность v1 | TUI в терминале; веб-дашборд отдельной фазой позже |
| Доступ к Jira | Прямой REST по API-токену, не MCP |
| Судья | Сменный провайдер, профиль на каждую роль отдельно |
| Власть судьи | Гейтит пишущие действия, советует на читающих |
| Изоляция | Решает само действие: читающие в чекауте, пишущие в одноразовом worktree |
| Промпты | Отдельные `.md`-файлы, редактируемые, трёхуровневое переопределение |
| Действия v1 | `conflict`, `threads`, `analyze`, `review` |
| Mattermost | Уведомления + отчёты + чтение каналов как контекст + бот-управление |
| Зависимости | npm-библиотеки берём охотно; **ноль новых внешних программ и сервисов** |
| `glab` | Остаётся навсегда, на прямой GitLab REST не уходим |
| TUI-фреймворк | `ink` + `htm` (JSX без шага сборки) |
| HTTP-судья | SDK `openai` на все OpenAI-совместимые бэкенды; схема - `zod` |

## Жёсткие ограничения

**Ноль новых внешних программ и сервисов.** Ограничение не про npm, а про то, что надо ставить и
настраивать **рядом** с проектом. `npm ci` и `fsh` - весь запуск; никаких «сначала поставь x, залогинься
в y, подними z». npm-библиотеки, наоборот, берём охотно: где есть готовое решение, оно тащится в
проект, а не переписывается руками.

Внешние программы, которые уже есть и остаются полом системы:

| Программа | Статус | Почему так |
| --- | --- | --- |
| `claude` | обязательна | Ей и делегируем работу, это сам смысл харнесса |
| `git` | обязательна | Универсальна, вопроса не стоит |
| `glab` | обязательна, **решение владельца - остаётся навсегда** | Уже стоит и залогинен, токен в keyring, ретраи написаны. Прямой REST через `@gitbeaker/rest` (23 пакета, 3.8 МБ) не заводим - см. п. 15 «чего не делаем» |
| `security` | обязательна | Встроена в macOS, ставить нечего |
| `pi` | опциональна | Второй агент. Отсутствие - не ошибка, `doctor` пишет «не найден», действия с `agent: 'pi'` просто недоступны |
| LM Studio | опциональна | Профиль судьи `local`. Не запущена - `doctor` предлагает переназначить роль на другой профиль, а не падает |

Единственное следствие для дизайна: **дефолтная конфигурация не должна требовать ничего
опционального.** Роли `model-pick` и `event-triage` по умолчанию идут на `local`, но если LM Studio
не отвечает - фолбэк на `opus-cli`, а не отказ.

**Библиотеки, которые берём** (замерено `npm i` в чистом каталоге):

| Пакет | Пакетов | Размер | Что закрывает |
| --- | --- | --- | --- |
| `ink` + `react` | 38 | 23 МБ | TUI: raw mode, resize, ширина юникода, ANSI-безопасная обрезка, скролл. См. § G |
| `openai` | 1 | 27 МБ | Все три HTTP-судьи разом (OpenRouter, DeepSeek, LM Studio): стрим, `response_format: json_schema`, ретраи, таймауты. См. § E |
| `zod` | 1 | 8 МБ | Схема вердикта, она же источник `json_schema` через `zodResponseFormat`. См. § E |
| `mustache` | 1 | 168 КБ | Рендер промптов. § C описывает ровно подмножество mustache - `{{var}}`, `{{#var}}`, `{{^var}}` |
| `gray-matter` | 10 | 1,1 МБ | Front-matter промптов |

Не берём: `@gitbeaker/rest` (23 пакета) - `glab` остаётся; `@anthropic-ai/sdk` (7 пакетов, 16 МБ) -
Claude покрыт адаптером `cli`, второй путь к той же модели не нужен; `ajv` - схема одна и наша, её
описывает `zod`.

**`FS-Harness` - дом форка.** Форк `gl-helper` физически переезжает сюда, репозиторий один. Отдельного
репозитория документации нет.

**Судья сменный.** Провайдер выбирается конфигом, и выбирается **на каждую роль отдельно** - см. § E.

---

## Что переиспользуется из gl-helper

Форк берётся не ради GitLab-обвязки, а потому что нужный паттерн там уже написан в одном экземпляре.

- **`src/registry.js`** - массив `COMMANDS`, из которого генерятся CLI-dispatch, help, agent-guide и
  MCP `tools/list` одновременно. `mcpTools(ctx)` отдаёт `{name, description, inputSchema, handler}` -
  JSON-API уже готов, TUI и будущий HTTP цепляются к нему без нового слоя.
- **`src/commands/conflict.js`** - эталон паттерна: worktree → спавн агента с промптом → верификация
  (`rev-list --count`, сверка `ls-remote` sha) → сам жмёт build → `finally` убирает worktree. Промпт
  (`buildPrompt`, строка 174) уже написан почти дословно как надо, включая «приоритет равный,
  ours/theirs вслепую запрещено». Его надо вынуть в файл, а не переписывать.
- **`src/glab.js`** - единственная точка выхода в GitLab, ретраи с backoff 1/2/4/8с, токена в коде
  нет (glab берёт из macOS keyring).
- **`src/resolve.js`** (MR по номеру или части ветки + Левенштейн), **`src/pipeline.js`**,
  **`src/ui.js`** (спиннер, live-таблица, `waitJob`, всё в stderr - stdout чистый под JSON),
  **`src/output.js`**, **`src/errors.js`** (`CliError` с кодами), **`src/mcp.js`** (свой JSON-RPC
  поверх stdio), **`src/format.js`** (`statusIcon`, `humanize`, `truncate`).
- Тесты: встроенный `node --test`, 7 файлов, 18 тестов, сеть не нужна. Тест-раннер остаётся
  встроенным и после того, как появятся зависимости - `vitest` сюда не едет.

**`mr_review.py` в fitstars-frontend - второй донор.** Готовые к переносу решения, не изобретать
заново: `DIFF_PATHSPECS` (что не показывать модели), `build_system_blocks` (кэш-точка на диффе,
роль-промпт вторым блоком), forced tool use как структурированный вывод, `rules_for_diff` (доменные
правила по путям), обвязка прокси.

**Имя бинаря `gl-helper` снято целиком (решение владельца, фаза 0).** Первоначально `bin` должен был
нести две записи, `fsh` и `gl-helper`, потому что на старое имя были завязаны симлинк
`~/.local/bin/gl-helper`, регистрация MCP в `~/.claude.json` (project-scope fitstars-frontend) и
permissions `mcp__gl-helper__*` в `settings.local.json` проекта. Все три удалены в фазе 0, вместе с
упоминаниями в правилах Claude Code и в памяти агентов fitstars-frontend. Держать вторую запись стало
не за что: в `bin` одна `fsh`, весь функционал растёт здесь.

---

## Проверенные факты

Не предположения, а замеры и чтение кода.

**Изоляция дешёвая.** `cp -Rc node_modules <worktree>/` на 683 МБ / 865 пакетов - **9.5 секунды и
ноль занятого диска** (APFS clonefile, свободное место не изменилось). Свежий worktree становится
рабочим сразу, без `npm ci` на минуты. Это снимает главное возражение против изоляции.

**Но копия node_modules не значит рабочие зависимости.** Если `package-lock.json` ветки разошёлся с
основным чекаутом, скопированные (или слинкованные) модули для этой ветки неверны. Сравнение
`git hash-object package-lock.json` даёт флаг `deps_available`, который уходит и в промпт (агент не
пытается запустить линт, которого нет), и в payload судьи (несделанная проверка не выдаётся за
сделанную).

**Конфликты детектируются локально и точно.** `git merge-tree --write-tree --name-only --no-messages
origin/<target> origin/<source>` отвечает «есть ли конфликт» и даёт список конфликтующих файлов, без
worktree. Проверено на синтетическом репо (git 2.50.1): конфликт → **exit 1**, чистый merge → exit 0.
Это полностью закрывает дефект `has_conflicts: unchecked` и даёт переменную `{{conflict_files}}` в
промпт; поле GitLab становится вторичной подсказкой.

**Ловушка парсинга: первая строка stdout - это OID результирующего дерева, а не имя файла.**
Реальный вывод конфликта выглядит так:

```
e9ad03c7f2ec5caf072f713507601901315fc115
f.txt
```

Парсер обязан отбросить первую строку, иначе хэш уедет в `{{conflict_files}}` и агент пойдёт искать
несуществующий файл.

**`glab api --input -` читает тело запроса из stdin.** Замерено на glab 1.112.0 против живого
`projects/fitstars%2Ffitstars-nuxt/merge_requests`:

| Команда | Элементов в ответе |
| --- | --- |
| `-F per_page=1` без `--input` | 1 |
| `--input -` (stdin `{}`) без `-F` | 20 (дефолт) |
| `--input -` + `-F per_page=1` | 1 |
| `?per_page=1` в URL | 1 |

Отсюда два вывода. Первый: `--input -` работает и это единственный правильный способ слать
многострочный markdown в тред. Требует правки `defaultRun` в `src/glab.js`: сейчас
`stdio: ['ignore','pipe','pipe']`, нужен проброс `input`.

Второй: **на GET `--field` и так уходит в query, независимо от `--input`** - то есть «`--input -`
переключает `--field` в query» не объясняет баг с резолвом треда. Настоящее объяснение другое, и оно
про метод, а не про stdin: на не-GET `--field` собирается в **JSON-тело**, а GitLab у
`PUT .../discussions/<id>` читает `resolved` только из query-строки. Тело молча игнорируется, exit 0.
Лечится URL'ом, а не `--input`.

**Формат стрима claude снят с живого запуска.** `claude -p --output-format stream-json
--include-partial-messages --verbose` даёт NDJSON: `system/init` (session_id, модель, доступные tools
и skills, cwd, permissionMode), `system/status`, `stream_event` с вложенным `event.type`
(`message_start`, `content_block_start|delta|stop`, `message_delta`, `message_stop`), `assistant`
(готовые блоки), `rate_limit_event`, финальный `result/success` с `result`, `is_error`,
`stop_reason`, `num_turns`, `usage`, `total_cost_usd`, `permission_denials`, `duration_ms`.

Три следствия: TUI показывает **цену и токены каждого запуска**; `permission_denials` даёт понятную
причину провала («не дали прав», а не «агент тупой»); `session_id` позволяет делать **retry через
`claude --resume <id>`** - замечания судьи дописываются в живую сессию, контекст и уже сделанная
работа сохраняются, а не выбрасываются.

**Флаги на месте.** `--effort` принимает `low|medium|high|xhigh|max`. `--agent <name>` подхватывает
агентов проекта из `.claude/agents/`. `--allowedTools` и `--permission-mode` ограничивают права на
действие. `--restricted` убирает Bash/Edit (режим судьи). `--bare` для судьи **не годится**: он
читает только `ANTHROPIC_API_KEY` и игнорирует OAuth и keychain.

**Node fetch (undici) имеет `headersTimeout` 300 секунд.** Единственный пункт в этом разделе, снятый
не замером, а из документации undici: он встроен в node и дефолт диспетчера наружу не читается.
Проверять придётся поведением на первом же долгом вызове судьи. Если цифра верна, судья на
максимальном effort по большому диффу упрётся в неё на нестриминговом запросе; стриминг снимает
(заголовки приходят сразу, `bodyTimeout` сбрасывается на каждом чанке). Побочный выигрыш - видно,
что судья думает, а не висит. Стриминг стоит того в любом случае, так что решение от этой цифры
не зависит.

**`.worktrees` нет в `.gitignore` fitstars-frontend.** Сейчас `conflict` во время работы засоряет
`git status` основного репо, глобы eslint/prettier и watcher Nuxt. А `commit` в gl-helper делает
`git add -A`. С правилом «коммить только свой код» это мина. Worktree-рут уезжает из репозитория.

---

## Дефекты, чинятся по пути

1. **`src/commands/conflict.js:162`** - голый `return` в `finally` проглатывает летящее исключение.
   Падение `git fetch` или `worktree add` исчезает, команда возвращает `undefined`, MCP видит
   успешный `null`. Чинится структурно: уборка уезжает из действия в движок, ни одного `return` в
   `finally`, каждый git-вызов в своём `try`.
2. **`jobs` объявлен read-only**, но внутри `ensureMRPipeline` делает `POST .../pipelines`. Мутирует,
   пометить честно. *Закрыт:* описание команды и MCP-инструмента говорят про пересоздание пайплайна,
   из списка «только чтение» в README `jobs` убран.
3. **`has_conflicts`** читается из GitLab как есть; при статусе `unchecked` покажет «конфликтов нет».
   Закрывается `git merge-tree` (см. выше).
4. **Резолв треда** работает только query-параметром: `PUT .../discussions/<id>?resolved=true`.
   `--field resolved=true` уходит в JSON-тело, GitLab его игнорирует и возвращает exit 0 - молчаливый
   no-op. Закрывается сборкой URL, `--input` тут ни при чём.
5. **`commit` делает `git add -A`** (`src/prompts.js`, хвост `FOOTER`). Рабочее дерево общее, в нём
   бывает чужой in-progress код - это прямое нарушение правила «коммить только свои пути». Хвост
   уезжает в тело `commit.md` (фаза 2) и там же переписывается на явные пути.

---

## Архитектура

```
src/
  registry.js          # + поле kind, + fromAction(), + экспорт ACTIONS
  config.js            # + миграция на список проектов
  secrets.js           # НОВОЕ: ключи из env → keychain
  actions/             # НОВОЕ: декларации действий
    conflict.js  threads.js  analyze.js  review.js
  agent/               # НОВОЕ: движок
    run.js             # оркестратор фаз
    events.js          # поток событий: async iterable + .on()
    spawn.js           # асинхронный спавн агента
    adapters/{claude,pi}.js
    workspace.js       # изоляция: три режима, worktree, node_modules
    journal.js         # events.jsonl на диск
    render-cli.js      # подписчик для терминала
  judge/               # НОВОЕ
    index.js             # judge(role, payload) → вердикт, выбор профиля, ремонтный round-trip
    schema.js            # zod-схема вердикта, она же источник json_schema
    payload.js           # сборка payload по ролям, DIFF_PATHSPECS
    providers/{cli,openai}.js
  prompts.js           # расширяется: loadTemplate/renderTemplate/listTemplates
  prompts/             # каталог редактируемых промптов
  jira.js              # НОВОЕ: REST, токен из keychain
  tui/                 # НОВОЕ, ink
    app.jsx  store.js
    panes/{List,Detail,Logs,Verdict,Confirm}.jsx
```

### A. Модель действия

**Один реестр, два вида записей.** Разделять `COMMANDS` на два массива не надо: dispatch,
`buildUsage`, `buildAgentGuide` и `mcpTools` итерируются по нему, два массива удваивают каждого
потребителя. Достаточно поля `kind`:

- `kind: 'data'` - все нынешние команды: `mrs`, `mr`, `mr-comments`, `jobs`, `run`, `deploy`,
  `doctor`, `commit`, `agent-guide`, `config`, `mcp`, плюс новая `jira`. Существующие записи не
  меняются вообще. `commit` тут особый: он единственный из «данных», у кого есть свой промпт, и в
  фазе 2 он переезжает на общий движок шаблонов первым - на нём проверяется, что `loadTemplate` не
  сломал обратную совместимость с `.llm-commit-pattern`.
- `kind: 'action'` - четыре agent-действия, обязательный блок `action`.
- Производный экспорт `ACTIONS = COMMANDS.filter(c => c.kind === 'action')` - из него TUI строит
  кнопки, а будущий HTTP роуты.

```js
export const conflictAction = {
  name: 'conflict', kind: 'action',
  usage: 'conflict <mr|ветка>', description: '...', example: '...',
  action: {
    title: 'Решить конфликт с target',   // подпись кнопки в TUI
    target: 'mr',                        // 'mr' | 'issue' | 'none' - что резолвить из args[0]
    writes: true,
    isolation: 'ephemeral-worktree',     // 'checkout' | 'ephemeral-worktree' | 'task-worktree'
    prompt: 'actions/conflict',
    agent: { default: 'claude', allow: ['claude', 'pi'], pickByJudge: false },
    judge: { gate: 'pre-push', role: 'acceptance' },  // 'pre-push' | 'advisory' | 'none'
    inputSchema: { /* JSON Schema, одна на CLI, MCP, TUI-форму и HTTP-валидацию */ },
    async precheck(x) {},   // до изоляции → {skip, reason, result, facts, workspace, meta}
    dryRun(x) {},           // план без side-effect'ов
    renderPlan(plan, log) {},// как этот план печатать человеку
    async context(x) {},    // → плоский объект переменных промпта
    goal(x) {},             // одна фраза «что просили» — уходит судье
    async verify(x) {},     // после агента, до судьи → механические факты
    judgeExtra(x) {},       // необяз.: материал действия судье (тексты тредов и ответы)
    judgePayload(x) {},     // необяз.: собрать payload целиком (роль mr-review вместо acceptance)
    async publish(x) {},    // необяз. у читающих; ТОЛЬКО после approve: push + build + reply/resolve
    result(x) {},           // финальный объект для --json
  },
};
```

Хуки получают один объект `x` — контекст рана: `{ctx, opts, input, target, pre, run, ws, vars,
facts, verdict, published, say, emit, phase, signal}`. Печатать из хуков нельзя, только `say` -
вывод идёт событиями, и CLI, MCP и TUI рендерят один и тот же поток.

`run` и `mcp` **не пишутся руками** - их синтезирует `fromAction(spec)` в `registry.js`. Одна
запись → CLI-команда, MCP-инструмент, TUI-кнопка, HTTP-эндпоинт.

`test/registry.test.js` расширяется: для `kind:'action'` проверяются наличие `action.prompt`,
`isolation ∈ MODES`, `judge.gate ∈ GATES`, `typeof context === 'function'`, и что при `writes:true`
есть `publish` и `gate !== 'none'`.

### B. Движок запуска

```js
export function runAction(spec, ctx, input, opts) -> AgentRun
// AgentRun: { id, spec, [Symbol.asyncIterator](), on(fn), abort(), result: Promise }
```

**Async iterator первичен, `.on()` - шим.** Не голый EventEmitter: события, испущенные до подписки
(фазы `context`/`isolate` стартуют мгновенно), теряются, а TUI подписывается уже после старта.
`createEventStream()` - очередь с pull-семантикой (~40 строк; готового брать нечего, `events.on()`
из ядра теряет ровно те же ранние события): `push(ev)` кладёт
в буфер, итератор отдаёт накопленное, `on(fn)` - широковещательная подписка для потребителей без
backpressure (MCP-notify). Итератор даёт естественный backpressure для TUI и 1:1 ложится на SSE.

Единая схема события, одна и та же в TUI, MCP, SSE и журнале:

```
{t:'phase',   run, phase:'context|isolate|prompt|agent|verify|judge|publish|cleanup', status, detail}
{t:'log',     run, stream:'stdout|stderr', text}
{t:'agent',   run, kind:'text|tool|result', text, tool, tokens}
{t:'tick',    run, label, status}          ← сюда мапится onTick из waitJob
{t:'verdict', run, verdict}
{t:'done',    run, ok, result}
{t:'error',   run, code, message}
```

Порядок фаз:

```
resolve target → precheck → (skip?) → context → render prompt → acquire workspace
  → spawnAgent (стрим) → verify → [judge, если writes] → publish → cleanup(keep)
```

`spawn.js` использует `spawn()` (не `spawnSync`), `readline` на stdout, каждая строка через
`adapter.parseLine()`. Адаптер claude добавляет `--output-format stream-json
--include-partial-messages --verbose`; адаптер pi - `--mode json`; не-JSON строка уходит как `log`.
`AbortSignal` → SIGTERM, через 5 секунд SIGKILL: это `x` в TUI и таймаут в MCP. `stdio:'inherit'`
больше нигде.

**`waitJob` не трогаем.** `publish` зовёт его как сегодня с `quiet: true, onTick: text =>
emit({t:'tick'})` - этот шов уже есть в `ui.js:105`. CLI-рендерер воспроизводит нынешний вывод, так
что визуально ничего не меняется, но источник один.

Отрендеренный промпт кладётся в `<runDir>/prompt.md` - судья и человек видят ровно то, что видел
агент. Журнал: `~/.local/state/fs-harness/runs/<runId>/{meta.json, events.jsonl, prompt.md,
agent.jsonl, verdict.json, diff.patch}`. Это аудит, восстановление TUI после перезапуска и будущий
SSE-replay.

`meta.json` не для красоты: без него `--judge-only <runId>` не на чем работать. В нём имя действия,
проект, цель (MR или задача), **путь к сохранённому worktree**, `base` и `head` sha, `session_id`
агента, профиль судьи. `--judge-only` и retry через `--resume` читают именно его.

### C. Промпты как артефакты

**Что есть сейчас:** `src/prompts.js` - одна константа из `src/prompts/commit.md`,
`findPatternFile()` идёт вверх до каталога с `.git` и ищет `.llm-commit-pattern`, `commitPrompt()`
возвращает `{source, prompt}` и приклеивает хардкоженный `FOOTER`. Плейсхолдеров, front-matter и
переменных нет.

**Расширяем, не заменяем.** `commitPrompt` остаётся с той же сигнатурой (тесты зелёные), но поверх
нового ядра:

```js
export function loadTemplate(name, {projectDir}) -> {source, meta, body}
export function renderTemplate(name, vars, {projectDir}) -> {source, text, used, missing}
export function listTemplates({projectDir}) -> [{name, source, overridden}]
```

**Порядок переопределения** (первое попадание, обобщение идеи `.llm-commit-pattern`):

1. `<projectDir>/.fs-harness/prompts/<имя>.md` - проектный, коммитится вместе с кодом, о котором говорит
2. `~/.config/fs-harness/prompts/<имя>.md` - личный, поверх всех проектов
3. встроенный `src/prompts/<имя>.md`

Формат - markdown с необязательным front-matter, разбирается `gray-matter`:

```md
---
id: conflict
vars: [repo, mr_iid, mr_title, mr_url, source_branch, target_branch, conflict_files, deps_available]
judge: acceptance
---
Ты решаешь конфликт в MR !{{mr_iid}} «{{mr_title}}» ({{mr_url}}), {{source_branch}} → {{target_branch}}.
{{#conflict_files}}Конфликтующие файлы (посчитано локально через git merge-tree):
{{conflict_files}}{{/conflict_files}}
{{^deps_available}}node_modules недоступны: lock-файл ветки разошёлся с основным чекаутом.
Линт и типы НЕ прогоняй, напиши об этом в итоге.{{/deps_available}}
```

Плейсхолдеры: `{{var}}`, блоки `{{#var}}...{{/var}}` и `{{^var}}...{{/var}}`. Это ровно синтаксис
`mustache`, поэтому рендерит он, а не наш код. Никаких выражений и циклов - списки формирует
`context()`.

Две вещи `mustache` делает не так, как нам надо, и обе закрываются один раз при инициализации:

- **`{{var}}` экранирует HTML.** В промптах живут код, markdown и дифф - экранирование их испортит
  (`&` станет `&amp;`, кавычки уедут в `&quot;`). Ставим `Mustache.escape = (t) => t` глобально и
  пишем двойные скобки везде, а не разводим `{{{...}}}` по шаблонам.
- **Пропущенная переменная рендерится в пустоту молча.** Строгость - наш слой поверх: перед рендером
  сверяем `vars` из front-matter с пришедшим объектом, отсутствующая → `CliError(...,
  'prompt_var_missing')` с именем; `Mustache.parse()` даёт список тегов шаблона, объявленная в
  `vars`, но не использованная → предупреждение в `doctor`.

**Команды для правки** (это и есть ответ на «список промптов, чтобы их можно было менять»):

- `prompts list` - имя → активный источник, видно что переопределено
- `prompts show <name> [--for !2547]` - сырой или отрендеренный на реальных данных
- `prompts edit <name>` - копирует встроенный в путь оверрайда и открывает `$EDITOR`
- `prompts check` - валидирует все шаблоны против `vars` их действий, гоняется в `npm test`

В TUI источник промпта виден в шапке запуска, чтобы не гадать, какая версия поехала.

#### Каталог: действия

| Файл | Переменные | Суть |
| --- | --- | --- |
| `actions/conflict.md` | `mr_iid` `mr_title` `mr_url` `source_branch` `target_branch` `repo` `conflict_files` `deps_available` `worktree` | Перенос существующего `buildPrompt` с двумя правками: **коммить, но не пушить** (push делает движок после судьи) и список конфликтующих файлов подставлен заранее. Критерии приёмки: рабочий код в обеих ветках, приоритет равный, `ours`/`theirs` вслепую и force-push запрещены. Линт и тесты - только если `deps_available`. |
| `actions/threads.md` | `mr_*` `threads` (автор, файл, строка, текст) `deps_available` `worktree` | Разобрать нерешённые треды: по каждому решить, правка это или ответ. Правки внести и закоммитить, по каждому треду сформировать текст ответа. **Отправку ответа и резолв делает движок**, агент только готовит текст - иначе агент резолвит то, что не починил. |
| `actions/analyze.md` | `issue_key` `issue_summary` `issue_description` `issue_comments` `project_dir` | Брейншторм задачи: что делать, где в коде (искать через `graphify query` именем сущности, не прозой), что сломается, какие вопросы к постановщику. Читающее, правок не вносить. |
| `actions/review.md` | `mr_*` `diff` `rules` | Ревью диффа по правилам проекта. Проектный оверрайд указывает на уже существующий `.claude/skills/mr-review/SKILL.md` - рубрика буквально та же, что у CI-бота, правится в одном месте. |

#### Каталог: судья

| Файл | Вход | Effort | Суть |
| --- | --- | --- | --- |
| `judge/acceptance.md` | цель действия, `facts` из `verify` (`commits_ahead`, изменённые файлы, коды выхода lint/typecheck с хвостами вывода, `deps_available`), `git diff base..HEAD` с `DIFF_PATHSPECS`, финальный текст агента; для `threads` - тексты тредов и подготовленные ответы | максимальный | Гейт перед push. Сделано ли то, что просили; не сломано ли соседнее; нет ли слепого выбора стороны; нет ли правок вне заявленного объёма. |
| `judge/mr-review.md` | `mr_context` + дифф + `rules_for_diff` - сборка как в `mr_review.py` | максимальный | Действие `review`, advisory. |
| `judge/model-pick.md` | тип задачи, заголовок, затронутые пути, оценка объёма | низкий + кэш по хэшу payload | Каким агентом и моделью гнать. Заменяет regex-угадайку в `router-judge.sh`. |
| `judge/event-triage.md` | батч `[{source, kind, title, url, age}]` | низкий, батчем | Срочно / к сведению / шум. Фильтр перед отправкой в Mattermost. |

#### Позже (каталог под них готов)

`actions/jira-create.md`, `actions/tester-description.md`, `actions/dict-csv.md` (формат задан в
`.claude/rules/dict.md`: три колонки, разделитель `, `, файл вложением в задачу, не в репозиторий),
`actions/branch-from-issue.md`.

### D. Изоляция

```js
export async function acquireWorkspace({mode, project, ref, baseRef, key, onEvent})
  -> {dir, branch, base, created, deps, cleanup(keep)}
```

- **`checkout`** - `dir = project.dir`, git-операций нет. Движок снимает `git rev-parse HEAD` +
  `git status --porcelain` до и после и падает с `dirty_checkout`, если читающее действие что-то
  изменило. Эта страховка и позволяет пускать `analyze`/`review` в живой чекаут без страха.
- **`ephemeral-worktree`** - `git fetch origin <ref>:refs/remotes/origin/<ref> <baseRef>:...` →
  `worktree add --detach <root>/<project>/<action>-<key>-<ts> origin/<ref>` → `checkout -b
  fs-harness/<action>-<key>-<ts>`. `cleanup(false)` = `worktree remove --force` + `prune` +
  `branch -D`; `cleanup(true)` оставляет и печатает путь.
- **`task-worktree`** - заглушка v1: тот же код, ключ = ключ задачи Jira, `cleanup` никогда не
  удаляет. Ни к одному действию не подключён, но `MODES` его знает, чтобы потом не переписывать
  сигнатуру.

**Worktree-рут вне репозитория:** `~/.local/state/fs-harness/worktrees/<project>/...` вместо
`$projectDir/.worktrees/`. Тот же том, `git worktree` и клоны работают.

**node_modules:** по умолчанию `cp -Rc` (APFS clonefile, замерено 9.5 с и 0 байт, полная изоляция -
общий `.cache` не мешает параллельным ранам). Независимо от способа считается `deps_available`
сравнением `git hash-object package-lock.json` worktree и основного чекаута: разошлось →
`deps_available: false`, флаг уходит в промпт и в payload судьи. Альтернативы в конфиге:
`deps.strategy: 'link'` (симлинк, быстрее, но общий кэш) и `'install'` (`npm ci --prefer-offline`).
`.nuxt` не переносим - он генерируемый и ветко-зависимый.

### E. Судья

Судья сменный: один интерфейс, два адаптера, профиль выбирается **на каждую роль отдельно**.

```js
// src/judge/providers/index.js
export function createProvider(profile) -> {
  name,
  schemaStrength,                // 'tool' | 'json_schema' | 'json_object' | 'prompt'
  async complete({system, user, schema, effort, signal, onDelta}) -> {json, raw, usage, cost}
}
```

**Два адаптера, и второй почти целиком чужой.** OpenRouter, DeepSeek и локальная LM Studio говорят на
одном и том же OpenAI-совместимом `/chat/completions`, поэтому это **один** адаптер с разным
`baseUrl` - и внутри у него SDK `openai`, а не наш HTTP-код. Отдельно стоит только claude CLI: это
процесс, а не HTTP. Нативный Anthropic Messages из v1 убран - Claude уже покрыт адаптером `cli`,
второй путь к той же модели не окупает ни зависимости, ни ключа.

| Адаптер | Кого покрывает | Схема | Стриминг | Ключ |
| --- | --- | --- | --- | --- |
| `cli` | `claude --model opus --effort xhigh --restricted -p` | `prompt` - выпрашиваем JSON и парсим | наш существующий парсер `stream-json` из `agent/adapters/claude.js`, второй не пишем | не нужен, идёт по подписке |
| `openai` | OpenRouter, DeepSeek, LM Studio, любой совместимый | `json_schema` со `strict:true` через `zodResponseFormat(Verdict, 'verdict')`; профиль может понизить до `json_object` или `prompt` | `client.chat.completions.stream()`, дельты приходят событиями SDK | из keychain по имени в `secret`; локальной не нужен |

Что уходит вместе с SDK: SSE-парсер (`data:`-кадры, сентинел `[DONE]`, склейка дельт), ретраи,
таймауты, разбор ошибок API и генерация JSON Schema из нашей формы вердикта. Это ~150 строк
собственного кода, которые не надо писать и не надо чинить.

`effort` мапится адаптером: CLI → `--effort`, openai → `reasoning_effort` (кто не понимает -
игнорирует). Вызывающий код про это не знает.

**Профиль на роль - в этом весь смысл сменности.** Четыре роли судьи отличаются по цене на порядки:

| Роль | Частота | Профиль по умолчанию | Почему |
| --- | --- | --- | --- |
| `acceptance` | на каждое пишущее действие | `opus-cli` | Гейт перед push, ошибка дороже вызова |
| `mr-review` | по кнопке | `opus-cli` | Тот же уровень, что у CI-бота |
| `model-pick` | перед каждым запуском | `local`, фолбэк `opus-cli` | Дешёвая классификация, локальной модели хватает; LM Studio уже крутится под `router-judge.sh`. Не отвечает - роль уезжает на `opus-cli`, а не падает |
| `event-triage` | батчем на каждый опрос watcher'а | `local`, фолбэк `opus-cli` | Фильтр шума, гонять на opus абсурдно; фолбэк тот же |

**Схема вердикта одна на все роли** (роли различаются payload и рубрикой). Живёт в `judge/schema.js`
как `zod`-объект и оттуда же уходит в `response_format` через `zodResponseFormat` - описание формы
одно, а не два расходящихся:

```json
{"decision":"approve|reject|revise|abstain","confidence":0.0,
 "summary":"1-3 предложения",
 "findings":[{"severity":"blocker|warning|nit","file":"","line":0,"body":""}],
 "checks":[{"name":"","pass":true,"note":""}],
 "next":{"action":"push|retry_agent|hand_to_human|none","hint":""},
 "meta":{"role":"","provider":"","model":"","effort":"","tokens":{},"cost":0}}
```

**Схема гарантируется не везде, поэтому валидация одна на всех.** `json_schema` со `strict:true`
даёт гарантию только там, где бэкенд её поддерживает; адаптер `cli` не даёт вообще. Поэтому вход в
`judge()` всегда проходит `Verdict.safeParse()` независимо от того, что обещал профиль. Порядок:
адаптер выжимает максимум из своего бэкенда → `safeParse` → при провале **один** ремонтный
round-trip (в сообщение уходит `error.issues` - готовый список «что не так», ещё одна причина брать
`zod`, а не рукописный валидатор) → при втором провале `CliError(..., 'judge_schema')`. На пишущем
действии невалидный вердикт трактуется как **не approve**: гейт закрыт, push не происходит. Тихо
пропускать нельзя.

**Стриминг обязателен на HTTP-адаптере**, и это не стилистика: у undici `headersTimeout` 300 секунд,
судья на максимальном effort по большому диффу упирается в него на нестриминговом запросе. Отсюда
`client.chat.completions.stream()`, а не `.create()`. Побочный выигрыш - `onDelta` → `{t:'log'}`, в
TUI видно, что судья думает, а не висит.

**Секреты.** `src/secrets.js`, единая лесенка: env → `security find-generic-password -s fs-harness -a <имя> -w`
→ внятная ошибка с готовой командой заведения. Имена: `openrouter`, `deepseek`, `jira`,
`mattermost`. Существующие env-имена (`DEEPSEEK_API_KEY` и прочие из `router-judge.sh`) принимаются
как алиасы, чтобы не заводить второй ключ под то, что уже настроено. `doctor` проверяет наличие
ключей для тех профилей, которые реально назначены ролям, и молчит про остальные.

**Payload по ролям:**

| Роль | Что подаётся |
| --- | --- |
| `acceptance` | цель действия из промпта, `facts` из `verify` (`commits_ahead`, изменённые файлы, коды выхода lint/typecheck с хвостами вывода, `deps_available`), `git diff base..HEAD` с `DIFF_PATHSPECS` из `mr_review.py`, финальный текст агента; для `threads` - тексты тредов и подготовленные ответы |
| `mr-review` | `mr_context` + дифф + `rules_for_diff` - сборка как в `mr_review.py`, рубрика из `.claude/skills/mr-review/SKILL.md` |
| `model-pick` | тип задачи, заголовок, затронутые пути, оценка объёма; результат кэшируется по хэшу payload |
| `event-triage` | батч `[{source, kind, title, url, age}]` |

Кэш префикса (первый system-блок - данные, второй - рубрика, как в `build_system_blocks`) держит
адаптер `openai` там, где бэкенд умеет; на `cli` кэширование делает сам claude. Окупается в
`threads`, где судья зовётся по одному диффу несколько раз.

**Как гейт останавливает push.** Push перестаёт быть работой агента - это главное архитектурное
следствие. В `conflict.md` вместо «запушь» стоит «закоммить и не пушь». Дальше:

```js
const facts = await spec.action.verify(runCtx);
if (spec.action.writes && spec.action.judge.gate === 'pre-push') {
  const verdict = await judge({role: spec.action.judge.role, payload, cfg});
  emit({t:'verdict', verdict});
  if (verdict.decision !== 'approve') { keep = true; throw new CliError(fmt(verdict), 1, 'judge_rejected'); }
}
await spec.action.publish(runCtx);   // единственное место, где происходит push
```

Плохой вердикт → worktree сохраняется, путь и `verdict.json` в сообщении, в origin ничего не ушло.
Уходит целый класс ошибок `not_pushed` и проверка `ls-remote sha === HEAD`.

**Retry на `revise`** - через `claude --resume <session_id>` с `verdict.findings` новым сообщением:
агент доделывает в том же контексте, а не начинает заново. Работает только на CLI-агентах (у `pi`
свой `--session-id`); лимит повторов в конфиге, по умолчанию 1.

**Escape hatches:** `--no-judge` (в результат пишется `judge:{skipped:true}`), `--judge <profile>`
(разовая подмена профиля), `--judge-only <runId>` - прогнать судью по сохранённому worktree. Последнее
и есть способ дёшево отлаживать рубрики и сравнивать провайдеров на одном и том же диффе.

### F. Jira

`src/jira.js` той же формы, что `glab.js` (инъекция `fetchImpl` ради тестов без сети):

```js
export function createJira({baseUrl, email, token, fetchImpl = fetch}) -> {
  myself(), searchJql({jql, fields, max, cursor}), issue(key), comments(key), transitions(key)
}
```

Аутентификация `Authorization: Basic base64(email:token)`. Ретраи и бэкофф копируются из `glab.js`,
плюс обработка `429` по `Retry-After`.

**Токен в keychain, не в файле.** `src/secrets.js`: `getSecret('jira')` = env → `security
find-generic-password -s fs-harness -a jira -w` → внятная ошибка с готовой командой заведения. Файл
с 0600 отпадает: он уедет в бэкапы и всплывёт на скриншоте, а `glab` уже живёт в keyring - форма
единая.

Эндпоинты v1 (чтение плюс единственная запись - переход по статусу):

- `GET /rest/api/3/myself` - проверка авторизации и `accountId`
- `POST /rest/api/3/search/jql` с `jql: "assignee = currentUser() ORDER BY updated DESC"`, пагинация
  курсором. **Проверить одной curl-командой первым шагом:** если инстанс отвечает 404/410 - ветка
  фолбэка на `GET /rest/api/3/search?jql=`; обе ветки в одном методе, выбранная запоминается.
- `GET /rest/api/2/issue/{key}?expand=renderedFields` - **именно v2**: `description` приходит
  текстом, а не ADF-деревом, и не нужен флаттенер ADF→text ради контекста для LLM.
- `GET /rest/api/2/issue/{key}/comment?maxResults=50` - комментарии как контекст брифа
- `GET /rest/api/2/issue/{key}/transitions` и `POST` того же адреса - смена статуса
  (`fsh jira move <KEY> <статус>`): совпадение по имени перехода или целевого статуса,
  подтверждение, read-back новым чтением задачи.

В реестре одна data-запись `jira` с подкомандами (`jira mine`, `jira FD-7647`, `jira move`).
Фильтры списка складываются в JQL флагами `--assignee`, `--sprint`, `--component`, `--status`,
`--jql` (последний перебивает остальные); имя checkbox-поля - `jira.componentField` в конфиге. Ключ детектится
`/^[A-Z]+-\d+$/` - это `target: 'issue'`.

*Изменено по решению владельца 2026-09-13:* записей в Jira стало четыре, а не одна. Кроме перехода
по статусу TUI умеет перенос в спринт (`POST /rest/agile/1.0/sprint/{id}/issue`), комментарий
(`POST .../comment`) и правку полей (`PUT /rest/api/2/issue/{key}`) - Assignee, «Ответственный
разработчик», Priority и всё прочее, что отдаёт `GET .../editmeta`. Форма значения (объект, массив,
`{id}`, `{accountId}`) берётся из схемы editmeta, а не угадывается: пустое поле не подсказывает,
чего оно ждёт. Список значений - это `allowedValues` поля или люди проекта из
`/rest/api/2/user/assignable/search`; поле, которое нечем заполнить, в списке не показывается.
Исключение - списки строк (Labels): их Jira не перечисляет, поэтому там поле ввода через запятую,
предзаполненное текущим значением. На живой FD так правятся Assignee, «Ответственный разработчик»,
Priority, «Компонент», Fix versions, Flagged, Issue Type и Labels.

**Смена статуса не изобретается:** простой переход fsh делает сам одним POST, а знание об
обязательных полях workflow-валидатора (`customfield_10275`, `customfield_10242`, формат ADF)
не дублирует - оно живёт в скилле `jira-transitions` проекта. Переход, который валидатор
заворачивает, fsh не чинит: показывает ответ Jira со списком полей и оставляет работу скиллу.

### G. TUI

**`ink`.** 38 пакетов и 23 МБ - на этом и стоит сам Claude Code, так что связка проверена ровно на
том сценарии, который нам нужен: полноэкранное окно с бесконечно капающим стримом.

Что ink закрывает и что иначе пришлось бы писать руками: raw mode и разбор escape-последовательностей
клавиш, ресайз окна, ширина юникода (эмодзи и кириллица в статусах ломают выравнивание по `length`),
ANSI-безопасная обрезка строк, flexbox-раскладка колонок, диффовая перерисовка вместо перерисовки
кадра целиком. Это и было те «350-450 строк», которые на деле оказываются 800 с хвостом и половина
из них - `wcwidth` и парсер ANSI.

**`blessed` рассматривался и отклонён.** 1 пакет и 1,8 МБ против 38 и 23 МБ - соблазнительно, и он
не мёртв (последняя публикация 2024-10-22, а не 2015, как я сначала сказал). Но модель у него
императивная, своя, и под стрим с частичными сообщениями её надо разруливать руками; `ink` даёт
декларативный рендер и остановку на «положил новое состояние в стейт». Для инструмента, который
живёт на одной машине, 21 МБ разницы не значат ничего, а модель значит.

**JSX без шага сборки: `htm`** (1 пакет, 228 КБ), забинденный на `React.createElement`. Node 26
исполняет ESM напрямую, но JSX не понимает, а тащить esbuild/tsx и каталог `dist` ради двух экранов
в личном инструменте - хуже, чем шаблонные литералы. Файлы остаются `.js`, `bin/fsh.js` запускается
как есть:

```js
const html = htm.bind(React.createElement);
html`<${Box} flexDirection="column"><${Text} color="cyan">${title}<//><//>`;
```

Переиспользуется из существующего кода: `statusIcon`, `humanize`, `truncate` из `format.js`,
`JOB_TERMINAL` и `coloredStatus` из `ui.js`. `createSpinner` и `createLiveTable` в TUI не нужны - у
ink свой `<Spinner>` и своя раскладка; в CLI-режиме они остаются как есть.

Инвариант: TUI пишет в stdout, но **только если stdout это TTY**; остальной код продолжает писать
прогресс в stderr. `--json`, MCP или не-TTY → TUI не стартует (`tui_requires_tty`), никакого
«умного» определения режима.

```
┌ fs-harness · fitstars-nuxt · dev ────────────────── раны: 2 ─┐
│ [1] MR   [2] Задачи   [3] История                 ? помощь  │
│ a решить конфликт · t обработать тикеты · r локальное ревью  │
├──────────────────────────────┬───────────────────────────────┤
│▌fix: баннер   ✅ 💬3 of 7 ⚠ │ !2547 fix: баннер             │
│▌!2547 · создан 2 дн · Амир   │ fix/banner → dev              │
│ feat: промо       🔵 ✅Appr… │ пайплайн ✅ · конфликт ⚠      │
│ !2551 · создан 1 дн · Эмиль  │ p — пайплайн · f — фильтры    │
├──────────────────────────────┴───────────────────────────────┤
│ cnf-2547 ▸ agent: git merge origin/dev                       │
│ cnf-2547 ▸ agent: правлю app/components/Banner.vue           │
│ cnf-2547 ▸ судья: думает… 47с · $0.42                        │
└ q выход  x прервать  v вердикт  p промпт ────────────────────┘
```

Клавиши: `1/2/3/4` - вкладки; `Tab` - перенести фокус между блоками (список → детали → лог),
`↑↓`/`jk` и `PgUp/PgDn` двигают курсор в списке и прокручивают тот блок, который в фокусе;
`a/t/r/n` - запустить conflict/threads/review/analyze для выделенного; `s` - статус задачи,
`S` - спринт, `c` - комментарий, `e` - раскрыть длинные поля задачи; `p` - панель пайплайна MR,
`f` - фильтры списка MR; `x` - прервать ран (тот самый `AbortSignal`); `o` - открыть `web_url`;
`R` - перечитать список; `?` - помощь; `q` - выход (при активных ранах подтверждение).

Экран занимает окно целиком и пересчитывается на ресайз: высоты блоков считаются от `stdout.rows`,
а не зашиты константой. Прокрутка есть у каждого блока, потому что в любой из них контент не влезает:
в списке её ведёт курсор, в деталях и логе - смещение в стейте (у лога отсчёт от конца, ноль значит
«самое свежее»).

*Изменено по решению владельца 2026-09-13:* `p` отдан панели пайплайна (в списке джоб `enter`
запускает выбранную, `deploy_dev*` сам сперва прогоняет `build_image` и ждёт его) - открытие промпта
в `$EDITOR` делается из шелла и клавиши не стоит. Вкладка `[3]` называется «История», а не «Раны»:
слово «раны» читалось как «ранеры». `Tab` переносит фокус, а не вкладку: вкладки и так на `1/2/3`,
а прокручивать блоки иначе нечем. Фильтры списка MR переехали с `/` на `f` и живут панелью с теми же
полями, что у флагов CLI. Строка MR стала двухэтажной, как в самом GitLab: заголовок с бейджами
(пайплайн, Approved, треды, конфликт) и строка «!iid · создан · автор · метки». Карточка задачи
показывает описание, участников, Priority, Labels, Parent, Sprint, связи и «Technical details for
QA» с «Контентом» - длинные блоки свёрнуты и раскрываются по `e`. Не сделаны и пока не нужны:
`Enter` - детали (правая панель и так показывает выделенное), `Space` - свернуть лог, `v` - вердикт
целиком.

*Изменено по решению владельца 2026-09-13 (вторая правка):* появилась четвёртая вкладка `[4] Промпты`
- список всех шаблонов действий и судей с текстом выбранного, `e` делает личную копию в
`~/.config/fs-harness/prompts`, `d` возвращает встроенный. Это то же, что даёт `prompts list/show`,
но без выхода из TUI. В проектный каталог `.fs-harness/prompts` TUI не пишет: он лежит в чужом
репозитории. Строки и карточки рисуются сегментами, а не готовой строкой: ключ задачи, номер MR,
статус и метки получают цвет и жирность, между смысловыми группами стоит пустая строка - сплошной
текст в терминале не читается. Значения фильтров MR (автор, assignee, reviewer, ветка, метка,
статус пайплайна) больше не печатаются руками: `Enter` на поле открывает список того, что реально
встречается в загруженных MR, плюс «я» и «— любой». Свободный ввод остался только у «Поиска по
тексту» - там перечислять нечего. У каждого списка есть свой поиск на `/`: он индексирует всю
сущность целиком (номер, заголовок, автор, ветки, метки, статус) и терпит опечатки - `fuse.js`,
threshold 0.4. Курсор и счётчик в подвале ходят по найденному, запрос живёт на вкладке и виден
строкой над списком. Уже 100 колонок две панели рядом не читаются, поэтому на узком терминале
остаётся одна: `Tab` переключает список и карточку. Пустой список говорит, почему он пуст (нет MR,
не попали под фильтры, ничего не нашлось) и какой клавишей это чинить. Под каждой строкой списка
бледная линия, а колонка маркера курсора не сжимается: на обрезанных строках ink съедал её ширину
и ключи задач разъезжались.

Стрим агента: TUI просто ещё один потребитель `for await (const ev of run)`. События падают в ring
buffer (2000 строк на ран), и **в стейт ink он сливается по таймеру 100 мс**, а не на каждое
событие - иначе `--include-partial-messages` даст сотни `setState` в секунду. Ink сам не рисует
лишнего, но реконсиляция на каждую дельту токена всё равно бессмысленна. Закрытие TUI не убивает
раны: движок пишет `events.jsonl`, при следующем старте вкладка «Раны» дочитывает файлы.

### H. Мультипроектность

**Путь конфига не меняется: `~/.config/gl-helper/config.json`.** Там уже лежит рабочий файл с
`repo`, `host`, `projectDir` и `agentArgs`; переименование каталога вслед за именем пакета молча
осиротит его, и `doctor` начнёт ругаться на пустую конфигурацию на ровном месте. Читаем
`~/.config/fs-harness/config.json`, если он есть, иначе `~/.config/gl-helper/config.json` - в таком
порядке. Каталог промптов при этом сразу новый (`~/.config/fs-harness/prompts/`): его ещё не
существует, наследовать нечего.

```json
{ "version": 2,
  "activeProject": "fitstars-nuxt",
  "projects": {
    "fitstars-nuxt": {
      "repo": "fitstars/fitstars-nuxt", "host": "fitstars.gitlab.yandexcloud.net",
      "dir": "~/Projects/fitstars-frontend", "targetBranch": "dev", "buildJob": "build_image",
      "jira": {"baseUrl": "https://fitstars.atlassian.net", "projectKey": "FD"},
      "deps": {"strategy": "copy"}, "agent": "claude" } },
  "agentArgs": {"claude": [], "pi": []},
  "judge": {
    "enabled": true, "maxRevise": 1,
    "roles": {"acceptance": "opus-cli", "mr-review": "opus-cli",
              "model-pick": "local", "event-triage": "local"},
    "profiles": {
      "opus-cli":   {"provider": "cli", "agent": "claude", "model": "opus",
                     "effort": "xhigh", "schema": "prompt"},
      "openrouter": {"provider": "openai", "baseUrl": "https://openrouter.ai/api/v1",
                     "model": "", "secret": "openrouter", "schema": "json_schema"},
      "deepseek":   {"provider": "openai", "baseUrl": "https://api.deepseek.com/v1",
                     "model": "deepseek-chat", "secret": "deepseek", "schema": "json_object"},
      "local":      {"provider": "openai", "baseUrl": "http://127.0.0.1:1234/v1",
                     "model": "", "schema": "json_object", "fallback": "opus-cli"}
    }
  },
  "mattermost": {"url": "", "webhook": "", "channels": []},
  "worktreeRoot": "~/.local/state/fs-harness/worktrees" }
```

**Реализовано с двумя отличиями от примера выше** (фаза 5): формы `judge` и `workspace` оставлены
такими, какими они сложились в фазах 1-3 (`roles` — списки профилей-фолбэков, `workspace.root` и
`workspace.deps` вместо `worktreeRoot` и `deps`), потому что они уже работают и переписывать их ради
косметики значит ломать рабочий судейский слой. `judge.enabled` и `maxRevise` введены в фазе 6 вместе с retry на
`revise` (доделка в той же сессии агента, дефолт 1 повтор). Ленивый кэш `g` на проект отложен до TUI - сейчас
его некому звать.

**Миграция в памяти, а не на диске.** `loadConfig()` видит отсутствие `version` и верхнеуровневый
`repo` → мигрирует в памяти, имя проекта = `basename(dir)` либо второй сегмент `repo`. На диск
ничего не пишется, пока владелец не выполнит `config migrate` (печатает дифф, спрашивает). Старый
конфиг работает бесконечно; тест покрывает обе версии.

Выбор активного: `-P/--project <name>` > `FS_HARNESS_PROJECT` > `activeProject` > единственный
проект. `ctx.repo` остаётся алиасом `ctx.project.repo` - существующие команды не переписываются ни
строчкой. `withRepoHost` становится `withProject` с сохранением старого имени как алиаса. Объект
`g` создаётся на проект лениво и кэшируется, чтобы TUI мог держать на экране два проекта разом.

### I. Mattermost

Четыре роли раскладываются на две очень разные по цене реализации, поэтому едут порознь.

**Дёшево:** уведомления и отчёты - incoming webhook, обычный `fetch` POST, ~20 строк, подписчик того
же потока событий. Watcher шлёт то, что прошло `judge/event-triage`; движок по завершении долгого
запуска шлёт выжимку, цену и вердикт со ссылкой. Бот не нужен.

**Дорого:** управление из чата - бот-аккаунт, websocket на `/api/v4/websocket`, обработчик, мапящий
сообщение на запись реестра. По сути второй транспорт рядом с CLI, MCP и TUI, окупается когда
действий станет много. Чтение каналов как контекст (`GET /api/v4/channels/{id}/posts`) - отдельный
источник для `context()` действия `analyze`; полезно для брифов, но тянет чужую переписку в промпт,
поэтому включается флагом на действие, а не по умолчанию.

Токен бота в keychain рядом с Jira:
`security add-generic-password -s fs-harness -a mattermost -w <токен>`.

---

## Фазы

Каждая заканчивается чем-то проверяемым. Оценки грубые.

**Фаза 0. Переезд форка и швы без нового поведения (полдня).**

**Переезд каталога. Каталог `~/Projects/FS-Harness` уже существует** (в нём лежит этот файл) и
git-репозиторием не является, поэтому `mv ~/Projects/gl-helper ~/Projects/FS-Harness` сделал бы
вложенный `FS-Harness/gl-helper/`, а не переезд. Правильный порядок - три команды, и `rmdir` тут
работает страховкой: он падает, если в каталоге осталось что-то ещё.

```
mv ~/Projects/FS-Harness/PLAN.md ~/Projects/FS-Harness/KICKOFF.md ~/Projects/gl-helper/
rmdir ~/Projects/FS-Harness
mv ~/Projects/gl-helper ~/Projects/FS-Harness        # дерево чистое, ветка master
```

Делает это человек, а не агент: перенос каталога, в котором агент стоит, выдёргивает у него cwd.

**Remote.** `origin` к началу фазы уже переведён владельцем на свой репозиторий, переименовывать
нечего и `upstream` не заводится. Ветка `main` создаётся локально, пушей из фазы нет.

**Старый `gl-helper` сносится целиком, обратной совместимости нет.** Изначально фаза берегла старое
имя ради MCP-сервера fitstars-frontend; решением владельца MCP и все следы имени удалены, беречь
нечего. Порядок:

```
npm_config_prefix="$HOME/.local" npm rm -g gl-helper   # снять старый линк
# правка package.json
npm_config_prefix="$HOME/.local" npm link
command -v fsh && fsh doctor && fsh mrs --json | head -5
```

Последняя строка - критерий, а не формальность: не сошлась, фаза не закрыта.

**Префикс задаётся через `npm_config_prefix`, а не флагом `--prefix`.** Линк живёт в `~/.local`, а
`npm config get prefix` показывает nvm'овский `~/.nvm/versions/node/<v>`: в nvm-префиксе бинарь
привязан к версии ноды и исчезнет при её смене. Флаг `--prefix` в npm 7+ двигает ещё и localPrefix,
и `npm link` полезет искать пакет не в текущем каталоге; env-переменная двигает только глобальный.

`package.json`: `name` становится `fs-harness`, в `bin` одна запись `fsh`. `engines.node` поднимается
с `>=20` до `>=22`: фактически всё гоняется на v26.2.0, а `ink` и `openai` собираются под современный
рантайм - незачем обещать поддержку, которую никто не проверяет.

**Переименование внутри кода - только то, что видит человек** (help, usage, примеры, подсказки в
ошибках, `serverInfo.name` у MCP). Три вещи с состоянием остаются на старом имени намеренно:
`~/.config/gl-helper/config.json` до фазы 5, где миграция конфига и так пишется (см. § H), префикс
worktree `gl-helper/<iid>-<ts>` до фазы 3, где появляется `workspace.js`, и переменные `GL_HELPER_*`
заодно с конфигом.

**`.gitignore` заводится первым коммитом, до любого `npm i`:** в репозитории его нет вообще, а эта
же фаза приносит `node_modules` и `package-lock.json`.

**Шапки `README.md` и `AGENTS.md` правятся здесь же.** В обеих «ноль npm-зависимостей» - с этой фазы
неправда, и `AGENTS.md` читается агентом первым.

**Заводится `CLAUDE.md` репозитория** (сейчас есть только `AGENTS.md` про нынешний gl-helper):
ссылка на `PLAN.md` как на спецификацию, ограничение «ноль новых внешних программ», правила
коммитов, запрет `git add -A`. Смысл - чтобы промпт следующей фазы был однострочным.

Тут же появляется секция `dependencies` (её в `gl-helper` нет вообще) и `package-lock.json`.
Пакеты добавляются не разом, а фазой, в которой впервые нужны: `openai` + `zod` в фазе 1,
`mustache` + `gray-matter` в фазе 2, `ink` + `react` + `htm` в фазе 6. Каждая фаза заканчивается
проверкой `rm -rf node_modules && npm ci && npm test` - гарантия, что «склонировал и запустил»
не сломалось.

Дальше: извлечь `spawnAgent` (асинхронный, со стримом) и `createEventStream`, перевести на них
`conflict`, заменив `stdio:'inherit'` прокачкой в нынешний логгер. Починить `finally` плюс
регрессионный тест. Добавить `input` в `defaultRun` в `glab.js`. Заменить чтение `has_conflicts` на
`git merge-tree`.
*Готово, когда:* `command -v fsh` жив и `fsh doctor` проходит, `npm test` зелёный,
`rm -rf node_modules && npm ci && npm test` тоже, `conflict --dry-run` и реальный конфликт работают
как раньше, в выводе появился список конфликтующих файлов, а имени `gl-helper` не осталось ни в
PATH, ни в конфигах Claude Code.

**Фаза 1. Судья и гейт на `conflict` (1-2 дня).**
`src/judge/*` с провайдерами, рубрика `acceptance.md`, `zod`-схема вердикта с ремонтным round-trip,
секреты из keychain. **Адаптер `cli` пишется первым и один** - на нём проверяется гейт; `openai`
добавляется сразу после, но фаза закрывается и без него.
`conflict` разделяется на `verify`/`publish`, промпт перестаёт пушить.
*Польза сразу:* плохо смерженные конфликты больше не уезжают в origin.
*Готово, когда:* на живом конфликтном MR вердикт печатается и гейтит push; `--judge-only` работает
по сохранённому worktree; заведомо плохой прогон (взять одну сторону целиком) получает `reject`;
невалидный JSON от судьи не проходит как approve.

**Фаза 2. Реестр действий и движок (1-2 дня).**
`kind`, блок `action`, `runAction`, `fromAction`. `conflict` переезжает на декларацию - неизменность
поведения и есть тест. Промпты выносятся в файлы, появляются оверрайды и `prompts list/show/check`.
Здесь же чинится дефект 5: хвост `FOOTER` из `prompts.js` уезжает в тело `commit.md`, и `git add -A`
в нём заменяется на явные пути.
*Готово, когда:* поведение `conflict` идентично фазе 1, `tools/list` в MCP не изменился,
`prompts check` в `npm test`, `.llm-commit-pattern` по-прежнему перебивает встроенный `commit.md`,
и `commit` больше нигде не говорит `git add -A`.

**Фаза 3. Изоляция как сервис и `threads` (1-2 дня).**
`workspace.js` (три режима, рут вне репо, `cp -Rc`, `deps_available`). Две операции в `glab.js`:
`replyDiscussion` через `--input -` и `resolveDiscussion` через query-параметр, обе с read-back
проверкой. Действие `threads` целиком.
*Готово, когда:* на MR с 2-3 открытыми тредами правки внесены, ответы отправлены, треды
зарезолвлены, и всё это после approve; `git status` основного чекаута чист во время работы.

**Фаза 4. Читающие действия (1 день).**
`analyze` (нужен Jira-слой) и `review` (рубрика из `SKILL.md`, payload как в `mr_review.py`).
`jira mine` / `jira FD-XXXX` в реестре. Режим `checkout` с защитой от записи.
*Готово, когда:* `analyze FD-7647` и `review !2547` дают вывод в терминал и в `--json`.

**Фаза 5. Мультипроектность (1 день).**
Конфиг v2, миграция, `-P`.
*Готово, когда:* `-P <второй проект> mrs` работает, старый конфиг тоже.

**Фаза 6. TUI (1-2 дня).**
`ink` + `htm`, store, панели, подписка на события, три вкладки, bin `fsh`. Оценка упала с трёх-четырёх
дней, потому что raw mode, ресайз, ширина юникода и обрезка ANSI больше не наша работа.
*Готово, когда:* действие запускается из TUI, вывод агента и судьи стримится, `x` прерывает, цена
запуска видна.

**Фаза 7. Mattermost.** 7a - исходящие уведомления и отчёты. 7b - чтение каналов как контекст и
бот-команды. Только после обкатки остального.

*7a сделано:* `mattermost.webhook` в конфиге, `src/notify.js` (одна строка про завершённый ран:
действие, цель, вердикт, цена, ссылка), подписка внутри движка — уведомление уходит из CLI, MCP
и TUI одинаково. Провал POST не ломает ран. 7b (бот, websocket, чтение каналов) не начата.

**Фаза 8. Watcher.** Персистентные снапшоты, дифф против предыдущего, триаж судьёй. Уведомляет,
не запускает.

*Сделано:* `fsh watch` — один опрос по команде человека (демона и расписания нет, см. «чего в v1
не делаем», п. 6). Снимок = вывод `mrs` в `~/.local/state/fs-harness/watch/<repo>.json`, события
`pipeline` / `threads` / `conflict` / `mr_new` / `mr_gone`, триаж ролью `event-triage` раскладывает
их на срочно / к сведению / шум, важное уходит в Mattermost. Проверено живьём на fitstars-nuxt.

**Фаза 9. Web/SSE.** Тот же `runAction`, `for await` → `res.write('data: ...')`. Не раньше, чем TUI
прожит месяц.

---

## Чего в v1 не делаем

1. Веб-дашборд, HTTP-сервер, SSE, аутентификация. Только заложенные швы.
2. Долгоживущий worktree на задачу (`task-worktree`) - только константа в `MODES`.
3. Автопостинг ревью в GitLab: `review` печатает находки, не комментирует MR. Комментирует CI-бот,
   дублирование хуже молчания.
4. Комментарии и worklog в Jira - слой read-only. *Изменено по решению владельца 2026-09-11 и
   2026-09-13:* записей в Jira теперь три и других не будет - статус (`fsh jira move`, `s` в TUI),
   спринт (`fsh jira sprint`, `S` в TUI) и комментарий (`fsh jira comment`, `c` в TUI). Worklog,
   правка описания и полей задачи по-прежнему не наши. Переходы с обязательными полями
   workflow-валидатора (в FD это «В ревью») командой не закрываются: Jira возвращает список
   недостающих полей, их по-прежнему заполняет скилл `jira-transitions`. Кастомные поля ищутся по
   названию через `expand=names`, а не по `customfield_*`: id у каждого проекта свои.
5. Параллельный запуск нескольких действий на одном worktree. Один ран - один worktree, очередь на проект.
6. Автозапуск действий по событиям (watch-режим, launchd, cron). Всё запускает человек или чат-команда.
7. Docker и удалённое исполнение агентов.
8. Свой планировщик, канбан, оценки, метрики продуктивности.
9. RAG и векторный индекс по репозиторию - контекст собирают `context()`-билдеры и скиллы проекта.
10. Обучение на вердиктах, сбор датасета качества.
11. Мышь, темы, конфигурируемые раскладки в TUI. Клавиши захардкожены.
12. Поддержку GitHub, хотя `gh` установлен.
13. Ансамбли судей и второй проход `fresh-eyes` в `acceptance` (только в `mr-review`, где он уже есть).
    Сменность провайдера - это выбор одного из, а не голосование нескольких.
14. Автоматический `npm ci` в worktree - расхождение lock-файла честно понижает объём проверок.
    (Стратегия `deps.strategy: 'install'` из § D существует, но по умолчанию выключена: дефолт -
    `clone`, и сам fs-harness `npm ci` в worktree не запускает.)
15. Уход от `glab` к прямому GitLab REST. Формально `glab` - единственная программа, которую надо
    поставить и залогинить отдельно, и `@gitbeaker/rest` (23 пакета, 3,8 МБ) её заменил бы. **Решение
    владельца: `glab` остаётся, и не как временная мера.** Он уже стоит, авторизован, токен лежит в
    keyring без нашего участия, ретраи написаны и обкатаны. Следствие принимается осознанно: его
    квирк с `--field` (на не-GET уходит в JSON-тело, а GitLab у резолва треда читает только query) -
    наш навсегда, лечится кодом в `glab.js`, а не сменой транспорта. Второе следствие: на новой машине
    к `npm ci` добавляется `brew install glab && glab auth login`, и это записано в README.
16. Правку промптов внутри TUI. Правятся файлы в `$EDITOR`, TUI показывает источник.
17. Замену `router-judge.sh` и `answer-judge.py`. `judge/model-pick.md` пишется, но текущие хуки
    живут своей жизнью.
18. Перенос `mr_review.py` из CI. Локальная кнопка ссылается на ту же рубрику, CI не трогаем.
19. Синхронизацию с апстримом форка. Remote на него не заводится вообще, обратно не мерджим.
20. Нативный адаптер Anthropic Messages (`@anthropic-ai/sdk`, 7 пакетов, 16 МБ). Единственное, что он
    давал сверх остальных, - forced tool use как жёсткая гарантия схемы, но её же даёт `json_schema`
    со `strict:true` на OpenRouter, а Claude и так доступен через адаптер `cli` по подписке, без
    отдельного ключа. Появится, если понадобится звать Claude без CLI.
21. TypeScript и шаг сборки. Исходники остаются `.js` с ESM, JSX не используется (`htm`), `dist/`
    нет, `bin/*.js` запускается как есть. JSDoc-типы - пожалуйста, `tsc` в пайплайне - нет.

---

## Верификация

- `node --test` зелёный на каждой фазе. Новые модули (`renderTemplate`, парсер stream-json, миграция
  конфига, `acquireWorkspace`, реестр действий) получают тесты рядом с существующими семью.
- **`rm -rf node_modules && npm ci && npm test` в конце каждой фазы.** Это и есть исполняемая
  проверка главного ограничения: если запуск с нуля требует чего-то кроме `npm ci`, здесь и вылезет.
- `doctor` проходит полностью после каждой фазы; в него добавляются проверки ключей в keychain,
  доступности Jira и наличия `git merge-tree`. Отдельный блок - внешние программы: `claude`, `git`,
  `glab` (плюс `glab auth status`) как обязательные и падающие; `pi` и LM Studio как опциональные,
  про которые пишется «нет, вот что из-за этого недоступно», но код выхода не портится.
- Пишущие действия проверяются на реальном MR с реальным конфликтом, **с обязательной проверкой, что
  `git status` основного чекаута остался чистым во время работы**.
- Гейт судьи проверяется намеренно плохим прогоном, а не только хорошим.
- Расход считается: `total_cost_usd` каждого рана копится в `state.json` и показывается в TUI. Гейт
  на пишущем действии это один вызов opus на максимальном effort по полному диффу, и стоит видеть
  фактическую цену, а не надеяться.
