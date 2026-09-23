import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expandHome } from '../config.js';
import { truncate } from '../judge/payload.js';
import { CliError } from '../errors.js';

const RULES_PATH = path.join('.claude', 'skills', 'mr-review', 'SKILL.md');

export const SEVERITY_LABEL = {
  blocker: '🚫 **BLOCKER**',
  warning: '⚠ **WARNING**',
  nit: '💬 **NIT**',
};

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

// Unified diff парсер для сопоставления номеров строк и построения position для GitLab.
export function buildDiffIndex(diff) {
  const index = {};
  let curNewPath = null;
  let curOldPath = null;
  let curNew = 0;
  let curOld = 0;
  let inHunk = false;
  const hunkRe = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

  for (const rawLine of String(diff ?? '').split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.startsWith('diff --git')) {
      const gitMatch = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (gitMatch) {
        curOldPath = gitMatch[1];
        curNewPath = gitMatch[2];
        if (!index[curNewPath]) {
          index[curNewPath] = {
            old_path: curOldPath || curNewPath,
            new: {},
            old: {},
          };
        }
      } else {
        curNewPath = null;
        curOldPath = null;
      }
      inHunk = false;
      continue;
    }
    if (line.startsWith('--- ')) {
      const p = line.slice(4).trim();
      curOldPath = p === '/dev/null' ? null : (p.startsWith('a/') ? p.slice(2) : p);
      continue;
    }
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim();
      if (p === '/dev/null') {
        curNewPath = curOldPath;
      } else {
        curNewPath = p.startsWith('b/') ? p.slice(2) : p;
      }
      if (curNewPath !== null && !index[curNewPath]) {
        index[curNewPath] = {
          old_path: curOldPath || curNewPath,
          new: {},
          old: {},
        };
      }
      continue;
    }
    const m = hunkRe.exec(line);
    if (m) {
      curOld = parseInt(m[1], 10);
      curNew = parseInt(m[2], 10);
      inHunk = true;
      continue;
    }
    if (!inHunk || curNewPath === null) {
      continue;
    }
    if (line.startsWith('\\')) {
      continue;
    }
    if (line.startsWith('+')) {
      index[curNewPath].new[curNew] = ['added', null];
      curNew++;
    } else if (line.startsWith('-')) {
      index[curNewPath].old[curOld] = ['removed', null];
      curOld++;
    } else {
      index[curNewPath].new[curNew] = ['context', curOld];
      index[curNewPath].old[curOld] = ['context', curNew];
      curNew++;
      curOld++;
    }
  }

  return index;
}

// Формирует структуру position для inline-дискуссии в GitLab API.
export function buildPosition(diffRefs, finding, diffIndex) {
  const { base_sha, start_sha, head_sha } = diffRefs ?? {};
  if (!base_sha || !start_sha || !head_sha) return null;

  const file = finding?.file;
  const line = Number(finding?.line);
  if (!file || !Number.isInteger(line) || line <= 0) return null;

  const side = finding?.side === 'LEFT' ? 'LEFT' : 'RIGHT';
  const fileDiff = diffIndex?.[file];
  if (!fileDiff) return null;

  const base = {
    base_sha,
    start_sha,
    head_sha,
    position_type: 'text',
    new_path: file,
    old_path: fileDiff.old_path,
  };

  if (side === 'RIGHT') {
    const info = fileDiff.new[line];
    if (!info) return null;
    const [kind, pairedOld] = info;
    base.new_line = line;
    if (kind === 'context' && pairedOld !== null) {
      base.old_line = pairedOld;
    }
    return base;
  }

  const info = fileDiff.old[line];
  if (!info) return null;
  const [kind, pairedNew] = info;
  base.old_line = line;
  if (kind === 'context' && pairedNew !== null) {
    base.new_line = pairedNew;
  }
  return base;
}

export function formatFindingComment(f) {
  const sev = String(f?.severity ?? 'warning').toLowerCase();
  const label = SEVERITY_LABEL[sev] ?? SEVERITY_LABEL.warning;
  return `${label}\n\n${f?.body ?? ''}`;
}

export function formatFallbackComment(f) {
  const sev = String(f?.severity ?? 'warning').toLowerCase();
  const label = SEVERITY_LABEL[sev] ?? SEVERITY_LABEL.warning;
  const where = f?.file ? ` (\`${f.file}\`${f.line ? `, строка ${f.line}` : ''})` : '';
  return `${label}${where}\n\n${f?.body ?? ''}`;
}

export function formatSummaryComment(verdict, findings = []) {
  const counts = { blocker: 0, warning: 0, nit: 0 };
  for (const f of findings) {
    const s = String(f?.severity ?? 'warning').toLowerCase();
    if (counts[s] !== undefined) counts[s]++;
    else counts.warning++;
  }
  const total = findings.length;
  const breakdown = ['blocker', 'warning', 'nit']
    .filter((s) => counts[s] > 0)
    .map((s) => `${SEVERITY_LABEL[s]} ${counts[s]}`)
    .join(' · ');
  const stats = total ? `---\n${breakdown}` : '---\n✅ Замечаний не найдено';
  const summary = verdict?.summary ? `${verdict.summary}\n\n` : '';
  return `🤖 **FS-Harness Code Review**\n\n${summary}${stats}`;
}

export const reviewAction = {
  name: 'review',
  kind: 'action',
  usage: 'review <mr|ветка> [--post]',
  description: 'Ревью диффа MR по правилам проекта (--post отправляет треды в GitLab)',
  example: 'fsh review !2547 --post',
  action: {
    title: 'Ревью MR',
    target: 'mr',
    writes: false,
    isolation: 'checkout',
    prompt: 'actions/review',
    agent: { default: 'cc', pickByJudge: false },
    judge: { gate: 'advisory', role: 'mr-review' },
    mcpDescription: 'Отревьюить merge request по правилам проекта силами AI-агента: находки с файлом, строкой и severity. Без --post — только читает, с post: true — отправляет треды в GitLab.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'номер MR или часть имени ветки' },
        agent: { type: 'string', description: 'какой агент ревьюит (имя профиля из конфига: cc, ccq, cco, ccd, agy)' },
        post: { type: 'boolean', description: 'отправить треды с замечаниями в GitLab' },
      },
      required: ['query'],
    },

    async precheck({ ctx, opts, target: mr }) {
      const projectDir = expandHome(opts.projectDir);
      if (!projectDir || !existsSync(path.join(projectDir, '.git'))) {
        throw new CliError('Каталог проекта не настроен или не является git-репозиторием. Выполни fsh config init или передай --project-dir.', 1, 'config_invalid');
      }
      const mrChanges = await ctx.g.getMRChanges(ctx.repo, mr.iid);
      const { files, diff } = formatChanges(mrChanges?.changes);
      const diff_refs = mrChanges?.diff_refs || mr.diff_refs;
      const rules = loadRules(projectDir);
      if (!files.length) {
        return { projectDir, skip: true, reason: 'в MR нет изменений', result: { ok: true, mr: mr.iid, files: 0, skipped: true } };
      }
      return {
        projectDir,
        files,
        diff,
        diff_refs,
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
        post: Boolean(opts.post),
        project_dir: pre.projectDir,
        steps: [
          `агент ${opts.agent} читает дифф (файлов: ${pre.files.length}) и код в ${pre.projectDir}`,
          'чекаут только на чтение: изменил — dirty_checkout',
          opts.noJudge ? 'судья отключён (--no-judge)' : 'судья (роль mr-review): второе мнение и валидация замечаний',
          opts.post
            ? 'публикация тредов и итогового саммари в GitLab (--post)'
            : 'вывод находок в терминал (для отправки тредов в GitLab добавь --post)',
        ],
      };
    },

    renderPlan(plan, log) {
      log(`🔍 План ревью (dry-run), MR !${plan.mr} ${plan.source_branch} → ${plan.target_branch}`);
      log(`   файлов: ${plan.files.length}, правила: ${plan.rules}`);
      log(`   агент: ${plan.agent} · чекаут ${plan.project_dir} (только чтение)${plan.post ? ' · отправка в GitLab (--post)' : ''}`);
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

    // Судья в роли mr-review смотрит тот же дифф и те же правила, проверяет и отбирает находки первого ревьюера
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

    async publish({ ctx, opts, target: mr, pre, verdict, say }) {
      if (!opts.post) {
        say('ℹ Для отправки тредов в GitLab запусти с --post');
        return { posted: false, discussions: 0, notes: 0 };
      }
      const findings = verdict?.findings ?? [];
      const diffRefs = mr.diff_refs || pre.diff_refs;
      const diffIndex = buildDiffIndex(pre.diff);
      let discussions = 0;
      let notes = 0;

      say(`📤 Отправка замечаний в MR !${mr.iid} (${findings.length})…`);

      for (const f of findings) {
        const pos = diffRefs ? buildPosition(diffRefs, f, diffIndex) : null;
        let inlineOk = false;
        if (pos) {
          try {
            await ctx.g.createDiscussion(ctx.repo, mr.iid, {
              body: formatFindingComment(f),
              position: pos,
            });
            discussions++;
            inlineOk = true;
            say(`   ✓ [${f.severity}] ${f.file}:${f.line}`);
          } catch (err) {
            say(`   ⚠ Inline для ${f.file}:${f.line} отклонён GitLab (${err.message}), отправляю заметкой`);
          }
        } else {
          say(`   ℹ ${f.file}:${f.line} вне контекста диффа, отправляю заметкой`);
        }

        if (!inlineOk) {
          await ctx.g.createNote(ctx.repo, mr.iid, formatFallbackComment(f));
          notes++;
        }
      }

      const summaryBody = formatSummaryComment(verdict, findings);
      await ctx.g.createNote(ctx.repo, mr.iid, summaryBody);
      notes++;

      say(`✅ Опубликовано в MR !${mr.iid}: тредов ${discussions}, заметок ${notes}`);
      return { posted: true, discussions, notes, total_findings: findings.length };
    },

    result({ target: mr, run, agentText, verdict, published, say }) {
      say(`✅ Ревью MR !${mr.iid} готово.`);
      return {
        ok: true,
        run: run.id,
        mr: mr.iid,
        review: agentText,
        judge: verdict
          ? { decision: verdict.decision, confidence: verdict.confidence, summary: verdict.summary, findings: verdict.findings, profile: verdict.meta?.profile, cost: verdict.meta?.cost }
          : { skipped: true },
        published: published ?? { posted: false },
      };
    },
  },
};
