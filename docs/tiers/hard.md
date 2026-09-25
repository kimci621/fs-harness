# Сложные задачи (hard)

Агент: план и разбор — `opus` xhigh, код — `opus-high` (фолбэк `agy-high`).

Критерий роутера (`TIER_CRITERIA.hard` в `src/tier.js`):

> Задача про оплату или чекаут: способы оплаты, рассрочка, сплит, тарифы, суммы и цены платежа, промокоды, payload заказа, payment_type, блоки оплат, платёжные шлюзы, контракт с бэкенд-задачей, конфликт слияния в коде чекаута. Или нужны план, архитектура или поиск неизвестной причины: баг без названной причины (кэш, SSR, гонка, пропадает после перезагрузки), миграция между подсистемами, аудит эпика, сверка на полную идентичность перед деплоем, новая подсистема, пайплайн или провайдер, проверка плана или гипотез, инцидент безопасности.

Разметка: 61 промптов из 472 уникальных за историю Claude Code по fitstars-frontend и FS-Harness. Медиана вызовов инструментов на ход: 24.

## Примеры

Текст промпта обрезан до 220 символов, после тире — почему такой уровень.

- ## Задача, которую решал агент FD-7734: PROD. FE. На странице программ замки (lock-иконки) на карточках отображаются сразу после покупки базовой подписки, пропадают после обновления страницы На странице /programs у польз — _lock-icon caching bug, unknown root cause, SPA state_
- сделай ревью плана, всё ли в нем хорошо и ничего не упустили? — _review plan for completeness and correctness_
- SSRF на нашей собственной куке — 167 блокировок 403 у одного RU-пользователя (<ip>), с 15:19 и продолжается: type: ssrf status: 403 hits: 139 GET + 28 POST parameter: HEADER_COOKIE_COOKIE_fs_payment_funnel_JSON_ — _SSRF/security incident investigation, checkout impact_
- Очень важная задача, требуется до начала работ планирование и 100 процентное понимание https://fitstars.atlassian.net/browse/FD-7785 — _planning checkout promo/utm bug ticket, full understanding needed_
- http://localhost:3000/subscribe?order_id=265&secret=<secret> тут намерено неправильный secret, бэк присылает 1 тариф, он почему-то не выбран по умолчанию. В чем причина? — _checkout default tariff selection bug, unknown cause_
- делай фазу 12. ci-fix (2-3 дня) - авто-починка упавших пайплайнов. Нужен предшаг apiRaw() в glab.js — _implement CI auto-fix pipeline phase, new architecture_
- есть проблема с валютами. сейчас выбираю рубли в переключателе валюты, /payments/list отправляет тело { "pageName": "is_on_subscribe", "country": "us", "tariff_slug": "dostup-navsegda", "currency": "RUB" } и получает тел — _checkout currency/payment contract bug_
- По уже сделанной задаче https://fitstars.atlassian.net/browse/FD-7147 (У тебя должна она быть в памяти и доках проекта) Есть один баг и одна доработка. БАГ — когда страницу сгенерировали, и там есть уже тарифы карточек,  — _checkout tariff selection bug plus payload compat design_
- ## Задача, которую решал агент Решить конфликт слияния в MR !2827 «FD-7738: FE. T-Bank Forma: выбор срока рассрочки 6/10/12 на чекауте и при оплате счёта»: ветка feature/FD-7738 сливается с dev. Конфликтующие файлы (1):  — _merge conflict in checkout payment installment component_
- давай stdin, и нужна возможность вызывать агента claude code так же, но по другим алиасам (cc, co, cd, ccq) cc по умолчанию. Это надо для того чтобы запускать с другими ai провайдерами. в настройках cli дать выбор и внеш — _design multi-provider agent alias architecture in CLI_
- У приложение что-то не работают ни обработка тикетов ни решение конфликта (обработка тикетов последнее в истории и я его прервал threads ▸ prompt… threads-mu2d8psg-ieeo │ │ threads ▸ agent… │ │ threads ▸ 🤖 Запускаю claud — _cross-system debugging, harness logging/judge unclear root cause_
- https://fitstars.atlassian.net/browse/FD-6817 Надо актуализировать и проверить, что уже сделано, а что осталось сделать. Эта задача-эпик по миграции с legacy checkout на новый payment system. Твоя задача состоит в том, ч — _audit legacy-to-payment-system migration completeness_
- Хороший текст, с единственным но. Делать буду этот проект я один с помощью агентов (ai only), от основной работы на чекауте я уходить не буду, работа будет вестить паралелльно. От моей команды разработки потребуется помо — _revise business plan with staffing/timeline/monetization tradeoffs_
- Создай новую задачу: на странице https://fitstars.ru/payment?sum=3000&email=test@example.com&name=%D0%98%D0%B2%D0%B0%D0%BD+%D0%98%D0%B2%D0%B0%D0%BD%D0%BE%D0%B2&text=3%D0%B0+%D0%BA%D0%BE%D0%BD%D1%81%D1%83%D0%BB%D1%8C%D1%8 — _checkout currency-switch contract bug, needs investigation_
- У меня есть план по автоматизации своей работы в отдельном приложении (работает и с worktree в том числе и у приложения есть доступ к cli чтобы он сам вызывал claude code с нужной моделью как ai as judge, где главным суд — _designing multi-agent harness app architecture_
- отображение что есть конфликт или есть не resolved all threds должно быть сразу видно в списке. Переименовать "a конфликт" на "a решить конфликт", "t треды" на "t обработать тикеты", "r ревью" на "r локальное ревью", и д — _complex UI plus pipeline-dependency cascade feature design_
- ## Задача, которую решал агент FD-7785: FE: якорные кнопки на лендинге сбрасывают ?promo и utm_* — после перезагрузки промокод подменяется на featured h2. Симптом Клиент приходит по промо-ссылке лендинга, видит цену со с — _prod promo/utm loss bug, cross-system root cause_
- https://fitstars.atlassian.net/browse/FD-7327 на ветке feature/FD-7147_html-ai-landings реализован чистый компонент оплат (конечно мы должны перенести его максимально аккуратно, учитывая то, почему и для чего он был созд — _migrate payment component across checkout boundary_
- на проде почему то нету стилей у карточек тарифов [Image #1] и нету выбора валют в модальном окне оплат у новых landing шаблонов. [Image #2] локально всё окей; — _prod-only styling/currency bug, cross-system debugging_
- ## Задача, которую решал агент Решить конфликт слияния в MR !2775 «feature/FD-7578 feat(checkout): порядок блоков оплаты из payments/list»: ветка feature/FD-7578 сливается с dev. Конфликтующие файлы (1): stores/checkout/ — _merge conflict in checkout store, payment domain contract_
- ## Задача, которую решал агент Разобрать 2 нерешённых тредов ревью в MR !2827 «FD-7738: FE. T-Bank Forma: выбор срока рассрочки 6/10/12 на чекауте и при оплате счёта»: где ревьюер прав — поправить код, где нет — ответить — _explain payment gating asymmetry across checkout components_
- Надо добавить в cli: 1) Возможность добавлять в поле файлы (в этом сценарии в задачу в поле "Контент" файл .csv) Группа, Ключ, Значение checkout, content_load_failed_title, Не получилось загрузить форму оплаты checkout,  — _design master AI chat integration architecture in CLI_
- 1) убрать из CLAUDE.md «сначала граф» и обновлять руками 2) перепиши 3) установи 4) в dev вливает человек исключительно вручную .claude/rules/checkout-payment-system.md и checkout-boundary.md описывают легаси-движок опла — _rewrite stale payment docs plus flaky test fix_
- на проде появилась сегодня ошибка qozNHqGr.js:21 Hydration completed but contains mismatches. (anonymous) @ qozNHqGr.js:21 vc @ qozNHqGr.js:3 m @ qozNHqGr.js:5 A @ qozNHqGr.js:3 f @ qozNHqGr.js:3 p @ qozNHqGr.js:5 h @ qo — _prod hydration mismatch, unknown root cause debugging_
- .claude/docs/ai-harness-upgrade-plan.md Эот план по улучшению harness для проекта. Нужно его провалидировать от и до и удостоверится что ничего не упущено и план совпадает с реальной кодовой базой — _validate architecture plan against real codebase_
- Когда выбираю беларусские рубли first_payment_sum: 0 но к оплате все еще не 0 а price_byn — _checkout tariff price contract bug_
- Перед деплоем нужно: 1. Сверить новый payment с тем что сейчас на проде (в dev) и реализацию на ветке на 100% идентичность функциональности 2. Проверить все по тесткейсам закрепленным во вложении только после 100% совмес — _verify payment parity and test cases before deploy_
- У всех блоков не хватает скролла внутри если контент не вмещается, у задач статус должен быть в списке задача в названии между номером и title, высота и ширина должны быть равны высоте и ширине viewport окна терминала(10 — _large multi-field editable UI feature set, layout design_
- ## Задача, которую решал агент FD-7719: FE: Посмотреть и при необходимости починить аналитику на HTML шаблонах Изначально было утверждение, что аналитика сразу заработает как на страницах тильды, но Валерия передала, что — _analytics broken, unknown root cause, cross-domain_
- Надо доделать работу уже с реальным бэкендом на этой ветке, напомни что задача эта эпик https://fitstars.atlassian.net/browse/FD-7147. у нас только продовое окружение бока, будем работать с ним вот в этом разделе ты созд — _multi-step prod backend auth integration_
