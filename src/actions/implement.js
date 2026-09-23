import { existsSync } from 'node:fs';
import path from 'node:path';
import { expandHome } from '../config.js';
import { ACCEPTANCE_PATHSPECS } from '../judge/payload.js';
import { buildAcceptancePayload } from '../judge/payload.js';
import { checksFact, runChecks } from '../checks.js';
import { getTelegramTarget, postTelegram } from '../notify.js';
import { branchFor, isProtected } from '../commands/task.js';
import { CliError } from '../errors.js';

// Планировщик и исполнитель — разные профили: план на opus, реализация на gemini flash.
// Имена вынесены в константы, чтобы dry-run и декларация не разъезжались.
export const PLAN_AGENT = 'opus';
export const EXEC_AGENT = 'gemini';

const titleOf = (issue) => `${issue.key}: ${issue.fields?.summary ?? ''}`.trim();

// Реализация задачи Jira целиком: план (claude opus) → код (agy gemini) → ревью судьёй
// (до трёх доделок) → push → черновик MR. Решение «отправить в ревью команде» остаётся
// человеку: снятие черновика, перевод Jira и пост в Mattermost делает `fsh task submit`.
export const implementAction = {
  name: 'implement',
  kind: 'action',
  usage: 'implement <KEY>',
  description: 'Реализовать задачу Jira: план, код, ревью судьёй, push и черновик MR',
  example: 'fsh implement FD-7647',
  action: {
    title: 'Реализовать задачу',
    target: 'issue',
    writes: true,
    isolation: 'task-worktree',
    prompt: 'actions/implement-execute',
    plan: { agent: PLAN_AGENT, prompt: 'actions/implement-plan' },
    agent: { default: EXEC_AGENT, pickByJudge: false },
    judge: { gate: 'pre-push', role: 'task-review', maxRevise: 3 },
    mcpDescription: 'Реализовать задачу Jira силами двух агентов: claude opus составляет план по коду, agy gemini пишет код, судья (до трёх доделок) принимает работу, затем fs-harness пушит ветку и открывает черновик MR в целевой ветке. Меняет код, git и GitLab. Отправка в ревью команде — отдельно (fsh task submit).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'ключ задачи Jira, например FD-7647' },
        agent: { type: 'string', description: 'какой агент пишет код (имя профиля из конфига, по умолчанию gemini)' },
      },
      required: ['query'],
    },

    async precheck({ ctx, opts, target: issue, say }) {
      const projectDir = expandHome(opts.projectDir);
      if (!projectDir || !existsSync(path.join(projectDir, '.git'))) {
        throw new CliError('Каталог проекта не настроен или не является git-репозиторием. Выполни fsh config init или передай --project-dir.', 1, 'config_invalid');
      }
      const target = opts.target || opts.cfg?.targetBranch || 'dev';
      const branch = branchFor(issue.key, opts.cfg?.branchPattern);
      if (isProtected(branch, target)) {
        throw new CliError(`Ветка "${branch}" защищённая, реализовывать в ней нельзя. Поправь branchPattern в конфиге.`, 1, 'usage');
      }
      const { comments = [] } = (await ctx.jira().comments(issue.key)) ?? {};
      const status = issue.fields?.status?.name ?? '—';
      const url = `${(opts.cfg?.jira?.baseUrl || '').replace(/\/+$/, '')}/browse/${issue.key}`;
      say(`📋 ${issue.key}: ${issue.fields?.summary ?? ''}`);
      say(`   ${status} · ветка ${branch} от origin/${target} · план ${PLAN_AGENT} → код ${opts.agent}`);
      return {
        projectDir,
        target,
        branch,
        comments,
        url,
        status,
        workspace: { project: projectDir, ref: target, refs: [target], key: issue.key },
        meta: { repo: ctx.repo, issue: issue.key, status, target_branch: target, branch, project_dir: projectDir },
      };
    },

    dryRun({ opts, target: issue, pre }) {
      return {
        ok: true,
        dry_run: true,
        issue: issue.key,
        summary: issue.fields?.summary ?? '',
        branch: pre.branch,
        target: pre.target,
        plan_agent: PLAN_AGENT,
        agent: opts.agent,
        project_dir: pre.projectDir,
        steps: [
          `worktree от origin/${pre.target} (режим task-worktree, переживает ран)`,
          `${PLAN_AGENT}: прочитать задачу и реальный код, составить план реализации`,
          `${opts.agent}: реализовать по плану, прогнать проверки, закоммитить`,
          opts.noJudge ? 'судья отключён (--no-judge)' : `судья (роль task-review, до ${3} доделок): без approve push не произойдёт`,
          `push origin HEAD:${pre.branch}`,
          `открыть MR в ${pre.target} черновиком и уведомить (Telegram)`,
          'отправка в ревью команде — по решению человека: fsh task submit ' + issue.key,
        ],
      };
    },

    renderPlan(plan, log) {
      log(`🔍 План реализации (dry-run), ${plan.issue}: ${plan.summary}`);
      log(`   ветка ${plan.branch} → ${plan.target} · чекаут ${plan.project_dir}`);
      log(`   план: ${plan.plan_agent} · код: ${plan.agent}`);
      plan.steps.forEach((s, i) => log(`   ${i + 1}. ${s}`));
    },

    context({ ctx, opts, target: issue, pre, ws, run, say }) {
      say(`   Worktree: ${ws.dir}`);
      say(`   Ран: ${run.id}`);
      return {
        repo: ctx.repo,
        issue_key: issue.key,
        issue_summary: issue.fields?.summary ?? '',
        issue_status: pre.status,
        issue_description: String(issue.fields?.description ?? '').trim() || 'Описания нет.',
        issue_comments: formatComments(pre.comments),
        issue_url: pre.url,
        target_branch: pre.target,
        branch: pre.branch,
        project_dir: pre.projectDir,
        worktree: ws.dir,
        checks: (opts.cfg?.checks ?? []).map((c) => `  ${c}`).join('\n') || '  (в конфиге проекта проверок нет)',
      };
    },

    goal: ({ target: issue, pre }) =>
      `Реализовать задачу ${issue.key} «${issue.fields?.summary ?? ''}» в ветке ${pre.branch} и открыть черновик MR в ${pre.target}.`,

    verify({ ws, opts, say }) {
      const { git, dir, base } = ws;
      const commitsAhead = Number(git(['rev-list', '--count', `${base}..HEAD`], dir));
      if (commitsAhead === 0) {
        throw new CliError(`Агент не создал коммитов в worktree (${dir}) — реализовывать нечего. Проверь вручную: git -C ${dir} status.`, 1, 'agent_failed');
      }
      return {
        commits_ahead: commitsAhead,
        deps_available: ws.deps.available,
        head_sha: git(['rev-parse', 'HEAD'], dir),
        changed_files: git(['diff', '--name-only', `${base}..HEAD`], dir).split('\n').filter(Boolean),
        diff: git(['diff', `${base}..HEAD`, '--', ...ACCEPTANCE_PATHSPECS], dir),
        diff_title: 'Дифф реализации (base..HEAD)',
        checks: checksFact(opts.cfg?.checks ?? [], ws.deps.available) ?? runChecks(opts.cfg.checks, dir, { say }),
      };
    },

    // Судье уходит и задача, и план: ревью сверяет код с тем, что задумывалось, а не только
    // с текстом задачи. План — часть задания, а не отчёт агента, поэтому кладём в extra.
    judgePayload: ({ target: issue, plan, facts, agentText }) =>
      buildAcceptancePayload({
        goal: [`${issue.key}: ${issue.fields?.summary ?? ''}`, String(issue.fields?.description ?? '').trim()].join('\n\n').trim(),
        facts: { ...facts, diff: undefined, diff_title: undefined },
        extra: ['## План, по которому работал исполнитель', '', plan ?? '(план не сохранён)'].join('\n'),
        diff: facts.diff,
        diffTitle: facts.diff_title,
        agentText,
      }),

    async publish({ ctx, opts, target: issue, pre, ws, facts, say, signal }) {
      const { g, repo } = ctx;
      say(`⬆ Пушу ${pre.branch}…`);
      ws.git(['push', '-u', 'origin', `HEAD:${pre.branch}`], ws.dir);
      const remoteSha = ws.git(['ls-remote', 'origin', `refs/heads/${pre.branch}`]).split(/\s+/)[0] || '';
      if (remoteSha !== facts.head_sha) {
        throw new CliError(`Push прошёл, но origin на ${remoteSha.slice(0, 8)} вместо ${facts.head_sha.slice(0, 8)}. Кто-то запушил параллельно.`, 1, 'not_pushed');
      }
      say(`✅ Запушено в ${pre.branch} (${facts.head_sha.slice(0, 8)}).`);

      const open = await g.listOpenMRs(repo, { source_branch: pre.branch });
      const existing = open?.[0] ?? null;
      const mr = existing
        ? await g.updateMR(repo, existing.iid, { title: `Draft: ${titleOf(issue)}` })
        : await g.createMR(repo, {
            source_branch: pre.branch,
            target_branch: pre.target,
            title: `Draft: ${titleOf(issue)}`,
            description: pre.url,
            remove_source_branch: true,
          });
      say(`✅ MR !${mr.iid} (черновик) → ${pre.target}: ${mr.web_url}`);

      // Уведомление человеку: MR готов, можно смотреть и решать про ревью команде.
      // Сбой Telegram — строка в логе, а не провал: работа уже сделана и запушена.
      const tg = getTelegramTarget(opts.cfg);
      if (tg) {
        const text = [
          `✅ ${issue.key} реализована · MR !${mr.iid} (черновик): ${mr.web_url}`,
          `Отправить в ревью: fsh task submit ${issue.key}`,
        ].join('\n');
        try {
          await postTelegram(tg, text, { fetchImpl: opts.fetchImpl, signal });
        } catch (e) {
          say(`⚠ Уведомление не ушло: ${e.message}`);
        }
      }
      return { pushed: true, mr: { iid: mr.iid, title: mr.title, web_url: mr.web_url, draft: true } };
    },

    result({ target: issue, run, pre, facts, verdict, published, say }) {
      say(`✅ ${issue.key}: MR !${published?.mr?.iid ?? '?'} открыт черновиком. Отправить в ревью: fsh task submit ${issue.key}`);
      return {
        ok: true,
        run: run.id,
        issue: issue.key,
        branch: pre.branch,
        target: pre.target,
        head_sha: facts.head_sha,
        commits_ahead: facts.commits_ahead,
        mr: published?.mr ?? null,
        judge: verdict
          ? { decision: verdict.decision, confidence: verdict.confidence, summary: verdict.summary, profile: verdict.meta.profile, cost: verdict.meta.cost }
          : { skipped: true },
      };
    },
  },
};

function formatComments(comments) {
  if (!comments?.length) return 'Комментариев нет.';
  return comments
    .map((c) => `**${c.author?.displayName ?? '?'}**\n${String(c.body ?? '').trim()}`)
    .join('\n\n');
}
