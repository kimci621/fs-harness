# Лёгкие задачи (easy)

Агент: `sonnet-low` (фолбэк `agy-low`).

Критерий роутера (`TIER_CRITERIA.easy` в `src/tier.js`):

> Механическая правка, где место и ответ уже названы в тексте: стиль, отступ, текст, удалить комментарий, неиспользуемую переменную или лишний файл, поправить тип коммита, merge без конфликтов, заполнить поля Jira, запустить сервер. Один-два файла, читать чужой код и выбирать решение не нужно. Оплаты, чекаут, тарифы и аналитика не упоминаются.

Разметка: 168 промптов из 472 уникальных за историю Claude Code по fitstars-frontend и FS-Harness. Медиана вызовов инструментов на ход: 4.

## Примеры

Текст промпта обрезан до 220 символов, после тире — почему такой уровень.

- Создай новую задачу на фронт: html ai лендинги https://fitstars.ru/page/special-2?promo=go2025. Не отображается премиум в подарок внутри модалки с оплатой, а должен. Вот этот тариф на нашем сайте напрямую https://fitstar — _create Jira bug task from clear description_
- подели бледной полоской колонки в канбане и добавь маленький отступ между колонками — _simple styling tweak, divider and spacing_
- когда запрашиваешь OCTOBER_ADMIN_TOKEN покажи сразу ссылку откуда его взять https://secure.fitstars.ru/backend/yougifted/api/adminproxytokens и когда лендинг публикуется каждый раз показывай сообщение "Лендинг опубликова — _small mechanical addition to prompt UX text_
- Файл: /Users/a.latipov/Downloads/fitstars-landing-generator.skill. это что? — _factual question about a file format_
- @components/Modules/Checkout/PaymentSystem/PaymentSystemPaymentMethods.vue Переменная foreignCurrencyCodeFor деструктурирована из второго usePaymentButtonCurrency, но в шаблоне не используется напрямую — только через yan — _remove unused destructured variable, small cleanup_
- что готово и осталось по плану? — _status question about plan progress_
- комить, обнови dev-ом, пуш, открывай мр в dev — _commit, merge dev, push, open MR_
- STRIP_FORWARDED_HEADERS это что? — _short factual question_
- Изучи что за инструмент и модель https://typesafe.ai/blog/introducing-system-one-models-and-jev — _read and summarize a blog post_
- Apple и google play обязательно (даже без rustore), там основной трафик — _simple platform requirement statement_
- сначала инструкцию, потом заново фикс — _ordering instruction for deliverables_
- дай мне все промпты которые ты отправил — _retrieve sent prompts_
- что за формат такой? может сделаешь zip или tar ? — _convert file to zip/tar format_
- мне кажется ты отправил довольно много ненужной документации, удали то что не нужно ни тебе ни мне где код уже сам говорит за себя — _delete unnecessary generated docs_
- сподними watch.intervalSeconds до 300, потом rm -rf node_modules && npm ci && npm test, потом коммить свое — _run mechanical commands and commit_
- поднять ROUTER_JUDGE_TIMEOUT до 3.5 с, — _raise a timeout constant_
- контейнер пока отложим, не могу ответить прямо сейчас — _trivial deferral acknowledgment_
- что случилось? Что осталось сделать? — _status question on remaining work_
- я ушел из api deepseek в openrouter и забыл поменять. Поменяй провайдера судьи на openrouter а модель на xiaomi/mimo-v2.6-flash (токен тут ~/.openrouter_key) — _swap API provider and model config_
- Отметь все в задаче, потом пушни в репозиторий — _mark task done, push repo_
- page/{slug} осталось? ничего не изменилось? — _simple verification question_
- Прверь работает ли gitlab соединение в glab, напрямую в репозиторий и в webstorm — _check gitlab connectivity in tools_
- создай задачу на фронтенд: Верстка внутри блока оплаты от cloud payments (эквайринг) сломалась, вот скрин [Image #1] — _create Jira task from screenshot, mechanical_
- да, потом отметь что все готово и идем дальше — _confirmation, mark done and continue_
- ты забыл gap в id="split_pays" — _small follow-up CSS gap fix_
- сДобавил в исключения fitstars.gitlab.yandexcloud.net проверь — _verify a config exclusion change_
- оставь как есть, иди дальше по плану — _continue with existing plan, no change_
- все подтверждаю, апи ключ будет в ~/.growthbook_apikey — _confirmation with config detail_
- Добавь fitstars.ru тоже, он тоже не открывается. Еще avito.ru, tbank.ru — _add domains to exclusion list_
- как его установить в claude desktop? — _factual installation instructions question_
