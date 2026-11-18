import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cmdConfig } from '../src/config-cmd.js';

const cfg = { activeProject: 'front', repo: 'fitstars/fitstars-nuxt', host: 'gitlab.fitstars.team', projectDir: '~/p', targetBranch: 'dev', branchPattern: 'feature/{key}', telegram: { bot_token: 'секрет' } };

test('config get: одно значение по ключу, печать — только оно', () => {
  assert.deepEqual(cmdConfig(['get', 'repo'], { asObject: true }, cfg), { ok: true, key: 'repo', value: 'fitstars/fitstars-nuxt' });
  assert.equal(cmdConfig(['get', 'project'], { asObject: true }, cfg).value, 'front');
  const out = [];
  const orig = console.log;
  console.log = (s) => out.push(s);
  try { cmdConfig(['get', 'host'], {}, cfg); } finally { console.log = orig; }
  assert.deepEqual(out, ['gitlab.fitstars.team']);
});

test('config get: секреты и неизвестные ключи не отдаёт — usage со списком ключей', () => {
  assert.throws(() => cmdConfig(['get', 'telegram'], { asObject: true }, cfg), (e) => e.code === 'usage' && /repo/.test(e.message));
  assert.throws(() => cmdConfig(['get'], { asObject: true }, cfg), (e) => e.code === 'usage');
});

test('config get: ключи прототипа (constructor, toString) не отдают конфиг', () => {
  for (const key of ['constructor', 'toString', 'valueOf', '__proto__']) {
    assert.throws(() => cmdConfig(['get', key], { asObject: true }, cfg), (e) => e.code === 'usage', key);
  }
});
