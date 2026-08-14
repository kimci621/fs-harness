// Форматирование вывода: статусы, время, таблицы, строки MR.
export const STATUS_ICONS = {
  success: '✅',
  failed: '❌',
  canceled: '🚫',
  manual: '⏸',
  running: '🔵',
  pending: '🕒',
  created: '⏳',
  preparing: '🕒',
  scheduled: '🕒',
  waiting_for_resource: '🕒',
  skipped: '⏭',
};

export const statusIcon = (s) => (STATUS_ICONS[s] ?? s ?? '—');

// Относительное время в человекочитаемом виде.
export function humanize(iso) {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'только что';
  const min = Math.round(diff / 60_000);
  if (min < 60) return `${min} мин назад`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} ч назад`;
  const d = Math.round(h / 24);
  return `${d} дн назад`;
}

// Продолжительность для спиннера: 1м 03с.
export function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}м ${String(s % 60).padStart(2, '0')}с` : `${s}с`;
}

export function truncate(str, max) {
  if (str.length <= max) return str;
  return str.slice(0, Math.max(0, max - 1)) + '…';
}

export function yesNo(v) {
  return v ? '⚠ да' : '✅ нет';
}

// Счётчики тредов обсуждений: всего комментов (notes), нерешённых и решённых тредов.
export function commentStats(discussions, totalNotes) {
  if (!Array.isArray(discussions)) return { total: totalNotes ?? 0, open: null, resolved: null };
  const open = discussions.filter((d) => d.resolvable === true && !d.resolved).length;
  const resolved = discussions.filter((d) => d.resolvable === true && d.resolved).length;
  return { total: totalNotes ?? 0, open, resolved };
}

export function fmtComments(stats) {
  const parts = [`💬 ${stats.total}`];
  if (stats.open !== null) parts.push(`открыто ${stats.open}`, `решено ${stats.resolved}`);
  return parts.join(' · ');
}

// Убирает "Draft: " из заголовка — статус уже показан отдельным маркером.
export function cleanTitle(mr) {
  return (mr.title || '').replace(/^draft:\s*/i, '');
}

// Одна строка списка MR. Ширина подстраивается под терминал.
export function fmtMRRow(mr, stats, width = 120) {
  const flag = mr.draft ? 'D ' : '  ';
  const title = truncate(`${flag}${cleanTitle(mr)}`, Math.max(20, Math.floor(width * 0.38)));
  const branches = truncate(`${mr.source_branch} → ${mr.target_branch}`, 30);
  const pipeline = mr.head_pipeline ? `${statusIcon(mr.head_pipeline.status)} ${mr.head_pipeline.status}${mr.head_pipeline.sha && mr.sha && mr.head_pipeline.sha !== mr.sha ? ' ⚠' : ''}` : '— нет';
  const comments = fmtComments(stats);
  const conflict = yesNo(mr.has_conflicts);
  return `!${String(mr.iid).padStart(5)}  ${title.padEnd(Math.max(20, Math.floor(width * 0.38)))}  ${branches.padEnd(30)}  ${pipeline.padEnd(16)}  ${comments.padEnd(24)}  ${conflict}`;
}

// Развёрнутый вывод одного MR.
export function fmtMR(mr, stats, pipelineInfo = {}) {
  const lines = [
    `!${mr.iid}  ${mr.draft ? '[Draft] ' : ''}${cleanTitle(mr)}`,
    `  ветки:      ${mr.source_branch} → ${mr.target_branch}`,
    `  пайплайн:   ${mr.head_pipeline ? `${statusIcon(mr.head_pipeline.status)} ${mr.head_pipeline.status} (#${mr.head_pipeline.id})` : '— нет'}`,
    `  комменты:   ${fmtComments(stats)}`,
    `  конфликт:   ${yesNo(mr.has_conflicts)}`,
    `  обновлён:   ${humanize(mr.updated_at)}`,
    `  url:        ${mr.web_url}`,
  ];
  if (pipelineInfo.stale) lines.push(`  ⚠ head-пайплайн устарел (sha не совпадает с HEAD ветки)`);
  return lines.join('\n');
}

// Таблица с выравниванием по ширине колонок.
export function table(rows) {
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => String(r[c] ?? '').length)));
  return rows.map((r) => r.map((cell, c) => String(cell ?? '').padEnd(widths[c])).join('  ').trimEnd()).join('\n');
}
