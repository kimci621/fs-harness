// gl-helper agent-guide — самодостаточная инструкция для AI-агента.
// Агент запускает эту команду первой и получает всё, что нужно для работы.
export const AGENT_GUIDE = `gl-helper — CLI для работы с GitLab (MR, пайплайны, деплой, конфликты, коммиты).
Обёртка над glab; все данные — JSON через API.

## Команды

  gl-helper mrs                     все открытые MR: ветки, пайплайн, комменты, конфликты
  gl-helper mr <ветка|номер>        один MR (ветку можно частично, неточный поиск)
  gl-helper jobs <mr|ветка>         джобы последнего MR-пайплайна
  gl-helper run <джоба> <mr|ветка>  запустить manual-джобу; -w — ждать завершения
  gl-helper deploy <ветка> [N]      build → ждать → deploy_dev[ N] → ждать; --rebuild — перезапустить даже success
  gl-helper conflict <mr|ветка>     агент решает конфликт MR в worktree, gl-helper пушит build
  gl-helper commit                  агент формирует коммит по паттерну (.llm-commit-pattern) и коммитит
  gl-helper doctor                  самодиагностика (glab, конфиг, API, git, агенты)
  gl-helper help                    справка

Флаги: -R/--repo <repo>, --host <host>, --json, --agent claude|pi, --project-dir <dir>,
-B/--build-job <имя> (дефолт build_image), -w/--watch, -y/--yes, --keep-worktree, --rebuild, --dry-run.

## Режим агента (env)

  GL_HELPER_JSON=1   все read-команды печатают JSON; side-effect команды — финальный JSON в stdout,
                     прогресс в stderr; ошибки — JSON {ok:false,error:{code,message}} в stdout
  GL_HELPER_YES=1    не спрашивать подтверждение (эквивалент -y везде)

## Рекомендуемый порядок работы

1. gl-helper doctor — убедиться, что окружение готово (иначе чинить по выводу).
2. read-команды (mrs, mr, jobs) — узнать состояние.
3. side-effect команды сначала с --dry-run, показать план человеку, затем выполнить.

## --json: схемы результатов

mrs/mr:  [{iid, title, draft, source_branch, target_branch, has_conflicts,
          pipeline:{id,status}|null, pipeline_stale, comments:{total,open,resolved},
          updated_at, web_url}]
jobs:    {pipeline:{id,status,web_url}, jobs:[{id,name,stage,status,web_url}]}
run:     {ok, pipeline:{id}, job:{id,name,status,web_url}}        (dry_run: +dry_run, plan)
deploy:  {ok, mr, pipeline:{id,status,web_url}, build:{...}, deploy:{...}}
conflict:{ok, mr, head_sha, commits_ahead, pipeline:{...}, build:{...}}
commit:  {ok, dir, branch, commit:{hash,message}}
doctor:  {ok, checks:[{name,ok,critical,detail}]}

Ошибки (в stdout при --json, exit code ≠ 0):
  {"ok":false,"error":{"code":"<код>","message":"<текст>"}}
Коды: usage, api_failed, mr_not_found, mr_ambiguous, job_not_found, job_failed,
build_failed, deploy_failed, agent_failed, not_pushed, no_commit, git_failed,
config_invalid, canceled.

## Важные детали поведения

- deploy сам ждёт build и deploy-джобы (опрос 5с, live-статус в stderr), exit 0 только при success.
- deploy с --rebuild перезапускает джобы даже при success (retry, новый id) — перезапись слота.
- conflict: работу с git делает АГЕНТ (claude|pi headless) во временном worktree проекта,
  gl-helper проверяет push и сам запускает build. Worktree удаляется автоматически.
- commit: агент коммитит по паттерну "<ветка> <тип>(<область>): <описание>"; если в корне
  репозитория есть .llm-commit-pattern — паттерн берётся из него. Push не делается.
- git-операции конфликта делаются только в ветке MR (source), target не трогается, force-push запрещён.
- Side-effect команды без -y/GL_HELPER_YES спрашивают подтверждение и при неинтерактивном stdin откажутся.`;

export function cmdAgentGuide() {
  console.log(AGENT_GUIDE);
  return 0;
}
