# Средние задачи (medium)

Агент: `sonnet-xhigh` (фолбэк `agy-high`).

Критерий роутера (`TIER_CRITERIA.medium` в `src/tier.js`):

> Обычная фича или баг с понятной причиной: взять задачу Jira в работу, добавить фильтр, поле или кнопку в UI, починить упавшие тесты, разобрать треды ревью, выяснить почему не сработала команда или скрипт, вычистить устаревшие доки, конфликт слияния вне оплат, настроить конфиг или переменные окружения, подключить событие аналитики по готовому контракту, ревью MR на чтение. Надо прочитать код и повторить существующий паттерн, но архитектуру выбирать не надо.

Разметка: 243 промптов из 472 уникальных за историю Claude Code по fitstars-frontend и FS-Harness. Медиана вызовов инструментов на ход: 12.

## Примеры

Текст промпта обрезан до 220 символов, после тире — почему такой уровень.

- не хватает редактирования описания в задачах (напоминаю фильтры и поля должны быть доступны все к редактированию что в jira что в gitlab) — _add description editing feature to tasks_
- возьми в работу задачу 7719 — _take ticket for landing analytics into work_
- https://www.figma.com/design/Vj684HtedIPJuJJFV9U5m3/Money-s-place?node-id=1843-13941&m=dev — _implement design from Figma link_
- очень часто кажется что зависает, надо добавить видимость состояния загрузки на все асинхронные действия — _add loading indicators across async actions_
- https://fitstars.gitlab.yandexcloud.net/fitstars/fitstars-nuxt/-/merge_requests/2755 надо решить конфликт, смерджить dev, запушить — _resolve merge conflict, push_
- первый продукт надо делать в web. Так как бэкенд для всех один и на основе web сделать приложение будет не сложно — _platform decision, update plan accordingly_
- почисти сирот в .claude/docs и пересобери снимок knowledge, code-quality-pragmatist/MEMORY.md надо тоже почистить от лишенго. Так же надо написать в AGENTS.md чтобы он полностью ссылался на CLAUDE.md и не писал ничего са — _cleanup orphan docs and rewrite AGENTS.md_
- перепроверь еще раз (важно учитывать бизнесс логику и точно понять что именно чинит этот mr) и оставь замечания — _deeper review considering business logic correctness_
- ## Задача, которую решал агент FD-7849: FE: Кнопка «Оплатить 990₽» на лендинге Премиума у пользователя с премиумом скроллит к "Оплатить сейчас" вместо мгновенной оплаты h3. Описание *Для премиум пользователя*, на лендинг — _known-behavior payment button bug fix_
- сделай mr review и сравни с поставленной задачей — _MR review against task requirements_
- Healtix идет как медецинское изделие? — _research competitor regulatory classification_
- забери коменты с merge request с помощью glab https://fitstars.gitlab.yandexcloud.net/fitstars/fitstars-nuxt/-/merge_requests/2416 проверь их на корректность и где действительно по делу почини — _fetch and address MR review comments_
- теперь дай мне список файлов и инструкцию для маркетолога чтобы он сленерировал лендинг и отправил его на бэкенд — _compile file list and instructions for marketer_
- ## Задача, которую решал агент FD-7732: FE. Не собирать события Roistat на страницах блога и рецептов Сейчас счётчик Roistat подключается на всех страницах сайта, включая блог и рецепты. Это неконверсионный контентный тр — _route-guarded analytics feature implementation_
- смерджи dev в ветку, там есть конфликты — _merge dev with conflicts_
- Теперь еще и dev2.nwh.ru не работает. все .ru ведь должны быть напрямую. А если дело в .nwh.ru то надо *.nwh.ru добавить в исключение — _debug domain routing issue, wildcard fix_
- Возьми в работу задачу https://fitstars.atlassian.net/browse/FD-7653 (ветка создана, мы на ней) — _take Jira ticket into work, branch ready_
- разбивай, пуш и дай мне инструкцию как мерджить — _execute MR split, push, write instructions_
- надо сделать задачу https://fitstars.atlassian.net/browse/FD-7769 — _generic Jira task pickup, feature work_
- подставь реальные значения — _substitute real config values into prompt doc_
- надо влить dev в ветку и запушить. Там конфликт решать его надо так: Каждый баннер должен находится в BannerSlot с renderId, посмотри, как пример, на pages/programs/index.vue, там есть баннер SubscriptionBanners. Для нов — _merge conflict resolution with banner rule_
- https://fitstars.atlassian.net/browse/FD-7236 — _take Jira ticket, link only, scope unknown_
- виджет отзывов надо перенести из чекаута, он никакого отношения к нему не имеет. ProductLanding → useCheckoutMainStore окей, нарушений нет, он только читает состояние. — _move component out of checkout domain_
- боковой скролл не работает, и надо добавить в задачи в список поля: исполнитель("нету" если никого), все тэги задачи, Parent задачу (приглушенно, кликабельно, если выбрать можно открыть parent задачу со всеми подзадачами — _fix scroll bug, add fields, parent modal, truncation_
- бери в работу https://fitstars.atlassian.net/browse/FD-7890 — _generic Jira task pickup, feature work_
- как именно в iframe показывается оплата в шаблонах? — _explain existing iframe checkout architecture_
- почини упавшие тесты FD-7327, удали 2 файла памяти агента если они не важные, стухшие ссылки на удалённый dev-стенд удали — _fix failing tests plus doc cleanup_
- как им указать свой токен? Этот этап не пропустили? — _verify doc completeness on token instructions_
- ❌ EAGAIN: resource temporarily unavailable, read разобраться: fsh ask "почему упало" — _diagnose CLI EAGAIN error_
- В промт ничего конкретного добавлять не надо там конкретные и абсолютные только айдишники, там дата атрибуты и так далее, а название тарифов и слаги это уже на усмотрение маркетолога. — _clarify and revise prompt content constraints_
