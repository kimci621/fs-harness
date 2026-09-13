import Fuse from 'fuse.js';
// Состояние TUI — чистые функции: их можно гонять тестами без терминала.
// Ink-компоненты только рисуют то, что здесь посчитано.
import { statusIcon, humanize, cleanTitle } from '../format.js';
import { fieldByName, fieldText, openSprints } from '../jira.js';

export const TABS = [
  { key: 'mr', title: 'MR', hint: 'a решить конфликт · t обработать тикеты · r локальное ревью · p пайплайн · f фильтры' },
  { key: 'issues', title: 'Задачи', hint: 'n проанализировать задачу · s статус · S спринт · E поле · c комментарий · e раскрыть' },
  { key: 'runs', title: 'История', hint: 'прошлые запуски действий: вердикт, цена, каталог' },
  { key: 'prompts', title: 'Промпты', hint: 'промпты действий и судей · e сделать свой · d вернуть встроенный' },
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

const TRI = [null, true, false]; // не важно → да → нет

export function toggleFilter(filters, key) {
  const field = FILTER_FIELDS.find((f) => f.key === key);
  if (field?.type === 'flag') return { ...filters, [key]: !filters[key] || null };
  if (field?.type === 'tri') return { ...filters, [key]: TRI[(TRI.indexOf(filters[key] ?? null) + 1) % TRI.length] };
  return filters;
}

export const filterValueText = (field, v, rows = []) => {
  if (field.type === 'option') return v == null || v === '' ? '—' : filterOptions(field.key, rows).find((o) => o.value === v)?.label ?? v;
  if (field.type === 'text') return v || '—';
  if (field.type === 'flag') return v ? 'да' : '—';
  return v === true ? 'да' : v === false ? 'нет' : '—';
};

// Короткая сводка активных фильтров для шапки: иначе непонятно, почему список поредел.
export function filterSummary(filters = {}, rows = []) {
  const parts = FILTER_FIELDS.filter((f) => filters[f.key] !== null && filters[f.key] !== undefined && filters[f.key] !== '')
    .map((f) => `${f.label.toLowerCase()}=${filterValueText(f, filters[f.key], rows)}`);
  return parts.join(', ');
}

export const initialState = (project = '') => ({
  project,
  tab: 'mr',
  focus: 'list',
  cursor: { mr: 0, issues: 0, runs: 0, prompts: 0 },
  items: { mr: [], issues: [], runs: [], prompts: [] },
  loading: { mr: true, issues: false, runs: true, prompts: false },
  scroll: { details: 0, log: 0 }, // details — строк вниз от начала, log — строк вверх от конца
  expand: false,
  search: { mr: '', issues: '', runs: '', prompts: '' }, // запрос на вкладку
  searching: false, // открыто поле ввода поиска
  filters: {},
  details: {}, // ключ задачи → {issue, comments}: подробности догружаются по выбору
  prompts: {}, // имя шаблона → текст: читается с диска при выборе строки
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
      return { ...state, tab: ev.tab, help: false, searching: false, focus: 'list', scroll: { details: 0, log: state.scroll.log } };
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
        scroll: { ...state.scroll, details: 0 },
      };
    }
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
    case 'issueDetails':
      return { ...state, details: { ...state.details, [ev.key]: { issue: ev.issue, comments: ev.comments ?? [] } } };
    case 'promptBody':
      return { ...state, prompts: { ...state.prompts, [ev.name]: ev.body } };
    case 'filters':
      return { ...state, filters: ev.filters };
    case 'loading':
      return { ...state, loading: { ...state.loading, [ev.tab]: true } };
    case 'error':
      return { ...state, error: ev.message, loading: { ...state.loading, [ev.tab]: false } };
    case 'help':
      return { ...state, help: !state.help };
    case 'modalOpen':
      return { ...state, modal: { kind: ev.kind ?? 'transition', title: ev.title, issue: ev.issue, mr: ev.mr, field: ev.field, meta: ev.meta, items: ev.items, cursor: ev.cursor ?? 0, note: ev.note ?? '', busy: Boolean(ev.busy), editing: ev.editing ?? null, value: ev.value ?? '' } };
    case 'modalItems': // обновление списка на месте: курсор и признак работы не трогаем
      return state.modal ? { ...state, modal: { ...state.modal, items: ev.items ?? state.modal.items, cursor: clamp(state.modal.cursor, (ev.items ?? state.modal.items).length), busy: ev.busy ?? state.modal.busy, note: ev.note ?? state.modal.note } } : state;
    case 'modalMove':
      return state.modal ? { ...state, modal: { ...state.modal, cursor: clamp(state.modal.cursor + ev.by, state.modal.items.length) } } : state;
    case 'modalEdit':
      return state.modal ? { ...state, modal: { ...state.modal, editing: ev.editing, value: ev.value ?? '' } } : state;
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
  if (e.t === 'log') return `${tag} ▸ ${e.text}`;
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

export const visibleItems = (state) => searchRows(state.tab, state.items[state.tab], state.search[state.tab]);
export const selected = (state) => visibleItems(state)[state.cursor[state.tab]] ?? null;
export const totalCost = (state) => Object.values(state.runs).reduce((s, r) => s + (r.cost ?? 0), 0);

// Куски строки со своим цветом: важное — номер, исполнитель, статус, ветка — должно
// выделяться, иначе панель читается как сплошная серая простыня.
const KEY = { color: 'cyan', bold: true };   // идентификаторы: !2785, FD-7653
const VAL = { bold: true };                  // значения, за которыми приходят
const LBL = { dim: true };                   // подписи полей
const seg = (text, style = {}) => ({ text: String(text ?? ''), ...style });
const line = (...parts) => ({ parts: parts.filter((p) => p && p.text !== '') });
const GAP = { gap: true, parts: [] };        // пустая строка между смысловыми группами
export const lineText = (l) => (l?.parts ?? []).map((p) => p.text).join('');

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
export const issueRow = (r) => line(
  seg(r.key, KEY),
  seg(' · '),
  seg(r.fields?.status?.name ?? '—', { color: statusTone(r.fields?.status) }),
  seg(' · '),
  seg(r.fields?.summary ?? ''),
);

export const runRow = (r) => line(
  seg(r.id, KEY),
  seg(` · ${r.action} `, LBL),
  seg(r.mr ? `!${r.mr}` : r.issue ?? ''),
  seg(' · '),
  seg(r.decision ?? r.state, { color: r.decision === 'approve' ? 'green' : r.decision ? 'yellow' : undefined }),
);

export const promptRow = (r) => line(
  seg(r.overridden ? '✏️ ' : '   '),
  seg(r.name, KEY),
  seg(`  ${r.overridden ? 'свой' : 'встроенный'}`, LBL),
);

// Правая панель — плоский список строк: так её можно прокручивать и проверять тестом.
export function detailLines(tab, item, extra = {}) {
  const { full = null, comments = [], expand = false, body = '' } = extra;
  if (!item) return [line(seg('нечего показывать', LBL))];
  if (tab === 'mr') return mrDetails(item);
  if (tab === 'issues') return issueDetails(item, full, comments, expand);
  if (tab === 'prompts') return promptDetails(item, body, expand);
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
    if (expand && body) for (const l of lines) rows.push(line(seg(`  ${l}`)));
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
    ...String(body ?? '').split('\n').map((l) => line(seg(l))),
  ].filter(Boolean);
}

function runDetails(item) {
  return [
    line(seg(item.id, KEY)),
    line(seg('действие  ', LBL), seg(item.action, VAL), seg('  цель  ', LBL), seg(item.mr ? `!${item.mr}` : item.issue ?? '—')),
    line(
      seg('итог      ', LBL),
      seg(item.state, { color: item.state === 'ok' ? 'green' : item.state === 'error' ? 'red' : undefined }),
      item.decision ? seg(`  вердикт  ${item.decision}`, { color: item.decision === 'approve' ? 'green' : 'yellow' }) : null,
      item.cost ? seg(`  $${item.cost.toFixed(2)}`, LBL) : null,
    ),
    GAP,
    line(seg('Прошлый запуск действия: каталог рана со всеми артефактами.', LBL)),
    line(seg(item.dir, LBL)),
  ].filter(Boolean);
}

// Клавиша → намерение. Чистая: в тестах не нужен ни ink, ни терминал.
export function keyIntent(input, key, state) {
  // Пока открыта модалка, клавиши действий молчат: случайный запуск тут дороже удобства.
  // Пока набирают запрос, клавиши действий молчат: поле ввода забирает их себе.
  if (state.searching) return key.escape || key.return ? { type: 'searchClose' } : null;
  if (state.modal) {
    if (state.modal.editing) return null; // ввод текста забирает поле ввода
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
  if (key.tab) return { type: 'focus', by: key.shift ? -1 : 1 };
  const byNumber = { 1: 'mr', 2: 'issues', 3: 'runs', 4: 'prompts' }[input];
  if (byNumber) return { type: 'tab', tab: byNumber };
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
  if (input === 'E' && state.tab === 'issues') return { type: 'editField' };
  if (input === 'p' && state.tab === 'mr') return { type: 'pipeline' };
  if (input === 'f' && state.tab === 'mr') return { type: 'openFilters' };
  if (input === 'R') return { type: 'reload' };
  const launch = LAUNCH[input];
  if (launch && launch.tab === state.tab) return { type: 'launch', action: launch.action };
  return null;
}
