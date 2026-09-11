// Состояние TUI — чистые функции: их можно гонять тестами без терминала.
// Ink-компоненты только рисуют то, что здесь посчитано.

export const TABS = [
  { key: 'mr', title: 'MR', hint: 'a конфликт · t треды · r ревью' },
  { key: 'issues', title: 'Задачи', hint: 'n разбор · s статус' },
  { key: 'runs', title: 'Запуски', hint: 'R обновить · путь к журналу справа' },
];

// Действия по клавишам: одно действие — одна клавиша, как в плане.
export const LAUNCH = {
  a: { action: 'conflict', tab: 'mr' },
  t: { action: 'threads', tab: 'mr' },
  r: { action: 'review', tab: 'mr' },
  n: { action: 'analyze', tab: 'issues' },
};

export const LOG_LIMIT = 2000;

export const initialState = (project = '') => ({
  project,
  tab: 'mr',
  cursor: { mr: 0, issues: 0, runs: 0 },
  items: { mr: [], issues: [], runs: [] },
  loading: { mr: true, issues: false, runs: true },
  error: null,
  runs: {}, // id → {id, action, target, phase, done, ok, cost, decision, error}
  log: [],
  help: false,
  modal: null, // {title, issue, items:[{id,name,to}], cursor} — выбор перехода задачи
});

const clamp = (i, len) => (len === 0 ? 0 : Math.max(0, Math.min(i, len - 1)));

export function reduce(state, ev) {
  switch (ev.type) {
    case 'tab':
      return { ...state, tab: ev.tab, help: false };
    case 'nextTab': {
      const i = TABS.findIndex((t) => t.key === state.tab);
      return { ...state, tab: TABS[(i + 1 + TABS.length) % TABS.length].key, help: false };
    }
    case 'move': {
      const len = state.items[state.tab].length;
      return { ...state, cursor: { ...state.cursor, [state.tab]: clamp(state.cursor[state.tab] + ev.by, len) } };
    }
    case 'items':
      return {
        ...state,
        items: { ...state.items, [ev.tab]: ev.items },
        loading: { ...state.loading, [ev.tab]: false },
        cursor: { ...state.cursor, [ev.tab]: clamp(state.cursor[ev.tab] ?? 0, ev.items.length) },
      };
    case 'loading':
      return { ...state, loading: { ...state.loading, [ev.tab]: true } };
    case 'error':
      return { ...state, error: ev.message, loading: { ...state.loading, [ev.tab]: false } };
    case 'help':
      return { ...state, help: !state.help };
    case 'modalOpen':
      return { ...state, modal: { title: ev.title, issue: ev.issue, items: ev.items, cursor: 0 } };
    case 'modalMove':
      return state.modal ? { ...state, modal: { ...state.modal, cursor: clamp(state.modal.cursor + ev.by, state.modal.items.length) } } : state;
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

// Клавиша → намерение. Чистая: в тестах не нужен ни ink, ни терминал.
export function keyIntent(input, key, state) {
  // Пока открыт выбор перехода, клавиши действий молчат: случайный запуск тут дороже удобства.
  if (state.modal) {
    if (key.escape || input === 'q') return { type: 'modalClose' };
    if (key.upArrow || input === 'k') return { type: 'modalMove', by: -1 };
    if (key.downArrow || input === 'j') return { type: 'modalMove', by: 1 };
    if (key.return) return { type: 'modalApply' };
    return null;
  }
  if (key.escape && state.help) return { type: 'help' };
  if (input === '?') return { type: 'help' };
  if (input === 'q') return { type: 'quit' };
  if (input === 'x') return { type: 'abort' };
  if (key.tab) return { type: 'nextTab' };
  const byNumber = { 1: 'mr', 2: 'issues', 3: 'runs' }[input];
  if (byNumber) return { type: 'tab', tab: byNumber };
  if (key.upArrow || input === 'k') return { type: 'move', by: -1 };
  if (key.downArrow || input === 'j') return { type: 'move', by: 1 };
  if (key.pageUp) return { type: 'move', by: -10 };
  if (key.pageDown) return { type: 'move', by: 10 };
  if (input === 'o') return { type: 'open' };
  if (input === 's' && state.tab === 'issues') return { type: 'transition' };
  if (input === 'R') return { type: 'reload' };
  const launch = LAUNCH[input];
  if (launch && launch.tab === state.tab) return { type: 'launch', action: launch.action };
  return null;
}
