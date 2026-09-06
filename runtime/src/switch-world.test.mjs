import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { executionPreflight } from './execution-preflight.mjs';
import { loadManifests } from './manifests.mjs';
import { canonical, resolveEnvironment } from './resolve.mjs';
import { validate } from './schema.mjs';
import { importSwitchArtifact, listSwitchWorlds, prepareSwitchWorld } from './switch-world.mjs';
import { inspectWorldArtifact } from './world-catalogue.mjs';
import { attachManagedSession } from './session-runtime.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const hash = value => createHash('sha256').update(value).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const manifests = loadManifests(join(ROOT, 'emulators'));
function temporary(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'worldfixture-switch-')));
  t.after(() => rmSync(root, { recursive: true, force: true })); return root;
}
function fixture(root, { name = 'starter', applicationEvent = false, rebase = false, oauth = false } = {}) {
  const source = join(root, `${name}-source`); mkdirSync(source);
  const header = json(join(ROOT, 'examples/minimal-world/world.json')).world;
  const data = json(join(ROOT, 'examples/minimal-world/fragments/core.json')).contributes;
  const world = { api_version: 'worldfixture.world-source/v1', ...header, ...data };
  if (rebase) world.clock.rebase = { relative_paths: [] };
  if (oauth) (world.software ??= {}).oauth_clients = { slack: [{ client_id: 'declared-app', name: 'Declared app', redirect_uris: ['http://localhost:8765/callback'] }] };
  if (applicationEvent) world.timeline = [{ id: 'arrival.app-review', after_seconds: 30, kind: 'application-event', payload: {
    kind: 'export.review.requested', actor: { worldfixture_ref: 'tomas-vidal' }, data: { review: 'export retry' },
  } }];
  const entry = join(source, 'custom-source.json'); save(entry, world);
  const distRoot = join(root, `${name}-dist`); mkdirSync(distRoot);
  const artifactPath = join(distRoot, 'renamed-artifact');
  execFileSync(process.env.PYTHON ?? 'python3', ['-m', 'worldfixture_compiler', 'build', entry, '--output', artifactPath], {
    cwd: ROOT, env: { ...process.env, PYTHONPATH: join(ROOT, 'compiler') }, stdio: 'pipe',
  });
  return { world, entry, source, artifactPath, distRoot, sourceRoots: [source], stateDir: join(root, 'state') };
}
function files(root) {
  if (!existsSync(root)) return {};
  const found = {};
  const walk = (dir, prefix = '') => { for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const name = `${prefix}${entry.name}`, path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, `${name}/`); else found[name] = readFileSync(path).toString('base64');
  } }; walk(root); return found;
}
function changeProjection(artifactPath, name, mutate) {
  const path = join(artifactPath, name), value = json(path); mutate(value); save(path, value);
  const manifest = json(join(artifactPath, 'manifest.json')), bytes = readFileSync(path);
  manifest.files[name] = { size: bytes.length, sha256: hash(bytes) };
  manifest.artifact_sha256 = hash(`${canonical(manifest.files)}\n`);
  save(join(artifactPath, 'manifest.json'), manifest);
}

test('import freezes only exact declared bytes and retains invalid catalogue diagnostics', t => {
  const setup = fixture(temporary(t));
  writeFileSync(join(setup.artifactPath, 'undeclared.txt'), 'not part of the artifact');
  const selected = inspectWorldArtifact(setup.artifactPath);
  const imported = importSwitchArtifact(setup.artifactPath, setup);
  assert.equal(imported.artifactPath, join(setup.stateDir, 'catalogue', selected.digest));
  assert.equal(imported.digest, selected.digest);
  assert.deepEqual(Object.keys(files(imported.artifactPath)).sort(), ['manifest.json', ...Object.keys(selected.manifest.files)].sort());
  for (const name of ['manifest.json', ...Object.keys(selected.manifest.files)]) assert.deepEqual(readFileSync(join(imported.artifactPath, name)), readFileSync(join(setup.artifactPath, name)));
  assert.equal(importSwitchArtifact(setup.artifactPath, setup).artifactPath, imported.artifactPath);
  mkdirSync(join(setup.stateDir, 'catalogue', 'broken-import'));
  const entries = listSwitchWorlds(setup);
  assert.equal(entries.filter(row => row.valid).length, 1, 'Identical shipped and imported artifacts are one choice');
  assert.equal(entries.filter(row => !row.valid).length, 1);
  assert.match(entries.find(row => !row.valid).errors.join(' '), /manifest|digest/);
  assert.ok(!readdirSync(join(setup.stateDir, 'catalogue')).some(name => name.startsWith('.import-')));
});

test('invalid or conflicting selection is read-only; an existing generation cannot change', t => {
  const setup = fixture(temporary(t));
  for (const input of [{}, { selector: 'demo.minimal:v1', worldPath: setup.artifactPath }, { selector: 'unknown' }, { selector: '' }]) {
    assert.throws(() => prepareSwitchWorld(input, { ...setup, generation: 'next' }));
    assert.equal(existsSync(setup.stateDir), false);
  }
  assert.throws(() => prepareSwitchWorld({ worldPath: setup.artifactPath }, { ...setup, generation: '../old' }), /generation/);
  const old = join(setup.stateDir, 'generations', 'old'); mkdirSync(old, { recursive: true }); writeFileSync(join(old, 'retained'), 'live state');
  const before = files(setup.stateDir);
  assert.throws(() => prepareSwitchWorld({ worldPath: setup.artifactPath }, { ...setup, generation: 'old' }), /EEXIST/);
  assert.deepEqual(files(setup.stateDir), before);
});

test('hash, size, path and identity errors cannot enter the imported catalogue', t => {
  const root = temporary(t);
  for (const defect of ['hash', 'size', 'path', 'identity']) {
    const setup = fixture(root, { name: defect });
    if (defect === 'hash') writeFileSync(join(setup.artifactPath, 'world.json'), readFileSync(join(setup.artifactPath, 'world.json')).toString().replace('Tiny', 'Fake'));
    else {
      const manifest = json(join(setup.artifactPath, 'manifest.json'));
      if (defect === 'size') manifest.files['world.json'].size++;
      if (defect === 'path') manifest.files['../outside'] = manifest.files['world.json'];
      if (defect === 'identity') manifest.world_id = 'other.world';
      save(join(setup.artifactPath, 'manifest.json'), manifest);
    }
    assert.throws(() => importSwitchArtifact(setup.artifactPath, setup), /Invalid world artifact/);
    assert.equal(existsSync(setup.stateDir), false);
  }
});

test('managed directory symlinks cannot write outside session state', t => {
  const root = temporary(t), setup = fixture(root), outside = join(root, 'outside'); mkdirSync(outside); mkdirSync(setup.stateDir);
  symlinkSync(outside, join(setup.stateDir, 'catalogue'), 'dir');
  assert.throws(() => importSwitchArtifact(setup.artifactPath, setup), /symlink/);
  symlinkSync(outside, join(setup.stateDir, 'generations'), 'dir');
  assert.throws(() => prepareSwitchWorld({ worldPath: setup.artifactPath }, { ...setup, generation: 'new' }), /symlink/);
  assert.deepEqual(files(outside), {});
});

test('candidate source and original digest stay fixed while rebased dates have a separate digest', t => {
  const setup = fixture(temporary(t), { rebase: true }), before = files(setup.artifactPath);
  const candidate = prepareSwitchWorld({ selector: 'demo.minimal:v1' }, { ...setup, generation: 'new', environmentOptions: { only: ['slack'] } });
  const record = json(join(setup.stateDir, 'generations/new/selection.json'));
  assert.equal(record.session.rebased, true, record.session.reason);
  assert.equal(candidate.selection.digest, inspectWorldArtifact(setup.artifactPath).digest);
  assert.notEqual(candidate.lock.world.artifact_sha256, candidate.selection.digest);
  assert.equal(candidate.artifactPath, join(setup.stateDir, 'generations/new/world'));
  assert.equal(candidate.stateDir, join(setup.stateDir, 'generations/new/runtime'));
  assert.equal(inspectWorldArtifact(candidate.artifactPath).valid, true);
  assert.deepEqual(readFileSync(record.sourcePath), readFileSync(setup.entry));
  assert.deepEqual(files(setup.artifactPath), before);
  assert.equal(candidate.spec.target.identity, 'ines-salgado');
});

test('authored dates and missing source fallback preserve artifact bytes', t => {
  const setup = fixture(temporary(t));
  for (const [generation, noRebase, sourceRoots] of [['authored', true, setup.sourceRoots], ['unavailable', false, []]]) {
    const candidate = prepareSwitchWorld({ worldPath: setup.artifactPath, noRebase }, { ...setup, sourceRoots, generation, environmentOptions: { only: ['slack'] } });
    assert.deepEqual(files(candidate.artifactPath), files(setup.artifactPath));
    assert.equal(candidate.lock.world.artifact_sha256, candidate.selection.digest);
    const record = json(join(setup.stateDir, 'generations', generation, 'selection.json'));
    assert.equal(record.session.rebased, false);
    assert.match(record.session.reason, noRebase ? /authored dates/ : /no world source verified/);
  }
});

test('candidate failure removes only its new generation and preserves active state', t => {
  const setup = fixture(temporary(t));
  mkdirSync(join(setup.stateDir, 'generations/active/runtime'), { recursive: true });
  writeFileSync(join(setup.stateDir, 'generations/active/runtime/db'), 'old application data');
  writeFileSync(join(setup.stateDir, 'active-generation.json'), 'active');
  const before = files(setup.stateDir);
  assert.throws(() => prepareSwitchWorld({ worldPath: setup.artifactPath, noRebase: true }, { ...setup, generation: 'rejected', environmentOptions: { only: ['unknown'] } }), /unknown world part/);
  assert.deepEqual(files(setup.stateDir), before);
  assert.equal(existsSync(join(setup.stateDir, 'generations/rejected')), false);
});

test('switch setup preserves application database services but never the old connector or actor', t => {
  const setup = fixture(temporary(t), { applicationEvent: true });
  const candidate = prepareSwitchWorld({ worldPath: setup.artifactPath, noRebase: true }, { ...setup, generation: 'new', environmentOptions: {
    only: ['slack'], includePostgres: true, includeMySQL: true,
    identity: 'foreign-person', target: { application_url: 'http://old.example', identity: 'foreign-person' }, application_url: 'http://old.example',
  } });
  assert.ok(candidate.lock.services.some(service => service.name === 'postgres'));
  assert.ok(candidate.lock.services.some(service => service.name === 'mysql'));
  assert.equal(candidate.spec.target.application_url, undefined);
  assert.equal(candidate.lock.target.identity, 'ines-salgado');
  assert.deepEqual(candidate.lock.execution.application_connection.arrival_ids, ['arrival.app-review']);
  assert.equal(candidate.lock.execution.application_connection.status, 'pending');
  assert.deepEqual(validate(candidate.lock, json(join(ROOT, 'schemas/environment-lock.v1.schema.json'))), []);
  assert.throws(() => resolveEnvironment(candidate.spec, { manifests, artifactPath: candidate.artifactPath }), /requires a configured HTTP application connector/);
  assert.equal(resolveEnvironment(candidate.spec, { manifests, artifactPath: candidate.artifactPath, deferApplicationConnection: true }).execution.application_connection.required, true);
});

test('deferred preflight keeps all content/reference validation and rejects malformed targets', t => {
  const { world } = fixture(temporary(t), { applicationEvent: true });
  assert.ok(executionPreflight(world, { capabilities: [] }).errors.length);
  const deferred = executionPreflight(world, { capabilities: [], deferApplicationConnection: true });
  assert.deepEqual(deferred.errors, []); assert.deepEqual(deferred.timeline.active, ['arrival.app-review']);
  const bad = structuredClone(world); bad.timeline[0].payload.actor.worldfixture_ref = 'foreign';
  assert.match(executionPreflight(bad, { capabilities: [], deferApplicationConnection: true }).errors.join(' '), /declared person/);
  for (const applicationTarget of ['ftp://bad.example', '', null]) assert.ok(executionPreflight(world, { capabilities: [], deferApplicationConnection: true, applicationTarget }).errors.length);
  assert.ok(executionPreflight(world, { capabilities: [], deferApplicationConnection: 'yes' }).errors.length);
  assert.equal(executionPreflight(world, { capabilities: [], applicationTarget: 'http://confirmed.example' }).applicationConnection, undefined);
});

test('missing mailbox credential references fail during preparation before old state changes', t => {
  const setup = fixture(temporary(t));
  changeProjection(setup.artifactPath, 'projections/mail.json', value => { delete value.users.find(row => row.id === 'ines-salgado').password_ref; });
  assert.equal(inspectWorldArtifact(setup.artifactPath).valid, true);
  mkdirSync(setup.stateDir); writeFileSync(join(setup.stateDir, 'old'), 'retained');
  assert.throws(() => prepareSwitchWorld({ worldPath: setup.artifactPath, noRebase: true }, { ...setup, generation: 'bad', environmentOptions: { only: ['mail'] } }), /mailbox password/);
  assert.equal(readFileSync(join(setup.stateDir, 'old'), 'utf8'), 'retained');
  assert.equal(existsSync(join(setup.stateDir, 'generations/bad')), false);
});

test('a missing personal token cannot enter a switch through another person shared alias', t => {
  const setup = fixture(temporary(t));
  const primary = setup.world.people.find(person => person.primary);
  changeProjection(setup.artifactPath, 'projections/emulator-overlay.json', value => {
    delete value.tokens[`slack_token_${primary.id}`];
    value.tokens.slack_token = { ...value.tokens.slack_token, login: 'different-person' };
  });
  assert.equal(inspectWorldArtifact(setup.artifactPath).valid, true);
  mkdirSync(setup.stateDir); writeFileSync(join(setup.stateDir, 'old'), 'retained');
  for (const only of [undefined, ['slack']]) {
    assert.throws(() => prepareSwitchWorld({ worldPath: setup.artifactPath, noRebase: true }, {
      ...setup, generation: 'bad', environmentOptions: { only },
    }), /SLACK_TOKEN requires a declared slack.*credential for person/);
    assert.equal(readFileSync(join(setup.stateDir, 'old'), 'utf8'), 'retained');
    assert.equal(existsSync(join(setup.stateDir, 'generations/bad')), false);
  }
});

test('a damaged import is diagnosed and cannot be silently overwritten', t => {
  const setup = fixture(temporary(t));
  const imported = importSwitchArtifact(setup.artifactPath, setup);
  const path = join(imported.artifactPath, 'world.json'); chmodSync(path, 0o600); writeFileSync(path, 'damaged input');
  const before = files(imported.artifactPath);
  assert.throws(() => importSwitchArtifact(setup.artifactPath, setup), /Invalid world artifact/);
  assert.deepEqual(files(imported.artifactPath), before);
  assert.equal(listSwitchWorlds(setup).find(row => row.artifactPath === imported.artifactPath).valid, false);
});

test('imported names work without the original artifact; distinct digests need an exact path', t => {
  const root = temporary(t), setup = fixture(root);
  const imported = importSwitchArtifact(setup.artifactPath, setup);
  rmSync(setup.artifactPath, { recursive: true });
  const candidate = prepareSwitchWorld({ selector: 'demo.minimal:v1', noRebase: true }, { ...setup, generation: 'imported', environmentOptions: { only: ['slack'] } });
  assert.equal(candidate.selection.artifactPath, imported.artifactPath);
  const different = fixture(root, { name: 'different', applicationEvent: true });
  importSwitchArtifact(different.artifactPath, setup);
  const before = files(setup.stateDir);
  assert.throws(() => prepareSwitchWorld({ selector: 'demo.minimal:v1' }, { ...setup, generation: 'ambiguous' }), /Ambiguous/);
  assert.deepEqual(files(setup.stateDir), before);
});

test('application-origin rules retain explicit pending dependency and all rule validation', t => {
  const { world } = fixture(temporary(t));
  const rule = { api_version: 'worldfixture.causal-rule/v1', id: 'rule.review-mail', when: 'application.event.delivered.v1', emit: [{
    type: 'mail.notification.requested.v1', with: { recipients: { value: ['ines-salgado'] }, text: { value: 'Review accepted' } },
  }] };
  const options = { capabilities: ['mail.smtp-submission.v1', 'slack.messaging.v1'], rules: [rule] };
  assert.match(executionPreflight(world, options).errors.join(' '), /configured connector/);
  const pending = executionPreflight(world, { ...options, deferApplicationConnection: true });
  assert.deepEqual(pending.errors, []);
  assert.deepEqual(pending.applicationConnection.rule_ids, [rule.id]);
  assert.deepEqual(pending.applicationConnection.arrival_ids, []);
  const unselected = executionPreflight(world, { ...options, capabilities: ['slack.messaging.v1'], allowUnselected: true, deferApplicationConnection: true });
  assert.deepEqual(unselected.errors, []);
  assert.equal(unselected.applicationConnection, undefined, 'Excluded rules do not invent a required application dependency');
  const malformed = { ...rule, emit: [{ type: 'unsupported.operation', with: {} }] };
  assert.match(executionPreflight(world, { ...options, rules: [malformed], deferApplicationConnection: true }).errors.join(' '), /unsupported/);
});

test('an interrupted import copy removes its staging directory and leaves prior imports intact', t => {
  const setup = fixture(temporary(t));
  const imported = importSwitchArtifact(setup.artifactPath, setup), before = files(imported.artifactPath);
  const manifest = json(join(setup.artifactPath, 'manifest.json'));
  manifest.files['./world.json'] = manifest.files['world.json'];
  manifest.artifact_sha256 = hash(`${canonical(manifest.files)}\n`);
  save(join(setup.artifactPath, 'manifest.json'), manifest);
  // The P1 inspector accepts relative aliases, but exclusive-copy semantics
  // refuse two manifest entries that address the same candidate file.
  assert.equal(inspectWorldArtifact(setup.artifactPath).valid, true);
  assert.throws(() => importSwitchArtifact(setup.artifactPath, setup), /EEXIST/);
  assert.deepEqual(files(imported.artifactPath), before);
  assert.deepEqual(readdirSync(join(setup.stateDir, 'catalogue')), [imported.digest]);
});

test('selected OAuth credentials must name a native client reference before the candidate can activate', t => {
  const setup = fixture(temporary(t), { oauth: true });
  const options = { ...setup, environmentOptions: { only: ['slack'] } };
  const candidate = prepareSwitchWorld({ worldPath: setup.artifactPath, noRebase: true }, { ...options, generation: 'valid' });
  assert.equal(candidate.lock.bindings.SLACK_CLIENT_SECRET.from, 'projection.credential');
  const before = files(setup.stateDir);
  changeProjection(setup.artifactPath, 'projections/emulator-overlay.json', value => { value.slack.worldfixture_oauth_client.client_secret_ref = 'foreign-reference'; });
  assert.throws(() => prepareSwitchWorld({ worldPath: setup.artifactPath, noRebase: true }, { ...options, generation: 'rejected' }), /native client credential reference/);
  assert.deepEqual(files(setup.stateDir), before);
});

test('the catalogue keeps initial custom and active rebased artifacts available for an exact return', t => {
  const root = temporary(t), setup = fixture(root, { rebase: true });
  const initial = inspectWorldArtifact(setup.artifactPath);
  const candidate = prepareSwitchWorld({ worldPath: setup.artifactPath }, { ...setup, generation: 'rebased', environmentOptions: { only: ['slack'] } });
  const emptyDist = join(root, 'empty-dist'); mkdirSync(emptyDist);
  save(join(setup.stateDir, 'session-catalogue.json'), { api_version: 'worldfixture.session-catalogue/v1', initial: [{ artifactPath: setup.artifactPath, world: { id: initial.id, version: initial.version, artifact_sha256: initial.digest } }] });
  save(join(setup.stateDir, 'active-generation.json'), { api_version: 'worldfixture.active-generation/v1', generation: 'rebased', artifactPath: candidate.artifactPath, stateDir: candidate.stateDir, world: candidate.lock.world, phase: 'ready' });
  const options = { ...setup, distRoot: emptyDist };
  const before = files(setup.stateDir), entries = listSwitchWorlds(options);
  assert.equal(entries.length, 2); assert.ok(entries.every(row => row.valid));
  assert.deepEqual(new Set(entries.map(row => row.digest)), new Set([initial.digest, candidate.lock.world.artifact_sha256]));
  assert.equal(new Set(entries.map(row => `${row.id}:${row.version}`)).size, 1, 'Different rebased digests retain separate choices');
  assert.deepEqual(files(setup.stateDir), before, 'Catalogue reads do not change session files');
  const returned = prepareSwitchWorld({ worldPath: entries.find(row => row.digest === initial.digest).artifactPath, noRebase: true }, { ...options, generation: 'return-initial', environmentOptions: { only: ['slack'] } });
  assert.equal(returned.lock.world.artifact_sha256, initial.digest);
  assert.deepEqual(files(returned.artifactPath), files(setup.artifactPath), 'Return uses every original artifact byte');
});

test('catalogue verifies session references rather than trusting accepted digest claims', t => {
  const root = temporary(t), setup = fixture(root), initial = inspectWorldArtifact(setup.artifactPath);
  mkdirSync(setup.stateDir);
  const reference = { artifactPath: setup.artifactPath, world: { id: initial.id, version: initial.version, artifact_sha256: '0'.repeat(64) } };
  save(join(setup.stateDir, 'session-catalogue.json'), { api_version: 'worldfixture.session-catalogue/v1', initial: [reference] });
  const entries = listSwitchWorlds(setup);
  assert.equal(entries.filter(row => row.valid).length, 1);
  assert.ok(entries.some(row => !row.valid && row.errors.some(error => /accepted record/.test(error))), 'A valid shipped duplicate cannot hide an invalid session reference');
  writeFileSync(join(setup.stateDir, 'active-generation.json'), '{broken');
  assert.ok(listSwitchWorlds(setup).some(row => !row.valid && row.errors.some(error => /active-generation.json/.test(error))));
});

test('host catalogue resolves accepted container state paths through the shared state mount', t => {
  const root = temporary(t), setup = fixture(root), imported = importSwitchArtifact(setup.artifactPath, setup);
  save(join(setup.stateDir, 'instance.json'), { name: 'test-host-instance' });
  save(join(setup.stateDir, 'session-catalogue.json'), { api_version: 'worldfixture.session-catalogue/v1', initial: [{ artifactPath: `/state/catalogue/${imported.digest}`, world: { id: imported.id, version: imported.version, artifact_sha256: imported.digest } }] });
  const before = files(setup.stateDir), entries = listSwitchWorlds(setup);
  assert.equal(entries.length, 1); assert.equal(entries[0].valid, true);
  assert.equal(entries[0].digest, imported.digest); assert.deepEqual(files(setup.stateDir), before);
});


test('managed session persists initial artifact references for both CLI and Workbench catalogue readers', t => {
  const root = temporary(t), setup = fixture(root), initial = inspectWorldArtifact(setup.artifactPath);
  const instance = { artifactPath: setup.artifactPath, stateDir: setup.stateDir,
    lock: { world: { id: initial.id, version: initial.version, artifact_sha256: initial.digest } } };
  const manager = attachManagedSession(instance, { sessionRoot: setup.stateDir, packageRoot: root,
    serviceRoot: join(ROOT, 'emulators'), initialSelection: initial, workbench: { url: 'http://workbench.test', notify() {} }, activateTimeline: async () => {} });
  const persisted = json(join(setup.stateDir, 'session-catalogue.json'));
  assert.equal(persisted.api_version, 'worldfixture.session-catalogue/v1');
  assert.ok(persisted.initial.some(row => row.artifactPath === setup.artifactPath && row.world.artifact_sha256 === initial.digest));
  const ui = manager.catalogue(), cli = listSwitchWorlds({ stateDir: setup.stateDir, distRoot: join(root, 'dist'), sourceRoots: [join(root, 'worlds')] });
  assert.deepEqual(ui, cli); assert.equal(ui.length, 1); assert.equal(ui[0].digest, initial.digest); assert.equal(ui[0].valid, true);
});
