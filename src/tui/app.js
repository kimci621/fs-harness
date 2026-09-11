import { execFile } from 'node:child_process';
import React, { useEffect, useReducer, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import Spinner from 'ink-spinner';
import htm from 'htm';
import { TABS, initialState, reduce, keyIntent, logLine, selected, activeRuns, totalCost } from './store.js';
import { listRuns } from '../agent/journal.js';
import { findCommand } from '../registry.js';
import { runAction } from '../engine.js';
import { statusIcon, truncate, humanize, cleanTitle } from '../format.js';

const html = htm.bind(React.createElement);

export function App({ ctx, opts }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [state, dispatch] = useReducer(reduce, initialState(ctx.cfg.activeProject));
  const [now, setNow] = useState(Date.now());
  const runsRef = useRef(new Map()); // id → AgentRun, чтобы было кого прерывать
  const bufferRef = useRef([]);
  const quitArmedRef = useRef(false);

  // Буфер + слив по таймеру: на каждую дельту агента перерисовывать бессмысленно.
  useEffect(() => {
    const id = setInterval(() => {
      setNow(Date.now());
      if (!bufferRef.current.length) return;
      const lines = bufferRef.current;
      bufferRef.current = [];
      dispatch({ type: 'log', lines });
    }, 100);
    return () => clearInterval(id);
  }, []);

  useEffect(() => { load('mr'); load('runs'); }, []);

  async function load(tab) {
    dispatch({ type: 'loading', tab });
    try {
      if (tab === 'mr') dispatch({ type: 'items', tab, items: await ctx.g.listOpenMRs(ctx.repo) });
      if (tab === 'runs') dispatch({ type: 'items', tab, items: listRuns({ limit: 30 }) });
      if (tab === 'issues') {
        const { issues } = await ctx.jira().searchJql({ jql: 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC' });
        dispatch({ type: 'items', tab, items: issues });
      }
    } catch (err) {
      dispatch({ type: 'error', tab, message: err.message });
    }
  }

  // Смена статуса задачи — единственная запись в Jira: сначала список переходов, потом выбор.
  async function openTransitions() {
    const item = selected(state);
    if (!item?.key) return;
    try {
      const { transitions = [] } = (await ctx.jira().transitions(item.key)) ?? {};
      if (!transitions.length) return void bufferRef.current.push(`${item.key} ▸ доступных переходов нет`);
      dispatch({ type: 'modalOpen', title: `${item.key}: куда переводим?`, issue: item.key, items: transitions.map((t) => ({ id: t.id, name: t.name, to: t.to?.name ?? t.name })) });
    } catch (err) {
      dispatch({ type: 'error', tab: 'issues', message: err.message });
    }
  }

  async function applyTransition() {
    const { issue, items, cursor } = state.modal;
    const t = items[cursor];
    dispatch({ type: 'modalClose' });
    try {
      await ctx.jira().transition(issue, t.id);
      bufferRef.current.push(`${issue} ▸ статус → ${t.to}`);
      load('issues');
    } catch (err) {
      bufferRef.current.push(`${issue} ▸ ❌ ${err.message}`);
    }
  }

  function launch(actionName) {
    const item = selected(state);
    if (!item) return;
    const spec = findCommand(actionName);
    const query = item.iid ? String(item.iid) : item.key;
    const run = runAction(spec, ctx, { query }, {
      ...opts,
      agent: opts.agent || ctx.cfg.agent || spec.action.agent.default,
      agentArgs: ctx.agentArgs(opts.agent || ctx.cfg.agent || spec.action.agent.default),
      projectDir: ctx.cfg.projectDir,
      cfg: ctx.cfg,
      yes: true, // подтверждение здесь — сама клавиша
      asObject: true,
    });
    // Ключ карточки свой: id рана появляется только после createRun, а события
    // идут с первой фазы — по e.run карточка теряла бы половину своей жизни.
    const key = `${actionName}-${Date.now().toString(36)}`;
    runsRef.current.set(key, run);
    dispatch({ type: 'runStarted', id: key, action: actionName, target: query });
    run.on((e) => {
      dispatch({ type: 'runEvent', id: key, event: e });
      const line = logLine(key, e);
      if (line) bufferRef.current.push(line);
    });
    run.result.catch(() => {}); // ошибка уже пришла событием
  }

  useInput((input, key) => {
    const intent = keyIntent(input, key, state);
    if (!intent) return;
    if (intent.type === 'quit') {
      // Выход при живых ранах — только со второго раза: движок их не убивает,
      // но человек должен знать, что уходит от работающего агента.
      if (activeRuns(state).length && !quitArmedRef.current) {
        quitArmedRef.current = true;
        bufferRef.current.push(`⚠ в работе запусков: ${activeRuns(state).length}. x прервёт, q ещё раз — выйти и оставить их`);
        return;
      }
      return exit();
    }
    if (intent.type === 'abort') {
      for (const r of runsRef.current.values()) r.abort();
      return;
    }
    if (intent.type === 'launch') return launch(intent.action);
    if (intent.type === 'transition') return void openTransitions();
    if (intent.type === 'modalApply') return void applyTransition();
    if (intent.type === 'open') {
      const url = selected(state)?.web_url;
      if (url) execFile('open', [url], () => {});
      return;
    }
    if (intent.type === 'reload') return load(state.tab);
    if (intent.type === 'tab') { dispatch(intent); if (!state.items[intent.tab].length) load(intent.tab); return; }
    dispatch(intent);
  });

  const width = stdout?.columns ?? 100;
  const item = selected(state);
  const running = activeRuns(state);

  return html`
    <${Box} flexDirection="column" width=${width}>
      <${Box} justifyContent="space-between">
        <${Text} bold color="cyan">fs-harness · ${state.project || ctx.repo}<//>
        <${Text} dimColor>запусков: ${running.length}${running.length ? ' ' : ''}${running.length ? html`<${Spinner} type="dots" />` : ''} · $${totalCost(state).toFixed(2)}<//>
      <//>
      <${Box}>
        ${TABS.map((t, i) => html`<${Text} key=${t.key} color=${state.tab === t.key ? 'cyan' : undefined} inverse=${state.tab === t.key}> [${i + 1}] ${t.title} <//>`)}
        <${Text} dimColor>  ${TABS.find((t) => t.key === state.tab).hint} · ? помощь<//>
      <//>
      ${state.help ? html`<${Help} />` : state.modal ? html`<${Modal} modal=${state.modal} />` : html`<${Body} state=${state} item=${item} width=${width} now=${now} />`}
      <${Log} lines=${state.log} />
      <${Text} dimColor>q выход · x прервать · R обновить · o открыть в браузере${state.error ? ` · ❌ ${state.error}` : ''}<//>
    <//>
  `;
}

const Help = () =>
  html`<${Box} flexDirection="column" paddingY=${1}>
    <${Text} bold>Клавиши<//>
    <${Text}>1/2/3, Tab — вкладки · ↑↓ или j/k — курсор · PgUp/PgDn — на 10<//>
    <${Text}>a — конфликт · t — треды · r — ревью (вкладка MR) · n — разбор задачи (вкладка Задачи)<//>
    <${Text}>s — сменить статус задачи (вкладка Задачи, единственная запись в Jira)<//>
    <${Text}>x — прервать все запуски · R — перечитать список · o — открыть в браузере · q — выход<//>
    <${Text} dimColor>Запуски переживают выход: события пишутся в ~/.local/state/fs-harness/runs/${'<id>'}/events.jsonl<//>
  <//>`;

const Modal = ({ modal }) =>
  html`<${Box} flexDirection="column" height=${12} borderStyle="round" borderColor="cyan" paddingX=${1}>
    <${Text} bold>${modal.title}<//>
    ${modal.items.map((t, i) => html`<${Text} key=${t.id} inverse=${i === modal.cursor}>${t.name}${t.to !== t.name ? ` → ${t.to}` : ''}<//>`)}
    <${Text} dimColor>Enter — перевести · Esc — отмена<//>
  <//>`;

function Body({ state, item, width, now }) {
  const listWidth = Math.max(28, Math.floor(width * 0.42));
  const rows = state.items[state.tab];
  const cursor = state.cursor[state.tab];
  return html`
    <${Box} height=${12}>
      <${Box} flexDirection="column" width=${listWidth} borderStyle="round" borderColor="gray">
        ${state.loading[state.tab] ? html`<${Text} dimColor>загружаю…<//>` : rows.slice(Math.max(0, cursor - 8), Math.max(0, cursor - 8) + 10).map((r, i, arr) => {
          const idx = Math.max(0, cursor - 8) + i;
          return html`<${Text} key=${rowKey(r, idx)} inverse=${idx === cursor}>${truncate(rowLabel(state.tab, r), listWidth - 3)}<//>`;
        })}
        ${!state.loading[state.tab] && !rows.length ? html`<${Text} dimColor>пусто<//>` : null}
      <//>
      <${Box} flexDirection="column" flexGrow=${1} borderStyle="round" borderColor="gray">
        ${item ? html`<${Details} tab=${state.tab} item=${item} />` : html`<${Text} dimColor>нечего показывать<//>`}
        ${Object.values(state.runs).slice(-4).map((r) => html`
          <${Text} key=${r.id}>${r.done ? (r.ok ? '✅' : '❌') : '⏳'} ${r.action} ${r.target} · ${r.phase}${r.decision ? ` · ${r.decision}` : ''}${r.cost ? ` · $${r.cost.toFixed(2)}` : ''}<//>
        `)}
      <//>
    <//>
  `;
}

const rowKey = (r, i) => String(r.iid ?? r.key ?? r.id ?? i);

function rowLabel(tab, r) {
  if (tab === 'mr') return `!${r.iid} ${cleanTitle(r)} ${r.has_conflicts ? '⚠' : ''}`;
  if (tab === 'issues') return `${r.key} ${r.fields?.summary ?? ''}`;
  return `${r.id} ${r.decision ?? r.state}`;
}

function Details({ tab, item }) {
  if (tab === 'mr') {
    return html`<${Box} flexDirection="column">
      <${Text} bold>!${item.iid} ${cleanTitle(item)}<//>
      <${Text} dimColor>${item.source_branch} → ${item.target_branch}<//>
      <${Text}>пайплайн ${statusIcon(item.pipeline?.status)} · конфликт ${item.has_conflicts ? '⚠' : '✅ нет'} · обновлён ${humanize(item.updated_at)}<//>
      <${Text} dimColor>${item.web_url}<//>
    <//>`;
  }
  if (tab === 'issues') {
    return html`<${Box} flexDirection="column">
      <${Text} bold>${item.key} ${item.fields?.summary ?? ''}<//>
      <${Text} dimColor>${item.fields?.status?.name ?? '—'} · ${humanize(item.fields?.updated)}<//>
    <//>`;
  }
  return html`<${Box} flexDirection="column">
    <${Text} bold>${item.id}<//>
    <${Text} dimColor>${item.action} ${item.mr ? `!${item.mr}` : item.issue ?? ''} · ${item.state}${item.decision ? ` · ${item.decision}` : ''}${item.cost ? ` · $${item.cost.toFixed(2)}` : ''}<//>
    <${Text} dimColor>${item.dir}<//>
  <//>`;
}

const Log = ({ lines }) =>
  html`<${Box} flexDirection="column" height=${8} borderStyle="round" borderColor="gray">
    ${lines.slice(-6).map((l, i) => html`<${Text} key=${i} wrap="truncate-end">${l}<//>`)}
    ${!lines.length ? html`<${Text} dimColor>лог пуст — запусти действие клавишей<//>` : null}
  <//>`;
