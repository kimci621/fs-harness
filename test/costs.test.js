import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appendCost, sumCosts } from '../src/costs.js';

test('costs: appendCost пишет строку JSONL, sumCosts суммирует по фильтру задачи', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'fs-harness-costs-test-'));
  try {
    appendCost({
      root,
      record: {
        run: 'r1',
        action: 'implement',
        issue: 'FD-100',
        agent_cost: { cost_usd: 0.15 },
        judge_cost: 0.05,
      },
    });
    appendCost({
      root,
      record: {
        run: 'r2',
        action: 'ci-fix',
        issue: 'FD-100',
        agent_cost: { cost_usd: 0.20 },
        judge_cost: 0.02,
      },
    });
    appendCost({
      root,
      record: {
        run: 'r3',
        action: 'implement',
        issue: 'FD-200',
        agent_cost: { cost_usd: 0.50 },
        judge_cost: 0.10,
      },
    });

    const file = path.join(root, 'costs.jsonl');
    const content = readFileSync(file, 'utf8');
    assert.equal(content.trim().split('\n').length, 3);

    const fd100 = sumCosts({ root, issue: 'FD-100' });
    assert.equal(fd100.runs_count, 2);
    assert.equal(fd100.agent_cost_usd, 0.35);
    assert.equal(fd100.judge_cost_usd, 0.07);
    assert.equal(fd100.total_usd, 0.42);

    const all = sumCosts({ root });
    assert.equal(all.runs_count, 3);
    assert.equal(all.total_usd, 1.02);

    const empty = sumCosts({ root, issue: 'UNKNOWN' });
    assert.equal(empty.runs_count, 0);
    assert.equal(empty.total_usd, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
