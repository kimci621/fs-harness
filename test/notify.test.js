import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getTelegramTarget, postTelegram, runMessage } from '../src/notify.js';

test('getTelegramTarget: берёт параметры из конфига', () => {
  const cfg = { telegram: { chat_id: '-100123', bot_token: 'bot-tok' } };
  const target = getTelegramTarget(cfg, { env: {} });
  assert.deepEqual(target, { chatId: '-100123', token: 'bot-tok' });
});

test('getTelegramTarget: берёт параметры из env и readSecret', () => {
  const cfg = {};
  const env = { TELEGRAM_CHAT_ID: '456' };
  const readSecretImpl = (name) => (name === 'telegram' ? 'sec-tok' : null);
  const target = getTelegramTarget(cfg, { env, readSecretImpl });
  assert.deepEqual(target, { chatId: '456', token: 'sec-tok' });
});

test('getTelegramTarget: возвращает null, если токен или chat_id отсутствуют', () => {
  assert.equal(getTelegramTarget({}, { env: {}, readSecretImpl: () => null }), null);
  assert.equal(getTelegramTarget({ telegram: { chat_id: '123' } }, { env: {}, readSecretImpl: () => null }), null);
  assert.equal(getTelegramTarget({ telegram: { bot_token: 'tok' } }, { env: {}, readSecretImpl: () => null }), null);
});

test('postTelegram: успешная отправка формирует правильный URL и тело', async () => {
  let calledUrl = '';
  let calledInit = null;
  const fetchImpl = async (url, init) => {
    calledUrl = url;
    calledInit = init;
    return { ok: true, status: 200 };
  };

  await postTelegram({ token: '123:ABC', chatId: '-100' }, 'Привет', { fetchImpl });
  assert.equal(calledUrl, 'https://api.telegram.org/bot123:ABC/sendMessage');
  assert.equal(calledInit.method, 'POST');
  assert.deepEqual(JSON.parse(calledInit.body), { chat_id: '-100', text: 'Привет' });
});

test('postTelegram: ошибка API пробрасывается с описанием', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 400,
    text: async () => JSON.stringify({ ok: false, description: 'Chat not found' }),
  });

  await assert.rejects(
    () => postTelegram({ token: 'tok', chatId: 'bad' }, 'test', { fetchImpl }),
    (err) => err.code === 'telegram_failed' && /Chat not found/.test(err.message),
  );
});

test('postTelegram: сетевая ошибка пробрасывается', async () => {
  const fetchImpl = async () => {
    throw new Error('connect ECONNREFUSED');
  };

  await assert.rejects(
    () => postTelegram({ token: 'tok', chatId: '123' }, 'test', { fetchImpl }),
    (err) => err.code === 'telegram_failed' && /ECONNREFUSED/.test(err.message),
  );
});

test('runMessage: формирует читаемую строку о ране', () => {
  const msg = runMessage({
    action: 'conflict',
    target: '!2547',
    ok: true,
    cost: 0.05,
    verdict: { decision: 'approve', confidence: 0.95 },
  });
  assert.equal(msg, '✅ conflict !2547 · судья: approve (0.95) · $0.0500');
});
