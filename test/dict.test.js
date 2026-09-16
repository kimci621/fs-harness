import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDict } from '../src/dict.js';

// Подменённый fetch: отдаёт заготовленные ответы по порядку и пишет, что спрашивали.
function fakeFetch(responses) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null, headers: init.headers });
    const r = responses.shift();
    return { ok: r.status < 400, status: r.status, json: async () => r.body ?? null };
  };
  return { impl, calls };
}

const dictWith = (responses) => {
  const { impl, calls } = fakeFetch(responses);
  return { dict: createDict({ baseUrl: 'https://dict.invalid/rest/v4/', token: 'tok', fetchImpl: impl, sleepMs: 1 }), calls };
};

test('dict: rest-token в заголовке, обрезанный хвост baseUrl', async () => {
  const { dict, calls } = dictWith([{ status: 200, body: { dictionary_items: [], meta: { page: { number: 1, size: 15, total: 0 } } } }]);
  await dict.items();
  assert.equal(calls[0].headers['rest-token'], 'tok');
  assert.match(calls[0].url, /^https:\/\/dict\.invalid\/rest\/v4\/system\/dictionary-item\?page=1$/);
});

test('dict: список, одна запись, создание, правка, удаление, кэш', async () => {
  const { dict, calls } = dictWith([
    { status: 200, body: { dictionary_items: [{ dictionary_item_id: 7, group: 'checkout', key: 'btn', value: 'Купить', language_id: 1 }], meta: { page: { number: 1, size: 15, total: 9 } } } },
    { status: 200, body: { dictionary_item: { dictionary_item_id: 7, value: 'Купить' } } },
    { status: 201, body: { dictionary_item: { dictionary_item_id: 8, group: 'checkout', key: 'btn2', value: 'Тест' } } },
    { status: 200, body: { dictionary_item: { dictionary_item_id: 8, value: 'Тест 2' } } },
    { status: 204, body: null },
    { status: 200, body: { message: 'Начато обновление словаря.' } },
  ]);
  const page = await dict.items({ page: 2 });
  assert.equal(page.items[0].dictionary_item_id, 7);
  assert.equal(page.page.total, 9);
  assert.equal((await dict.item(7)).dictionary_item_id, 7);
  assert.equal((await dict.create({ language_id: 1, group: 'checkout', key: 'btn2', value: 'Тест' })).dictionary_item_id, 8);
  assert.equal(calls[2].method, 'POST');
  assert.equal((await dict.update(8, { language_id: 1, group: 'checkout', key: 'btn2', value: 'Тест 2' })).value, 'Тест 2');
  assert.equal(calls[3].method, 'PUT');
  assert.equal(await dict.remove(8), null); // 204
  assert.equal(calls[4].method, 'DELETE');
  assert.match((await dict.refresh()).message, /словаря/);
  assert.equal(calls[5].method, 'POST');
  assert.equal(calls[5].url.split('/').at(-1), 'refresh');
});

test('dict: языки и развёртка ответа', async () => {
  const { dict } = dictWith([{ status: 200, body: { languages: [{ language_id: 1, code: 'ru', name: 'Русский' }] } }]);
  assert.equal((await dict.languages())[0].code, 'ru');
});

test('dict: 403 — внятная ошибка про токен, без baseUrl — config_invalid', async () => {
  const { dict } = dictWith([{ status: 403, body: null }]);
  await assert.rejects(() => dict.items(), (e) => e.code === 'api_failed' && /rest-token/.test(e.message));
  assert.throws(() => createDict({ token: 'x' }), (e) => e.code === 'config_invalid');
});
