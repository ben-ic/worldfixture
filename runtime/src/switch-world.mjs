import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shareHostOwnership } from './host-state-ownership.mjs';
import { defaultEnvironment } from './environments.mjs';
import { loadManifests } from './manifests.mjs';
import { resolveEnvironment, serializeLock } from './resolve.mjs';
import { rebaseForSession } from './session-world.mjs';
import { sessionPath } from './session-files.mjs';
import { inspectWorldArtifact, listWorldArtifacts } from './world-catalogue.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_SOURCES = [join(ROOT, 'worlds')];
const HASH = /^[a-f0-9]{64}$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, value) => {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  shareHostOwnership(path);
};

function checked(path, sourceRoots = []) {
  const entry = inspectWorldArtifact(path, { sourceRoots });
  if (!entry.valid) throw new Error(`Invalid world artifact at ${entry.artifactPath}: ${entry.errors.join('; ')}`);
  return entry;
}
function below(root, path) {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function managedDirectory(path) {
  if (existsSync(path)) {
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Managed directory must not be a symlink or file: ${path}`);
  } else mkdirSync(path, { mode: 0o700 });
  shareHostOwnership(path);
  return path;
}
function stateRoot(stateDir) {
  if (typeof stateDir !== 'string' || !stateDir.trim()) throw new Error('stateDir is required');
  mkdirSync(resolve(stateDir), { recursive: true, mode: 0o700 });
  return realpathSync(resolve(stateDir));
}
function copyFiles(sourceRoot, targetRoot, table) {
  const actualRoot = realpathSync(sourceRoot);
  mkdirSync(targetRoot, { mode: 0o700 });
  shareHostOwnership(targetRoot);
  for (const [name, expected] of Object.entries(table)) {
    const actual = realpathSync(join(actualRoot, name));
    if (!below(actualRoot, actual)) throw new Error(`Source file leaves its verified directory: ${name}`);
    const bytes = readFileSync(actual);
    if (hash(bytes) !== expected.sha256 || bytes.length !== expected.size) throw new Error(`Source bytes changed after selection: ${name}`);
    const target = join(targetRoot, name);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, bytes, { flag: 'wx', mode: 0o444 });
    shareHostOwnership(target);
  }
}
function copyArtifact(entry, target) {
  const manifestBytes = readFileSync(join(entry.artifactPath, 'manifest.json'));
  // The table and identity selected earlier must still be the same document.
  if (JSON.stringify(JSON.parse(manifestBytes)) !== JSON.stringify(entry.manifest)) throw new Error('Artifact manifest changed after selection');
  copyFiles(entry.artifactPath, target, entry.manifest.files);
  writeFileSync(join(target, 'manifest.json'), manifestBytes, { flag: 'wx', mode: 0o444 });
  shareHostOwnership(join(target, 'manifest.json'));
  const copied = checked(target);
  if (copied.digest !== entry.digest) throw new Error('Copied artifact digest differs from selection');
  return copied;
}

/** Read-only catalogue. Broken imported and session entries remain diagnostics. */
export function listSwitchWorlds({ distRoot = join(ROOT, 'dist'), sourceRoots = DEFAULT_SOURCES, stateDir } = {}) {
  const entries = listWorldArtifacts({ distRoot, sourceRoots });
  if (stateDir) {
    const catalogue = join(resolve(stateDir), 'catalogue');
    if (existsSync(catalogue)) {
      if (lstatSync(catalogue).isSymbolicLink() || !lstatSync(catalogue).isDirectory()) throw new Error('Imported catalogue must be a real directory');
      for (const name of readdirSync(catalogue).sort()) {
        if (name.startsWith('.import-')) continue;
        const path = join(catalogue, name), entry = inspectWorldArtifact(path, { sourceRoots });
        if (!HASH.test(name) || entry.digest !== name) entry.errors.push('Imported catalogue directory does not match its artifact digest');
        if (lstatSync(path).isSymbolicLink()) entry.errors.push('Imported catalogue entry must not be a symlink');
        entry.valid = entry.errors.length === 0;
        entries.push(entry);
      }
    }
    const inspectReference = reference => {
      if (!reference || typeof reference.artifactPath !== 'string' || !reference.artifactPath) throw new Error('Session catalogue reference has no artifact path');
      const entry = inspectWorldArtifact(sessionPath(stateDir, reference.artifactPath), { sourceRoots });
      const expected = reference.world;
      if (!expected || entry.id !== expected.id || entry.version !== expected.version || entry.digest !== expected.artifact_sha256) entry.errors.push('Session artifact identity differs from its accepted record');
      entry.valid = entry.errors.length === 0; entries.push(entry);
    };
    for (const [file, version] of [['session-catalogue.json', 'worldfixture.session-catalogue/v1'], ['active-generation.json', 'worldfixture.active-generation/v1']]) {
      const path = join(resolve(stateDir), file);
      if (!existsSync(path)) continue;
      try {
        const record = json(path);
        if (record.api_version !== version) throw new Error(`Unsupported ${file} version`);
        if (file === 'session-catalogue.json') {
          if (!Array.isArray(record.initial) || !record.initial.length) throw new Error('Session catalogue has no initial artifact references');
          for (const reference of record.initial) inspectReference(reference);
        } else inspectReference(record);
      } catch (error) {
        const entry = inspectWorldArtifact(path, { sourceRoots });
        entry.errors.push(`${file}: ${error.message}`); entry.valid = false; entries.push(entry);
      }
    }
  }
  // Identical verified bytes can have shipped, imported and active paths. Keep
  // one choice, but never hide a broken path behind a valid duplicate.
  const seen = new Set();
  return entries.filter(entry => {
    if (!entry.valid) return true;
    const identity = JSON.stringify([entry.id, entry.version, entry.digest]);
    if (seen.has(identity)) return false;
    seen.add(identity); return true;
  });
}

/** Import only verified declared bytes; never overwrite an existing import. */
export function importSwitchArtifact(path, { stateDir } = {}) {
  const selected = checked(path);
  const catalogue = managedDirectory(join(stateRoot(stateDir), 'catalogue'));
  const destination = join(catalogue, selected.digest);
  if (existsSync(destination)) {
    if (lstatSync(destination).isSymbolicLink()) throw new Error('Imported catalogue entry must not be a symlink');
    const existing = checked(destination);
    if (existing.digest !== selected.digest || !readFileSync(join(destination, 'manifest.json')).equals(readFileSync(join(selected.artifactPath, 'manifest.json')))) throw new Error('Existing import has different manifest bytes');
    return existing;
  }
  const temporary = mkdtempSync(join(catalogue, '.import-'));
  try {
    const candidate = join(temporary, 'world');
    copyArtifact(selected, candidate);
    // A concurrent import cannot replace a nonempty immutable directory.
    renameSync(candidate, destination);
    return checked(destination);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

function select(input, options) {
  const fields = ['selector', 'worldPath'].filter(key => input[key] !== undefined && input[key] !== null);
  if (fields.length !== 1) throw new Error('Switch requires exactly one explicit selector or worldPath');
  if (input.noRebase !== undefined && typeof input.noRebase !== 'boolean') throw new Error('noRebase must be a boolean');
  const key = fields[0], value = input[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} must be a nonempty string`);
  let entry;
  if (key === 'worldPath' || isAbsolute(value) || value.startsWith('.') || value.includes('/') || value.includes('\\') || existsSync(resolve(value))) {
    entry = checked(resolve(value), options.sourceRoots);
  } else {
    const candidates = listSwitchWorlds(options).filter(row => row.id && row.version && [row.id, `${row.id}:${row.version}`, `${row.id}.${row.version}`].includes(value));
    if (!candidates.length) throw new Error(`Unknown world selector: ${value}`);
    const identities = new Set(candidates.map(row => `${row.id}:${row.version}:${row.digest}`));
    if (identities.size > 1) throw new Error(`Ambiguous world selector: ${value}; use an exact artifact path`);
    entry = candidates.find(row => row.valid) ?? candidates[0];
    if (!entry.valid) throw new Error(`Invalid world artifact: ${entry.errors.join('; ')}`);
  }
  const { valid, errors, ...selection } = entry;
  return { ...selection, selectionSource: key };
}

/** Prepare a separate generation completely before the active run is touched. */
export function prepareSwitchWorld(input = {}, {
  generation, stateDir, distRoot = join(ROOT, 'dist'), sourceRoots = DEFAULT_SOURCES,
  serviceRoot = join(ROOT, 'emulators'), environmentOptions = {},
} = {}) {
  if (typeof generation !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(generation)) throw new Error('generation must be a safe nonempty directory name');
  const selection = select(input, { distRoot, sourceRoots, stateDir });
  const generations = managedDirectory(join(stateRoot(stateDir), 'generations'));
  const directory = join(generations, generation);
  mkdirSync(directory, { mode: 0o700 }); // Existing generations are never reused.
  try {
    const inputs = managedDirectory(join(directory, 'input'));
    const original = copyArtifact(selection, join(inputs, 'world'));
    let frozenSource;
    if (selection.sourcePath) {
      const sourceDir = join(inputs, 'source');
      copyFiles(dirname(selection.sourcePath), sourceDir, selection.manifest.source_files);
      frozenSource = checked(original.artifactPath, [sourceDir]).sourcePath;
      if (!frozenSource) throw new Error('Copied source provenance no longer verifies');
    }
    const session = input.noRebase ? { rebased: false, reason: 'Requested authored dates' }
      : rebaseForSession(original.artifactPath, directory, { quiet: true, sourceRoots: frozenSource ? [dirname(frozenSource)] : [] });
    const artifactPath = join(directory, 'world');
    if (!session.rebased) copyArtifact(original, artifactPath);
    const artifact = checked(artifactPath), world = json(join(artifactPath, 'world.json'));
    const manifests = loadManifests(serviceRoot);
    const { includeS3, includeProviders, includePostgres, includeMySQL, only, environmentSpec } = environmentOptions;
    const spec = defaultEnvironment(`${world.id}:${world.version}`, {
      includeS3, includeProviders, includePostgres, includeMySQL, only, environmentSpec,
      artifactPath, manifests, identity: world.people?.find(person => person.primary)?.id,
      oauthClients: world.software?.oauth_clients,
    });
    const lock = resolveEnvironment(spec, { manifests, artifactPath, deferApplicationConnection: true });
    const runtimeDir = managedDirectory(join(directory, 'runtime'));
    save(join(directory, 'selection.json'), { api_version: 'worldfixture.switch-selection/v1', generation,
      requested: input, selection, sourcePath: frozenSource ?? null,
      session: { artifactPath, digest: artifact.digest, rebased: session.rebased, reason: session.reason ?? null } });
    save(join(directory, 'environment.json'), spec);
    writeFileSync(join(directory, 'environment-lock.json'), serializeLock(lock), { flag: 'wx', mode: 0o600 });
    shareHostOwnership(join(directory, 'environment-lock.json'));
    return { lock, artifactPath, world, selection, spec, stateDir: runtimeDir };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
