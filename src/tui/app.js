import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import React, { useEffect, useReducer, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdin, useStdout } from 'ink';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import htm from 'htm';
import {
  TABS, fieldsFor, promptRow, initialState, reduce, keyIntent, logLine, selected, activeRuns, totalCost,
  orderJobs, deploySlot, DEPLOY_JOB, mrRow, MR_FIELDS, mrFieldRow, issueCard, shiftLine, runRow, detailLines, flowLines, visibleItems, onBoard, boardLanes, cardRows, toggleFilter, filterValueText, filterOptions, filterSummary, busyText, gbRow, dictRow,
} from './store.js';
import { envStates } from '../growthbook.js';
import { listRuns, readRun } from '../agent/journal.js';
import { fieldText, editKind, editValueFor } from '../jira.js';
import { listTemplates, loadTemplate, userOverride, dropUserOverride } from '../prompts.js';
import { findCommand } from '../registry.js';
import { startChat } from '../chat.js';
import { HARNESS_DIR, buildAskBrief, lastFailedRun, pickChatAgent } from '../commands/ask.js';
import { runAction } from '../engine.js';
import { cmdMRS, toJSON, anyFilter } from '../commands/mrs.js';
import { buildJql } from '../commands/jira.js';
import { boardOf } from '../commands/jira.js';
import { cmdRun } from '../commands/run.js';
import { cmdDeploy } from '../commands/deploy.js';
import { statusIcon, commentStats } from '../format.js';

const html = htm.bind(React.createElement);

const attachSize = (n) => (n >= 1024 ? `${Math.round(n / 1024)} КБ` : `${n} Б`);

// Наверх списка полей — то, что правят чаще всего.
const EDIT_FIRST = ['Assignee', 'Ответственный разработчик', 'Ответственный тестировщик', 'Ответственный продакт', 'Priority'];
const rank = (name) => (EDIT_FIRST.indexOf(name) + 1 || 99);
// Значение в лог: от многострочного описания там нужна первая строка, не весь текст.
const valueText = (v) => (Array.isArray(v) ? v.join(', ') : String(v ?? '')).split('\n')[0].slice(0, 60) || 'очищено';

const NARROW = 100; // уже этого две колонки не читаются, показываем одну
const EMPTY = { mr: 'нет открытых MR', issues: 'нет задач на тебе', runs: 'нет процессов', prompts: 'шаблонов не нашлось', gb: 'флагов нет', dict: 'записей нет' };

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
  const { stdin, setRawMode, isRawModeSupported } = useStdin();
  const chatRef = useRef(null);
  const jiraRef = useRef(null);
  const jira = () => (jiraRef.current ??= ctx.jira());
  const gbRef = useRef(null);
  const gb = () => (gbRef.current ??= ctx.gb());
  const dictRef = useRef(null);
  const dict = () => (dictRef.current ??= ctx.dict());

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

  async function load(tab, pageArg) {
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
      if (tab === 'runs') dispatch({ type: 'items', tab, items: listRuns({ limit: 50 }) });
      if (tab === 'prompts') dispatch({ type: 'items', tab, items: listTemplates({ projectDir: ctx.cfg.projectDir }) });
      if (tab === 'gb') {
        const out = [];
        for (let offset = 0; ;) {
          const page = await withBusy('флаги GrowthBook', () => gb().features({ project: ctx.cfg.growthbook?.project || undefined, offset }));
          out.push(...page.features);
          if (page.nextOffset === null) break;
          offset = page.nextOffset;
        }
        dispatch({ type: 'items', tab, items: out.filter((f) => !f.archived).map((f) => ({ ...f, envs: envStates(f) })) });
      }
      if (tab === 'dict') {
        const res = await withBusy('словарь', () => dict().items({ page: pageArg ?? state.dictPage.page }));
        dispatch({ type: 'dictPage', meta: { page: res.page.number ?? pageArg ?? 1, size: res.page.size ?? 15, total: res.page.total ?? 0 } });
        dispatch({ type: 'items', tab, items: res.items });
      }
      if (tab === 'issues') {
        const jql = buildJql({ ...state.filters.issues, componentField: ctx.cfg.jira?.componentField });
        const { issues } = await withBusy('задачи Jira', () =>
          jira().searchJql({ jql, fields: ['summary', 'status', 'updated', 'issuetype', 'priority', 'assignee', 'labels', 'parent'] }));
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

  // Родитель с подзадачами: в списке от него виден один ключ, а контекст задачи обычно там.
  async function openParent() {
    const item = selected(state);
    const p = item?.fields?.parent;
    if (!p?.key) return void bufferRef.current.push(`${item?.key ?? '—'} ▸ родителя нет`);
    dispatch({ type: 'modalOpen', kind: 'parent', title: `${p.key} ${p.fields?.summary ?? ''}`, issue: p.key, items: [], busy: true, note: 'читаю родителя…' });
    try {
      const j = jira();
      const [parent, found] = await withBusy(`родитель ${p.key}`, () => Promise.all([
        j.issue(p.key),
        j.searchJql({ jql: `parent = ${p.key} ORDER BY status`, fields: ['summary', 'status', 'assignee'], max: 100 }),
      ]));
      const f = parent?.fields ?? {};
      const kids = found?.issues ?? [];
      dispatch({
        type: 'modalItems',
        busy: false,
        note: `${f.status?.name ?? '—'} · ${fieldText(f.assignee) || 'нету'} · подзадач: ${kids.length}`,
        items: kids.map((s) => ({
          id: s.key,
          label: `${s.key.padEnd(9)} ${(s.fields?.status?.name ?? '—').padEnd(14)} ${fieldText(s.fields?.assignee) || 'нету'} · ${s.fields?.summary ?? ''}`,
        })),
      });
    } catch (err) {
      dispatch({ type: 'modalItems', items: [], busy: false, note: `❌ ${err.message}` });
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

  // Мастер по самому fsh. Окно поверх TUI: агент работает в каталоге харнесса и правит его
  // же — гейт тут человек за клавиатурой, он видит каждый шаг. Первая реплика несёт бриф
  // об упавшем ране, дальше идёт обычный диалог в той же сессии агента.
  function openMaster() {
    if (state.modal) return; // поверх другого окна мастера не поднимаем
    const run = masterRun();
    const title = run?.error?.code ? `мастер fsh · ${run.id} · ${run.error.code}` : 'мастер fsh';
    dispatch({ type: 'modalOpen', kind: 'chat', title, items: [], editing: 'chat', value: '', lines: [], meta: { run, first: true } });
  }

  // О каком ране спрашивать: на вкладке процессов — о выделенном, иначе о последнем упавшем.
  function masterRun() {
    try {
      const item = state.tab === 'runs' ? selected(state) : null;
      if (item?.id) {
        const r = readRun(item.id);
        return { id: r.id, dir: r.dir, action: r.meta?.action ?? '', error: null, tail: [] };
      }
    } catch {
      // ран мог быть ещё живым и без meta.json — спросим про последний упавший
    }
    return lastFailedRun();
  }

  async function sendToMaster(text) {
    const said = String(text ?? '').trim();
    if (!said) return;
    const meta = state.modal?.meta ?? {};
    dispatch({ type: 'chatSay', role: 'me', text: said });
    dispatch({ type: 'modalEdit', editing: 'chat', value: '' });
    try {
      if (!chatRef.current) {
        const agent = pickChatAgent(ctx.cfg, null);
        dispatch({ type: 'chatNote', text: `${agent.name} думает…` });
        chatRef.current = startChat({
          agent,
          cwd: HARNESS_DIR,
          env: { ...process.env, ...agent.env },
          onEvent: (e) => {
            if (e.t === 'delta') return void dispatch({ type: 'chatDelta', text: e.text });
            if (e.t === 'activity') return void dispatch({ type: 'chatNote', text: e.text.slice(0, 120) });
          },
        });
      }
      // Бриф уходит только с первой репликой: дальше контекст держит сам агент.
      const prompt = meta.first ? buildAskBrief({ run: meta.run, question: said }) : said;
      if (meta.first) dispatch({ type: 'modalEdit', editing: 'chat', value: '', meta: { ...meta, first: false } });
      const answer = await chatRef.current.send(prompt);
      dispatch({ type: 'chatDone', text: answer || '(пустой ответ)' });
    } catch (err) {
      dispatch({ type: 'chatDone', role: '❌', text: err.message });
    }
  }

  function closeMaster() {
    chatRef.current?.close();
    chatRef.current = null;
    dispatch({ type: 'modalClose' });
  }

  // Вложения задачи. В editmeta их нет (заполнить полем нечем), поэтому окно своё:
  // список читаем отдельным запросом, Enter выгружает на диск, a переводит в ввод пути.
  async function openAttachments() {
    const item = selected(state);
    if (!item?.key) return;
    dispatch({ type: 'modalOpen', kind: 'attach', title: `${item.key}: вложения`, issue: item.key, items: [], busy: true, note: 'читаю вложения…' });
    try {
      const list = await withBusy('вложения', () => jira().attachments(item.key));
      const items = list.map((a) => ({
        id: String(a.id),
        filename: path.basename(a.filename ?? ''),
        content: a.content,
        label: `${path.basename(a.filename ?? '')}  ${attachSize(a.size ?? 0)}  ${a.author?.displayName ?? ''}`,
      }));
      dispatch({ type: 'modalItems', items, busy: false, note: items.length ? '' : 'вложений нет' });
    } catch (err) {
      dispatch({ type: 'modalItems', items: [], busy: false, note: `❌ ${err.message}` });
    }
  }

  // Имя файла приходит из Jira — это чужой ввод, на диск кладём только basename.
  async function downloadAttachment() {
    const a = state.modal.items[state.modal.cursor];
    const key = state.modal.issue;
    if (!a) return;
    try {
      const data = Buffer.from(await withBusy(`выгрузка ${a.filename}`, () => jira().attachmentData(a.content)));
      const dest = path.join(process.cwd(), path.basename(a.filename));
      writeFileSync(dest, data);
      bufferRef.current.push(`${key} ▸ ⬇️ ${dest}`);
    } catch (err) {
      bufferRef.current.push(`${key} ▸ ❌ ${err.message}`);
    }
  }

  async function uploadAttachment(text) {
    const key = state.modal.issue;
    const file = String(text ?? '').trim().replace(/^~(?=\/|$)/, homedir());
    if (!file) return void dispatch({ type: 'modalEdit', editing: null, value: '' });
    try {
      if (!existsSync(file)) throw new Error(`файла нет: ${file}`);
      await withBusy(`вложение ${path.basename(file)}`, () => jira().addAttachment(key, [{ name: path.basename(file), data: readFileSync(file) }]));
      bufferRef.current.push(`${key} ▸ 📎 ${path.basename(file)}`);
    } catch (err) {
      bufferRef.current.push(`${key} ▸ ❌ ${err.message}`);
    }
    await openAttachments();
  }

  // Что у задачи можно править, спрашиваем у самой Jira: editmeta знает и список полей,
  // и форму значения. Прячем только то, что заполнить нечем: вложения, связи, трекинг времени.
  async function openEditFields() {
    const item = selected(state);
    if (!item?.key) return;
    dispatch({ type: 'modalOpen', kind: 'editField', title: `${item.key}: изменить поле`, issue: item.key, items: [], busy: true, note: 'читаю, что можно править…' });
    try {
      const meta = await withBusy('редактируемые поля', () => jira().editMeta(item.key));
      const fields = Object.entries(meta?.fields ?? {})
        .filter(([, f]) => editKind(f))
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
    const kind = editKind(field.meta);
    const now = state.details[key]?.issue?.fields?.[field.id];
    // Многострочный текст (Описание и любое textarea) правим в $EDITOR: своего редактора в TUI нет.
    if (kind === 'editor') {
      dispatch({ type: 'modalClose' });
      return void editLong(key, field, typeof now === 'string' ? now : '');
    }
    // Списки строк (Labels), однострочный текст и числа Jira не перечисляет — их набирают руками.
    if (kind !== 'pick') {
      const value = kind === 'list' ? (now ?? []).join(', ') : now === null || now === undefined ? '' : String(now);
      return void dispatch({ type: 'modalOpen', kind: 'editValue', title: `${key} · ${field.label}`, issue: key, field: field.id, meta: field.meta, items: [], editing: field.id, value });
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
    const kind = editKind(meta);
    const value = text === undefined
      ? editValueFor(meta, opt.clear ? null : opt)
      : kind === 'list' ? text.split(',').map((v) => v.trim()).filter(Boolean)
        : kind === 'number' ? (text.trim() === '' ? null : Number(text))
          : text;
    dispatch({ type: 'modalItems', busy: true, note: 'сохраняю…' });
    try {
      await withBusy(`${meta.name} у ${issue}`, () => jira().updateIssue(issue, { [field]: value }));
      dispatch({ type: 'modalClose' });
      bufferRef.current.push(`${issue} ▸ ${meta.name}: ${text !== undefined ? valueText(value) : opt.clear ? 'очищено' : opt.label}`);
      await reloadIssue(issue);
    } catch (err) {
      dispatch({ type: 'modalItems', busy: false, note: `❌ ${err.message}` });
    }
  }

  // Поля MR правятся тем же окном, что и поля задачи: сперва список полей, потом значение.
  function openMRFields() {
    const mr = selected(state);
    if (!mr?.iid) return;
    dispatch({ type: 'modalOpen', kind: 'editField', title: `!${mr.iid}: изменить поле`, mr: mr.iid, items: MR_FIELDS.map((f) => ({ ...f, label: mrFieldRow(f, mr) })) });
  }

  async function openMRValue() {
    const field = state.modal.items[state.modal.cursor];
    const mr = state.items.mr.find((m) => m.iid === state.modal.mr);
    if (!field || !mr) return;
    const title = `!${mr.iid} · ${field.name}`;
    if (field.kind === 'flag') return void applyMR(mr.iid, field, !field.read(mr));
    if (field.kind === 'editor') {
      dispatch({ type: 'modalClose' });
      return void editLongMR(mr, field);
    }
    if (field.kind !== 'pick') {
      return void dispatch({ type: 'modalOpen', kind: 'editValue', title, mr: mr.iid, field: field.id, meta: field, items: [], editing: field.id, value: field.read(mr) });
    }
    dispatch({ type: 'modalOpen', kind: 'editValue', title, mr: mr.iid, field: field.id, meta: field, items: [], busy: true, note: 'читаю варианты…' });
    try {
      const opts = field.from === 'branches'
        ? ((await withBusy('ветки проекта', () => ctx.g.branches(ctx.repo))) ?? []).map((b) => ({ value: b.name, label: b.name }))
        : ((await withBusy('участники проекта', () => ctx.g.members(ctx.repo))) ?? []).map((u) => ({ value: u.id, label: `${u.name} (${u.username})` }));
      dispatch({ type: 'modalItems', items: [{ label: '— очистить', clear: true }, ...opts], busy: false, note: '' });
    } catch (err) {
      dispatch({ type: 'modalItems', items: [], busy: false, note: `❌ ${err.message}` });
    }
  }

  async function applyMRValue(text) {
    const { mr: iid, meta, items, cursor } = state.modal;
    const opt = text === undefined ? items[cursor] : null;
    if (text === undefined && !opt) return;
    let value;
    if (text === undefined) value = opt.clear ? (meta.id === 'assignee_ids' ? [] : '') : meta.id === 'assignee_ids' ? [opt.value] : opt.value;
    else if (meta.kind === 'list') value = text.split(',').map((v) => v.trim()).filter(Boolean).join(',');
    else if (meta.kind === 'users') {
      // Ревьюеров GitLab принимает только id, поэтому логины сначала ищем среди участников.
      const names = text.split(',').map((v) => v.trim().replace(/^@/, '')).filter(Boolean);
      const people = ((await withBusy('участники проекта', () => ctx.g.members(ctx.repo))) ?? []);
      const ids = names.map((n) => people.find((u) => u.username === n || u.name === n)?.id);
      const bad = names.filter((n, i) => !ids[i]);
      if (bad.length) return void dispatch({ type: 'modalItems', busy: false, note: `❌ нет таких участников: ${bad.join(', ')}` });
      value = ids;
    } else value = text;
    dispatch({ type: 'modalItems', busy: true, note: 'сохраняю…' });
    await applyMR(iid, meta, value);
  }

  async function applyMR(iid, field, value) {
    try {
      await withBusy(`${field.name} у !${iid}`, () => ctx.g.updateMR(ctx.repo, iid, { [field.id]: value }));
      dispatch({ type: 'modalClose' });
      bufferRef.current.push(`!${iid} ▸ ${field.name}: ${typeof value === 'boolean' ? (value ? 'да' : 'нет') : valueText(value)}`);
      load('mr');
    } catch (err) {
      dispatch({ type: 'modalItems', busy: false, note: `❌ ${err.message}` });
    }
  }

  async function editLongMR(mr, field) {
    let text;
    try {
      text = await openEditor(field.read(mr), `mr-${mr.iid}-${field.id}.md`);
    } catch (err) {
      return void bufferRef.current.push(`!${mr.iid} ▸ ${field.name}: ❌ ${err.message}`);
    }
    if (text === null) return void bufferRef.current.push(`!${mr.iid} ▸ ${field.name}: задай $EDITOR, без него многострочное поле не править`);
    if (text === field.read(mr)) return void bufferRef.current.push(`!${mr.iid} ▸ ${field.name}: без изменений`);
    await applyMR(mr.iid, field, text);
  }

  // Описание правится в $EDITOR, а не внутри TUI: редактор текста мы не пишем (PLAN, п. 16).
  async function editLong(key, field, now) {
    let text;
    try {
      text = await openEditor(now, `${key}-${field.id}.md`);
    } catch (err) {
      return void bufferRef.current.push(`${key} ▸ ${field.label}: ❌ ${err.message}`);
    }
    if (text === null) return void bufferRef.current.push(`${key} ▸ ${field.label}: задай $EDITOR, без него многострочное поле не править`);
    if (text === now) return void bufferRef.current.push(`${key} ▸ ${field.label}: без изменений`);
    try {
      await withBusy(`${field.label} у ${key}`, () => jira().updateIssue(key, { [field.id]: text }));
      bufferRef.current.push(`${key} ▸ ${field.label}: ${valueText(text)}`);
      await reloadIssue(key);
    } catch (err) {
      bufferRef.current.push(`${key} ▸ ${field.label}: ❌ ${err.message}`);
    }
  }

  // Пока человек в редакторе, ink отпускает ввод: иначе клавиши уходят обоим сразу.
  async function openEditor(text, name) {
    const editor = process.env.EDITOR || process.env.VISUAL;
    if (!editor) return null;
    const [bin, ...pre] = editor.split(' ').filter(Boolean); // EDITOR бывает с флагами: «code -w»
    const dir = mkdtempSync(path.join(tmpdir(), 'fsh-'));
    const file = path.join(dir, name.replace(/[^\w.-]/g, '_'));
    writeFileSync(file, text ?? '');
    try {
      if (isRawModeSupported) setRawMode(false);
      stdin.pause?.();
      await new Promise((res, rej) => {
        const child = spawn(bin, [...pre, file], { stdio: 'inherit' });
        child.on('error', rej);
        child.on('close', res);
      });
      return readFileSync(file, 'utf8');
    } finally {
      stdin.resume?.();
      if (isRawModeSupported) setRawMode(true);
      rmSync(dir, { recursive: true, force: true });
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
  // ── Вкладка флагов: CRUD GrowthBook ─────────────────────────────────

  function openGBCreate() {
    dispatch({ type: 'modalOpen', kind: 'gbCreate', title: 'Новый флаг: id', items: [], editing: 'id', value: '' });
  }

  function submitGBId(text) {
    const id = text.trim();
    if (!id) return void dispatch({ type: 'modalClose' });
    dispatch({ type: 'modalOpen', kind: 'gbState', title: `${id}: в каком состоянии создать?`, items: [
      { id: 'off', label: 'выключенным (безопасно)', on: false },
      { id: 'on', label: 'включённым', on: true },
    ] });
  }

  async function applyGBCreate() {
    const opt = state.modal.items[state.modal.cursor];
    const id = (state.modal.title ?? '').match(/^([^:]+):/)?.[1];
    if (!opt || !id) return void dispatch({ type: 'modalClose' });
    const env = ctx.cfg.growthbook?.env || 'production';
    dispatch({ type: 'modalItems', busy: true, note: 'создаю…' });
    try {
      await withBusy(`флаг ${id}`, () => gb().createFeature({
        id, valueType: 'boolean', defaultValue: 'true',
        ...(ctx.cfg.growthbook?.project ? { project: ctx.cfg.growthbook.project } : {}),
        environments: { [env]: { enabled: opt.on, rules: [] } },
      }));
      bufferRef.current.push(`${id} ▸ флаг создан (${env}=${opt.on ? 'on' : 'off'})`);
      dispatch({ type: 'modalClose' });
      load('gb');
    } catch (err) {
      dispatch({ type: 'modalItems', busy: false, note: `❌ ${err.message}` });
    }
  }

  function openGBToggle() {
    const f = selected(state);
    if (!f?.id) return;
    const envs = Object.entries(f.environments ?? {});
    if (!envs.length) return void bufferRef.current.push(`${f.id} ▸ у флага нет окружений`);
    dispatch({ type: 'modalOpen', kind: 'gbToggle', title: `${f.id}: окружение → вкл/выкл`, items: envs.map(([env, e]) => ({
      id: env,
      label: `${env} · сейчас ${e.enabled ? 'on' : 'off'} → станет ${e.enabled ? 'off' : 'on'}`,
      on: !e.enabled,
    })) });
  }

  async function applyGBToggle() {
    const t = state.modal.items[state.modal.cursor];
    const f = selected(state);
    if (!t || !f?.id) return;
    dispatch({ type: 'modalItems', busy: true, note: `переключаю ${t.id}…` });
    try {
      // Read-back: API отвечает 200 и на окружение, которого у флага нет.
      const res = await withBusy(`флаг ${f.id}`, () => gb().toggleFeature(f.id, { [t.id]: t.on }, `fsh tui: ${t.id} → ${t.on ? 'on' : 'off'}`));
      dispatch({ type: 'modalClose' });
      const after = res?.environments?.[t.id];
      const line = !after || after.enabled === undefined ? `${f.id} ▸ ${t.id} → ${t.on ? 'on' : 'off'} (в ответе нет окружения — проверь)`
        : Boolean(after.enabled) === t.on ? `${f.id} ▸ ${t.id} → ${t.on ? 'on' : 'off'}`
          : `${f.id} ▸ ❌ GrowthBook принял запрос, но ${t.id} остался ${after.enabled ? 'on' : 'off'}`;
      bufferRef.current.push(line);
      load('gb');
    } catch (err) {
      dispatch({ type: 'modalItems', busy: false, note: `❌ ${err.message}` });
    }
  }

  // ── Вкладка словаря: CRUD REST бэкенда ──────────────────────────────

  function openDictCreate() {
    dispatch({ type: 'modalOpen', kind: 'dictCreate', title: 'Новая запись: значение, ключ, группа, язык', items: [], editing: 'value', value: '', meta: {} });
  }

  async function submitDictField(text) {
    const field = state.modal.editing;
    const meta = { ...state.modal.meta, [field]: text.trim() };
    const next = { value: 'key', key: 'group', group: 'lang' }[field];
    // Накопленное — в modal.meta: следующим шагом submitDictField вызовется с новым state.
    if (next) return void dispatch({ type: 'modalEdit', editing: next, value: next === 'lang' ? 'ru' : '', meta });
    if (!meta.value || !meta.key || !meta.group) {
      return void dispatch({ type: 'modalItems', items: [], busy: false, note: '❌ нужны и значение, и ключ, и группа' });
    }
    dispatch({ type: 'modalEdit', editing: null, value: '' });
    dispatch({ type: 'modalItems', items: [], busy: true, note: 'создаю…' });
    try {
      const lang = await pickLanguage(meta.lang || 'ru');
      const item = await withBusy('создание записи', () => dict().create({ language_id: lang.language_id, group: meta.group, key: meta.key, value: meta.value }));
      bufferRef.current.push(`словарь ▸ создано ${meta.group}.${meta.key} (${item.dictionary_item_id})`);
      dispatch({ type: 'modalClose' });
      await refreshDictCache();
      load('dict');
    } catch (err) {
      dispatch({ type: 'modalItems', items: [], busy: false, note: `❌ ${err.message}` });
    }
  }

  function openDictEdit() {
    const item = selected(state);
    if (!item?.dictionary_item_id) return;
    dispatch({ type: 'modalOpen', kind: 'dictEdit', title: `${item.group}.${item.key}`, items: [], editing: 'value', value: item.value ?? '',
      meta: { id: item.dictionary_item_id, language_id: item.language_id, group: item.group, key: item.key, value: item.value ?? '' } });
  }

  async function applyDictValue(text) {
    const meta = state.modal.meta ?? {};
    const value = text.trim();
    if (!value) return void dispatch({ type: 'modalClose' });
    dispatch({ type: 'modalEdit', editing: null, value: '' });
    dispatch({ type: 'modalItems', items: [], busy: true, note: 'сохраняю…' });
    try {
      // PUT требует все поля разом, включая язык и группу — шлём как лежало.
      await withBusy('правка словаря', () => dict().update(meta.id, { language_id: meta.language_id, group: meta.group, key: meta.key, value }));
      bufferRef.current.push(`словарь ▸ ${meta.group}.${meta.key} обновлено`);
      dispatch({ type: 'modalClose' });
      await refreshDictCache();
      load('dict');
    } catch (err) {
      dispatch({ type: 'modalItems', items: [], busy: false, note: `❌ ${err.message}` });
    }
  }

  async function pickLanguage(code) {
    // После dispatch в этом же такте state ещё старый — ищем в локальном списке.
    const langs = state.languages.length ? state.languages : await withBusy('языки словаря', () => dict().languages());
    if (!state.languages.length) dispatch({ type: 'languages', items: langs });
    const hit = langs.find((l) => l.code === code)
      ?? langs.find((l) => String(l.code ?? '').startsWith(code));
    if (!hit) throw new Error(`нет языка "${code}" — есть: ${langs.map((l) => l.code).join(', ')}`);
    return hit;
  }

  async function refreshDictCache() {
    try {
      await dict().refresh();
    } catch (err) {
      bufferRef.current.push(`словарь ▸ ⚠ кэш не обновился: ${err.message}`);
    }
  }

  function openDeleteConfirm() {
    const item = selected(state);
    if (!item) return;
    if (state.tab === 'gb') {
      return void dispatch({ type: 'modalOpen', kind: 'confirm', title: `Удалить флаг ${item.id}? Необратимо.`, items: [
        { label: '— отмена' },
        { label: `удалить ${item.id}`, yes: true, what: 'gb' },
      ] });
    }
    dispatch({ type: 'modalOpen', kind: 'confirm', title: `Удалить ${item.group}.${item.key}?`, items: [
      { label: '— отмена' },
      { label: `удалить запись ${item.dictionary_item_id}`, yes: true, what: 'dict' },
    ] });
  }

  async function applyConfirm() {
    const opt = state.modal.items[state.modal.cursor];
    if (!opt?.yes) return void dispatch({ type: 'modalClose' });
    dispatch({ type: 'modalItems', busy: true, note: 'удаляю…' });
    try {
      if (opt.what === 'gb') {
        const res = await withBusy(`удаление ${opt.label}`, () => gb().deleteFeature(selected(state).id));
        if (res?.deletedId !== selected(state).id) throw new Error('GrowthBook не подтвердил удаление — проверь флаг в вебе');
        bufferRef.current.push(`${selected(state).id} ▸ флаг удалён`);
        dispatch({ type: 'modalClose' });
        load('gb');
      } else {
        const item = selected(state);
        await withBusy(`удаление ${item.dictionary_item_id}`, () => dict().remove(item.dictionary_item_id));
        bufferRef.current.push(`словарь ▸ удалено ${item.group}.${item.key} (${item.dictionary_item_id})`);
        dispatch({ type: 'modalClose' });
        await refreshDictCache();
        load('dict');
      }
    } catch (err) {
      dispatch({ type: 'modalItems', busy: false, note: `❌ ${err.message}` });
    }
  }

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

  // Текстовые модалки: одна точка роутинга Enter из поля ввода.
  function submitModal(text) {
    const kind = state.modal?.kind;
    if (kind === 'comment') return submitComment(text);
    if (kind === 'editValue') return state.tab === 'mr' ? applyMRValue(text) : applyEditValue(text);
    if (kind === 'gbCreate') return submitGBId(text);
    if (kind === 'dictCreate') return submitDictField(text);
    if (kind === 'dictEdit') return applyDictValue(text);
    if (kind === 'attach') return uploadAttachment(text);
    if (kind === 'chat') return sendToMaster(text);
    return submitFilter(text);
  }

  const editing = state.modal?.editing ?? null;

  // Пока набирают текст, все клавиши принадлежат полю ввода — кроме Esc, он отменяет ввод.
  // В окне комментария кроме ввода ничего нет, поэтому Esc закрывает его целиком.
  useInput((input, key) => {
    if (!key.escape) return;
    if (state.modal?.kind === 'chat') return void closeMaster();
    if (state.modal?.kind === 'comment') return void dispatch({ type: 'modalClose' });
    if (['gbCreate', 'dictCreate', 'dictEdit'].includes(state.modal?.kind)) return void dispatch({ type: 'modalClose' });
    if (state.modal?.kind === 'editValue') return void (state.tab === 'mr' ? openMRFields() : openEditFields()); // назад к списку полей
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
    if (intent.type === 'gbToggle') return void openGBToggle();
    if (intent.type === 'create') return void (state.tab === 'gb' ? openGBCreate() : openDictCreate());
    if (intent.type === 'dictEdit') return void openDictEdit();
    if (intent.type === 'delete') return void openDeleteConfirm();
    if (intent.type === 'dictPage') {
      dispatch({ type: 'dictPage', meta: { ...state.dictPage, page: state.dictPage.page + intent.by } });
      const next = state.dictPage.page + intent.by;
      if (next >= 1) load('dict', next); // за границу не выходим: reduce зажмёт, а загрузка — нет
      return;
    }
    if (intent.type === 'sprint') return void openSprints();
    if (intent.type === 'comment') {
      const item = selected(state);
      if (item?.key) dispatch({ type: 'modalOpen', kind: 'comment', title: `${item.key}: комментарий`, issue: item.key, items: [], editing: 'comment' });
      return;
    }
    if (intent.type === 'openFilters') return openFilters();
    if (intent.type === 'searchOpen' || intent.type === 'searchClose') return void dispatch(intent);
    if (intent.type === 'editField') return void (state.tab === 'mr' ? openMRFields() : openEditFields());
    if (intent.type === 'parent') return void openParent();
    if (intent.type === 'ask') return void openMaster();
    if (intent.type === 'attach') return void openAttachments();
    if (intent.type === 'attachAdd') return void dispatch({ type: 'modalEdit', editing: 'path', value: '' });
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
      if (kind === 'gbState') return void applyGBCreate();
      if (kind === 'gbToggle') return void applyGBToggle();
      if (kind === 'confirm') return void applyConfirm();
      if (kind === 'filters') return void applyFilterRow();
      if (kind === 'filterValue') return applyFilterValue();
      if (kind === 'editField') return void (state.tab === 'mr' ? openMRValue() : openEditValue());
      if (kind === 'editValue') return void (state.tab === 'mr' ? applyMRValue() : applyEditValue());
      if (kind === 'attach') return void downloadAttachment();
      if (kind === 'parent') return void dispatch({ type: 'modalClose' }); // окно только читают
      return void applyTransition();
    }
    if (intent.type === 'modalClear') {
      if (state.modal.kind !== 'filters') return;
      return void dispatch({ type: 'filters', filters: { ...myFilters(), [fieldsFor(state.tab)[state.modal.cursor].key]: null } });
    }
    if (intent.type === 'modalClose') {
      if (state.modal.kind === 'filterValue') return openFilters(); // назад к списку полей, а не наружу
      if (state.modal.kind === 'editValue') return void (state.tab === 'mr' ? openMRFields() : openEditFields());
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
          ? html`<${Modal} modal=${state.modal} filters=${state.filters[state.tab] ?? {}} fields=${fieldsFor(state.tab)} optionsFor=${optionsFor} height=${bodyInner} onSubmit=${submitModal} onChange=${(v) => dispatch({ type: 'modalEdit', editing: state.modal.editing, value: v })} />`
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
    <${Text}>1…6 — вкладки (MR, задачи, процессы, промпты, флаги, словарь) · Tab — фокус: список → детали → лог<//>
    <${Text}>↑↓ или j/k — курсор и прокрутка · / — поиск по списку (терпит опечатки) · R — перечитать<//>
    <${Text}>MR: a — конфликт · t — тикеты · r — ревью · p — пайплайн и джобы · E — поле<//>
    <${Text}>Задачи: n — анализ · s — статус · S — спринт · c — комментарий · p — родитель · v — доска (H/L — перенос)<//>
    <${Text}>E — поле из editmeta · e — раскрыть текст ($EDITOR) · @ — вложения (Enter, a)<//>
    <${Text}>Флаги (5): c — создать · t — вкл/выкл в окружении · D — удалить<//>
    <${Text}>Словарь (6): c — создать (значение → ключ → группа → язык) · E — править значение · D — удалить · n/p — страницы<//>
    <${Text}>A — мастер по fsh · x — прервать запуски · o — в браузере · q — выход<//>
    <${Text} dimColor>Запуски переживают выход: события пишутся в ~/.local/state/fs-harness/runs/${'<id>'}/events.jsonl<//>
  <//>`;

function Modal({ modal, filters, fields, optionsFor, height, onSubmit, onChange }) {
  const body = () => {
    if (['gbCreate', 'dictCreate', 'dictEdit'].includes(modal.kind) && modal.editing) {
      const hints = {
        gbCreate: 'ид флага: латиница, цифры, - и _ · Enter — дальше · Esc — отмена',
        dictCreate: {
          value: 'значение перевода · Enter — дальше',
          key: 'ключ (часть после точки) · Enter — дальше',
          group: 'группа (часть до точки) · Enter — дальше',
          lang: 'код языка (ru, en, by…) · Enter — создать',
        }[modal.editing],
        dictEdit: 'Enter — сохранить и обновить кэш словаря · Esc — закрыть',
      };
      return html`<${Box} flexDirection="column">
        <${Box}><${Text}>› <//><${TextInput} value=${modal.value} onChange=${onChange} onSubmit=${onSubmit} /><//>
        <${Text} dimColor>${hints[modal.kind]}<//>
      <//>`;
    }
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
    if (modal.kind === 'chat') {
      const room = Math.max(3, height - 5);
      const stream = modal.stream ? [{ role: 'мастер', text: modal.stream }] : [];
      // Показываем хвост переписки: окно короткое, а разговор растёт.
      const shown = [...(modal.lines ?? []), ...stream].flatMap((m) => {
        const mark = m.role === 'me' ? '›' : m.role === '❌' ? '❌' : '💬';
        const color = m.role === 'me' ? 'cyan' : m.role === '❌' ? 'red' : undefined;
        return String(m.text).split('\n').map((line, i) => ({ mark: i === 0 ? mark : ' ', line, color }));
      }).slice(-room);
      return html`<${Box} flexDirection="column">
        ${shown.map((r, i) => html`<${Text} key=${i} color=${r.color} wrap="truncate-end">${r.mark} ${r.line}<//>`)}
        ${!shown.length ? html`<${Text} dimColor>Спроси что угодно про fsh: почему упал ран, что делает команда, как починить.<//>` : null}
        ${modal.note ? html`<${Text} color="yellow"><${Spinner} type="dots" /> ${modal.note}<//>` : null}
        <${Box}><${Text} color="cyan">› <//><${TextInput} value=${modal.value} onChange=${onChange} onSubmit=${onSubmit} /><//>
        <${Text} dimColor>Enter — спросить · Esc — закрыть (мастер правит сам, ты видишь каждый шаг)<//>
      <//>`;
    }
    if (modal.kind === 'attach') {
      const room = Math.max(1, height - 5);
      return html`<${Box} flexDirection="column">
        ${modal.note ? html`<${Text} color="yellow">${modal.busy ? html`<${Spinner} type="dots" /> ` : ''}${modal.note}<//>` : null}
        ${modal.items.slice(0, room).map((a, i) => html`
          <${Text} key=${a.id} inverse=${i === modal.cursor && !modal.editing} wrap="truncate-end">📎 ${a.label}<//>
        `)}
        ${modal.editing
          ? html`<${Box}><${Text}>путь: <//><${TextInput} value=${modal.value} onChange=${onChange} onSubmit=${onSubmit} /><//>`
          : null}
        <${Text} dimColor>${modal.editing
          ? 'Enter — приложить к задаче · Esc — назад к списку'
          : 'Enter — выгрузить в текущий каталог · a — приложить файл · Esc — закрыть'}<//>
      <//>`;
    }
    if (modal.kind === 'parent') {
      const room = Math.max(1, height - 4);
      return html`<${Box} flexDirection="column">
        ${modal.note ? html`<${Text} color="yellow">${modal.busy ? html`<${Spinner} type="dots" /> ` : ''}${modal.note}<//>` : null}
        ${modal.items.slice(0, room).map((t) => html`<${Text} key=${t.id} wrap="truncate-end">${t.label}<//>`)}
        ${!modal.items.length && !modal.busy ? html`<${Text} dimColor>подзадач нет<//>` : null}
        <${Text} dimColor>${modal.items.length > room ? `…ещё ${modal.items.length - room} · ` : ''}Esc — закрыть<//>
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
  const cursor = state.cursor[state.tab];
  // Высота строк разная (карточка задачи до пяти строк), поэтому окно набираем от курсора, а не делим height.
  const heights = rows.map((r) => (state.tab === 'mr' ? 2 : rowLines(state.tab, r, width).length) + 1);
  let start = cursor;
  let end = cursor + 1;
  let used = heights[cursor] ?? 1;
  while (start > 0 || end < rows.length) {
    if (start > 0 && used + heights[start - 1] <= height) { used += heights[--start]; continue; }
    if (end < rows.length && used + heights[end] <= height) { used += heights[end++]; continue; }
    break;
  }
  return rows.slice(start, end).flatMap((r, i) => {
    const active = start + i === cursor;
    const key = r.iid ?? r.key ?? r.name ?? r.id ?? i;
    const body = state.tab === 'mr'
      ? [html`<${MRRow} key=${key} r=${r} active=${active} width=${width} />`]
      : rowLines(state.tab, r, width).map((l, j) => html`<${Box} key=${`${key}-${j}`} flexShrink=${0}>
          <${Marker} active=${active && j === 0} />
          <${Line} line=${shiftLine(l, state.scroll.x)} bold=${active} />
        <//>`);
    // Тонкая бледная линия между строками: без неё список читается как сплошной абзац.
    return [...body, html`<${Text} key=${`${key}-sep`} dimColor wrap="truncate-end">${'─'.repeat(Math.max(1, width))}<//>`];
  });
}

// Задача рисуется карточкой: ключ со статусом, название до трёх строк, тэги и родитель.
const rowLines = (tab, r, width) => (tab === 'issues' ? issueCard(r, width - 1)
  : tab === 'gb' ? [gbRow(r)]
    : tab === 'dict' ? [dictRow(r)]
      : [tab === 'prompts' ? promptRow(r) : runRow(r)]);


const COL_MIN = 26; // уже этого карточка нечитаема
const GUTTER = 3; // между колонками: линия и воздух с обеих сторон

// Доска: те же колонки, что человек видит в Jira. Пустых нет, видимые листаются h/l.
function Board({ state, height, width }) {
  const cols = boardLanes(state);
  if (state.loading.issues && !cols.length) return html`<${Text} dimColor>загружаю…<//>`;
  if (!cols.length) return html`<${Text} dimColor>${state.columns.length ? 'ни одна задача не попала на доску' : 'колонки доски ещё не прочитаны'}<//>`;

  const fit = Math.max(1, Math.min(cols.length, Math.floor((width + GUTTER) / (COL_MIN + GUTTER))));
  const from = Math.max(0, Math.min(state.boardCursor.col - Math.floor(fit / 2), cols.length - fit));
  const colWidth = Math.floor((width - GUTTER * (fit - 1)) / fit);
  const perCard = 3; // две строки карточки и отбивка
  const rows = Math.max(1, Math.floor((height - 1) / perCard));

  return html`<${Box}>
    ${cols.slice(from, from + fit).flatMap((c, ci) => {
      const active = from + ci === state.boardCursor.col;
      const start = active ? Math.max(0, Math.min(state.boardCursor.row - Math.floor(rows / 2), c.items.length - rows)) : 0;
      const col = html`<${Box} key=${c.name} width=${colWidth} flexShrink=${0} flexDirection="column">
        <${Text} bold color=${active ? 'cyan' : undefined} wrap="truncate-end">${c.name} ${c.items.length}<//>
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
      // Колонки разделены бледной линией во всю высоту доски: без неё карточки соседних колонок слипаются.
      return ci ? [html`<${Box} key=${`${c.name}-gut`} width=${1} flexShrink=${0} marginX=${1} flexDirection="column">
        ${Array.from({ length: height }, (_, i) => html`<${Text} key=${i} dimColor>│<//>`)}
      <//>`, col] : [col];
    })}
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
  return flowed.slice(off, off + height).map((l, i) => html`<${Line} key=${i} line=${shiftLine(l, state.scroll.x)} />`);
}

// Строка из кусков: у каждого свой цвет. Пустая строка-разделитель рисуется пробелом,
// иначе ink схлопывает её и группы слипаются.
const Line = ({ line, bold = false }) =>
  line.gap
    ? html`<${Text}> <//>`
    : html`<${Text} wrap="truncate-end">${line.parts.map((p, i) => html`<${Text} key=${i} bold=${p.bold || bold} dimColor=${p.dim} color=${p.color}>${p.text}<//>`)}<//>`;

function Log({ lines, height, offset, focused }) {
  const inner = Math.max(1, height - 2);
  const end = Math.max(inner, lines.length - offset);
  return html`<${Box} flexDirection="column" height=${height} paddingX=${1} borderStyle="round" borderColor=${focused ? 'cyan' : 'gray'}>
    ${lines.slice(Math.max(0, end - inner), end).map((l, i) => html`<${Text} key=${i} wrap="truncate-end">${l}<//>`)}
    ${!lines.length ? html`<${Text} dimColor>лог пуст — запусти действие клавишей<//>` : null}
  <//>`;
}
