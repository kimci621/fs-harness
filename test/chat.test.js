import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startChat, WIRE } from '../src/chat.js';
import { parseAgyLine } from '../src/agent/stream.js';
import { buildAskBrief, lastFailedRun, eventLine } from '../src/commands/ask.js';

// Подменённый spawnAgent: копит аргументы и написанные строки, отдаёт события по команде теста.
function fakeSpawn() {
  const calls = [];
  const impl = ({ bin, args, cwd, input, keepStdin }) => {
    const listeners = new Set();
    const proc = {
      bin, args, cwd, input, keepStdin,
      written: [],
      emit: (e) => { for (const fn of listeners) fn(e); },
      out: (text) => proc.emit({ t: 'log', stream: 'stdout', text }),
      events: { on: (fn) => { listeners.add(fn); return () => listeners.delete(fn); } },
      result: Promise.resolve({ ok: true }),
      abort: () => {},
      write: (text) => proc.written.push(text),
    };
    calls.push(proc);
    return proc;
  };
  return { impl, calls };
}

const agyAgent = { name: 'agy', bin: 'agy', family: 'agy', args: ['--dangerously-skip-permissions'], env: {} };

test('чат agy: один процесс на всю сессию, реплики уходят строками NDJSON', async () => {
  const { impl, calls } = fakeSpawn();
  const seen = [];
  const chat = startChat({ agent: agyAgent, cwd: '/repo', onEvent: (e) => seen.push(e), spawnImpl: impl });

  const first = chat.send('почему упало');
  assert.equal(calls.length, 1, 'процесс поднимается один раз');
  assert.equal(calls[0].keepStdin, true, 'stdin закрывать нельзя: ходов много');
  assert.deepEqual(JSON.parse(calls[0].written[0]), { event: 'user', message: { role: 'user', content: 'почему упало' } });

  calls[0].out(JSON.stringify({ event: 'step_update', step_update: { text_delta: 'Судья ' } }));
  calls[0].out(JSON.stringify({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: 'Судья завернул' } }));
  assert.equal(await first, 'Судья завернул');
  assert.deepEqual(seen.filter((e) => e.t === 'delta').map((e) => e.text), ['Судья ']);

  // Второй ход — тот же процесс, второй строкой. Никаких --conversation и перезапусков.
  const second = chat.send('а что делать');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].written.length, 2);
  calls[0].out(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'убрать маркеры' } }));
  assert.equal(await second, 'убрать маркеры');
});

test('чат: процесс умер между ходами — поднимаем заново и продолжаем ту же сессию', async () => {
  const { impl, calls } = fakeSpawn();
  const chat = startChat({ agent: agyAgent, cwd: '/repo', spawnImpl: impl });

  const first = chat.send('привет');
  calls[0].out(JSON.stringify({ event: 'init', conversation_id: 'c-42' }));
  calls[0].out(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'ага' } }));
  await first;

  calls[0].emit({ t: 'done', ok: true, code: 0 }); // agy закрылся по --print-timeout
  const second = chat.send('ещё вопрос');
  assert.equal(calls.length, 2, 'подняли новый процесс');
  assert.deepEqual(calls[1].args.slice(-2), ['--conversation', 'c-42'], 'и продолжили ту же беседу');
  calls[1].out(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'отвечаю' } }));
  assert.equal(await second, 'отвечаю');
});

test('чат: ошибка агента не оставляет реплику висеть', async () => {
  const { impl, calls } = fakeSpawn();
  const chat = startChat({ agent: agyAgent, cwd: '/repo', spawnImpl: impl });
  const q = chat.send('вопрос');
  calls[0].out(JSON.stringify({ event: 'result', result: { status: 'ERROR', error: 'кончился лимит' } }));
  await assert.rejects(() => q, (e) => e.code === 'agent_failed' && /лимит/.test(e.message));

  const dead = startChat({ agent: agyAgent, cwd: '/repo', spawnImpl: impl });
  const q2 = dead.send('вопрос');
  calls.at(-1).emit({ t: 'done', ok: false, code: 1 });
  await assert.rejects(() => q2, (e) => e.code === 'agent_failed');
});

test('read-only снимает обход разрешений и ставит флаг режима', () => {
  const { impl, calls } = fakeSpawn();
  const chat = startChat({ agent: agyAgent, cwd: '/repo', readOnly: true, spawnImpl: impl });
  chat.send('вопрос').catch(() => {});
  assert.ok(!calls[0].args.includes('--dangerously-skip-permissions'), 'иначе флаг режима ничего не значит');
  assert.ok(calls[0].args.join(' ').includes('--mode plan'));

  // pi режима «только чтение» не умеет — молчать об этом нельзя
  assert.throws(
    () => startChat({ agent: { name: 'pi', bin: 'pi', family: 'pi', args: [] }, cwd: '/repo', readOnly: true, spawnImpl: impl }),
    (e) => e.code === 'usage',
  );
});

test('чат pi: ход = отдельный процесс, промпт в stdin, ответ обычным текстом', async () => {
  const { impl, calls } = fakeSpawn();
  const chat = startChat({ agent: { name: 'pi', bin: 'pi', family: 'pi', args: [] }, cwd: '/repo', spawnImpl: impl });
  const q = chat.send('вопрос');
  assert.equal(calls[0].input, 'вопрос');
  assert.equal(calls[0].keepStdin, false);
  calls[0].out('обычный текст ответа');
  calls[0].emit({ t: 'done', ok: true, code: 0 });
  assert.equal(await q, 'обычный текст ответа');

  const q2 = chat.send('второй');
  assert.equal(calls.length, 2, 'у pi каждый ход — новый процесс');
  assert.ok(calls[1].args.includes('--session-id'), 'сессия держится id, а не живым процессом');
  calls[1].out('и второй ответ');
  calls[1].emit({ t: 'done', ok: true, code: 0 });
  assert.equal(await q2, 'и второй ответ');
});

test('parseAgyLine: конверт event, дельты текста и ошибка результата', () => {
  assert.equal(parseAgyLine('{"event":"init","conversation_id":"c1"}').session, 'c1');
  assert.equal(parseAgyLine('{"event":"step_update","step_update":{"text_delta":"при"}}').delta, 'при');
  assert.equal(parseAgyLine('{"event":"result","result":{"status":"SUCCESS","response":"ок"}}').result, 'ок');
  assert.equal(parseAgyLine('{"event":"result","result":{"status":"ERROR","error":"бум"}}').error, 'бум');
  assert.equal(parseAgyLine('не json').passthrough, 'не json');
  // user_input — это эхо нашей же реплики,активности из него делать нечего
  assert.equal(parseAgyLine('{"event":"step_update","step_update":{"step_type":"user_input","state":"ACTIVE"}}').activity, null);

  // Шаг инструмента: имя и первый осмысленный параметр, и ровно один раз на вызов
  const tool = '{"event":"step_update","step_update":{"step_type":"tool","state":"%s","tool_name":"find_by_name",' +
    '"tool_info":{"parameters":{"Pattern":"probe.txt","SearchDirectory":"/Users/a"}}}}';
  assert.equal(parseAgyLine(tool.replace('%s', 'ACTIVE')).activity, '🔧 find_by_name probe.txt');
  assert.equal(parseAgyLine(tool.replace('%s', 'DONE')).activity, null, 'иначе каждый вызов двоится');
});

// --- бриф упавшего рана ---

function runDir(root, id, { action = 'conflict', events = [] } = {}) {
  const dir = path.join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ action, created_at: `2026-09-17T10:${id.slice(-2)}:00.000Z` }));
  for (const e of events) appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({ at: '2026-09-17T10:00:00.000Z', ...e }) + '\n');
  return dir;
}

test('lastFailedRun: берётся упавший, а не просто последний; пустой каталог — null', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'fsh-runs-'));
  assert.equal(lastFailedRun({ root }), null);

  runDir(root, '20260917-1001', { events: [{ t: 'phase', phase: 'agent' }, { t: 'error', code: 'judge_rejected', message: 'судья завернул' }] });
  runDir(root, '20260917-1002', { action: 'review', events: [{ t: 'phase', phase: 'done' }] });

  const found = lastFailedRun({ root });
  assert.equal(found.id, '20260917-1001', 'свежий, но успешный ран не перебивает упавший');
  assert.equal(found.error.code, 'judge_rejected');
});

test('бриф: хвост журнала обрезан, ошибка и вопрос на месте, конфига внутри нет', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'fsh-runs-'));
  const events = Array.from({ length: 200 }, (_, i) => ({ t: 'log', text: `шаг ${i}` }));
  events.push({ t: 'error', code: 'agent_failed', message: 'агент упал' });
  runDir(root, '20260917-1003', { events });

  const run = lastFailedRun({ root });
  assert.ok(run.tail.length <= 40, `хвост не обрезан: ${run.tail.length} строк`);

  const brief = buildAskBrief({ run, question: 'почему упало', readOnly: true });
  assert.ok(brief.includes('agent_failed'));
  assert.ok(brief.includes('почему упало'));
  assert.ok(brief.includes('Правки сейчас запрещены'));
  assert.ok(!brief.includes('шаг 0'), 'начало журнала в бриф не лезет');
  assert.ok(brief.includes('шаг 199'));

  // без рана промпт всё равно рендерится: спрашивать про инструмент можно и на чистом журнале
  const plain = buildAskBrief({ run: null, question: 'что делает fsh deploy' });
  assert.ok(plain.includes('Ранов в журнале нет'));
  assert.ok(!plain.includes('Правки сейчас запрещены'));
});

test('eventLine: код ошибки виден, дельты в хвост не попадают', () => {
  assert.match(eventLine({ t: 'error', at: '2026-09-17T10:20:30.000Z', code: 'judge_rejected', message: 'нет' }), /10:20:30 ❌ \[judge_rejected] нет/);
  assert.equal(eventLine({ t: 'delta', text: 'кусок' }), null);
});

test('WIRE: у agy промпт-флаг последний — иначе он съест следующий аргумент', () => {
  assert.equal(WIRE.agy.args.at(-1), '-p=');
  assert.equal(WIRE.claude.args.at(-1), '-p');
});
