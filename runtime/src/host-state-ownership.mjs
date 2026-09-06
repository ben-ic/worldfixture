import { chownSync, lstatSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

// The container must stay root to start services under their own users. Only
// runtime metadata belongs to the user who supplied the host bind mount.
export function createHostOwnership({ enabled, roots = ['/state', '/project-private'] } = {}) {
  return function share(path) {
    if (!(enabled ?? process.env.WORLDFIXTURE_SINGLE_CONTAINER === '1')) return false;
    const target = resolve(path);
    const root = roots.find(candidate => target === candidate || target.startsWith(`${candidate}${sep}`));
    if (!root) return false;
    const owner = statSync(root);
    const suffix = relative(root, target);
    let current = root;
    // Validate every ancestor before changing ownership. Never follow a link
    // into a service directory or outside the host mount.
    const paths = [];
    for (const part of suffix ? suffix.split(sep) : []) {
      current = join(current, part);
      const info = lstatSync(current);
      if (info.isSymbolicLink()) throw new Error(`Runtime state must not contain a symlink: ${current}`);
      paths.push([current, info]);
    }
    for (const [name, info] of paths) {
      if (info.uid !== owner.uid || info.gid !== owner.gid) chownSync(name, owner.uid, owner.gid);
    }
    return true;
  };
}

export const shareHostOwnership = createHostOwnership();

// Call only on a newly prepared world artifact, never on runtime/service state.
export function shareHostArtifact(path) {
  if (!shareHostOwnership(path)) return;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) shareHostArtifact(child);
    else shareHostOwnership(child);
  }
}
