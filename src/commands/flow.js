import { listTemplates, loadTemplate } from '../prompts.js';
import { finish } from '../output.js';
import { CliError } from '../errors.js';

const PREFIX = 'flows/';

// Сценарии — это markdown-протоколы для агента, а не команды: у сценария нет кода,
// есть шаги и точные вызовы fsh. Лежат рядом с промптами и так же переопределяются.
export function listFlows({ projectDir } = {}) {
  return listTemplates({ projectDir })
    .filter((t) => t.name.startsWith(PREFIX))
    .map((t) => {
      const tpl = loadTemplate(t.name, { projectDir });
      return { name: t.name.slice(PREFIX.length), description: tpl.meta.description ?? '', source: tpl.source, body: tpl.body };
    });
}

export function cmdFlow(args, opts = {}, ctx = {}) {
  const [sub = 'list', name] = args;
  const projectDir = opts.projectDir || ctx.cfg?.projectDir || '';
  if (sub === 'list') return list(projectDir, opts);
  if (sub === 'show') return show(projectDir, name, opts);
  throw new CliError('Использование: fsh flow list | fsh flow show <имя>.', 1, 'usage');
}

function list(projectDir, opts) {
  const flows = listFlows({ projectDir }).map(({ body, ...f }) => f);
  const result = { ok: true, flows };
  if (opts.asObject) return result;
  if (opts.json) return finish(true, result);
  const width = Math.max(...flows.map((f) => f.name.length));
  for (const f of flows) console.log(`  ${f.name.padEnd(width)}  ${f.description}`);
  console.log('\nРазвернуть: fsh flow show <имя>');
  return result;
}

// Сценарий по имени или по словам описания («взять задачу» → take-task). Слова сверяются
// по первым пяти буквам, чтобы падеж не мешал. Не нашлось одного — ближайшие в near.
export function matchFlow(flows, query = '') {
  const exact = flows.find((f) => f.name === query);
  if (exact) return { flow: exact, near: [] };
  const stems = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).map((w) => w.slice(0, 5));
  const hits = (f) => {
    const text = `${f.name.replaceAll('-', ' ')} ${f.description}`.toLowerCase();
    return stems.filter((s) => text.includes(s)).length;
  };
  const full = stems.length ? flows.filter((f) => hits(f) === stems.length) : [];
  if (full.length === 1) return { flow: full[0], near: [] };
  const near = full.length ? full : flows.filter((f) => hits(f) > 0);
  return { flow: null, near: near.map((f) => f.name) };
}

function show(projectDir, name, opts) {
  const flows = listFlows({ projectDir });
  const { flow, near } = matchFlow(flows, name);
  if (!flow) {
    const hint = near.length ? `Похожие: ${near.join(', ')}.` : `Есть: ${flows.map((f) => f.name).join(', ')}.`;
    throw new CliError(`Нет сценария "${name ?? ''}". ${hint}`, 1, 'usage');
  }
  const result = { ok: true, name: flow.name, source: flow.source, body: flow.body };
  if (opts.asObject) return result;
  if (opts.json) return finish(true, result);
  console.log(flow.body);
  return result;
}
