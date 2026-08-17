import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyDiscussions } from '../src/commands/mr-comments.js';

const DISCUSSIONS = [
  {
    id: 'a1', resolvable: true, resolved: true,
    notes: [
      { id: 1, author: { username: 'u1' }, created_at: '2026-08-14T10:00:00Z', body: 'готово', system: false },
      { id: 2, author: { username: 'u2' }, created_at: '2026-08-14T10:05:00Z', body: 'спасибо', system: false },
    ],
  },
  {
    id: 'a2', resolvable: true, resolved: false,
    notes: [{ id: 3, author: { username: 'u1' }, created_at: '2026-08-14T11:00:00Z', body: 'поправь', system: false }],
  },
  {
    id: 'a3', resolvable: false, resolved: false, individual_note: true,
    notes: [{ id: 4, author: { username: 'u3' }, created_at: '2026-08-14T12:00:00Z', body: 'отдельный коммент', system: false }],
  },
  {
    id: 'a4', resolvable: false, resolved: false,
    notes: [{ id: 5, author: { username: 'u2' }, created_at: '2026-08-14T12:30:00Z', body: 'апрувнул', system: true }],
  },
];

test('mr-comments: все — системные треды без комментов исключены, системная нота помечена', () => {
  const r = classifyDiscussions(DISCUSSIONS);
  assert.equal(r.items.length, 3); // a4 (только системные) не входит
  assert.equal(r.total, 4); // системные не считаются комментом
  assert.equal(r.openCount, 2);
  assert.equal(r.resolvedCount, 1);
});

test('mr-comments: --resolved — только решённый тред', () => {
  const r = classifyDiscussions(DISCUSSIONS, { resolved: true });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].id, 'a1');
});

test('mr-comments: --open — нерешённые и отдельные, системные исключены', () => {
  const r = classifyDiscussions(DISCUSSIONS, { open: true });
  assert.deepEqual(r.items.map((d) => d.id), ['a2', 'a3']);
});

test('mr-comments: пустой список не падает', () => {
  const r = classifyDiscussions([]);
  assert.equal(r.items.length, 0);
  assert.equal(r.total, 0);
});
