import { readSecret } from './secrets.js';

// Классификатор выбора из списка: OpenRouter decisions API (~typesafe/jev-latest).
// В отличие от судьи он не пишет текст, а выбирает вариант и отдаёт вероятности.
// Любой сбой — null: вызывающий обязан вернуться к поведению без классификатора.
export const DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';

export function classifierFor(role, cfg) {
  const name = cfg?.classify?.roles?.[role];
  return name ? cfg.classify.profiles?.[name] ?? null : null;
}

// questions: { имя: { instructions, criteria: { вариант: когда } } }.
// Ответ: { имя: { choice, p } }, choice === null — уверенность ниже minP.
export async function classify({ role, state, questions, cfg, fetchImpl = fetch, secret = readSecret }) {
  const profile = classifierFor(role, cfg);
  if (!profile) return null;
  const minP = cfg.classify.minP ?? 0.8;
  try {
    const res = await fetchImpl(profile.baseUrl ?? DECISIONS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret(profile.secret ?? 'openrouter')}` },
      body: JSON.stringify({
        model: profile.model,
        state: String(state).slice(0, cfg.classify.stateLimit ?? 8000),
        questions: Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, { type: 'choice', ...q }])),
      }),
      signal: AbortSignal.timeout(cfg.classify.timeoutMs ?? 3000),
    });
    if (!res.ok) return null;
    const { answers } = await res.json();
    const out = {};
    for (const name of Object.keys(questions)) {
      const { choice, probabilities } = answers[name];
      const p = Number(probabilities?.[choice] ?? 0);
      out[name] = { choice: p >= minP ? choice : null, p };
    }
    return out;
  } catch {
    return null;
  }
}
