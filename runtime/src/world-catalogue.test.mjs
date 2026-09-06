import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import test from 'node:test';
import { inspectWorldArtifact, listWorldArtifacts, resolveWorldSelection } from './world-catalogue.mjs';

const sha = data => createHash('sha256').update(data).digest('hex');
const canonical = value => value && typeof value === 'object' && !Array.isArray(value)
  ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  : Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : JSON.stringify(value);
const bytes = value => Buffer.from(`${canonical(value)}\n`);
const descriptor = body => ({ sha256: sha(body), size: body.length });
function put(path, body) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body);
}
function setup(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'world-catalogue-test-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, distRoot: join(root, 'dist'), sourceRoot: join(root, 'worlds') };
}
function fixture(env, { id = 'business.saas-company', version = 'v3', folder = 'unrelated-build-name', sourceFolder = 'renamed-authoring', sourceName = 'world.json', fragmentName = 'pieces/people.json', fragmented = false } = {}) {
  const world = { api_version: 'worldfixture.world-source/v1', id, version, title: 'Synthetic 🌍 source' };
  const sourcePath = join(env.sourceRoot, sourceFolder, sourceName);
  const artifactPath = join(env.distRoot, folder);
  const sourceFiles = {};
  let sourceSha;
  if (fragmented) {
    const sourceBytes = Buffer.from(JSON.stringify({ api_version: 'worldfixture.world-manifest/v1', world: { id, version }, fragments: [fragmentName] }, null, 4));
    const fragmentBytes = bytes({ api_version: 'worldfixture.world-fragment/v1', id: 'people', contributes: { identity: { people: [] } } });
    put(sourcePath, sourceBytes);
    put(join(sourcePath, '..', fragmentName), fragmentBytes);
    sourceFiles[sourceName] = descriptor(sourceBytes);
    sourceFiles[fragmentName] = descriptor(fragmentBytes);
    sourceSha = sha(bytes(sourceFiles));
  } else {
    const sourceBytes = Buffer.from(`${JSON.stringify(world, null, 2)}\n\n`);
    put(sourcePath, sourceBytes);
    sourceFiles[sourceName] = descriptor(sourceBytes);
    sourceSha = sha(sourceBytes);
  }
  const files = { 'world.json': bytes(world), 'packs/identity.json': bytes({ people: [] }) };
  const fileTable = Object.fromEntries(Object.entries(files).map(([name, body]) => [name, descriptor(body)]));
  const manifest = { api_version: 'worldfixture.world-artifact/v1', world_id: id, world_version: version,
    artifact_sha256: sha(bytes(fileTable)), files: fileTable, source_files: sourceFiles, source_sha256: sourceSha };
  for (const [name, body] of Object.entries(files)) put(join(artifactPath, name), body);
  put(join(artifactPath, 'manifest.json'), bytes(manifest));
  return { sourcePath, artifactPath, manifest, world };
}
function updateManifest(entry, change) {
  change(entry.manifest);
  put(join(entry.artifactPath, 'manifest.json'), bytes(entry.manifest));
}
function snapshot(root) {
  const out = {};
  function walk(path) {
    const stat = statSync(path);
    out[relative(root, path)] = { mtimeMs: stat.mtimeMs, size: stat.size, mode: stat.mode,
      ...(stat.isFile() ? { sha: sha(readFileSync(path)) } : {}) };
    if (stat.isDirectory()) for (const entry of readdirSync(path).sort()) walk(join(path, entry));
  }
  walk(root);
  return out;
}

test('catalogue and names use manifest identity in renamed artifact folders', t => {
  const env = setup(t);
  const entry = fixture(env);
  const options = { distRoot: env.distRoot, sourceRoots: [env.root] };
  const list = listWorldArtifacts(options);
  assert.equal(list.length, 1);
  assert.equal(list[0].valid, true);
  assert.equal(list[0].sourcePath, entry.sourcePath);
  for (const selector of ['business.saas-company:v3', 'business.saas-company.v3', 'business.saas-company']) {
    const selected = resolveWorldSelection({ ...options, selector });
    assert.equal(selected.artifactPath, entry.artifactPath);
    assert.equal(selected.selectionSource, 'selector');
    assert.deepEqual(selected.manifest, entry.manifest);
    assert.equal(selected.digest, entry.manifest.artifact_sha256);
  }
  assert.throws(() => resolveWorldSelection({ ...options, selector: 'unrelated-build-name' }), /Unknown world/);
});

test('selection precedence is explicit selector/path, project setting, then declared default', t => {
  const env = setup(t);
  const v3 = fixture(env);
  const v2 = fixture(env, { version: 'v2', folder: 'other', sourceFolder: 'other-source' });
  const options = { distRoot: env.distRoot, cwd: env.root };
  assert.equal(resolveWorldSelection(options).artifactPath, v3.artifactPath);
  assert.equal(resolveWorldSelection(options).selectionSource, 'defaultWorld');
  assert.equal(resolveWorldSelection({ ...options, projectWorld: 'business.saas-company:v2' }).artifactPath, v2.artifactPath);
  assert.equal(resolveWorldSelection({ ...options, projectWorld: 'business.saas-company:v2' }).selectionSource, 'projectWorld');
  assert.equal(resolveWorldSelection({ ...options, projectWorld: 'unknown', selector: 'business.saas-company:v2' }).artifactPath, v2.artifactPath);
  assert.equal(resolveWorldSelection({ ...options, projectWorld: 'unknown', worldPath: 'dist/other' }).selectionSource, 'worldPath');
  assert.equal(resolveWorldSelection({ ...options, projectWorld: 'dist/other' }).artifactPath, v2.artifactPath);
  assert.equal(resolveWorldSelection({ ...options, defaultWorld: 'business.saas-company:v2' }).artifactPath, v2.artifactPath);
});

test('ambiguous id and duplicate exact identities fail with all candidate paths', t => {
  const env = setup(t);
  fixture(env);
  fixture(env, { version: 'v2', folder: 'old', sourceFolder: 'old' });
  assert.throws(() => resolveWorldSelection({ distRoot: env.distRoot, selector: 'business.saas-company' }), /Ambiguous.*v2.*old.*v3/s);
  fixture(env, { folder: 'duplicate', sourceFolder: 'duplicate-source' });
  assert.throws(() => resolveWorldSelection({ distRoot: env.distRoot, selector: 'business.saas-company:v3' }), /Ambiguous.*duplicate.*unrelated-build-name/s);
});

test('reject conflicting, unknown and malformed selection input before writes', t => {
  const env = setup(t);
  fixture(env);
  const before = snapshot(env.root);
  for (const options of [
    { selector: 'x', worldPath: './x' }, { selector: '' }, { selector: true },
    { worldPath: '' }, { projectWorld: {} }, { defaultWorld: null }, { selector: 'unknown' },
  ]) assert.throws(() => resolveWorldSelection({ distRoot: env.distRoot, ...options }));
  assert.deepEqual(snapshot(env.root), before);
});

test('explicit and relative paths work without a catalogue and bypass broken unrelated manifests', t => {
  const env = setup(t);
  const entry = fixture(env);
  put(join(env.distRoot, 'broken', 'manifest.json'), '{');
  assert.equal(resolveWorldSelection({ worldPath: entry.artifactPath }).artifactPath, entry.artifactPath);
  assert.equal(resolveWorldSelection({ selector: './dist/unrelated-build-name', cwd: env.root }).artifactPath, entry.artifactPath);
  assert.equal(resolveWorldSelection({ selector: 'unrelated-build-name', cwd: env.distRoot }).artifactPath, entry.artifactPath);
  assert.equal(resolveWorldSelection({ selector: 'business.saas-company:v3', distRoot: env.distRoot }).artifactPath, entry.artifactPath);
  const invalid = listWorldArtifacts({ distRoot: env.distRoot }).find(item => !item.valid);
  assert.match(invalid.errors.join(' '), /invalid JSON/);
});

test('inspect never throws for missing or malformed artifact paths and manifests', t => {
  const env = setup(t);
  for (const path of [undefined, null, 5, '', join(env.root, 'missing')]) {
    const entry = inspectWorldArtifact(path);
    assert.equal(entry.valid, false);
    assert.ok(entry.errors.length);
  }
  for (const body of ['null', '[]', '{', '{}']) {
    put(join(env.distRoot, 'manifest.json'), body);
    assert.equal(inspectWorldArtifact(env.distRoot).valid, false);
  }
});

test('all declared file sizes and hashes are checked; damage does not hide verified source', t => {
  const env = setup(t);
  const entry = fixture(env);
  put(join(entry.artifactPath, 'packs/identity.json'), Buffer.from('changed'));
  const inspection = inspectWorldArtifact(entry.artifactPath, { sourceRoots: [env.sourceRoot] });
  assert.equal(inspection.valid, false);
  assert.equal(inspection.sourcePath, entry.sourcePath);
  assert.match(inspection.errors.join(' '), /packs\/identity.json: size mismatch/);
  assert.throws(() => resolveWorldSelection({ worldPath: entry.artifactPath }), /Invalid world artifact/);
  const data = readFileSync(join(entry.artifactPath, 'world.json'));
  data[0] = 32;
  put(join(entry.artifactPath, 'world.json'), data);
  assert.match(inspectWorldArtifact(entry.artifactPath).errors.join(' '), /world.json: SHA-256 mismatch/);
});

test('missing nested files retain the complete declared path in diagnostics', t => {
  const env = setup(t);
  const entry = fixture(env);
  rmSync(join(entry.artifactPath, 'packs'), { recursive: true });
  assert.match(inspectWorldArtifact(entry.artifactPath).errors.join(' '), /packs\/identity.json: ENOENT/);
});

test('aggregate digest, source digest, identity and required world file fail independently', t => {
  const env = setup(t);
  const entry = fixture(env);
  updateManifest(entry, manifest => { manifest.artifact_sha256 = '0'.repeat(64); manifest.source_sha256 = '1'.repeat(64); manifest.world_id = 'wrong'; });
  const inspected = inspectWorldArtifact(entry.artifactPath, { sourceRoots: [env.sourceRoot] });
  assert.equal(inspected.sourcePath, null);
  assert.match(inspected.errors.join(' '), /aggregate SHA-256 mismatch/);
  assert.match(inspected.errors.join(' '), /source_sha256 does not match/);
  assert.match(inspected.errors.join(' '), /identity does not match/);
  updateManifest(entry, manifest => { delete manifest.files['world.json']; manifest.artifact_sha256 = sha(bytes(manifest.files)); });
  assert.match(inspectWorldArtifact(entry.artifactPath).errors.join(' '), /does not include world.json/);
});

test('matching malformed world identities are invalid even with correct content hashes', t => {
  const env = setup(t);
  const entry = fixture(env, { id: 'Bad world/name', version: 'latest' });
  const inspection = inspectWorldArtifact(entry.artifactPath);
  assert.equal(inspection.valid, false);
  assert.match(inspection.errors.join(' '), /valid world_id/);
  assert.match(inspection.errors.join(' '), /valid world_version/);
});

test('original standalone source bytes are verified without normalization or edits', t => {
  const env = setup(t);
  const entry = fixture(env);
  const before = snapshot(env.root);
  const selected = resolveWorldSelection({ worldPath: entry.artifactPath, sourceRoots: [env.sourceRoot] });
  assert.equal(selected.sourcePath, entry.sourcePath);
  assert.equal(selected.manifest.source_sha256, sha(readFileSync(entry.sourcePath)));
  assert.deepEqual(snapshot(env.root), before);
  put(entry.sourcePath, bytes(entry.world));
  const changed = inspectWorldArtifact(entry.artifactPath, { sourceRoots: [env.sourceRoot] });
  assert.equal(changed.valid, true);
  assert.equal(changed.sourcePath, null, 'same data with different original bytes is not verified provenance');
});

test('fragmented source verifies every hash, size, declared fragment and aggregate source digest', t => {
  const env = setup(t);
  const entry = fixture(env, { fragmented: true });
  const options = { sourceRoots: [env.root] };
  assert.equal(inspectWorldArtifact(entry.artifactPath, options).sourcePath, entry.sourcePath);
  put(join(entry.sourcePath, '..', 'pieces/people.json'), '{}');
  assert.equal(inspectWorldArtifact(entry.artifactPath, options).sourcePath, null);
});

test('standalone root filenames come from provenance and support directory or direct file roots', t => {
  const env = setup(t);
  const entry = fixture(env, { sourceName: 'retail.json' });
  const before = snapshot(env.root);
  for (const sourceRoot of [env.root, env.sourceRoot, join(entry.sourcePath, '..'), entry.sourcePath]) {
    const inspected = inspectWorldArtifact(entry.artifactPath, { sourceRoots: [sourceRoot] });
    assert.equal(inspected.valid, true);
    assert.equal(inspected.sourcePath, entry.sourcePath);
    assert.deepEqual(inspected.manifest, entry.manifest);
  }
  assert.deepEqual(snapshot(env.root), before);
  put(entry.sourcePath, bytes(entry.world));
  assert.equal(inspectWorldArtifact(entry.artifactPath, { sourceRoots: [entry.sourcePath] }).sourcePath, null);
});

test('fragmented renamed roots verify original provenance and do not accept fragments as roots', t => {
  const env = setup(t);
  const entry = fixture(env, { sourceName: 'retail-manifest.json', fragmented: true, fragmentName: 'people.json' });
  for (const sourceRoot of [env.sourceRoot, join(entry.sourcePath, '..'), entry.sourcePath]) {
    assert.equal(inspectWorldArtifact(entry.artifactPath, { sourceRoots: [sourceRoot] }).sourcePath, entry.sourcePath);
  }
  const fragmentPath = join(entry.sourcePath, '..', 'people.json');
  assert.equal(inspectWorldArtifact(entry.artifactPath, { sourceRoots: [fragmentPath] }).sourcePath, null);
  put(fragmentPath, '{}');
  assert.equal(inspectWorldArtifact(entry.artifactPath, { sourceRoots: [entry.sourcePath] }).sourcePath, null);
});

test('a source named manifest.json does not stop searches for nested source candidates', t => {
  const env = setup(t);
  const entry = fixture(env, { sourceName: 'manifest.json', sourceFolder: 'nested/right', fragmented: true });
  put(join(env.sourceRoot, 'manifest.json'), bytes({ api_version: 'worldfixture.world-fragment/v1' }));
  assert.equal(inspectWorldArtifact(entry.artifactPath, { sourceRoots: [env.sourceRoot] }).sourcePath, entry.sourcePath);
});

test('same identity alone cannot establish provenance; all candidate source paths are tried', t => {
  const env = setup(t);
  const entry = fixture(env, { sourceFolder: 'z-right-source' });
  put(join(env.sourceRoot, 'a-wrong-source', 'world.json'), bytes(entry.world));
  assert.equal(inspectWorldArtifact(entry.artifactPath, { sourceRoots: [env.sourceRoot] }).sourcePath, entry.sourcePath);
  updateManifest(entry, manifest => { manifest.world_id = 'different'; });
  assert.equal(inspectWorldArtifact(entry.artifactPath, { sourceRoots: [env.sourceRoot] }).sourcePath, null);
});

test('fragment declaration cannot omit provenance files or cite unchecked extra files', t => {
  const env = setup(t);
  const entry = fixture(env, { fragmented: true });
  const source = JSON.parse(readFileSync(entry.sourcePath));
  source.fragments.push('pieces/extra.json');
  const body = bytes(source);
  put(entry.sourcePath, body);
  put(join(entry.sourcePath, '..', 'pieces/extra.json'), bytes({ api_version: 'worldfixture.world-fragment/v1', id: 'extra', contributes: { extra: true } }));
  updateManifest(entry, manifest => {
    manifest.source_files['world.json'] = descriptor(body);
    manifest.source_sha256 = sha(bytes(manifest.source_files));
  });
  assert.equal(inspectWorldArtifact(entry.artifactPath, { sourceRoots: [env.sourceRoot] }).sourcePath, null);
});

test('artifact traversal paths and symlinks cannot validate files outside the artifact', t => {
  const env = setup(t);
  const entry = fixture(env);
  const external = join(env.root, 'external.json');
  put(external, bytes({ external: true }));
  updateManifest(entry, manifest => { manifest.files['../../external.json'] = descriptor(readFileSync(external)); manifest.artifact_sha256 = sha(bytes(manifest.files)); });
  assert.match(inspectWorldArtifact(entry.artifactPath).errors.join(' '), /invalid relative path/);
  updateManifest(entry, manifest => {
    delete manifest.files['../../external.json'];
    manifest.files['linked.json'] = descriptor(readFileSync(external));
    manifest.artifact_sha256 = sha(bytes(manifest.files));
  });
  symlinkSync(external, join(entry.artifactPath, 'linked.json'));
  assert.match(inspectWorldArtifact(entry.artifactPath).errors.join(' '), /symlink leaves artifact/);
});

test('source symlinks outside the authoring tree do not supply verified provenance', t => {
  const env = setup(t);
  const entry = fixture(env, { fragmented: true });
  const fragment = join(entry.sourcePath, '..', 'pieces/people.json');
  const external = join(env.root, 'external-source.json');
  put(external, readFileSync(fragment));
  rmSync(fragment);
  symlinkSync(external, fragment);
  assert.equal(inspectWorldArtifact(entry.artifactPath, { sourceRoots: [env.sourceRoot] }).sourcePath, null);
});

test('list, resolve and inspect do not write to source, dist or current directory', t => {
  const env = setup(t);
  fixture(env, { fragmented: true });
  const before = snapshot(env.root);
  const options = { distRoot: env.distRoot, sourceRoots: [env.sourceRoot], cwd: env.root };
  const [entry] = listWorldArtifacts(options);
  inspectWorldArtifact(entry.artifactPath, options);
  resolveWorldSelection(options);
  assert.deepEqual(snapshot(env.root), before);
});
