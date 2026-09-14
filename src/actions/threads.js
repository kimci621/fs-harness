import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expandHome } from '../config.js';
import { ACCEPTANCE_PATHSPECS } from '../judge/payload.js';
import { runChecks, checksFact } from '../checks.js';
import { makeGit, WORKTREE_ROOT } from '../workspace.js';
import { CliError } from '../errors.js';

// Тред считается открытым, если в нём есть хоть одна нерешённая resolvable-заметка.
// Системные записи («изменил статус») не в счёт.
export function openThreads(discussions) {
  return (discussions ?? [])
    .filter((d) => (d.notes ?? []).some((n) => n.resolvable && !n.resolved && !n.system))
    .map((d) => {
      const first = d.notes.find((n) => !n.system) ?? d.notes[0] ?? {};
      const pos = first.position;
      return {
        id: d.id,
        file: pos?.new_path ?? pos?.old_path ?? null,
        line: pos?.new_line ?? pos?.old_line ?? null,
        notes: d.notes.filter((n) => !n.system).map((n) => ({
          author: n.author?.username ?? n.author?.name ?? '?',
          created_at: n.created_at,
          body: String(n.body ?? '').trim(),
        })),
      };
    });
}

export function formatThreads(threads) {
  return threads
    .map((t) => {
      const where = t.file ? `${t.file}${t.line ? `:${t.line}` : ''}` : 'общий комментарий к MR';
      const notes = t.notes.map((n) => `${n.author}: ${n.body}`).join('\n\n');
      return `### Тред ${t.id}\nГде: ${where}\n\n${notes}`;
    })
    .join('\n\n');
}

// Ответы агента: строгий разбор. Пустой или кривой файл — провал действия,
// а не «ну ладно, отправим что есть».
export function parseReplies(text, openIds) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new CliError(`Агент записал ответы не как JSON: ${err.message}`, 1, 'agent_failed');
  }
  if (!Array.isArray(raw)) throw new CliError('Ответы агента должны быть JSON-массивом.', 1, 'agent_failed');
  const seen = new Set();
  const replies = [];
  for (const r of raw) {
    const id = String(r?.id ?? '');
    const reply = String(r?.reply ?? '').trim();
    if (!id || !reply) throw new CliError(`В ответах агента есть запись без id или текста: ${JSON.stringify(r)}`, 1, 'agent_failed');
    if (seen.has(id)) continue;
    seen.add(id);
    replies.push({ id, reply, resolve: r.resolve !== false, known: openIds.includes(id) });
  }
  return replies;
}

export const threadsAction = {
  name: 'threads',
  kind: 'action',
  usage: 'threads <mr|ветка>',
  description: 'Разобрать нерешённые треды ревью: правки, ответы, резолв',
  example: 'fsh threads !2547',
  action: {
    title: 'Разобрать треды ревью',
    target: 'mr',
    writes: true,
    isolation: 'ephemeral-worktree',
    prompt: 'actions/threads',
    agent: { default: 'cc', pickByJudge: false },
    judge: { gate: 'pre-push', role: 'acceptance' },
    mcpDescription: 'Разобрать нерешённые треды код-ревью в MR силами AI-агента во временном git worktree: внести правки, подготовить ответы. Push, отправка ответов и резолв тредов происходят только после approve судьи. Меняет код и GitLab.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'номер MR или часть имени ветки' },
        agent: { type: 'string', description: 'какой агент разбирает треды (имя профиля из конфига: cc, ccq, cco, ccd, pi)' },
      },
      required: ['query'],
    },

    async precheck({ ctx, opts, target: mr, say }) {
      const projectDir = expandHome(opts.projectDir);
      if (!projectDir || !existsSync(path.join(projectDir, '.git'))) {
        throw new CliError('Каталог проекта не настроен или не является git-репозиторием. Выполни fsh config init или передай --project-dir.', 1, 'config_invalid');
      }
      makeGit(projectDir)(['fetch', 'origin', `${mr.source_branch}:refs/remotes/origin/${mr.source_branch}`]);
      const threads = openThreads(await ctx.g.getDiscussions(ctx.repo, mr.iid));
      const skip = threads.length === 0;
      if (skip) say(`✅ В MR !${mr.iid} нерешённых тредов нет.`);

      return {
        projectDir,
        threads,
        workspace: { project: projectDir, ref: mr.source_branch, baseRef: mr.target_branch, key: String(mr.iid), refs: [] },
        skip,
        reason: 'нерешённых тредов нет',
        result: { ok: true, mr: mr.iid, threads_open: 0, skipped: true },
        meta: {
          repo: ctx.repo,
          mr: mr.iid,
          source_branch: mr.source_branch,
          target_branch: mr.target_branch,
          project_dir: projectDir,
          thread_ids: threads.map((t) => t.id),
        },
      };
    },

    dryRun({ opts, target: mr, pre }) {
      return {
        ok: true,
        dry_run: true,
        mr: mr.iid,
        source_branch: mr.source_branch,
        target_branch: mr.target_branch,
        threads_open: pre.threads.length,
        threads: pre.threads.map((t) => ({ id: t.id, file: t.file, line: t.line })),
        agent: opts.agent,
        project_dir: pre.projectDir,
        worktree_root: path.join(WORKTREE_ROOT, path.basename(pre.projectDir)),
        steps: [
          `worktree add --detach ${path.join(WORKTREE_ROOT, path.basename(pre.projectDir), `threads-${mr.iid}-<ts>`)} origin/${mr.source_branch}`,
          `агент ${opts.agent}: правки по тредам, коммит, тексты ответов в replies.json`,
          opts.noJudge ? 'судья отключён (--no-judge)' : 'судья (роль acceptance): approve или ничего не уедет',
          `push origin HEAD:${mr.source_branch} (если были правки)`,
          `ответы в ${pre.threads.length} тредов и резолв тех, что агент счёл закрытыми`,
          'удаление временного worktree',
        ],
      };
    },

    renderPlan(plan, log) {
      log(`🔍 План разбора тредов (dry-run), MR !${plan.mr} ${plan.source_branch} → ${plan.target_branch}`);
      log(`   нерешённых тредов: ${plan.threads_open}`);
      plan.threads.forEach((t) => log(`     ${t.id.slice(0, 8)} ${t.file ? `${t.file}${t.line ? `:${t.line}` : ''}` : 'общий'}`));
      log(`   worktree: ${plan.worktree_root}/threads-${plan.mr}-<ts>`);
      log(`   агент: ${plan.agent} (headless)`);
      plan.steps.forEach((s, i) => log(`   ${i + 1}. ${s}`));
    },

    context({ ctx, opts, target: mr, pre, ws, run, say }) {
      say(`💬 MR !${mr.iid}: ${pre.threads.length} нерешённых тредов`);
      pre.threads.forEach((t) => say(`   ${t.id.slice(0, 8)} ${t.file ? `${t.file}${t.line ? `:${t.line}` : ''}` : 'общий'} · ${t.notes[0]?.author ?? '?'}`));
      say(`   Агент: ${opts.agent} · worktree: ${ws.dir}${ws.deps.available ? '' : ' · без node_modules'}`);
      say(`   Ран: ${run.id}`);
      return {
        repo: ctx.repo,
        mr_iid: mr.iid,
        mr_title: mr.title,
        mr_url: mr.web_url,
        source_branch: mr.source_branch,
        target_branch: mr.target_branch,
        threads: formatThreads(pre.threads),
        thread_count: pre.threads.length,
        worktree: ws.dir,
        deps_available: ws.deps.available,
        replies_file: path.join(run.dir, 'replies.json'),
      };
    },

    goal: ({ target: mr, pre }) =>
      `Разобрать ${pre.threads.length} нерешённых тредов ревью в MR !${mr.iid} «${mr.title}»: где ревьюер прав — поправить код, где нет — ответить по существу. ` +
      'Правки только по тредам, посторонние изменения запрещены. Ответы агент готовит текстом, отправляет их и резолвит треды fs-harness после приёмки.',

    verify({ ws, pre, run, opts, say }) {
      const { git, dir, base } = ws;
      const file = path.join(run.dir, 'replies.json');
      if (!existsSync(file)) {
        throw new CliError(`Агент не записал ответы в ${file}. Отправлять нечего.`, 1, 'agent_failed');
      }
      const replies = parseReplies(readFileSync(file, 'utf8'), pre.threads.map((t) => t.id));
      const commitsAhead = Number(git(['rev-list', '--count', `${base}..HEAD`], dir));
      return {
        commits_ahead: commitsAhead, // ноль — норма: тред мог требовать только ответа
        deps_available: ws.deps.available,
        head_sha: git(['rev-parse', 'HEAD'], dir),
        changed_files: commitsAhead ? git(['diff', '--name-only', `${base}..HEAD`], dir).split('\n').filter(Boolean) : [],
        threads_open: pre.threads.length,
        replies_given: replies.length,
        threads_without_reply: pre.threads.filter((t) => !replies.some((r) => r.id === t.id)).map((t) => t.id),
        unknown_threads: replies.filter((r) => !r.known).map((r) => r.id),
        to_resolve: replies.filter((r) => r.resolve).length,
        replies,
        diff: commitsAhead ? git(['diff', `${base}..HEAD`, '--', ...ACCEPTANCE_PATHSPECS], dir) : '',
        checks: !commitsAhead
          ? 'не прогонялись: агент не менял код'
          : checksFact(opts.cfg?.checks ?? [], ws.deps.available) ?? runChecks(opts.cfg.checks, dir, { say }),
      };
    },

    // Судье показываем и сами треды, и то, что агент собрался на них ответить.
    judgeExtra: ({ pre, facts }) =>
      `${formatThreads(pre.threads)}\n\n### Подготовленные ответы\n\n` +
      facts.replies.map((r) => `- ${r.id}${r.resolve ? ' (резолв)' : ' (оставить открытым)'}: ${r.reply}`).join('\n'),

    async publish({ ctx, target: mr, ws, facts, say }) {
      const { g, repo } = ctx;
      if (facts.commits_ahead > 0) {
        say(`⬆ Пушу в ${mr.source_branch}…`);
        ws.git(['push', 'origin', `HEAD:${mr.source_branch}`], ws.dir);
        const remoteSha = ws.git(['ls-remote', 'origin', `refs/heads/${mr.source_branch}`]).split(/\s+/)[0] || '';
        if (remoteSha !== facts.head_sha) {
          throw new CliError(`Push прошёл, но origin на ${remoteSha.slice(0, 8)} вместо ${facts.head_sha.slice(0, 8)}. Кто-то запушил параллельно.`, 1, 'not_pushed');
        }
        say(`✅ Запушено в ${mr.source_branch} (${facts.head_sha.slice(0, 8)}).`);
      } else {
        say('ℹ Правок в коде нет — пушить нечего, только ответы.');
      }

      const replied = [];
      const resolved = [];
      for (const r of facts.replies) {
        if (!r.known) {
          say(`⚠ Тред ${r.id} не из списка открытых — пропускаю.`);
          continue;
        }
        await g.replyDiscussion(repo, mr.iid, r.id, r.reply);
        replied.push(r.id);
        if (r.resolve) {
          await g.resolveDiscussion(repo, mr.iid, r.id);
          resolved.push(r.id);
        }
        say(`   💬 ${r.id.slice(0, 8)} — ответ отправлен${r.resolve ? ', тред закрыт' : ', оставлен открытым'}`);
      }
      return { replied, resolved };
    },

    result({ target: mr, run, facts, verdict, published, say }) {
      say(`✅ Треды MR !${mr.iid} разобраны: ${published.replied.length} ответов, ${published.resolved.length} закрыто.`);
      return {
        ok: true,
        run: run.id,
        mr: mr.iid,
        head_sha: facts.head_sha,
        commits_ahead: facts.commits_ahead,
        threads_open: facts.threads_open,
        replied: published.replied,
        resolved: published.resolved,
        judge: verdict
          ? { decision: verdict.decision, confidence: verdict.confidence, summary: verdict.summary, profile: verdict.meta.profile, cost: verdict.meta.cost }
          : { skipped: true },
      };
    },
  },
};
