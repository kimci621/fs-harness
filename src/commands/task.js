import { expandHome } from '../config.js';
import { ISSUE_KEY, fieldByName, fieldText, keyFromBranch } from '../jira.js';
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

// Взять задачу в работу: прочитать её и встать на ветку feature/<KEY>.
// Статус в Jira не двигаем — переход с обязательными полями это работа скилла проекта.
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
  return info;
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
    title,
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
  const statusName = opts.status || 'Ревью';
  const { transitions } = (await j.transitions(key)) ?? {};
  const t = pickTransition(transitions, statusName);
  const before = await j.issue(key);
  const from = before.fields?.status?.name ?? '—';
  const wasDraft = /^\s*(draft|wip):/i.test(String(mr.title ?? ''));
  const title = String(mr.title ?? '').replace(/^\s*(draft|wip):\s*/i, '');

  // Обязательные поля перехода проверяем сами: иначе отказ Jira хуже читается, а submit —
  // ровно то место, где человеку нужно сказать, чего не хватает.
  const missing = missingRequired(t, before);
  if (missing.length) {
    const hint = missing.map((n) => `fsh jira field ${key} "${n}" <значение>`).join('\n   ');
    throw new CliError(
      `Переход "${t.name}" требует заполнить поля: ${missing.join(', ')}.\n   Заполни и повтори:\n   ${hint}`,
      1,
      'jira_fields_missing',
    );
  }

  const info = { ok: true, key, branch, mr: { iid: mr.iid, web_url: mr.web_url }, jira: { from, to: t.to?.name ?? t.name } };
  if (opts.dryRun) {
    return { ...info, dry_run: true, plan: [
      `Jira ${key}: ${from} → ${t.to?.name ?? t.name}`,
      wasDraft ? `PUT /merge_requests/${mr.iid}: снять черновик (title: ${title})` : `MR !${mr.iid} уже не черновик`,
      'сообщение в Mattermost (сценарий review)',
    ] };
  }
  if (!opts.yes && !opts.asObject && !confirm(`${key}: ${from} → ${t.to?.name ?? t.name}, MR !${mr.iid} в ревью, отписать в Mattermost? [y/N] `)) {
    throw new CliError('Отменено.', 0, 'canceled');
  }

  // Jira первой: не переводится — MR остаётся черновиком, и повторить безопасно.
  await j.transition(key, t.id);
  const after = await j.issue(key);
  const to = after.fields?.status?.name ?? '—';
  if (to === from) throw new CliError(`Jira приняла переход "${t.name}", но статус ${key} остался "${from}". Проверь права и условия перехода.`, 1, 'api_failed');

  const updated = wasDraft ? await ctx.g.updateMR(ctx.repo, mr.iid, { title }) : mr;
  const posted = await postReview(ctx, { iid: mr.iid, mrUrl: mr.web_url, key, title: updated?.title ?? title }, opts);
  return { ...info, title: updated?.title ?? title, draft_removed: wasDraft, jira: { from, to, transition: t.name }, posted };
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
      'Technical details for QA': fieldText(fieldByName(issue, 'Technical details for QA')) ? 'заполнено' : 'пусто',
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
    console.log(`Jira: ${r.jira.from} → ${r.jira.to}${r.draft_removed ? ' · черновик снят' : ''}`);
    if (r.posted) console.log(`Mattermost: ${r.posted.scenario || r.posted.channel}`);
    if (r.dry_run) for (const line of r.plan) console.log(`  ${line}`);
  } else if (r.issue) {
    console.log(`${r.issue.key} · ${r.issue.status} · ${r.issue.summary}`);
    console.log(`${r.issue.url}`);
    console.log(`Ветка ${r.branch}: ${r.dry_run ? 'план' : STATE_TEXT[r.state]}${r.base ? ` от ${r.base}` : ''}`);
  } else {
    console.log(`${r.branch} → ${r.target}, коммитов сверху: ${r.commits_ahead}`);
    if (r.mr) console.log(`MR !${r.mr.iid} ${r.mr_created ? 'открыт' : 'уже был'}: ${r.mr.web_url}`);
  }
  if (r.dry_run) for (const line of r.plan) console.log(`  ${line}`);
}
