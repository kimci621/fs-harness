// fsh agent-guide — самодостаточная инструкция для AI-агента.
// Список команд генерируется из реестра (src/registry.js), чтобы не рассинхронизироваться.
// Агент запускает эту команду первой и получает всё, что нужно для работы.

const GUIDE_TEMPLATE = `fsh — CLI для работы с GitLab (MR, пайплайны, деплой, конфликты, коммиты).
Обёртка над glab; все данные — JSON через API.

## Команды

{{COMMANDS}}

Флаги: -R/--repo <repo>, --host <host>, --json, --agent claude|pi, --project-dir <dir>,
-B/--build-job <имя> (дефолт build_image), -w/--watch, -y/--yes, --keep-worktree, --rebuild, --dry-run,
--resolved/--open (mr-comments), --no-judge / --judge <профиль> / --judge-only <runId> (conflict),
--for <mr> (prompts show).

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
commit:  {ok, dir, branch, commit:{hash,message}}
prompts: {ok, prompts:[{name,source,overridden,vars}]} | {ok, name, source, body|text}
doctor:  {ok, checks:[{name,ok,critical,detail}]}

Ошибки (в stdout при --json, exit code ≠ 0):
  {"ok":false,"error":{"code":"<код>","message":"<текст>"}}
Коды: usage, api_failed, mr_not_found, mr_ambiguous, job_not_found, job_failed, job_timeout,
build_failed, deploy_failed, agent_failed, not_pushed, no_commit, git_failed,
workspace_failed, dirty_checkout, config_invalid, canceled, prompt_missing, prompt_var_missing,
judge_rejected, judge_schema, judge_failed,
judge_rubric_missing, secret_missing, run_not_found, run_incomplete.

## Важные детали поведения

- deploy сам ждёт build и deploy-джобы (опрос 5с, live-статус в stderr), exit 0 только при success.
- deploy с --rebuild перезапускает джобы даже при success (retry, новый id) — перезапись слота.
- conflict: работу с git делает АГЕНТ (claude|pi headless) во временном worktree проекта.
  Пушит не он, а fsh — и только после того, как судья вернул approve. Любой другой вердикт,
  невалидный ответ судьи или падение его бэкенда = гейт закрыт (judge_rejected, judge_schema,
  judge_failed). При любом провале после запуска агента worktree сохранён, путь к нему в
  сообщении. Дальше fsh сам запускает build.
- threads: те же правила, что у conflict (worktree, гейт судьи, push силами fsh). Агент правит код
  по нерешённым тредам ревью и пишет тексты ответов; отправку ответов и резолв тредов делает fsh
  после approve. Коммитов может не быть — тред мог требовать только ответа, это не провал.
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

// Генерирует гайд со списком команд из реестра.
export function buildAgentGuide(commands) {
  const lines = commands
    .filter((c) => c.name !== 'mcp')
    .map((c) => `  fsh ${c.usage.padEnd(24)} ${c.description}`)
    .join('\n');
  return GUIDE_TEMPLATE.replace('{{COMMANDS}}', lines);
}

export function cmdAgentGuide(commands) {
  console.log(buildAgentGuide(commands));
  return 0;
}
