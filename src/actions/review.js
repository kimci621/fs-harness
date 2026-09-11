import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expandHome } from '../config.js';
import { truncate } from '../judge/payload.js';
import { CliError } from '../errors.js';

const RULES_PATH = path.join('.claude', 'skills', 'mr-review', 'SKILL.md');

// Правила ревью живут в проекте и правятся в одном месте с рубрикой CI-бота.
export function loadRules(projectDir) {
  const file = path.join(projectDir, RULES_PATH);
  if (!existsSync(file)) {
    return { source: 'встроенные', text: 'Правил проекта нет. Суди по общим: корректность, обработка ошибок, границы доверия к входным данным, утечки ресурсов, случайные правки вне задачи MR.' };
  }
  return { source: RULES_PATH, text: readFileSync(file, 'utf8').trim() };
}

// Дифф из API GitLab: склеиваем по файлам, с заголовком как в git.
export function formatChanges(changes, { maxLines = 3000 } = {}) {
  const files = (changes ?? []).map((c) => ({
    path: c.new_path ?? c.old_path,
    kind: c.new_file ? 'новый' : c.deleted_file ? 'удалён' : c.renamed_file ? `переименован из ${c.old_path}` : 'изменён',
    diff: c.diff ?? '',
  }));
  const text = files.map((f) => `diff --git a/${f.path} b/${f.path}\n${f.diff}`).join('\n');
  return { files, diff: truncate(text, maxLines) };
}

export const reviewAction = {
  name: 'review',
  kind: 'action',
  usage: 'review <mr|ветка>',
  description: 'Ревью диффа MR по правилам проекта (читающее, ничего не правит)',
  example: 'fsh review !2547',
  action: {
    title: 'Ревью MR',
    target: 'mr',
    writes: false,
    isolation: 'checkout',
    prompt: 'actions/review',
    agent: { default: 'claude', allow: ['claude', 'pi'], pickByJudge: false },
    judge: { gate: 'advisory', role: 'mr-review' },
    mcpDescription: 'Отревьюить merge request по правилам проекта силами AI-агента: находки с файлом, строкой и severity. Ничего не правит и не комментирует MR, только читает.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'номер MR или часть имени ветки' },
        agent: { type: 'string', enum: ['claude', 'pi'], description: 'какой агент ревьюит' },
      },
      required: ['query'],
    },

    async precheck({ ctx, opts, target: mr }) {
      const projectDir = expandHome(opts.projectDir);
      if (!projectDir || !existsSync(path.join(projectDir, '.git'))) {
        throw new CliError('Каталог проекта не настроен или не является git-репозиторием. Выполни fsh config init или передай --project-dir.', 1, 'config_invalid');
      }
      const { files, diff } = formatChanges((await ctx.g.getMRChanges(ctx.repo, mr.iid))?.changes);
      const rules = loadRules(projectDir);
      if (!files.length) {
        return { projectDir, skip: true, reason: 'в MR нет изменений', result: { ok: true, mr: mr.iid, files: 0, skipped: true } };
      }
      return {
        projectDir,
        files,
        diff,
        rules,
        workspace: { project: projectDir },
        meta: { repo: ctx.repo, mr: mr.iid, source_branch: mr.source_branch, target_branch: mr.target_branch, project_dir: projectDir, rules_source: rules.source },
      };
    },

    dryRun({ opts, target: mr, pre }) {
      return {
        ok: true,
        dry_run: true,
        mr: mr.iid,
        source_branch: mr.source_branch,
        target_branch: mr.target_branch,
        files: pre.files.map((f) => f.path),
        rules: pre.rules.source,
        agent: opts.agent,
        project_dir: pre.projectDir,
        steps: [
          `агент ${opts.agent} читает дифф (файлов: ${pre.files.length}) и код в ${pre.projectDir}`,
          'чекаут только на чтение: изменил — dirty_checkout',
          opts.noJudge ? 'судья отключён (--no-judge)' : 'судья (роль mr-review): второе мнение, ничего не гейтит',
        ],
      };
    },

    renderPlan(plan, log) {
      log(`🔍 План ревью (dry-run), MR !${plan.mr} ${plan.source_branch} → ${plan.target_branch}`);
      log(`   файлов: ${plan.files.length}, правила: ${plan.rules}`);
      log(`   агент: ${plan.agent} · чекаут ${plan.project_dir} (только чтение)`);
      plan.steps.forEach((s, i) => log(`   ${i + 1}. ${s}`));
    },

    context({ ctx, opts, target: mr, pre, say }) {
      say(`🔎 MR !${mr.iid}: ${pre.files.length} файлов, правила — ${pre.rules.source}`);
      say(`   Агент: ${opts.agent} · чекаут ${pre.projectDir} (только чтение)`);
      return {
        repo: ctx.repo,
        mr_iid: mr.iid,
        mr_title: mr.title,
        mr_url: mr.web_url,
        source_branch: mr.source_branch,
        target_branch: mr.target_branch,
        changed_files: pre.files.map((f) => `  ${f.path} (${f.kind})`).join('\n'),
        file_count: pre.files.length,
        diff: pre.diff,
        rules: pre.rules.text,
        project_dir: pre.projectDir,
      };
    },

    goal: ({ target: mr, pre }) =>
      `Отревьюить MR !${mr.iid} «${mr.title}» (${pre.files.length} файлов) по правилам проекта из ${pre.rules.source}. ` +
      'Читающее действие: код не правится, находки выдаются текстом.',

    verify: ({ pre, agentText }) => ({
      files_reviewed: pre.files.length,
      rules_source: pre.rules.source,
      agent_chars: agentText.length,
      diff: pre.diff,
    }),

    // Судья в роли mr-review смотрит тот же дифф и те же правила, а не отчёт агента:
    // это второе мнение, а не приёмка чужого текста.
    judgePayload: ({ ctx, target: mr, pre, agentText }) =>
      [
        `## MR !${mr.iid} «${mr.title}»`,
        `${ctx.repo} · ${mr.source_branch} → ${mr.target_branch} · ${mr.web_url}`,
        '',
        '## Правила проекта',
        '',
        pre.rules.text,
        '',
        '## Дифф',
        '',
        '```diff',
        pre.diff,
        '```',
        '',
        '## Что нашёл первый ревьюер (проверь, не верь на слово)',
        '',
        truncate(agentText, 300),
      ].join('\n'),

    result({ target: mr, run, agentText, verdict, say }) {
      say(`✅ Ревью MR !${mr.iid} готово.`);
      return {
        ok: true,
        run: run.id,
        mr: mr.iid,
        review: agentText,
        judge: verdict
          ? { decision: verdict.decision, confidence: verdict.confidence, summary: verdict.summary, findings: verdict.findings, profile: verdict.meta.profile, cost: verdict.meta.cost }
          : { skipped: true },
      };
    },
  },
};
