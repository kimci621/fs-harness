# PLAN-FAZA-16 - Серверный headless-режим (ОТЛОЖЕНА: сначала вопрос владельцу)

Инструкция для AI-агента. Исходная формулировка - PLAN.md, «Фаза 16» (строки 1473-1496).

> **Фаза отложена решением владельца 2026-09-16.** Блокирующий вопрос: чем авторизуется
> `claude` в контейнере. `--bare` читает только `ANTHROPIC_API_KEY` и игнорирует OAuth и
> keychain, а агент и судья `opus-cli` живут по подписке. Варианты: монтировать
> `~/.claude` с хоста ИЛИ завести отдельный API-ключ (новая статья расходов).
>
> **ШАГ 0 - получить решение владельца. Без ответа код не пишется вообще.** Это не
> формальность: от ответа зависят Dockerfile, doctor-проверки и финансовая модель фазы.

Критерий приёмки дословно:

> *Готово, когда:* харнесс в режиме демона и воркеров запускается в Linux-контейнере,
> `doctor` внутри контейнера зелёный, и ни один ран не уходит к судье с молча отвалившимися
> зависимостями.

Зависимости: фазы 11 (демон), 15 (воркеры). От этой фазы они не зависят - порядок строго
после них.

## Жёсткие ограничения

1. Контейнер - ОПЦИОНАЛЬНЫЙ серверный путь, осознанное исключение из ограничения №1
   (зафиксировано в PLAN). Дефолт остаётся `npm ci` + `fsh` на хосте: ни одна проверка,
   тест или команда на macOS-хосте НЕ должна требовать Docker.
2. `rm -rf node_modules && npm ci && npm test` гоняется на ХОСТЕ как раньше, плюс в контейнере.
3. Ошибки - CliError с кодами. Комментарии на русском. Минимальный диф.
4. Глобальные конфиги не трогаем: Dockerfile и compose - файлы репозитория, установка -
   командами человека (`docker build`, `docker compose up`), fsh их печатает/поясняет,
   но не запускает.

## §0. Что прочитать перед началом

- `PLAN.md` 1473-1496 (фаза 16), 44-88 (жёсткие ограничения, таблица внешних программ),
  1648-1655 (п. 7 «чего не делаем» - Docker снят именно этой фазой).
- `src/secrets.js` - лесенка: env (`envNames(name)` = `FS_HARNESS_<NAME>` + алиасы) →
  keychain (`security find-generic-password`, отсутствие бинаря глушится) → файл →
  `.env` бэкенда. В контейнере работает только первая ступень - это уже задумано.
- `src/glab.js` - `createGlab`, `defaultRun`: авторизация целиком на стороне glab CLI
  (keyring хоста). `GITLAB_TOKEN`/`GITLAB_HOST` в коде НИГДЕ не читаются.
- `src/workspace.js` - `provideDeps`: `clone` = `cp -Rc` (APFS clonefile, **macOS-only**);
  провал проглатывается в `deps: {available: false, reason}` - на Linux это молчаливый
  даунгрейд всех проверок.
- `src/commands/doctor.js` - структура `add(name, ok, detail, critical)`; блок `--daemon`
  (158-175); проверки платформы (`process.platform`) сейчас НЕТ.
- `src/commands/watch.js` - `serviceText(cfg, {platform})`: systemd-user unit для Linux
  уже умеет.
- `test/doctor.test.js`, `test/workspace.test.js` - паттерны.

---

## Шаг 1. deps-стратегия по платформе (Linux-совместимость изоляции)

**Файл: `src/workspace.js`.**

1.1. `clone` перестаёт быть синонимом `cp -Rc`. Выбор команды по `process.platform`:
- `darwin`: `cp -Rc <src> <dst>` (как сейчас);
- `linux`: `cp -a --reflink=auto <src> <dst>`;
- прочие: стратегия недоступна, фолбэк `link`.

1.2. **Молчаливый даунгрейд = ошибка.** Сейчас провал `cp` пишется в `deps.reason`, и ран
идёт дальше с ослабленными проверками. На платформе, где выбранная стратегия НЕ сработала
по системной причине (команда упала, а не lock-файл разошёлся), - бросай CliError
(`'deps_strategy_failed'`), ран обязан упасть громко. Расхождение lock-файла остаётся
мягким (`deps_available: false`) - это другое, не путай.

1.3. Конфиг `workspace.deps.strategy` при пустом значении - авто: darwin → clone,
linux → clone (reflink) с фолбэком link, иначе link. Явно заданная стратегия уважается.

**Тест: `test/workspace.test.js`** - выбор команды по платформе (платформу инжектируй
параметром `platform = process.platform`, чтобы тест гонялся на macOS); падение cp →
CliError, а не `available: false`.

## Шаг 2. GitLab без keyring: путь через env

2.1. Проверь факт руками (одна команда, запиши вывод в отчёт фазы):
`GITLAB_TOKEN=<токен> GITLAB_HOST=<host> glab api projects/<repo>` - работает ли glab без
своего `auth login`. glab умеет эти переменные нативно - тогда в `src/glab.js` код почти не
нужен: env просто пробрасывается процессу (execFile наследует env сам). Если glab требует
ещё и отсутствие config.yml - зафиксируй в doctor-подсказке.

2.2. **Файл: `src/glab.js`** - только если замер показал, что надо: добавь в `defaultRun`
явный `env: {...process.env, GITLAB_TOKEN?, GITLAB_HOST?}` (переменные и так наследуются -
код нужен лишь если найдётся реальная дыра). Не пиши код «про запас».

2.3. `doctor` (шаг 3) проверяет этот путь.

## Шаг 3. doctor: платформа и контейнер

**Файл: `src/commands/doctor.js`.**

3.1. Проверка «платформа»: `process.platform`, выбранная deps-стратегия и команда копии;
на darwin - `cp -Rc` доступен (он встроен), на linux - `cp --reflink=auto` (GNU coreutils;
проверка: `cp --help | grep -q reflink`, при отсутствии - критично, если strategy=clone).
Критичность: стратегия clone недоступна И явно задана - критично; авто-фолбэк сработал -
некритичное предупреждение с именем выбранной стратегии.

3.2. Проверка «gitlab env»: если `security` недоступен (Linux-контейнер) - тогда
`GITLAB_TOKEN` + `GITLAB_HOST` в env становятся ОБЯЗАТЕЛЬНЫМИ (критично), иначе
некритично. Плюс живой `glab auth status` как раньше.

3.3. Проверка «не root»: `process.getuid?.() === 0` в контейнере с
`--dangerously-skip-permissions` - см. шаг 4.3: claude отказывается от skip-флага под root.
doctor пишет это критично.

**Тест: `test/doctor.test.js`** - инъекция platform/uid/env (doctor уже собирается через
внутренние параметры - если нет, добавь параметры максимально узко).

## Шаг 4. Dockerfile и compose

**Новые файлы: `Dockerfile`, `docker-compose.yml` (или `compose.yml`) в корне.**

4.1. База `node:22-bookworm-slim` (сверь с engines в package.json). Пакеты: `git` (>= 2.38,
ради merge-tree), `ca-certificates`. glab - скачиванием release-архива с
gitlab.com/gitlab-org/cli/-/releases (пин версии в ARG, checksum рядом в комментарии).
claude - `npm i -g @anthropic-ai/claude-code` (пин версии).

4.2. **Не-root обязателен**, если замер 4.3 это подтвердил: `USER node` (или свой пользователь
с uid 1000), HOME с правами, `npm ci` под ним.

4.3. Замер перед финализацией образа (один живой прогон, вывод - в отчёт):
`docker run --rm <образ> claude --dangerously-skip-permissions --version` под root и под
не-root. Если под root отказ - требование не-root пишется в Dockerfile комментарием и в
doctor (3.3).

4.4. compose: сервис `fsh` - команда `fsh watch --daemon` (+ `fsh worker`, когда фаза 15
закрыта), env: `GITLAB_TOKEN`, `GITLAB_HOST`, `FS_HARNESS_TELEGRAM`, `TELEGRAM_CHAT_ID`,
ключи судей/агентов по шагу 0 (либо `ANTHROPIC_API_KEY`, либо монтирование
`~/.claude:ro` - volumes по выбору владельца, оба варианта закомментированы с пояснением).
Репозитории проектов монтируются volumes (пути из config.json должны совпадать внутри
контейнера - вынеси в `.env` compose с примером).

4.5. README-абзац: сборка, запуск, что дефолт по-прежнему хост.

## Шаг 5. Смоук внутри контейнера

Скрипт не нужен - чеклист в README и в отчёте фазы:
1. `docker compose run --rm fsh doctor` - зелёный (включая gitlab env, платформу, не-root).
2. `docker compose run --rm fsh mrs` - живой список MR.
3. `docker compose run --rm fsh watch --once`-эквивалент (`fsh watch`) - опрос без keychain.
4. Ран действия с worktree: deps-стратегия в логе - не молчаливый `available: false`.

---

# Финальная верификация

```bash
npm test                                     # хост, без Docker
rm -rf node_modules && npm ci && npm test    # хост - дефолтный путь не пострадал
node bin/fsh.js doctor                       # хост: новые проверки некритичны/зелёны
docker build -t fsh .                        # образ собирается
docker compose run --rm fsh doctor           # контейнер: зелёный целиком
docker compose run --rm fsh mrs              # контейнер: API отвечает без keyring
```

Критерий «ни один ран не уходит к судье с молча отвалившимися зависимостями» проверяется
тестом шага 1.2 (падение стратегии = CliError) плюс живым прогоном п. 4 чеклиста.

# Документация

`AGENTS.md` (абзац про контейнерный путь и deps по платформе), `README.md` (секция Docker),
`docs/SPEC.md` (deps-стратегии по платформе, env GitLab), `PLAN.md` (статус фазы, ответ
владельца на вопрос авторизации - дословно, расхождения).
