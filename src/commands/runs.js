import { existsSync, readdirSync } from 'node:fs';
import { listRuns, readRun, readEvents, runIsActive, sweepExpiredApprovals } from '../agent/journal.js';
import { eventLine } from './ask.js';
import { table } from '../format.js';
import { finish } from '../output.js';
import { CliError } from '../errors.js';

// fsh runs — архив ранов и точка входа в resume/retry/ask. id упавшего рана человек
// видит и в хвосте ошибки, но список нужен, чтобы вернуться к нему позже.
export function cmdRuns(ctx, args, opts = {}) {
  const [sub = 'list', id, ...rest] = args;
  if (rest.length) throw new CliError('Использование: fsh runs [list|show <runId>].', 1, 'usage');
  const at = opts.runsDir ? { root: opts.runsDir } : {};
  try { sweepExpiredApprovals(at); } catch {}

  if (sub === 'list') {
    const runs = listRuns({ ...at, limit: 50 });
    const result = { ok: true, runs };
    if (opts.asObject) return result;
    if (opts.json) {
      finish(true, result);
      return result;
    }
    if (!runs.length) {
      console.log('Ранов пока нет.');
      return result;
    }
    console.log(table([
      ['ID', 'ДЕЙСТВИЕ', 'ЦЕЛЬ', 'СОСТОЯНИЕ', 'ОШИБКА', 'ВРЕМЯ'],
      ...runs.map((r) => [
        r.id,
        r.action ?? '—',
        r.mr ? `!${r.mr}` : r.issue ?? '—',
        r.state,
        r.error_code ?? '—',
        String(r.created_at).replace('T', ' ').slice(0, 19),
      ]),
    ]));
    return result;
  }

  if (sub === 'show') {
    if (!id) throw new CliError('Использование: fsh runs show <runId>.', 1, 'usage');
    const saved = readRun(id, at);
    const m = saved.meta;
    const events = readEvents(saved);
    const lastError = [...events].reverse().find((e) => e.t === 'error') ?? null;
    const worktree = m.worktree ?? null;
    const run = {
      id: saved.id,
      dir: saved.dir,
      action: m.action,
      state: m.state ?? null,
      created_at: m.created_at ?? null,
      mr: m.mr ?? null,
      issue: m.issue ?? null,
      worktree,
      worktree_exists: worktree ? existsSync(worktree) : false,
      session_id: m.session_id ?? null,
      error: m.error ?? (lastError ? { code: lastError.code, message: lastError.message } : null),
      active: runIsActive(m, saved.dir),
      artifacts: existsSync(saved.dir) ? readdirSync(saved.dir).filter((f) => f !== 'events.jsonl').sort() : [],
      tail: events.slice(-40).map(eventLine).filter(Boolean),
    };
    const result = { ok: true, run };
    if (opts.asObject) return result;
    if (opts.json) {
      finish(true, result);
      return result;
    }
    console.log(`Ран ${run.id} · ${run.action} · ${run.state ?? '—'}${run.active ? ' (живой)' : ''}`);
    console.log(`  каталог:   ${run.dir}`);
    if (run.error) console.log(`  ошибка:    [${run.error.code}] ${run.error.message}`);
    if (worktree) console.log(`  worktree:  ${worktree}${run.worktree_exists ? '' : ' (удалён)'}`);
    if (run.session_id) console.log(`  сессия:    ${run.session_id}`);
    console.log(`  артефакты: ${run.artifacts.join(', ') || '—'}`);
    if (run.tail.length) console.log(`\nЖурнал (хвост):\n${run.tail.join('\n')}`);
    return result;
  }

  throw new CliError('Использование: fsh runs [list|show <runId>].', 1, 'usage');
}
