import { loadAuto, listAuto, stopAuto, advanceTask, AUTO_ROOT } from '../auto.js';
import { sumCosts } from '../costs.js';
import { CliError } from '../errors.js';
import { finish } from '../output.js';
import { ISSUE_KEY } from '../jira.js';

export async function cmdAuto(ctx, args = [], opts = {}) {
  const [subOrKey, maybeKey] = args;
  const root = opts.autoRoot || AUTO_ROOT;

  if (subOrKey === 'status') {
    const key = maybeKey;
    if (key) {
      const state = loadAuto(root, key);
      if (!state) throw new CliError(`Задача ${key} не найдена в автомате.`, 1, 'not_found');
      const costs = sumCosts({ issue: key });
      const item = { ...state, spent_usd: costs.total_usd };
      if (opts.asObject) return { ok: true, task: item };
      if (opts.json) return finish(true, { ok: true, task: item });
      console.log(`\n📋 Задача ${item.key}:`);
      console.log(`   Шаг:        ${item.step}`);
      console.log(`   Расход:     $${item.spent_usd.toFixed(4)}`);
      if (item.mr) console.log(`   MR:         !${item.mr}`);
      if (item.branch) console.log(`   Ветка:      ${item.branch}`);
      if (item.note) console.log(`   Заметка:    ${item.note}`);
      if (item.paused_until) console.log(`   Пауза до:   ${item.paused_until}`);
      console.log(`   Обновлено:  ${item.updated_at}`);
      if (item.history?.length) {
        console.log('\n   История:');
        item.history.forEach((h) => {
          const ok = h.ok ? '✅' : '❌';
          console.log(`   - ${ok} ${h.step} (${h.at}): ${h.note || (h.run ? `ран ${h.run}` : 'ок')}`);
        });
      }
      return { ok: true, task: item };
    }

    const tasks = listAuto(root).map((t) => {
      const costs = sumCosts({ issue: t.key });
      return { ...t, spent_usd: costs.total_usd };
    });
    if (opts.asObject) return { ok: true, tasks };
    if (opts.json) return finish(true, { ok: true, tasks });

    if (!tasks.length) {
      console.log('В автомате нет активных задач. Запуск: fsh auto <KEY>');
      return { ok: true, tasks: [] };
    }

    console.log(`\nЗадачи в автомате (${tasks.length}):\n`);
    console.log('КЛЮЧ      ШАГ        РАСХОД     MR    ОБНОВЛЕНО');
    console.log('-'.repeat(55));
    for (const t of tasks) {
      const keyCol = t.key.padEnd(9);
      const stepCol = (t.step || '—').padEnd(10);
      const spentCol = (`$${t.spent_usd.toFixed(2)}`).padEnd(10);
      const mrCol = (t.mr ? `!${t.mr}` : '—').padEnd(5);
      const updated = t.updated_at ? t.updated_at.slice(11, 19) : '—';
      console.log(`${keyCol} ${stepCol} ${spentCol} ${mrCol} ${updated}`);
    }
    return { ok: true, tasks };
  }

  if (subOrKey === 'stop') {
    const key = maybeKey;
    if (!key) throw new CliError('Использование: fsh auto stop <KEY>', 1, 'usage');
    const stopped = stopAuto(root, key, opts.message || 'остановлено человеком');
    if (!stopped) throw new CliError(`Задача ${key} не найдена в автомате.`, 1, 'not_found');
    if (opts.asObject) return { ok: true, key, stopped: true, state: stopped };
    if (opts.json) return finish(true, { ok: true, key, stopped: true, state: stopped });
    console.log(`⏹ Задача ${key} остановлена в автомате.`);
    return { ok: true, key, stopped: true, state: stopped };
  }

  // fsh auto <KEY>
  const key = subOrKey;
  if (!key || !ISSUE_KEY.test(key)) {
    throw new CliError('Использование: fsh auto <KEY> | fsh auto status [KEY] | fsh auto stop <KEY>', 1, 'usage');
  }

  // При прямом вызове fsh auto <KEY> разрешаем запуск даже если в глобальном конфиге automation.enabled: false
  const adv = await advanceTask(key, {
    cfg: ctx.cfg,
    ctx,
    root,
    runsDir: opts.runsDir,
    costsRoot: opts.costsRoot,
    force: true, // явный запуск человеком из CLI
    makeProvider: opts.makeProvider,
    spawnAgentImpl: opts.spawnAgentImpl,
    fetchImpl: depsOrOpts(opts, 'fetchImpl'),
  });

  if (opts.asObject) return adv;
  if (opts.json) return finish(adv.ok, adv);

  const st = adv.state;
  console.log(`\n🤖 Автомат задачи ${key}:`);
  console.log(`   Текущий шаг: ${st.step}`);
  if (st.note) console.log(`   Заметка:     ${st.note}`);
  if (st.mr) console.log(`   MR:          !${st.mr}`);
  if (st.paused_until) console.log(`   Пауза до:    ${st.paused_until}`);
  return adv;
}

function depsOrOpts(opts, name) {
  return opts[name];
}
