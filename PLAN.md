# FS-Harness

Персональный харнесс разработчика: одна поверхность, с которой видно задачи и MR, и на которой
каждое действие это запуск агента с готовым контекстным промптом и проверкой результата судьёй.

Статус: фазы 0-15, 17 и 19 сделаны. Активная работа - фаза 18 дорожной карты v2, по
ней есть пошаговая инструкция `PLAN-FAZA-18.md` (см. таблицу ниже). Фаза 16 отложена до
решения владельца.

## Состояние фаз

| Фаза | Статус | План-инструкция |
| --- | --- | --- |
| 0-10. Ядро v1 | сделано | - |
| 11. Фоновый демон watcher | сделано | - |
| 12. Авто-исправление пайплайнов (ci-fix) | сделано | - |
| 13. Доигрывание рана и Telegram-бот | сделано | - |
| 14. Оркестратор жизненного цикла задачи | сделано | [PLAN-FAZA-14.md](PLAN-FAZA-14.md) |
| 15. Очередь задач и параллельность | сделано | [PLAN-FAZA-15.md](PLAN-FAZA-15.md) |
| 16. Серверный headless-режим | отложена: ждёт решения владельца про авторизацию `claude` в контейнере | [PLAN-FAZA-16.md](PLAN-FAZA-16.md) |
| 17. Вложения Jira и мастер по fsh | сделано | - |
| 18. Бэкенд в контуре задачи | не начата | [PLAN-FAZA-18.md](PLAN-FAZA-18.md) |
| 19. Сообщения в рабочие чаты (Mattermost) | сделано | - |

Словарь статусов: **сделано** - закрыта и проверена; **не начата** - план готов, работа не
начиналась; **в процессе** - идёт работа, в заголовке фазы перечислено, что осталось;
**отложена** - заблокирована внешним решением, не планируется до разблокировки. Порядок
выполнения: 15 сделана, дальше 18 (16 отложена).

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
| Telegram | Исходящие уведомления + отчёты (сделано); бот-управление и интерактивные аппрувы (v2) |
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
| `fuse.js` | 1 | 1,2 МБ | Поиск `/` по спискам TUI: терпит опечатки, threshold 0,4. См. § G |
| `ink-spinner`, `ink-text-input` | 2 | — | Спиннер и поле ввода ink: писать свои поверх raw mode незачем |
| `ink-testing-library` (dev) | 1 | — | Рендер ink-компонентов в `node --test` без терминала |

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

**Обязательные поля перехода не видны заранее: замерено 2026-09-16 на FD-7770.**
`GET /rest/api/3/issue/FD-7770/transitions?expand=transitions.fields` показывает у перехода
«В ревью» **ноль обязательных полей**, хотя на деле его заворачивает workflow-валидатор, требующий
`customfield_10275` («Контент») и `customfield_10242` («Technical details for QA»). Причина в том,
что `expand=transitions.fields` описывает **экран** перехода, а валидатор живёт в workflow и ни в
одном GET не отражается. Следствие: проверить выполнимость перехода заранее нельзя в принципе -
можно только выполнить POST и разобрать 400 со списком. Любая логика вокруг статусов строится на
«попробуй и прочитай ошибку», а не на «спроси и реши».

**Вебхуков не будет: замерено 2026-09-16.** В GitLab у владельца `access_level: 30` (Developer),
а `GET projects/fitstars%2Ffitstars-nuxt/hooks` отвечает **403** - Project Hooks заводит Maintainer
(40). В Jira `GET /rest/api/3/webhook` отвечает **403 «Only Connect and OAuth 2.0 apps can use this
operation»**: регистрация вебхука по API-токену через Basic невозможна независимо от прав, а
`mypermissions?permissions=ADMINISTER` даёт `false`, то есть и путь через UI закрыт. Следствие для
дизайна: **входящих событий у харнесса нет и не будет, всё строится на опросе** (фаза 11).

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
6. **Буфер `execFileSync` в `makeGit`** - дефолтный мегабайт. Дифф ветки после мержа target больше,
   и ран падал с `spawnSync git ENOBUFS` на фазе verify, то есть уже после работы агента: `diff.patch`
   не сохранён, пересудить сохранённый ран нечем. *Закрыт 2026-09-14:* `maxBuffer` 64 МБ в `makeGit`
   и в `merge-tree`, `commit` переведён на общий `makeGit` вместо своей копии. Поймано живьём на
   `conflict 2775`.

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

Это набросок фазы 0: что появляется сверх `gl-helper`. Дерево с тех пор выросло (`growthbook.js`,
`dict.js`, `watch.js`, `checks.js`, `agents.js`, `commands/task.js`, `commands/flow.js`,
`commands/init.js`, а панели TUI живут в одном `app.js`, а не в `panes/`). **Актуальную карту файлов
держит [AGENTS.md](AGENTS.md)**, и дублировать её здесь незачем: этот раздел про замысел, а не про
опись.

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
    agent: { default: 'cc', pickByJudge: false },   // имя профиля из agents в конфиге
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

**Судье уходит дифф решения, а не мержа** (*добавлено 2026-09-14*). `git diff base..HEAD` на
мерж-коммите - это все коммиты target (живой случай: 188 коммитов, 13354 строки; судью обрезало,
и конфликтующий файл в дифф не попал вовсе). `git merge-tree --write-tree` по тем же двум родителям
даёт дерево механического слияния, а `git diff <дерево> HEAD` - ровно то, что сделал агент
(тот же случай: 83 строки, оба файла на месте). Заголовок блока в payload едет вместе с диффом.

**Промпт уходит агенту в stdin, а не аргументом** (*добавлено 2026-09-14*). `claude -p` без текста
читает задание со входа. Аргументом нельзя: `ARG_MAX` на macOS - мегабайт на весь вызов, а дифф в
задании судьи бывает в сотни килобайт. То же в `commit` (`spawnSync` с `input`) и в судье `cli`.

**`waitJob` не трогаем.** `publish` зовёт его как сегодня с `quiet: true, onTick: text =>
emit({t:'tick'})` - этот шов уже есть в `ui.js:105`. CLI-рендерер воспроизводит нынешний вывод, так
что визуально ничего не меняется, но источник один.

Отрендеренный промпт кладётся в `<runDir>/prompt.md` - судья и человек видят ровно то, что видел
агент. Журнал: `~/.local/state/fs-harness/runs/<runId>/{meta.json, events.jsonl, prompt.md,
agent.jsonl, verdict.json, diff.patch}`. Это аудит, восстановление TUI после перезапуска и будущий
SSE-replay.

*Добавлено 2026-09-16:* архив не бесконечный - `pruneRuns` в `agent/journal.js` держит последние
**50 ранов** и сносит старые при создании нового. Следствие, которое надо знать: `--judge-only` по
рану, с которого прошло 50 запусков, уже не сработает, а сохранённый после плохого вердикта worktree
переживёт свой `meta.json` и станет сиротой - уборщик появляется в фазе 15.

`meta.json` не для красоты: без него `--judge-only <runId>` не на чем работать. В нём имя действия,
проект, цель (MR или задача), **путь к сохранённому worktree**, ветка, `base` и `base_sha`, профиль
агента и роль с профилем судьи. `--judge-only` читает именно его.

*Сверка с кодом 2026-09-16: двух полей в `meta.json` нет, и оба нужны дорожной карте.* `session_id`
агента живёт только в памяти рана (`x.sessionId`, `engine.js`), поэтому retry через `--resume`
работает внутри запуска и не переживает его конца - кнопка «Revise» из фазы 13 начнёт заново.
Стоимость работы агента не сохраняется вовсе: `parseClaudeLine` отдаёт `envelope` с
`total_cost_usd`, движок его выбрасывает, и в уведомление идёт только цена судьи. Оба поля
дописываются в `meta.json` первым шагом фазы 14 - без них бюджет и доигрывание рана не на чем
строить.

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
| `judge/event-triage.md` | батч `[{source, kind, title, url, age}]` | низкий, батчем | Срочно / к сведению / шум. Фильтр перед отправкой в Telegram. |

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

*Изменено по решению владельца 2026-09-14:* у режима `checkout` появилось исключение. Команды
`task start` и `task push` работают в живом чекауте `~/Projects/fitstars-frontend` и git в нём
меняют. Иначе сценарий не собирается: ветка задачи нужна человеку и агенту прямо в том дереве, где
они работают, а не в одноразовом worktree, который через минуту удалят. Инвариант сузился с «в
чужом проекте ничего не пишем» до закрытого списка операций, каждая из которых не теряет работу:

- `fetch origin <ветка>`, `switch <ветка>`, `switch -c <ветка> origin/<база>`, `push -u origin <своя
  ветка>`. Всё. Ни `commit`, ни `merge`, ни `rebase`, ни `reset`, ни `push --force`, ни удаления
  веток.
- Переключение с незакоммиченными правками отбивается (`dirty_checkout`) - они уехали бы в чужую
  ветку.
- Защищённые имена (`dev`, `master`, `main`, `rel/*`, `release/*`, целевая ветка проекта) не
  создаются работой и не принимают push задачи.
- Пишущие **действия** (`conflict`, `threads`) исключения не получают: они как были в одноразовом
  worktree, так и остаются.

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

**Профиль на роль - в этом весь смысл сменности.** Пять ролей судьи отличаются по цене на порядки
(`task-acceptance` добавилась в фазе 10, см. §J):

| Роль | Частота | Профиль по умолчанию | Почему |
| --- | --- | --- | --- |
| `acceptance` | на каждое пишущее действие | `opus-cli` | Гейт перед push, ошибка дороже вызова |
| `task-acceptance` | по кнопке, на задаче | `opus-cli` | Приёмка работы против текста задачи (§J). Советует, не гейтит: работу гейтит человек |
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
→ файл, если ключ уже лежит файлом (§K) → `.env` бэкенда, если он уже лежит там (§L)
→ внятная ошибка с готовой командой заведения. Имена: `openrouter`, `deepseek`, `jira`,
`telegram`. Существующие env-имена (`DEEPSEEK_API_KEY` и прочие из `router-judge.sh`) принимаются
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

*Изменено по решению владельца 2026-09-14:* пятая запись - `fsh jira field <KEY> "<имя поля>"`.
Тот же PUT и та же схема из editmeta, что в TUI, но из CLI: агенту нужно положить в задачу
результат скилла проекта, а это многострочный текст, который в TUI руками не наберёшь. Значение
берётся из хвоста аргументов либо из `--file <путь|->` (`-` = stdin). Имя поля человеческое
(«Technical details for QA»), id считается из editmeta - `customfield_*` у каждого проекта свой.
Неизвестное имя отвечает списком правимых полей этой задачи, чужой вариант pick-поля - списком
допустимых. После записи задача перечитывается: пустое поле после успешного PUT - ошибка, а не
успех (Jira молча принимает запись в поле, которого нет на экране).

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
│ [1] MR   [2] Задачи   [3] Процессы                ? помощь  │
│ a решить конфликт · t разобрать треды · r локальное ревью    │
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
строкой над списком. Фильтры свои у каждой вкладки: у задач это Assignee (по умолчанию «я», как
было), Статус, Спринт, Компонент и свой JQL - те же поля, что у флагов CLI, они складываются тем же
`buildJql`. Варианты берутся из самой Jira (люди проекта, статусы проекта, спринты доски,
`allowedValues` поля-компонента) и кешируются до перезапуска. Абзацы описания и комментариев в
карточке переносятся по словам, а не обрезаются: поля-строки по-прежнему обрезает ink.

*Изменено по решению владельца 2026-09-14:* у вкладки задач есть второй вид - доска на `v`, возврат
той же клавишей. Колонки берутся из конфигурации доски Jira (`/rest/agile/1.0/board/{id}/configuration`),
а не собираются из статусов проекта: в FD статусов пятнадцать, а колонок десять, и человек видит
именно колонки. Пустые колонки скрыты - иначе на «моих» задачах девять из десяти пустые. Курсор
двумя осями: `h/l` по колонкам, `j/k` по карточкам, `H/L` переносит карточку в соседнюю колонку тем
же переходом статуса, что и `s` (переход ищется по id целевого статуса колонки; если такого перехода
нет, пишем это в лог и ничего не делаем). Доска занимает всю ширину, карточка задачи открывается
по `Tab`, как в узком терминале. Колонки разделены бледной вертикальной линией во всю высоту
доски и отбиты пробелом с обеих сторон: впритык карточки соседних колонок читаются как одна. Мышь по-прежнему не делаем (см. «чего в v1 не делаем», п. 11). Уже 100 колонок две панели рядом не читаются, поэтому на узком терминале
остаётся одна: `Tab` переключает список и карточку. Пустой список говорит, почему он пуст (нет MR,
не попали под фильтры, ничего не нашлось) и какой клавишей это чинить. Под каждой строкой списка
бледная линия, а колонка маркера курсора не сжимается: на обрезанных строках ink съедал её ширину
и ключи задач разъезжались.

*Изменено по решению владельца 2026-09-14 (третья правка):* `E` работает и на вкладке MR: правятся
заголовок, описание, assignee, ревьюеры, метки, target branch, squash и удаление ветки после мержа.
Схему «что тут можно править» GitLab не отдаёт (в отличие от `editmeta` у Jira), поэтому список
полей наш, текущее значение читается из самого MR и видно прямо в списке. Ревьюеров GitLab принимает
только числовыми id, поэтому логины резолвятся через участников проекта, а незнакомый логин - ошибка,
а не молчаливая потеря. Описание MR, как и описание задачи, правится в `$EDITOR`.

*Изменено по решению владельца 2026-09-14 (вторая правка):* задача в списке - не строка, а карточка:
первой строкой ключ, статус и исполнитель (`нету`, если никого), дальше название до трёх строк с
переносом по словам и `…` на обрыве, последней строкой все метки и родитель приглушённо (`↑ FD-0`).
Высота строк стала разной, поэтому окно списка набирается от курсора по накопленной высоте, а не
делением высоты панели. `p` на задаче открывает родителя окном: его статус, исполнитель и все
подзадачи (`parent = KEY`) - окно только читают, `Esc` закрывает. `←`/`→` двигают обе панели вбок
на восемь знаков: обрезанные справа хвосты иначе не прочитать, а перенос в списке и в полях-строках
ломает высоту строки. Сдвиг сбрасывается при переходе на другую строку и на другую вкладку.

*Изменено 2026-09-16 (сверка с кодом):* вкладок стало шесть, а не четыре, и третья называется иначе.
Реальный список - `TABS` в `src/tui/store.js`: `[1] MR`, `[2] Задачи`, `[3] Процессы` (активные раны
плюс архив запусков, до 50 - см. §B), `[4] Промпты`, `[5] Флаги` (GrowthBook, §K: `c` создать,
`t` вкл/выкл в окружении, `D` удалить, `R` перечитать), `[6] Словарь` (§L: `c`, `E`, `D`, `n/p`
страница, `R`). Схема экрана выше нарисована на фазе 6 и трёх вкладок; раскладка панелей с тех пор
не менялась, состав вкладок - да. Слово «Раны» не прижилось дважды: сперва стало «Историей», потом
«Процессами», потому что вкладка показывает и то, что идёт прямо сейчас.

Стрим агента: TUI просто ещё один потребитель `for await (const ev of run)`. События падают в ring
buffer (2000 строк на ран), и **в стейт ink он сливается по таймеру 100 мс**, а не на каждое
событие - иначе `--include-partial-messages` даст сотни `setState` в секунду. Ink сам не рисует
лишнего, но реконсиляция на каждую дельту токена всё равно бессмысленна. Закрытие TUI не убивает
раны: движок пишет `events.jsonl`, при следующем старте вкладка «Процессы» дочитывает файлы.

*Изменено по решению владельца 2026-09-16:* вкладка `[3]` называется «Процессы» (ранее «История»):
показывает активные процессы (в работе прямо сейчас с иконкой `⏳`, текущей фазой и расходом) первыми,
за ними - архивные раны (максимум 50 штук). Все архивы ранов на диске (`~/.local/state/fs-harness/runs`)
строго ограничены лимитом 50 штук (`MAX_ARCHIVES = 50`), старые каталоги ранов автоматически вычищаются
через `pruneRuns` при создании каждого нового рана.

### H. Мультипроектность

**Путь конфига не меняется: `~/.config/gl-helper/config.json`.** Там уже лежит рабочий файл с
`repo`, `host`, `projectDir` и `agentArgs`; переименование каталога вслед за именем пакета молча
осиротит его, и `doctor` начнёт ругаться на пустую конфигурацию на ровном месте. Читаем
`~/.config/fs-harness/config.json`, если он есть, иначе `~/.config/gl-helper/config.json` - в таком
порядке. Каталог промптов при этом сразу новый (`~/.config/fs-harness/prompts/`): его ещё не
существует, наследовать нечего.

Форма ниже - не эскиз, а то, что лежит в `DEFAULTS` (`src/config.js`); сокращены только профили
агентов (полный список - ниже в этом же разделе).

```json
{ "version": 2,
  "activeProject": "fitstars-nuxt",
  "projects": {
    "fitstars-nuxt": {
      "repo": "fitstars/fitstars-nuxt", "host": "fitstars.gitlab.yandexcloud.net",
      "dir": "~/Projects/fitstars-frontend", "targetBranch": "dev", "buildJob": "build_image",
      "branchPattern": "feature/{key}", "checks": [], "agent": "cc",
      "jira": {"baseUrl": "https://fitstars.atlassian.net", "projectKey": "FD",
               "email": "", "componentField": "Компонент"},
      "growthbook": {"baseUrl": "", "project": "", "env": "production"},
      "dict": {"baseUrl": ""} } },
  "agentArgs": {"claude": ["--dangerously-skip-permissions"], "pi": []},
  "agents": { "cc": {}, "ccq": {}, "cco": {}, "ccd": {}, "pi": {} },
  "workspace": { "root": "~/.local/state/fs-harness/worktrees",
                 "deps": {"strategy": "clone"} },
  "telegram": {"chat_id": "", "bot_token": ""},
  "judge": {
    "enabled": true, "maxRevise": 1,
    "profiles": {
      "opus-cli":  {"provider": "cli", "bin": "claude", "model": "opus", "effort": "xhigh"},
      "haiku-cli": {"provider": "cli", "bin": "claude", "model": "haiku", "effort": "medium"}
    },
    "roles": {"acceptance": ["opus-cli"], "task-acceptance": ["opus-cli"],
              "mr-review": ["opus-cli"],
              "model-pick": ["haiku-cli", "opus-cli"], "event-triage": ["haiku-cli", "opus-cli"]}
  } }
```

Три отличия от того, как это задумывалось в фазе 5, зафиксированы намеренно. **Роль - это список
профилей, а не один профиль:** фолбэк («не ответил - следующий») живёт в самой роли, а не полем
`fallback` внутри профиля. **`workspace.root` и `workspace.deps`** вместо `worktreeRoot` и
`deps` на проекте: изоляция настраивается в одном месте, а не в двух. **Профили `openrouter` и
`deepseek` из дефолтов убраны** - они заводятся вручную там, где нужны, а `schema` у профиля нет:
адаптер выжимает максимум сам (§E). `judge.enabled` и `maxRevise` пришли в фазе 6 вместе с retry на
`revise`. Ленивый кэш `g` на проект отложен до TUI - сейчас его некому звать.

**Проверки проекта** (*добавлено 2026-09-14*). `projects.<имя>.checks` — команды, которые fsh
прогоняет в worktree после агента, чтобы положить в факты коды выхода (§E обещал их с самого
начала, но снимать их было нечем: судья упирался в это блокером и закрывал гейт). Пустой список
или отсутствие `node_modules` — в фактах строка с причиной, и это не блокер.

**Профили агента** (*добавлено 2026-09-14*). `agent` в проекте - не имя программы, а имя профиля из
`agents` в конфиге. Профиль - это программа плюс провайдер в env:

```json
"agents": {
  "cc":  {"bin": "claude", "args": ["--dangerously-skip-permissions"]},
  "ccq": {"bin": "claude", "args": ["--dangerously-skip-permissions"], "keyFile": "~/.alibaba_key",
          "env": {"ANTHROPIC_BASE_URL": "…/apps/anthropic", "ANTHROPIC_MODEL": "qwen3.8-max"}},
  "pi":  {"bin": "pi", "family": "pi"}
}
```

Зачем: у владельца те же провайдеры живут в `~/.zshrc` алиасом `cc` и функциями `ccq`/`cco`/`ccd`,
а `spawn` шелл не поднимает и их не видит. Дублировать их в конфиге - единственный способ, не трогая
глобальные настройки (ограничение «глобальные конфиги не трогаем»). Ключ читается из `keyFile` в
момент запуска и кладётся в `ANTHROPIC_AUTH_TOKEN`; в конфиге и в репозитории ключей нет.

Дефолты `cc`, `ccq`, `cco`, `ccd`, `pi` живут в `DEFAULTS.agents` и подмешиваются к пользовательским.
Имя `claude` оставлено алиасом `cc` - старые конфиги не переписываются. Выбор: `agents` в конфиге >
`projects.<имя>.agent` > `--agent <имя>` (и `--agent=<имя>`) > `action.agent.default`. Список
открытый: незнакомое имя даёт ошибку с перечислением того, что есть. Профиль судьи тоже умеет
`"agent": "ccd"` - судить можно другим провайдером, чем работать.

**Миграция в памяти, а не на диске.** `loadConfig()` видит отсутствие `version` и верхнеуровневый
`repo` → мигрирует в памяти, имя проекта = `basename(dir)` либо второй сегмент `repo`. На диск
ничего не пишется, пока владелец не выполнит `config migrate` (печатает дифф, спрашивает). Старый
конфиг работает бесконечно; тест покрывает обе версии.

Выбор активного: `-P/--project <name>` > `FS_HARNESS_PROJECT` > `activeProject` > единственный
проект. `ctx.repo` остаётся алиасом `ctx.project.repo` - существующие команды не переписываются ни
строчкой. `withRepoHost` становится `withProject` с сохранением старого имени как алиаса. Объект
`g` создаётся на проект лениво и кэшируется, чтобы TUI мог держать на экране два проекта разом.

### I. Уведомления (Telegram)

*Изменено по решению владельца 2026-09-16:* транспорт - Telegram Bot API, не Mattermost. Причина
бытовая: Telegram владелец читает с телефона, а Mattermost - нет, и половина смысла уведомления (не
сидеть у терминала) без этого пропадает. Форма разговора не изменилась: одна строка на событие,
провал отправки ран не ломает.

Две реализации разной цены, едут порознь.

**Дёшево (сделано, фаза 7a):** уведомления и отчёты - `POST /bot<токен>/sendMessage`, обычный
`fetch`, подписчик того же потока событий (`src/notify.js`). Watcher шлёт то, что прошло
`judge/event-triage`; движок по завершении долгого запуска шлёт выжимку, цену и вердикт со ссылкой.
Бот тут нужен только как отправитель: ни websocket, ни чтения апдейтов.

**Дорого (фаза 13):** управление из чата - тот же бот, но с `getUpdates` (long-polling) или входящим
вебхуком, хранением `offset`, `answerCallbackQuery` и inline-кнопками аппрува. По сути второй
транспорт рядом с CLI, MCP и TUI. Обязательное условие, а не украшение: **allowlist**
(`telegram.allowed_user_ids`, сверка `message.from.id` и `callback_query.from.id`) - иначе кнопка
«Approve & Push» есть у всех, кто знает бота. Подробности - фаза 13.

Чтение каналов как контекст для `analyze` отпало вместе с Mattermost: в Telegram переписки команды
нет, тянуть нечего.

Токен бота там же, где остальные ключи (env → keychain, см. §E):
`security add-generic-password -s fs-harness -a telegram -w <токен>`. `chat_id` - в конфиге, он не
секрет.

---

### J. Агентный режим в чужом проекте

Решение владельца 2026-09-14. Задача: в `~/Projects/fitstars-frontend` человек говорит агенту
«возьми FD-7719 в работу», и дальше вся механика вокруг задачи (Jira, ветка, MR, обязательные поля)
идёт через `fsh`, а не пересобирается агентом каждый раз заново.

**Транспорт - CLI, не MCP.** MCP-сервер остаётся, но агенту в чужом проекте он не нужен: `fsh` уже
в `PATH` через `npm link`, у Claude Code есть Bash, а вывод `--json` структурирован. MCP потребовал
бы правки `.mcp.json` чужого проекта и отдельного процесса на сессию.

**Сценарии живут в харнессе.** `src/prompts/flows/<имя>.md`, одна команда `flow` в реестре:
`fsh flow list` перечисляет, `fsh flow show <имя>` печатает протокол. Три штуки: `take-task`
(взять задачу в работу), `push-task` (запушить и открыть MR), `fill-jira` (заполнить обязательные
поля). Протокол - это markdown с шагами и точными командами `fsh`, а не код: шаги меняются чаще,
чем движок. Тест греплит из каждого протокола строки `fsh <команда>` и падает, если такой команды
в реестре нет.

*Изменено при реализации 2026-09-14:* задумывался `kind: 'flow'` - запись сценария среди команд
реестра, без `run`. Не стал: сценарий это документ, а не команда, и каждому потребителю `COMMANDS`
(dispatch, help, MCP, agent-guide) пришлось бы его отфильтровывать. Сценарии лежат в каталоге
промптов, где уже работает трёхуровневое переопределение (проектный - личный - встроенный):
проект может переписать протокол под себя, не трогая харнесс. Описание сценария - `description`
во front-matter, рядом с текстом, который оно описывает, а не в отдельном списке.

**Инициализация сессии - скилл, не хук.** `fsh init` пишет в проект `.claude/skills/fsh/SKILL.md`
(описание команд + список сценариев, генерируется из реестра) и печатает блок для `CLAUDE.md`
проекта. `fsh init --check` говорит, разошёлся ли записанный скилл с нынешним реестром; `doctor`
проверяет то же, но только если скилл уже стоит. SessionStart hook не берём: он жрёт контекст
каждой сессии, даже когда задача к Jira не относится.

Разрешение на запуск (`Bash(fsh:*)`) уходит в `.claude/settings.local.json` - личный файл,
исключённый из git проекта. Общий `settings.json` не трогаем: он уехал бы в чужой коммит. Блок для
`CLAUDE.md` печатается, а не вписывается: это файл человека, и порядок разделов в нём его.

*Поставлено в fitstars-frontend 2026-09-14:* скилл и разрешение записаны, а в `CLAUDE.md` вместо
напечатанного блока добавлена одна строка в уже существующую таблицу скиллов - у проекта своя
форма прогрессивного раскрытия, и отдельный раздел ей противоречил бы. Коммит - за владельцем.

**Триггеры важнее текста скилла.** Замечание владельца: первая редакция описывала возможности, а
не случаи, и свежая сессия по ней скилл бы не подхватила. `description` во front-matter - то
единственное, по чему сессия решает грузить скилл, поэтому в нём перечислены реплики человека
целиком («возьми FD-1234 в работу», «реши конфликты в MR», «включи фича-флаг»), а в теле скилла
первым разделом идёт таблица «человек говорит - команда». Тест проверяет, что ключ задачи, MR и
флаги из триггеров не исчезли.

**Механика - четыре команды.** `task start <KEY>` (см. §D), `task push [KEY] [--target <ветка>]`,
`jira field` (см. §F), `task judge [KEY]` - приёмка работы судьёй против текста задачи, роль
`task-acceptance`, совет, а не гейт. Решения агент принимает сам, механику делает `fsh`.

Судья приёмки читает дифф `origin/<целевая>...HEAD` (три точки: с точкой ветвления, иначе в дифф
попадёт чужая работа в целевой ветке) и текст задачи, фактами идут статус, число коммитов и
заполненность обязательных полей. Гейта нет: работу гейтит человек, а закрывать ему путь к `push`
из-за мнения модели - не наше дело.

**Обязательные поля Jira.** «Technical details for QA» заполняет скилл проекта `manual-qa`,
«Контент» - словарные строки (`add-dictionary-translations`) и фича-флаги GrowthBook. Знание о том,
*что* писать, живёт в скиллах проекта; `fsh` знает только *куда* и *как* писать. Протокол
`fill-jira` связывает одно с другим.

### K. GrowthBook

`src/growthbook.js` той же формы, что `jira.js`: инъекция `fetchImpl`, Bearer-ключ, ретраи.
`fsh growthbook list|get|create|toggle` - больше в v1 не нужно: правила раскатки, эксперименты и
метрики живут в вебе, туда мы не лезем. Это удалённый HTTP-сервис, а не программа: ограничение
«ноль новых внешних программ» про то, что надо ставить рядом с проектом, и GrowthBook его не
нарушает - как не нарушают Jira и GitLab.

*Проверено живьём 2026-09-14:* API стоит на **отдельном хосте** `https://growthbook-api.fitstars.ru`,
а не на адресе веб-интерфейса - `growthbook.fitstars.ru/api/v1/*` отдаёт 404 от Next.js. Адрес
лежит в `growthbook.baseUrl` проекта. `GET /api/v1/features` пагинируется (`limit` 100,
`hasMore`/`nextOffset`), окружения инстанса - `production`, `loadtest`, `dev`, флагов 55.
Переключение - `POST /api/v1/features/<id>/toggle` с `reason` для аудита, после него read-back:
GrowthBook отвечает 200 и на окружение, которого у флага нет.

*Отступление от §F по решению владельца 2026-09-14:* ключ GrowthBook лежит в `~/.growthbook_apikey`,
а не в keychain. Причина - им же пользуются другие инструменты владельца. `src/secrets.js` учится
читать файл как третий источник после env и keychain; для `jira` источник не меняется.

### L. Словарь бэкенда

*Добавлено 2026-09-16: раздел описывает уже написанный `src/dict.js`, которого в плане не было.*

Зачем: словарные строки - одна из двух вещей, которыми закрывается обязательное поле «Контент» в
задаче FD (вторая - фича-флаги, §K). Знание, *что* писать, живёт в скилле проекта
`add-dictionary-translations`; `fsh` знает, *куда* и *как*.

`src/dict.js` той же формы, что `growthbook.js` и `jira.js`: один `api()` с ретраями 1/2/4 с,
инъекция `fetchImpl` ради тестов без сети. Отличие одно - аутентификация заголовком `rest-token`,
а не `Bearer`. Эндпоинты - `GET|POST|PUT|DELETE /system/dictionary-item` (список постранично, один
элемент, CRUD) и `POST /system/dictionary/refresh` - сброс кэша бэкенда, без него правка не видна.

Адрес - `projects.<имя>.dict.baseUrl` (REST-корень бэкенда, например
`https://core.dev6.nwh.ru/rest/v4`). Токен - четвёртая ступень лесенки §E: `REST_TOKEN` из `.env`
самого бэкенда (`~/Projects/fitstars-api4/.env`), потому что он там уже есть, и заводить ему вторую
копию в keychain значит развести две правды.

**Поверхность - только TUI, вкладка «Словарь»** (`c` создать, `E` править, `D` удалить, `n/p`
страница, `R` перечитать). CLI-команды `dict` нет и в v1 не будет: правка словаря - ручная работа
глазами по списку, агенту она не нужна, а `fsh` без неё меньше.

### M. Бэкенд как источник правды (fitstars-api4)

*Решение владельца 2026-09-17.*

Проблема: фронтовую задачу агент закрывает по тексту задачи и по тому, что видит в Nuxt. Контракт
ручки он при этом додумывает, а тестовые данные сочиняет. Обе догадки вылезают позже - на ревью или
на стенде, когда поле называется иначе или его нет вовсе.

Рядом лежит настоящий бэкенд: `~/Projects/fitstars-api4`, Laravel 12 / PHP 8.2, тот же GitLab-хост,
репозиторий `fitstars/fitstars-api4`, целевая ветка `dev`. Он и есть правда - роуты, контроллеры,
ресурсы, модели, фабрики.

**Харнесс не переписывает знание о бэкенде в себя.** У api4 есть собственный `AGENTS.md`: таблица
префиксов и файлов роутов (`routes/api/`), карта `app/`, словарь доменных понятий, доступ к БД через
SSH-туннель и правила работы с данными. Дублировать это в промптах значит завести вторую правду,
которая протухнет первой. `fsh` делает три вещи: показывает агенту каталог бэкенда, обязывает
сходить туда прежде, чем называть контракт, и даёт судье увидеть, ходил ли он.

**Связь проектов - ссылка, а не копия.** В записи проекта появляется `backend` - имя другого проекта
из того же конфига (`"backend": "fitstars-api4"`). У бэкенда своя обычная запись в `projects` со
своими `repo`, `dir`, `targetBranch`, и ничего специального для него заводить не надо. В `DEFAULTS`
(`src/config.js`) и в примере §H поля пока нет намеренно - оно появляется в фазе 18.

**Контракт подтверждается ссылкой на файл, а не памятью.** Прежде чем назвать поля ответа, агент
находит роут в `routes/api/*.php` (регистрация префиксов - `app/Providers/RouteServiceProvider.php`),
из него контроллер, из контроллера Resource/Request, и называет `файл:строка`. Расхождение задачи с
кодом - повод сказать об этом, а не выбрать удобное. Scribe (`public/docs/openapi.yaml`,
`php artisan scribe:generate`) - генерация, а не источник: спека отстаёт от кода, код не отстаёт
никогда.

**Тестовые данные берутся фабриками, а не сочиняются.** В `database/factories/` лежат 119 фабрик, в
`database/seeders/` - 42 сида, в `database/seeders/fixtures/` - json с дефолтами (языки, страны,
платёжные сервисы, словарь). Данные «близкие к настоящим» - это вызов фабрики поверх этих дефолтов,
а не рукописный `INSERT` с придуманными полями. Доступ к БД - `./artisan-tunnel-dev6.sh tinker` из
каталога бэкенда (скрипт сам поднимает SSH-туннель на `dev2.nwh.ru`).

**Ограничение №1 не нарушается.** Ни туннель, ни `php`, ни `composer` полом системы не становятся:
`fsh` их не запускает и не проверяет. Он подставляет каталог в промпт, дальше туннель поднимает сам
агент своим `Bash`, и отсутствие php ломает конкретный ход агента, а не харнесс.

**Границы те же, что у фронта.** api4 - чужой проект: читать можно, править нельзя, пишущие действия
только через одноразовый worktree (§D). Плюс правило самого бэкенда, которое харнесс не ослабляет:
**в БД по умолчанию только чтение**, любая запись - с явного разрешения человека. Промпт это
повторяет, а не смягчает: у агента в чужой БД нет ни одного основания писать молча.

**Задачи бывают и только в бэкенде.** Отдельной механики это не требует: вторая запись в `projects`,
`-P fitstars-api4` - и `mrs`, `mr`, `conflict`, `task` работают там как есть. Своё у бэкенда только
`checks` (phpstan/grumphp вместо eslint/tsc) - это уже настраиваемый список.

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
нечего и `upstream` не заводится. Работа идёт в `master`, пушей из фазы нет.

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

**Фаза 7. Уведомления и бот (Telegram).** 7a - исходящие уведомления и отчёты. 7b - интерактивное
управление через бота.

*7a сделано:* исходящий транспорт переведён на Telegram Bot API (`telegram.chat_id` и
`telegram.bot_token` в конфиге/env/keychain), `src/notify.js` (`runMessage` + `postTelegram`),
подписка внутри движка - уведомление уходит из CLI, MCP и TUI одинаково. Провал POST не ломает
ран. 7b (двусторонний бот, команды, inline-кнопки аппрува) перенесена в дорожную карту v2 (Фаза 13).

**Фаза 8. Watcher.** Персистентные снапшоты, дифф против предыдущего, триаж судьёй. Уведомляет,
не запускает.

*Сделано:* `fsh watch` — один опрос по команде человека (демона и расписания нет, см. «чего в v1
не делаем», п. 6). Снимок = вывод `mrs` в `~/.local/state/fs-harness/watch/<repo>.json`, события
`pipeline` / `threads` / `conflict` / `mr_new` / `mr_gone`, триаж ролью `event-triage` раскладывает
их на срочно / к сведению / шум, важное уходит в Telegram. Проверено живьём на fitstars-nuxt.

**Фаза 9. Web/SSE.** Тот же `runAction`, `for await` → `res.write('data: ...')`. По смыслу это уже
v2 (п. 1 «чего не делаем»), номера в дорожной карте у неё нет намеренно: она не запланирована, а
отложена до того, как TUI проживёт месяц и станет понятно, чего ему не хватает.

**Фаза 10. Агент в чужом проекте (§J).** Пять шагов, каждый отдельным коммитом.

1. *Механика.* `task start`, `task push`, `glab.createMR`, `jira field`, гарды защищённых веток и
   грязного дерева, `--dry-run` везде. **Сделано.**
2. *Сценарии.* `flow list|show`, протоколы `take-task` / `push-task` / `fill-jira`, раздел
   «Сценарии» в `agent-guide`, тест на то, что все упомянутые команды существуют. **Сделано.**
3. *Инициализация.* `fsh init`, `--check`, проверка в `doctor`, установка в fitstars-frontend плюс
   `Bash(fsh:*)` в его `.claude/settings.local.json` (не в общий `settings.json`). **Сделано.**
4. *Приёмка.* `fsh task judge [KEY]`, рубрика `src/prompts/judge/task-acceptance.md`, роль в
   конфиге. **Сделано** (раньше шагов 2-3: сценарии ссылаются на эту команду, а ссылаться на
   несуществующее нельзя - это ровно то, что ловит тест шага 2).
5. *GrowthBook (§K).* Сначала одна curl-проверка живого инстанса, потом `src/growthbook.js` и
   команда. **Сделано** (тоже раньше шагов 2-3: сценарий заполнения «Контента» ссылается на
   `fsh growthbook`).

*Готово, когда:* в `~/Projects/fitstars-frontend` свежая сессия Claude Code по фразе «возьми FD-xxxx
в работу» встаёт на `feature/FD-xxxx`, а по фразе «запушь задачу» открывает MR в `dev`.

---

## Дорожная карта к полной автоматизации (v2)

Фазы перехода от полуавтоматического ассистента к автономному харнессу.

**Порядок задан зависимостями, а не номерами.** Ревью 2026-09-16 показало, что фазы были написаны
списком фич, и три из них не собирались физически. Что выяснилось и учтено ниже: вебхуки на ноутбуке
недостижимы без туннеля, то есть без новой внешней программы (ограничение №1); у кнопки аппрува нет
механики - `publish` это замыкание внутри живого рана, доиграть его по сохранённому рану нечем;
бюджет в долларах считать не из чего - персистентного учёта нет, а цена работы агента не снимается
вовсе. Плюс в цепочке автомата не хватает самого главного звена: действия, которое пишет код по
задаче. Всё это разложено по фазам как обязательные шаги, а не как «потом разберёмся».

Общее для всех фаз: новые модули сетевые и долгоживущие, поэтому каждый получает тот же шов, что
`glab` и `jira` (инъекция `fetchImpl`, exec и часов), и ту же финальную проверку -
`rm -rf node_modules && npm ci && npm test` плюс `doctor`.

**Фаза 11. Фоновый демон watcher (1-2 дня).** Статус: сделано.
Полноценный фоновый цикл вместо разового вызова `fsh watch`.
- Демон опроса: `fsh watch --daemon`, интервал `watch.intervalSeconds` (дефолт 300 с), вкл/выкл и
  интервал на проект.
- **Обход всех проектов конфига.** Сегодня `pollOnce` и `cmdWatch` работают с одним `ctx.repo`;
  файлы снимков уже разведены по repo, так что это цикл, а не переделка.
- **Очередь заданий и ключ идемпотентности задаются здесь**, а не в фазе 15: `source + kind +
  (MR|ключ задачи) + sha` плюс TTL. Иначе одно и то же событие поставится в очередь трижды.
- **Очередь зовёт действия с `yes: true`.** Движок спрашивает подтверждение (`confirm()` в
  `engine.js`), а без stdin ответ - «нет», и задание тихо отменится. Без явного флага автозапуск
  запрещён по определению - это же и предохранитель.
- **Демон и залоченный keychain.** `security find-generic-password` на залоченном экране ключ не
  отдаст, OAuth-токен `claude` лежит там же: демон начнёт молча падать по ночам. Требование - демон
  стартует, только если все нужные секреты читаются из env; `doctor --daemon` это проверяет.
- **launchd/systemd: печатаем, не ставим.** `~/Library/LaunchAgents/*.plist` - глобальный конфиг, а
  их мы не трогаем (CLAUDE.md). `fsh` печатает готовый plist/unit и команду `launchctl bootstrap`,
  ровно как `fsh init` печатает блок для `CLAUDE.md`.
- **HTTP-слушатель вебхуков вычеркнут совсем, не отложен.** Замер 2026-09-16 (см. «Проверенные
  факты»): в GitLab у владельца Developer, `projects/.../hooks` отвечает 403; в Jira регистрация
  вебхука по API-токену невозможна в принципе. Адрес и туннель тут даже не главное - регистрировать
  хук нечем. **Опрос - не временная мера, а единственный способ**, и фаза 11 строится вокруг него.
*Готово, когда:* демон сутки крутится по всем проектам конфига, события попадают в очередь без
дублей, а `fsh watch` вручную работает как раньше.
*Сделано:* `fsh watch --daemon` (цикл по всем проектам, `watch.enabled` и `watch.intervalSeconds`
общие или на проект, дефолт интервала 300 с - один опрос большого репозитория идёт под минуту,
на 60 с демон опрашивал бы непрерывно; конфиг перечитывается каждым циклом, упавший опрос проекта цикл не роняет,
SIGINT/SIGTERM будят демон посреди сна), `src/queue.js` (ключ `source:kind:(mr<iid>|<ключ>):sha`,
TTL `watch.ttlSeconds`, дефолт сутки), `fsh queue [list|clear]`, `fsh watch install` (печать
launchd-plist и systemd-unit), `doctor --daemon` (секреты из env + предупреждение про cli-судью).

*Три расхождения с формулировкой фазы, внесены при реализации:*
1. **Очередь только копится, действий не зовёт.** Пункт «очередь зовёт действия с `yes: true`»
   вызывающего в этой фазе не имеет: воркеры - фаза 15, `implement` и автомат - 14. Требование
   записано в `docs/SPEC.md` рядом с форматом задания, чтобы воркер не придумывал своё.
   Критерий фазы («события попадают в очередь без дублей») этим не затронут.
2. **`sha` добавлен в JSON `mrs`.** Ключ идемпотентности собирается из снимка, а снимок - это вывод
   `mrs`; поля `sha` там не было. Поле additive, остальной вывод не менялся.
3. **Заведена команда `fsh queue`.** В тексте фазы её нет, но очередь, которую нечем посмотреть,
   непроверяема: `queue list` - и есть исполняемая проверка «без дублей».

**Фаза 12. Авто-исправление упавших пайплайнов (`ci-fix`) (2-3 дня).** Статус: сделано.
**Сделано.**
Действие `action: ci-fix` (`fsh ci-fix [MR|iid]`).
- **Предшаг в `glab.js`: сырой ответ.** `/jobs/:id/trace` отдаёт `text/plain`, а наш `api()` делает
  `JSON.parse` и на не-JSON возвращает `null` - логи джобы потерялись бы молча. Нужен
  `apiRaw()`/`{raw: true}` и тест на не-JSON ответ.
- Сбор контекста: логи упавших джоб, выжимка stack trace и упавших тестов/линтов, дифф ветки.
- Изоляция в worktree, шаблон `ci-fix.md`, локальные `checks`, гейт судьи `ci-acceptance`, пуш фикса
  и ретрай упавшей джобы.
- **Зависимости обязательны.** При расхождении lock-файла `deps_available: false`, и тогда `checks`
  не гоняются вовсе - судья примет фикс, не увидев ни одной прогнанной проверки. Для `ci-fix`
  либо `deps.strategy: install`, либо `deps_available: false` автоматически считается «не approve».
- **Счётчик попыток.** Свой же push рождает новый пайплайн, watcher ловит его и
  зовёт `ci-fix` снова: на стабильно красном тесте это бесконечный цикл. Лимит - `ci.maxRetries`
  (дефолт 2), после него `hand_to_human` и тишина по этому MR.
  *Расхождение с исходной формулировкой (ключ `(MR, job, sha)`), внесено при реализации:* sha в ключ
  не входит. Свой же push меняет sha, то есть ключ со sha рождался бы новый на каждой итерации и
  счётчик обнулялся бы - ровно тот цикл, ради которого он и заводился. Ключ - `(MR, набор упавших
  джоб)`, а sha хранятся внутри записи: повтор того же sha означает, что прошлая попытка ничего не
  сдвинула, и это стоп сразу, не дожидаясь лимита.
- **Только свои MR.** Чужую ветку не чиним: гард на авторство рядом с теми, что уже есть на
  защищённые ветки и грязное дерево.
*Готово, когда:* на упавшем по линту MR `fsh ci-fix` исправляет код, проходит судью, пушит и
перезапускает джобу, а второй подряд провал по тому же sha останавливает попытки.
*Сделано:* `fsh ci-fix <mr|ветка>`, `glab.js` умеет `apiRaw()`/`getJobTrace`, рубрика
`judge/ci-acceptance.md` (ищет заглушенную проверку, а не решённый конфликт), `deps_available:
false` роняет ран с `deps_unavailable` **до** запуска агента, счётчик в
`~/.local/state/fs-harness/ci-fix/<repo>.json`, гард на авторство, дифф ветки в промпте рядом с
логами, клавиша `C` в TUI. Цепочка - в `docs/SPEC.md`.

**Фаза 13. Доигрывание рана и двусторонний Telegram-бот (3+ дня).** Статус: сделано.
**Сделано.**
Пошаговый план был: [PLAN-FAZA-13.md](PLAN-FAZA-13.md).

*13a. `fsh publish <runId>` - без него кнопку аппрува не к чему подключать.* Сейчас `publish` это
замыкание в декларации действия, которому нужны живые `ws.git`, `ctx`, `facts` и `target`, а
`--judge-only` умеет работать только по артефактам. К моменту, когда человек нажмёт кнопку в
телефоне, процесс рана давно мёртв.
- Состояние рана `pending_approval` в `meta.json`: гейт не роняет ран, а останавливает его.
- `fsh publish <runId>` восстанавливает воркспейс из `meta.json` (worktree, ветка, `base`,
  `head_sha`), перепроверяет `git rev-parse HEAD === meta.head_sha` и `ls-remote` цели - и только
  потом зовёт `action.publish`.
- **Раны в `pending_approval` не прунятся** (иначе ретеншн на 50 ранов съест тот, который ждёт
  ответа), у аппрува TTL сутки: истёк - авто-reject и уборка worktree.
- **`session_id` агента пишется в `meta.json`** (§B) - иначе `[Revise]` начнёт работу заново вместо
  доделки в той же сессии.

*13b. Бот.* `getUpdates` (long-polling) или входящий вебхук, хранение `offset`,
`answerCallbackQuery`, inline-кнопки. Сегодня `notify.js` умеет ровно `sendMessage` без
`reply_markup` - всё остальное пишется здесь, с `fetchImpl`-швом ради тестов.
- Команды боту: `/mrs`, `/watch`, `/run <action>`, `/status`.
- Интерактивный гейт: `[Approve & Push]`, `[Reject]`, `[Revise]` на вердикте судьи.
- **Allowlist обязателен:** `telegram.allowed_user_ids`, сверка `message.from.id` и
  `callback_query.from.id`, чужие игнорируются молча. Кто знает бота, тот иначе и пушит в origin.
  В `callback_data` - runId плюс одноразовый токен, чтобы старая кнопка не сыграла второй раз.
*Готово, когда:* ран с плохим вердиктом ждёт в `pending_approval`, решение принимается кнопкой в
Telegram, push происходит из `fsh publish`, а нажатие кнопки чужим аккаунтом не делает ничего.
*Сделано:* `meta.state` (`running`/`done`/`failed`/`pending_approval`/`rejected`/`expired`) и
`setRunState`; `ws.baseSha` из `rev-parse <base>` (дыра с `meta.base_sha` закрыта);
`interactiveGate` между `accept` и `publish` (при `telegram.approvals` + target — любой вердикт
пакуется в `pending_approval` с nonce, worktree `keep`, без `result.json` и без `notify`);
`pruneRuns` пропускает `pending_approval`; `sweepExpiredApprovals` (TTL сутки) в начале
`publish`/`revise` и каждый цикл бота; `src/publish.js` — `publishRun` (sweep → гарды
`approval_expired`/`run_not_pending`/`run_not_approved`/`already_published`/`worktree_gone` →
`HEAD === head_sha` → `ls-remote` → для conflict `merge-tree` → `action.publish`) и `reviseRun`
(`SESSION_ARGS[family]` по `meta.session_id`, `spawnSession` с resume, новая судья, при approvals
снова pending с новым nonce); `src/tgbot.js` (`tgCall`/`getUpdates`/`sendButtons`/`answerCallbackQuery`/
`editMessageReplyMarkup`/`sendApprovalRequest`/`handleUpdate`/`isAllowed`/`load|saveBotState`);
`src/commands/bot.js` — `fsh bot` (стартовый снос `timeout:0`, allowlist обязателен, команды
`/mrs` `/watch` `/status` `/run`, кнопки с одноразовым nonce, publish/revise в фоне цикла);
`revise` и `bot` в реестре (без MCP); doctor — пункт «telegram bot» (критично при approvals:true);
`engine.spawnSession` выделен из `runAgent` (единственный рефактор хвоста).

*Расхождения с формулировкой, внесённые при реализации:*
1. **Кнопки на любом вердикте pre-push**, а не только на reject: дешевле и честнее остановиться
   всегда, человек видит вердикт в сообщении. Формулировка «ран с плохим вердиктом» была уже в плане
   фазы, `PLAN-FAZA-13.md` §2.2 это явно разрешил.
2. **`publishRun` не требует `state === pending_approval` для legacy-ранов.** Упавшие на push/build
   раны (до фазы 13) по-прежнему доопубликовываются: `run_not_pending` только для `rejected`/чужих
   состояний, `already_published` — через `result.json` и через `ls-remote`.
3. **`fsh publish` без отдельного usage-флага `--dry-run` уже имел** (пункт main.js «ничего не
   менять») — оставлен как был.
4. **doctor: allowlist критична только при `approvals: true`**, иначе некритичный пункт — бот
   без approvals никому не нужен.

**Фаза 14. Сквозной оркестратор жизненного цикла задачи (5-7 дней после закрытия зависимостей).**
Статус: сделано.
Пошаговый план: [PLAN-FAZA-14.md](PLAN-FAZA-14.md).
Стейт-машина полного цикла задачи: от статуса в Jira до деплоя. Зависит от фаз 11, 12 и 13; сам
оркестратор без них - пустая обёртка. Внутри три шага, и первые два - не украшение.

*14a. Действие `implement` - звена, которое пишет код по задаче, сегодня нет.* Действий четыре
(`conflict`, `threads`, `review`, `analyze`), ни одно не реализует задачу: `take-task` - протокол
для человеко-сессии, `task start`/`task push` - простые команды без worktree, `verify` и гейта.
Нужна полноценная декларация: промпт по задаче Jira, изоляция `task-worktree`, `verify` = локальные
`checks`, роль `acceptance`, `publish` = `task push`. **И `task start`/`task push` учатся работать по
переданному каталогу:** сегодня они пишут в живой чекаут `fitstars-frontend` (§D), а автомат - тем
более пул воркеров - не может работать в дереве, где сидит человек. Живой чекаут остаётся ручным
режимом.

*14b. Учёт расхода - на нём стоит весь бюджет.* Сохранять `total_cost_usd` и usage из `result`-события
агента в `meta.json` (сейчас движок их выбрасывает) и накапливать агрегат по рану и по задаче на
диске. **Под подпиской доллары фиктивны:** профили `cc` и `opus-cli` ходят по подписке, там
`total_cost_usd` - оценка, а не счёт. Поэтому `maxCostPerTask` действует только для профилей с
ключом, а для подписки предохранители другие: таймаут, `maxRetries` и обработка рейт-лимита.
**Рейт-лимит распознаётся отдельно от провала:** сегодня любой ненулевой код выхода агента - это
`agent_failed`, и воркер честно пойдёт на следующую попытку в стену. Надо переводить задачу в
`paused_until <reset>`, попытку не засчитывать.

*14c. Сам автомат.*
- **Жёсткое требование:** фича автовыполнения строго выключаемая и **ПО УМОЛЧАНИЮ ВЫКЛЮЧЕНА**.
  - В конфиге: `automation: { enabled: false, maxCostPerTask: 2.0, maxRetries: 3 }`.
  - В CLI: флаг `--auto-execute` (требует явного указания, без флага автовыполнение не запускается).
  - Предохранители: лимит бюджета, таймаут, остановка при reject судьи без автоматического пуша.
  - `automation.enabled` перечитывается каждым циклом, а не на старте: выключатель должен работать
    на ходу.
- Автоматический цикл (когда опция включена явно):
  1. Триггер: задача перешла в статус «В работе» (или вызов `fsh task auto <KEY>`).
  2. Создание ветки `task start`.
  3. Агент пишет реализацию действием `implement` (14a).
  4. Прогон локальных `checks` + приёмка `task judge`.
  5. Открытие MR в целевую ветку (`task push`).
  6. Мониторинг CI: при падении -> запуск `ci-fix`.
  7. Мониторинг тредов: при появлении замечаний ревьюера -> запуск `threads`.
  8. Мониторинг конфликтов: при расхождении с dev -> запуск `conflict`.
  9. После прохождения CI и аппрува всех тредов -> заполнение обязательных полей и перевод задачи
     в Jira («В ревью» / «Готово к тестированию»).

*Девятый шаг разворачивается в три (решение владельца 2026-09-16).* Переход «В ревью» в FD
заворачивает workflow-валидатор: нужны `customfield_10242` («Technical details for QA») и
`customfield_10275` («Контент»). Заранее это не проверяется - валидатор не виден ни одному GET (см.
«Проверенные факты»), поэтому порядок такой:

  9.1. Агент прогоняет скиллы проекта: `manual-qa` даёт текст для «Technical details for QA»,
       `add-dictionary-translations` и флаги GrowthBook - для «Контента».
  9.2. Тексты кладутся через уже существующую `fsh jira field <KEY> "<поле>" --file -`. Движку сюда
       дописывать нечего.
  9.3. POST перехода. Пришёл 400 - разбираем список недостающих полей, пишем его в лог и **зовём
       человека**; это штатный исход, а не сбой. «Контент» про фича-флаги агент без контекста задачи
       не угадает, и на части задач шаг будет упираться в человека всегда.

**П. 4 «чего не делаем» этим не отменяется, и это важно.** Разделение остаётся прежним: *что* писать
знает скилл проекта, *куда и как* - `fsh`. Меняется только то, кто зовёт скилл: внутри автомата это
агент, а не человек в чате. Знание об обязательных полях по-прежнему не дублируется в харнессе.
- **Не реагируем на свои события.** Ответ в тред рождает событие «новые треды», push фикса - новый
  пайплайн: без фильтра (автор заметки - я, пайплайн на моём sha) цикл заведётся сам от себя. Плюс
  глобальный лимит шагов на задачу поверх `maxRetries` отдельных действий.
- **Состояние задачи на диске и выключатель:** где «потрачено X, шаг Y», что с задачей после
  перезапуска демона, `fsh auto status|stop <KEY>`.
*Готово, когда:* при `automation.enabled: false` (дефолт) ни одна задача не выполняется
автоматически; при включении задача проходит цепочку от Jira до MR с реакцией на сбои, а перезапуск
демона её не теряет.
*Сделано:*
- 14a: действие `implement` (`implementAction`, план opus -> код gemini -> судья task-review с maxRevise:3 -> push ветки -> черновик MR).
- 14b: учёт расхода в `src/costs.js` (costs.jsonl, `appendCost`, `sumCosts`), `agentCost` из stream envelope в `meta.json` и `x.agentCost`, распознавание `agent_rate_limited` с `retry_after`.
- 14c: автомат жизненного цикла в `src/auto.js` (`advanceTask`, стейт в `auto/<KEY>.json`, шаги start -> implement -> review -> ci -> threads -> conflict -> done), фильтр собственных событий и sha в `src/watch.js`, CLI `fsh auto <KEY>|status|stop` (`src/commands/auto.js`), интеграция в демон `watch --daemon --auto-execute`.

**Фаза 15. Очередь задач и параллельность (2-3 дня).** Статус: сделано.
Пошаговый план: [PLAN-FAZA-15.md](PLAN-FAZA-15.md).
- Централизованная очередь задач (`~/.local/state/fs-harness/queue/`) - формат и ключ
  идемпотентности уже заданы фазой 11, здесь добавлены воркеры.
- Пул воркеров с независимыми `task-worktree`.
- **Уборщик worktree - до воркеров, а не после.** `fsh worktrees list|gc` с ретеншном по возрасту и состоянию
  задачи, он же подбирает сирот, оставшихся от прунутых ранов (§B).
- **Локи.** Файловый лок на ключ `project + branch | MR` (`repo:branch`, `repo:mr<iid>`) с pid, mtime,
  протуханием (30 мин) в `src/locks.js`.
- **`MAX_ARCHIVES` в конфиг и прун по возрасту** в `src/agent/journal.js` (`DEFAULTS.journal = {maxRuns: 50, maxAgeDays: 30}`).
*Готово, когда:* несколько событий (конфликт в MR 1, упавший тест в MR 2) обрабатываются параллельно
в изолированных каталогах, две задачи на одну ветку сериализуются локом, а `worktrees gc` чистит за
собой.
*Сделано:*
- Инвентаризация и gc worktree в `src/worktrees.js`, `removeWorktree` расширен для projectDir, CLI `fsh worktrees list|gc` (`src/commands/worktrees.js`, `DEFAULTS.workspace.gcOlderThanDays = 7`), авто-gc в `cmdWatchDaemon`.
- Файловые локи в `src/locks.js` (`acquireLock`, `releaseLock`, `listLocks`, атомарный `openSync('wx')`), колонка `ЛОК` в `fsh queue list`.
- Настраиваемый ретеншн ранов по возрасту и числу в `src/agent/journal.js` (`pruneRuns`, `createRun`, `DEFAULTS.journal`).
- Воркер-цикл в `src/worker.js` (`takeJob`, `runWorker`, `concurrency`, `JOB_MAX_ATTEMPTS = 3`), функции `removeJob`/`updateJob` в `src/queue.js`, CLI `fsh worker [--once] [--concurrency N]` (`src/commands/worker.js`), интеграция в демон `watch --daemon` при `workers.enabled: true`.

**Фаза 16. Серверный headless-режим (отложена).** Статус: отложена - ждёт решения владельца
про авторизацию `claude` в контейнере (шаг 0 плана).
Пошаговый план: [PLAN-FAZA-16.md](PLAN-FAZA-16.md).
*Решение владельца 2026-09-16: фаза откладывается - ответа про авторизацию агента в контейнере пока
нет.* Пункты ниже остаются заготовкой: ни оценки, ни места в очереди у фазы нет, пока вопрос не
закрыт. Фазы 11-15 от неё не зависят и идут своим чередом: единственная привязка, `fsh listen`,
отпала сама - вебхуков не будет ни на ноутбуке, ни на сервере (см. «Проверенные факты»).

Отвязка от локального окружения разработчика.
- **Вопрос, без которого фаза не планируется: чем авторизуется `claude` в контейнере.**
  План сам фиксирует, что `--bare` читает только `ANTHROPIC_API_KEY` и игнорирует OAuth и keychain,
  а агент и судья `opus-cli` живут по подписке. Либо монтируем креды хоста (`~/.claude`), либо
  заводим отдельный API-ключ - и это новая статья расходов. Решение за владельцем.
- Секреты из env - **в основном уже сделано**: env стоит первым в лесенке, отсутствие `security`
  глушится. Незакрытое - `glab` (токен в keyring хоста): нужен путь через `GITLAB_TOKEN`/`GITLAB_HOST`
  плюс проверка в `doctor`.
- **`cp -Rc` - macOS-only.** На Linux он упадёт, а падение проглотится в `deps_available: false`:
  все раны в контейнере молча пойдут без линта и с ослабленными фактами судьи. Нужна стратегия deps
  по платформе (`cp -a --reflink=auto`, иначе `link`/`install`), выбранную проверяет `doctor`, а
  молчаливый даунгрейд считается ошибкой, а не предупреждением.
- Dockerfile и compose-манифест. Это осознанное исключение из ограничения №1: контейнер -
  опциональный серверный путь, дефолт остаётся `npm ci` + `fsh` на хосте.
- Проверить на своей версии CLI, что `--dangerously-skip-permissions` работает не от root; если нет
  - образ обязан ходить не-root, и это требование к Dockerfile.
*Готово, когда:* харнесс в режиме демона и воркеров запускается в Linux-контейнере, `doctor` внутри
контейнера зелёный, и ни один ран не уходит к судье с молча отвалившимися зависимостями.

**Фаза 17. Вложения Jira и мастер по самому fsh (1-2 дня).** *Решение владельца 2026-09-17.*
Статус: сделано.
**Сделано.**
Две отдельные дырки, закрытые одним заходом: задача не заполняется до конца без вложений, а упавший
ран не разбирается ничем, кроме чтения `events.jsonl` глазами.

**17a. Вложения Jira.** Седьмая запись в Jira. `api()` в `src/jira.js` получает два обхода:
`form` (тело уходит в fetch как есть, boundary у multipart проставляет он сам) и `raw` (ответ не
разбирается в JSON - содержимое вложения двоичное). Плюс абсолютный URL в `path`: ссылка на
содержимое приходит от самой Jira, а на Cloud и Server пути разные. Обязателен заголовок
`X-Atlassian-Token: no-check`, без него Jira считает аплоад XSRF и отвечает 403.

- CLI: `fsh jira attach <KEY>` - список, `fsh jira attach <KEY> <файл...>` - приложить,
  `fsh jira attach get <KEY> [имя|id] [--out <каталог>]` - выгрузить.
- `fsh jira field <KEY> "<поле>" --file <путь> --attach` кладёт один файл и в поле текстом, и
  вложением: ровно сценарий `fill-jira` со словарём в поле «Контент».
- TUI: `@` на вкладке задач - окно вложений, `Enter` выгружает в текущий каталог, `a` прикладывает
  файл. В `editKind()` вложения по-прежнему `null` - полем их не заполнить, окно отдельное.
- Имя файла из Jira - чужой ввод: на диск пишется только `basename`, иначе `../..` в имени увёл бы
  запись из каталога назначения.

**17b. Мастер по самому fsh.** Диалог с агентом, который работает в каталоге харнесса, читает его
`CLAUDE.md`/`AGENTS.md`/`PLAN.md`/`src` сам и правит его же.

- Транспорт - `src/chat.js`. Своей машинерии сессий нет, потому что она не нужна: `claude` и `agy`
  принимают `--input-format stream-json`, то есть один живой процесс играет ход на каждую строку
  NDJSON и держит контекст сам. Замерено 2026-09-17: `num_turns` растёт, `conversation_id` один,
  память между ходами живёт. `pi` потокового входа не умеет - у него ход это отдельный процесс с
  тем же `--session-id`; ради этого `spawnAgent` получил `keepStdin` и `write()`.
- Вызов: клавиша `A` в TUI (окно поверх экрана) и `fsh ask "<вопрос>" [--run <id>]` в CLI. Плюс
  строка `разобраться: fsh ask` в хвосте любой ошибки, кроме `usage` и `canceled` - без напоминания
  ровно там, где упало, про мастера не вспомнят.
- Контекст брифа - только рантайм-факты: id рана, `code` и текст ошибки, хвост журнала в 40 строк,
  перечень артефактов. Файлы репозитория не инлайнятся (агент в этом каталоге, прочитает свежее), а
  **конфиг не попадает туда ни в каком виде**: в `telegram.bot_token` живой секрет.
- Права: окно в TUI работает профилем как есть, гейт здесь человек за клавиатурой - он видит каждый
  шаг. `fsh ask` без TTY - только чтение: из аргументов снимается `--dangerously-skip-permissions`
  и ставится режим плана (`--permission-mode plan --permission-prompts none` у claude, `--mode plan`
  у agy). У `pi` read-only-режима нет, и команда говорит это вслух, а не молчит.
- Worktree и судья мастеру не нужны: `npm link` смотрит на реальный каталог, а дерево git-версионное
  - откат это `git checkout`. Судья судит дифф против цели действия, а у «объясни, почему упало»
  такой цели нет.

**Исключение из ограничения №1, зафиксировано явно.** Профиль мастера по умолчанию - `agy`
(Antigravity CLI), а это новая внешняя программа. Пол системы она не меняет: `agy` стоит рядом с
`pi` как опциональный, `pickChatAgent` при отсутствии его в PATH молча берёт `cc`, `doctor` про это
говорит. Дефолтная конфигурация без `agy` остаётся рабочей - иначе ограничение было бы нарушено, а
не расширено.

*Готово, когда:* `fsh jira attach FD-XXXX <файл>` кладёт вложение в живую задачу и `fsh jira
FD-XXXX` его видит; `@` в TUI открывает вложения и выгружает выбранное; `fsh ask "почему упало"`
называет конкретный run id и его `code`, а не общие слова; `A` в TUI держит многоходовый разговор и
переживает выход из окна; `npm test` и `rm -rf node_modules && npm ci && npm test` зелёные,
`fsh doctor` зелёный и знает про `agy`.

**Открытые вопросы владельцу** (без ответов фазы не планируются, а не «планируются с допущением»):

1. ~~Есть ли Maintainer на fitstars-nuxt и админ инстанса Jira?~~ **Закрыт 2026-09-16 замером:**
   прав нет ни там, ни там, и в Jira дело даже не в правах. Вебхуки вычеркнуты, опрос навсегда.
2. Чем авторизуется `claude` в headless-контейнере - монтированием кредов или отдельным API-ключом?
   *2026-09-16: владелец ответить пока не может, фаза 16 отложена до этого.*
3. ~~Отменяется ли п. 4 «чего не делаем» ради девятого шага фазы 14?~~ **Закрыт 2026-09-16:** не
   отменяется. Автомат зовёт скиллы проекта агентом и кладёт тексты через `fsh jira field`, а на
   отказ валидатора штатно зовёт человека. Развёрнуто в шаге 9 фазы 14.

**Фаза 18. Бэкенд в контуре задачи (1-2 дня).** *Решение владельца 2026-09-17, см. §M.*
Статус: не начата (независима, может идти в любой момент).
Пошаговый план: [PLAN-FAZA-18.md](PLAN-FAZA-18.md).
Агент перестаёт догадываться о контракте и о данных: и то и другое подтверждается в `fitstars-api4`.

1. **Конфиг.** Поле `projects.<имя>.backend` - имя другого проекта конфига. `resolveProject` отдаёт
   рядом с проектом его бэкенд (каталог и репозиторий) или `null`. `doctor` говорит, что каталог
   бэкенда на месте и это git-репозиторий; нет каталога - предупреждение, не критическая ошибка.
2. **Промпты действий.** Переменные `backend_dir` и `backend_repo` в шапке промптов, где агент
   пишет код или разбирает задачу (`analyze`, `task-start`, agent-промпт действий). Текст короткий:
   контракт - из роутов и ресурсов бэкенда со ссылкой `файл:строка`, расхождение с задачей называть
   вслух. Знание о самом бэкенде не копируем - шлём читать его `AGENTS.md`.
3. **Сценарий `flows/backend-check.md`.** Протокол на два случая: подтвердить контракт (роут →
   контроллер → Resource/Request → поля и типы) и получить тестовые данные (фабрика из
   `database/factories/`, `./artisan-tunnel-dev6.sh tinker`, запись в БД - только с подтверждением
   человека). Тест на сценарии уже есть и греплит команды `fsh` - тут он ничего нового не требует.
4. **Судья видит поход.** В `facts` приёмки добавляется `backend_refs` - файлы бэкенда, на которые
   агент сослался. Пусто - не приговор (бывают задачи без API), но у судьи это перед глазами.
5. **Бэкенд-only.** Вторая запись в `projects` для `fitstars-api4` и проверка, что `-P` по ней
   работает без правок движка. Своё у бэкенда - только список `checks`.

*Готово, когда:* на живой FD-задаче с ручкой агент называет поля ответа со ссылкой на файл в
`fitstars-api4`, а не из описания задачи; `fsh doctor` знает про каталог бэкенда; `-P fitstars-api4
mrs` работает; `npm test` и `rm -rf node_modules && npm ci && npm test` зелёные.

**Фаза 19. Сообщения в рабочие чаты (Mattermost) (1 день).** *Решение владельца 2026-09-17.*
Статус: сделано.
**Сделано.**
Третья точка, где работа видна людям: Jira знает статус, GitLab знает MR, а команда узнаёт о том,
что задача уехала в ревью, только если кто-то написал в канал. Пишет харнесс, от имени человека.

- **Ограничение №1 не нарушено.** Mattermost — существующий корпоративный сервис, доступный по
  REST; ставить, логинить и поднимать рядом нечего, ровно как Jira, GitLab и Telegram. Новых
  программ фаза не приносит.
- **Токен сессионный — это следствие, а не предпочтение.** Замер 2026-09-17: на `mm.fitstars.ru`
  Personal Access Tokens выключены админом инстанса. Бот-аккаунт писал бы от себя, а нужно от
  человека, поэтому `fsh mm login` меняет логин и пароль на токен сессии (`POST /users/login`,
  заголовок `Token`) и кладёт его в keychain. Пароль не хранится. Если вход закрыт SSO или MFA,
  запасной путь тот же по коду: кука `MMAUTHTOKEN` из браузера кладётся в тот же ключ keychain.
- **Канал на сценарий:** `mattermost.channels.<сценарий>` в конфиге проекта. Сценарий v1 один —
  `review` (канал «Frontend Merge Requests»). Агент называет сценарий, id канала не выбирает.
- **Канал задаётся сценарием, id, `команда/имя-канала` или именем канала**, плюс разовый
  `--channel`. Имя разворачивается в id запросом: в URL Mattermost лежит имя, и требовать id
  значило бы гонять человека в devtools. `fsh mm channels [строка]` показывает свои каналы с id.
- **Формат сообщения зафиксирован владельцем дословно** - первой строкой описание задачи (как в GitLab), затем две строки со ссылками:
  `• MR !2833: <url>` и `• Jira FD-7655 <url>`. Шаблонизации нет: менять формат - менять
  `reviewMessage`.
- **Триггер двойной:** `fsh mm review [KEY]` (сама находит MR по текущей ветке и ключ по её имени)
  и флаг `fsh task push --post`, который зовёт ту же функцию. Без флага пуш молчит: запись в общий
  канал не должна быть побочным эффектом пуша. Шаг дописан в `flows/push-task.md`.
- **MCP-инструмента у `mm` нет намеренно:** вызовы из MCP идут с `yes: true`, и сообщение в общий
  канал ушло бы мимо человека. Из агента команда зовётся как CLI, по сценарию.
- `doctor` дёргает `/users/me`, а не просто проверяет наличие токена: протухшую сессию по наличию
  ключа не отличить от живой.

*Готово, когда:* `fsh mm review FD-XXXX --dry-run` печатает описание задачи, ссылки на MR/Jira и канал;
`fsh mm login` кладёт рабочий токен, `fsh mm whoami` называет твой аккаунт; живой прогон оставляет
сообщение в «Frontend Merge Requests» от твоего имени; `fsh task push --post` делает то же в конце
пуша; `npm test` и `rm -rf node_modules && npm ci && npm test` зелёные, `fsh doctor` знает про
Mattermost.

## Чего в v1 не делаем

Пункты, которые снимает дорожная карта v2, помечены прямо здесь. Без пометки через месяц не отличить
действующее решение от отменённого.

1. Веб-дашборд, HTTP-сервер, SSE, аутентификация. Только заложенные швы. *Частично снято фазой 13:*
   у бота появляется входящий транспорт, но это не веб-дашборд и не аутентификация - только
   allowlist по id.
2. Долгоживущий worktree на задачу (`task-worktree`) - только константа в `MODES`. *Снято фазой 15*,
   и вместе с ним туда же уезжает уборщик: сегодня `task-worktree` не удаляется никогда.
3. Автопостинг ревью в GitLab: `review` печатает находки, не комментирует MR. Комментирует CI-бот,
   дублирование хуже молчания.
4. Комментарии и worklog в Jira - слой read-only. *Изменено по решению владельца 2026-09-11 и
   2026-09-13 (дважды):* записей в Jira теперь четыре - статус (`fsh jira move`, `s` в TUI),
   спринт (`fsh jira sprint`, `S` в TUI), комментарий (`fsh jira comment`, `c` в TUI) и правка полей
   (`E` в TUI, только TUI, CLI-команды нет). Правятся те поля, которые сама Jira отдаёт в `editmeta`:
   Assignee, «Ответственный разработчик», Priority, «Компонент», Fix versions, Labels. *Изменено по
   решению владельца 2026-09-14:* правятся все поля из `editmeta`, которые есть чем заполнить -
   списки и люди выбираются из готовых вариантов, строки, числа и даты набираются, а многострочный
   текст (Описание и любое `textarea`) открывается в `$EDITOR` и после выхода уходит одним PUT.
   Своего редактора текста в TUI по-прежнему нет (см. п. 16). *Изменено фазой 17:* вложения тоже наши
   — `fsh jira attach` и окно `@` в TUI кладут, выгружают и показывают их, `field --attach` делает
   это заодно с записью поля. Не наш остаётся только worklog. Переходы с обязательными полями
   workflow-валидатора (в FD это «В ревью») командой не закрываются: Jira возвращает список
   недостающих полей, их по-прежнему заполняет скилл `jira-transitions`. *Уточнено фазой 14:*
   в автомате скилл зовёт агент, а не человек, но пункт остаётся в силе - знание о том, *что*
   писать в эти поля, в харнесс не переезжает. Кастомные поля ищутся по
   названию через `expand=names`, а не по `customfield_*`: id у каждого проекта свои.
5. Параллельный запуск нескольких действий на одном worktree. Один ран - один worktree, очередь на
   проект. *Снято фазой 15* - там же появляются файловые локи, которых сейчас в коде нет ни одного.
6. Автозапуск действий по событиям (watch-режим, launchd, cron). Всё запускает человек или
   чат-команда. *Снято фазой 11* - с оговоркой: `fsh` печатает plist/unit и команду установки, но
   сам в `~/Library/LaunchAgents` не пишет (глобальные конфиги не трогаем).
7. Docker и удалённое исполнение агентов. *Снято фазой 16*, и только как опциональный серверный
   путь: дефолт остаётся `npm ci` + `fsh` на хосте, и `rm -rf node_modules && npm ci && npm test`
   гоняется там же.
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
    *Уточнено 2026-09-13:* вкладка «Промпты» умеет завести личную копию шаблона (`e`) и убрать её
    (`d`) - это работа с файлами, а не редактор текста внутри TUI.
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
- Расход считается: `total_cost_usd` каждого рана копится на диске и показывается в TUI. Гейт
  на пишущем действии это один вызов opus на максимальном effort по полному диффу, и стоит видеть
  фактическую цену, а не надеяться.
  *Не сделано (сверка 2026-09-16):* накопителя на диске нет - TUI суммирует цену в памяти за сессию,
  и считает только судью (см. §B). Плюс под подпиской `total_cost_usd` это оценка, а не счёт:
  профили `cc` и `opus-cli` денег за вызов не тратят. Закрывается первым шагом фазы 14, где на этом
  стоит `automation.maxCostPerTask`.
