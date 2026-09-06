import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export const SELECTION_PATHS = [
  'project', 'state/input-world', 'selected-build', 'state/instance.json',
  'state/host-bindings.json', 'state/host-addresses.json', 'state/environment.json',
  'state/environment.lock.json',
];

export function snapshot(path, selectedPaths) {
  const result = {};
  const walk = file => {
    const name = relative(path, file);
    // Exclude unrelated trees before accessing them. Provider directories can
    // be private to a container user and are outside the selection contract.
    if (selectedPaths && name && !selectedPaths.some(selected =>
      name === selected || name.startsWith(`${selected}/`) || selected.startsWith(`${name}/`))) return;
    if (!existsSync(file)) return;
    const stat = statSync(file);
    if (stat.isDirectory()) {
      if (!selectedPaths) result[name] = { directory: true, mode: stat.mode, mtime: stat.mtimeMs };
      for (const child of readdirSync(file).sort()) walk(join(file, child));
    } else if (stat.isFile()) {
      result[name] = { sha256: createHash('sha256').update(readFileSync(file)).digest('hex'), mode: stat.mode, mtime: stat.mtimeMs };
    }
  };
  walk(path);
  return result;
}
