import { envStates } from '../growthbook.js';
import { table, truncate } from '../format.js';
import { finish } from '../output.js';
import { confirm } from '../ui.js';
import { CliError } from '../errors.js';

// fsh growthbook list|get|create|toggle|delete — фича-флаги. Правило раскатки,
// эксперименты и метрики живут в вебе, туда мы не лезем.
export async function cmdGrowthBook(ctx, args, opts = {}) {
  const [sub, ...rest] = args;
  const gb = ctx.gb();
  const result =
    !sub || sub === 'list' ? await list(gb, ctx, opts)
      : sub === 'get' ? await get(gb, rest)
        : sub === 'create' ? await create(gb, ctx, rest, opts)
          : sub === 'toggle' ? await toggle(gb, ctx, rest, opts)
            : sub === 'delete' ? await del(gb, rest, opts)
              : (() => { throw new CliError('Использование: fsh growthbook [list|get <id>|create <id> <on|off>|toggle <id> <on|off>|delete <id>].', 1, 'usage'); })();

  if (opts.asObject) return result;
  if (opts.json) finish(true, result);
  else render(result);
  return result;
}

async function list(gb, ctx, opts) {
  const project = opts.for || ctx.cfg.growthbook.project || '';
  const out = [];
  for (let offset = 0; ;) {
    const page = await gb.features({ project, offset });
    out.push(...page.features);
    if (page.nextOffset === null) break;
    offset = page.nextOffset;
  }
  const flags = out.filter((f) => !f.archived).map(brief);
  return { ok: true, flags, total: flags.length };
}

async function get(gb, [id]) {
  if (!id) throw new CliError('Использование: fsh growthbook get <id>.', 1, 'usage');
  const f = await gb.feature(id);
  return { ok: true, flag: { ...brief(f), description: f.description ?? '', owner: f.owner ?? '', project: f.project ?? '' } };
}

async function create(gb, ctx, [id, state], opts) {
  if (!id) throw new CliError('Использование: fsh growthbook create <id> [on|off] [--type <тип>] [--default <значение>] [--for <проект>].', 1, 'usage');
  const on = state === 'on';
  const env = opts.env || ctx.cfg.growthbook.env;
  const valueType = opts.type || 'boolean';
  const defaultValue = opts.default !== undefined && opts.default !== null
    ? String(opts.default)
    : (valueType === 'boolean' ? 'true' : '');
  const body = {
    id,
    valueType,
    defaultValue,
    project: opts.for || ctx.cfg.growthbook.project || undefined,
    // rules обязателен в каждом окружении, иначе zod-валидатор API отдаёт 400.
    environments: { [env]: { enabled: on, rules: [] } },
  };
  if (opts.dryRun) return { ok: true, dry_run: true, created: id, body };
  if (!opts.yes && !opts.asObject && !confirm(`Создать флаг "${id}" (${env}=${on ? 'on' : 'off'})? [y/N] `)) {
    throw new CliError('Отменено.', 0, 'canceled');
  }
  return { ok: true, created: id, flag: brief(await gb.createFeature(body)) };
}

async function toggle(gb, ctx, [id, state], opts) {
  if (!id || !['on', 'off'].includes(state)) throw new CliError('Использование: fsh growthbook toggle <id> <on|off> [--env <окружение>].', 1, 'usage');
  const env = opts.env || ctx.cfg.growthbook.env;
  const on = state === 'on';
  if (opts.dryRun) return { ok: true, dry_run: true, toggled: id, env, enabled: on };
  if (!opts.yes && !opts.asObject && !confirm(`Флаг "${id}": ${env} → ${on ? 'on' : 'off'}? [y/N] `)) {
    throw new CliError('Отменено.', 0, 'canceled');
  }
  const f = await gb.toggleFeature(id, { [env]: on }, `fsh: ${env} → ${on ? 'on' : 'off'}`);
  // Read-back: GrowthBook отвечает 200 и на запрос про окружение, которого нет.
  const after = f?.environments?.[env];
  if (!after) throw new CliError(`У флага "${id}" нет окружения "${env}". Есть: ${Object.keys(f?.environments ?? {}).join(', ') || 'ни одного'}.`, 1, 'api_failed');
  if (Boolean(after.enabled) !== on) throw new CliError(`GrowthBook принял переключение "${id}", но ${env} остался ${after.enabled ? 'on' : 'off'}.`, 1, 'api_failed');
  return { ok: true, toggled: id, env, enabled: on, flag: brief(f) };
}

const brief = (f) => ({ id: f.id, type: f.valueType, default: f.defaultValue, envs: envStates(f), tags: f.tags ?? [] });

// Удаление необратимо; API может отказаться для живого флага (см. growthbook.js).
async function del(gb, [id], opts) {
  if (!id) throw new CliError('Использование: fsh growthbook delete <id>.', 1, 'usage');
  if (opts.dryRun) return { ok: true, dry_run: true, deleted: id };
  if (!opts.yes && !opts.asObject && !confirm(`Удалить флаг "${id}" без возможности вернуть? [y/N] `)) {
    throw new CliError('Отменено.', 0, 'canceled');
  }
  const r = await gb.deleteFeature(id);
  if (r?.deletedId !== id) throw new CliError(`GrowthBook не подтвердил удаление "${id}" — проверь флаг в вебе.`, 1, 'api_failed');
  return { ok: true, deleted: id };
}

function render(r) {
  if (r.flags) {
    if (!r.flags.length) return void console.log('Флагов нет.');
    console.log(table(r.flags.map((f) => [f.id, f.type, f.envs, truncate((f.tags ?? []).join(', '), 30)])));
    return;
  }
  if (r.dry_run) return void console.log(`dry-run: ${r.created ? `создать ${r.created}` : r.deleted ? `удалить ${r.deleted}` : `${r.toggled} ${r.env} → ${r.enabled ? 'on' : 'off'}`}`);
  if (r.deleted) return void console.log(`Флаг ${r.deleted} удалён.`);
  const f = r.flag;
  if (r.created) return void console.log(`Флаг ${f.id} создан: ${f.envs}`);
  if (r.toggled) return void console.log(`Флаг ${f.id}: ${f.envs}`);
  console.log(`${f.id} · ${f.type} · default ${f.default}`);
  console.log(f.envs);
  if (f.description) console.log(`\n${f.description}`);
  if (f.owner) console.log(`\nвладелец: ${f.owner}`);
}
