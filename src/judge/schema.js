import { z } from 'zod';

// Схема вердикта одна на все роли — роли различаются payload и рубрикой.
// meta модель не заполняет: его дописывает judge() из фактов вызова.
export const Verdict = z.object({
  decision: z.enum(['approve', 'reject', 'revise', 'abstain']),
  confidence: z.number().min(0).max(1),
  summary: z.string().min(1),
  findings: z.array(
    z.object({
      severity: z.enum(['blocker', 'warning', 'nit']),
      file: z.string(),
      line: z.number().int().nonnegative(),
      body: z.string(),
    }),
  ),
  checks: z.array(z.object({ name: z.string(), pass: z.boolean(), note: z.string() })),
  next: z.object({
    action: z.enum(['push', 'retry_agent', 'hand_to_human', 'none']),
    hint: z.string(),
  }),
});

// Та же форма словами — для адаптеров без json_schema (claude CLI): им схему
// приходится выпрашивать текстом, и текст должен быть ровно про эту схему.
export const VERDICT_SHAPE = `{
  "decision": "approve | reject | revise | abstain",
  "confidence": 0.0,
  "summary": "1-3 предложения по-русски",
  "findings": [{"severity": "blocker | warning | nit", "file": "путь", "line": 0, "body": "что не так"}],
  "checks": [{"name": "имя проверки", "pass": true, "note": "чем подтверждено"}],
  "next": {"action": "push | retry_agent | hand_to_human | none", "hint": "что делать дальше"}
}`;

// Модель заворачивает JSON в ```json-забор или обкладывает текстом. Достаём объект.
// Возвращает распарсенное значение или null — решение о невалидности принимает вызывающий.
export function extractJson(text) {
  const raw = String(text ?? '');
  const candidates = [];

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) candidates.push(fenced[1]);

  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(raw.slice(first, last + 1));

  candidates.push(raw);

  for (const c of candidates) {
    try {
      const value = JSON.parse(c.trim());
      if (value && typeof value === 'object') return value;
    } catch { /* следующий кандидат */ }
  }
  return null;
}
