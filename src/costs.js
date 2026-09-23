import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

export const COSTS_DIR = path.join(homedir(), '.local', 'state', 'fs-harness');

// Запись расхода по рану в JSONL-файл costs.jsonl
export function appendCost({ root = COSTS_DIR, record = {} } = {}) {
  mkdirSync(root, { recursive: true });
  const file = path.join(root, 'costs.jsonl');
  const line = JSON.stringify({
    at: record.at || new Date().toISOString(),
    run: record.run || null,
    action: record.action || null,
    project: record.project || null,
    issue: record.issue || null,
    mr: record.mr || null,
    profile: record.profile || null,
    agent_cost: record.agent_cost || null,
    judge_cost: record.judge_cost ?? null,
  }) + '\n';
  appendFileSync(file, line, 'utf8');
}

// Агрегированный подсчёт расходов по задаче или фильтрам
export function sumCosts({ root = COSTS_DIR, issue = null, since = null } = {}) {
  const file = path.join(root, 'costs.jsonl');
  if (!existsSync(file)) {
    return { total_usd: 0, runs_count: 0, agent_cost_usd: 0, judge_cost_usd: 0 };
  }
  // ponytail: при >10k строк читать весь файл целиком станет медленно, тогда ротация по месяцам
  const content = readFileSync(file, 'utf8');
  const lines = content.split('\n').filter(Boolean);
  let runsCount = 0;
  let agentCostUsd = 0;
  let judgeCostUsd = 0;

  const sinceTime = since ? new Date(since).getTime() : 0;

  for (const line of lines) {
    try {
      const rec = JSON.parse(line);
      if (issue && rec.issue !== issue) continue;
      if (sinceTime && new Date(rec.at).getTime() < sinceTime) continue;

      runsCount++;
      const aCost = Number(rec.agent_cost?.cost_usd ?? 0);
      if (!isNaN(aCost)) agentCostUsd += aCost;
      const jCost = Number(rec.judge_cost ?? 0);
      if (!isNaN(jCost)) judgeCostUsd += jCost;
    } catch {
      // Игнорируем битые строки
    }
  }

  const totalUsd = Number((agentCostUsd + judgeCostUsd).toFixed(4));
  return {
    total_usd: totalUsd,
    runs_count: runsCount,
    agent_cost_usd: Number(agentCostUsd.toFixed(4)),
    judge_cost_usd: Number(judgeCostUsd.toFixed(4)),
  };
}
