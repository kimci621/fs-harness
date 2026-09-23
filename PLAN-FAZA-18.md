# PLAN-FAZA-18 - Бэкенд в контуре задачи (fitstars-api4)

Инструкция для AI-агента. Выполняй шаги по порядку. Исходная формулировка - PLAN.md,
«Фаза 18» (строки 1562-1583) и «§M. Бэкенд как источник правды» (строки 1074-1121).
Решение владельца 2026-09-17. Критерий приёмки дословно:

> *Готово, когда:* на живой FD-задаче с ручкой агент называет поля ответа со ссылкой на
> файл в `fitstars-api4`, а не из описания задачи; `fsh doctor` знает про каталог бэкенда;
> `-P fitstars-api4 mrs` работает; `npm test` и `rm -rf node_modules && npm ci && npm test`
> зелёные.

Оценка: 1-2 дня. Самостоятельная фаза, от 13-16 не зависит.

## Смысл фазы (не потерять по дороге)

Агент перестаёт ДОГАДЫВАТЬСЯ о контракте API и о тестовых данных: и то и другое
подтверждается в репозитории бэкенда `fitstars-api4` (Laravel 12 / PHP 8.2, репо
`fitstars/fitstars-api4`, target `dev`, каталог `~/Projects/fitstars-api4`).
**Харнесс не переписывает знание о бэкенде в себя**: у api4 свой AGENTS.md - промпт шлёт
агента читать его. Scribe (`public/docs/openapi.yaml`) - генерация, а не источник; источник -
код: роут → контроллер → Resource/Request → поля и типы, со ссылкой `файл:строка`.

## Жёсткие ограничения

1. Ноль новых внешних программ и npm-зависимостей.
2. Ошибки - CliError с кодами. Тесты - node --test без сети. Комментарии на русском.
3. Минимальный диф: фаза маленькая, искушение «заодно» расширить - подавить.
4. Запись в БД бэкенда - ТОЛЬКО с подтверждением человека (это в протоколе
   backend-check, не в коде харнесса).

## §0. Что прочитать перед началом

- `PLAN.md` 1074-1121 (§M целиком), 1562-1583 (фаза 18).
- `src/config.js` - `PROJECT_DEFAULT` (строка ~16: все поля проекта), `pickProject`
  (~156-169: приоритет `-P` > `FS_HARNESS_PROJECT` > `activeProject` > единственный),
  `loadConfig` (~173: как собирается плоский cfg). **Функции `resolveProject` нет** -
  в фазе она появляется поверх `pickProject`.
- `src/prompts.js` - `templatePaths` (порядок переопределения), `renderTemplate`
  (СТРОГИЙ: объявленная в `vars` переменная обязана быть передана, иначе CliError
  `prompt_var_missing` - это важно для шага 3).
- `src/prompts/actions/analyze.md` - переменные `[issue_key, ..., project_dir]`.
- `src/actions/analyze.js` - как `context(x)` собирает переменные.
- `src/prompts/flows/` - `take-task.md`, `push-task.md`, `fill-jira.md`: формат сценария
  (front-matter только с `description`, тело - протокол с командами `fsh`).
- `src/judge/payload.js` - `buildAcceptancePayload`: как facts превращаются в текст судье.
- `src/actions/threads.js` - паттерн «агент пишет JSON в run.dir, verify читает»
  (`replies.json`, CliError `agent_failed` если нет) - он же для `backend_refs`.
- `src/commands/doctor.js` - как добавляется проверка (`add(name, ok, detail, critical)`).
- `test/flow.test.js` - тест сценариев: грепит `fsh <cmd>` по телу flows и сверяет с
  COMMANDS; новый сценарий подхватится автоматом.
- `test/config.test.js` - паттерны тестов конфига.

## Известные факты (сверено 2026-09-21)

- Бэкенд в коде уже трогается ровно один раз: `src/secrets.js` читает `REST_TOKEN` из
  `~/Projects/fitstars-api4/.env` (ENV_FILES, словарь). Это не связь «проект → бэкенд»,
  а файловый fallback секрета - не путай, не ломай.
- `deps` у проекта мержится через `workspace.deps` (общий + `p.deps`) - прецедент
  «поле есть у проекта, дефолта нет» уже есть: `backend` делаем так же.
- В `DEFAULTS` и примере §H поля `backend` сейчас нет НАМЕРЕННО (PLAN §M) - оно появляется
  в этой фазе.

---

## Шаг 1. Конфиг: `projects.<имя>.backend`

**Файл: `src/config.js`.**

1.1. В `PROJECT_DEFAULT` добавь `backend: null` (имя другого проекта конфига или null).

1.2. Новая экспортируемая функция `resolveProject(cfgV2, name)` - поверх существующего
механизма: возвращает `{name, project, backend}` где `backend` = `{name, dir, repo}` проекта
с именем `project.backend`, или null если поля нет. Неизвестное имя бэкенда - CliError
('config_invalid', «projects.<имя>.backend указывает на несуществующий проект»). Цикл
(A.backend = B, B.backend = A) - CliError тем же кодом (одна проверка: backend.backend
запрещён, бэкенд сам бэкенда не имеет).

1.3. В `loadConfig` после `pickProject`: если у активного проекта есть `backend` - в плоский
cfg клади `cfg.backend = {name, dir: expandHome(p2.dir), repo: p2.repo}`. Иначе
`cfg.backend = null`. Тесты loadConfig не должны пострадать (поле additive).

**Тест: `test/config.test.js`** - конфиг с backend: резолв в `{name, dir, repo}`; без
backend: null; битая ссылка: config_invalid; цикл: config_invalid.

## Шаг 2. doctor

**Файл: `src/commands/doctor.js`.** Некритичная проверка «бэкенд»: если `cfg.backend` -
каталог существует и это git-репозиторий (`.git` на месте, как проверка projectDir рядом).
Нет каталога - ПРЕДУПРЕЖДЕНИЕ, не критическая ошибка (план дословно: «нет каталога -
предупреждение, не критическая ошибка»). Деталь: `fitstars-api4 → ~/Projects/fitstars-api4`.

## Шаг 3. Переменные `backend_dir`/`backend_repo` в промптах

3.1. **Шаблоны** (`src/prompts/actions/`): добавь блок в `analyze.md` и `ci-fix.md` (агент
пишет код/чинит его) + `take-task.md` в flows. НЕ трогай `review.md` (читает дифф MR, не
задачу) и judge-рубрики. Блок короткий, по образцу существующих секций:

```
{{#backend_dir}}
Бэкенд этого проекта: {{backend_dir}} (репозиторий {{backend_repo}}).
Контракт API подтверждай по коду бэкенда: роут → контроллер → Resource/Request → поля и
типы, со ссылкой файл:строка. Сначала прочитай {{backend_dir}}/AGENTS.md. Расхождение
описания задачи с кодом бэкенда называй вслух в отчёте.
{{/backend_dir}}
```

`{{#backend_dir}}`/`{{/backend_dir}}` - секция mustache: без бэкенда блок исчезает.

3.2. **vars во front-matter** этих шаблонов: добавь `backend_dir, backend_repo`.
`checkTemplates()` (гоняется в npm test) сверит соответствие.

3.3. **Код**: в `context(x)` действий `analyze` и `ci-fix` (и `implement`, если фаза 14 уже
сделана - смотри git log) добавь `backend_dir: opts.cfg.backend?.dir ?? ''`,
`backend_repo: opts.cfg.backend?.repo ?? ''`. Пустая строка + секция mustache = блок
скрыт, `prompt_var_missing` не срабатывает (переменная ПЕРЕДАНА, просто пустая).

3.4. flows сами не рендерятся движком (их читает агент в человеко-сессии) - `take-task.md`
просто текстом упоминает backend_dir из конфига: одна строка «если у проекта настроен
backend (fsh config show), контракт подтверждай в нём по flows/backend-check.md».

**Тест: `test/prompts.test.js`** - существующие проверки зелёные; добавь: analyze с
backend в cfg содержит блок, без backend - не содержит (renderTemplate с обоими наборами).

## Шаг 4. Сценарий `src/prompts/flows/backend-check.md`

Front-matter: `description: Подтвердить контракт API по коду бэкенда и получить тестовые
данные`. Тело - протокол двух случаев (PLAN 1572-1575):

1. **Подтвердить контракт**: роут (`routes/`) → контроллер → Resource/FormRequest → поля и
   типы; каждый факт - со ссылкой `файл:строка`; расхождение с текстом задачи называется
   вслух. Scribe/openapi.yaml - только как оглавление, источник - код.
2. **Тестовые данные**: фабрика из `database/factories/` (там ~119 штук); запуск через
   `./artisan-tunnel-dev6.sh tinker`; в БД по умолчанию ТОЛЬКО ЧТЕНИЕ; любая запись -
   с явным подтверждением человека.

Сценарий пишется для агента, читающего его в человеко-сессии или автомате. Команды `fsh`
в теле - только существующие (test/flow.test.js греплит `fsh ([a-z-]+)` и сверяет с
COMMANDS - несуществующая команда уронит тест).

## Шаг 5. `backend_refs` в facts приёмки

5.1. **Промпт**: в `analyze.md` (и `implement.md` фазы 14, если есть) добавь инструкцию:
«Ссылки на бэкенд, которыми подтвердил контракт, запиши в файл
`{{run_dir}}/backend_refs.json` - массив строк `путь:строка`». Переменную `run_dir` действия
уже знают? Нет - добавь в `context(x)`: `run_dir: x.run.dir` (движок кладёт run в x до
рендера - проверь порядок в engine.js: runDir создаётся до context, да, строки ~130-145).

5.2. **verify**: в `actions/analyze.js` verify читает `<run.dir>/backend_refs.json`:
есть и валиден - `facts.backend_refs = массив`; нет - `facts.backend_refs = []` (НЕ ошибка:
«Пусто - не приговор (бывают задачи без API)», PLAN 1577). Битый JSON - не ронять, писать
`backend_refs: []` + warning в say.

5.3. **Судья**: `buildAcceptancePayload` уже выводит все facts списком - `backend_refs`
попадёт автоматом. Проверь глазами на живом ране; если массив длинный - обрежь до 20 строк
в facts (судье хватит).

**Тест: `test/read-actions.test.js`** (там живёт analyze) - verify с файлом
backend_refs.json кладёт массив в facts, без файла - пустой массив, битый - пустой + warning.

## Шаг 6. Бэкенд-only проект

6.1. В свой живой `~/.config/fs-harness/config.json` (НЕ в репозиторий - конфиг личный)
добавь вторую запись `projects["fitstars-api4"]`: repo `fitstars/fitstars-api4`, dir,
targetBranch `dev`, своё `checks` (для Laravel - что реально гоняется: спроси у владельца
или посмотри composer.json/scripts; пустой массив допустим).

6.2. Проверь руками: `fsh -P fitstars-api4 mrs`, `fsh -P fitstars-api4 jira` (если jira
проекту не задана - команда должна падать с понятной config-подсказкой, не сыпать). Движок
не правим: `-P` работает через pickProject без изменений - это и есть проверка.

**Тест: `test/config.test.js`** - два проекта, pickProject по имени бэкенда отдаёт его
конфиг; проект без jira - jira-команда падает с config_invalid (уже покрыто? проверь,
если нет - добавь).

---

# Финальная верификация

```bash
npm test
rm -rf node_modules && npm ci && npm test
node bin/fsh.js doctor                        # знает про каталог бэкенда
node bin/fsh.js -P fitstars-api4 mrs          # работает без правок движка
node bin/fsh.js analyze FD-XXXX --dry-run     # план; промпт собран без prompt_var_missing
```

Живой прогон (прямой критерий): `fsh analyze <FD-задача с API-ручкой>` - в отчёте агента
поля ответа названы со ссылкой на файл в fitstars-api4 (`app/.../Resource.php:42`), а не
пересказаны из описания задачи; `backend_refs.json` лежит в каталоге рана.

# Документация

`AGENTS.md` (секция про backend-связку, `resolveProject`, `backend_refs`), `docs/SPEC.md`
(§M зафиксирован как реализованный: поле конфига, переменные промптов, сценарий),
`PLAN.md` (статус фазы 18: «Сделано» + расхождения, если были). README - по желанию,
фаза внутренняя.
