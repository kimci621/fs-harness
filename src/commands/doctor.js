import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createGlab } from '../glab.js';
import { loadConfig, CONFIG_PATH, expandHome } from '../config.js';

// gl-helper doctor — самодиагностика окружения: glab, конфиг, API, git, агенты.
// Критично: glab, api. Остальное — предупреждения.
export async function cmdDoctor({ repo, host, projectDir, json } = {}) {
  const checks = [];
  const add = (name, ok, detail, critical = false) => checks.push({ name, ok: Boolean(ok), critical, detail: detail ?? (ok ? 'ok' : '') });

  add('node', /^v(2[0-9]|[3-9]\d)\./.test(process.version), process.version, true);

  try {
    const v = execFileSync('glab', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    add('glab', true, v, true);
  } catch {
    add('glab', false, 'не найден в PATH. Установка: brew install glab', true);
  }

  let cfg = null;
  try {
    cfg = loadConfig();
    add('config', true, CONFIG_PATH);
  } catch (err) {
    add('config', false, err.message, true);
  }

  const targetRepo = repo || cfg?.repo;
  const targetHost = host || cfg?.host;
  if (targetRepo && targetHost) {
    try {
      const g = createGlab(undefined, { host: targetHost, sleepMs: 100 });
      const project = await g.api(targetRepo, '', { retries: 1 });
      add('api', true, `${targetHost} · проект "${targetRepo}" #${project?.id ?? '?'} доступен, авторизация ok`, true);
    } catch (err) {
      add('api', false, `${targetHost} · "${targetRepo}": ${err.message}`, true);
    }
  } else {
    add('api', false, 'нет repo/host в конфиге — запусти gl-helper config init', true);
  }

  const dir = expandHome(projectDir || cfg?.projectDir || '~');
  add('git', existsSync(path.join(dir, '.git')), `${dir}${existsSync(path.join(dir, '.git')) ? '' : ' — нет .git (conflict не заработает)'}`);

  for (const agent of ['claude', 'pi']) {
    try {
      const where = execFileSync('which', [agent], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      add(`agent ${agent}`, true, where);
    } catch {
      add(`agent ${agent}`, false, 'не найден в PATH');
    }
  }

  if (json) {
    const ok = checks.every((c) => !c.critical || c.ok);
    console.log(JSON.stringify({ ok, checks }, null, 2));
    return ok ? 0 : 1;
  }

  for (const c of checks) {
    console.log(`${c.ok ? '✅' : '❌'} ${c.name.padEnd(12)} ${c.detail}`);
  }
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) {
    console.log(`\n${failed.filter((c) => c.critical).length} критических, ${failed.filter((c) => !c.critical).length} предупреждений.`);
  } else {
    console.log('\nВсё в порядке, gl-helper готов к работе.');
  }
  return checks.some((c) => c.critical && !c.ok) ? 1 : 0;
}
