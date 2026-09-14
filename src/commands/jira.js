import { readFileSync } from 'node:fs';
import { ISSUE_KEY, editKind, editValueFor, fieldByName, fieldText, openSprints } from '../jira.js';
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

// Спринт по имени: точное совпадение, потом вхождение. Неоднозначность — ошибка со списком.
export function pickSprint(sprints, name) {
  const all = sprints ?? [];
  const lower = String(name).toLowerCase();
  const exact = all.find((s) => s.name?.toLowerCase() === lower || String(s.id) === String(name));
  if (exact) return exact;
  const hits = all.filter((s) => s.name?.toLowerCase().includes(lower));
  if (hits.length === 1) return hits[0];
  const list = all.map((s) => s.name).join(', ') || 'нет активных и будущих';
  throw new CliError(
    hits.length ? `"${name}" подходит нескольким спринтам: ${hits.map((s) => s.name).join(', ')}.` : `Спринта "${name}" нет. Доступны: ${list}.`,
    1,
    'usage',
  );
}

// Доска задачи: у спринта в самой задаче она уже указана, иначе ищем по ключу проекта.
export async function boardOf(j, issue) {
  const fromSprint = openSprints(fieldByName(issue, 'Sprint'))[0]?.boardId;
  if (fromSprint) return fromSprint;
  const projectKey = issue.key.split('-')[0];
  const { values = [] } = (await j.boards(projectKey)) ?? {};
  if (!values.length) throw new CliError(`У проекта ${projectKey} нет доски — спринт назначать некуда.`, 1, 'api_failed');
  return values[0].id;
}

// fsh jira [mine|<KEY>] [фильтры] | move <KEY> <статус> | sprint <KEY> <спринт> | comment <KEY> <текст>
export async function cmdJira(ctx, args, opts = {}) {
  const { json, asObject } = opts;
  const j = ctx.jira();
  const [query, ...rest] = args;
  const result =
    query === 'move'
      ? await move(j, rest, ctx, opts)
      : query === 'sprint'
        ? await sprint(j, rest, ctx, opts)
        : query === 'comment'
          ? await comment(j, rest, ctx, opts)
          : query === 'field'
            ? await field(j, rest, ctx, opts)
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

// Запись в Jira: перенос задачи в спринт. Список спринтов берётся с доски задачи.
async function sprint(j, [key, ...words], ctx, { yes, asObject, dryRun } = {}) {
  const name = words.join(' ').trim();
  if (!key || !ISSUE_KEY.test(key) || !name) {
    throw new CliError('Использование: fsh jira sprint <KEY> <спринт>, например fsh jira sprint FD-7647 "Спринт 18".', 1, 'usage');
  }
  const issue = await j.issue(key);
  const from = openSprints(fieldByName(issue, 'Sprint')).map((s) => s.name).join(', ') || 'без спринта';
  const { values = [] } = (await j.sprints(await boardOf(j, issue))) ?? {};
  const s = pickSprint(values, name);
  if (dryRun) return { ok: true, dry_run: true, key, from, to: s.name, sprint_id: s.id };
  if (!yes && !asObject && !confirm(`${key}: ${from} → ${s.name}. Переносим? [y/N] `)) {
    throw new CliError('Отменено.', 0, 'canceled');
  }
  await j.moveToSprint(s.id, [key]);
  return { ok: true, key, from, to: s.name, sprint_id: s.id, url: issueUrl(ctx, key) };
}

// Запись в Jira: комментарий. Текст уходит как есть, его увидит вся команда.
async function comment(j, [key, ...words], ctx, { yes, asObject, dryRun } = {}) {
  const text = words.join(' ').trim();
  if (!key || !ISSUE_KEY.test(key) || !text) {
    throw new CliError('Использование: fsh jira comment <KEY> <текст>.', 1, 'usage');
  }
  if (dryRun) return { ok: true, dry_run: true, key, comment: text };
  if (!yes && !asObject && !confirm(`${key}: опубликовать комментарий «${truncate(text, 60)}»? [y/N] `)) {
    throw new CliError('Отменено.', 0, 'canceled');
  }
  const created = await j.addComment(key, text);
  return { ok: true, key, comment: text, comment_id: created?.id ?? null, url: issueUrl(ctx, key) };
}

// Запись в Jira: любое поле по человеческому имени. id берётся из editmeta (customfield_*
// у каждого проекта свой), форма значения — из схемы поля, как в TUI.
async function field(j, [key, name, ...words], ctx, { yes, asObject, dryRun, file } = {}) {
  if (!key || !ISSUE_KEY.test(key) || !name) {
    throw new CliError('Использование: fsh jira field <KEY> "<имя поля>" <значение> или --file <путь|->.', 1, 'usage');
  }
  const meta = await j.editMeta(key);
  const entries = Object.entries(meta?.fields ?? {});
  const hit = entries.find(([, f]) => (f.name ?? '') === name) ?? entries.find(([, f]) => (f.name ?? '').toLowerCase() === name.toLowerCase());
  if (!hit) {
    const names = entries.filter(([, f]) => editKind(f)).map(([, f]) => f.name).sort().join(', ');
    throw new CliError(`У ${key} нет правимого поля "${name}". Есть: ${names}.`, 1, 'usage');
  }
  const [id, meta1] = hit;
  const kind = editKind(meta1);
  if (!kind) throw new CliError(`Поле "${meta1.name}" fsh заполнить нечем: тип ${meta1.schema?.type}.`, 1, 'usage');
  // Текст поля приходит файлом или stdin: результат скилла проекта многострочный,
  // в argv он не влезает и теряет переводы строк.
  const text = file ? String(readFileSync(file === '-' ? 0 : file, 'utf8')) : words.join(' ');
  if (!text.trim()) throw new CliError(`Нечего писать в "${meta1.name}": значение пустое.`, 1, 'usage');
  const value = shapeValue(meta1, kind, text);

  if (dryRun) return { ok: true, dry_run: true, key, field: meta1.name, field_id: id, value };
  if (!yes && !asObject && !confirm(`${key}: записать в «${meta1.name}» ${truncate(text.replace(/\n/g, ' '), 60)}? [y/N] `)) {
    throw new CliError('Отменено.', 0, 'canceled');
  }
  await j.updateIssue(key, { [id]: value });
  const after = await j.issue(key);
  const written = fieldText(after.fields?.[id]);
  if (!written) throw new CliError(`Jira приняла запись в "${meta1.name}", но при перечитывании поле пустое.`, 1, 'api_failed');
  return { ok: true, key, field: meta1.name, field_id: id, written, url: issueUrl(ctx, key) };
}

// Форма значения по типу поля: списки строк через запятую, число числом,
// выбор — сопоставлением с allowedValues, остальное текстом как есть.
function shapeValue(meta, kind, text) {
  if (kind === 'list') return text.split(',').map((v) => v.trim()).filter(Boolean);
  if (kind === 'number') return Number(text);
  if (kind !== 'pick') return text;
  const opts = meta.allowedValues ?? [];
  const opt = opts.find((v) => [v.value, v.name, v.displayName].some((n) => n && String(n).toLowerCase() === text.trim().toLowerCase()));
  if (!opt) {
    const list = opts.map((v) => fieldText(v)).filter(Boolean).join(', ') || 'варианты отдаёт только Jira';
    throw new CliError(`"${text.trim()}" не подходит полю "${meta.name}". Доступно: ${list}.`, 1, 'usage');
  }
  return editValueFor(meta, { id: opt.id, value: opt.value ?? opt.name, accountId: opt.accountId });
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
  if (r.transition || r.sprint_id) {
    console.log(`${r.key}: ${r.from} → ${r.to}${r.dry_run ? ' (dry-run, ничего не менял)' : ''}`);
    return;
  }
  if (r.comment) {
    console.log(`${r.key}: комментарий ${r.dry_run ? 'не опубликован (dry-run)' : `опубликован (#${r.comment_id})`}`);
    return;
  }
  if (r.field_id) {
    console.log(`${r.key}: «${r.field}» ${r.dry_run ? 'не записано (dry-run)' : 'записано'}`);
    if (r.written) console.log(truncate(r.written.replace(/\n/g, ' '), 100));
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
