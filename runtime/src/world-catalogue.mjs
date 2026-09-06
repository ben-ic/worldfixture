import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const HASH = /^[a-f0-9]{64}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const present = value => value !== undefined && value !== null;
const message = error => error instanceof Error ? error.message : String(error);
// Match compiler canonical_json, including its trailing newline. Serialize keys
// directly so JSON.stringify cannot reorder integer-like object keys.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const tableHash = table => hash(`${canonical(table)}\n`);

function within(root, path) {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function filePath(root, name) {
  if (typeof name !== 'string' || !name || isAbsolute(name) || name.includes('\\')) {
    throw new Error(`Invalid relative file path: ${String(name)}`);
  }
  const path = resolve(root, name);
  if (!within(root, path) || path === root || name.split('/').includes('..')) {
    throw new Error(`File path leaves artifact or source directory: ${name}`);
  }
  const actual = realpathSync(path);
  if (!within(root, actual)) throw new Error(`File symlink leaves artifact or source directory: ${name}`);
  return actual;
}

function fileTableErrors(table, label) {
  if (!object(table) || !Object.keys(table).length) return [`${label} must be a nonempty file table`];
  const errors = [];
  for (const [name, entry] of Object.entries(table)) {
    if (!name || isAbsolute(name) || name.includes('\\') || name.split('/').includes('..')) {
      errors.push(`${label} has an invalid relative path: ${name}`);
    }
    if (!object(entry) || !HASH.test(entry.sha256) || !Number.isSafeInteger(entry.size) || entry.size < 0) {
      errors.push(`${label}[${name}] must declare a SHA-256 hash and a nonnegative integer size`);
    }
  }
  return errors;
}

function checkedBytes(root, name, entry) {
  let bytes;
  try { bytes = readFileSync(filePath(root, name)); }
  catch (error) { throw new Error(`${name}: ${message(error)}`); }
  if (bytes.length !== entry.size) throw new Error(`${name}: size mismatch (expected ${entry.size}, actual ${bytes.length})`);
  const actualHash = hash(bytes);
  if (actualHash !== entry.sha256) throw new Error(`${name}: SHA-256 mismatch (expected ${entry.sha256}, actual ${actualHash})`);
  return bytes;
}

function json(bytes, label) {
  try { return JSON.parse(bytes.toString('utf8')); }
  catch (error) { throw new Error(`${label}: invalid JSON (${message(error)})`); }
}

function walk(root, wanted, result, seen = new Set()) {
  let actual;
  try { actual = realpathSync(root); } catch { return; }
  if (seen.has(actual)) return;
  seen.add(actual);
  let entries;
  try { entries = readdirSync(actual, { withFileTypes: true }); } catch { return; }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const names = typeof wanted === 'string' ? new Set([wanted]) : wanted;
  for (const entry of entries) {
    if (names.has(entry.name) && (entry.isFile() || entry.isSymbolicLink())) {
      result.add(join(actual, entry.name));
      // Source searches pass a name set: even a source named manifest.json
      // does not make this directory an artifact catalogue leaf.
      if (wanted === 'manifest.json') return;
    }
  }
  for (const entry of entries) {
    if (entry.isDirectory() && !['node_modules', '.git', '.worldfixture'].includes(entry.name)) {
      walk(join(actual, entry.name), wanted, result, seen);
    }
  }
}

function sourceCandidates(sourceRoots, sourceFiles) {
  const candidates = new Set();
  // The compiler records the root source by basename, and fragments relative
  // to that source's directory. Top-level fragments remain possible candidates
  // until their API version is checked; nested fragments cannot be roots.
  const names = new Set(Object.keys(sourceFiles).filter(name => basename(name) === name));
  for (const root of sourceRoots) {
    if (typeof root !== 'string' || !root) continue;
    const absolute = resolve(root);
    try {
      const actual = realpathSync(absolute);
      if (statSync(actual).isFile()) {
        if (names.has(basename(actual))) candidates.add(actual);
        continue;
      }
    } catch { continue; }
    // Accept repository roots, a worlds directory, or a custom source tree.
    let scan = absolute;
    try { if (statSync(join(absolute, 'worlds')).isDirectory()) scan = join(absolute, 'worlds'); } catch {}
    walk(scan, names, candidates);
  }
  return [...candidates].sort();
}

function provenanceErrors(manifest) {
  const errors = fileTableErrors(manifest.source_files, 'manifest.source_files');
  if (!HASH.test(manifest.source_sha256)) errors.push('manifest.source_sha256 must be a SHA-256 hash');
  if (errors.length) return errors;
  const entries = Object.values(manifest.source_files);
  const directHash = entries.length === 1 ? entries[0].sha256 : null;
  if (manifest.source_sha256 !== directHash && manifest.source_sha256 !== tableHash(manifest.source_files)) {
    errors.push('manifest.source_sha256 does not match manifest.source_files');
  }
  return errors;
}

function verifiedSource(manifest, sourceRoots) {
  if (provenanceErrors(manifest).length) return null;
  for (const candidate of sourceCandidates(sourceRoots, manifest.source_files)) {
    try {
      const root = realpathSync(dirname(candidate));
      const bytes = readFileSync(candidate);
      const source = json(bytes, candidate);
      const fragmented = source?.api_version === 'worldfixture.world-manifest/v1';
      if (!fragmented && source?.api_version !== 'worldfixture.world-source/v1') continue;
      const identity = fragmented ? source.world : source;
      if (!identity || identity.id !== manifest.world_id || identity.version !== manifest.world_version) continue;
      const actualFiles = {};
      for (const [name, entry] of Object.entries(manifest.source_files)) {
        const bytes = checkedBytes(root, name, entry);
        actualFiles[name] = { sha256: hash(bytes), size: bytes.length };
      }
      if (!Object.hasOwn(actualFiles, basename(candidate))) continue;
      if (fragmented) {
        if (!Array.isArray(source.fragments) || !source.fragments.length) continue;
        const declaredFiles = [basename(candidate)];
        for (const path of source.fragments) {
          const actual = filePath(root, path);
          const normalized = relative(root, actual).split(sep).join('/');
          if (declaredFiles.includes(normalized)) throw new Error('Duplicate source fragment');
          declaredFiles.push(normalized);
          if (json(readFileSync(actual), path).api_version !== 'worldfixture.world-fragment/v1') throw new Error('Invalid source fragment');
        }
        if (canonical(declaredFiles.sort()) !== canonical(Object.keys(actualFiles).sort())) continue;
        if (tableHash(actualFiles) !== manifest.source_sha256) continue;
      } else {
        if (source.api_version !== 'worldfixture.world-source/v1' || Object.keys(actualFiles).length !== 1) continue;
        if (hash(bytes) !== manifest.source_sha256) continue;
      }
      return candidate;
    } catch {
      // A same-name source is not proof. Try every candidate with exact bytes.
    }
  }
  return null;
}

/** Read only. Invalid builds still expose sourcePath when provenance verifies. */
export function inspectWorldArtifact(artifactPath, { sourceRoots = [] } = {}) {
  const result = { id: null, version: null, digest: null, artifactPath: null,
    selectionSource: null, sourcePath: null, manifest: null, valid: false, errors: [] };
  try {
    if (typeof artifactPath !== 'string' || !artifactPath.trim()) throw new Error('Artifact path must be a nonempty string');
    result.artifactPath = resolve(artifactPath);
    const root = realpathSync(result.artifactPath);
    if (!statSync(root).isDirectory()) throw new Error(`Artifact path is not a directory: ${result.artifactPath}`);
    const manifest = json(readFileSync(filePath(root, 'manifest.json')), 'manifest.json');
    if (!object(manifest)) throw new Error('manifest.json must contain an object');
    result.manifest = manifest;
    result.id = typeof manifest.world_id === 'string' ? manifest.world_id : null;
    result.version = typeof manifest.world_version === 'string' ? manifest.world_version : null;
    result.digest = typeof manifest.artifact_sha256 === 'string' ? manifest.artifact_sha256 : null;
    if (manifest.api_version !== 'worldfixture.world-artifact/v1') result.errors.push('Unsupported manifest.api_version');
    if (!result.id || !/^[a-z][a-z0-9.-]+$/.test(result.id)) result.errors.push('Manifest must declare a valid world_id');
    if (!result.version || !/^v[0-9]+$/.test(result.version)) result.errors.push('Manifest must declare a valid world_version');
    if (!HASH.test(manifest.artifact_sha256)) result.errors.push('manifest.artifact_sha256 must be a SHA-256 hash');
    const tableErrors = fileTableErrors(manifest.files, 'manifest.files');
    result.errors.push(...tableErrors, ...provenanceErrors(manifest));
    // Source lookup does not depend on the state of generated output files.
    if (result.id && result.version && Array.isArray(sourceRoots)) result.sourcePath = verifiedSource(manifest, sourceRoots);
    if (!tableErrors.length) {
      if (tableHash(manifest.files) !== manifest.artifact_sha256) result.errors.push('Artifact aggregate SHA-256 mismatch');
      for (const [name, entry] of Object.entries(manifest.files)) {
        try {
          const bytes = checkedBytes(root, name, entry);
          if (name === 'world.json') {
            const world = json(bytes, name);
            if (world?.api_version !== 'worldfixture.world-source/v1') result.errors.push('Unsupported world.json api_version');
            if (world?.id !== result.id || world?.version !== result.version) result.errors.push('world.json identity does not match manifest identity');
          }
        } catch (error) { result.errors.push(message(error)); }
      }
      if (!Object.hasOwn(manifest.files, 'world.json')) result.errors.push('manifest.files does not include world.json');
    }
  } catch (error) { result.errors.push(message(error)); }
  result.valid = result.errors.length === 0;
  return result;
}

/** Include invalid entries for diagnostics instead of hiding broken builds. */
export function listWorldArtifacts({ distRoot, sourceRoots = [] } = {}) {
  if (typeof distRoot !== 'string' || !distRoot.trim()) throw new Error('distRoot must be a nonempty directory path');
  const manifests = new Set();
  walk(resolve(distRoot), 'manifest.json', manifests);
  return [...manifests].sort().map(path => inspectWorldArtifact(dirname(path), { sourceRoots }));
}

function input(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a nonempty string`);
  return value;
}

function looksLikePath(value, cwd) {
  if (isAbsolute(value) || value.startsWith('.') || value.includes('/') || value.includes('\\')) return true;
  try { return statSync(resolve(cwd, value)).isDirectory(); } catch { return false; }
}

/** Resolve one selection before callers create project or runtime state. */
export function resolveWorldSelection({ selector, worldPath, projectWorld,
  defaultWorld = 'business.saas-company:v3', distRoot, sourceRoots = [], cwd = process.cwd() } = {}) {
  if (present(selector) && present(worldPath)) throw new Error('Conflicting world selectors: use selector or worldPath, not both');
  let value;
  let selectionSource;
  if (present(selector)) { value = input(selector, 'selector'); selectionSource = 'selector'; }
  else if (present(worldPath)) { value = input(worldPath, 'worldPath'); selectionSource = 'worldPath'; }
  else if (present(projectWorld)) { value = input(projectWorld, 'projectWorld'); selectionSource = 'projectWorld'; }
  else { value = input(defaultWorld, 'defaultWorld'); selectionSource = 'defaultWorld'; }
  let selected;
  if (selectionSource === 'worldPath' || looksLikePath(value, cwd)) {
    selected = inspectWorldArtifact(resolve(cwd, value), { sourceRoots });
  } else {
    const entries = listWorldArtifacts({ distRoot, sourceRoots });
    const candidates = entries.filter(entry => entry.id && entry.version &&
      (value === `${entry.id}:${entry.version}` || value === `${entry.id}.${entry.version}` || value === entry.id));
    if (!candidates.length) throw new Error(`Unknown world selector: ${value}. Use a manifest id:version or an artifact directory path.`);
    if (candidates.length > 1) throw new Error(`Ambiguous world selector: ${value}. Matches: ${candidates.map(entry => `${entry.id}:${entry.version} (${entry.artifactPath})`).join(', ')}. Use an exact version or artifact path.`);
    [selected] = candidates;
  }
  if (!selected.valid) {
    const error = new Error(`Invalid world artifact at ${selected.artifactPath ?? value}: ${selected.errors.join('; ')}`);
    // Read-only diagnostics need the selected path even when its files fail.
    error.artifact = selected;
    throw error;
  }
  const { valid, errors, ...selection } = selected;
  return { ...selection, selectionSource };
}
