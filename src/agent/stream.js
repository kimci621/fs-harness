// Разбор построчного вывода агента claude (--output-format stream-json --verbose):
// JSON-события превращаются в короткие строки активности и финальный отчёт.
// Не-JSON строки проходят насквозь (passthrough) — так живут текстовые режимы и мусор.

const MAX_BRIEF = 160;

// Короткое «чем агент занят» по аргументам инструмента: команда, файл, паттерн.
export function toolBrief(name, input = {}) {
  const raw = input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.query ?? input.description ?? input.skill ?? '';
  const one = String(raw).split('\n').map((l) => l.trim()).filter(Boolean)[0] ?? '';
  const brief = one.length > MAX_BRIEF ? `${one.slice(0, MAX_BRIEF)}…` : one;
  return brief ? `${name} ${brief}` : String(name);
}

// Шаг активности из одного блока сообщения ассистента. null — блока без визуального следа.
export function blockActivity(block) {
  if (block?.type === 'tool_use') return `🔧 ${toolBrief(block.name, block.input)}`;
  if (block?.type === 'text') {
    const one = String(block.text ?? '').split('\n').map((l) => l.trim()).filter(Boolean)[0] ?? '';
    if (!one) return null;
    return `💬 ${one.length > MAX_BRIEF ? `${one.slice(0, MAX_BRIEF)}…` : one}`;
  }
  return null;
}

// Строка потока → {activity, result, passthrough}. result приходит один раз — в событии
// type:'result'; activity — по одному на сообщение ассистента; passthrough — сырое, если это не JSON.
export function parseClaudeLine(line) {
  const text = String(line ?? '').trim();
  if (!text.startsWith('{')) return { activity: null, result: null, passthrough: text || null };
  let ev;
  try {
    ev = JSON.parse(text);
  } catch {
    return { activity: null, result: null, passthrough: text };
  }
  if (ev.type === 'assistant') {
    const acts = (ev.message?.content ?? []).map(blockActivity).filter(Boolean);
    return { activity: acts.join(' · ') || null, result: null };
  }
  if (ev.type === 'result') {
    return { activity: null, result: String(ev.result ?? ''), envelope: ev };
  }
  return { activity: null, result: null };
}

// Разбор потока agy (antigravity): конверт другой — {"event": ...} вместо {"type": ...},
// а текст приходит кусками в step_update.text_delta, а не целым сообщением.
// Форма ответа та же, что у parseClaudeLine, плюс delta: чат рисует ответ по мере набора.
export function parseAgyLine(line) {
  const text = String(line ?? '').trim();
  if (!text.startsWith('{')) return { activity: null, result: null, passthrough: text || null };
  let ev;
  try {
    ev = JSON.parse(text);
  } catch {
    return { activity: null, result: null, passthrough: text };
  }
  if (ev.event === 'init') return { activity: null, result: null, session: ev.conversation_id ?? null };
  if (ev.event === 'step_update') {
    const step = ev.step_update ?? {};
    if (step.text_delta) return { activity: null, result: null, delta: step.text_delta };
    // Шаг инструмента приходит дважды (ACTIVE и DONE) — берём только начало, иначе всё двоится.
    // Имена параметров у agy с большой буквы и свои, поэтому сводим их к виду toolBrief.
    if (step.step_type !== 'tool' || step.state !== 'ACTIVE') return { activity: null, result: null };
    const p = step.tool_info?.parameters ?? {};
    const arg = p.CommandLine ?? p.Pattern ?? p.AbsolutePath ?? p.TargetFile ?? p.Query ?? p.Url ?? '';
    return { activity: `🔧 ${toolBrief(step.tool_name ?? 'tool', { command: arg })}`, result: null };
  }
  if (ev.event === 'result') {
    const r = ev.result ?? {};
    return { activity: null, result: String(r.response ?? ''), error: r.status === 'ERROR' ? (r.error ?? 'agy ответил ошибкой') : null, envelope: ev };
  }
  return { activity: null, result: null };
}
