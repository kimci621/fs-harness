import { ISSUE_KEY, fieldByName, fieldText } from '../jira.js';
import { judge, formatVerdict } from '../judge/index.js';
import { buildAcceptancePayload } from '../judge/payload.js';
import { makeGit } from '../workspace.js';
import { finish } from '../output.js';
import { confirm } from '../ui.js';
import { CliError } from '../errors.js';
import { issueUrl } from './jira.js';

// Ветки, в которые нельзя ни переключаться работой, ни пушить задачу.
// targetBranch проекта добавляется к списку на месте.
const PROTECTED = [/^dev$/, /^master$/, /^main$/, /^rel\//, /^release\//];

export const isProtected = (branch, targetBranch = '') =>
  PROTECTED.some((re) => re.test(branch)) || (Boolean(targetBranch) && branch === targetBranch);

// Имя ветки задачи: шаблон из конфига проекта, {key} — ключ задачи.
export const branchFor = (key, pattern = 'feature/{key}') => pattern.replace('{key}', key);

// Ключ задачи из имени ветки: feature/FD-7719 → FD-7719.
export const keyFromBranch = (branch) => branch.match(/[A-Z][A-Z0-9]+-\d+/)?.[0] ?? null;

const dirOf = (ctx, opts) => {
  const dir = opts.projectDir || ctx.cfg.projectDir;
  if (!dir) throw new CliError('Не задан каталог проекта: --project-dir или projects.<имя>.dir в конфиге.', 1, 'config_invalid');
  return dir;
};

export async function cmdTask(ctx, args, opts = {}) {
  const [sub, ...rest] = args;
  const result =
    sub === 'start' ? await start(ctx, rest, opts)
      : sub === 'push' ? await push(ctx, rest, opts)
        : sub === 'judge' ? await review(ctx, rest, opts)
          : (() => { throw new CliError('Использование: fsh task start <KEY> | fsh task push [KEY] [--target <ветка>] | fsh task judge [KEY].', 1, 'usage'); })();

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
    return { ...info, dry_run: true, plan: [`git push -u origin ${branch}`, existing ? `MR !${existing.iid} уже есть` : `POST /merge_requests ${JSON.stringify(fields)}`] };
  }
  if (!opts.yes && !opts.asObject && !confirm(`Запушить ${branch} и ${existing ? `оставить MR !${existing.iid}` : `открыть MR в ${target}`}? [y/N] `)) {
    throw new CliError('Отменено.', 0, 'canceled');
  }
  git(['push', '-u', 'origin', branch]);
  const mr = existing ?? (await ctx.g.createMR(ctx.repo, fields));
  return { ...info, pushed: true, mr: { iid: mr?.iid ?? null, title: mr?.title ?? title, web_url: mr?.web_url ?? null }, mr_created: !existing };
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
  if (r.issue) {
    console.log(`${r.issue.key} · ${r.issue.status} · ${r.issue.summary}`);
    console.log(`${r.issue.url}`);
    console.log(`Ветка ${r.branch}: ${r.dry_run ? 'план' : STATE_TEXT[r.state]}${r.base ? ` от ${r.base}` : ''}`);
  } else {
    console.log(`${r.branch} → ${r.target}, коммитов сверху: ${r.commits_ahead}`);
    if (r.mr) console.log(`MR !${r.mr.iid} ${r.mr_created ? 'открыт' : 'уже был'}: ${r.mr.web_url}`);
  }
  if (r.dry_run) for (const line of r.plan) console.log(`  ${line}`);
}
