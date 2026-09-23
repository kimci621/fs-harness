import { listFlows } from './flow.js';

// fsh agent-guide — самодостаточная инструкция для AI-агента.
// Список команд генерируется из реестра (src/registry.js), чтобы не рассинхронизироваться.
// Агент запускает эту команду первой и получает всё, что нужно для работы.

const GUIDE_TEMPLATE = `fsh — CLI для работы с GitLab (MR, пайплайны, деплой, конфликты, коммиты).
Обёртка над glab; все данные — JSON через API.

## Команды

{{COMMANDS}}

Флаги: -R/--repo <repo>, --host <host>, --json, --agent <профиль: cc, ccq, cco, ccd, agy>, --project-dir <dir>,
-B/--build-job <имя> (дефолт build_image), -w/--watch, -y/--yes, --keep-worktree, --rebuild, --dry-run,
--resolved/--open (mr-comments), --no-judge / --judge <профиль> / --judge-only <runId> (conflict),
--for <mr> (prompts show).

## Сценарии

Готовые протоколы работы: пошагово, с точными командами. Разворачивать через fsh flow show <имя>,
не пересказывать по памяти.

{{FLOWS}}

## Режим агента (env)

  GL_HELPER_JSON=1   все read-команды печатают JSON; side-effect команды — финальный JSON в stdout,
                     прогресс в stderr; ошибки — JSON {ok:false,error:{code,message}} в stdout
  GL_HELPER_YES=1    не спрашивать подтверждение (эквивалент -y везде)

## Рекомендуемый порядок работы

1. fsh doctor — убедиться, что окружение готово (иначе чинить по выводу).
2. read-команды (mrs, mr, mr-comments, jobs) — узнать состояние.
3. side-effect команды сначала с --dry-run, показать план человеку, затем выполнить.

## --json: схемы результатов

mrs/mr:  [{iid, title, draft, source_branch, target_branch, has_conflicts,
          pipeline:{id,status}|null, pipeline_stale, comments:{total,open,resolved},
          updated_at, web_url}]
jobs:    {pipeline:{id,status,web_url}, jobs:[{id,name,stage,status,web_url}]}
mr-comments: {ok, mr, filter, summary:{threads_total,comments_total,threads_open,threads_resolved},
             discussions:[{id,state,notes:[{id,author,created_at,body,system}]}]}
run:     {ok, pipeline:{id}, job:{id,name,status,web_url}}        (dry_run: +dry_run, plan)
deploy:  {ok, mr, pipeline:{id,status,web_url}, build:{...}, deploy:{...}}
conflict:{ok, run, mr, head_sha, commits_ahead, conflict_files:[...],
          judge:{decision,confidence,summary,profile,cost}|{skipped:true},
          pipeline:{...}, build:{...}}
threads: {ok, run, mr, head_sha, commits_ahead, threads_open, replied:[id], resolved:[id],
          judge:{...}|{skipped:true}}
review:  {ok, run, mr, review:"<текст находок>", judge:{...}|{skipped:true}}
analyze: {ok, run, issue, analysis:"<текст разбора>"}
jira:    {ok, issues:[{key,summary,status,type,priority,updated}]} | {ok, issue:{...}, comments:[...]}
commit:  {ok, dir, branch, commit:{hash,message}}
prompts: {ok, prompts:[{name,source,overridden,vars}]} | {ok, name, source, body|text}
doctor:  {ok, checks:[{name,ok,critical,detail}]}

Ошибки (в stdout при --json, exit code ≠ 0):
  {"ok":false,"error":{"code":"<код>","message":"<текст>"}}
Коды: usage, api_failed, mr_not_found, mr_ambiguous, job_not_found, job_failed, job_timeout,
build_failed, deploy_failed, agent_failed, not_pushed, no_commit, git_failed,
workspace_failed, dirty_checkout, config_invalid, canceled, prompt_missing, prompt_var_missing,
judge_rejected, judge_schema, judge_failed,
judge_rubric_missing, secret_missing, run_not_found, run_incomplete, no_mr, not_found,
telegram_failed, tui_requires_tty,
run_not_pending, run_not_approved, already_published, worktree_gone, worktree_moved,
approval_expired, conflict_reappeared, no_session, run_active, resume_not_applicable,
action_unknown, run_not_publishable, deps_unavailable.

## Важные детали поведения

- deploy сам ждёт build и deploy-джобы (опрос 5с, live-статус в stderr), exit 0 только при success.
- deploy с --rebuild перезапускает джобы даже при success (retry, новый id) — перезапись слота.
- conflict: работу с git делает АГЕНТ (claude|agy headless) во временном worktree проекта.
  Пушит не он, а fsh — и только после того, как судья вернул approve. Любой другой вердикт,
  невалидный ответ судьи или падение его бэкенда = гейт закрыт (judge_rejected, judge_schema,
  judge_failed). При любом провале после запуска агента worktree сохранён, путь к нему в
  сообщении. Дальше fsh сам запускает build.
- При telegram.approvals=true гейт pre-push не пушит сам: ран встаёт в pending_approval
  (state в meta.json, worktree сохранён), кнопки Approve/Revise/Reject уходят в Telegram.
  Push делает fsh publish <runId>; доделка в той же сессии — fsh revise <runId>.
  Аппрув живёт сутки (TTL): истёк — авто-reject и уборка worktree (approval_expired).
  Повторное нажатие той же кнопки — «Устарело» (nonce одноразовый, обнуляется до publish).
- threads: те же правила, что у conflict (worktree, гейт судьи, push силами fsh). Агент правит код
  по нерешённым тредам ревью и пишет тексты ответов; отправку ответов и резолв тредов делает fsh
  после approve. Коммитов может не быть — тред мог требовать только ответа, это не провал.
- review и analyze читающие: работают в самом чекауте проекта, ничего не правят и не публикуют.
  Если действие всё же изменило чекаут — ошибка dirty_checkout. review судится advisory (второе
  мнение, ничего не блокирует), у analyze судьи нет. analyze берёт ключ задачи Jira (FD-7647).
- Каждый прогон conflict пишется в ~/.local/state/fs-harness/runs/<runId>/ (meta.json, prompt.md,
  agent.txt, diff.patch, verdict.json, result.json). fsh conflict --judge-only <runId> пересудит
  сохранённый прогон, ничего не запуская заново.
- commit: агент коммитит по паттерну "<ветка> <тип>(<область>): <описание>"; если в корне
  репозитория есть .llm-commit-pattern — паттерн берётся из него. Файлы добавляются явными
  путями, git add -A промптом запрещён. Push не делается.
- Промпты агентов — отдельные .md-файлы, заменяются без правки кода: проектный
  <projectDir>/.fs-harness/prompts/<имя>.md, личный ~/.config/fs-harness/prompts/<имя>.md,
  встроенный. Смотреть и проверять: fsh prompts list|show <имя> [--for <mr>]|check.
- git-операции конфликта делаются только в ветке MR (source), target не трогается, force-push запрещён.
- Side-effect команды без -y/GL_HELPER_YES спрашивают подтверждение и при неинтерактивном stdin откажутся.`;

// Генерирует гайд со списком команд из реестра и сценариев из src/prompts/flows.
export function buildAgentGuide(commands, { projectDir } = {}) {
  const lines = commands
    .filter((c) => c.name !== 'mcp')
    .map((c) => `  fsh ${c.usage.padEnd(24)} ${c.description}`)
    .join('\n');
  const flows = listFlows({ projectDir });
  const flowLines = flows.length
    ? flows.map((f) => `  fsh flow show ${f.name.padEnd(12)} ${f.description}`).join('\n')
    : '  (сценариев нет)';
  return GUIDE_TEMPLATE.replace('{{COMMANDS}}', lines).replace('{{FLOWS}}', flowLines);
}

export function cmdAgentGuide(commands, opts = {}) {
  console.log(buildAgentGuide(commands, opts));
  return 0;
}
