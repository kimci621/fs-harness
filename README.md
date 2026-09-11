# FS-Harness

Персональный харнесс разработчика. Сейчас это `fsh` — CLI-обёртка над [`glab`](https://gitlab.com/gitlab-org/cli) для повседневной работы с merge request'ами и пайплайнами GitLab: детерминированный вывод, режим `--json`, понятные ошибки, живой прогресс. Ей одинаково удобно пользуются люди и AI-агенты.

Куда растёт — в [PLAN.md](PLAN.md): движок «действие → контекстный промпт → запуск агента → проверка судьёй», TUI, Jira.

Зависимости ставятся через `npm ci`; из внешних программ нужны только `node` (≥22), `glab`, `git`.

## Установка

```bash
git clone https://github.com/kimci621/fs-harness.git ~/Projects/FS-Harness
cd ~/Projects/FS-Harness
npm ci            # зависимости
npm link          # ставит `fsh` в PATH
npm test          # 45 тестов, сеть не нужна
```

`glab` должен быть залогинен на нужный GitLab-хост:

```bash
glab auth login --hostname ваш.gitlab.example.com
```

## Настройка

```bash
fsh config init    # создаст ~/.config/gl-helper/config.json
fsh config show
```

```json
{
  "repo": "ваш-неймспейс/ваш-проект",
  "host": "ваш.gitlab.example.com",
  "projectDir": "~/Projects/ваш-проект",
  "agent": "claude",
  "agentArgs": { "claude": ["--dangerously-skip-permissions"], "pi": [] }
}
```

- `repo` — дефолтный репозиторий (можно перебить флагом `-R` или env `GL_HELPER_REPO`).
- `host` — **важно**: glab сам выбирает хост по git remote текущей директории. `fsh` всегда передаёт `--hostname` из конфига, чтобы команда работала из любой директории. Перебивается флагом `--host` или env `GL_HELPER_HOST`.
- `projectDir` — проект, в котором `conflict` создаёт временный worktree.
- `agent` / `agentArgs` — какой агент решает конфликты и с какими флагами (`claude` или `pi`, headless `-p`).

## Команды

| Команда | Что делает |
|---|---|
| `mrs` | Все открытые MR: название, ветки `from→to`, статус пайплайна, комменты (всего / открытых тредов / решённых), конфликт ✅/⚠ |
| `mr <ветка\|номер>` | Один MR в том же формате. Ветку можно вводить частично и с ошибками — `mr banner-fl` найдёт `fix/main-banner-flicker`. Принимает `!2547` и `2547` |
| `conflict <mr\|ветка>` | Решает конфликт силами AI-агента в отдельном worktree, пушит в ветку MR и сам запускает build (подробнее ниже) |
| `jobs <mr\|ветка>` | Джобы последнего MR-пайплайна: stage, имя, статус, id |
| `mr-comments <mr\|ветка>` | Комментарии MR по тредам: `--resolved` — только решённые, `-open` — только нерешённые |
| `run <джоба> <mr\|ветка>` | Запустить manual-джобу по имени или id. С `-w` — ждать завершения |
| `deploy <ветка\|mr> [N]` | build → ждать ✅ → запустить `deploy_dev` (или `deploy_dev2`…`deploy_dev10`) → ждать итог. С `--rebuild` — перезапускает build и deploy даже при success (когда кто-то перезаписал слот своим MR) |
| `commit` | Агент формирует сообщение коммита по паттерну и коммитит все изменения (без push). Паттерн — встроенный или из `.llm-commit-pattern` проекта |
| `doctor` | Самодиагностика: glab, конфиг, доступ к API, git-репозиторий, агенты |
| `agent-guide` | Полная инструкция для AI-агента: команды, флаги, env, JSON-схемы, коды ошибок |
| `mcp` | MCP-сервер (stdio): те же команды как типизированные инструменты для AI-клиентов |
| `config init\|show` | Конфиг |
| `help` | Справка |

Флаги: `-R/--repo`, `--host`, `--json` (read-команды), `--agent claude|pi`, `--project-dir`, `-B/--build-job` (дефолт `build_image`), `-w/--watch`, `-y/--yes`, `--keep-worktree`, `--rebuild` (deploy), `--dry-run` (run/deploy/conflict/commit — план без запусков).

Примеры:

```bash
fsh mrs
fsh mr special-offer
fsh jobs fix/main-banner
fsh mr-comments fix/main-banner -open
fsh run build_image fix/main-banner -w
fsh deploy feat/premium-banner 3      # deploy_dev3
fsh deploy feat/premium-banner 2 --rebuild  # перезаписать слот dev2 своим кодом
fsh commit --agent pi
fsh conflict !2547 --agent pi
fsh -R other/repo mrs --json          # JSON для агентов/скриптов
```

## Команда conflict

1. Проверяет `has_conflicts`; нет конфликта — сообщает и выходит.
2. `git fetch` обеих веток, создаёт временный worktree `$projectDir/.worktrees/gl-helper-<iid>-<ts>` от `origin/<source-ветки>`.
3. Запускает агента (`claude` или `pi`, неинтерактивно) внутри worktree с промптом: сделать `git merge origin/<target>`, решить конфликты вручную, сохранив логику **обеих** веток (приоритет равный), запрещены «взять всё ours/theirs» и force-push, прогнать линт/тесты, закоммитить по стилю проекта, запушить `git push origin HEAD:<source>`.
4. Проверяет, что коммиты созданы и запушены. Если агент не запушил — worktree **сохраняется** (с инструкцией), чтобы ничего не потерять.
5. Пайплайн build жмёт сам fsh: актуальный MR-пайплайн → джоба `build_image` → ожидание со спиннером и живым статусом → итог.
6. В любом случае убирает за собой: worktree, временная ветка. `--keep-worktree` отключает очистку.

Перед запуском спрашивает подтверждение (отключить — `-y`).

## Команда commit

Агент (`claude` или `pi`) смотрит `git status`/`git diff`, формулирует сообщение коммита по паттерну и выполняет `git add -A && git commit`. Push не делает.

**Встроенный паттерн** (файл `src/prompts/commit.md`):

```
<имя текущей ветки> <тип>(<область>): <описание>
feature/FD-5466 refactor(components): убрал дублирование логики
```

Префикс — имя ветки ровно как есть (1в1). Тип: feat/fix/refactor/chore/style/perf/test/docs/ci. Область — компонент/модуль/директория. Описание — что сделано.

**Свой паттерн на проект**: положи файл `.llm-commit-pattern` в корень репозитория — его содержимое полностью заменит встроенный промпт (инструкция «изучи изменения и закоммить» добавляется автоматически).

```bash
fsh commit --agent pi      # в текущей директории
gh commit -y                     # без подтверждения
```

## Режим агента

```bash
export GL_HELPER_JSON=1   # JSON-вывод и структурированные ошибки
export GL_HELPER_YES=1    # не спрашивать подтверждение (как -y)
```

- `--json` на read-командах — данные; на side-effect (`run`, `deploy`, `conflict`, `commit`) — **финальный результат** в stdout, прогресс в stderr.
- Ошибки при `--json`: `{"ok":false,"error":{"code","message"}}` + exit code ≠ 0. Коды: `usage`, `api_failed`, `mr_not_found`, `mr_ambiguous`, `job_not_found`, `job_failed`, `build_failed`, `deploy_failed`, `agent_failed`, `not_pushed`, `no_commit`, `git_failed`, `config_invalid`, `canceled`.
- Полная инструкция для агента встроена в CLI: `fsh agent-guide`.
- Перед side-effect командами можно смотреть план: `--dry-run`.
- Для нативного вызова инструментов из AI-клиентов: `fsh mcp` (см. раздел MCP-режим).

## MCP-режим

`fsh mcp` — stdio MCP-сервер: те же команды как типизированные инструменты. Агент вызывает их нативно, без shell и парсинга: аргументы валидируются JSON-Schema, результат — структурированный JSON, ожидание джоб — внутри сервера.

**Инструменты:** `mrs`, `mr`, `mr-comments`, `jobs` (только чтение) и `run`, `deploy`, `conflict`, `commit` (меняют состояние; клиент спрашивает разрешение), плюс `doctor`, `agent_guide`.

**Подключение:**

```bash
# Claude Code (проект или user scope)
claude mcp add fs-harness -- fsh mcp
# .mcp.json в проекте:
# { "mcpServers": { "fs-harness": { "command": "fsh", "args": ["mcp"] } } }
```

pi не имеет встроенного MCP (осознанный дизайн) — там fsh используется через CLI/`--json` или MCP-адаптеры-расширения (pi-mcp-adapter).

CLI при этом никуда не девается: человеку — таблицы и спиннеры, агентам — MCP или `--json`.

## Вывод

- Человекочитаемый: таблицы с выравниванием, статусы с иконками (✅ ⏸ ❌ 🚫 🔵), ⚠ у устаревшего пайплайна (sha не совпадает с HEAD ветки), относительное время.
- `--json`: стабильные поля для агентов и скриптов (см. примеры в AGENTS.md).
- Прогресс (спиннер, живые таблицы джоб) пишется в stderr — stdout можно смело парсить.

## Известные грабли

- **404 Project Not Found внезапно**: glab определяет хост по git remote текущей директории. fsh лечится передачей `--hostname` (из конфига) и ретраями. Если сам пользуешься glab вручную — запускай его из директории проекта или передавай `--hostname`.
- **Флапающий GitLab API**: каждый GET повторяется до 5 раз с экспоненциальным бэкоффом (1/2/4/8с), о повторах пишется в stderr.
- **Медленный `mrs`**: статусы пайплайнов берутся одним запросом всех MR-пайплайнов, треды комментов — параллельно с ограничением 6.

## Разработка

```bash
npm test                # node --test, мокнутый glab — без сети
node bin/fsh.js mrs   # запуск без npm link
```

Детали архитектуры и инструкции для AI-агентов — в [AGENTS.md](AGENTS.md).
