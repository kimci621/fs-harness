import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { CliError } from '../errors.js';

export const RUNS_DIR = path.join(homedir(), '.local', 'state', 'fs-harness', 'runs');

// Каталог рана. meta.json не для красоты: без него --judge-only не на чем работать.
export function createRun(action, { root = RUNS_DIR } = {}) {
  root = root || RUNS_DIR; // явный undefined из опций не должен обнулять дефолт
  const id = `${action}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const dir = path.join(root, id);
  mkdirSync(dir, { recursive: true });
  return { id, dir };
}

export function saveArtifact(run, name, content) {
  const body = typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n';
  writeFileSync(path.join(run.dir, name), body);
}

export function readRun(id, { root = RUNS_DIR } = {}) {
  const dir = path.join(root, id);
  if (!existsSync(path.join(dir, 'meta.json'))) {
    throw new CliError(`Ран "${id}" не найден: нет ${path.join(dir, 'meta.json')}.`, 1, 'run_not_found');
  }
  const read = (name) => {
    const p = path.join(dir, name);
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  };
  return { id, dir, meta: JSON.parse(read('meta.json')), read };
}
