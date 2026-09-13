// Состояние TUI — чистые функции: их можно гонять тестами без терминала.
// Ink-компоненты только рисуют то, что здесь посчитано.
import { statusIcon, humanize, cleanTitle } from '../format.js';
import { fieldByName, fieldText, openSprints } from '../jira.js';

export const TABS = [
  { key: 'mr', title: 'MR', hint: 'a решить конфликт · t обработать тикеты · r локальное ревью · p пайплайн · f фильтры' },
  { key: 'issues', title: 'Задачи', hint: 'n проанализировать задачу · s статус · S спринт · c комментарий · e раскрыть' },
  { key: 'runs', title: 'История', hint: 'прошлые запуски действий: вердикт, цена, каталог' },
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
  { key: 'author', label: 'Автор', type: 'text' },
  { key: 'assignee', label: 'Assignee', type: 'text' },
  { key: 'reviewer', label: 'Reviewer', type: 'text' },
  { key: 'target', label: 'Целевая ветка', type: 'text' },
  { key: 'label', label: 'Метка', type: 'text' },
  { key: 'search', label: 'Поиск по тексту', type: 'text' },
  { key: 'pipeline', label: 'Статус пайплайна', type: 'text' },
  { key: 'draft', label: 'Draft', type: 'tri' },
  { key: 'conflicts', label: 'Только с конфликтом', type: 'flag' },
  { key: 'threads', label: 'Только с открытыми тредами', type: 'flag' },
];

const TRI = [null, true, false]; // не важно → да → нет

export function toggleFilter(filters, key) {
  const field = FILTER_FIELDS.find((f) => f.key === key);
  if (field?.type === 'flag') return { ...filters, [key]: !filters[key] || null };
  if (field?.type === 'tri') return { ...filters, [key]: TRI[(TRI.indexOf(filters[key] ?? null) + 1) % TRI.length] };
  return filters;
}

export const filterValueText = (field, v) => {
  if (field.type === 'text') return v || '—';
  if (field.type === 'flag') return v ? 'да' : '—';
  return v === true ? 'да' : v === false ? 'нет' : '—';
};

// Короткая сводка активных фильтров для шапки: иначе непонятно, почему список поредел.
export function filterSummary(filters = {}) {
  const parts = FILTER_FIELDS.filter((f) => filters[f.key] !== null && filters[f.key] !== undefined && filters[f.key] !== '')
    .map((f) => `${f.label.toLowerCase()}=${filterValueText(f, filters[f.key])}`);
  return parts.join(', ');
}

export const initialState = (project = '') => ({
  project,
  tab: 'mr',
  focus: 'list',
  cursor: { mr: 0, issues: 0, runs: 0 },
  items: { mr: [], issues: [], runs: [] },
  loading: { mr: true, issues: false, runs: true },
  scroll: { details: 0, log: 0 }, // details — строк вниз от начала, log — строк вверх от конца
  expand: false,
  filters: {},
  details: {}, // ключ задачи → {issue, comments}: подробности догружаются по выбору
  error: null,
  runs: {}, // id → {id, action, target, phase, done, ok, cost, decision, error}
  log: [],
  help: false,
  modal: null, // {kind, title, issue, mr, items, cursor, note, busy, editing, value}
});

const clamp = (i, len) => (len === 0 ? 0 : Math.max(0, Math.min(i, len - 1)));

export function reduce(state, ev) {
  switch (ev.type) {
    case 'tab':
      return { ...state, tab: ev.tab, help: false, focus: 'list', scroll: { details: 0, log: state.scroll.log } };
    case 'nextTab': {
      const i = TABS.findIndex((t) => t.key === state.tab);
      return reduce(state, { type: 'tab', tab: TABS[(i + 1 + TABS.length) % TABS.length].key });
    }
    case 'focus': {
      const i = PANES.indexOf(state.focus);
      return { ...state, focus: PANES[(i + ev.by + PANES.length) % PANES.length] };
    }
    case 'move': {
      const len = state.items[state.tab].length;
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
    case 'issueDetails':
      return { ...state, details: { ...state.details, [ev.key]: { issue: ev.issue, comments: ev.comments ?? [] } } };
    case 'filters':
      return { ...state, filters: ev.filters };
    case 'loading':
      return { ...state, loading: { ...state.loading, [ev.tab]: true } };
    case 'error':
      return { ...state, error: ev.message, loading: { ...state.loading, [ev.tab]: false } };
    case 'help':
      return { ...state, help: !state.help };
    case 'modalOpen':
      return { ...state, modal: { kind: ev.kind ?? 'transition', title: ev.title, issue: ev.issue, mr: ev.mr, items: ev.items, cursor: 0, note: ev.note ?? '', busy: false, editing: ev.editing ?? null, value: ev.value ?? '' } };
    case 'modalItems': // обновление списка на месте: курсор и признак работы не трогаем
      return state.modal ? { ...state, modal: { ...state.modal, items: ev.items, cursor: clamp(state.modal.cursor, ev.items.length), busy: ev.busy ?? state.modal.busy, note: ev.note ?? state.modal.note } } : state;
    case 'modalMove':
      return state.modal ? { ...state, modal: { ...state.modal, cursor: clamp(state.modal.cursor + ev.by, state.modal.items.length) } } : state;
    case 'modalEdit':
      return state.modal ? { ...state, modal: { ...state.modal, editing: ev.editing, value: ev.value ?? '' } } : state;
    case 'modalClose':
      return { ...state, modal: null };
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

export const activeRuns = (state) => Object.values(state.runs).filter((r) => !r.done);
export const selected = (state) => state.items[state.tab][state.cursor[state.tab]] ?? null;
export const totalCost = (state) => Object.values(state.runs).reduce((s, r) => s + (r.cost ?? 0), 0);

// Строка MR в списке — две строки, как в самом GitLab: заголовок с бейджами и метаданные.
export function mrRow(r) {
  const badges = [
    r.pipeline?.status ? statusIcon(r.pipeline.status) : '',
    r.approved ? '✅Approved' : '',
    r.comments?.open ? `💬${r.comments.resolved} of ${r.comments.resolved + r.comments.open}` : r.comments?.resolved ? '💬Resolved' : '',
    r.has_conflicts ? '⚠конфликт' : '',
  ].filter(Boolean).join(' ');
  const meta = [`!${r.iid}`, `создан ${humanize(r.created_at)}`, r.author, ...(r.labels ?? [])].filter(Boolean).join(' · ');
  return { title: `${r.draft ? 'Draft: ' : ''}${cleanTitle(r)}`, badges, meta };
}

// Строка задачи: статус между номером и названием — по нему и ищут глазами.
export const issueRow = (r) => `${r.key} · ${r.fields?.status?.name ?? '—'} · ${r.fields?.summary ?? ''}`;

export const runRow = (r) => `${r.id} · ${r.action} ${r.mr ? `!${r.mr}` : r.issue ?? ''} · ${r.decision ?? r.state}`;

const L = (text, style = {}) => ({ text, ...style });

// Правая панель — плоский список строк: так её можно прокручивать и проверять тестом.
export function detailLines(tab, item, { full = null, comments = [], expand = false } = {}) {
  if (!item) return [L('нечего показывать', { dim: true })];
  if (tab === 'mr') return mrDetails(item);
  if (tab === 'issues') return issueDetails(item, full, comments, expand);
  return runDetails(item);
}

function mrDetails(item) {
  return [
    L(`!${item.iid} ${item.draft ? 'Draft: ' : ''}${cleanTitle(item)}`, { bold: true }),
    L(`${item.source_branch} → ${item.target_branch}`, { dim: true }),
    L(`${item.author ?? '—'} · создан ${humanize(item.created_at)} · обновлён ${humanize(item.updated_at)}`, { dim: true }),
    L(`пайплайн ${statusIcon(item.pipeline?.status)} ${item.pipeline?.status ?? 'нет'}${item.pipeline_stale ? ' (устарел)' : ''}`),
    L(`конфликт ${item.has_conflicts ? '⚠ есть' : '✅ нет'} · треды ${item.comments?.open ? `⚠ открыто ${item.comments.open}` : '✅ все закрыты'} · ревью ${item.approved ? '✅ Approved' : '— не одобрен'}`),
    ...(item.labels?.length ? [L(`метки: ${item.labels.join(', ')}`, { dim: true })] : []),
    L(`p — пайплайн и запуск джоб · f — фильтры списка`, { dim: true }),
    L(item.web_url ?? '', { dim: true }),
  ];
}

const PEOPLE = ['Ответственный разработчик', 'Ответственный тестировщик', 'Ответственный продакт'];

function issueDetails(item, full, comments, expand) {
  const head = [
    L(`${item.key} ${item.fields?.summary ?? ''}`, { bold: true }),
    L(`${item.fields?.issuetype?.name ?? '—'} · ${item.fields?.status?.name ?? '—'} · обновлена ${humanize(item.fields?.updated)}`, { dim: true }),
  ];
  if (!full) return [...head, L('подробности загружаются…', { dim: true })];

  const f = full.fields ?? {};
  const by = (name) => fieldText(fieldByName(full, name)) || '—';
  const sprints = openSprints(fieldByName(full, 'Sprint'));
  const links = (f.issuelinks ?? []).map((l) => {
    const side = l.outwardIssue ?? l.inwardIssue;
    const rel = l.outwardIssue ? l.type?.outward : l.type?.inward;
    return `${rel} ${side?.key} ${side?.fields?.summary ?? ''}`;
  });

  const rows = [
    ...head,
    L(`Assignee: ${fieldText(f.assignee) || '—'} · Reporter: ${fieldText(f.reporter) || '—'}`),
    ...PEOPLE.filter((n) => fieldByName(full, n) !== undefined).map((n) => L(`${n}: ${by(n)}`)),
    L(`Priority: ${fieldText(f.priority) || '—'} · Labels: ${(f.labels ?? []).join(', ') || '—'}`),
    L(`Sprint: ${sprints.map((s) => `${s.name} (${s.state})`).join(', ') || '—'}`),
    L(`Parent: ${f.parent ? `${f.parent.key} ${f.parent.fields?.summary ?? ''}` : '—'}`),
    L(`Linked work items: ${links.length ? '' : '—'}`),
    ...links.map((l) => L(`  ${l}`, { dim: true })),
  ];

  const sections = [
    ['Описание', f.description ?? ''],
    ['Technical details for QA', fieldText(fieldByName(full, 'Technical details for QA'))],
    ['Контент', fieldText(fieldByName(full, 'Контент'))],
    ['Комментарии', comments.map((c) => `@${c.author?.displayName ?? '?'} · ${humanize(c.created)}\n${c.body ?? ''}`).join('\n\n')],
  ];
  for (const [title, body] of sections) {
    const lines = String(body ?? '').split('\n').filter((l, i, a) => !(l === '' && a[i - 1] === ''));
    const size = body ? `${lines.length} стр.` : 'пусто';
    rows.push(L(`${expand ? '▾' : '▸'} ${title} · ${size}${expand || !body ? '' : ' · e раскрыть'}`, { color: 'cyan' }));
    if (expand && body) for (const line of lines) rows.push(L(`  ${line}`, { dim: true }));
  }
  return rows.filter((r) => r.text !== '');
}

function runDetails(item) {
  return [
    L('Прошлый запуск действия (conflict, threads, review, analyze): что решил судья и почём.', { dim: true }),
    L(item.id, { bold: true }),
    L(`${item.action} ${item.mr ? `!${item.mr}` : item.issue ?? ''} · ${item.state}${item.decision ? ` · ${item.decision}` : ''}${item.cost ? ` · $${item.cost.toFixed(2)}` : ''}`, { dim: true }),
    L(item.dir, { dim: true }),
  ];
}

// Клавиша → намерение. Чистая: в тестах не нужен ни ink, ни терминал.
export function keyIntent(input, key, state) {
  // Пока открыта модалка, клавиши действий молчат: случайный запуск тут дороже удобства.
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
  const byNumber = { 1: 'mr', 2: 'issues', 3: 'runs' }[input];
  if (byNumber) return { type: 'tab', tab: byNumber };
  const scroll = state.focus === 'list' ? null : 'scroll';
  if (key.upArrow || input === 'k') return { type: scroll ?? 'move', by: -1 };
  if (key.downArrow || input === 'j') return { type: scroll ?? 'move', by: 1 };
  if (key.pageUp) return { type: scroll ?? 'move', by: -10 };
  if (key.pageDown) return { type: scroll ?? 'move', by: 10 };
  if (input === 'o') return { type: 'open' };
  if (input === 'e' && state.tab === 'issues') return { type: 'expand' };
  if (input === 's' && state.tab === 'issues') return { type: 'transition' };
  if (input === 'S' && state.tab === 'issues') return { type: 'sprint' };
  if (input === 'c' && state.tab === 'issues') return { type: 'comment' };
  if (input === 'p' && state.tab === 'mr') return { type: 'pipeline' };
  if (input === 'f' && state.tab === 'mr') return { type: 'openFilters' };
  if (input === 'R') return { type: 'reload' };
  const launch = LAUNCH[input];
  if (launch && launch.tab === state.tab) return { type: 'launch', action: launch.action };
  return null;
}
