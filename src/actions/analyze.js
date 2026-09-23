import { existsSync } from 'node:fs';
import path from 'node:path';
import { expandHome } from '../config.js';
import { humanize } from '../format.js';
import { CliError } from '../errors.js';

export function formatComments(comments) {
  if (!comments?.length) return 'Комментариев нет.';
  return comments
    .map((c) => `**${c.author?.displayName ?? '?'}** · ${humanize(c.created)}\n${String(c.body ?? '').trim()}`)
    .join('\n\n');
}

export const analyzeAction = {
  name: 'analyze',
  kind: 'action',
  usage: 'analyze <KEY>',
  description: 'Разобрать задачу Jira: что делать, где в коде, что сломается',
  example: 'fsh analyze FD-7647',
  action: {
    title: 'Разбор задачи',
    target: 'issue',
    writes: false,
    isolation: 'checkout',
    prompt: 'actions/analyze',
    agent: { default: 'cc', pickByJudge: false },
    judge: { gate: 'none', role: 'acceptance' },
    mcpDescription: 'Разобрать задачу Jira силами AI-агента: о чём она, где в коде править, что сломается, какие вопросы к постановщику. Только читает — ни код, ни Jira не меняет.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'ключ задачи Jira, например FD-7647' },
        agent: { type: 'string', description: 'какой агент разбирает (имя профиля из конфига: cc, ccq, cco, ccd, agy)' },
      },
      required: ['query'],
    },

    async precheck({ ctx, opts, target: issue }) {
      const projectDir = expandHome(opts.projectDir);
      if (!projectDir || !existsSync(path.join(projectDir, '.git'))) {
        throw new CliError('Каталог проекта не настроен или не является git-репозиторием. Выполни fsh config init или передай --project-dir.', 1, 'config_invalid');
      }
      const { comments = [] } = (await ctx.jira().comments(issue.key)) ?? {};
      return {
        projectDir,
        comments,
        url: `${(ctx.cfg?.jira?.baseUrl || '').replace(/\/+$/, '')}/browse/${issue.key}`,
        workspace: { project: projectDir },
        meta: { issue: issue.key, status: issue.fields?.status?.name ?? null, project_dir: projectDir },
      };
    },

    dryRun({ opts, target: issue, pre }) {
      return {
        ok: true,
        dry_run: true,
        issue: issue.key,
        summary: issue.fields?.summary ?? '',
        comments: pre.comments.length,
        agent: opts.agent,
        project_dir: pre.projectDir,
        steps: [
          `агент ${opts.agent} читает задачу и код в ${pre.projectDir}`,
          'чекаут только на чтение: изменил — dirty_checkout',
          'судьи нет: разбор ничего не меняет и ничего не публикует',
        ],
      };
    },

    renderPlan(plan, log) {
      log(`🔍 План разбора (dry-run), ${plan.issue}: ${plan.summary}`);
      log(`   комментариев в задаче: ${plan.comments}`);
      log(`   агент: ${plan.agent} · чекаут ${plan.project_dir} (только чтение)`);
      plan.steps.forEach((s, i) => log(`   ${i + 1}. ${s}`));
    },

    context({ target: issue, pre, opts, say }) {
      say(`📋 ${issue.key}: ${issue.fields?.summary ?? ''}`);
      say(`   Статус: ${issue.fields?.status?.name ?? '—'} · комментариев: ${pre.comments.length}`);
      say(`   Агент: ${opts.agent} · чекаут ${pre.projectDir} (только чтение)`);
      return {
        issue_key: issue.key,
        issue_summary: issue.fields?.summary ?? '',
        issue_status: issue.fields?.status?.name ?? '—',
        issue_description: String(issue.fields?.description ?? '').trim() || 'Описания нет.',
        issue_comments: formatComments(pre.comments),
        issue_url: pre.url,
        project_dir: pre.projectDir,
      };
    },

    goal: ({ target: issue }) => `Разобрать задачу ${issue.key} «${issue.fields?.summary ?? ''}» по коду проекта. Читающее действие: ничего не править.`,

    verify: ({ pre, agentText }) => ({
      issue_comments: pre.comments.length,
      agent_chars: agentText.length,
    }),

    result({ target: issue, run, agentText, say }) {
      say(`✅ Разбор ${issue.key} готов.`);
      return { ok: true, run: run.id, issue: issue.key, analysis: agentText };
    },
  },
};
