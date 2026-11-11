import { expandHome } from '../config.js';
import { ISSUE_KEY, fieldByName, fieldIdByName, fieldText, keyFromBranch } from '../jira.js';
import { judge, formatVerdict } from '../judge/index.js';
import { buildAcceptancePayload } from '../judge/payload.js';
import { makeGit } from '../workspace.js';
import { finish } from '../output.js';
import { confirm } from '../ui.js';
import { CliError } from '../errors.js';
import { issueUrl, pickTransition } from './jira.js';
import { postReview } from './mm.js';

// Ветки, в которые нельзя ни переключаться работой, ни пушить задачу.
// targetBranch проекта добавляется к списку на месте.
const PROTECTED = [/^dev$/, /^master$/, /^main$/, /^rel\//, /^release\//];

export const isProtected = (branch, targetBranch = '') =>
  PROTECTED.some((re) => re.test(branch)) || (Boolean(targetBranch) && branch === targetBranch);

// Имя ветки задачи: шаблон из конфига проекта, {key} — ключ задачи.
export const branchFor = (key, pattern = 'feature/{key}') => pattern.replace('{key}', key);

export { keyFromBranch };

const dirOf = (ctx, opts) => {
  const dir = expandHome(opts.projectDir || ctx.cfg.projectDir || '');
  if (!dir) throw new CliError('Не задан каталог проекта: --project-dir или projects.<имя>.dir в конфиге.', 1, 'config_invalid');
  return dir;
};

export async function cmdTask(ctx, args, opts = {}) {
  const [sub, ...rest] = args;
  const result =
    sub === 'start' ? await start(ctx, rest, opts)
      : sub === 'push' ? await push(ctx, rest, opts)
        : sub === 'submit' ? await submit(ctx, rest, opts)
          : sub === 'judge' ? await review(ctx, rest, opts)
            : (() => { throw new CliError('Использование: fsh task start <KEY> | fsh task push [KEY] [--target <ветка>] | fsh task submit [KEY] [--status <имя>] | fsh task judge [KEY].', 1, 'usage'); })();

  if (opts.asObject) return result;
  if (opts.json) finish(true, result);
  else render(result);
  return result;
}

// Взять задачу в работу: прочитать её, встать на ветку feature/<KEY> и, если в конфиге задан
// taskFlow.startStatus, перевести задачу в этот статус.
async function start(ctx, [key], opts) {
  if (!key || !ISSUE_KEY.test(key)) throw new CliError('Использование: fsh task start FD-7719.', 1, 'usage');
  const dir = dirOf(ctx, opts);
  const git = makeGit(dir);
  const target = opts.target || ctx.cfg.targetBranch || 'dev';
  const branch = branchFor(key, ctx.cfg.branchPattern);
  if (isProtected(branch, target)) {
    throw new CliError(`Ветка "${branch}" защищённая, работать в ней нельзя. Поправь branchPattern в конфиге.`, 1, 'usage');
  }

  const issue = await ctx.jira().issue(key);
  const current = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const local = Boolean(git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], dir, { allowFail: true }));
  const remote = Boolean(git(['ls-remote', '--heads', 'origin', branch], dir, { allowFail: true }));
  // Статусные буквы отрезаем регуляркой, а не по позиции: git-обёртка уже сделала trim.
  const dirty = git(['status', '--porcelain']).split('\n').filter(Boolean).map((l) => l.trim().replace(/^\S+\s+/, ''));
  const state = current === branch ? 'already' : local ? 'switched' : remote ? 'tracked' : 'created';

  const plan = [
    state === 'created' || state === 'tracked' ? ['fetch', 'origin', state === 'created' ? target : branch] : null,
    state === 'already' ? null
      : state === 'switched' ? ['switch', branch]
        : state === 'tracked' ? ['switch', '-c', branch, '--track', `origin/${branch}`]
          : ['switch', '-c', branch, `origin/${target}`],
  ].filter(Boolean);

  const info = {
    ok: true,
    issue: { key, summary: issue.fields?.summary ?? '', status: issue.fields?.status?.name ?? '—', url: issueUrl(ctx, key) },
    branch,
    base: state === 'created' ? `origin/${target}` : null,
    state,
    dir,
  };
  if (opts.dryRun) return { ...info, dry_run: true, plan: plan.map((a) => `git ${a.join(' ')}`) };
  // Незакоммиченные правки при смене ветки уедут с тобой в чужую ветку: это не наше решение.
  if (state !== 'already' && dirty.length) {
    throw new CliError(`В ${dir} незакоммиченные правки (${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ' и ещё' : ''}). Закоммить или спрячь их, потом повтори.`, 1, 'dirty_checkout');
  }
  for (const a of plan) git(a);
  return { ...info, jira: await moveOnStart(ctx, key, info.issue.status) };
}

// Статус ставится в момент старта, а не задним числом: иначе cycle time в отчёте врёт.
// Перехода нет (задача уже дальше по флоу) — не ошибка, ветка всё равно нужна.
async function moveOnStart(ctx, key, from) {
  const to = ctx.cfg.taskFlow?.startStatus;
  if (!to || from === to) return null;
  const j = ctx.jira();
  const { transitions } = (await j.transitions(key)) ?? {};
  let t;
  try {
    t = pickTransition(transitions, to);
  } catch {
    return { from, to: from, skipped: `перехода в «${to}» из «${from}» нет` };
  }
  await j.transition(key, t.id);
  return { from, to: t.to?.name ?? to };
}

// Запушить ветку задачи и открыть MR. Push только текущей ветки и только не-force.
async function push(ctx, [maybeKey], opts) {
  const dir = dirOf(ctx, opts);
  const git = makeGit(dir);
  const target = opts.target || ctx.cfg.targetBranch || 'dev';
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (isProtected(branch, target)) {
    throw new CliError(`Ты на защищённой ветке "${branch}". Задачу пушат из своей ветки.`, 1, 'usage');
  }
  const key = maybeKey && ISSUE_KEY.test(maybeKey) ? maybeKey : keyFromBranch(branch);
  const ahead = Number(git(['rev-list', '--count', `origin/${target}..HEAD`], dir, { allowFail: true }) || 0);
  if (!ahead) throw new CliError(`В ${branch} нет коммитов поверх origin/${target}: пушить нечего.`, 1, 'no_commit');

  const open = await ctx.g.listOpenMRs(ctx.repo, { source_branch: branch });
  const existing = open?.[0] ?? null;
  const issue = key ? await ctx.jira().issue(key).catch(() => null) : null;
  const title = issue ? `${key}: ${issue.fields?.summary ?? ''}`.trim() : branch;
  const fields = existing ? null : {
    source_branch: branch,
    target_branch: target,
    title: opts.draft ? `Draft: ${title}` : title,
    description: key ? `${issueUrl(ctx, key)}` : '',
    remove_source_branch: true,
  };

  const info = { ok: true, branch, target, commits_ahead: ahead, key: key ?? null, dir };
  if (opts.dryRun) {
    return { ...info, dry_run: true, plan: [
      `git push -u origin ${branch}`,
      existing ? `MR !${existing.iid} уже есть` : `POST /merge_requests ${JSON.stringify(fields)}`,
      ...(opts.post ? ['сообщение в Mattermost (сценарий review)'] : []),
    ] };
  }
  if (!opts.yes && !opts.asObject && !confirm(`Запушить ${branch} и ${existing ? `оставить MR !${existing.iid}` : `открыть MR в ${target}`}? [y/N] `)) {
    throw new CliError('Отменено.', 0, 'canceled');
  }
  git(['push', '-u', 'origin', branch]);
  const mr = existing ?? (await ctx.g.createMR(ctx.repo, fields));
  const out = { ...info, pushed: true, mr: { iid: mr?.iid ?? null, title: mr?.title ?? title, web_url: mr?.web_url ?? null }, mr_created: !existing };
  // --post: отписать в рабочий чат, что задача уехала в ревью. Без флага молчим:
  // запись в общий канал не должна быть побочным эффектом пуша.
  if (opts.post) out.posted = await postReview(ctx, { iid: out.mr.iid, mrUrl: out.mr.web_url, key, title: out.mr.title }, opts);
  return out;
}

// Отправить задачу в ревью команде: снять черновик с MR, перевести Jira в статус ревью
// и отписать в Mattermost. Шаг человека: implement оставляет MR черновиком и не двигает Jira.
async function submit(ctx, [maybeKey], opts) {
  const dir = dirOf(ctx, opts);
  const git = makeGit(dir);
  const head = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const key = maybeKey && ISSUE_KEY.test(maybeKey) ? maybeKey : keyFromBranch(head);
  if (!key) throw new CliError(`Из ветки "${head}" ключ задачи не читается. Использование: fsh task submit FD-7719.`, 1, 'usage');

  // Ветку задачи знаем по ключу: implement пушит именно в branchFor(key), а основной чекаут
  // может стоять на dev. Ищем MR по ней, текущую ветку пробуем как запасной вариант.
  const taskBranch = branchFor(key, ctx.cfg.branchPattern);
  const candidates = [...new Set([taskBranch, head].filter(Boolean))];
  let mr = null;
  let branch = taskBranch;
  for (const b of candidates) {
    const open = await ctx.g.listOpenMRs(ctx.repo, { source_branch: b });
    if (open?.[0]) { mr = open[0]; branch = b; break; }
  }
  if (!mr) throw new CliError(`Нет открытого MR ни в "${taskBranch}", ни в "${head}": сначала fsh implement ${key} или fsh task push.`, 1, 'no_mr');

  const j = ctx.jira();
  const flow = ctx.cfg.taskFlow ?? {};
  const statusName = opts.status || 'Ревью';
  const { transitions } = (await j.transitions(key)) ?? {};
  // Перехода в ревью нет у Tech task: такая задача уходит в ревью одним сообщением в чат.
  // Статус, названный явно, обязан найтись — там молчаливый пропуск хуже ошибки.
  let t = null;
  try {
    t = pickTransition(transitions, statusName);
  } catch (err) {
    if (opts.status) throw err;
  }
  const before = await j.issue(key);
  const from = before.fields?.status?.name ?? '—';
  const wasDraft = /^\s*(draft|wip):/i.test(String(mr.title ?? ''));
  const title = String(mr.title ?? '').replace(/^\s*(draft|wip):\s*/i, '');

  // Всё, чего не хватает, — до первой записи и одним списком: чинить по одному пункту за прогон дольше.
  const missingBlocks = (flow.mrBlocks ?? []).filter((b) => !String(mr.description ?? '').includes(b));
  // Поля, которые заполню собой сам, нехваткой не считаются: их и требует валидатор перехода.
  const selfFill = t ? await withMulti(j, key, emptySelfFields(flow.selfFields, before)) : [];
  const own = new Set(selfFill.map((f) => f.name));
  const missing = t
    ? [...new Set([...missingRequired(t, before), ...missingNamed(flow.requiredFields, before)])].filter((n) => !own.has(n))
    : [];
  if (missingBlocks.length || missing.length) {
    const lines = [
      ...(missingBlocks.length ? [`В описании MR !${mr.iid} нет блоков: ${missingBlocks.join(', ')}. Допиши описание по шаблону проекта.`] : []),
      ...(missing.length ? [`Перед переходом "${t.name}" заполни поля: ${missing.join(', ')}.`, ...missing.map((n) => `   fsh jira field ${key} "${n}" <значение> -y`)] : []),
    ];
    throw new CliError(`${lines.join('\n')}\n   Потом повтори fsh task submit ${key}.`, 1, missing.length ? 'jira_fields_missing' : 'mr_description_incomplete');
  }

  const to = t ? t.to?.name ?? t.name : from;
  const info = { ok: true, key, branch, mr: { iid: mr.iid, web_url: mr.web_url }, jira: { from, to } };
  if (opts.dryRun) {
    return { ...info, dry_run: true, plan: [
      ...selfFill.map((f) => `Jira ${key}: «${f.name}» ← я`),
      t ? `Jira ${key}: ${from} → ${to}` : `Jira ${key}: перехода «${statusName}» нет, статус не трогаю`,
      wasDraft ? `PUT /merge_requests/${mr.iid}: снять черновик (title: ${title})` : `MR !${mr.iid} уже не черновик`,
      'сообщение в Mattermost (сценарий review)',
    ] };
  }
  if (!opts.yes && !opts.asObject && !confirm(`${key}: ${from} → ${to}, MR !${mr.iid} в ревью, отписать в Mattermost? [y/N] `)) {
    throw new CliError('Отменено.', 0, 'canceled');
  }

  const steps = [];
  if (selfFill.length) {
    const me = await j.myself();
    await j.updateIssue(key, Object.fromEntries(selfFill.map((f) => [f.id, f.multi ? [{ accountId: me.accountId }] : { accountId: me.accountId }])));
    for (const f of selfFill) steps.push({ step: `«${f.name}»`, ok: true, note: 'заполнено мной' });
  }

  // Jira первой: не переводится — MR остаётся черновиком, и повторить безопасно.
  let now = from;
  if (t) {
    await j.transition(key, t.id);
    const after = await j.issue(key);
    now = after.fields?.status?.name ?? '—';
    if (now === from) throw new CliError(`Jira приняла переход "${t.name}", но статус ${key} остался "${from}". Проверь права и условия перехода.`, 1, 'api_failed');
    steps.push({ step: 'статус Jira', ok: true, note: `${from} → ${now}` });
  } else {
    steps.push({ step: 'статус Jira', ok: true, note: `перехода «${statusName}» нет (Tech task?), остаётся «${from}»` });
  }
  for (const n of flow.requiredFields ?? []) if (fieldIdByName(before, n)) steps.push({ step: `«${n}»`, ok: true, note: 'заполнено' });
  if (flow.mrBlocks?.length) steps.push({ step: 'описание MR', ok: true, note: flow.mrBlocks.join(', ') });

  const updated = wasDraft ? await ctx.g.updateMR(ctx.repo, mr.iid, { title }) : mr;
  steps.push({ step: 'MR', ok: true, note: wasDraft ? 'черновик снят' : 'уже не черновик' });
  const posted = await postReview(ctx, { iid: mr.iid, mrUrl: mr.web_url, key, title: updated?.title ?? title }, opts);
  steps.push({ step: 'Mattermost', ok: Boolean(posted?.ok), note: posted?.scenario || posted?.channel || '' });
  return { ...info, title: updated?.title ?? title, draft_removed: wasDraft, jira: { from, to: now, transition: t?.name ?? null }, posted, steps };
}

// Поля по названию из taskFlow.requiredFields. Поля нет у типа задачи (Tech task) — не требуем.
function missingNamed(names = [], issue) {
  return names.filter((n) => fieldIdByName(issue, n) && !fieldText(fieldByName(issue, n)));
}

// Поля-пользователи, которые submit заполняет мной: пустые и существующие у задачи.
function emptySelfFields(names = [], issue) {
  return names
    .map((name) => ({ name, id: fieldIdByName(issue, name) }))
    .filter((f) => f.id && !fieldText(issue.fields?.[f.id]));
}

// Пустое поле приходит null и одиночное, и множественное: форму значения говорит только editmeta.
async function withMulti(j, key, fields) {
  if (!fields.length) return fields;
  const meta = (await j.editMeta(key))?.fields ?? {};
  return fields.map((f) => ({ ...f, multi: meta[f.id]?.schema?.type === 'array' }));
}

// Поля экрана перехода, помеченные обязательными и пустые у задачи. hasDefaultValue Jira
// заполняет сама — такие не считаем нехваткой.
function missingRequired(transition, issue) {
  return Object.entries(transition?.fields ?? {})
    .filter(([, f]) => f.required && !f.hasDefaultValue)
    .filter(([id]) => !fieldText(issue.fields?.[id]))
    .map(([, f]) => f.name || '?');
}

// Приёмка: судья сверяет дифф ветки с тем, что написано в задаче. Совет, а не гейт —
// решение всё равно за человеком, поэтому ok: true при любом вердикте.
async function review(ctx, [maybeKey], opts) {
  const dir = dirOf(ctx, opts);
  const git = makeGit(dir);
  const target = opts.target || ctx.cfg.targetBranch || 'dev';
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const key = maybeKey && ISSUE_KEY.test(maybeKey) ? maybeKey : keyFromBranch(branch);
  if (!key) throw new CliError(`Из ветки "${branch}" ключ задачи не читается. Использование: fsh task judge FD-7719.`, 1, 'usage');

  const issue = await ctx.jira().issue(key);
  // Три точки, а не две: сравниваем с точкой ветвления, иначе в дифф попадёт чужая работа в dev.
  const diff = git(['diff', `origin/${target}...HEAD`], dir, { allowFail: true });
  if (!diff.trim()) throw new CliError(`В ${branch} нет изменений против origin/${target}: судить нечего.`, 1, 'no_commit');
  const commits = git(['log', '--oneline', `origin/${target}..HEAD`], dir, { allowFail: true });

  const f = issue.fields ?? {};
  const goal = [`${key}: ${f.summary ?? ''}`, f.description ?? ''].join('\n\n').trim();
  const payload = buildAcceptancePayload({
    goal,
    facts: {
      статус: fieldText(f.status),
      ветка: branch,
      'целевая ветка': target,
      коммиты: commits.split('\n').filter(Boolean).length,
      'Technical details for QA': (fieldText(fieldByName(issue, 'Technical details for QA')) || (f.description && f.description.includes('Technical details for QA')) || (f.environment && f.environment.includes('Technical details for QA'))) ? 'заполнено' : 'пусто',
      'Контент': fieldText(fieldByName(issue, 'Контент')) ? 'заполнено' : 'пусто',
    },
    extra: commits ? `Коммиты ветки:\n\n${commits}` : '',
    diff,
  });

  if (opts.dryRun) return { ok: true, dry_run: true, key, branch, target, payload };
  const verdict = await judge({ role: 'task-acceptance', cfg: ctx.cfg, profile: opts.judgeProfile, payload });
  return { ok: true, key, branch, target, url: issueUrl(ctx, key), verdict };
}

const STATE_TEXT = { already: 'уже на ней', switched: 'переключился', tracked: 'взял с origin', created: 'создал' };

function render(r) {
  if (r.verdict || (r.dry_run && r.payload)) {
    console.log(`${r.key} · ${r.branch} → ${r.target}`);
    console.log(r.verdict ? formatVerdict(r.verdict) : r.payload);
    return;
  }
  if (r.jira && r.mr && !r.issue) {
    console.log(`${r.key} · ${r.branch} · MR !${r.mr.iid}: ${r.mr.web_url}`);
    if (r.steps) for (const st of r.steps) console.log(`${st.ok ? '✓' : '✗'} ${st.step}${st.note ? `: ${st.note}` : ''}`);
    else console.log(`Jira: ${r.jira.from} → ${r.jira.to}`);
  } else if (r.issue) {
    console.log(`${r.issue.key} · ${r.issue.status} · ${r.issue.summary}`);
    console.log(`${r.issue.url}`);
    console.log(`Ветка ${r.branch}: ${r.dry_run ? 'план' : STATE_TEXT[r.state]}${r.base ? ` от ${r.base}` : ''}`);
    if (r.jira) console.log(`Jira: ${r.jira.from} → ${r.jira.to}${r.jira.skipped ? ` (${r.jira.skipped})` : ''}`);
  } else {
    console.log(`${r.branch} → ${r.target}, коммитов сверху: ${r.commits_ahead}`);
    if (r.mr) console.log(`MR !${r.mr.iid} ${r.mr_created ? 'открыт' : 'уже был'}: ${r.mr.web_url}`);
  }
  if (r.dry_run) for (const line of r.plan) console.log(`  ${line}`);
}
