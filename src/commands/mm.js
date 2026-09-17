import { expandHome } from '../config.js';
import { createMattermost, reviewMessage } from '../mattermost.js';
import { writeSecret } from '../secrets.js';
import { makeGit } from '../workspace.js';
import { keyFromBranch } from '../jira.js';
import { issueUrl } from './jira.js';
import { finish } from '../output.js';
import { confirm, promptSecret } from '../ui.js';
import { CliError } from '../errors.js';

// fsh mm login|whoami|post|review — сообщения в Mattermost от имени человека.
// Сценарий здесь один (review): канал на сценарий берётся из mattermost.channels.
export async function cmdMM(ctx, args, opts = {}) {
  const [sub, ...rest] = args;
  const result =
    sub === 'login' ? await login(ctx, rest)
      : sub === 'whoami' ? await whoami(ctx)
        : sub === 'post' ? await post(ctx, rest, opts)
          : sub === 'review' ? await review(ctx, rest, opts)
            : (() => { throw new CliError('Использование: fsh mm [login [логин]|whoami|post <сценарий|id канала> "<текст>"|review [KEY]].', 1, 'usage'); })();

  if (opts.asObject) return result;
  if (opts.json) finish(true, result);
  else render(result);
  return result;
}

// Канал: имя сценария из конфига (review) либо сам id, если его передали руками.
export function resolveChannel(cfg, name) {
  const channels = cfg.mattermost?.channels ?? {};
  if (!name) {
    throw new CliError(`Не задан канал. Сценарии из конфига: ${Object.keys(channels).join(', ') || '—'}.`, 1, 'usage');
  }
  const id = channels[name] || name;
  if (!id) {
    throw new CliError(`У сценария "${name}" нет канала: заполни mattermost.channels.${name} в конфиге.`, 1, 'config_invalid');
  }
  return { id, scenario: channels[name] ? name : '' };
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
  if (!text) throw new CliError('Использование: fsh mm post <сценарий|id канала> "<текст>".', 1, 'usage');
  return send(ctx, resolveChannel(ctx.cfg, channel), text, opts);
}

// Сценарий «задача уехала в ревью»: MR по текущей ветке плюс ссылка на задачу.
async function review(ctx, [maybeKey], opts) {
  const dir = expandHome(opts.projectDir || ctx.cfg.projectDir || '');
  if (!dir) throw new CliError('Не задан каталог проекта: --project-dir или projects.<имя>.dir в конфиге.', 1, 'config_invalid');
  const branch = makeGit(dir)(['rev-parse', '--abbrev-ref', 'HEAD']);
  const open = await ctx.g.listOpenMRs(ctx.repo, { source_branch: branch });
  const mr = open?.[0] ?? null;
  if (!mr) {
    throw new CliError(`Из ветки ${branch} нет открытого MR: сначала fsh task push.`, 1, 'no_mr');
  }
  return postReview(ctx, { iid: mr.iid, mrUrl: mr.web_url, key: maybeKey || keyFromBranch(branch) }, opts);
}

// Общая точка сценария: зовут и `fsh mm review`, и `fsh task push --post`.
export async function postReview(ctx, { iid, mrUrl, key }, opts = {}) {
  const text = reviewMessage({ iid, mrUrl, key, issueUrl: key ? issueUrl(ctx, key) : '' });
  return send(ctx, resolveChannel(ctx.cfg, 'review'), text, opts);
}

// Запись в общий чат: как и все записи в харнессе — dry-run показывает, подтверждение спрашивает.
async function send(ctx, { id, scenario }, text, opts) {
  if (opts.dryRun) return { ok: true, dry_run: true, channel: id, scenario, text };
  if (!opts.yes && !opts.asObject && !confirm(`Отправить в ${scenario || id}?\n${text}\n[y/N] `)) {
    throw new CliError('Отменено.', 0, 'canceled');
  }
  const created = await ctx.mm().post(id, text);
  return { ok: true, channel: id, scenario, text, post_id: created?.id ?? null };
}

function render(r) {
  if (r.user) return void console.log(`✅ ${r.user.username}${r.user.email ? ` <${r.user.email}>` : ''}${r.saved ? ' — токен в keychain' : ''}`);
  console.log(`${r.dry_run ? '📝 план' : '✅ отправлено'} → ${r.scenario || r.channel}\n${r.text}`);
}
