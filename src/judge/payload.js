// Что показывать судье в роли acceptance.
//
// В mr_review.py из diff-а вырезаны ещё `**/*.test.ts` и `**/*.md`: там судят качество
// изменения, и тесты с документацией — шум. Здесь роль другая — приёмка решённого
// конфликта, и конфликт в тест-файле это ровно то, что надо посмотреть (живой пример:
// MR !2472, конфликт в useTariffCardComputeds.test.ts). Режем только заметки агента.
export const ACCEPTANCE_PATHSPECS = ['.', ':(glob,exclude).claude/**'];

// Обрезка с явным маркером: судья обязан видеть, что его обрезали. Тихая обрезка
// означала бы approve на том, чего он не читал.
export function truncate(text, maxLines) {
  const lines = String(text ?? '').split('\n');
  if (lines.length <= maxLines) return String(text ?? '');
  const cut = lines.length - maxLines;
  return [...lines.slice(0, maxLines), `[… обрезано ${cut} строк из ${lines.length}; полный текст в worktree]`].join('\n');
}

const block = (title, body) => (body ? `## ${title}\n\n${body}\n` : '');

export function buildAcceptancePayload({ goal, facts = {}, diff = '', agentText = '', maxDiffLines = 4000, maxAgentLines = 200 }) {
  const factLines = Object.entries(facts)
    .map(([k, v]) => `- ${k}: ${Array.isArray(v) ? v.join(', ') || '—' : v}`)
    .join('\n');

  return [
    block('Задача, которую решал агент', goal),
    block('Факты, снятые механически (не словами агента)', factLines),
    block('Дифф base..HEAD', diff ? '```diff\n' + truncate(diff, maxDiffLines) + '\n```' : '_пусто_'),
    block('Финальный отчёт агента (его слова, проверять по диффу)', truncate(agentText, maxAgentLines)),
  ]
    .filter(Boolean)
    .join('\n');
}
