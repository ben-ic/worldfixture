import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve, relative, isAbsolute } from 'node:path';

export function writeSessionJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally { rmSync(temporary, { force: true }); }
}

export function readActiveGeneration(sessionRoot, { allowTransition = false } = {}) {
  const path = join(sessionRoot, 'active-generation.json');
  if (!existsSync(path)) return null;
  const active = JSON.parse(readFileSync(path, 'utf8'));
  if (active.api_version !== 'worldfixture.active-generation/v1' || typeof active.generation !== 'string'
    || !active.generation || typeof active.artifactPath !== 'string' || typeof active.stateDir !== 'string') {
    throw new Error('The active world record is invalid. Stop this session and start it again.');
  }
  if (!allowTransition && active.phase !== 'ready') {
    throw new Error('The world session is not ready. Inspect its switch status before sending commands.');
  }
  return active;
}

// Docker's /state bind mount is the same session directory on the host. Other
// absolute paths belong to the direct runtime and are left unchanged.
export function sessionPath(sessionRoot, path) {
  if (process.env.WORLDFIXTURE_SINGLE_CONTAINER !== '1' && existsSync(join(sessionRoot, 'instance.json'))
    && (path === '/state' || path.startsWith('/state/'))) {
    const suffix = relative('/state', path);
    if (suffix.startsWith('..') || isAbsolute(suffix)) throw new Error('Invalid active world path');
    return resolve(sessionRoot, suffix);
  }
  return path;
}

export function activeStateDir(sessionRoot) {
  const active = readActiveGeneration(sessionRoot);
  return active ? sessionPath(sessionRoot, active.stateDir) : sessionRoot;
}

export function activeFile(sessionRoot, field, fallback) {
  const active = readActiveGeneration(sessionRoot);
  return active ? sessionPath(sessionRoot, active[field] ?? join(active.stateDir, fallback)) : join(sessionRoot, fallback);
}
