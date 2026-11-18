import { resolveMR } from '../resolve.js';
import { CliError } from '../errors.js';
import { finish } from '../output.js';
import { confirm } from '../ui.js';
import { classifyDiscussions } from './mr-comments.js';
import { readText } from './jira.js';

// fsh mr reply <mr> <тред> (--file <путь|-> | "<текст>") и fsh mr resolve <mr> <тред>.
// Тред — номер из fsh mr-comments (#3 или 3), полный id или его уникальное начало.
const USAGE = {
  reply: 'fsh mr reply <mr> <#N|id треда> (--file <путь|-> | "<текст>") -y',
  resolve: 'fsh mr resolve <mr> <#N|id треда> -y',
};

export async function cmdMRThread(g, repo, sub, [query, ref, ...words], opts = {}) {
  if (!query || !ref) throw new CliError(`Использование: ${USAGE[sub]}.`, 1, 'usage');
  const text = sub === 'reply' ? (opts.file ? readText(opts.file) : words.join(' ')).trim() : '';
  if (sub === 'reply' && !text) throw new CliError(`Пустой ответ. Использование: ${USAGE.reply}.`, 1, 'usage');

  const mr = await resolveMR(g, repo, query);
  const { items } = classifyDiscussions((await g.getDiscussions(repo, mr.iid)) || []);
  const d = findThread(items, ref, mr.iid);
  const thread = { n: d.n, id: d.id, resolved: d.resolvable && d.resolved };
  const label = `тред #${d.n} MR !${mr.iid}`;

  let result;
  if (sub === 'reply') {
    if (opts.dryRun) result = { ok: true, dry_run: true, mr: mr.iid, thread, text };
    else {
      if (!opts.yes && !opts.asObject && !confirm(`Ответить в ${label}?\n${text}\n[y/N] `)) throw new CliError('Отменено.', 0, 'canceled');
      const note = await g.replyDiscussion(repo, mr.iid, d.id, text);
      result = { ok: true, mr: mr.iid, thread, note_id: note.id, text };
    }
  } else {
    if (!d.resolvable) throw new CliError(`${label} — обычный комментарий, его нельзя зарезолвить.`, 1, 'usage');
    if (thread.resolved) result = { ok: true, mr: mr.iid, thread, resolved: true, already: true };
    else if (opts.dryRun) result = { ok: true, dry_run: true, mr: mr.iid, thread };
    else {
      if (!opts.yes && !opts.asObject && !confirm(`Зарезолвить ${label}? [y/N] `)) throw new CliError('Отменено.', 0, 'canceled');
      await g.resolveDiscussion(repo, mr.iid, d.id);
      result = { ok: true, mr: mr.iid, thread, resolved: true };
    }
  }

  if (opts.asObject) return result;
  if (opts.json) finish(true, result);
  else console.log(render(result, label));
  return result;
}

function findThread(items, ref, iid) {
  const num = /^#?(\d{1,4})$/.exec(ref);
  const hits = num
    ? items.filter((d) => d.n === Number(num[1]))
    : items.filter((d) => String(d.id).startsWith(ref));
  if (hits.length === 1) return hits[0];
  const why = hits.length ? `под "${ref}" несколько тредов, дай полный id` : `треда "${ref}" нет`;
  throw new CliError(`В MR !${iid} ${why}. Список: fsh mr-comments ${iid}.`, 1, hits.length ? 'usage' : 'not_found');
}

function render(r, label) {
  if (r.dry_run) return `📝 план: ${r.text ? `ответить в ${label}\n${r.text}` : `зарезолвить ${label}`}`;
  if (r.already) return `${label} уже зарезолвлен.`;
  return r.resolved ? `✅ ${label} зарезолвлен.` : `✅ ответ в ${label} отправлен.`;
}
