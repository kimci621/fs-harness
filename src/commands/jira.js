import { ISSUE_KEY } from '../jira.js';
import { humanize, table, truncate } from '../format.js';
import { finish } from '../output.js';
import { CliError } from '../errors.js';

export const MY_ISSUES_JQL = 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC';

const brief = (issue) => ({
  key: issue.key,
  summary: issue.fields?.summary ?? '',
  status: issue.fields?.status?.name ?? '—',
  type: issue.fields?.issuetype?.name ?? '—',
  priority: issue.fields?.priority?.name ?? '—',
  updated: issue.fields?.updated ?? null,
});

// fsh jira [mine] | fsh jira FD-7647
export async function cmdJira(ctx, args, { json, asObject } = {}) {
  const j = ctx.jira();
  const [query] = args;
  const result = !query || query === 'mine' ? await mine(j) : await one(j, query, ctx);

  if (asObject) return result;
  if (json) finish(true, result);
  else render(result, ctx);
  return result;
}

async function mine(j) {
  const { issues } = await j.searchJql({ jql: MY_ISSUES_JQL });
  return { ok: true, jql: MY_ISSUES_JQL, issues: issues.map(brief) };
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
