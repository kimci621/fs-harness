import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Verdict, VERDICT_SHAPE, extractJson } from './schema.js';
import { createProvider } from './providers/index.js';
import { CliError } from '../errors.js';

const RUBRIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts', 'judge');

export function loadRubric(role) {
  try {
    return readFileSync(path.join(RUBRIC_DIR, `${role}.md`), 'utf8').trim();
  } catch {
    throw new CliError(`Нет рубрики судьи для роли "${role}": ожидался ${path.join(RUBRIC_DIR, `${role}.md`)}.`, 1, 'judge_rubric_missing');
  }
}

// Роль → список профилей по порядку. Список, а не один: у дешёвых ролей опциональный
// локальный бэкенд, и его молчание должно уводить на следующий профиль, а не ронять действие.
export function pickProfiles(role, cfg, override) {
  if (override) return [override];
  const assigned = cfg?.judge?.roles?.[role];
  const names = Array.isArray(assigned) ? assigned : assigned ? [assigned] : [];
  if (!names.length) throw new CliError(`Роли судьи "${role}" не назначен профиль (judge.roles в конфиге).`, 1, 'config_invalid');
  return names;
}

// Вердикт по payload. Бросает на любом провале — вызывающий обязан трактовать
// это как «не approve»: тихо пропускать нельзя.
export async function judge({ role, payload, cfg, signal, onDelta, profile: override, makeProvider = createProvider }) {
  const rubric = loadRubric(role);
  const names = pickProfiles(role, cfg, override);

  let lastErr;
  for (const [i, name] of names.entries()) {
    const profile = cfg?.judge?.profiles?.[name];
    if (!profile) {
      throw new CliError(`Профиль судьи "${name}" не описан в judge.profiles.`, 1, 'config_invalid');
    }
    try {
      return await askOnce({ role, name, profile, rubric, payload, signal, onDelta, makeProvider, cfg });
    } catch (err) {
      lastErr = err;
      // Невалидная схема — беда модели, а не бэкенда: другой профиль тут ни при чём.
      if (err.code === 'judge_schema' || i === names.length - 1) throw err;
    }
  }
  throw lastErr;
}

async function askOnce({ role, name, profile, rubric, payload, signal, onDelta, makeProvider, cfg }) {
  const provider = await makeProvider(profile, cfg);
  const system = `${rubric}\n\n## Схема ответа\n\n${VERDICT_SHAPE}`;
  const started = Date.now();

  let res = await provider.complete({ system, user: payload, schema: Verdict, signal, onDelta });
  let parsed = Verdict.safeParse(extractJson(res.text));
  let cost = res.cost ?? 0;

  if (!parsed.success) {
    // Один ремонтный round-trip: отдаём модели её же ошибки готовым списком.
    const repaired = await provider.complete({
      system,
      user: repairPrompt(parsed.error.issues, res.text),
      schema: Verdict,
      signal,
      onDelta,
    });
    cost += repaired.cost ?? 0;
    parsed = Verdict.safeParse(extractJson(repaired.text));
    res = repaired;
  }

  if (!parsed.success) {
    throw new CliError(
      `Судья (профиль ${name}) дважды вернул вердикт не по схеме. Гейт закрыт.\n` +
        parsed.error.issues.map((i) => `  ${i.path.join('.') || '<корень>'}: ${i.message}`).join('\n'),
      1,
      'judge_schema',
    );
  }

  return {
    ...parsed.data,
    meta: {
      role,
      profile: name,
      provider: provider.name,
      model: res.model ?? profile.model ?? null,
      effort: profile.effort ?? null,
      tokens: res.usage ?? {},
      cost,
      session_id: res.sessionId ?? null,
      duration_ms: Date.now() - started,
    },
  };
}

function repairPrompt(issues, previous) {
  return [
    'Твой прошлый ответ не прошёл валидацию схемы. Верни исправленный JSON целиком, без текста вокруг.',
    '',
    'Что именно не так:',
    ...issues.map((i) => `- ${i.path.join('.') || '<корень>'}: ${i.message}`),
    '',
    'Схема:',
    VERDICT_SHAPE,
    '',
    'Твой прошлый ответ:',
    previous,
  ].join('\n');
}

export const isApproved = (verdict) => verdict?.decision === 'approve';

const ICON = { approve: '✅', reject: '❌', revise: '✏️', abstain: '🤷' };
const SEV = { blocker: '⛔', warning: '⚠', nit: '·' };

export function formatVerdict(v) {
  const lines = [
    `${ICON[v.decision] ?? '?'} Судья: ${v.decision} (уверенность ${v.confidence.toFixed(2)}, ${v.meta.profile}, $${(v.meta.cost ?? 0).toFixed(4)})`,
    `   ${v.summary}`,
  ];
  for (const f of v.findings) {
    lines.push(`   ${SEV[f.severity] ?? '·'} ${f.file}${f.line ? `:${f.line}` : ''} — ${f.body}`);
  }
  for (const c of v.checks) {
    lines.push(`   ${c.pass ? '✓' : '✗'} ${c.name}${c.note ? ` — ${c.note}` : ''}`);
  }
  if (v.next?.hint) lines.push(`   → ${v.next.action}: ${v.next.hint}`);
  return lines.join('\n');
}
