import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { runActionCLI } from './engine.js';
import { implementAction } from './actions/implement.js';
import { ciFixAction } from './actions/ci-fix.js';
import { threadsAction } from './actions/threads.js';
import { conflictAction } from './actions/conflict.js';
import { sumCosts } from './costs.js';
import { getTelegramTarget, postTelegram } from './notify.js';

export const AUTO_ROOT = path.join(homedir(), '.local', 'state', 'fs-harness', 'auto');

export function autoFile(key, root = AUTO_ROOT) {
  return path.join(root, `${key}.json`);
}

// Загрузка состояния авто-задачи
export function loadAuto(root = AUTO_ROOT, key) {
  const file = autoFile(key, root);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Сохранение состояния авто-задачи
export function saveAuto(root = AUTO_ROOT, state) {
  if (!state?.key) return;
  mkdirSync(root, { recursive: true });
  state.updated_at = new Date().toISOString();
  writeFileSync(autoFile(state.key, root), JSON.stringify(state, null, 2) + '\n', 'utf8');
}

// Список всех авто-задач
export function listAuto(root = AUTO_ROOT) {
  if (!existsSync(root)) return [];
  try {
    const files = readdirSync(root).filter((f) => f.endsWith('.json'));
    return files
      .map((f) => {
        try {
          return JSON.parse(readFileSync(path.join(root, f), 'utf8'));
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// Принудительная остановка задачи человеком
export function stopAuto(root = AUTO_ROOT, key, note = 'остановлено человеком') {
  const state = loadAuto(root, key);
  if (!state) return null;
  state.step = 'failed';
  state.note = note;
  state.history = state.history || [];
  state.history.push({ step: 'stopped', at: new Date().toISOString(), ok: false, note });
  saveAuto(root, state);
  return state;
}

// Один шаг стейт-машины авто-задачи. Идемпотентен.
export async function advanceTask(key, deps = {}) {
  const root = deps.root || AUTO_ROOT;
  const ctx = deps.ctx;
  const cfg = deps.cfg || ctx?.cfg || {};

  // 1. Гард: автоматика строго выключаемая и по умолчанию выключена
  if (cfg.automation?.enabled !== true && !deps.force) {
    return { ok: false, skipped: true, reason: 'automation_disabled', state: loadAuto(root, key) };
  }

  // 2. Загрузка или начальная инициализация состояния
  let state = loadAuto(root, key);
  if (!state) {
    state = {
      key,
      step: 'start',
      history: [],
      spent_usd: 0,
      attempts: {},
      mr: null,
      branch: null,
      head_sha: null,
      worktree: null,
      updated_at: new Date().toISOString(),
    };
  }
  state.attempts = state.attempts || {};
  state.history = state.history || [];

  // 3. Терминальные состояния
  if (state.step === 'done') {
    return { ok: true, terminal: true, step: 'done', state };
  }
  if (state.step === 'failed') {
    return { ok: false, terminal: true, step: 'failed', note: state.note, state };
  }

  // 4. Гард: пауза (например, после rate-limit)
  const nowMs = deps.now ? deps.now() : Date.now();
  if (state.paused_until) {
    if (nowMs < new Date(state.paused_until).getTime()) {
      return { ok: true, paused: true, paused_until: state.paused_until, state };
    }
    delete state.paused_until;
  }

  // 5. Гард: суммарный лимит шагов (защита от бесконечных циклов)
  const maxSteps = cfg.automation?.maxSteps ?? 30;
  if ((state.history?.length || 0) >= maxSteps) {
    state.step = 'failed';
    state.note = `Превышен суммарный лимит шагов автомата (${maxSteps})`;
    saveAuto(root, state);
    return { ok: false, stopped: true, reason: 'max_steps_exceeded', state };
  }

  // 6. Гард: лимит попыток на текущем шаге
  const maxRetries = cfg.automation?.maxRetries ?? 3;
  if ((state.attempts?.[state.step] || 0) >= maxRetries) {
    state.step = 'paused';
    state.note = `Исчерпан лимит попыток (${maxRetries}) на шаге ${state.step}`;
    saveAuto(root, state);
    return { ok: false, stopped: true, reason: 'max_retries_exceeded', state };
  }

  // 7. Гард: расход бюджета (только для платных профилей с ключом)
  const costsRoot = deps.costsRoot;
  const spent = sumCosts({ root: costsRoot, issue: key });
  state.spent_usd = spent.total_usd;
  const maxCost = cfg.automation?.maxCostPerTask ?? 2.0;
  const agentProfile = cfg.agents?.[cfg.agent || 'gemini'];
  const hasKey = Boolean(agentProfile?.keyFile || agentProfile?.secret);
  if (hasKey && state.spent_usd >= maxCost) {
    state.step = 'paused';
    state.note = `Превышен лимит стоимости ($${state.spent_usd} >= $${maxCost})`;
    saveAuto(root, state);
    return { ok: false, stopped: true, reason: 'max_cost_exceeded', state };
  }

  // Стейт-машина шагов
  switch (state.step) {
    case 'start': {
      let issue;
      try {
        issue = await ctx.jira().issue(key);
      } catch (err) {
        state.step = 'failed';
        state.note = `Не удалось прочитать задачу в Jira: ${err.message}`;
        state.history.push({ step: 'start', at: new Date().toISOString(), ok: false, note: state.note });
        saveAuto(root, state);
        return { ok: false, error: err, state };
      }

      const stName = issue?.fields?.status?.name ?? '';
      if (/done|закрыт|resolved|готово/i.test(stName)) {
        state.step = 'failed';
        state.note = `Задача уже закрыта в Jira (${stName})`;
        state.history.push({ step: 'start', at: new Date().toISOString(), ok: false, note: state.note });
        saveAuto(root, state);
        return { ok: false, reason: 'issue_closed', state };
      }

      if (!/в работе|in progress/i.test(stName)) {
        try {
          await ctx.jira().transition(key, 'В работе');
        } catch {
          // Игнорируем невозможность перехода в старте
        }
      }

      state.history.push({ step: 'start', at: new Date().toISOString(), ok: true, status: stName });
      state.step = 'implement';
      saveAuto(root, state);
      return { ok: true, advanced: true, state };
    }

    case 'implement': {
      state.attempts.implement = (state.attempts.implement || 0) + 1;
      saveAuto(root, state);
      try {
        const res = await runActionCLI(implementAction, ctx, [key], {
          yes: true,
          json: true,
          asObject: true,
          runsDir: deps.runsDir,
          costsRoot: deps.costsRoot,
          makeProvider: deps.makeProvider,
          spawnAgentImpl: deps.spawnAgentImpl,
          fetchImpl: deps.fetchImpl,
          signal: deps.signal,
        });
        state.mr = res.mr?.iid ?? null;
        state.branch = res.branch ?? null;
        state.head_sha = res.head_sha ?? null;
        state.history.push({ step: 'implement', at: new Date().toISOString(), run: res.run, ok: true, mr: state.mr });
        state.step = 'review';
        saveAuto(root, state);
        return { ok: true, advanced: true, state };
      } catch (err) {
        if (err.code === 'agent_rate_limited') {
          // При рейт-лимите попытка не сгорает
          state.attempts.implement = Math.max(0, state.attempts.implement - 1);
          const pauseSec = err.retry_after || 1800;
          state.paused_until = new Date((deps.now ? deps.now() : Date.now()) + pauseSec * 1000).toISOString();
          state.history.push({ step: 'implement', at: new Date().toISOString(), ok: false, note: `rate-limit: пауза ${pauseSec}с` });
          saveAuto(root, state);
          return { ok: false, paused: true, retry_after: pauseSec, state };
        }
        state.history.push({ step: 'implement', at: new Date().toISOString(), ok: false, note: err.message, run: err.run });
        if (state.attempts.implement >= maxRetries) {
          state.step = 'paused';
          state.note = `implement исчерпал попытки (${maxRetries}): ${err.message}`;
          const tg = getTelegramTarget(cfg);
          if (tg) {
            try {
              await postTelegram(tg, `⚠ Задача ${key}: остановлена на шаге implement (${err.message})`, { fetchImpl: deps.fetchImpl });
            } catch {}
          }
        }
        saveAuto(root, state);
        return { ok: false, error: err, state };
      }
    }

    case 'review': {
      state.attempts.review = (state.attempts.review || 0) + 1;
      saveAuto(root, state);
      const targetStatus = cfg.jira?.reviewStatus || 'Ревью';
      try {
        await ctx.jira().transition(key, targetStatus);
        state.history.push({ step: 'review', at: new Date().toISOString(), ok: true, to: targetStatus });
        state.step = 'ci';
        saveAuto(root, state);
        return { ok: true, advanced: true, state };
      } catch (err) {
        state.step = 'paused';
        state.note = `Не удалось перевести задачу в "${targetStatus}": ${err.message}`;
        state.history.push({ step: 'review', at: new Date().toISOString(), ok: false, note: err.message });
        const tg = getTelegramTarget(cfg);
        if (tg) {
          try {
            await postTelegram(tg, `⚠ Задача ${key}: нужен человек, не заполнены поля перехода в ревью:\n${err.message}`, { fetchImpl: deps.fetchImpl });
          } catch {}
        }
        saveAuto(root, state);
        return { ok: false, paused: true, error: err, state };
      }
    }

    case 'ci': {
      if (!state.mr) {
        state.step = 'failed';
        state.note = 'Нет номера MR для проверки CI';
        saveAuto(root, state);
        return { ok: false, error: new Error(state.note), state };
      }
      const mr = await ctx.g.getMR(ctx.repo, state.mr);
      const pipeline = mr?.head_pipeline || mr?.pipeline;
      const status = pipeline?.status ?? 'none';
      if (['running', 'pending', 'waiting_for_resource'].includes(status)) {
        return { ok: true, waiting: true, status, state };
      }
      if (['failed', 'canceled'].includes(status)) {
        state.attempts.ci = (state.attempts.ci || 0) + 1;
        saveAuto(root, state);
        try {
          const res = await runActionCLI(ciFixAction, ctx, [String(state.mr)], {
            yes: true,
            json: true,
            asObject: true,
            runsDir: deps.runsDir,
            costsRoot: deps.costsRoot,
            makeProvider: deps.makeProvider,
            spawnAgentImpl: deps.spawnAgentImpl,
            fetchImpl: deps.fetchImpl,
            signal: deps.signal,
          });
          state.history.push({ step: 'ci', at: new Date().toISOString(), run: res.run, ok: true, action: 'ci-fix' });
          saveAuto(root, state);
          return { ok: true, action: 'ci-fix', res, state };
        } catch (err) {
          state.history.push({ step: 'ci', at: new Date().toISOString(), ok: false, note: err.message });
          if (state.attempts.ci >= maxRetries) {
            state.step = 'paused';
            state.note = `CI-fix исчерпал попытки: ${err.message}`;
          }
          saveAuto(root, state);
          return { ok: false, error: err, state };
        }
      }
      state.history.push({ step: 'ci', at: new Date().toISOString(), ok: true, status });
      state.step = 'threads';
      saveAuto(root, state);
      return { ok: true, advanced: true, state };
    }

    case 'threads': {
      if (!state.mr) {
        state.step = 'failed';
        state.note = 'Нет номера MR для проверки тредов';
        saveAuto(root, state);
        return { ok: false, error: new Error(state.note), state };
      }
      const disc = (await ctx.g.getDiscussions(ctx.repo, state.mr)) ?? [];
      let me = null;
      try {
        me = await ctx.g.me();
      } catch {}
      const openThreads = disc.filter((d) => {
        const first = d.notes?.[0];
        if (!first || first.system || first.resolvable === false) return false;
        if (first.resolved) return false;
        if (me && first.author?.username === me.username) return false;
        return true;
      });

      if (openThreads.length > 0) {
        state.attempts.threads = (state.attempts.threads || 0) + 1;
        saveAuto(root, state);
        try {
          const res = await runActionCLI(threadsAction, ctx, [String(state.mr)], {
            yes: true,
            json: true,
            asObject: true,
            runsDir: deps.runsDir,
            costsRoot: deps.costsRoot,
            makeProvider: deps.makeProvider,
            spawnAgentImpl: deps.spawnAgentImpl,
            fetchImpl: deps.fetchImpl,
            signal: deps.signal,
          });
          state.history.push({ step: 'threads', at: new Date().toISOString(), run: res.run, ok: true, threads: openThreads.length });
          saveAuto(root, state);
          return { ok: true, action: 'threads', res, state };
        } catch (err) {
          state.history.push({ step: 'threads', at: new Date().toISOString(), ok: false, note: err.message });
          if (state.attempts.threads >= maxRetries) {
            state.step = 'paused';
            state.note = `threads исчерпал попытки: ${err.message}`;
          }
          saveAuto(root, state);
          return { ok: false, error: err, state };
        }
      }

      state.history.push({ step: 'threads', at: new Date().toISOString(), ok: true, threads: 0 });
      state.step = 'conflict';
      saveAuto(root, state);
      return { ok: true, advanced: true, state };
    }

    case 'conflict': {
      if (!state.mr) {
        state.step = 'failed';
        state.note = 'Нет номера MR для проверки конфликтов';
        saveAuto(root, state);
        return { ok: false, error: new Error(state.note), state };
      }
      const mr = await ctx.g.getMR(ctx.repo, state.mr);
      if (mr.has_conflicts) {
        state.attempts.conflict = (state.attempts.conflict || 0) + 1;
        saveAuto(root, state);
        try {
          const res = await runActionCLI(conflictAction, ctx, [String(state.mr)], {
            yes: true,
            json: true,
            asObject: true,
            runsDir: deps.runsDir,
            costsRoot: deps.costsRoot,
            makeProvider: deps.makeProvider,
            spawnAgentImpl: deps.spawnAgentImpl,
            fetchImpl: deps.fetchImpl,
            signal: deps.signal,
          });
          state.history.push({ step: 'conflict', at: new Date().toISOString(), run: res.run, ok: true });
          saveAuto(root, state);
          return { ok: true, action: 'conflict', res, state };
        } catch (err) {
          state.history.push({ step: 'conflict', at: new Date().toISOString(), ok: false, note: err.message });
          if (state.attempts.conflict >= maxRetries) {
            state.step = 'paused';
            state.note = `conflict исчерпал попытки: ${err.message}`;
          }
          saveAuto(root, state);
          return { ok: false, error: err, state };
        }
      }

      state.history.push({ step: 'conflict', at: new Date().toISOString(), ok: true });
      state.step = 'done';
      const tg = getTelegramTarget(cfg);
      if (tg) {
        try {
          await postTelegram(tg, `✅ Задача ${key} полностью завершена автоматом! MR !${state.mr}: ${mr.web_url}`, { fetchImpl: deps.fetchImpl });
        } catch {}
      }
      saveAuto(root, state);
      return { ok: true, terminal: true, step: 'done', state };
    }

    default:
      return { ok: false, reason: `unknown_step_${state.step}`, state };
  }
}
