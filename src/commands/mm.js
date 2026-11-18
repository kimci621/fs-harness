import { expandHome, projectByDir } from '../config.js';
import { createMattermost, reviewMessage } from '../mattermost.js';
import { writeSecret } from '../secrets.js';
import { makeGit } from '../workspace.js';
import { ISSUE_KEY, keyFromBranch } from '../jira.js';
import { issueUrl, readText } from './jira.js';
import { finish } from '../output.js';
import { table } from '../format.js';
import { confirm, promptSecret } from '../ui.js';
import { CliError } from '../errors.js';

// fsh mm login|whoami|channels|post|review|reply|thread|react — сообщения в Mattermost от имени человека.
// Сценарий здесь один (review): канал на сценарий берётся из mattermost.channels.
const MM_USAGE = [
  'fsh mm post <сценарий|канал|@ник> "<текст>" -y',
  'fsh mm review [KEY] -y',
  'fsh mm reply <KEY|permalink> "<текст>" -y',
  'fsh mm thread <permalink|id поста> [--last N] [--since <ISO-время>]',
  'fsh mm react <permalink|id поста> <эмодзи>',
  'fsh mm edit <permalink|id поста> (--file <путь> | "<текст>") -y',
  'fsh mm delete <permalink|id поста> -y',
  'fsh mm channels [строка] | fsh mm whoami | fsh mm login [логин]',
].join('\n');

export async function cmdMM(ctx, args, opts = {}) {
  const [sub, ...rest] = args;
  if (!sub) {
    const help = { ok: true, usage: MM_USAGE };
    if (!opts.asObject) opts.json ? finish(true, help) : console.log(MM_USAGE);
    return help;
  }
  const result =
    sub === 'login' ? await login(ctx, rest)
      : sub === 'whoami' ? await whoami(ctx)
        : sub === 'channels' ? await channels(ctx, rest)
        : sub === 'post' ? await post(ctx, rest, opts)
          : sub === 'review' ? await review(ctx, rest, opts)
            : sub === 'reply' ? await reply(ctx, rest, opts)
              : sub === 'thread' ? await thread(ctx, rest, opts)
                : sub === 'react' ? await react(ctx, rest, opts)
                  : sub === 'edit' ? await edit(ctx, rest, opts)
                    : sub === 'delete' ? await del(ctx, rest, opts)
                  : (() => { throw new CliError(`Использование: fsh mm <подкоманда>\n${MM_USAGE}`, 1, 'usage'); })();

  if (opts.asObject) return result;
  if (opts.json) finish(true, result);
  else render(result);
  return result;
}

// id канала в Mattermost — ровно 26 символов [a-z0-9]. Всё, что не подошло, считаем именем.
const CHANNEL_ID = /^[a-z0-9]{26}$/;

// Куда пишем: имя сценария из конфига (review), сам id или имя канала (team/name либо name).
// Имя из конфига разворачивается здесь же — сценарий тоже можно задать именем, а не id.
export function resolveChannel(cfg, name) {
  const channels = cfg.mattermost?.channels ?? {};
  if (!name) {
    throw new CliError(`Не задан канал. Сценарии из конфига: ${Object.keys(channels).join(', ') || '—'}.`, 1, 'usage');
  }
  const ref = channels[name] || name;
  if (!ref) {
    throw new CliError(`У сценария "${name}" нет канала: заполни mattermost.channels.${name} в конфиге.`, 1, 'config_invalid');
  }
  return { id: ref, scenario: channels[name] ? name : '' };
}

// Имя канала → id. Сам id проходит насквозь, в сеть за ним не ходим.
// `team/name` спрашиваем напрямую, голое имя ищем по своим командам.
export async function channelId(ctx, ref) {
  if (CHANNEL_ID.test(ref)) return ref;
  const mm = ctx.mm();
  // @ник — личка: direct-канал создаётся при первом обращении, дальше тот же.
  if (ref.startsWith('@')) {
    const [user] = (await mm.usersByUsernames([ref.slice(1)])) ?? [];
    if (!user) throw new CliError(`Пользователя ${ref} нет в Mattermost.`, 1, 'not_found');
    return (await mm.directChannel((await mm.me()).id, user.id)).id;
  }
  if (ref.includes('/')) {
    const [team, name] = ref.split('/');
    const ch = await mm.channelByName(team, name);
    if (!ch) throw new CliError(`В команде "${team}" нет канала "${name}".`, 1, 'not_found');
    return ch.id;
  }
  for (const team of await mm.teams()) {
    const ch = await mm.channelByName(team.name, ref);
    if (ch) return ch.id;
  }
  throw new CliError(`Канала "${ref}" нет ни в одной твоей команде. Найди его: fsh mm channels ${ref}`, 1, 'not_found');
}

// Свои каналы с фильтром по подстроке: id взять больше неоткуда — в URL лежит имя, не id.
async function channels(ctx, [term = '']) {
  const mm = ctx.mm();
  const needle = term.toLowerCase();
  const found = [];
  for (const team of await mm.teams()) {
    for (const ch of await mm.myChannels(team.id)) {
      if (ch.type !== 'O' && ch.type !== 'P') continue; // личные и групповые пропускаем
      const hay = `${ch.display_name} ${ch.name}`.toLowerCase();
      if (needle && !hay.includes(needle)) continue;
      found.push({ id: ch.id, name: ch.name, title: ch.display_name, team: team.name, private: ch.type === 'P' });
    }
  }
  found.sort((a, b) => a.title.localeCompare(b.title, 'ru'));
  return { ok: true, channels: found, total: found.length };
}

// Вход по логину и паролю: на этом инстансе Personal Access Tokens выключены, а сессионный
// токен — единственный способ писать от своего имени. Пароль не хранится нигде, в keychain
// уезжает только токен.
async function login(ctx, [maybeLogin]) {
  const mm = createMattermost(ctx.cfg.mattermost);
  const loginId = maybeLogin || process.env.FS_HARNESS_MM_LOGIN || '';
  if (!loginId) throw new CliError('Использование: fsh mm login <логин или почта>.', 1, 'usage');
  const password = process.env.FS_HARNESS_MM_PASSWORD || await promptSecret(`Пароль Mattermost для ${loginId}: `);
  if (!password) throw new CliError('Пустой пароль.', 1, 'usage');

  const { token, user } = await mm.login({ loginId, password });
  writeSecret('mattermost', token);
  return { ok: true, saved: true, user: { id: user.id, username: user.username, email: user.email ?? '' } };
}

async function whoami(ctx) {
  const user = await ctx.mm().me();
  return { ok: true, user: { id: user.id, username: user.username, email: user.email ?? '' } };
}

async function post(ctx, [channel, ...words], opts) {
  const text = words.join(' ').trim();
  if (!text) throw new CliError('Использование: fsh mm post <сценарий|канал|@ник> "<текст>".', 1, 'usage');
  return send(ctx, resolveChannel(ctx.cfg, channel), text, opts);
}

// Сценарий «задача уехала в ревью»: MR по текущей ветке плюс ссылка на задачу.
async function review(ctx, [maybeKey], opts) {
  // Запуск из worktree проекта: ветка берётся из него, а не из основного checkout.
  const here = projectByDir(ctx.cfg, process.cwd()) === ctx.cfg.activeProject ? process.cwd() : '';
  const dir = expandHome(opts.projectDir || here || ctx.cfg.projectDir || '');
  if (!dir) throw new CliError('Не задан каталог проекта: --project-dir или projects.<имя>.dir в конфиге.', 1, 'config_invalid');
  const branch = makeGit(dir)(['rev-parse', '--abbrev-ref', 'HEAD']);
  const open = await ctx.g.listOpenMRs(ctx.repo, { source_branch: branch });
  const mr = open?.[0] ?? null;
  if (!mr) {
    throw new CliError(`Из ветки ${branch} нет открытого MR: сначала fsh task push.`, 1, 'no_mr');
  }
  return postReview(ctx, { iid: mr.iid, mrUrl: mr.web_url, key: maybeKey || keyFromBranch(branch), title: mr.title }, opts);
}

// Общая точка сценария: зовут и `fsh mm review`, и `fsh task push --post`.
// --channel подменяет канал разово: проверить формат в личке, не трогая общий чат.
export async function postReview(ctx, { iid, mrUrl, key, title }, opts = {}) {
  let mrTitle = title;
  if (!mrTitle && iid && ctx.g?.getMR) {
    try {
      const mr = await ctx.g.getMR(ctx.repo, iid);
      mrTitle = mr?.title;
    } catch {
      // игнорируем ошибку получения MR
    }
  }
  const text = reviewMessage({ iid, mrUrl, key, issueUrl: key ? issueUrl(ctx, key) : '', title: mrTitle });
  return send(ctx, resolveChannel(ctx.cfg, opts.channel || 'review'), text, opts);
}

// Ответ в тред: по ключу задачи — под свой последний корневой пост с ключом в канале сценария
// (сообщение `fsh mm review`), по permalink или id поста — в тред этого поста, где бы он ни был.
async function reply(ctx, [ref, ...words], opts) {
  const text = words.join(' ').trim();
  if (!ref || !text) {
    throw new CliError('Использование: fsh mm reply <KEY|permalink> "<текст>".', 1, 'usage');
  }
  const { target, scenario, rootId, label } = ISSUE_KEY.test(ref)
    ? await taskRoot(ctx, ref, opts)
    : await postRoot(ctx, ref);
  if (opts.dryRun) return { ok: true, dry_run: true, channel: target, scenario, root_id: rootId, text };
  if (!opts.yes && !opts.asObject && !confirm(`Ответить в тред ${label}?\n${text}\n[y/N] `)) {
    throw new CliError('Отменено.', 0, 'canceled');
  }
  const created = await ctx.mm().post(target, text, { rootId });
  return { ok: true, channel: target, scenario, root_id: rootId, text, post_id: created?.id ?? null, post_url: await permalink(ctx, created?.id, target) };
}

// ponytail: свой корневой пост с ключом ищем только в последних 200 постах канала, без порога по дате;
// ушедший глубже не найдётся — тогда листать channelPosts по page или /posts/search.
export async function findTaskPost(ctx, key, opts = {}) {
  const { id, scenario } = resolveChannel(ctx.cfg, opts.channel || 'review');
  const mm = ctx.mm();
  const target = await channelId(ctx, id);
  const me = await mm.me();
  const { order = [], posts = {} } = await mm.channelPosts(target);
  const mention = new RegExp(`\\b${key}\\b`);
  const root = order.map((postId) => posts[postId])
    .find((p) => p && !p.root_id && p.user_id === me.id && mention.test(p.message ?? '')) ?? null;
  return { target, scenario, root };
}

async function taskRoot(ctx, key, opts) {
  const { target, scenario, root } = await findTaskPost(ctx, key, opts);
  if (!root) {
    throw new CliError(
      `В ${scenario || target} среди последних постов нет твоего поста про ${key}. Ответь по ссылке на тред: `
        + `fsh mm reply <permalink> "<текст>" -y, или, если задачу ещё не отписывали, сначала fsh mm review ${key} -y.`,
      1,
      'not_found',
    );
  }
  return { target, scenario, rootId: root.id, label: `${key} (${scenario || target})` };
}

// Ссылка может указывать на ответ внутри треда — отвечаем в корень, иначе Mattermost отклонит root_id.
async function postRoot(ctx, ref) {
  const id = postIdFrom(ref, 'fsh mm reply <KEY|permalink> "<текст>"');
  const p = await ctx.mm().getPost(id);
  if (!p) throw new CliError(`Поста ${id} нет или он тебе не виден.`, 1, 'not_found');
  return { target: p.channel_id, scenario: '', rootId: p.root_id || p.id, label: p.root_id || p.id };
}

// Permalink вида https://mm/<team>/pl/<id> или сам id поста → id. Остальное — usage.
export function postIdFrom(ref = '', usage = 'fsh mm thread <permalink|id поста>') {
  const id = String(ref).trim().replace(/[?#].*$/, '').split('/').filter(Boolean).pop() ?? '';
  if (!CHANNEL_ID.test(id)) throw new CliError(`Использование: ${usage}.`, 1, 'usage');
  return id;
}

// Чтение треда по возрастанию времени: только GET, в чат ничего не пишет.
// --since и --last режут уже скачанный тред: total остаётся числом всех сообщений.
async function thread(ctx, [ref], { last, since } = {}) {
  const sinceMs = since ? Date.parse(since) : 0;
  if (Number.isNaN(sinceMs)) throw new CliError(`--since ждёт дату или время ISO (2026-11-18T10:00), а не "${since}".`, 1, 'usage');
  if (last !== undefined && last !== null && !(Number.isInteger(last) && last > 0)) {
    throw new CliError('--last ждёт целое число больше нуля.', 1, 'usage');
  }
  const mm = ctx.mm();
  const { order = [], posts = {} } = await mm.thread(postIdFrom(ref));
  const all = order.map((id) => posts[id]).filter(Boolean).sort((a, b) => a.create_at - b.create_at);
  const fresh = all.filter((p) => p.create_at >= sinceMs);
  const list = last ? fresh.slice(-last) : fresh;
  const userIds = [...new Set(list.map((p) => p.user_id))];
  const users = Object.fromEntries((userIds.length ? await mm.usersByIds(userIds) : []).map((u) => [u.id, u.username]));
  const messages = list.map((p) => ({
    id: p.id,
    at: new Date(p.create_at).toISOString(),
    user: users[p.user_id] ?? p.user_id,
    text: p.message ?? '',
    files: (p.metadata?.files ?? []).map((f) => f.name),
  }));
  return { ok: true, root_id: all[0]?.root_id || all[0]?.id || '', messages, shown: messages.length, total: all.length };
}

// Запись в общий чат: как и все записи в харнессе — dry-run показывает, подтверждение спрашивает.
async function send(ctx, { id, scenario }, text, opts) {
  if (opts.dryRun) return { ok: true, dry_run: true, channel: id, scenario, text };
  if (!opts.yes && !opts.asObject && !confirm(`Отправить в ${scenario || id}?\n${text}\n[y/N] `)) {
    throw new CliError('Отменено.', 0, 'canceled');
  }
  const target = await channelId(ctx, id);
  const created = await ctx.mm().post(target, text);
  return { ok: true, channel: target, scenario, text, post_id: created?.id ?? null, post_url: await permalink(ctx, created?.id, target) };
}

// Ссылка на пост: команда — та, где канал; у лички команды нет, подходит любая своя.
export async function permalink(ctx, postId, channel) {
  if (!postId) return null;
  try {
    const mm = ctx.mm();
    const [teams, ch] = await Promise.all([mm.teams(), mm.channel(channel)]);
    const team = teams.find((t) => t.id === ch?.team_id) ?? teams[0];
    return team ? `${ctx.cfg.mattermost.baseUrl.replace(/\/+$/, '')}/${team.name}/pl/${postId}` : null;
  } catch {
    return null; // пост уже ушёл: сбой ссылки не должен выглядеть провалом отправки
  }
}

// Эмодзи из Unicode в имя Mattermost; имя (eyes, :eyes:) проходит как есть.
const EMOJI_NAMES = { '✅': 'white_check_mark', '👀': 'eyes', '👍': '+1', '❌': 'x' };

async function react(ctx, [ref, emoji], opts) {
  if (!ref || !emoji) throw new CliError('Использование: fsh mm react <permalink|id поста> <эмодзи>.', 1, 'usage');
  const postId = postIdFrom(ref, 'fsh mm react <permalink|id поста> <эмодзи>');
  const name = EMOJI_NAMES[emoji] ?? emoji.replace(/^:|:$/g, '');
  if (opts.dryRun) return { ok: true, dry_run: true, post_id: postId, emoji: name };
  const mm = ctx.mm();
  const me = await mm.me();
  await mm.react(me.id, postId, name);
  return { ok: true, post_id: postId, emoji: name };
}

// Править и удалять даём только свои посты: Mattermost отказал бы 403, но наш текст про
// протухшую сессию в этом случае врал бы.
async function ownPost(ctx, ref, usage) {
  const id = postIdFrom(ref, usage);
  const mm = ctx.mm();
  const [p, me] = await Promise.all([mm.getPost(id), mm.me()]);
  if (!p) throw new CliError(`Поста ${id} нет или он тебе не виден.`, 1, 'not_found');
  if (p.user_id !== me.id) throw new CliError(`Пост ${id} не твой: править и удалять можно только свои.`, 1, 'usage');
  return p;
}

async function edit(ctx, [ref, ...words], opts) {
  const usage = 'fsh mm edit <permalink|id поста> (--file <путь> | "<текст>")';
  const text = (opts.file ? readText(opts.file) : words.join(' ')).trim();
  if (!ref || !text) throw new CliError(`Использование: ${usage}.`, 1, 'usage');
  const p = await ownPost(ctx, ref, usage);
  if (opts.dryRun) return { ok: true, dry_run: true, post_id: p.id, edited: true, text };
  if (!opts.yes && !opts.asObject && !confirm(`Заменить текст поста ${p.id}?\n${text}\n[y/N] `)) {
    throw new CliError('Отменено.', 0, 'canceled');
  }
  await ctx.mm().patchPost(p.id, text);
  return { ok: true, post_id: p.id, edited: true, text, post_url: await permalink(ctx, p.id, p.channel_id) };
}

async function del(ctx, [ref], opts) {
  const p = await ownPost(ctx, ref, 'fsh mm delete <permalink|id поста>');
  if (opts.dryRun) return { ok: true, dry_run: true, deleted: p.id, text: p.message ?? '' };
  if (!opts.yes && !opts.asObject && !confirm(`Удалить пост ${p.id} без возврата${p.root_id ? '' : ' (корень треда: ответы в нём тоже пропадут)'}?\n${p.message ?? ''}\n[y/N] `, { irreversible: true })) {
    throw new CliError('Отменено.', 0, 'canceled');
  }
  await ctx.mm().deletePost(p.id);
  return { ok: true, deleted: p.id };
}

function render(r) {
  if (r.deleted) return void console.log(`${r.dry_run ? '📝 план: удалить' : '✅ удалён'} пост ${r.deleted}${r.text ? `\n${r.text}` : ''}`);
  if (r.edited) return void console.log(`${r.dry_run ? '📝 план: заменить' : '✅ изменён'} → ${r.post_url || r.post_id}\n${r.text}`);
  if (r.emoji) return void console.log(`${r.dry_run ? '📝 план' : '✅ реакция'} :${r.emoji}: → пост ${r.post_id}`);
  if (r.messages) {
    if (r.shown < r.total) console.log(`показано ${r.shown} из ${r.total}\n`);
    return void console.log(r.messages.map((m) => {
      const files = m.files.length ? `\n📎 ${m.files.join(', ')}` : '';
      return `— ${m.at.slice(0, 16).replace('T', ' ')} ${m.user}\n${m.text}${files}`;
    }).join('\n\n'));
  }
  if (r.user) return void console.log(`✅ ${r.user.username}${r.user.email ? ` <${r.user.email}>` : ''}${r.saved ? ' — токен в keychain' : ''}`);
  if (r.channels) {
    if (!r.total) return void console.log('Ничего не нашлось.');
    return void console.log(table([
      ['канал', 'имя', 'id', 'команда'],
      ...r.channels.map((c) => [`${c.private ? '🔒 ' : ''}${c.title}`, c.name, c.id, c.team]),
    ]));
  }
  const thread = r.root_id ? `, тред ${r.root_id}` : '';
  console.log(`${r.dry_run ? '📝 план' : '✅ отправлено'} → ${r.post_url || `${r.scenario || r.channel}${thread}`}\n${r.text}`);
}
