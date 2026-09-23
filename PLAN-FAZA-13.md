# PLAN-FAZA-13 - Доигрывание рана и двусторонний Telegram-бот

**Статус: сделано** (расхождения с формулировкой — в `PLAN.md`, блок «*Сделано:*» у фазы 13).

Инструкция для AI-агента. Выполняй шаги по порядку, не перескакивай. Каждый шаг закрывается
тестом или командой проверки из его конца. Исходная формулировка фазы - PLAN.md, «Фаза 13»
(строки 1365-1389). Критерий приёмки дословно:

> *Готово, когда:* ран с плохим вердиктом ждёт в `pending_approval`, решение принимается кнопкой
> в Telegram, push происходит из `fsh publish`, а нажатие кнопки чужим аккаунтом не делает ничего.

Оценка: 3+ дня. Две части: 13a (`fsh publish <runId>` + состояние `pending_approval`),
13b (бот). 13a идёт первой - без неё кнопке аппрува нечего вызывать.

## Жёсткие ограничения (действуют на всю фазу)

1. Ноль новых внешних программ и сервисов. Вебхук-сервер не поднимаем - только `getUpdates`
   long-polling (публичного адреса у ноутбука нет, а план фазы 11 вычеркнул HTTP-слушатель совсем).
2. npm-зависимостей новых не нужно: Telegram Bot API - это `fetch` на `https://api.telegram.org`,
   весь транспорт пишется руками с швом `fetchImpl` ради тестов (как `src/notify.js`).
3. Все ошибки - `CliError(msg, exitCode, code)` с машинным кодом. Сырых stack trace нет.
4. Новая команда регистрируется ТОЛЬКО в `src/registry.js` (запись в `COMMANDS`).
5. Тесты - встроенный `node --test`, сеть не используется, `fetch`/`exec` мокаются инъекцией.
6. Комментарии в коде - на русском, короткие, только «что делает».
7. Минимальный диф. Не рефакторить соседнее, не «улучшать» то, что не ломается.

## §0. Что прочитать перед началом (обязательно, целиком)

- `PLAN.md` строки 1365-1389 (фаза 13), 336-410 (§B движок и журнал), 945-973 (§I Telegram).
- `src/engine.js` - целиком. Ключевое: фазы в `go()` (115-186), `accept()` (209-227),
  `gate()` (230-261), `runAgent()` (264-332, `SESSION_ARGS`, `reviseMessage`), `notify()`
  (96-113), `judgeRun` (461-499), первая запись meta.json (150-163), вторая запись в
  `collect()` (196-203, там уже есть `session_id`, `head_sha`, `facts`, `goal`, `extra`).
- `src/agent/journal.js` - целиком: `createRun`, `pruneRuns` (MAX_ARCHIVES=50, без исключений
  по состоянию), `listRuns`, `readRun`, `appendEvent`.
- `src/notify.js` - целиком: `postTelegram({token, chatId}, text, {fetchImpl, signal})`,
  `getTelegramTarget(cfg)`, `runMessage`.
- `src/actions/conflict.js`, `src/actions/ci-fix.js`, `src/actions/threads.js` - только блоки
  `publish(x)`: какие поля `x` они читают (см. §2 ниже).
- `src/workspace.js` - `cleanup(keep)`: `task-worktree` не удаляется никогда, ephemeral -
  `worktree remove --force` + `branch -D`.
- `src/commands/watch.js` - `cmdWatchDaemon` как образец демон-цикла: deps-инъекции
  (`env, loadCfg, sleep, now, cycles, log`), SIGINT/SIGTERM через `wake`, конфиг перечитывается
  каждый цикл.
- `src/registry.js` - структура записи `COMMANDS`, `fromAction`, `createCtx`.
- `src/main.js` - `parseArgs` (куда добавлять флаги), обработка ошибок.
- `src/config.js` - `DEFAULTS.telegram` (сейчас только `chat_id`, `bot_token`), слияние
  `DEFAULTS < v2.telegram < p.telegram` (строка ~206).
- `src/secrets.js` - `readSecret('telegram')`: env `FS_HARNESS_TELEGRAM` / `TELEGRAM_BOT_TOKEN` /
  `TELEGRAM_TOKEN` → keychain. Файлового fallback у telegram нет.
- `test/notify.test.js`, `test/journal.test.js`, `test/queue.test.js` - паттерны моков.

## Известные факты кода (сверено 2026-09-21, не перепроверяй слепо - читай сам)

- `session_id` агента УЖЕ пишется в `meta.json` во второй записи (`collect()`, engine.js:198).
  Пункт плана «session_id пишется в meta.json» - это проверка тестом, а не новый код.
- Точка рассечения для `pending_approval` - между `accept(x)` и `a.publish(x)` (engine.js:174-176).
  Сейчас approve ведёт в publish синхронно, в том же процессе.
- `pruneRuns` прунит всё за пределами keep=50 без разбора состояния - ран, ждущий аппрува,
  сейчас съедается ретеншном.
- В `meta.json` сейчас НЕТ `base_sha` (`ws.baseSha` в workspace.js не существует - известная
  дыра, поле пишется как `undefined` и в JSON не попадает). Фаза 13 чинит это по пути: п. 13a
  требует `base` и `head_sha` для восстановления.
- Восстановить контекст для `publish` из meta.json можно полностью:
  `makeGit(meta.project_dir)` + `dir = meta.worktree` дают `ws.git`/`ws.dir`;
  `target = {iid: meta.mr, source_branch: meta.source_branch, ...}`; `facts = meta.facts`
  (+ `head_sha` с верхнего уровня meta); для ci-fix `pre.failed[].name` = `meta.facts.failed_jobs`,
  `pre.pipeline.id` = `meta.pipeline`.
- `listRuns` выводит состояние по файлам: нет diff.patch - не дошёл до verify; есть diff.patch,
  нет verdict.json - умер на судье; verdict approve без result.json - publish не завершён;
  result.json - done. `pending_approval` станет первым ЯВНЫМ состоянием (`meta.state`).

---

# Часть 13a. `fsh publish <runId>` и состояние `pending_approval`

## Шаг 1. Явное состояние рана в meta.json

**Файл: `src/engine.js`.**

1.1. При первой записи meta.json (блок ~150-163) добавь поле `state: 'running'`.

1.2. В `collect()` (вторая запись, ~196-203) сохраняй `state: 'running'` (не затирать).

1.3. В конце успешного рана (перед `done`) пиши в meta.json `state: 'done'`. При ошибке -
`state: 'failed'`. Делай это через одну маленькую функцию `setRunState(runDir, state)` -
она читает meta.json, дописывает поле, пишет обратно. Раньше такой функции не было -
заведи её в `src/agent/journal.js` и экспортируй (там же живут `readRun`/`appendEvent`).

1.4. Заодно почини дыру с `base_sha`: в `src/workspace.js` `acquireWorkspace` после создания
worktree (или при `checkout`) сними `git rev-parse <base>` и верни поле `baseSha` в объекте
workspace. Тогда `meta.base_sha` начнёт реально писаться (оно уже есть в первой записи
meta.json, просто `undefined`). Одна строка в workspace.js, ноль в engine.js.

**Тест: `test/journal.test.js`** - дополни: `setRunState` пишет и переписывает `state`.
**Тест: `test/workspace.test.js`** - `baseSha` присутствует и равен sha базового ref
(там уже есть настоящий git-репозиторий в mkdtemp - пользуйся тем же паттерном).

## Шаг 2. Режим интерактивного гейта (остановка вместо publish)

**Файл: `src/config.js`.** В `DEFAULTS.telegram` добавь `allowed_user_ids: []` и
`approvals: false`. Слияние уже есть (`DEFAULTS < v2.telegram < p.telegram`), ничего не пиши.

**Файл: `src/engine.js`.**

2.1. После `accept(x)` (где сейчас сразу `publish`) вставь ветку:

```
интерактив = spec.action.writes
  && gate === 'pre-push'
  && cfg.telegram?.approvals === true
  && getTelegramTarget(cfg) !== null
  && !opts.noJudge
```

`getTelegramTarget` импортируй из `notify.js` (уже экспортируется).

2.2. Если интерактив и есть хоть какой-то вердикт (approve или нет - решение за человеком,
кнопки показываются на ЛЮБОМ вердикте гейта pre-push; план говорит «ран с плохим вердиктом
ждёт», но дешевле и честнее остановиться на любом - человек видит вердикт в сообщении):

- сгенерируй `nonce = randomUUID()` (node:crypto);
- запиши в meta.json: `state: 'pending_approval'`,
  `approval: {nonce, issued_at: new Date().toISOString(), run: runDir.id, action: spec.name}`;
- отправь в Telegram сообщение с вердиктом и inline-кнопками (шаг 8, функция бота
  `sendApprovalRequest`) - здесь, в engine, вызывай её через `opts.approvalSink`, чтобы движок
  не знал про Telegram: `await opts.approvalSink?.({cfg, run: runDir.id, meta, verdict, nonce,
  fetchImpl: opts.fetchImpl, say})`. В CLI `runActionCLI` подставит реализацию из `src/tgbot.js`;
  без неё (MCP, тесты) - просто `say('Ожидает аппрува: fsh publish ' + runDir.id)`;
- заверши ран НЕ падая: `ws.cleanup(keep)` с `keep = true` (worktree обязан остаться),
  финальное событие `{t:'done', ok: true, result: {ok: true, pending_approval: true, run: id,
  mr: meta.mr, verdict: <кратко>}}`. `result.json` НЕ пиши - иначе `listRuns` покажет done.
- `notify(ok, err)` в этом случае НЕ зови - сообщение с кнопками и есть уведомление,
  дубль не нужен.

2.3. Поведение по умолчанию (`approvals: false`) не меняется НИ на бит: approve → publish
в том же процессе. Это регрессионный тест.

**Тест: `test/engine-approval.test.js` (новый)** - мок-действие с `writes: true`,
`judge: {gate: 'pre-push'}`, мок-провайдер судьи (паттерн из `test/gate.test.js`), cfg с
`telegram.approvals: true` + фейковый `approvalSink`. Проверь: publish НЕ вызван, meta.json
имеет `state: 'pending_approval'` и `approval.nonce`, worktree сохранён, result с
`pending_approval: true`. Второй тест: `approvals: false` - publish вызван, state `done`.

## Шаг 3. Раны в pending_approval не прунятся; TTL сутки

**Файл: `src/agent/journal.js`.**

3.1. `pruneRuns({root, keep})`: перед удалением каталога читай его meta.json (она уже читается
для сортировки) и ПРОПУСКАЙ каталоги с `meta.state === 'pending_approval'`.

3.2. Новая функция `sweepExpiredApprovals({root, now = Date.now(), ttlMs = 24*3600*1000,
onExpired})`: находит раны с `state === 'pending_approval'` и `approval.issued_at` старше TTL.
Для каждого: пишет `state: 'expired'` в meta.json, вызывает `onExpired?.(run)` (там уборка
worktree и отказ по кнопке - см. шаг 5), возвращает список id истёкших.

3.3. Вызов `sweepExpiredApprovals` встрой в два места: начало `fsh publish` (шаг 4, перед
обработкой любого runId) и цикл демона бота (шаг 9) - одна строка в каждом.

**Тест: `test/journal.test.js`** - ран с `pending_approval` переживает prune при keep=0;
`sweepExpiredApprovals` гасит просроченный и не трогает свежий (управляй `now` и
`issued_at` руками).

## Шаг 4. Команда `fsh publish <runId>`

**Новый файл: `src/publish.js`** (логика, чистая от CLI):

```
publishRun(runId, {cfg, g, exec?, fetchImpl, say, emit, yes}) 
```

Порядок обязателен:

4.1. `readRun(runId)` из journal.js. Нет - CliError `run_not_found` (уже есть).

4.2. `sweepExpiredApprovals` (шаг 3.3). Если runId сам истёк - CliError
('Аппрув протух (TTL сутки). Worktree убран. Перезапусти действие.', 1, 'approval_expired').

4.3. Проверки допуска, каждая со своим кодом:
- `meta.state === 'pending_approval'` - иначе CliError(..., 'run_not_pending') с текстом
  текущего состояния («ран уже завершён» / «ран упал, смотри verdict.json»);
- `verdict.json` существует и `decision === 'approve'` - иначе 'run_not_approved'
  (кнопка Approve шлёт только approve, но человек мог позвать руками);
- нет `result.json` - иначе 'already_published';
- каталог `meta.worktree` существует - иначе 'worktree_gone' («worktree удалён, ран не
  доиграть, перезапусти действие»).

4.4. Перепроверка фактов (план: «перепроверяет `git rev-parse HEAD === meta.head_sha` и
`ls-remote` цели - и только потом зовёт `action.publish`»):
- `git -C <meta.worktree> rev-parse HEAD` === `meta.head_sha` - иначе 'worktree_moved'
  («в worktree кто-то коммитил после рана»);
- `git -C <meta.project_dir> ls-remote origin <meta.source_branch>` - удалённый sha НЕ равен
  `meta.head_sha` (иначе уже запушено - 'already_published'), а если ветка уехала ВПЕРЁД от
  `meta.base_sha` - предупреждение в say, но не отказ (publish сам проверит push);
- если `meta.action === 'conflict'`: `git merge-tree` заново на worktree - конфликт вернулся
  (target уехал) - 'conflict_reappeared' («пока ран ждал, target уехал: перезапусти conflict»).

4.5. Восстановление суррогатного `x` и вызов publish. Найди действие по `meta.action` в
`ACTIONS` реестра (registry экспортирует `ACTIONS`). Собери минимальный контекст, который
реально читают publish-блоки (сверено по трём действиям):

```
x = {
  ctx: {g, cfg, repo: meta.repo, ...createCtx-подобное},
  opts: {cfg, yes: true, json: true, quiet: false, fetchImpl},
  target: {iid: meta.mr, source_branch: meta.source_branch, target_branch: meta.target_branch,
           title: meta.mr_title ?? ''},
  pre: {failed: (meta.facts.failed_jobs ?? []).map(name => ({name})), pipeline: {id: meta.pipeline}},
  ws: {git: makeGit(meta.project_dir), dir: meta.worktree, branch: meta.branch,
       base: meta.base, created: false, cleanup: (keep) => keep ? null : removeWorktree(...)},
  facts: {...meta.facts, head_sha: meta.head_sha},
  run: {id: runId, dir: runDir},
  say, emit: emit ?? (() => {}), signal: AbortSignal.none
}
```

`makeGit` экспортируется из `src/workspace.js`. Для `cleanup` переиспользуй логику из
workspace.js (вынеси `removeWorktree(projectDir, dir, branch)` в экспорт, workspace.js ею же
пользуется сам - не дублируй команды git).

Вызови `action.publish(x)`. Любая ошибка publish (not_pushed, build_failed, ci_still_failing) -
пробросить как есть, state оставить `pending_approval` (человек может повторить).

4.6. Успех: запиши `result.json` (формат как у движка: `{ok: true, ...published}`), поставь
`state: 'done'`, событие `{t:'done'}` в events.jsonl, убери worktree через `x.ws.cleanup(false)`,
верни `{ok: true, run: runId, ...published}`. Уведомление в Telegram - обычным `runMessage`
(без кнопок), если target настроен.

**Новый файл: `src/commands/publish.js`** - обёртка: `cmdPublish(ctx, args, opts)`;
`args[0]` обязателен (иначе CliError usage с примером); поддержи `asObject` и `--json`;
`--dry-run` печатает проверки 4.3-4.4 без вызова publish.

**`src/registry.js`**: запись `publish` в `COMMANDS` (run → `withRepoHost`, mcp - НЕ
экспортируем: MCP зовёт с `yes: true`, а publish это запись по решению человека; тот же
принцип, что у `mm`).

**`src/main.js`**: ничего (команда без новых флагов; `--dry-run` уже есть).

**Тест: `test/publish.test.js` (новый)** - настоящий git-репозиторий в mkdtemp + bare origin
(паттерн `test/task.test.js`): собери ран вручную (каталог с meta.json, verdict.json approve,
worktree = второй клон/чекаут с коммитом). Мок `g` (getMR, ensureMRPipeline, getJobs, playJob,
retryJob). Проверь: publish проходит и пушит; HEAD не совпал - `worktree_moved`; нет
verdict - `run_not_approved`; повторный вызов - `already_published`.

## Шаг 5. Команда `fsh revise <runId>` (доделка в той же сессии)

Без неё кнопка [Revise] некуда ведёт. План прямо требует: «иначе [Revise] начнёт работу
заново вместо доделки в той же сессии».

**Файл: `src/publish.js`** (тот же модуль, вторая функция):

5.1. `reviseRun(runId, {message, cfg, g, ...})`: те же проверки 4.2-4.3, кроме вердикта -
нужен ЛЮБОЙ verdict.json (revise имеет смысл и после approve, если человек хочет правки).
`meta.session_id` обязателен - иначе CliError 'no_session' («ран старый, сессии нет;
перезапусти действие»). Семейство агента из `meta.agent` через `resolveAgent(cfg, meta.agent)`
- `SESSION_ARGS[family]` обязан существовать (claude/pi/agy есть; иначе 'no_session').

5.2. Восстанови `ws` как в 4.5. Собери текст доделки: `reviseMessage(verdict)` уже есть в
engine.js - вытащи его в экспорт (он чистая функция, ~10 строк) и переиспользуй; если передан
`message` (от человека из бота) - добавь его строкой в конец.

5.3. Запусти агента в `meta.worktree` с resume-аргументами: не копируй `runAgent` целиком -
вызывай `runAction` не получится (он с нуля). Поэтому в engine.js выдели внутреннюю
`spawnSession(x, promptText, {resume})` (сегодняшнее тело runAgent без сборки промпта) и
экспортируй. Это единственный рефактор engine.js в этой части - держи его маленьким.

5.4. После агента: `collect`-эквивалент (пересними facts через `action.verify(x)` - она чистая,
живая в декларации), запиши meta (новый `head_sha`), снова `gate(x)` (судья, та же роль),
новый вердикт перезаписывает verdict.json. Дальше по режиму: `approvals: true` - снова
`pending_approval` с НОВЫМ nonce (старый сгорает) и новым сообщением с кнопками; иначе -
publish как обычно.

**Тест: `test/publish.test.js`** - reviseRun с мок-спавном: агенту ушли resume-аргументы
(`--resume <session_id>` для claude), после вердикта approve при approvals:true ран снова
в `pending_approval` с новым nonce.

## Шаг 6. Проверка «session_id в meta.json» (пункт плана, уже сделан)

`engine.js:198` уже пишет `session_id`. Добавь в `test/e2e-actions.test.js` (или gate.test.js)
ассерт: после рана meta.json содержит непустой `session_id` для профиля claude-семейства.
Для agy session_id приходит из потока (`init → conversation_id`) - если мок-поток его отдаёт,
тоже ассерт. Этим пункт плана закрыт.

---

# Часть 13b. Двусторонний Telegram-бот

## Шаг 7. Транспорт Bot API

**Новый файл: `src/tgbot.js`.** Всё с `fetchImpl = fetch` в параметрах (шов ради тестов).
Никаких новых зависимостей. Базовый вызов:

```
tgCall(token, method, body, {fetchImpl, signal}) 
  → POST https://api.telegram.org/bot<token>/<method>, JSON body
  → !res.ok или !json.ok → CliError(`Telegram ${method}: <description>`, 1, 'telegram_failed')
  → return json.result
```

Функции:
- `getUpdates(token, {offset, timeout = 25, fetchImpl, signal})` - long-polling;
- `sendButtons(token, chatId, text, buttons, {fetchImpl, signal})` - sendMessage с
  `reply_markup: {inline_keyboard: buttons}`; `buttons` - массив рядов
  `[{text, callback_data}]`. В `notify.js` НЕ лезь: postTelegram остаётся как был, бот - новый
  модуль (notify.js трогаешь только если понадобится общий `getTelegramTarget` - он уже
  экспортируется);
- `answerCallbackQuery(token, id, {text, fetchImpl, signal})`;
- `editMessageReplyMarkup(token, chatId, messageId, {reply_markup: null, fetchImpl})` -
  снять кнопки после нажатия, чтобы старая кнопка визуально умерла;
- `sendApprovalRequest({cfg, run, meta, verdict, nonce, fetchImpl, say})` - та самая
  `approvalSink` из шага 2.2: текст = `runMessage`-подобная строка (действие, MR, вердикт,
  уверенность, цена) + первая строка findings; кнопки:
  `[Approve & Push] → callback_data: "appr:<runId>:<nonce>"`,
  `[Revise] → "rev:<runId>:<nonce>"`, `[Reject] → "rej:<runId>:<nonce>"`.
  Лимит callback_data 64 байта - runId у нас `<action>-<base36>-<rand4>` (~20 символов),
  влезает. После sendMessage допиши в meta.json `approval.chat_id` и `approval.message_id`
  (нужны для снятия кнопок).

**Тест: `test/tgbot.test.js` (новый)** - мок fetchImpl, очередь ответов; проверь тела
запросов (offset, reply_markup JSON), ошибку `telegram_failed` на `{ok:false, description}`,
64-байтный лимит callback_data (ассерт `callback_data.length <= 64`).

## Шаг 8. Allowlist и разбор updates

**Файл: `src/tgbot.js` (продолжение).**

8.1. `isAllowed(cfg, id)`: `cfg.telegram.allowed_user_ids` (массив чисел) включает `id`.
Пустой массив - НИКТО не допущен (безопасный дефолт; бот без allowlist вообще не стартует,
см. шаг 9).

8.2. `handleUpdate(u, deps)` - чистая функция разбора:
- `u.message` с `text` начинающимся с `/` - команда: верни `{kind: 'command', name, args,
  chatId, fromId}`; `fromId` не в allowlist - верни `{kind: 'ignored'}` (молча: никаких
  ответов чужим, план: «чужие игнорируются молча»);
- `u.callback_query`: разбери `data` по `:` в `{cmd, runId, nonce}`; from не в allowlist -
  `{kind: 'ignored'}`; иначе `{kind: 'callback', cmd, runId, nonce, chatId, messageId,
  callbackId, fromId}`;
- всё прочее - `{kind: 'ignored'}`.

**Тест:** чужой `from.id` на команде и на кнопке - `ignored`, ни одного fetch-вызова наружу.

## Шаг 9. Демон бота: команда `fsh bot`

**Новый файл: `src/commands/bot.js`.** Образец - `cmdWatchDaemon` из `src/commands/watch.js`:
те же deps-инъекции (`env, loadCfg, fetchImpl, sleep, now, cycles, log`), SIGINT/SIGTERM через
будильник, конфиг перечитывается каждый цикл (allowlist и approvals работают на ходу).

9.1. Старт: `getTelegramTarget(cfg)` - нет токена/chat_id: CliError('Заведи telegram.bot_token
и telegram.chat_id...', 1, 'config_invalid'). `allowed_user_ids` пуст - CliError с подсказкой
(«бот без allowlist не стартует: telegram.allowed_user_ids: [<твой id>]», код
'config_invalid'). Твой id человек узнаёт у @userinfobot - напиши это в тексте ошибки.

9.2. Хранение offset: `~/.local/state/fs-harness/tgbot.json`, `{offset}`. Чтение/запись -
две функции в `src/tgbot.js` (`loadBotState(root)`, `saveBotState(root, state)`), root
инжектируется ради тестов. При старте: `getUpdates` БЕЗ offset с `timeout: 0` и взять
`max(update_id)+1` - старые апдейты, накопленные пока бот был выключен, проглатываем один раз
(иначе на первом старте прилетит год спама и, хуже, СТАРЫЕ кнопки).

9.3. Цикл: `getUpdates(offset, timeout: 25)` → каждый update через `handleUpdate` →
`saveBotState({offset: update_id + 1})` СРАЗУ после обработки каждого (не батчем в конце:
упали посреди - переиграем только один). Сетевые ошибки getUpdates - warning в лог и повтор
через 5с, демон не падает (как упавший опрос проекта в watch-демоне).

9.4. Команды (все ответы - через `tgCall sendMessage` в тот же chat_id):
- `/mrs` - `cmdMRS(ctx, [], {asObject: true})`, ответ - до 10 строк `!iid title (статус
  пайплайна)`, пусто - «открытых MR нет»;
- `/watch` - `cmdWatch(ctx, {asObject: true})`, ответ - `kept`-события или «тихо»;
- `/status` - `listRuns({limit: 5})` + `listJobs()` очереди + число ранов в
  `pending_approval`;
- `/run <action> <target>` - только действия из `ACTIONS` с `target !== 'none'`, вызов через
  `runActionCLI`-путь с `yes: true`, `json: true` (без TTY confirm бы ответил «нет» - это же
  требование SPEC к воркерам); ответ в чат по событию done/error. Незнакомое действие -
  список доступных. НЕ запускать, если действие `writes` и у cfg нет `telegram.approvals`...
  нет, наоборот: запускать можно, гейт сам остановит в pending_approval, если approvals
  включён; выключен - publish случится синхронно, человек сам вызвал /run, его присутствие и
  есть гейт. Зафиксируй это поведение в description команды.
- любое другое - короткий help.

9.5. Callback-кнопки:
- `appr:<runId>:<nonce>`: сверь nonce с `meta.approval.nonce` и state `pending_approval`.
  Не совпал/не тот state - `answerCallbackQuery('Устарело или уже обработано')` и сними
  кнопки. Совпал - обнули nonce в meta (ОДНОРАЗОВОСТЬ до начала работы, а не после: упали
  посреди publish - кнопка уже мертва), `answerCallbackQuery('Публикую…')`, `publishRun`
  (шаг 4), по итогу `editMessageReplyMarkup(null)` + новое сообщение с результатом.
- `rej:<runId>:<nonce>`: та же сверка, state → 'rejected', уборка worktree
  (`removeWorktree`), answerCallbackQuery('Отклонено'), снять кнопки.
- `rev:<runId>:<nonce>`: сверка, `answerCallbackQuery('Отправил на доделку')`,
  `reviseRun` (шаг 5) - он вернёт ран в pending_approval с новым сообщением и новыми
  кнопками; у старого сообщения сними кнопки.
- Каждый запуск publish/revise - длинный; крути его в фоне цикла (Promise без await внутри
  обработчика, ошибки лови и шли в чат), чтобы long-polling не стоял.

9.6. В цикл же встрой `sweepExpiredApprovals` раз в итерацию (шаг 3.3): истёкшие -
`onExpired` шлёт в чат «Аппрув рана X протух, worktree убран».

**`src/registry.js`**: запись `bot` (без mcp-экспорта).
**`src/main.js`**: ничего.

**Тест: `test/bot.test.js` (новый)** - демон с `cycles: 2`, мок fetchImpl с очередью
getUpdates-ответов: команда `/mrs` от чужого - ноль исходящих вызовов; `/mrs` от своего -
один sendMessage; нажатие `appr` с протухшим nonce - answerCallbackQuery «Устарело» и НИ
одного вызова publish (мок-publishRun не позван); нажатие с верным nonce - publishRun позван
ровно один раз, повторное нажатие тем же nonce - «Устарело».

## Шаг 10. doctor

**`src/commands/doctor.js`**: в некритичные добавь «telegram bot»: если `telegram.approvals`
или задан `allowed_user_ids` - проверь, что allowlist непуст (иначе критично при
approvals:true: раны встанут в pending_approval, а нажать кнопку никто не сможет). В блок
`--daemon` добавь секрет бота рядом с существующим `daemonSecretIssues` - telegram там уже
есть, убедись, что покрыт и для `fsh bot` (тот же env-вариант).

**Тест: `test/doctor.test.js`** если есть паттерн - иначе прогон руками в финале.

## Шаг 11. Документация и статус фазы

1. `AGENTS.md` - карта файлов: `src/tgbot.js`, `src/publish.js`, `src/commands/bot.js`,
   `src/commands/publish.js`; в раздел «Мастер»/уведомления - одна строка про approvals.
2. `docs/SPEC.md` - абзац про `pending_approval`, TTL аппрува и формат `callback_data`.
3. `PLAN.md` - фаза 13: «**Сделано.**» + блок «*Сделано:*» и, если были, «расхождения с
   формулировкой, внесённые при реализации» (по примеру фаз 11-12).
4. `README.md` - таблица команд: `publish`, `revise` (если вынес отдельной командой), `bot`.

---

# Финальная верификация (обязательно вся, по порядку)

```bash
npm test                                # все тесты зелёные
rm -rf node_modules && npm ci && npm test   # проверка ограничения №1
node bin/fsh.js help                    # publish и bot в справке
node bin/fsh.js agent-guide | grep -c publish   # команда видна агентам
node bin/fsh.js doctor                  # зелёный, новый пункт telegram bot
node bin/fsh.js publish                 # usage-ошибка с примером, exit 1
```

Живой прогон (только с разрешения человека, на тестовом MR):
1. Включить `telegram.approvals: true` и свой id в `allowed_user_ids`.
2. `fsh bot` - демон стартует, `/status` из чужого аккаунта молчит, из своего - отвечает.
3. `fsh conflict <mr>` на MR с конфликтом - ран встаёт в `pending_approval`, в Telegram
   пришли кнопки.
4. Нажать [Reject] чужим аккаунтом - ничего не происходит (прямой критерий плана).
5. Нажать [Approve & Push] своим - push случился, кнопки умерли, повторное нажатие -
   «Устарело».
6. `fsh publish <runId>` руками на уже опубликованном - `already_published`.

Отчёт в конце: список изменённых файлов, расхождения с PLAN.md (если были), вывод финальной
верификации.
