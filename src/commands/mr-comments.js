import { resolveMR } from '../resolve.js';
import { CliError } from '../errors.js';
import { humanize } from '../format.js';
import { finish } from '../output.js';

// gl-helper mr-comments <mr|ветка> [--resolved|--open]
// Все комментарии MR, сгруппированные по тредам. GitLab решает треды целиком:
// resolved — только решённые треды; open — нерешённые треды и отдельные комментарии.

// Чистая классификация тредов (для тестов).
// Возвращает {items, total, openCount, resolvedCount}.
export function classifyDiscussions(discussions, { resolved = false, open = false } = {}) {
  const items = (discussions || []).map((d) => {
    const notes = (d.notes || []).map((n) => ({
      id: n.id,
      author: n.author?.username ?? 'unknown',
      created_at: n.created_at,
      body: n.body || '',
      system: Boolean(n.system),
    }));
    const humanNotes = notes.filter((n) => !n.system);
    return {
      id: d.id,
      resolvable: Boolean(d.resolvable),
      resolved: Boolean(d.resolved),
      notes,
      humanNotes,
    };
  });

  const isResolved = (d) => d.resolvable && d.resolved;

  // Треды без живых комментов (только системные события) — не комментарии, убираем везде.
  const withComments = items.filter((d) => d.humanNotes.length > 0);

  let filtered = withComments;
  if (resolved) filtered = withComments.filter(isResolved);
  else if (open) filtered = withComments.filter((d) => !isResolved(d));

  return {
    items: filtered,
    total: withComments.reduce((sum, d) => sum + d.humanNotes.length, 0),
    openCount: withComments.filter((d) => !isResolved(d)).length,
    resolvedCount: withComments.filter(isResolved).length,
  };
}

// asObject — вернуть данные без печати (MCP-режим).
export async function cmdMRComments(g, repo, args, { json, resolved = false, open = false, asObject } = {}) {
  const [query] = args;
  if (!query) throw new CliError('Использование: gl-helper mr-comments <mr|ветка> [--resolved|--open]', 1, 'usage');
  if (resolved && open) {
    throw new CliError('--resolved и --open вместе не нужны: resolved — только решённые, open — всё нерешённое.', 1, 'usage');
  }

  const mr = await resolveMR(g, repo, query);
  const discussions = (await g.getDiscussions(repo, mr.iid)) || [];
  const { items, total, openCount, resolvedCount } = classifyDiscussions(discussions, { resolved, open });

  const result = {
    ok: true,
    mr: mr.iid,
    filter: resolved ? 'resolved' : open ? 'open' : 'all',
    summary: { threads_total: items.length, comments_total: total, threads_open: openCount, threads_resolved: resolvedCount },
    discussions: items.map((d) => ({
      id: d.id,
      state: d.resolvable ? (d.resolved ? 'resolved' : 'open') : 'open',
      notes: d.notes,
    })),
  };
  if (asObject) return result;

  if (json) {
    finish(true, result);
    return result;
  }

  const label = resolved ? 'решённые' : open ? 'открытые' : 'все';
  console.log(`MR !${mr.iid} — ${label} комментарии (тредов: ${items.length}; всего комментов: ${total}, открытых тредов: ${openCount}, решённых: ${resolvedCount})`);
  if (!items.length) {
    console.log('Комментариев нет.');
    return result;
  }
  for (const [i, d] of items.entries()) {
    const state = d.resolvable ? (d.resolved ? '✅ resolved' : '🔓 open') : '💬';
    console.log(`\n${state} тред #${i + 1} (${String(d.id).slice(0, 8)}) · комментов: ${d.humanNotes.length}`);
    for (const n of d.notes) {
      const tag = n.system ? ' [система]' : '';
      console.log(`  @${n.author} · ${humanize(n.created_at)}${tag}`);
      for (const line of n.body.split('\n')) console.log(`  > ${line}`);
    }
  }
  return result;
}
