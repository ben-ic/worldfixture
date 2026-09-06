import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export function lifecyclePath(path, stateDir) {
  if (typeof path !== 'string' || !path || path.includes('\0')) throw new Error('Invalid service state path');
  let base, target;
  if (isAbsolute(path)) {
    if (!/^\/tmp\/(?:seaweedfs(?:\/|$)|worldfixture-[a-z0-9_-]+(?:\/|$))/.test(path)) throw new Error(`Service state path is outside approved temporary state: ${path}`);
    base = '/tmp'; target = resolve(path);
    const root = path.split('/').slice(0, 3).join('/');
    if (target !== root && !target.startsWith(`${root}/`)) throw new Error(`Service state path escapes its root: ${path}`);
  } else {
    base = resolve(stateDir); target = resolve(base, path);
    if (target === base || !target.startsWith(`${base}${sep}`)) throw new Error(`Service state path escapes runtime state: ${path}`);
  }
  // The runtime root itself may use the platform /var -> /private/var alias.
  // Reject symlinks below that root before either copying or removing files.
  const verifiedBase = existsSync(base) ? realpathSync(base) : base;
  let current = verifiedBase;
  for (const part of relative(base, target).split(sep)) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error(`Service state path crosses a symlink: ${path}`);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return current;
}
