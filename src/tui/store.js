import Fuse from 'fuse.js';
// Состояние TUI — чистые функции: их можно гонять тестами без терминала.
// Ink-компоненты только рисуют то, что здесь посчитано.
import { statusIcon, humanize, cleanTitle, hhmmss } from '../format.js';
import { fieldByName, fieldText, openSprints } from '../jira.js';

export const TABS = [
  { key: 'mr', title: 'MR', hint: 'a решить конфликт · t обработать тикеты · r локальное ревью · p пайплайн · E поле · f фильтры' },
  { key: 'issues', title: 'Задачи', hint: 'v доска · n проанализировать · s статус · S спринт · E поле · p родитель · c коммент · f фильтры' },
  { key: 'runs', title: 'Процессы', hint: 'активные процессы и архив запусков (до 50): вердикт, цена, каталог' },
  { key: 'prompts', title: 'Промпты', hint: 'промпты действий и судей · e сделать свой · d вернуть встроенный' },
  { key: 'gb', title: 'Флаги', hint: 'c создать · t вкл/выкл в окружении · D удалить · R перечитать' },
  { key: 'dict', title: 'Словарь', hint: 'c создать · E править · D удалить · n/p страница · R перечитать' },
];

// Действия по клавишам: одно действие — одна клавиша, как в плане.
export const LAUNCH = {
  a: { action: 'conflict', tab: 'mr' },
  t: { action: 'threads', tab: 'mr' },
  r: { action: 'review', tab: 'mr' },
  n: { action: 'analyze', tab: 'issues' },
};

export const LOG_LIMIT = 2000;

// Блоки экрана. Tab переносит фокус, j/k двигают курсор в списке и прокручивают остальные.
export const PANES = ['list', 'details', 'log'];

// Джобы пайплайна по стадиям, как показывает GitLab. Порядок стадий API не отдаёт,
// поэтому берём его по младшему id джобы в стадии: джобы ранних стадий создаются первыми.
// ponytail: ретрай создаёт новый id, и стадия из одних ретраев уедет вниз списка.
export function orderJobs(jobs = []) {
  const first = new Map();
  for (const j of jobs) {
    const stage = j.stage ?? '';
    if (!first.has(stage) || j.id < first.get(stage)) first.set(stage, j.id);
  }
  return [...jobs].sort((a, b) => first.get(a.stage ?? '') - first.get(b.stage ?? '') || a.id - b.id);
}

// Джоба деплоя тянет за собой сборку: запускать её надо цепочкой deploy, а не в одиночку.
export const DEPLOY_JOB = /^deploy_dev(\d*)$/;
export const deploySlot = (name) => (DEPLOY_JOB.exec(name ?? '') ?? [])[1] || '';

// Фильтры списка MR: те же, что у флагов CLI. type решает, что делает Enter на строке.
// Что правится у MR. Схему «что тут можно менять» GitLab не отдаёт, в отличие от Jira editmeta,
// поэтому список наш, а текущее значение читается из самого MR.
export const MR_FIELDS = [
  { id: 'title', name: 'Title', kind: 'text', read: (m) => m.title ?? '' },
  { id: 'description', name: 'Description', kind: 'editor', read: (m) => m.description ?? '' },
  { id: 'assignee_ids', name: 'Assignee', kind: 'pick', from: 'members', read: (m) => (m.assignees ?? []).map((u) => u.username).join(', ') },
  { id: 'reviewer_ids', name: 'Reviewers', kind: 'users', read: (m) => (m.reviewers ?? []).map((u) => u.username).join(', ') },
  { id: 'labels', name: 'Labels', kind: 'list', read: (m) => (m.labels ?? []).join(', ') },
  { id: 'target_branch', name: 'Target branch', kind: 'pick', from: 'branches', read: (m) => m.target_branch ?? '' },
  { id: 'squash', name: 'Squash при мерже', kind: 'flag', read: (m) => Boolean(m.squash) },
  { id: 'remove_source_branch', name: 'Удалить ветку после мержа', kind: 'flag', read: (m) => Boolean(m.force_remove_source_branch) },
];

// Строка поля в списке: видно, что стоит сейчас, иначе правишь вслепую.
export const mrFieldRow = (f, mr) => `${f.name.padEnd(26)}${f.kind === 'flag' ? (f.read(mr) ? 'да' : 'нет') : f.read(mr).split('\n')[0].slice(0, 40) || '—'}`;

export const FILTER_FIELDS = [
  { key: 'author', label: 'Автор', type: 'option' },
  { key: 'assignee', label: 'Assignee', type: 'option' },
  { key: 'reviewer', label: 'Reviewer', type: 'option' },
  { key: 'target', label: 'Целевая ветка', type: 'option' },
  { key: 'label', label: 'Метка', type: 'option' },
  { key: 'search', label: 'Поиск по тексту', type: 'text' },
  { key: 'pipeline', label: 'Статус пайплайна', type: 'option' },
  { key: 'draft', label: 'Draft', type: 'tri' },
  { key: 'conflicts', label: 'Только с конфликтом', type: 'flag' },
  { key: 'threads', label: 'Только с открытыми тредами', type: 'flag' },
];

// Значения фильтров собираем из уже загруженных MR: угадывать чужие логины руками неоткуда.
const OPTION_SOURCES = {
  author: (r) => [{ value: r.author_username, label: r.author }],
  assignee: (r) => (r.assignees ?? []).map((u) => ({ value: u.username, label: u.name })),
  reviewer: (r) => (r.reviewers ?? []).map((u) => ({ value: u.username, label: u.name })),
  target: (r) => [{ value: r.target_branch, label: r.target_branch }],
  label: (r) => (r.labels ?? []).map((l) => ({ value: l, label: l })),
  pipeline: (r) => [{ value: r.pipeline?.status ?? 'none', label: r.pipeline?.status ?? 'без пайплайна' }],
};
const ME_FIELDS = ['author', 'assignee', 'reviewer'];

export function filterOptions(key, rows = []) {
  const src = OPTION_SOURCES[key];
  if (!src) return [];
  const found = new Map();
  for (const r of rows) for (const o of src(r) ?? []) if (o?.value) found.set(o.value, o.label || o.value);
  const list = [...found].sort((a, b) => String(a[1]).localeCompare(String(b[1]))).map(([value, label]) => ({ value, label }));
  return [
    { value: null, label: '— любой' },
    ...(ME_FIELDS.includes(key) ? [{ value: 'me', label: 'я' }] : []),
    ...list,
  ];
}

// Фильтры задач — те же, что в самом Jira: их значения складываются в JQL (buildJql),
// свой язык запросов поверх чужого не выдумываем.
export const ISSUE_FILTER_FIELDS = [
  { key: 'assignee', label: 'Assignee', type: 'option' },
  { key: 'status', label: 'Статус', type: 'option' },
  { key: 'sprint', label: 'Спринт', type: 'option' },
  { key: 'component', label: 'Компонент', type: 'option' },
  { key: 'jql', label: 'Свой JQL', type: 'text' },
];

export const fieldsFor = (tab) => (tab === 'issues' ? ISSUE_FILTER_FIELDS : FILTER_FIELDS);

// Значения, которых нет в списках: они не приходят из Jira, их понимает buildJql.
const SPECIAL = { me: 'я', any: 'все', current: 'текущий' };

const TRI = [null, true, false]; // не важно → да → нет

export function toggleFilter(filters, key) {
  const field = [...FILTER_FIELDS, ...ISSUE_FILTER_FIELDS].find((f) => f.key === key);
  if (field?.type === 'flag') return { ...filters, [key]: !filters[key] || null };
  if (field?.type === 'tri') return { ...filters, [key]: TRI[(TRI.indexOf(filters[key] ?? null) + 1) % TRI.length] };
  return filters;
}

export const filterValueText = (field, v, options = []) => {
  if (field.type === 'option') return v == null || v === '' ? '—' : options.find((o) => o.value === v)?.label ?? SPECIAL[v] ?? v;
  if (field.type === 'text') return v || '—';
  if (field.type === 'flag') return v ? 'да' : '—';
  return v === true ? 'да' : v === false ? 'нет' : '—';
};

// Короткая сводка активных фильтров для шапки: иначе непонятно, почему список поредел.
export function filterSummary(filters = {}, fields = FILTER_FIELDS, optionsFor = () => []) {
  const parts = fields.filter((f) => filters[f.key] !== null && filters[f.key] !== undefined && filters[f.key] !== '')
    .map((f) => `${f.label.toLowerCase()}=${filterValueText(f, filters[f.key], optionsFor(f.key))}`);
  return parts.join(', ');
}

export const initialState = (project = '') => ({
  project,
  tab: 'mr',
  focus: 'list',
  cursor: { mr: 0, issues: 0, runs: 0, prompts: 0, gb: 0, dict: 0 },
  items: { mr: [], issues: [], runs: [], prompts: [], gb: [], dict: [] },
  loading: { mr: true, issues: false, runs: true, prompts: false, gb: false, dict: false },
  scroll: { details: 0, log: 0, x: 0 }, // details — строк вниз от начала, log — строк вверх от конца
  expand: false,
  board: false, // вкладка задач: доска вместо списка
  boardCursor: { col: 0, row: 0 },
  columns: [], // колонки доски из Jira: [{name, statuses:[{id}]}]
  search: { mr: '', issues: '', runs: '', prompts: '', gb: '', dict: '' }, // запрос на вкладку
  searching: false, // открыто поле ввода поиска
  filters: { mr: {}, issues: { assignee: 'me' } }, // по умолчанию задачи только мои, как было
  options: { issues: {} }, // варианты фильтров, прочитанные из Jira: ключ поля → [{value,label}]
  details: {}, // ключ задачи → {issue, comments}: подробности догружаются по выбору
  prompts: {}, // имя шаблона → текст: читается с диска при выборе строки
  dictPage: { page: 1, size: 15, total: 0 }, // у словаря своя пагинация: API отдаёт по 15
  languages: [], // коды языков словаря: читаются один раз для форм создания и правки
  error: null,
  busy: [], // {label, at} по каждому идущему запросу: пока список не пуст, в шапке спиннер
  runs: {}, // id → {id, action, target, phase, done, ok, cost, decision, error}
  log: [],
  help: false,
  modal: null, // {kind, title, issue, mr, items, cursor, note, busy, editing, value}
});

const clamp = (i, len) => (len === 0 ? 0 : Math.max(0, Math.min(i, len - 1)));

export function reduce(state, ev) {
  switch (ev.type) {
    case 'tab':
      return { ...state, tab: ev.tab, help: false, searching: false, focus: 'list', scroll: { details: 0, log: state.scroll.log, x: 0 } };
    case 'nextTab': {
      const i = TABS.findIndex((t) => t.key === state.tab);
      return reduce(state, { type: 'tab', tab: TABS[(i + 1 + TABS.length) % TABS.length].key });
    }
    case 'focus': {
      const i = PANES.indexOf(state.focus);
      return { ...state, focus: PANES[(i + ev.by + PANES.length) % PANES.length] };
    }
    case 'move': {
      const len = visibleItems(state).length;
      // Курсор уехал на другую строку — правая панель показывает уже другое, прокрутку сбрасываем.
      return {
        ...state,
        cursor: { ...state.cursor, [state.tab]: clamp(state.cursor[state.tab] + ev.by, len) },
        scroll: { ...state.scroll, details: 0, x: 0 },
      };
    }
    case 'boardToggle':
      return { ...state, board: !state.board, boardCursor: { col: 0, row: 0 }, scroll: { ...state.scroll, details: 0 } };
    case 'columns':
      return { ...state, columns: ev.columns };
    case 'boardMove': {
      const cols = boardLanes(state);
      if (!cols.length) return state;
      const col = clamp(state.boardCursor.col + (ev.col ?? 0), cols.length);
      const row = clamp(state.boardCursor.row + (ev.row ?? 0), cols[col].items.length);
      return { ...state, boardCursor: { col, row }, scroll: { ...state.scroll, details: 0 } };
    }
    case 'scrollX': // вбок двигаются обе панели разом: иначе непонятно, что именно ты сдвинул
      return { ...state, scroll: { ...state.scroll, x: Math.max(0, state.scroll.x + ev.by) } };
    case 'scroll': {
      // У лога отсчёт от конца: он дописывается снизу, и «ноль» должен значить «самое свежее».
      const pane = state.focus === 'log' ? 'log' : 'details';
      const by = pane === 'log' ? -ev.by : ev.by;
      return { ...state, scroll: { ...state.scroll, [pane]: Math.max(0, state.scroll[pane] + by) } };
    }
    case 'expand':
      return { ...state, expand: !state.expand, scroll: { ...state.scroll, details: 0 } };
    case 'items':
      return {
        ...state,
        items: { ...state.items, [ev.tab]: ev.items },
        loading: { ...state.loading, [ev.tab]: false },
        cursor: { ...state.cursor, [ev.tab]: clamp(state.cursor[ev.tab] ?? 0, ev.items.length) },
      };
    case 'busy': {
      // Массив, а не флаг: параллельных запросов бывает несколько, и каждый снимает только себя.
      if (ev.on) return { ...state, busy: [...state.busy, { label: ev.label, at: ev.at }] };
      const i = state.busy.findIndex((b) => b.label === ev.label);
      return i === -1 ? state : { ...state, busy: [...state.busy.slice(0, i), ...state.busy.slice(i + 1)] };
    }
    case 'dictPage': {
      // Страница зажимается здесь, а не на вызывающем месте: так правило проверяется тестом.
      const size = ev.meta?.size ?? state.dictPage.size;
      const total = ev.meta?.total ?? state.dictPage.total;
      const page = total
        ? Math.min(Math.max(1, ev.meta?.page ?? state.dictPage.page), Math.max(1, Math.ceil(total / (size || 15))))
        : (ev.meta?.page ?? state.dictPage.page);
      return { ...state, dictPage: { ...state.dictPage, ...ev.meta, page }, cursor: { ...state.cursor, dict: 0 } };
    }
    case 'languages':
      return { ...state, languages: ev.items };
    case 'issueDetails':
      return { ...state, details: { ...state.details, [ev.key]: { issue: ev.issue, comments: ev.comments ?? [] } } };
    case 'promptBody':
      return { ...state, prompts: { ...state.prompts, [ev.name]: ev.body } };
    case 'filterOptions':
      return { ...state, options: { ...state.options, issues: { ...state.options.issues, [ev.key]: ev.items } } };
    case 'filters': // фильтры свои у каждой вкладки: список MR и список задач фильтруются по-разному
      return { ...state, filters: { ...state.filters, [ev.tab ?? state.tab]: ev.filters }, cursor: { ...state.cursor, [ev.tab ?? state.tab]: 0 } };
    case 'loading':
      return { ...state, loading: { ...state.loading, [ev.tab]: true } };
    case 'error':
      return { ...state, error: ev.message, loading: { ...state.loading, [ev.tab]: false } };
    case 'help':
      return { ...state, help: !state.help };
    case 'modalOpen':
      return { ...state, modal: { kind: ev.kind ?? 'transition', title: ev.title, issue: ev.issue, mr: ev.mr, field: ev.field, meta: ev.meta, items: ev.items, cursor: ev.cursor ?? 0, note: ev.note ?? '', busy: Boolean(ev.busy), editing: ev.editing ?? null, value: ev.value ?? '', lines: ev.lines ?? [], stream: '' } };
    case 'modalItems': // обновление списка на месте: курсор и признак работы не трогаем
      return state.modal ? { ...state, modal: { ...state.modal, items: ev.items ?? state.modal.items, cursor: clamp(state.modal.cursor, (ev.items ?? state.modal.items).length), busy: ev.busy ?? state.modal.busy, note: ev.note ?? state.modal.note } } : state;
    case 'modalMove':
      return state.modal ? { ...state, modal: { ...state.modal, cursor: clamp(state.modal.cursor + ev.by, state.modal.items.length) } } : state;
    case 'modalEdit': // meta не трогаем, если событие её не несёт: многошаговые формы копят поля в ней
      return state.modal ? { ...state, modal: { ...state.modal, editing: ev.editing, value: ev.value ?? '', meta: ev.meta ?? state.modal.meta } } : state;
    // Чат мастера: реплики копятся в модалке, поток ответа — отдельной строкой,
    // иначе на каждую дельту пришлось бы перекраивать весь список.
    case 'chatSay':
      return state.modal ? { ...state, modal: { ...state.modal, lines: [...(state.modal.lines ?? []), { role: ev.role, text: ev.text }], stream: '', busy: ev.role === 'me' } } : state;
    case 'chatDelta':
      return state.modal ? { ...state, modal: { ...state.modal, stream: (state.modal.stream ?? '') + ev.text } } : state;
    case 'chatNote':
      return state.modal ? { ...state, modal: { ...state.modal, note: ev.text } } : state;
    case 'chatDone':
      return state.modal
        ? { ...state, modal: { ...state.modal, lines: [...(state.modal.lines ?? []), { role: ev.role ?? 'мастер', text: ev.text }], stream: '', busy: false, note: '' } }
        : state;
    case 'modalClose':
      return { ...state, modal: null };
    case 'searchOpen':
      return { ...state, searching: true, help: false };
    case 'searchEdit': // курсор на первую строку: старый индекс указывает в другой список
      return { ...state, search: { ...state.search, [state.tab]: ev.value }, cursor: { ...state.cursor, [state.tab]: 0 }, scroll: { ...state.scroll, details: 0 } };
    case 'searchClose':
      return { ...state, searching: false };
    case 'runStarted':
      return { ...state, runs: { ...state.runs, [ev.id]: { id: ev.id, action: ev.action, target: ev.target, phase: 'старт', cost: 0, done: false } } };
    case 'runEvent':
      return applyRunEvent(state, ev.id, ev.event);
    case 'log':
      return { ...state, log: [...state.log, ...ev.lines].slice(-LOG_LIMIT) };
    default:
      return state;
  }
}

// Событие движка → и в лог, и в карточку рана. Один поток, два потребителя.
function applyRunEvent(state, id, e) {
  const run = state.runs[id];
  if (!run) return state;
  const patch = e.run && !run.runId ? { runId: e.run } : {};
  if (e.t === 'phase') patch.phase = `${e.phase}${e.status === 'done' ? ' ✓' : '…'}`;
  if (e.t === 'verdict') {
    patch.decision = e.verdict.decision;
    patch.cost = (run.cost ?? 0) + (e.verdict.meta?.cost ?? 0);
  }
  if (e.t === 'done') Object.assign(patch, { done: true, ok: true, phase: 'готово' });
  if (e.t === 'error') Object.assign(patch, { done: true, ok: false, phase: 'ошибка', error: e.message });
  return { ...state, runs: { ...state.runs, [id]: { ...run, ...patch } } };
}

// Строки лога из события. null — событие не для лога (фазы рисуются в карточке).
export function logLine(runId, e) {
  const tag = runId.split('-')[0];
  // Метка времени: долгий ран без неё неотличим от зависшего.
  const at = e.at ? `${hhmmss(e.at)} ` : '';
  if (e.t === 'log') return `${tag} ▸ ${at}${e.text}`;
  if (e.t === 'verdict') return `${tag} ▸ судья: ${e.verdict.decision} · $${(e.verdict.meta?.cost ?? 0).toFixed(4)}`;
  if (e.t === 'error') return `${tag} ▸ ❌ ${e.message}`;
  if (e.t === 'phase' && e.status === 'start') return `${tag} ▸ ${e.phase}…`;
  return null;
}

// Что сейчас грузится — в шапку. После трёх секунд дописываем счётчик: без него
// долгий запрос неотличим от зависшего экрана.
export function busyText(busy = [], now = Date.now()) {
  const started = new Map();
  for (const b of busy) if (!started.has(b.label) || b.at < started.get(b.label)) started.set(b.label, b.at);
  return [...started]
    .map(([label, at]) => {
      const sec = Math.round((now - at) / 1000);
      return sec >= 3 ? `${label} ${sec}с` : label;
    })
    .join(' · ');
}

export const activeRuns = (state) => Object.values(state.runs).filter((r) => !r.done);
// Поиск по всей сущности сразу: склеиваем её поля в одну строку и отдаём Fuse.
// threshold 0.4 — опечатка в паре букв ещё находит, случайное совпадение уже нет.
const HAY = {
  mr: (r) => [`!${r.iid}`, r.title, r.author, r.source_branch, r.target_branch, r.pipeline?.status, r.draft ? 'draft' : '', ...(r.labels ?? [])],
  issues: (r) => [r.key, r.fields?.summary, r.fields?.status?.name, r.fields?.issuetype?.name, r.fields?.assignee?.displayName, ...(r.fields?.labels ?? [])],
  runs: (r) => [r.id, r.action, r.mr ? `!${r.mr}` : '', r.issue, r.state, r.decision],
  prompts: (r) => [r.name, r.overridden ? 'свой' : 'встроенный', ...(r.vars ?? [])],
  gb: (r) => [r.id, r.type, r.envs, ...(r.tags ?? [])],
  dict: (r) => [r.group, r.key, r.value, String(r.language_id ?? '')],
};

let cache = {}; // индекс переживает перерисовку: список меняется реже, чем кадр

export function searchRows(tab, items, query) {
  const q = (query ?? '').trim();
  if (!q || !HAY[tab]) return items;
  if (cache.tab !== tab || cache.items !== items) {
    const docs = items.map((item, i) => ({ i, hay: HAY[tab](item).filter(Boolean).join(' ') }));
    cache = { tab, items, fuse: new Fuse(docs, { keys: ['hay'], threshold: 0.4, ignoreLocation: true, minMatchCharLength: 2 }) };
  }
  return cache.fuse.search(q).map((r) => items[r.item.i]);
}

// Вкладка «Процессы»: активные процессы первыми, затем до 50 архивных.
export const processItems = (state) => {
  const active = Object.values(state.runs || {})
    .filter((r) => !r.done)
    .map((r) => ({
      id: r.id,
      action: r.action,
      target: r.target,
      mr: r.target?.startsWith?.('!') ? r.target.slice(1) : (r.mr ?? null),
      issue: !r.target?.startsWith?.('!') ? r.target : (r.issue ?? null),
      created_at: r.created_at ?? 'сейчас',
      state: 'в работе',
      phase: r.phase,
      decision: r.decision ?? null,
      cost: r.cost ?? 0,
      active: true,
    }));

  const archived = (state.items.runs || []).filter((ar) => !active.some((ac) => ac.id === ar.id)).slice(0, 50);
  return [...active, ...archived];
};

export const visibleItems = (state) =>
  searchRows(state.tab, state.tab === 'runs' ? processItems(state) : state.items[state.tab], state.search[state.tab]);

// Раскладка задач по колонкам доски. Колонка хранит id статусов, а не имена: имя колонки
// и имя статуса в Jira совпадают не всегда. Пустые колонки прячем — их в FD больше половины.
export function boardColumns(columns = [], issues = []) {
  const byStatus = new Map();
  columns.forEach((c, i) => (c.statuses ?? []).forEach((st) => byStatus.set(String(st.id), i)));
  const buckets = columns.map((c) => ({ name: c.name, items: [] }));
  const rest = [];
  for (const it of issues) {
    const i = byStatus.get(String(it.fields?.status?.id));
    if (i === undefined) rest.push(it);
    else buckets[i].items.push(it);
  }
  if (rest.length) buckets.push({ name: 'вне доски', items: rest });
  return buckets.filter((b) => b.items.length);
}

export const onBoard = (state) => state.tab === 'issues' && state.board;
export const boardLanes = (state) => boardColumns(state.columns, visibleItems(state));
export const selected = (state) =>
  (onBoard(state)
    ? boardLanes(state)[state.boardCursor.col]?.items[state.boardCursor.row]
    : visibleItems(state)[state.cursor[state.tab]]) ?? null;
export const totalCost = (state) => Object.values(state.runs).reduce((s, r) => s + (r.cost ?? 0), 0);

// Куски строки со своим цветом: важное — номер, исполнитель, статус, ветка — должно
// выделяться, иначе панель читается как сплошная серая простыня.
const KEY = { color: 'cyan', bold: true };   // идентификаторы: !2785, FD-7653
const VAL = { bold: true };                  // значения, за которыми приходят
const LBL = { dim: true };                   // подписи полей
const seg = (text, style = {}) => ({ text: String(text ?? ''), ...style });
const line = (...parts) => ({ parts: parts.filter((p) => p && p.text !== '') });
const GAP = { gap: true, parts: [] };        // пустая строка между смысловыми группами
// Боковой сдвиг строки: панель обрезает текст справа, а прочитать хвост иначе нечем.
export function shiftLine(l, off) {
  if (!off || l.gap) return l;
  let left = off;
  const parts = [];
  for (const p of l.parts) {
    if (left >= p.text.length) { left -= p.text.length; continue; }
    parts.push(left ? { ...p, text: p.text.slice(left) } : p);
    left = 0;
  }
  return { ...l, parts };
}

export const lineText = (l) => (l?.parts ?? []).map((p) => p.text).join('');

// Абзацы описания и комментариев переносятся по словам, а не обрезаются: текст задачи
// в одну строку не читается. Остальные строки — поля и заголовки — по-прежнему обрезаются.
export function flowLines(lines, width) {
  if (!(width > 0)) return lines;
  return lines.flatMap((l) => {
    if (!l.flow) return [l];
    const style = l.parts[0] ?? {};
    const indent = /^\s*/.exec(style.text ?? '')[0];
    const words = String(style.text ?? '').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return [l];
    const out = [];
    let cur = indent;
    for (const w of words) {
      const next = cur.trim() ? `${cur} ${w}` : `${cur}${w}`;
      if (next.length > width && cur.trim()) { out.push(cur); cur = `${indent}${w}`; } else cur = next;
    }
    out.push(cur);
    return out.map((text) => ({ parts: [{ ...style, text }], flow: true }));
  });
}

const PIPE_TONE = { success: 'green', failed: 'red', canceled: 'gray', running: 'cyan', manual: 'yellow' };
export const pipeTone = (status) => PIPE_TONE[status] ?? 'yellow';
const CAT_TONE = { done: 'green', indeterminate: 'yellow', new: 'gray' };
export const statusTone = (status) => CAT_TONE[status?.statusCategory?.key] ?? 'yellow';

// Строка MR в списке — две строки, как в самом GitLab: заголовок с бейджами и метаданные.
export function mrRow(r) {
  const badges = [
    r.pipeline?.status ? statusIcon(r.pipeline.status) : '',
    r.approved ? '✅Approved' : '',
    r.comments?.open ? `💬${r.comments.resolved} of ${r.comments.resolved + r.comments.open}` : r.comments?.resolved ? '💬Resolved' : '',
    r.has_conflicts ? '⚠конфликт' : '',
  ].filter(Boolean).join(' ');
  const meta = line(
    seg(`!${r.iid}`, KEY),
    seg(` · создан ${humanize(r.created_at)} · `, LBL),
    seg(r.author ?? '—'),
    r.labels?.length ? seg(` · ${r.labels.join(' · ')}`, { color: 'blue' }) : null,
  );
  return { title: `${r.draft ? 'Draft: ' : ''}${cleanTitle(r)}`, badges, meta, metaText: lineText(meta) };
}

// Строка задачи: статус между ключом и названием — по нему и ищут глазами.
// Перенос по словам с потолком: хвост, который не влез, обрезается многоточием.
export function wrapText(text, width, max = Infinity) {
  const words = String(text ?? '').trim().split(/\s+/).filter(Boolean);
  if (!words.length || !(width > 0)) return [String(text ?? '')];
  const out = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length > width && cur) {
      out.push(cur);
      if (out.length === max) return [...out.slice(0, -1), `${cur.slice(0, Math.max(1, width - 1))}…`];
      cur = w;
    } else cur = next;
  }
  out.push(cur);
  return out;
}

// Строка задачи в списке — карточка в несколько строк: кто делает, как называется,
// какие метки и от какой родительской задачи. В одну строку это не помещалось.
export function issueCard(r, width = 60) {
  const f = r.fields ?? {};
  const parent = f.parent;
  const labels = f.labels ?? [];
  const title = wrapText(f.summary ?? '', Math.max(10, width - 1), 3);
  return [
    line(
      seg(r.key, KEY),
      seg(' · '),
      seg(f.status?.name ?? '—', { color: statusTone(f.status) }),
      seg(' · '),
      seg(fieldText(f.assignee) || 'нету', f.assignee ? VAL : { dim: true }),
    ),
    ...title.map((t) => line(seg(t))),
    labels.length || parent
      ? line(
        labels.length ? seg(labels.join(', '), { color: 'blue' }) : null,
        labels.length && parent ? seg(' · ', LBL) : null,
        parent ? seg(`↑ ${parent.key} ${parent.fields?.summary ?? ''}`, LBL) : null,
      )
      : null,
  ].filter(Boolean);
}

export const cardRows = (r) => [
  line(seg(r.key, KEY), seg(`  ${fieldText(r.fields?.priority) || ''}`, LBL)),
  line(seg(r.fields?.summary ?? '')),
];

export const runRow = (r) => {
  if (r.active) {
    return line(
      seg(r.id, KEY),
      seg(` · ${r.action} `, LBL),
      seg(r.mr ? `!${r.mr}` : r.target || r.issue || ''),
      seg(' · '),
      seg(`⏳ ${r.phase || 'в работе'}`, { color: 'yellow' }),
    );
  }
  return line(
    seg(r.id, KEY),
    seg(` · ${r.action} `, LBL),
    seg(r.mr ? `!${r.mr}` : r.issue ?? ''),
    seg(' · '),
    seg(r.decision ?? r.state, { color: r.decision === 'approve' ? 'green' : r.decision ? 'yellow' : undefined }),
  );
};

export const promptRow = (r) => line(
  seg(r.overridden ? '✏️ ' : '   '),
  seg(r.name, KEY),
  seg(`  ${r.overridden ? 'свой' : 'встроенный'}`, LBL),
);

export const gbRow = (r) => line(
  seg(r.id, KEY),
  seg(` · ${r.type ?? 'boolean'} · `, LBL),
  seg(r.envs || 'нет окружений', { color: /production=on/.test(r.envs ?? '') ? 'green' : undefined }),
  r.tags?.length ? seg(` · ${r.tags.join(', ')}`, { color: 'blue' }) : null,
);

export const dictRow = (r) => line(
  seg(`${r.group}.${r.key}`, KEY),
  seg(` · ${r.language_id} · `, LBL),
  seg(String(r.value ?? '').slice(0, 60)),
);

// Правая панель — плоский список строк: так её можно прокручивать и проверять тестом.
export function detailLines(tab, item, extra = {}) {
  const { full = null, comments = [], expand = false, body = '' } = extra;
  if (!item) return [line(seg('нечего показывать', LBL))];
  if (tab === 'mr') return mrDetails(item);
  if (tab === 'issues') return issueDetails(item, full, comments, expand);
  if (tab === 'prompts') return promptDetails(item, body, expand);
  if (tab === 'gb') return gbDetails(item);
  if (tab === 'dict') return dictDetails(item);
  return runDetails(item);
}

function mrDetails(item) {
  const open = item.comments?.open;
  return [
    line(seg(`!${item.iid}`, KEY), seg(' '), seg(`${item.draft ? 'Draft: ' : ''}${cleanTitle(item)}`, VAL)),
    line(seg('ветка   ', LBL), seg(item.source_branch, { color: 'yellow' }), seg(' → ', LBL), seg(item.target_branch, { color: 'yellow' })),
    line(seg('автор   ', LBL), seg(item.author ?? '—', VAL), seg(` · создан ${humanize(item.created_at)} · обновлён ${humanize(item.updated_at)}`, LBL)),
    item.labels?.length ? line(seg('метки   ', LBL), seg(item.labels.join(' · '), { color: 'blue' })) : null,
    GAP,
    line(
      seg('пайплайн ', LBL),
      seg(`${statusIcon(item.pipeline?.status)} ${item.pipeline?.status ?? 'нет'}`, { color: item.pipeline ? pipeTone(item.pipeline.status) : 'gray' }),
      item.pipeline_stale ? seg(' (устарел)', { color: 'yellow' }) : null,
    ),
    line(
      seg('конфликт ', LBL),
      seg(item.has_conflicts ? '⚠ есть' : '✅ нет', { color: item.has_conflicts ? 'red' : 'green' }),
      seg('   треды ', LBL),
      seg(open ? `⚠ открыто ${open}` : '✅ все закрыты', { color: open ? 'red' : 'green' }),
    ),
    line(seg('ревью    ', LBL), seg(item.approved ? '✅ Approved' : '— не одобрен', { color: item.approved ? 'green' : undefined })),
    GAP,
    line(seg('p — пайплайн и запуск джоб · f — фильтры · / — поиск по списку', LBL)),
    line(seg(item.web_url ?? '', LBL)),
  ].filter(Boolean);
}

const PEOPLE = ['Ответственный разработчик', 'Ответственный тестировщик', 'Ответственный продакт'];

function issueDetails(item, full, comments, expand) {
  const head = [
    line(seg(item.key, KEY), seg(' '), seg(item.fields?.summary ?? '', VAL)),
    line(
      seg(item.fields?.issuetype?.name ?? '—', LBL),
      seg(' · '),
      seg(item.fields?.status?.name ?? '—', { color: statusTone(item.fields?.status), bold: true }),
      seg(` · обновлена ${humanize(item.fields?.updated)}`, LBL),
    ),
  ];
  if (!full) return [...head, GAP, line(seg('подробности загружаются…', { color: 'yellow' }))];

  const f = full.fields ?? {};
  const by = (name) => fieldText(fieldByName(full, name)) || '—';
  const sprints = openSprints(fieldByName(full, 'Sprint'));
  const links = (f.issuelinks ?? []).map((l) => {
    const side = l.outwardIssue ?? l.inwardIssue;
    return { rel: l.outwardIssue ? l.type?.outward : l.type?.inward, key: side?.key, summary: side?.fields?.summary ?? '' };
  });

  const rows = [
    ...head,
    GAP,
    line(seg('Assignee  ', LBL), seg(fieldText(f.assignee) || '—', VAL)),
    line(seg('Reporter  ', LBL), seg(fieldText(f.reporter) || '—')),
    ...PEOPLE.filter((n) => fieldByName(full, n) !== undefined).map((n) => line(seg(`${n}  `, LBL), seg(by(n), by(n) === '—' ? {} : VAL))),
    GAP,
    line(seg('Priority  ', LBL), seg(fieldText(f.priority) || '—'), seg('   Labels  ', LBL), seg((f.labels ?? []).join(', ') || '—', { color: 'blue' })),
    line(seg('Sprint    ', LBL), seg(sprints.map((s) => `${s.name} (${s.state})`).join(', ') || '—', { color: 'magenta' })),
    line(seg('Parent    ', LBL), f.parent ? seg(f.parent.key, KEY) : seg('—'), f.parent ? seg(` ${f.parent.fields?.summary ?? ''}`) : null),
    line(seg('Linked work items', LBL), links.length ? null : seg('  —')),
    ...links.map((l) => line(seg(`  ${l.rel} `, LBL), seg(l.key, KEY), seg(` ${l.summary}`))),
    GAP,
  ];

  const sections = [
    ['Описание', f.description ?? ''],
    ['Technical details for QA', fieldText(fieldByName(full, 'Technical details for QA'))],
    ['Контент', fieldText(fieldByName(full, 'Контент'))],
    ['Комментарии', comments.map((c) => `@${c.author?.displayName ?? '?'} · ${humanize(c.created)}\n${c.body ?? ''}`).join('\n\n')],
  ];
  for (const [title, body] of sections) {
    const lines = String(body ?? '').split('\n').filter((l, i, a) => !(l === '' && a[i - 1] === ''));
    rows.push(line(
      seg(`${expand ? '▾' : '▸'} ${title}`, { color: 'cyan', bold: true }),
      seg(` · ${body ? `${lines.length} стр.` : 'пусто'}`, LBL),
      body && !expand ? seg(' · e раскрыть', LBL) : null,
    ));
    if (expand && body) for (const l of lines) rows.push({ ...line(seg(`  ${l}`)), flow: true });
    rows.push(GAP);
  }
  return rows.filter(Boolean);
}

function promptDetails(item, body) {
  return [
    line(seg(item.name, KEY)),
    line(seg('источник  ', LBL), seg(item.overridden ? item.source : 'встроенный', { color: item.overridden ? 'yellow' : undefined })),
    item.vars?.length ? line(seg('переменные ', LBL), seg(item.vars.join(', '), { color: 'blue' })) : null,
    GAP,
    ...String(body ?? '').split('\n').map((l) => ({ ...line(seg(l)), flow: true })),
  ].filter(Boolean);
}

function runDetails(item) {
  if (item.active) {
    return [
      line(seg(item.id, KEY)),
      line(seg('действие  ', LBL), seg(item.action, VAL), seg('  цель  ', LBL), seg(item.target ?? (item.mr ? `!${item.mr}` : item.issue ?? '—'))),
      line(seg('статус    ', LBL), seg('⏳ в работе', { color: 'yellow' }), seg(`  фаза: ${item.phase || 'старт'}`)),
      item.cost ? line(seg('расход    ', LBL), seg(`$${item.cost.toFixed(4)}`, VAL)) : null,
      GAP,
      line(seg('Активный процесс выполняется в изолированном окружении.', LBL)),
      line(seg('Нажми x, чтобы прервать процесс.', LBL)),
    ].filter(Boolean);
  }
  return [
    line(seg(item.id, KEY)),
    line(seg('действие  ', LBL), seg(item.action, VAL), seg('  цель  ', LBL), seg(item.mr ? `!${item.mr}` : item.issue ?? '—')),
    line(
      seg('итог      ', LBL),
      seg(item.state, { color: item.state === 'ok' || item.state === 'done' ? 'green' : item.state === 'error' ? 'red' : undefined }),
      item.decision ? seg(`  вердикт  ${item.decision}`, { color: item.decision === 'approve' ? 'green' : 'yellow' }) : null,
      item.cost ? seg(`  $${item.cost.toFixed(2)}`, LBL) : null,
    ),
    GAP,
    line(seg('Прошлый запуск действия: каталог рана со всеми артефактами.', LBL)),
    item.dir ? line(seg(item.dir, LBL)) : null,
  ].filter(Boolean);
}

function gbDetails(item) {
  return [
    line(seg(item.id, KEY), seg('  ', LBL), seg(item.type ?? 'boolean', VAL)),
    line(seg('дефолт   ', LBL), seg(String(item.defaultValue ?? item.default ?? '—'))),
    line(seg('окружения', LBL), seg(item.envs || '—', { color: /production=on/.test(item.envs ?? '') ? 'green' : undefined })),
    item.tags?.length ? line(seg('метки    ', LBL), seg(item.tags.join(', '), { color: 'blue' })) : null,
    GAP,
    line(seg('t — включить или выключить в окружении · c — создать · D — удалить', LBL)),
  ].filter(Boolean);
}

function dictDetails(item) {
  return [
    line(seg(`${item.group}.${item.key}`, KEY)),
    line(seg('язык     ', LBL), seg(String(item.language_id ?? '—')), seg(`  (${item.language?.name ?? ''})`, LBL)),
    GAP,
    ...String(item.value ?? '').split('\n').map((l) => ({ ...line(seg(l)), flow: true })),
    GAP,
    line(seg('E — править значение · c — создать · D — удалить · после записи кэш обновляется сам', LBL)),
  ].filter(Boolean);
}

// Клавиша → намерение. Чистая: в тестах не нужен ни ink, ни терминал.
export function keyIntent(input, key, state) {
  // Пока открыта модалка, клавиши действий молчат: случайный запуск тут дороже удобства.
  // Пока набирают запрос, клавиши действий молчат: поле ввода забирает их себе.
  if (state.searching) return key.escape || key.return ? { type: 'searchClose' } : null;
  if (state.modal) {
    if (state.modal.editing) return null; // ввод текста забирает поле ввода
    // В списке вложений a переводит модалку в ввод пути: отдельной клавиши верхнего уровня не надо.
    if (state.modal.kind === 'attach' && input === 'a') return { type: 'attachAdd' };
    if (key.escape || input === 'q') return { type: 'modalClose' };
    if (key.upArrow || input === 'k') return { type: 'modalMove', by: -1 };
    if (key.downArrow || input === 'j') return { type: 'modalMove', by: 1 };
    if (key.return) return { type: 'modalApply' };
    if (key.delete || key.backspace) return { type: 'modalClear' };
    return null;
  }
  if (key.escape && state.help) return { type: 'help' };
  if (input === '?') return { type: 'help' };
  if (input === 'q') return { type: 'quit' };
  if (input === 'x') return { type: 'abort' };
  if (input === 'A') return { type: 'ask' };
  if (key.tab) return { type: 'focus', by: key.shift ? -1 : 1 };
  const byNumber = { 1: 'mr', 2: 'issues', 3: 'runs', 4: 'prompts', 5: 'gb', 6: 'dict' }[input];
  if (byNumber) return { type: 'tab', tab: byNumber };
  if (input === 'v' && state.tab === 'issues') return { type: 'boardToggle' };
  // На доске курсор двумя осями: h/l по колонкам, j/k по карточкам, H/L переносит карточку.
  if (onBoard(state) && state.focus === 'list') {
    if (input === 'H') return { type: 'moveCard', by: -1 };
    if (input === 'L') return { type: 'moveCard', by: 1 };
    if (key.leftArrow || input === 'h') return { type: 'boardMove', col: -1 };
    if (key.rightArrow || input === 'l') return { type: 'boardMove', col: 1 };
    if (key.upArrow || input === 'k') return { type: 'boardMove', row: -1 };
    if (key.downArrow || input === 'j') return { type: 'boardMove', row: 1 };
    if (key.pageUp) return { type: 'boardMove', row: -10 };
    if (key.pageDown) return { type: 'boardMove', row: 10 };
  }
  if (key.leftArrow) return { type: 'scrollX', by: -8 };
  if (key.rightArrow) return { type: 'scrollX', by: 8 };
  const scroll = state.focus === 'list' ? null : 'scroll';
  if (key.upArrow || input === 'k') return { type: scroll ?? 'move', by: -1 };
  if (key.downArrow || input === 'j') return { type: scroll ?? 'move', by: 1 };
  if (key.pageUp) return { type: scroll ?? 'move', by: -10 };
  if (key.pageDown) return { type: scroll ?? 'move', by: 10 };
  if (input === '/') return { type: 'searchOpen' };
  if (input === 'o') return { type: 'open' };
  if (input === 'e' && state.tab === 'issues') return { type: 'expand' };
  if (input === 'e' && state.tab === 'prompts') return { type: 'promptOverride' };
  if (input === 'd' && state.tab === 'prompts') return { type: 'promptDrop' };
  if (input === 's' && state.tab === 'issues') return { type: 'transition' };
  if (input === 'S' && state.tab === 'issues') return { type: 'sprint' };
  if (input === 'c' && state.tab === 'issues') return { type: 'comment' };
  if (input === 'c' && (state.tab === 'gb' || state.tab === 'dict')) return { type: 'create' };
  if (input === 't' && state.tab === 'gb') return { type: 'gbToggle' };
  if (input === 'E' && state.tab === 'dict') return { type: 'dictEdit' };
  if (input === 'n' && state.tab === 'dict') return { type: 'dictPage', by: 1 };
  if (input === 'p' && state.tab === 'dict') return { type: 'dictPage', by: -1 };
  if (input === 'D' && (state.tab === 'gb' || state.tab === 'dict')) return { type: 'delete' };
  if (input === 'E' && (state.tab === 'issues' || state.tab === 'mr')) return { type: 'editField' };
  if (input === '@' && state.tab === 'issues') return { type: 'attach' };
  if (input === 'p' && state.tab === 'issues') return { type: 'parent' };
  if (input === 'p' && state.tab === 'mr') return { type: 'pipeline' };
  if (input === 'f' && (state.tab === 'mr' || state.tab === 'issues')) return { type: 'openFilters' };
  if (input === 'R') return { type: 'reload' };
  const launch = LAUNCH[input];
  if (launch && launch.tab === state.tab) return { type: 'launch', action: launch.action };
  return null;
}
