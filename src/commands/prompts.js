import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { listTemplates, loadTemplate, renderTemplate, checkTemplates, templatePaths } from '../prompts.js';
import { resolveMR } from '../resolve.js';
import { expandHome } from '../config.js';
import { finish } from '../output.js';
import { CliError } from '../errors.js';

// fsh prompts list|show|check|edit — промпты как артефакты, которые можно посмотреть и заменить.
export async function cmdPrompts(actions, args, opts = {}, ctx = {}) {
  const [sub, name] = args;
  const projectDir = expandHome(opts.projectDir || ctx.cfg?.projectDir || '');
  switch (sub) {
    case 'list': return list(projectDir, opts);
    case 'show': return show(actions, name, projectDir, opts, ctx);
    case 'check': return check(projectDir, opts);
    case 'edit': return edit(name, projectDir);
    default:
      throw new CliError('Использование: fsh prompts list | show <имя> [--for <mr>] | check | edit <имя>', 1, 'usage');
  }
}

function list(projectDir, opts) {
  const items = listTemplates({ projectDir });
  if (opts.json) return finish(true, { ok: true, prompts: items });
  const width = Math.max(...items.map((t) => t.name.length));
  for (const t of items) {
    console.log(`${t.overridden ? '✏️ ' : '  '} ${t.name.padEnd(width)}  ${t.source}`);
  }
  console.log(`\nПереопределить: ${path.join(projectDir || '<projectDir>', '.fs-harness', 'prompts', '<имя>.md')} или fsh prompts edit <имя>`);
  return { ok: true, prompts: items };
}

async function show(actions, name, projectDir, opts, ctx) {
  if (!name) throw new CliError('Использование: fsh prompts show <имя> [--for <mr|ветка>]', 1, 'usage');
  const tpl = loadTemplate(name, { projectDir });
  if (!opts.for) {
    if (opts.json) return finish(true, { ok: true, name, source: tpl.source, vars: tpl.meta.vars ?? [], body: tpl.body });
    console.log(`# ${name} · ${tpl.source}`);
    if (tpl.meta.vars) console.log(`# переменные: ${tpl.meta.vars.join(', ')}\n`);
    console.log(tpl.body);
    return { ok: true, name, source: tpl.source };
  }

  // --for: отрендерить на реальных данных через context() того действия, чей это промпт.
  const spec = actions.find((a) => a.action.prompt === name);
  if (!spec) throw new CliError(`Шаблон "${name}" не принадлежит ни одному действию — рендерить --for нечем.`, 1, 'usage');
  const x = {
    ctx,
    opts: { ...opts, agent: opts.agent || ctx.cfg?.agent || spec.action.agent.default, projectDir },
    say: () => {},
    phase: () => {},
    run: { id: '(превью)' },
  };
  x.target = await resolveMR(ctx.g, ctx.repo, opts.for);
  x.pre = await spec.action.precheck(x);
  const rendered = renderTemplate(name, await spec.action.context(x), { projectDir });
  if (opts.json) return finish(true, { ok: true, name, source: rendered.source, text: rendered.text });
  console.log(`# ${name} · ${rendered.source} · для MR !${x.target.iid}\n`);
  console.log(rendered.text);
  return { ok: true, name, source: rendered.source };
}

function check(projectDir, opts) {
  const problems = checkTemplates({ projectDir });
  const errors = problems.filter((p) => p.level === 'error');
  if (opts.json) {
    finish(true, { ok: errors.length === 0, problems });
    return errors.length ? 1 : 0;
  }
  for (const p of problems) console.log(`${p.level === 'error' ? '❌' : '⚠️ '} ${p.name} (${p.source}): ${p.message}`);
  console.log(problems.length ? `\n${errors.length} ошибок, ${problems.length - errors.length} предупреждений.` : 'Все шаблоны в порядке.');
  return errors.length ? 1 : 0;
}

function edit(name, projectDir) {
  if (!name) throw new CliError('Использование: fsh prompts edit <имя>', 1, 'usage');
  if (!projectDir) throw new CliError('Не задан projectDir: некуда класть проектный оверрайд. Передай --project-dir.', 1, 'config_invalid');
  const tpl = loadTemplate(name, { projectDir });
  const dest = templatePaths(name, { projectDir })[0];
  if (!existsSync(dest)) {
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(tpl.path, dest); // целиком, вместе с front-matter — иначе оверрайд потеряет vars
    console.log(`📄 Скопировал ${tpl.source} → ${dest}`);
  }
  const editor = process.env.EDITOR || process.env.VISUAL;
  if (!editor) {
    console.log(`Открой сам: ${dest} ($EDITOR не задан).`);
    return { ok: true, path: dest };
  }
  execFileSync(editor, [dest], { stdio: 'inherit' });
  return { ok: true, path: dest };
}
