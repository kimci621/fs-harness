import { CliError } from './errors.js';

// Находит MR по номеру (!2547, 2547) или по части имени source-ветки (неточное, case-insensitive).
export async function resolveMR(g, repo, query) {
  const q = String(query ?? '').trim();
  if (!q) throw new CliError('Укажи MR: номер (!2547) или имя ветки (можно частично).');

  if (/^!?\d+$/.test(q)) {
    const mr = await g.getMR(repo, q.replace(/^!/, ''));
    if (!mr) throw new CliError(`MR !${q.replace(/^!/, '')} не найден в ${repo}.`);
    return mr;
  }

  const mrs = await g.listOpenMRs(repo);
  const needle = q.toLowerCase();
  const hits = mrs.filter((m) => String(m.source_branch || '').toLowerCase().includes(needle));

  if (hits.length === 1) {
    // Полный объект MR: list-ответ не содержит head_pipeline.
    return (await g.getMR(repo, hits[0].iid)) || hits[0];
  }
  if (hits.length === 0) {
    const best = mrs
      .map((m) => ({ m, score: similarity(m.source_branch || '', q) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((x) => x.m.source_branch);
    const hint = best.length ? `\nБлижайшие ветки: ${best.join(', ')}` : '';
    throw new CliError(`Ветка "${q}" не найдена среди открытых MR в ${repo}.${hint}`);
  }
  const list = hits.map((h) => `${h.source_branch} (!${h.iid})`).join(', ');
  throw new CliError(`"${q}" подходит нескольким MR: ${list}. Уточни запрос.`);
}

// Простая оценка близости строки к запросу: префикс > подстрока > Левенштейн.
export function similarity(candidate, query) {
  const c = String(candidate || '').toLowerCase();
  const q = String(query || '').toLowerCase();
  if (!q) return 0;
  if (c === q) return 1;
  if (c.startsWith(q)) return 0.9;
  if (c.includes(q)) return 0.7;
  const dist = levenshtein(c, q);
  const maxLen = Math.max(c.length, q.length) || 1;
  const sim = 1 - dist / maxLen;
  return sim > 0.4 ? sim * 0.5 : sim;
}

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length][b.length];
}
