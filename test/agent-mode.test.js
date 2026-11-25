import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confirm } from '../src/ui.js';
import { cancelLine } from '../src/main.js';
import { CliError } from '../src/errors.js';

// Тест сам может идти под Claude Code: env на время проверки задаём явно и возвращаем.
function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
}

test('confirm: под Claude Code (CLAUDECODE) обратимое подтверждается само, необратимое — нет', () => {
  withEnv({ CLAUDECODE: '1' }, () => {
    assert.equal(confirm(''), true);
    assert.equal(confirm('', { irreversible: true }), false);
  });
  // Без агента и без терминала подтвердить некому.
  withEnv({ CLAUDECODE: undefined }, () => assert.equal(confirm(''), false));
});

test('cancelLine: отмена без терминала — одна строка с готовой командой повтора', () => {
  const err = new CliError('Отменено.', 0, 'canceled');
  const line = cancelLine(err, ['jira', 'comment', 'FD-1', 'текст с пробелом', "it's"], { tty: false });
  assert.equal(line, `Отменено. Повтори с -y: fsh jira comment FD-1 'текст с пробелом' 'it'\\''s' -y`);
  assert.equal(line.includes('\n'), false);
  // Живой терминал: человек сам ответил «нет», подсказка не нужна.
  assert.equal(cancelLine(err, ['jira', 'delete', 'FD-1'], { tty: true }), 'Отменено.');
  // Чужие отмены (прерванный ход чата) не трогаем.
  assert.equal(cancelLine(new CliError('Ход прерван.', 1, 'canceled'), ['ask'], { tty: false }), 'Ход прерван.');
});
