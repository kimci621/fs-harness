import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ISSUE_KEY, createJira, editKind, editValueFor, fieldByName, fieldText, openSprints } from '../jira.js';
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
  parent: issue.fields?.parent ? { key: issue.fields.parent.key, summary: issue.fields.parent.fields?.summary ?? '' } : null,
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

// Справка подкоманды: печатается на голый вызов и в ошибках использования.
const SUB_USAGE = {
  move: 'fsh jira move <KEY> <статус> -y, например fsh jira move FD-7647 "В тестирование" -y',
  sprint: 'fsh jira sprint <KEY> <спринт|id> -y',
  comment: 'fsh jira comment <KEY> "<текст>" -y или fsh jira comment <KEY> --file <путь|-> -y',
  field: 'fsh jira field <KEY> "<поле>" — прочитать; fsh jira field <KEY> "<поле>" <значение>|--file <путь|-> [--append] -y — записать',
  parent: 'fsh jira parent <KEY> <EPIC> -y',
  create: 'fsh jira create <ПРОЕКТ> <тип> "<summary>" [--file <описание>|-] [--component <знач>] [--parent <EPIC>] [--sprint <id|имя>] [--assignee me|<кто>] -y',
  attach: 'fsh jira attach <KEY> [файл...] -y | fsh jira attach get <KEY> [имя|id] [--out <каталог>]',
  link: 'fsh jira link <KEY> <тип или фраза> <KEY2> -y',
  delete: 'fsh jira delete <KEY> -y',
  search: 'fsh jira search "<JQL>"',
  one: 'fsh jira show <KEY>',
};

const ACCOUNT_ID = /^(\d+:[0-9a-f-]{8,}|[0-9a-f]{24})$/;

// Пустой JQL собрал бы дефолтный «мои задачи» — молча не тот ответ.
function searchJql(words) {
  const jql = words.join(' ').trim();
  if (!jql) throw new CliError(`Использование: ${SUB_USAGE.search}.`, 1, 'usage');
  return jql;
}

// Слова, которыми агенты зовут подкоманды по привычке из других CLI.
const SYNONYMS = { show: 'one', view: 'one', transition: 'move' };

// fsh jira [mine|<KEY>] [фильтры] | show <KEY> | search "<JQL>" | move <KEY> <статус> | sprint <KEY> <спринт>
//   | comment <KEY> <текст> | field <KEY> "<поле>" [значение] | parent <KEY> <EPIC> | create <ПРОЕКТ> <тип> <summary> | delete <KEY>
export async function cmdJira(ctx, args, opts = {}) {
  const { json, asObject } = opts;
  const [first, ...rest] = args;
  const query = SYNONYMS[first] ?? first;
  if (SUB_USAGE[query] && !rest.length) {
    const help = { ok: true, usage: SUB_USAGE[query] };
    if (!asObject) json ? finish(true, help) : console.log(help.usage);
    return help;
  }
  const j = ctx.jira();
  const result =
    query === 'one'
      ? await one(j, rest[0], ctx)
      : query === 'search'
        ? await mine(j, { jql: searchJql(rest) }, ctx)
      : query === 'parent'
        ? await parent(j, rest, ctx, opts)
      : query === 'move'
      ? await move(j, rest, ctx, opts)
      : query === 'sprint'
        ? await sprint(j, rest, ctx, opts)
        : query === 'comment'
          ? await comment(j, rest, ctx, opts)
          : query === 'field'
            ? await field(j, rest, ctx, opts)
          : query === 'create'
            ? await create(j, rest, ctx, opts)
          : query === 'attach'
            ? await attach(j, rest, ctx, opts)
          : query === 'delete'
            ? await del(j, rest, ctx, opts)
          : query === 'link'
            ? await link(j, rest, ctx, opts)
          : !query || query === 'mine'
            ? await mine(j, { ...opts, componentField: ctx.cfg.jira?.componentField }, ctx)
            : await one(j, query, ctx);

  if (asObject) return result;
  if (json) finish(true, result);
  else render(result, ctx);
  return result;
}

async function mine(j, filters, ctx) {
  const jql = buildJql(filters);
  const { issues } = await j.searchJql({ jql, fields: ['summary', 'status', 'updated', 'issuetype', 'priority', 'parent'] });
  return { ok: true, jql, issues: issues.map((i) => ({ ...brief(i), url: issueUrl(ctx, i.key) })) };
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
async function comment(j, [key, ...words], ctx, { yes, asObject, dryRun, file } = {}) {
  const text = (file ? readText(file) : words.join(' ')).trim();
  if (!key || !ISSUE_KEY.test(key) || !text) {
    throw new CliError(`Использование: ${SUB_USAGE.comment}.`, 1, 'usage');
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
async function field(j, [key, name, ...words], ctx, opts = {}) {
  const { yes, asObject, dryRun, file, attach: alsoAttach, append } = opts;
  if (!key || !ISSUE_KEY.test(key) || !name) throw new CliError(`Использование: ${SUB_USAGE.field}.`, 1, 'usage');
  if (!file && !words.length) return readField(j, key, name, ctx);
  // Родитель в editmeta — issuelink, PUT поля его не ставит: у него своя подкоманда.
  if (/^(parent|родитель)$/i.test(name)) return parent(j, [key, ...words], ctx, opts);
  const meta = await j.editMeta(key);
  const entries = Object.entries(meta?.fields ?? {});
  const [id] = findField(entries.map(([fid, f]) => [fid, f.name ?? '']), name) ?? [];
  if (!id) {
    const names = entries.filter(([, f]) => editKind(f)).map(([, f]) => f.name).sort().join(', ');
    throw new CliError(`У ${key} нет правимого поля "${name}". Есть: ${names}.`, 1, 'usage');
  }
  const meta1 = meta.fields[id];
  const kind = editKind(meta1);
  if (!kind) throw new CliError(`Поле "${meta1.name}" fsh заполнить нечем: тип ${meta1.schema?.type}.`, 1, 'usage');
  // Текст поля приходит файлом или stdin: результат скилла проекта многострочный,
  // в argv он не влезает и теряет переводы строк.
  const piece = file ? readText(file) : words.join(' ');
  if (!piece.trim()) throw new CliError(`Нечего писать в "${meta1.name}": значение пустое.`, 1, 'usage');
  if (append && kind !== 'text' && kind !== 'editor') {
    throw new CliError(`--append только для текстовых полей, а "${meta1.name}" — ${kind}.`, 1, 'usage');
  }
  const current = append ? fieldText((await j.issue(key)).fields?.[id]).replace(/\s+$/, '') : '';
  const text = current ? `${current}\n${piece}` : piece;
  const isUser = meta1.schema?.type === 'user' || meta1.schema?.items === 'user';
  const userOpts = isUser && !meta1.allowedValues?.length ? await userOptions(j, text, () => j.assignableUsers?.(key)) : null;
  const value = shapeValue(meta1, kind, text, userOpts);

  // --attach: тот же файл ложится и в поле текстом, и вложением. Со stdin нечего прикладывать.
  if (alsoAttach && (!file || file === '-')) {
    throw new CliError('--attach нужен файл: с --file - (stdin) прикладывать нечего.', 1, 'usage');
  }
  if (dryRun) return { ok: true, dry_run: true, key, field: meta1.name, field_id: id, value, attach: Boolean(alsoAttach) };
  if (!yes && !asObject && !confirm(`${key}: ${append ? 'дописать' : 'записать'} в «${meta1.name}» ${truncate(piece.replace(/\n/g, ' '), 60)}? [y/N] `)) {
    throw new CliError('Отменено.', 0, 'canceled');
  }
  await j.updateIssue(key, { [id]: value });
  const after = await j.issue(key);
  const written = fieldText(after.fields?.[id]);
  if (!written) throw new CliError(`Jira приняла запись в "${meta1.name}", но при перечитывании поле пустое.`, 1, 'api_failed');
  const attached = alsoAttach ? (await j.addAttachment(key, [{ name: basename(file), data: readFileSync(file) }])).map(attachBrief) : null;
  return { ok: true, key, field: meta1.name, field_id: id, written, ...(attached ? { attached } : {}), url: issueUrl(ctx, key) };
}

// Русские имена системных полей: id у них одинаковые на любом инстансе, в отличие от customfield_*.
const FIELD_ALIASES = { исполнитель: 'assignee', описание: 'description', метки: 'labels', приоритет: 'priority', автор: 'reporter' };

// Поле по имени из пар [id, имя]: точное, без регистра, затем русский алиас системного поля.
function findField(pairs, name) {
  const lower = name.toLowerCase();
  return pairs.find(([, n]) => n === name) ?? pairs.find(([, n]) => n.toLowerCase() === lower)
    ?? pairs.find(([id]) => id === FIELD_ALIASES[lower]);
}

export const readText = (file) => String(readFileSync(file === '-' ? 0 : file, 'utf8'));

// Чтение одного поля как есть: textarea приходит wiki-разметкой, её и отдаём, чтобы дописать.
async function readField(j, key, name, ctx) {
  const issue = await j.issue(key);
  const [id, label] = findField(Object.entries(issue.names ?? {}), name) ?? [];
  if (!id) {
    throw new CliError(`У ${key} нет поля "${name}". Есть: ${Object.values(issue.names ?? {}).sort().join(', ')}.`, 1, 'usage');
  }
  const value = issue.fields?.[id] ?? null;
  return { ok: true, read: true, key, field: label, field_id: id, value, text: fieldText(value), url: issueUrl(ctx, key) };
}

// Запись в Jira: родитель (эпик). Через PUT поля parent, итог сверяется чтением.
async function parent(j, [key, epic], ctx, { yes, asObject, dryRun } = {}) {
  if (!key || !epic || !ISSUE_KEY.test(key) || !ISSUE_KEY.test(epic)) throw new CliError(`Использование: ${SUB_USAGE.parent}.`, 1, 'usage');
  const parentOf = async () => (await j.issue(key)).fields?.parent?.key ?? null;
  const from = (await parentOf()) ?? 'без родителя';
  const res = { ok: true, key, from, to: epic, parent: epic, url: issueUrl(ctx, key) };
  if (from === epic) return { ...res, existed: true };
  if (dryRun) return { ...res, dry_run: true };
  if (!yes && !asObject && !confirm(`${key}: родитель ${from} → ${epic}? [y/N] `)) {
    throw new CliError('Отменено.', 0, 'canceled');
  }
  await j.updateIssue(key, { parent: { key: epic } });
  const after = await parentOf();
  if (after !== epic) {
    throw new CliError(`Jira приняла родителя ${epic}, но у ${key} он ${after ?? 'не задан'}. Проверь тип задачи и иерархию.`, 1, 'api_failed');
  }
  return res;
}

// Кандидаты для поля-человека: назначаемые люди, а на «me» — ещё и сам вошедший.
async function userOptions(j, text, loadUsers) {
  const users = (await loadUsers()) ?? [];
  if (text.trim().toLowerCase() !== 'me') return users;
  const me = await j.myself?.().catch(() => null);
  return me ? [{ ...me, value: 'me' }, ...users] : users;
}

const ASSIGNEE_META = { name: 'Assignee', schema: { type: 'user', system: 'assignee' } };

// Спринт для задачи, которой ещё нет: доска — первая доска проекта, как у boardOf.
async function projectSprint(j, project, name) {
  const { values: boards = [] } = (await j.boards(project)) ?? {};
  if (!boards.length) throw new CliError(`У проекта ${project} нет доски — спринт назначать некуда.`, 1, 'api_failed');
  const { values = [] } = (await j.sprints(boards[0].id)) ?? {};
  return pickSprint(values, name);
}

// Форма значения по типу поля: списки строк через запятую, число числом,
// выбор — сопоставлением с allowedValues или списком людей, остальное текстом как есть.
function shapeValue(meta, kind, text, customOpts = null) {
  if (kind === 'list') return text.split(',').map((v) => v.trim()).filter(Boolean);
  if (kind === 'number') return Number(text);
  if (kind !== 'pick') return text;
  const opts = customOpts ?? meta.allowedValues ?? [];
  const findOne = (raw) => {
    const q = raw.trim().toLowerCase();
    const opt = opts.find((v) => [v.value, v.name, v.displayName, v.emailAddress, v.accountId].some((n) => n && String(n).toLowerCase() === q))
      ?? (customOpts ? opts.find((v) => [v.displayName, v.name, v.emailAddress].some((n) => n && String(n).toLowerCase().includes(q))) : null);
    // Список людей Jira отдаёт первыми 50: accountId за его пределами Jira примет и так.
    if (!opt && customOpts && ACCOUNT_ID.test(raw.trim())) return { accountId: raw.trim() };
    if (!opt) {
      const list = opts.map((v) => fieldText(v)).filter(Boolean).join(', ') || 'варианты отдаёт только Jira';
      const how = customOpts ? ' Пиши имя как в Jira, me или accountId.' : '';
      throw new CliError(`"${raw.trim()}" не подходит полю "${meta.name}". Доступно: ${list}.${how}`, 1, 'usage');
    }
    return opt;
  };
  if (customOpts && meta?.schema?.type === 'array' && text.includes(',')) {
    const picks = text.split(',').map((s) => s.trim()).filter(Boolean).map(findOne);
    return picks.map((p) => ({ accountId: p.accountId }));
  }
  const opt = findOne(text);
  return editValueFor(meta, { id: opt.id, value: opt.value ?? opt.name, accountId: opt.accountId });
}

// Запись в Jira: создание задачи. Обязательное — проект, тип, summary; описание — --file или stdin.
// Список типов проекта берётся из createmeta, чтобы опечатку в типе поймать до POST.
async function create(j, [project, type, ...words], ctx, opts = {}) {
  const { yes, asObject, dryRun, file, component, parent: epic, sprint: sprintName, assignee } = opts;
  const summary = words.join(' ').trim();
  if (!project || !type || !summary || (epic && !ISSUE_KEY.test(epic))) {
    throw new CliError(`Использование: ${SUB_USAGE.create}.`, 1, 'usage');
  }
  const types = await j.createTypes(project);
  const lower = type.toLowerCase();
  const t = types.find((x) => x.name.toLowerCase() === lower) ?? types.find((x) => x.name.toLowerCase().includes(lower));
  if (!t) {
    const list = types.map((x) => x.name).join(', ') || 'createmeta пуст';
    throw new CliError(`Типа "${type}" нет в проекте ${project}. Доступны: ${list}.`, 1, 'usage');
  }
  const description = file ? readText(file).trim() : '';
  const fields = { project: { key: project }, issuetype: { id: String(t.id) }, summary };
  if (description) fields.description = description;
  if (epic) fields.parent = { key: epic };
  // Спринт и исполнитель проверяются до POST: опечатка не должна оставить задачу сделанной наполовину.
  const sprintTo = sprintName ? await projectSprint(j, project, sprintName) : null;
  if (assignee) fields.assignee = shapeValue(ASSIGNEE_META, 'pick', assignee, await userOptions(j, assignee, () => j.projectUsers(project)));

  // «Компонент» — customfield проекта, его id и форму значения даёт только createmeta
  // с expand: editmeta без задачи не работает. Неизвестное значение не молчим — ошибкой.
  if (component) {
    const meta0 = await j.createMeta(project, t.id);
    const name = ctx.cfg.jira?.componentField || 'Компонент';
    const entry = Object.entries(meta0?.fields ?? {}).find(([, f]) => (f.name ?? '') === name);
    if (!entry) {
      const names = Object.values(meta0?.fields ?? {}).map((f) => f.name).filter(Boolean).join(', ');
      throw new CliError(`У типа ${t.name} нет поля "${name}" для создания. Есть: ${names}. Или задай jira.componentField в конфиге.`, 1, 'usage');
    }
    const [id, meta1] = entry;
    const kind = editKind(meta1);
    if (!kind) throw new CliError(`Поле "${meta1.name}" fsh заполнить нечем: тип ${meta1.schema?.type}.`, 1, 'usage');
    fields[id] = shapeValue(meta1, kind, component);
  }

  const extras = { component: component ?? null, parent: epic ?? null, sprint: sprintName ?? null, assignee: assignee ?? null };
  if (dryRun) return { ok: true, dry_run: true, project, type: t.name, summary, described: Boolean(description), ...extras };
  if (!yes && !asObject && !confirm(`${project}: создать задачу типа ${t.name} «${truncate(summary, 60)}»? [y/N] `)) {
    throw new CliError('Отменено.', 0, 'canceled');
  }
  const res = await j.createIssue(fields);
  if (!res?.key) throw new CliError('Jira ответила без ключа задачи — создание под вопросом, проверь руками.', 1, 'api_failed');
  // Спринт ставится уже созданной задаче: его сбой не должен выглядеть как «не создана».
  if (sprintTo) {
    await j.moveToSprint(sprintTo.id, [res.key]).catch((err) => {
      throw new CliError(`Задача ${res.key} создана, но не в спринте: ${err.message} Доделай: fsh jira sprint ${res.key} ${sprintTo.id} -y`, 1, 'api_failed');
    });
  }
  return { ok: true, key: res.key, project, type: t.name, summary, ...extras, url: issueUrl(ctx, res.key) };
}

const kb = (n) => (n >= 1024 ? `${Math.round(n / 1024)} КБ` : `${n} Б`);

const ATTACH_USAGE ='Использование: fsh jira attach <KEY> [файл...] | fsh jira attach get <KEY> [имя|id] [--out <каталог>].';

const attachBrief = (a) => ({
  id: String(a.id),
  filename: a.filename,
  size: a.size ?? 0,
  mime: a.mimeType ?? '',
  created: a.created ?? '',
  author: a.author?.displayName ?? '',
});

// Запись 7. Вложения: без файлов — список, с файлами — аплоад, get — выгрузка на диск.
async function attach(j, rest, ctx, opts = {}) {
  if (rest[0] === 'get') return attachGet(j, rest.slice(1), ctx, opts);
  const [key, ...paths] = rest;
  if (!key || !ISSUE_KEY.test(key)) throw new CliError(ATTACH_USAGE, 1, 'usage');
  if (!paths.length) {
    return { ok: true, key, attachments: (await j.attachments(key)).map(attachBrief), url: issueUrl(ctx, key) };
  }
  const files = paths.map((p) => {
    if (!existsSync(p)) throw new CliError(`Файла нет: ${p}.`, 1, 'usage');
    return { name: basename(p), data: readFileSync(p), path: p };
  });
  const names = files.map((f) => f.name).join(', ');
  if (opts.dryRun) return { ok: true, dry_run: true, key, files: files.map((f) => ({ name: f.name, size: f.data.length })) };
  if (!opts.yes && !opts.asObject && !confirm(`${key}: приложить ${names}? [y/N] `)) {
    throw new CliError('Отменено.', 0, 'canceled');
  }
  const added = await j.addAttachment(key, files);
  if (!Array.isArray(added) || added.length !== files.length) {
    throw new CliError(`Jira приняла не все вложения: отправлено ${files.length}, вернулось ${added?.length ?? 0}.`, 1, 'api_failed');
  }
  return { ok: true, key, attached: added.map(attachBrief), url: issueUrl(ctx, key) };
}

// Выгрузка вложения. Имя файла из Jira — чужой ввод: берём только basename,
// иначе "../.." в имени увёл бы запись из каталога назначения.
async function attachGet(j, [key, which], ctx, { out, asObject, dryRun } = {}) {
  if (!key || !ISSUE_KEY.test(key)) throw new CliError(ATTACH_USAGE, 1, 'usage');
  const list = await j.attachments(key);
  if (!list.length) throw new CliError(`У ${key} нет вложений.`, 1, 'usage');
  const lower = String(which ?? '').toLowerCase();
  const picked = which
    ? list.filter((a) => String(a.id) === which || (a.filename ?? '').toLowerCase().includes(lower))
    : list;
  if (!picked.length) {
    throw new CliError(`У ${key} нет вложения "${which}". Есть: ${list.map((a) => a.filename).join(', ')}.`, 1, 'usage');
  }
  const dir = out || process.cwd();
  if (dryRun) return { ok: true, dry_run: true, key, dir, files: picked.map((a) => basename(a.filename)) };
  const saved = [];
  for (const a of picked) {
    const data = Buffer.from(await j.attachmentData(a.content));
    const path = join(dir, basename(a.filename));
    writeFileSync(path, data);
    saved.push({ name: basename(a.filename), path, size: data.length });
  }
  return { ok: true, key, saved };
}

// Запись в Jira: удаление задачи. Необратимо, поэтому подтверждение по умолчанию; -y его снимает.
async function del(j, [key], ctx, { yes, asObject, dryRun } = {}) {
  if (!key || !ISSUE_KEY.test(key)) {
    throw new CliError('Использование: fsh jira delete <KEY>.', 1, 'usage');
  }
  const issue = await j.issue(key);
  const title = issue.fields?.summary ?? '';
  if (dryRun) return { ok: true, dry_run: true, key, summary: title };
  if (!yes && !asObject && !confirm(`Удалить ${key} «${truncate(title, 60)}» навсегда? [y/N] `, { irreversible: true })) {
    throw new CliError('Отменено.', 0, 'canceled');
  }
  await j.deleteIssue(key);
  return { ok: true, key, summary: title };
}

// Тип связи по слову человека: имя типа или его фраза. Фраза inward («is blocked by») значит,
// что первая задача — принимающая сторона. Неоднозначность — ошибка со списком.
export function pickLinkType(types, phrase) {
  const all = types ?? [];
  const q = String(phrase).trim().toLowerCase();
  const words = (t) => [t.name, t.outward, t.inward].map((w) => String(w ?? '').toLowerCase());
  const exact = all.find((t) => words(t).includes(q));
  const hits = exact ? [exact] : all.filter((t) => words(t).some((w) => w.includes(q)));
  if (hits.length !== 1) {
    const list = all.map((t) => `${t.name} (${t.outward} / ${t.inward})`).join(', ') || 'Jira не отдала типов';
    const why = hits.length ? `"${phrase}" подходит нескольким типам` : `Типа связи "${phrase}" нет`;
    throw new CliError(`${why}. Доступны: ${list}.`, 1, 'usage');
  }
  const type = hits[0];
  const [name, outward, inward] = words(type);
  const asInward = inward !== outward && (inward === q || (inward.includes(q) && !outward.includes(q) && name !== q));
  return { type, asInward };
}

const LINK_USAGE = 'Использование: fsh jira link <KEY> <тип или фраза> <KEY2>, например fsh jira link FD-2 blocks FD-1 или fsh jira link FD-2 relates FD-1.';

// Запись в Jira: связь двух задач. Читается как фраза: «FD-2 blocks FD-1».
async function link(j, args, ctx, { yes, asObject, dryRun } = {}) {
  const [from, ...rest] = args;
  const to = rest.pop();
  const phrase = rest.join(' ').trim();
  if (!from || !to || !phrase || !ISSUE_KEY.test(from) || !ISSUE_KEY.test(to)) throw new CliError(LINK_USAGE, 1, 'usage');
  if (from === to) throw new CliError(`${from} не связывается сама с собой.`, 1, 'usage');
  const { type, asInward } = pickLinkType(await j.linkTypes(), phrase);
  const verb = asInward ? type.inward : type.outward;
  const sentence = `${from} ${verb} ${to}`;
  // Связи со стороны первой задачи: outwardIssue в её связях = «from <outward> to».
  const shownNow = async () =>
    (await j.issueLinks(from))
      .filter((l) => l.type?.name === type.name)
      .map((l) => (l.outwardIssue?.key === to ? type.outward : l.inwardIssue?.key === to ? type.inward : null))
      .filter(Boolean);
  if ((await shownNow()).includes(verb)) {
    return { ok: true, key: from, link: sentence, type: type.name, target: to, existed: true, url: issueUrl(ctx, from) };
  }
  if (dryRun) return { ok: true, dry_run: true, key: from, link: sentence, type: type.name, target: to };
  if (!yes && !asObject && !confirm(`Связать: ${sentence}? [y/N] `)) throw new CliError('Отменено.', 0, 'canceled');

  const [inward, outward] = asInward ? [to, from] : [from, to];
  await j.createLink({ type: type.name, inward, outward });

  const shown = await shownNow();
  if (!shown.length) throw new CliError(`Jira приняла связь «${sentence}», но у ${from} её не видно. Проверь в Jira.`, 1, 'api_failed');
  if (!shown.includes(verb)) {
    throw new CliError(`Связь легла в обратную сторону: ${from} ${shown[0]} ${to}. Удали её в Jira и сообщи об ошибке fsh.`, 1, 'api_failed');
  }
  return { ok: true, key: from, link: sentence, type: type.name, target: to, url: issueUrl(ctx, from) };
}

async function one(j, key, ctx) {
  if (!ISSUE_KEY.test(key)) {
    throw new CliError(`"${key}" не похоже на ключ задачи (FD-7647). Использование: fsh jira [mine|<KEY>].`, 1, 'usage');
  }
  const issue = await j.issue(key);
  const { comments = [] } = (await j.comments(key)) ?? {};
  // Дети эпика в fields.subtasks не попадают, parent = KEY находит и их, и сабтаски.
  const { issues: children = [] } = await j.searchJql({ jql: `parent = ${key} ORDER BY status`, fields: ['summary', 'status'], max: 100 });
  return {
    ok: true,
    issue: {
      ...brief(issue),
      description: issue.fields?.description ?? '',
      assignee: issue.fields?.assignee?.displayName ?? null,
      reporter: issue.fields?.reporter?.displayName ?? null,
      subtasks: children.map((t) => ({ key: t.key, summary: t.fields?.summary ?? '', status: t.fields?.status?.name ?? '—' })),
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
  if (r.read) {
    if (r.text) console.log(r.text);
    else console.error(`${r.key}: «${r.field}» пустое`);
    return;
  }
  if (r.link) {
    console.log(`${r.link}${r.existed ? ' — связь уже была' : r.dry_run ? ' — не связано (dry-run)' : ' — связано'}`);
    return;
  }
  if (r.project) {
    console.log(`${r.project}: задача типа ${r.type} ${r.dry_run ? 'не создана (dry-run)' : `создана: ${r.key}`}`);
    console.log(truncate(r.summary, 80));
    return;
  }
  if (r.summary && !r.issue && !r.issues) {
    console.log(`${r.key}: ${r.dry_run ? 'не удалён (dry-run)' : 'удалён'}${r.transition ? '' : ''}`.trim());
    return;
  }
  if (r.transition || r.sprint_id || r.parent) {
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
    if (r.attached) console.log(`📎 вложением: ${r.attached.map((a) => a.filename).join(', ')}`);
    return;
  }
  if (r.saved) {
    for (const s of r.saved) console.log(`⬇️  ${s.path} (${kb(s.size)})`);
    return;
  }
  if (r.attached || r.attachments || (r.dry_run && r.files)) {
    const list = r.attached ?? r.attachments ?? r.files;
    if (!list.length) return void console.log(`У ${r.key} вложений нет.`);
    if (r.dry_run) return void console.log(`${r.key}: не приложено (dry-run): ${list.map((f) => f.name).join(', ')}`);
    const verb = r.attached ? 'приложено' : 'вложений';
    console.log(`${r.key}: ${verb} ${list.length}`);
    console.log(table(list.map((a) => [a.id, truncate(a.filename, 50), kb(a.size), a.author, humanize(a.created)])));
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
