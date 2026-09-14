import { execFile } from 'node:child_process';
import React, { useEffect, useReducer, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import htm from 'htm';
import {
  TABS, fieldsFor, promptRow, initialState, reduce, keyIntent, logLine, selected, activeRuns, totalCost,
  orderJobs, deploySlot, DEPLOY_JOB, mrRow, issueRow, runRow, detailLines, flowLines, visibleItems, onBoard, boardLanes, cardRows, toggleFilter, filterValueText, filterOptions, filterSummary, busyText,
} from './store.js';
import { listRuns } from '../agent/journal.js';
import { fieldText, editValueFor } from '../jira.js';
import { listTemplates, loadTemplate, userOverride, dropUserOverride } from '../prompts.js';
import { findCommand } from '../registry.js';
import { runAction } from '../engine.js';
import { cmdMRS, toJSON, anyFilter } from '../commands/mrs.js';
import { buildJql } from '../commands/jira.js';
import { boardOf } from '../commands/jira.js';
import { cmdRun } from '../commands/run.js';
import { cmdDeploy } from '../commands/deploy.js';
import { statusIcon, commentStats } from '../format.js';

const html = htm.bind(React.createElement);

// Наверх списка полей — то, что правят чаще всего.
const EDIT_FIRST = ['Assignee', 'Ответственный разработчик', 'Ответственный тестировщик', 'Ответственный продакт', 'Priority'];
const rank = (name) => (EDIT_FIRST.indexOf(name) + 1 || 99);
const isTextList = (f) => f?.schema?.type === 'array' && f?.schema?.items === 'string';

const NARROW = 100; // уже этого две колонки не читаются, показываем одну
const EMPTY = { mr: 'нет открытых MR', issues: 'нет задач на тебе', runs: 'запусков ещё не было', prompts: 'шаблонов не нашлось' };

// Размер окна терминала: экран занимает его целиком и переживает ресайз.
function useTerminalSize() {
  const { stdout } = useStdout();
  const [size, setSize] = useState({ columns: stdout?.columns ?? 100, rows: stdout?.rows ?? 30 });
  useEffect(() => {
    if (!stdout?.on) return undefined;
    const onResize = () => setSize({ columns: stdout.columns ?? 100, rows: stdout.rows ?? 30 });
    stdout.on('resize', onResize);
    return () => stdout.off?.('resize', onResize);
  }, [stdout]);
  return size;
}

export function App({ ctx, opts }) {
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();
  const [state, dispatch] = useReducer(reduce, initialState(ctx.cfg.activeProject));
  const [now, setNow] = useState(Date.now()); // тик: по нему же считается «идёт 12с»
  const runsRef = useRef(new Map()); // id → AgentRun, чтобы было кого прерывать
  const bufferRef = useRef([]);
  const quitArmedRef = useRef(false);
  const pipeRef = useRef({ iid: null, pipelineId: null, busy: false });
  const jiraRef = useRef(null);
  const jira = () => (jiraRef.current ??= ctx.jira());

  // Любой запрос оборачиваем в подпись: пока он идёт, в шапке крутится спиннер с ней.
  // Без этого экран выглядит зависшим — половина запросов к GitLab и Jira идёт секундами.
  async function withBusy(label, fn) {
    dispatch({ type: 'busy', label, on: true, at: Date.now() });
    try {
      return await fn();
    } finally {
      dispatch({ type: 'busy', label, on: false });
    }
  }

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

  // Пока джоба крутится, панель обновляется сама: без этого статусы врут.
  useEffect(() => {
    const id = setInterval(() => { if (pipeRef.current.busy) refreshPipeline().catch(() => {}); }, 5000);
    return () => clearInterval(id);
  }, []);

  // Текст промпта читается с диска для выбранной строки: файлы маленькие, кеш на имя.
  const promptName = state.tab === 'prompts' ? selected(state)?.name ?? null : null;
  useEffect(() => {
    if (!promptName || state.prompts[promptName] !== undefined) return;
    try {
      dispatch({ type: 'promptBody', name: promptName, body: loadTemplate(promptName, { projectDir: ctx.cfg.projectDir }).body });
    } catch (err) {
      dispatch({ type: 'promptBody', name: promptName, body: `не прочитался: ${err.message}` });
    }
  }, [promptName]);

  // Карточка задачи целиком — отдельным запросом и только для выбранной строки.
  const issueKey = state.tab === 'issues' ? selected(state)?.key ?? null : null;
  useEffect(() => {
    if (!issueKey || state.details[issueKey]) return undefined;
    let alive = true;
    withBusy(`карточка ${issueKey}`, async () => {
      const j = jira();
      const [issue, comments] = await Promise.all([j.issue(issueKey), j.comments(issueKey).catch(() => null)]);
      if (alive) dispatch({ type: 'issueDetails', key: issueKey, issue, comments: comments?.comments ?? [] });
    }).catch((err) => dispatch({ type: 'error', tab: 'issues', message: err.message }));
    return () => { alive = false; };
  }, [issueKey]);

  async function load(tab) {
    dispatch({ type: 'loading', tab });
    try {
      if (tab === 'mr') {
        // Под фильтрами короткого пути нет: конфликты и треды считаются только после дозагрузки.
        if (anyFilter(state.filters.mr)) {
          const res = await withBusy('список MR под фильтрами', () => cmdMRS(ctx.g, ctx.repo, { asObject: true, ...state.filters.mr }));
          dispatch({ type: 'items', tab, items: res.mrs });
        } else {
          // Список MR приходит быстро, а треды, аппрувы и пайплайны — это запрос на каждый MR.
          // Поэтому в два захода: сперва показываем что есть, потом дополняем строки маркерами.
          const mrs = await withBusy('список MR', () => ctx.g.listOpenMRs(ctx.repo));
          dispatch({ type: 'items', tab, items: mrs.map((mr) => toJSON({ mr, stats: commentStats(null, mr.user_notes_count) })) });
          withBusy('треды, аппрувы и пайплайны', () => cmdMRS(ctx.g, ctx.repo, { asObject: true }))
            .then((full) => dispatch({ type: 'items', tab, items: full.mrs }))
            .catch(() => {}); // не дополнилось — список и так на экране
        }
      }
      if (tab === 'runs') dispatch({ type: 'items', tab, items: listRuns({ limit: 30 }) });
      if (tab === 'prompts') dispatch({ type: 'items', tab, items: listTemplates({ projectDir: ctx.cfg.projectDir }) });
      if (tab === 'issues') {
        const jql = buildJql({ ...state.filters.issues, componentField: ctx.cfg.jira?.componentField });
        const { issues } = await withBusy('задачи Jira', () =>
          jira().searchJql({ jql, fields: ['summary', 'status', 'updated', 'issuetype', 'priority', 'assignee'] }));
        dispatch({ type: 'items', tab, items: issues });
      }
    } catch (err) {
      dispatch({ type: 'error', tab, message: err.message });
    }
  }

  // Пайплайн выбранного MR: показываем то же, что GitLab, и запускаем джобы отсюда.
  async function openPipeline() {
    const item = selected(state);
    if (!item?.iid) return;
    const id = item.pipeline_stale ? null : item.pipeline?.id;
    pipeRef.current = { iid: item.iid, pipelineId: id, busy: false };
    // Панель открывается сразу, джобы приезжают следом: иначе клавиша молчит секунду-две.
    dispatch({
      type: 'modalOpen',
      kind: 'pipeline',
      title: `!${item.iid} · пайплайн${id ? ` #${id}` : ''}`,
      mr: item.iid,
      items: [],
      note: id ? 'загружаю джобы…' : 'Пайплайна нет или он устарел — запуск джобы создаст новый.',
      busy: Boolean(id),
    });
    if (!id) return void dispatch({ type: 'modalItems', items: [{ id: 0, name: 'build_image', stage: 'build', status: 'нет пайплайна' }] });
    const jobs = orderJobs(await withBusy('джобы пайплайна', () => ctx.g.getJobs(ctx.repo, id)));
    dispatch({ type: 'modalItems', items: jobs, busy: false, note: '' });
  }

  // Запуск джобы из панели. deploy_dev* идёт цепочкой через deploy: сборка,
  // ожидание её успеха и только потом сам деплой — как это делает GitLab по кнопке.
  async function runJob() {
    const { items, cursor, mr } = state.modal;
    const job = items[cursor];
    if (!job || pipeRef.current.busy) return;
    pipeRef.current.busy = true;
    dispatch({ type: 'modalItems', items, busy: true });
    const tag = `!${mr} ${job.name}`;
    const onTick = (line) => bufferRef.current.push(`${tag} ▸ ${line}`);
    const chain = DEPLOY_JOB.test(job.name);
    bufferRef.current.push(`${tag} ▸ ${chain ? 'сборка → ожидание → деплой' : 'запуск'}…`);
    try {
      await withBusy(`джоба ${job.name}`, () => (chain
        ? cmdDeploy(ctx.g, ctx.repo, [String(mr), deploySlot(job.name)], { asObject: true, quiet: true, onTick, buildJob: ctx.cfg.buildJob || undefined })
        : cmdRun(ctx.g, ctx.repo, [job.name, String(mr)], { asObject: true, quiet: true, watch: true, onTick })));
      bufferRef.current.push(`${tag} ▸ ✅ готово`);
    } catch (err) {
      bufferRef.current.push(`${tag} ▸ ❌ ${err.message.split('\n')[0]}`);
    } finally {
      pipeRef.current.busy = false;
      await refreshPipeline();
      load('mr');
    }
  }

  // Перечитать джобы панели: и по таймеру во время работы, и сразу после неё.
  async function refreshPipeline() {
    const { iid, pipelineId } = pipeRef.current;
    if (!iid) return;
    let id = pipelineId;
    if (!id) {
      const mr = await ctx.g.getMR(ctx.repo, iid);
      id = mr?.head_pipeline?.id ?? null;
      pipeRef.current.pipelineId = id;
    }
    if (!id) return;
    dispatch({ type: 'modalItems', items: orderJobs(await ctx.g.getJobs(ctx.repo, id)), busy: pipeRef.current.busy, note: '' });
  }

  // Смена статуса задачи: сначала список переходов, потом выбор.
  async function openTransitions() {
    const item = selected(state);
    if (!item?.key) return;
    dispatch({ type: 'modalOpen', title: `${item.key}: куда переводим?`, issue: item.key, items: [], note: 'загружаю переходы…', busy: true });
    try {
      const { transitions = [] } = (await withBusy('переходы задачи', () => jira().transitions(item.key))) ?? {};
      if (!transitions.length) {
        dispatch({ type: 'modalClose' });
        return void bufferRef.current.push(`${item.key} ▸ доступных переходов нет`);
      }
      dispatch({ type: 'modalItems', items: transitions.map((t) => ({ id: t.id, name: t.name, to: t.to?.name ?? t.name })), busy: false, note: '' });
    } catch (err) {
      dispatch({ type: 'modalClose' });
      dispatch({ type: 'error', tab: 'issues', message: err.message });
    }
  }

  async function applyTransition() {
    const { issue, items, cursor } = state.modal;
    const t = items[cursor];
    if (!t) return;
    dispatch({ type: 'modalItems', busy: true, note: `перевожу в ${t.to}…` });
    try {
      await withBusy(`перевод ${issue}`, () => jira().transition(issue, t.id));
      bufferRef.current.push(`${issue} ▸ статус → ${t.to}`);
      dispatch({ type: 'modalClose' });
      load('issues');
    } catch (err) {
      dispatch({ type: 'modalClose' });
      bufferRef.current.push(`${issue} ▸ ❌ ${err.message}`);
    }
  }

  // Спринты берём с доски самой задачи: у активного спринта boardId уже указан.
  async function openSprints() {
    const item = selected(state);
    if (!item?.key) return;
    dispatch({ type: 'modalOpen', kind: 'sprint', title: `${item.key}: в какой спринт?`, issue: item.key, items: [], note: 'загружаю спринты доски…', busy: true });
    try {
      const { values = [] } = (await withBusy('спринты доски', async () => {
        const full = state.details[item.key]?.issue ?? (await jira().issue(item.key));
        return jira().sprints(await boardOf(jira(), full));
      })) ?? {};
      if (!values.length) {
        dispatch({ type: 'modalClose' });
        return void bufferRef.current.push(`${item.key} ▸ активных спринтов на доске нет`);
      }
      dispatch({ type: 'modalItems', items: values.map((s) => ({ id: s.id, name: s.name, to: s.state })), busy: false, note: '' });
    } catch (err) {
      dispatch({ type: 'modalClose' });
      dispatch({ type: 'error', tab: 'issues', message: err.message });
    }
  }

  async function applySprint() {
    const { issue, items, cursor } = state.modal;
    const s = items[cursor];
    if (!s) return;
    dispatch({ type: 'modalItems', busy: true, note: `переношу в ${s.name}…` });
    try {
      await withBusy(`спринт ${issue}`, () => jira().moveToSprint(s.id, [issue]));
      bufferRef.current.push(`${issue} ▸ спринт → ${s.name}`);
      dispatch({ type: 'modalClose' });
      await reloadIssue(issue);
    } catch (err) {
      dispatch({ type: 'modalClose' });
      bufferRef.current.push(`${issue} ▸ ❌ ${err.message}`);
    }
  }

  async function submitComment(text) {
    const { issue } = state.modal;
    if (!text.trim()) return void dispatch({ type: 'modalClose' });
    dispatch({ type: 'modalEdit', editing: null, value: '' });
    dispatch({ type: 'modalItems', busy: true, note: 'публикую комментарий…' });
    try {
      await withBusy(`комментарий ${issue}`, () => jira().addComment(issue, text));
      bufferRef.current.push(`${issue} ▸ комментарий опубликован`);
      dispatch({ type: 'modalClose' });
      await reloadIssue(issue);
    } catch (err) {
      dispatch({ type: 'modalClose' });
      bufferRef.current.push(`${issue} ▸ ❌ ${err.message}`);
    }
  }

  async function reloadIssue(key) {
    await withBusy(`карточка ${key}`, async () => {
      const j = jira();
      const [issue, comments] = await Promise.all([j.issue(key), j.comments(key).catch(() => null)]);
      dispatch({ type: 'issueDetails', key, issue, comments: comments?.comments ?? [] });
    });
  }

  // Колонки доски читаем один раз: это настройка проекта, за сессию она не меняется.
  async function loadColumns() {
    if (state.columns.length) return;
    try {
      const j = jira();
      const projectKey = ctx.cfg.jira?.projectKey || selected(state)?.key?.split('-')[0];
      const { values: boards = [] } = (await j.boards(projectKey)) ?? {};
      if (!boards.length) throw new Error(`у проекта ${projectKey} нет доски`);
      const conf = await withBusy('колонки доски', () => j.boardConfig(boards[0].id));
      dispatch({ type: 'columns', columns: conf?.columnConfig?.columns ?? [] });
    } catch (err) {
      dispatch({ type: 'error', tab: 'issues', message: `доска: ${err.message}` });
    }
  }

  // Перенос карточки — это переход по статусу: ищем тот, что ведёт в статус соседней колонки.
  async function moveCard(by) {
    const item = selected(state);
    const cols = boardLanes(state);
    const target = state.columns.find((c) => c.name === cols[state.boardCursor.col + by]?.name);
    if (!item?.key || !target) return;
    const ids = new Set((target.statuses ?? []).map((st) => String(st.id)));
    try {
      const j = jira();
      const { transitions = [] } = await withBusy(`переходы ${item.key}`, () => j.transitions(item.key));
      const hit = transitions.find((t) => ids.has(String(t.to?.id)));
      if (!hit) {
        bufferRef.current.push(`${item.key} ▸ ❌ в «${target.name}» отсюда перехода нет`);
        return;
      }
      await withBusy(`${item.key} → ${hit.to?.name ?? hit.name}`, () => j.transition(item.key, hit.id));
      bufferRef.current.push(`${item.key} ▸ ${hit.to?.name ?? hit.name}`);
      dispatch({ type: 'boardMove', col: by });
      await load('issues');
    } catch (err) {
      bufferRef.current.push(`${item.key} ▸ ❌ ${err.message}`);
    }
  }

  // Что у задачи можно править, спрашиваем у самой Jira: editmeta знает и список полей,
  // и форму значения. Показываем только то, что есть чем заполнить — люди и готовые опции.
  async function openEditFields() {
    const item = selected(state);
    if (!item?.key) return;
    dispatch({ type: 'modalOpen', kind: 'editField', title: `${item.key}: изменить поле`, issue: item.key, items: [], busy: true, note: 'читаю, что можно править…' });
    try {
      const meta = await withBusy('редактируемые поля', () => jira().editMeta(item.key));
      const fields = Object.entries(meta?.fields ?? {})
        .filter(([, f]) => f.allowedValues?.length || f.schema?.type === 'user' || f.schema?.items === 'user' || isTextList(f))
        .map(([id, f]) => ({ id, label: f.name ?? id, meta: f }))
        .sort((a, b) => rank(a.label) - rank(b.label) || a.label.localeCompare(b.label));
      dispatch({ type: 'modalItems', items: fields, busy: false, note: fields.length ? '' : 'править нечего' });
    } catch (err) {
      dispatch({ type: 'modalItems', items: [], busy: false, note: `❌ ${err.message}` });
    }
  }

  async function openEditValue() {
    const field = state.modal.items[state.modal.cursor];
    const key = state.modal.issue;
    if (!field) return;
    // Списки строк (Labels) Jira не перечисляет — их набирают через запятую.
    if (isTextList(field.meta)) {
      const now = (state.details[key]?.issue?.fields?.[field.id] ?? []).join(', ');
      return void dispatch({ type: 'modalOpen', kind: 'editValue', title: `${key} · ${field.label}`, issue: key, field: field.id, meta: field.meta, items: [], editing: field.id, value: now });
    }
    dispatch({ type: 'modalOpen', kind: 'editValue', title: `${key} · ${field.label}`, issue: key, field: field.id, meta: field.meta, items: [], busy: true, note: 'читаю значения…' });
    try {
      const opts = field.meta.allowedValues?.length
        ? field.meta.allowedValues.map((v) => ({ id: v.id, value: v.value ?? v.name, label: fieldText(v) || String(v.id) }))
        : (await withBusy('люди проекта', () => jira().assignableUsers(key))).map((u) => ({ accountId: u.accountId, label: u.displayName }));
      dispatch({ type: 'modalItems', items: [{ label: '— очистить', clear: true }, ...opts], busy: false, note: '' });
    } catch (err) {
      dispatch({ type: 'modalItems', items: [], busy: false, note: `❌ ${err.message}` });
    }
  }

  async function applyEditValue(text) {
    const { issue, field, meta, items, cursor } = state.modal;
    const opt = text === undefined ? items[cursor] : null;
    if (text === undefined && !opt) return;
    const value = text === undefined ? editValueFor(meta, opt.clear ? null : opt) : text.split(',').map((v) => v.trim()).filter(Boolean);
    dispatch({ type: 'modalItems', busy: true, note: 'сохраняю…' });
    try {
      await withBusy(`${meta.name} у ${issue}`, () => jira().updateIssue(issue, { [field]: value }));
      dispatch({ type: 'modalClose' });
      bufferRef.current.push(`${issue} ▸ ${meta.name}: ${text !== undefined ? value.join(', ') || 'очищено' : opt.clear ? 'очищено' : opt.label}`);
      await reloadIssue(issue);
    } catch (err) {
      dispatch({ type: 'modalItems', busy: false, note: `❌ ${err.message}` });
    }
  }

  // Свой промпт — копия в ~/.config/fs-harness/prompts. В проектный каталог не пишем:
  // он лежит в чужом репозитории, туда кладёт файлы только человек.
  function promptSource(makeOwn) {
    const item = selected(state);
    if (!item?.name) return;
    try {
      const res = makeOwn ? userOverride(item.name, { projectDir: ctx.cfg.projectDir }) : dropUserOverride(item.name);
      bufferRef.current.push(
        makeOwn
          ? `${item.name} ▸ ${res.created ? 'свой промпт создан' : 'свой промпт уже был'}: ${res.path}`
          : `${item.name} ▸ ${res.removed ? 'свой промпт удалён, снова встроенный' : 'своего промпта и не было'}`,
      );
      dispatch({ type: 'promptBody', name: item.name, body: undefined });
      load('prompts');
    } catch (err) {
      bufferRef.current.push(`${item.name} ▸ ❌ ${err.message}`);
    }
  }

  // Фильтры — те же, что у флагов CLI, только выбираются с клавиш. У каждой вкладки свои.
  const myFilters = () => state.filters[state.tab] ?? {};

  function openFilters() {
    const tab = state.tab;
    dispatch({ type: 'modalOpen', kind: 'filters', title: tab === 'mr' ? 'Фильтры списка MR' : 'Фильтры списка задач', items: fieldsFor(tab) });
  }

  async function applyFilterRow() {
    const fields = fieldsFor(state.tab);
    const field = fields[state.modal.cursor];
    if (field.type === 'text') return void dispatch({ type: 'modalEdit', editing: field.key, value: myFilters()[field.key] ?? '' });
    if (field.type === 'option') {
      const known = state.tab === 'mr' ? filterOptions(field.key, state.items.mr) : state.options.issues[field.key];
      const cursor = (items) => Math.max(0, items.findIndex((o) => o.value === (myFilters()[field.key] ?? null)));
      if (known) return void dispatch({ type: 'modalOpen', kind: 'filterValue', title: `Фильтр: ${field.label}`, field: field.key, items: known, cursor: cursor(known) });
      // Варианты фильтров задач знает только Jira: спрашиваем один раз и держим до перезапуска.
      dispatch({ type: 'modalOpen', kind: 'filterValue', title: `Фильтр: ${field.label}`, field: field.key, items: [], busy: true, note: 'читаю варианты…' });
      try {
        const items = await withBusy(`варианты «${field.label}»`, () => issueFilterOptions(field.key));
        dispatch({ type: 'filterOptions', key: field.key, items });
        dispatch({ type: 'modalItems', items, busy: false, note: '' });
        dispatch({ type: 'modalMove', by: cursor(items) });
      } catch (err) {
        dispatch({ type: 'modalItems', items: [], busy: false, note: `❌ ${err.message}` });
      }
      return;
    }
    dispatch({ type: 'filters', filters: toggleFilter(myFilters(), field.key) });
  }

  // Откуда Jira берёт варианты: люди проекта, статусы проекта, спринты доски и опции поля-компонента.
  async function issueFilterOptions(key) {
    const j = jira();
    const projectKey = ctx.cfg.jira?.projectKey || selected(state)?.key?.split('-')[0];
    if (key === 'assignee') {
      const users = await j.projectUsers(projectKey);
      return [{ value: 'me', label: 'я' }, { value: 'any', label: 'все' }, ...users.map((u) => ({ value: u.displayName, label: u.displayName }))];
    }
    if (key === 'status') {
      const byType = await j.statuses(projectKey);
      const names = [...new Set(byType.flatMap((t) => (t.statuses ?? []).map((st) => st.name)))].sort();
      return [{ value: null, label: '— любой незакрытый' }, ...names.map((n) => ({ value: n, label: n }))];
    }
    if (key === 'sprint') {
      const { values: boards = [] } = (await j.boards(projectKey)) ?? {};
      const { values: sprints = [] } = boards.length ? (await j.sprints(boards[0].id)) ?? {} : {};
      return [
        { value: null, label: '— любой' },
        { value: 'current', label: 'текущий' },
        ...sprints.map((sp) => ({ value: sp.name, label: `${sp.name} (${sp.state})` })),
      ];
    }
    // Компонент — обычное поле задачи, его варианты лежат в editmeta любой задачи проекта.
    const item = selected(state);
    const meta = item?.key ? await j.editMeta(item.key) : { fields: {} };
    const field = Object.values(meta.fields ?? {}).find((f) => f.name === (ctx.cfg.jira?.componentField || 'Компонент'));
    return [{ value: null, label: '— любой' }, ...(field?.allowedValues ?? []).map((v) => ({ value: v.value ?? v.name, label: v.value ?? v.name }))];
  }

  function applyFilterValue() {
    const { field, items, cursor } = state.modal;
    dispatch({ type: 'filters', filters: { ...myFilters(), [field]: items[cursor]?.value ?? null } });
    openFilters();
  }

  function submitFilter(value) {
    const key = state.modal.editing;
    dispatch({ type: 'modalEdit', editing: null, value: '' });
    dispatch({ type: 'filters', filters: { ...myFilters(), [key]: value.trim() || null } });
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

  const editing = state.modal?.editing ?? null;

  // Пока набирают текст, все клавиши принадлежат полю ввода — кроме Esc, он отменяет ввод.
  // В окне комментария кроме ввода ничего нет, поэтому Esc закрывает его целиком.
  useInput((input, key) => {
    if (!key.escape) return;
    if (state.modal?.kind === 'comment') return void dispatch({ type: 'modalClose' });
    if (state.modal?.kind === 'editValue') return void openEditFields(); // назад к списку полей
    dispatch({ type: 'modalEdit', editing: null, value: '' });
  }, { isActive: Boolean(editing) });

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
    if (intent.type === 'sprint') return void openSprints();
    if (intent.type === 'comment') {
      const item = selected(state);
      if (item?.key) dispatch({ type: 'modalOpen', kind: 'comment', title: `${item.key}: комментарий`, issue: item.key, items: [], editing: 'comment' });
      return;
    }
    if (intent.type === 'openFilters') return openFilters();
    if (intent.type === 'searchOpen' || intent.type === 'searchClose') return void dispatch(intent);
    if (intent.type === 'editField') return void openEditFields();
    if (intent.type === 'boardToggle') {
      dispatch(intent);
      if (!state.board) loadColumns();
      return;
    }
    if (intent.type === 'boardMove') return void dispatch(intent);
    if (intent.type === 'moveCard') return void moveCard(intent.by);
    if (intent.type === 'promptOverride' || intent.type === 'promptDrop') return promptSource(intent.type === 'promptOverride');
    if (intent.type === 'pipeline') return void openPipeline().catch((err) => dispatch({ type: 'error', tab: 'mr', message: err.message }));
    if (intent.type === 'modalApply') {
      if (state.modal.busy) return; // запрос уже идёт, второй Enter только навредит
      const kind = state.modal.kind;
      if (kind === 'pipeline') return void runJob();
      if (kind === 'sprint') return void applySprint();
      if (kind === 'filters') return void applyFilterRow();
      if (kind === 'filterValue') return applyFilterValue();
      if (kind === 'editField') return void openEditValue();
      if (kind === 'editValue') return void applyEditValue();
      return void applyTransition();
    }
    if (intent.type === 'modalClear') {
      if (state.modal.kind !== 'filters') return;
      return void dispatch({ type: 'filters', filters: { ...myFilters(), [fieldsFor(state.tab)[state.modal.cursor].key]: null } });
    }
    if (intent.type === 'modalClose') {
      if (state.modal.kind === 'filterValue') return openFilters(); // назад к списку полей, а не наружу
      if (state.modal.kind === 'editValue') return void openEditFields();
      const wasFilters = state.modal.kind === 'filters';
      dispatch(intent);
      if (wasFilters) load(state.tab);
      return;
    }
    if (intent.type === 'open') {
      const url = selected(state)?.web_url;
      if (url) execFile('open', [url], () => {});
      return;
    }
    if (intent.type === 'reload') return load(state.tab);
    if (intent.type === 'tab') { dispatch(intent); if (!state.items[intent.tab].length) load(intent.tab); return; }
    dispatch(intent);
  }, { isActive: !editing });

  // Раскладка по высоте окна: шапка, вкладки с подсказкой, тело, карточки ранов, лог, низ.
  const height = Math.max(16, rows - 1);
  const cards = Object.values(state.runs).slice(-3);
  const logInner = Math.min(12, Math.max(3, Math.floor((height - 8) * 0.3)));
  const bodyInner = Math.max(4, height - 8 - logInner - cards.length);
  const item = selected(state);
  const running = activeRuns(state);
  const hint = TABS.find((t) => t.key === state.tab).hint;
  const optionsFor = (key) => (state.tab === 'mr' ? filterOptions(key, state.items.mr) : state.options.issues[key] ?? []);
  const filters = state.tab === 'mr' || state.tab === 'issues'
    ? filterSummary(state.filters[state.tab], fieldsFor(state.tab), optionsFor)
    : '';

  return html`
    <${Box} flexDirection="column" width=${columns} height=${height}>
      <${Box} justifyContent="space-between" flexShrink=${0}>
        <${Box} minWidth=${0}>
          <${Text} bold color="cyan">fs-harness · ${state.project || ctx.repo}<//>
          ${state.busy.length
            ? html`<${Text} color="yellow" wrap="truncate-end">  <${Spinner} type="dots" /> ${busyText(state.busy, now)}…<//>`
            : null}
        <//>
        <${Box} flexShrink=${0}>
          <${Text} dimColor>запусков: ${running.length}${running.length ? ' ' : ''}${running.length ? html`<${Spinner} type="dots" />` : ''} · $${totalCost(state).toFixed(2)}<//>
        <//>
      <//>
      <${Box} flexShrink=${0}>
        ${TABS.map((t, i) => html`<${Text} key=${t.key} color=${state.tab === t.key ? 'cyan' : undefined} inverse=${state.tab === t.key}> [${i + 1}] ${t.title} <//>`)}
      <//>
      <${Text} dimColor wrap="truncate-end">${hint} · ? помощь${filters ? ` · фильтры: ${filters}` : ''}<//>
      ${state.help
        ? html`<${Help} height=${bodyInner} />`
        : state.modal
          ? html`<${Modal} modal=${state.modal} filters=${state.filters[state.tab] ?? {}} fields=${fieldsFor(state.tab)} optionsFor=${optionsFor} height=${bodyInner} onSubmit=${state.modal.kind === 'comment' ? submitComment : state.modal.kind === 'editValue' ? applyEditValue : submitFilter} onChange=${(v) => dispatch({ type: 'modalEdit', editing: state.modal.editing, value: v })} />`
          : html`<${Body} state=${state} item=${item} width=${columns} height=${bodyInner}
              onSearch=${(v) => dispatch({ type: 'searchEdit', value: v })} onSearchDone=${() => dispatch({ type: 'searchClose' })} />`}
      ${cards.map((r) => html`
        <${Text} key=${r.id} wrap="truncate-end">${r.done ? (r.ok ? '✅' : '❌') : '⏳'} ${r.action} ${r.target} · ${r.phase}${r.decision ? ` · ${r.decision}` : ''}${r.cost ? ` · $${r.cost.toFixed(2)}` : ''}<//>
      `)}
      <${Log} lines=${state.log} height=${logInner} offset=${state.scroll.log} focused=${state.focus === 'log'} />
      <${Text} dimColor wrap="truncate-end">q выход · x прервать · R обновить · o в браузере · Tab блок: ${state.focus === 'list' ? 'список' : state.focus === 'details' ? 'детали' : 'лог'} · ${position(state)}${state.error ? ` · ❌ ${state.error}` : ''}<//>
    <//>
  `;
}

// Где мы в списке — единственное место, где это видно, когда строк больше экрана.
const position = (state) => {
  if (onBoard(state)) {
    const cols = boardLanes(state);
    const col = cols[state.boardCursor.col];
    return col ? `${col.name}: ${state.boardCursor.row + 1}/${col.items.length}` : 'доска пуста';
  }
  const len = visibleItems(state).length;
  return len ? `${state.cursor[state.tab] + 1}/${len}` : '0/0';
};

const Help = ({ height }) =>
  html`<${Box} flexDirection="column" height=${height} borderStyle="round" borderColor="gray" paddingX=${1}>
    <${Text} bold>Клавиши<//>
    <${Text}>1/2/3 — вкладки · Tab — перенести фокус (список → детали → лог) · ↑↓ или j/k — курсор и прокрутка<//>
    <${Text}>a — решить конфликт · t — обработать тикеты · r — локальное ревью (вкладка MR)<//>
    <${Text}>p — пайплайн MR: все джобы и их запуск · f — фильтры списка MR<//>
    <${Text}>n — проанализировать задачу · s — статус · S — спринт · c — комментарий · e — раскрыть поля<//>
    <${Text}>E — изменить поле задачи: Assignee, Ответственный разработчик, Priority и всё, что даёт Jira<//>
    <${Text}>v — доска вместо списка задач: h/l — колонки, j/k — карточки, H/L — перенести карточку<//>
    <${Text}>/ — поиск по списку (терпит опечатки, ищет по всем полям) · f — фильтры списка MR<//>
    <${Text}>x — прервать все запуски · R — перечитать список · o — открыть в браузере · q — выход<//>
    <${Text} dimColor>Запуски переживают выход: события пишутся в ~/.local/state/fs-harness/runs/${'<id>'}/events.jsonl<//>
  <//>`;

function Modal({ modal, filters, fields, optionsFor, height, onSubmit, onChange }) {
  const body = () => {
    if (modal.kind === 'editValue' && modal.editing) {
      return html`<${Box} flexDirection="column">
        <${Box}><${Text}>› <//><${TextInput} value=${modal.value} onChange=${onChange} onSubmit=${onSubmit} /><//>
        <${Text} dimColor>через запятую · Enter — сохранить · Esc — назад к полям<//>
      <//>`;
    }
    if (modal.kind === 'comment') {
      return html`<${Box} flexDirection="column">
        <${Box}><${Text}>› <//><${TextInput} value=${modal.value} onChange=${onChange} onSubmit=${onSubmit} /><//>
        <${Text} dimColor>Enter — опубликовать в Jira · Esc — отмена<//>
      <//>`;
    }
    if (modal.kind === 'filters') {
      return html`<${Box} flexDirection="column">
        ${fields.map((f, i) => html`
          <${Text} key=${f.key} inverse=${i === modal.cursor && !modal.editing} wrap="truncate-end">${f.label.padEnd(28)} ${
            modal.editing === f.key ? html`<${TextInput} value=${modal.value} onChange=${onChange} onSubmit=${onSubmit} />` : filterValueText(f, filters[f.key], optionsFor(f.key))
          }<//>
        `)}
        <${Text} dimColor>Enter — задать или переключить · Backspace — сбросить · Esc — применить и закрыть<//>
      <//>`;
    }
    if (modal.kind === 'filterValue') {
      return html`<${Box} flexDirection="column">
        ${modal.items.slice(0, Math.max(1, height - 4)).map((o, i) => html`
          <${Text} key=${o.value ?? '—'} inverse=${i === modal.cursor} dimColor=${o.value === null} wrap="truncate-end">${o.label}<//>
        `)}
        ${modal.items.length > Math.max(1, height - 4) ? html`<${Text} dimColor>…ещё ${modal.items.length - Math.max(1, height - 4)}<//>` : null}
        <${Text} dimColor>Enter — выбрать · Esc — назад к фильтрам<//>
      <//>`;
    }
    if (modal.kind === 'pipeline') {
      return html`<${Box} flexDirection="column">
        ${modal.note ? html`<${Text} color="yellow">${modal.busy ? html`<${Spinner} type="dots" /> ` : ''}${modal.note}<//>` : null}
        ${modal.items.slice(0, Math.max(1, height - 4)).map((j, i) => html`
          <${Text} key=${j.id} inverse=${i === modal.cursor} wrap="truncate-end">${(j.stage ?? '—').padEnd(16)} ${j.name.padEnd(24)} ${statusIcon(j.status)} ${j.status}<//>
        `)}
        ${!modal.items.length ? html`<${Text} dimColor>джоб нет<//>` : null}
        <${Text} dimColor>Enter — запустить (deploy_dev* сам собирает build_image и ждёт его) · Esc — закрыть<//>
      <//>`;
    }
    const room = Math.max(1, height - 3);
    // Окно вокруг курсора: список полей задачи длиннее экрана, и без него выбор уезжает вслепую.
    const from = Math.max(0, Math.min(modal.cursor - Math.floor(room / 2), modal.items.length - room));
    return html`<${Box} flexDirection="column">
      ${modal.note ? html`<${Text} color="yellow">${modal.busy ? html`<${Spinner} type="dots" /> ` : ''}${modal.note}<//>` : null}
      ${modal.items.slice(from, from + room).map((t, i) => html`
        <${Text} key=${t.id ?? t.accountId ?? t.label} inverse=${from + i === modal.cursor} wrap="truncate-end">${t.label ?? t.name}${t.to && t.to !== t.name ? ` → ${t.to}` : ''}<//>
      `)}
      <${Text} dimColor>${modal.items.length > room ? `${modal.cursor + 1}/${modal.items.length} · ` : ''}Enter — применить · Esc — ${modal.kind === 'editValue' ? 'назад к полям' : 'отмена'}<//>
    <//>`;
  };
  return html`<${Box} flexDirection="column" height=${height} borderStyle="round" borderColor="cyan" paddingX=${1}>
    <${Text} bold>${modal.title}${modal.busy ? ' · работает…' : ''}<//>
    ${body()}
  <//>`;
}

function Body({ state, item, width, height, onSearch, onSearchDone }) {
  // Узкий терминал: две колонки по 40 знаков нечитаемы, поэтому показываем ту,
  // что в фокусе, и Tab становится переключателем «список ↔ карточка».
  const board = onBoard(state);
  const narrow = width < NARROW || board; // доске нужна вся ширина: колонки по 26 знаков
  const onDetails = state.focus === 'details';
  const listWidth = narrow ? width : Math.max(30, Math.floor(width * (state.tab === 'mr' ? 0.58 : 0.45)));
  const inner = Math.max(1, height - 2); // рамка сверху и снизу
  const detailsWidth = Math.max(20, (narrow ? width : width - listWidth) - 4); // минус рамка и padding
  return html`
    <${Box} height=${height}>
      ${narrow && onDetails ? null : html`<${Box} flexDirection="column" width=${listWidth} flexShrink=${0} overflow="hidden" paddingX=${1} borderStyle="round" borderColor=${state.focus === 'list' ? 'cyan' : 'gray'}>
        ${state.searching || state.search[state.tab]
          ? html`<${Box} flexShrink=${0}>
              <${Text} color="cyan">/ <//>
              ${state.searching
                ? html`<${TextInput} value=${state.search[state.tab]} onChange=${onSearch} onSubmit=${onSearchDone} />`
                : html`<${Text} wrap="truncate-end">${state.search[state.tab]}<//>`}
              <${Text} dimColor> · ${visibleItems(state).length} из ${state.items[state.tab].length}<//>
            <//>`
          : null}
        ${board
          ? html`<${Board} state=${state} height=${inner} width=${listWidth - 4} />`
          : html`<${List} state=${state} height=${state.searching || state.search[state.tab] ? inner - 1 : inner} width=${listWidth - 4} />`}
      <//>`}
      ${narrow && !onDetails ? null : html`<${Box} flexDirection="column" flexGrow=${1} minWidth=${0} overflow="hidden" paddingX=${1} borderStyle="round" borderColor=${onDetails ? 'cyan' : 'gray'}>
        <${Details} state=${state} item=${item} height=${inner} width=${detailsWidth} />
      <//>`}
    <//>
  `;
}

function List({ state, height, width }) {
  const rows = visibleItems(state);
  // Гасим список только пока показывать нечего: на обновлении старые строки полезнее пустоты.
  if (state.loading[state.tab] && !rows.length) return html`<${Text} dimColor>загружаю…<//>`;
  if (!rows.length) {
    const hint = state.search[state.tab]
      ? `ничего не нашлось по «${state.search[state.tab]}» · / — поправить запрос`
      : anyFilter(state.filters.mr) && state.tab === 'mr'
        ? 'под фильтры не попал ни один MR · f — фильтры'
        : `${EMPTY[state.tab]} · R — перечитать`;
    return html`<${Text} dimColor wrap="truncate-end">${hint}<//>`;
  }
  const per = (state.tab === 'mr' ? 2 : 1) + 1; // строка MR двухэтажная + разделитель под каждой
  const visible = Math.max(1, Math.floor(height / per));
  const cursor = state.cursor[state.tab];
  const start = Math.max(0, Math.min(cursor - Math.floor(visible / 2), rows.length - visible));
  return rows.slice(start, start + visible).flatMap((r, i) => {
    const active = start + i === cursor;
    const key = r.iid ?? r.key ?? r.name ?? r.id ?? i;
    const body = state.tab === 'mr'
      ? html`<${MRRow} key=${key} r=${r} active=${active} width=${width} />`
      : html`<${Box} key=${key} flexShrink=${0}>
          <${Marker} active=${active} />
          <${Text} wrap="truncate-end">${row(state.tab, r).parts.map((pt, j) => html`<${Text} key=${j} bold=${pt.bold || active} dimColor=${pt.dim} color=${pt.color}>${pt.text}<//>`)}<//>
        <//>`;
    // Тонкая бледная линия между строками: без неё список читается как сплошной абзац.
    return [body, html`<${Text} key=${`${key}-sep`} dimColor wrap="truncate-end">${'─'.repeat(Math.max(1, width))}<//>`];
  });
}

const row = (tab, r) => (tab === 'issues' ? issueRow(r) : tab === 'prompts' ? promptRow(r) : runRow(r));

const COL_MIN = 26; // уже этого карточка нечитаема

// Доска: те же колонки, что человек видит в Jira. Пустых нет, видимые листаются h/l.
function Board({ state, height, width }) {
  const cols = boardLanes(state);
  if (state.loading.issues && !cols.length) return html`<${Text} dimColor>загружаю…<//>`;
  if (!cols.length) return html`<${Text} dimColor>${state.columns.length ? 'ни одна задача не попала на доску' : 'колонки доски ещё не прочитаны'}<//>`;

  const fit = Math.max(1, Math.min(cols.length, Math.floor(width / COL_MIN)));
  const from = Math.max(0, Math.min(state.boardCursor.col - Math.floor(fit / 2), cols.length - fit));
  const colWidth = Math.floor(width / fit);
  const perCard = 3; // две строки карточки и отбивка
  const rows = Math.max(1, Math.floor((height - 1) / perCard));

  return html`<${Box} flexDirection="column">
    <${Box}>
      ${cols.slice(from, from + fit).map((c, i) => html`
        <${Box} key=${c.name} width=${colWidth} flexShrink=${0}>
          <${Text} bold color=${from + i === state.boardCursor.col ? 'cyan' : undefined} wrap="truncate-end">${c.name} ${c.items.length}<//>
        <//>
      `)}
    <//>
    <${Box}>
      ${cols.slice(from, from + fit).map((c, ci) => {
        const active = from + ci === state.boardCursor.col;
        const start = active ? Math.max(0, Math.min(state.boardCursor.row - Math.floor(rows / 2), c.items.length - rows)) : 0;
        return html`<${Box} key=${c.name} width=${colWidth} flexShrink=${0} flexDirection="column">
          ${c.items.slice(start, start + rows).flatMap((it, i) => {
            const here = active && start + i === state.boardCursor.row;
            return [
              ...cardRows(it).map((l, k) => html`<${Box} key=${`${it.key}-${k}`}>
                <${Marker} active=${here && k === 0} />
                <${Text} wrap="truncate-end">${l.parts.map((pt, j) => html`<${Text} key=${j} bold=${pt.bold || here} dimColor=${pt.dim} color=${pt.color}>${pt.text}<//>`)}<//>
              <//>`),
              html`<${Text} key=${`${it.key}-sep`} dimColor wrap="truncate-end">${'─'.repeat(Math.max(1, colWidth - 1))}<//>`,
            ];
          })}
        <//>`;
      })}
    <//>
  <//>`;
}

// Маркер курсора не жмётся: иначе на обрезанной строке ink съедает его ширину и строки разъезжаются.
const Marker = ({ active }) => html`<${Box} flexShrink=${0} width=${1}><${Text} color="cyan">${active ? '▌' : ' '}<//><//>`;

// Две строки на MR: заголовок с бейджами справа и метаданные снизу — как в списке GitLab.
function MRRow({ r, active, width = 40 }) {
  const { title, badges, meta } = mrRow(r);
  // Бейджи не жмутся и не переносятся: перенос ломает высоту строки и весь список уезжает.
  const room = width - 4 - badges.length;
  return html`<${Box} flexDirection="column" flexShrink=${0}>
    <${Box}>
      <${Marker} active=${active} />
      <${Box} flexGrow=${1} minWidth=${0}><${Text} bold color=${active ? 'cyan' : undefined} wrap="truncate-end">${title}<//><//>
      ${badges && room > 8 ? html`<${Box} flexShrink=${0}><${Text} wrap="truncate-end"> ${badges}<//><//>` : null}
    <//>
    <${Box}>
      <${Marker} active=${active} />
      <${Text} wrap="truncate-end">${meta.parts.map((p, i) => html`<${Text} key=${i} bold=${p.bold} dimColor=${p.dim} color=${p.color}>${p.text}<//>`)}<//>
    <//>
  <//>`;
}

function Details({ state, item, height, width }) {
  const full = item?.key ? state.details[item.key] : null;
  const lines = detailLines(state.tab, item, {
    full: full?.issue ?? null,
    comments: full?.comments ?? [],
    expand: state.expand,
    body: item?.name ? state.prompts[item.name] ?? '' : '',
  });
  const flowed = flowLines(lines, width);
  const off = Math.min(state.scroll.details, Math.max(0, flowed.length - height));
  return flowed.slice(off, off + height).map((l, i) => html`<${Line} key=${i} line=${l} />`);
}

// Строка из кусков: у каждого свой цвет. Пустая строка-разделитель рисуется пробелом,
// иначе ink схлопывает её и группы слипаются.
const Line = ({ line }) =>
  line.gap
    ? html`<${Text}> <//>`
    : html`<${Text} wrap="truncate-end">${line.parts.map((p, i) => html`<${Text} key=${i} bold=${p.bold} dimColor=${p.dim} color=${p.color}>${p.text}<//>`)}<//>`;

function Log({ lines, height, offset, focused }) {
  const inner = Math.max(1, height - 2);
  const end = Math.max(inner, lines.length - offset);
  return html`<${Box} flexDirection="column" height=${height} paddingX=${1} borderStyle="round" borderColor=${focused ? 'cyan' : 'gray'}>
    ${lines.slice(Math.max(0, end - inner), end).map((l, i) => html`<${Text} key=${i} wrap="truncate-end">${l}<//>`)}
    ${!lines.length ? html`<${Text} dimColor>лог пуст — запусти действие клавишей<//>` : null}
  <//>`;
}
