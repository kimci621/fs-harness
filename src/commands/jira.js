import { ISSUE_KEY } from '../jira.js';
import { humanize, table, truncate } from '../format.js';
import { finish } from '../output.js';
import { confirm } from '../ui.js';
import { CliError } from '../errors.js';

export const MY_ISSUES_JQL = 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC';

const quote = (v) => `"${String(v).replace(/"/g, '\\"')}"`;

// Фильтры складываются в JQL: язык запросов у Jira уже есть, свой поверх не выдумываем.
// componentField — имя checkbox-поля проекта (в конфиге jira.componentField).
export function buildJql({ assignee, sprint, component, status, jql, componentField = 'Компонент' } = {}) {
  if (jql) return jql;
  const parts = [];
  if (!assignee || assignee === 'me') parts.push('assignee = currentUser()');
  else if (assignee !== 'any') parts.push(`assignee = ${quote(assignee)}`);
  if (sprint) parts.push(sprint === 'current' ? 'sprint in openSprints()' : `sprint = ${quote(sprint)}`);
  if (component) parts.push(`${quote(componentField)} = ${quote(component)}`);
  parts.push(status ? `status = ${quote(status)}` : 'statusCategory != Done');
  return `${parts.join(' AND ')} ORDER BY updated DESC`;
}

// Переход по имени: точное совпадение, потом вхождение. Неоднозначность — ошибка со списком.
export function pickTransition(transitions, name) {
  const all = transitions ?? [];
  const lower = String(name).toLowerCase();
  const exact = all.find((t) => t.name.toLowerCase() === lower || t.to?.name?.toLowerCase() === lower);
  if (exact) return exact;
  const hits = all.filter((t) => `${t.name} ${t.to?.name ?? ''}`.toLowerCase().includes(lower));
  if (hits.length === 1) return hits[0];
  const list = all.map((t) => t.name).join(', ') || 'нет доступных';
  throw new CliError(
    hits.length ? `"${name}" подходит нескольким переходам: ${hits.map((t) => t.name).join(', ')}.` : `Перехода "${name}" нет. Доступны: ${list}.`,
    1,
    'usage',
  );
}

const brief = (issue) => ({
  key: issue.key,
  summary: issue.fields?.summary ?? '',
  status: issue.fields?.status?.name ?? '—',
  type: issue.fields?.issuetype?.name ?? '—',
  priority: issue.fields?.priority?.name ?? '—',
  updated: issue.fields?.updated ?? null,
});

// fsh jira [mine|<KEY>] [фильтры] | fsh jira move <KEY> <статус>
export async function cmdJira(ctx, args, opts = {}) {
  const { json, asObject } = opts;
  const j = ctx.jira();
  const [query, ...rest] = args;
  const result =
    query === 'move'
      ? await move(j, rest, ctx, opts)
      : !query || query === 'mine'
        ? await mine(j, { ...opts, componentField: ctx.cfg.jira?.componentField })
        : await one(j, query, ctx);

  if (asObject) return result;
  if (json) finish(true, result);
  else render(result, ctx);
  return result;
}

async function mine(j, filters) {
  const jql = buildJql(filters);
  const { issues } = await j.searchJql({ jql });
  return { ok: true, jql, issues: issues.map(brief) };
}

// Единственная запись в Jira. Спрашивает подтверждение и проверяет статус чтением.
async function move(j, [key, ...words], ctx, { yes, asObject, dryRun } = {}) {
  const name = words.join(' ').trim();
  if (!key || !ISSUE_KEY.test(key) || !name) {
    throw new CliError('Использование: fsh jira move <KEY> <статус>, например fsh jira move FD-7647 "В тестирование".', 1, 'usage');
  }
  const { transitions } = (await j.transitions(key)) ?? {};
  const t = pickTransition(transitions, name);
  const before = await j.issue(key);
  const from = before.fields?.status?.name ?? '—';
  if (dryRun) return { ok: true, dry_run: true, key, from, to: t.to?.name ?? t.name, transition: t.name };
  if (!yes && !asObject && !confirm(`${key}: ${from} → ${t.to?.name ?? t.name}. Менять статус? [y/N] `)) {
    throw new CliError('Отменено.', 0, 'canceled');
  }
  await j.transition(key, t.id);
  const after = await j.issue(key);
  const to = after.fields?.status?.name ?? '—';
  if (to === from) {
    throw new CliError(`Jira приняла переход "${t.name}", но статус ${key} остался "${from}". Проверь права и условия перехода.`, 1, 'api_failed');
  }
  return { ok: true, key, from, to, transition: t.name, url: issueUrl(ctx, key) };
}

async function one(j, key, ctx) {
  if (!ISSUE_KEY.test(key)) {
    throw new CliError(`"${key}" не похоже на ключ задачи (FD-7647). Использование: fsh jira [mine|<KEY>].`, 1, 'usage');
  }
  const issue = await j.issue(key);
  const { comments = [] } = (await j.comments(key)) ?? {};
  return {
    ok: true,
    issue: {
      ...brief(issue),
      description: issue.fields?.description ?? '',
      assignee: issue.fields?.assignee?.displayName ?? null,
      reporter: issue.fields?.reporter?.displayName ?? null,
      url: issueUrl(ctx, key),
    },
    comments: comments.map((c) => ({
      author: c.author?.displayName ?? '?',
      created: c.created,
      body: c.body ?? '',
    })),
  };
}

export const issueUrl = (ctx, key) => `${(ctx.cfg.jira?.baseUrl || '').replace(/\/+$/, '')}/browse/${key}`;

function render(r, ctx) {
  if (r.transition) {
    console.log(`${r.key}: ${r.from} → ${r.to}${r.dry_run ? ' (dry-run, ничего не менял)' : ''}`);
    return;
  }
  if (r.issues) {
    if (!r.issues.length) return void console.log('Задач на тебе нет.');
    console.log(table(r.issues.map((i) => [i.key, truncate(i.summary, 70), i.status, humanize(i.updated)])));
    return;
  }
  const { issue, comments } = r;
  console.log(`${issue.key} · ${issue.summary}`);
  console.log(`${issue.type} · ${issue.status} · ${issue.priority} · ${issue.assignee ?? 'без исполнителя'} · ${humanize(issue.updated)}`);
  console.log(issueUrl(ctx, issue.key));
  if (issue.description) console.log(`\n${issue.description}`);
  if (!comments.length) return;
  console.log(`\nКомментарии (${comments.length}):`);
  for (const c of comments) {
    console.log(`\n@${c.author} · ${humanize(c.created)}`);
    for (const line of c.body.split('\n')) console.log(`  > ${line}`);
  }
}
