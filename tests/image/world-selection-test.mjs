#!/usr/bin/env node
// Real CLI selection verification. No services start unless --run is supplied.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

import { SELECTION_PATHS, snapshot } from './coupling-selection-snapshot.mjs';

const { values } = parseArgs({ options: {
  repo: { type: 'string', default: resolve(dirname(fileURLToPath(import.meta.url)), '../..') },
  image: { type: 'string', default: process.env.WORLDFIXTURE_IMAGE ?? 'worldfixture:local' },
  'timeout-ms': { type: 'string', default: '120000' },
  filter: { type: 'string', default: '' },
  report: { type: 'string' },
  run: { type: 'boolean', default: false },
} });
const repo = resolve(values.repo), image = values.image, filter = values.filter;
const timeout = Number(values['timeout-ms']);
assert.ok(Number.isSafeInteger(timeout) && timeout > 0, '--timeout-ms must be a positive integer');
const execute = promisify(execFile);
const docker = args => execute('docker', args, { timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pause = ms => new Promise(done => setTimeout(done, ms));
const { listWorldArtifacts, inspectWorldArtifact, resolveWorldSelection } = await import(pathToFileURL(join(repo, 'runtime/src/world-catalogue.mjs')));
const { stopHostInstance, hostContainerName } = await import(pathToFileURL(join(repo, 'runtime/src/host-launcher.mjs')));
const { removeOwnedContainer, redact, credentialValues } = await import(pathToFileURL(join(repo, 'tests/image/coupling-runner.mjs')));
const { snapshotArtifact } = await import(pathToFileURL(join(repo, 'tests/image/coupling-artifacts.mjs')));
const worlds = listWorldArtifacts({ distRoot: join(repo, 'dist'), sourceRoots: [repo] });
assert.ok(worlds.length >= 2, 'Selection and cross-world refusal checks require at least two catalogue entries');
for (const world of worlds) assert.ok(world.valid && world.sourcePath, `${world.id}:${world.version} must have verified artifact and source bytes`);
const defaultWorld = resolveWorldSelection({ distRoot: join(repo, 'dist'), sourceRoots: [repo] });
const partFor = world => world.manifest.files['projections/http-targets.json'] ? 'site' : 'domain';
const serviceFor = world => partFor(world) === 'site' ? 'http-targets' : 'domain';
const entrypointWorld = worlds.find(world => world.id !== defaultWorld.id) ?? worlds.find(world => world.version !== defaultWorld.version);
const cases = worlds.flatMap(world => ['direct', 'host'].flatMap(mode => ['named', 'path'].flatMap(selection =>
  [false, true].map(noRebase => ({ world, mode, selection, noRebase,
    label: `${world.id}.${world.version}/${mode}/${selection}/${noRebase ? 'no-rebase' : 'rebase'}` }))))).filter(row => row.label.includes(filter));
if (!values.run) {
  console.log(JSON.stringify({ action: 'plan-only', image, report: values.report ? resolve(values.report) : 'temporary directory', cases: cases.map(row => row.label),
    extra: [`raw Docker ENTRYPOINT ${entrypointWorld.id}:${entrypointWorld.version} named selection`],
    negative: ['invalid name', 'missing path', 'conflicting selectors', 'host mismatch without selection/project writes'],
    command: `node ${process.argv[1]} --repo ${repo} --image ${image} --run` }, null, 2));
  process.exit(0);
}
assert.ok(cases.length, 'The filter selected no cases');
// Inspect the new image before any service starts. A cached P0 image is not P1.
const imageInfo = JSON.parse((await docker(['image', 'inspect', image])).stdout)[0];
assert.ok(!(imageInfo.Config.Entrypoint ?? []).includes('--world-path'), 'Rebuild the P1 image: its entrypoint still forces the old default artifact');
const imageId = imageInfo.Id;
assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
// macOS limits Unix socket paths; leave space for case/state/control.sock.
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'wf-p1-')));
const reportDir = values.report ? resolve(values.report) : scratch;
if (values.report) {
  mkdirSync(reportDir, { recursive: true, mode: 0o700 });
  assert.deepEqual(readdirSync(reportDir), [], '--report must be a new or empty directory to preserve earlier evidence');
}
const owner = hash(scratch).slice(0, 24);
const abort = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => abort.abort(new Error(`Selection check interrupted by ${signal}`)));
const report = { api_version: 'worldfixture.p1-selection-check/v1', started_at: new Date().toISOString(), repo,
  image, image_id: imageInfo.Id, scratch, scope: 'World selection, source identity, session digest, finance schedule dates and identities, and real HTTP target content', inputs: [], checks: [] };
const reportPath = join(reportDir, 'report.json');
const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
const bin = join(repo, 'runtime/bin/worldfixture.mjs');
const environment = { ...process.env, WORLDFIXTURE_IMAGE: imageId };
delete environment.WORLDFIXTURE_SINGLE_CONTAINER;
delete environment.WORLDFIXTURE_TOKEN;
delete environment.WORLDFIXTURE_PROJECT_CONFIG;
delete environment.WORLDFIXTURE_GENERATED_SECRETS_PATH;
const knownSecrets = new Set();

function retainInputs() {
  const inputDir = join(reportDir, 'inputs'); mkdirSync(inputDir, { mode: 0o700 });
  for (const world of worlds) {
    world.snapshotPath = join(inputDir, `${world.id}.${world.version}`);
    const saved = snapshotArtifact(world.artifactPath, world.snapshotPath);
    assert.equal(saved.identity.digest, world.digest, 'Catalogue input changed before snapshot');
    report.inputs.push({ id: world.id, version: world.version, digest: world.digest,
      artifact: relative(reportDir, world.snapshotPath), original_path: world.artifactPath, source_sha256: world.manifest.source_sha256 });
  }
  save();
}

function safeFailure(error, tasks, state, project) {
  for (const path of [join(state, 'credentials.json'), join(state, 'bindings.json'), join(state, 'host-bindings.json'),
    ...(project ? [join(project, '.worldfixture/generated-secrets.json')] : [])]) {
    if (!existsSync(path)) continue;
    try {
      const document = read(path);
      for (const value of [...credentialValues(document), ...Object.values(document.values ?? {})]) {
        if (typeof value === 'string') knownSecrets.add(value);
      }
    } catch { /* A partial startup file must not prevent failure capture. */ }
  }
  if (project && existsSync(join(project, '.worldfixture/token'))) knownSecrets.add(readFileSync(join(project, '.worldfixture/token'), 'utf8').trim());
  const secrets = [...knownSecrets];
  return {
    name: error.name, message: redact(error.message, secrets),
    cli: tasks.map(task => ({ exit: task.exit(), stdout: redact(task.output(), secrets).slice(-20000), stderr: redact(task.stderr(), secrets).slice(-20000) })),
  };
}

function launch(args, cwd) {
  const child = spawn(process.execPath, [bin, ...args], { cwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', stderr = '', exit;
  child.stdout.on('data', bytes => { output += bytes; });
  child.stderr.on('data', bytes => { stderr += bytes; });
  child.on('error', error => { exit = { code: -1, error: error.message }; });
  child.on('exit', (code, signal) => { exit = { code, signal }; });
  return { child, output: () => output, stderr: () => stderr, exit: () => exit };
}
async function until(condition, child, deadline = Date.now() + timeout, cleanup = false) {
  while (!condition()) {
    if (!cleanup) abort.signal.throwIfAborted();
    if (child?.exit()) throw new Error(`CLI exited before readiness (${child.exit().code}); output SHA-256 ${hash(child.output() + child.stderr())}`);
    if (Date.now() > deadline) throw new Error('CLI readiness timed out');
    await pause(200);
  }
}
async function complete(args, cwd) {
  const task = launch(args, cwd);
  try { await until(() => !!task.exit(), null); }
  catch (error) { task.child.kill('SIGTERM'); throw error; }
  return task;
}
async function request(base, path, token) {
  const response = await fetch(`${base.replace(/\/$/, '')}${path}`, { signal: AbortSignal.timeout(10000), ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}) });
  assert.equal(response.status, 200, path);
  return response.json();
}
async function measureWorld(bindings, world, source) {
  if (partFor(world) === 'site') {
    const ready = await request(bindings.SITE_BASE_URL, '/readyz');
    assert.equal(ready.world_id, world.id); assert.equal(ready.world_version, world.version);
    const company = await request(bindings.SITE_BASE_URL, '/api/v1/company');
    const primary = source.organizations.find(row => row.primary);
    assert.deepEqual(company, { id: primary.id, name: primary.name, summary: primary.summary, synthetic: true });
    const stories = await request(bindings.SITE_BASE_URL, '/api/v1/stories');
    assert.equal(stories.count, source.stories.length);
    assert.deepEqual(stories.items.map(row => row.id).sort(), source.stories.map(row => row.id).sort());
    return { http_world: [ready.world_id, ready.world_version], company_id: company.id, story_count: stories.count };
  }
  const counts = {};
  for (const collection of ['organizations', 'people']) {
    const rows = []; let cursor;
    do {
      const page = await request(bindings.DOMAIN_BASE_URL, `/v1/collections/identity.${collection}?${new URLSearchParams({ limit: '200', ...(cursor ? { cursor } : {}) })}`, bindings.DOMAIN_TOKEN);
      assert.equal(page.world.id, world.id); assert.equal(page.world.version, world.version);
      rows.push(...page.data); cursor = page.next_cursor;
      assert.equal(Boolean(cursor), page.has_more);
    } while (cursor);
    const sorted = items => [...items].sort((a, b) => a.id.localeCompare(b.id));
    assert.deepEqual(sorted(rows), sorted(source[collection]));
    counts[collection] = rows.length;
  }
  return { domain_world: [world.id, world.version], identity_counts: counts };
}


async function negatives() {
  for (const direct of [false, true]) for (const [label, flags] of [
    ['invalid-name', ['--world', 'missing.world:v999']],
    ['missing-path', ['--world-path', join(scratch, 'missing-artifact')]],
    ['conflict', ['--world', `${worlds[0].id}:${worlds[0].version}`, '--world-path', worlds[1].artifactPath]],
  ]) {
    const base = join(scratch, `negative-${direct ? 'direct' : 'host'}-${label}`);
    mkdirSync(join(base, 'project'), { recursive: true });
    const before = snapshot(base);
    const task = await complete(['up', ...(direct ? ['--direct'] : []), ...flags, '--only', 'site', '--state', join(base, 'state'), '--project-dir', join(base, 'project')], join(base, 'project'));
    assert.notEqual(task.exit().code, 0, `Negative selection ${label} must fail`);
    assert.deepEqual(snapshot(base), before, `Negative selection ${label} wrote files`);
    report.checks.push({ label: `negative/${direct ? 'direct' : 'host'}/${label}`, status: 'passed', writes: 0 }); save();
  }
}

// Runtime SQLite is read only for exact cleanup ownership, never for API proof.
async function directContainerNames(state) {
  if (!existsSync(join(state, 'state.sqlite'))) return [];
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(state, 'state.sqlite'), { readOnly: true });
  try { return db.prepare('SELECT id FROM instance').all().flatMap(row => read(join(state, 'environment.lock.json')).services.map(service => `worldfixture-${row.id.slice(0, 8)}-${service.name}`)); }
  finally { db.close(); }
}
async function removeExact(name, state) {
  let info;
  try { info = JSON.parse((await docker(['inspect', name])).stdout)[0]; }
  catch (error) { if (/No such (object|container)/i.test(error.stderr ?? '')) return; throw error; }
  assert.equal(info.Name, `/${name}`);
  assert.ok(info.Mounts.some(mount => mount.Type === 'bind' &&
    (resolve(mount.Source) === resolve(state) || resolve(mount.Source).startsWith(`${resolve(state)}${sep}`))),
  'Cleanup requires a bind mount inside this case state directory');
  await docker(['rm', '--force', info.Id]);
}
async function rawEntrypoint() {
  const world = entrypointWorld;
  const state = join(scratch, 'entrypoint-state'); mkdirSync(state);
  const name = `worldfixture-p1-entry-${hash(scratch).slice(0, 12)}`;
  const details = { label: `entrypoint/${world.id}.${world.version}/named/no-rebase`, status: 'failed' };
  try {
    await docker(['run', '--detach', '--name', name, '--label', `worldfixture.coupling.owner=${owner}`, '--publish', '127.0.0.1::8080',
      '--mount', `type=bind,source=${state},target=/state`, imageId,
      '--world', `${world.id}:${world.version}`, '--only', 'site', '--no-rebase']);
    await until(() => existsSync(join(state, 'bindings.json')), null);
    const info = JSON.parse((await docker(['inspect', name])).stdout)[0];
    assert.equal(info.State.Running, true);
    const published = info.NetworkSettings.Ports['8080/tcp'][0];
    assert.equal(published.HostIp, '127.0.0.1');
    const base = `http://127.0.0.1:${published.HostPort}`;
    const ready = await request(base, '/readyz');
    assert.equal(ready.world_id, world.id); assert.equal(ready.world_version, world.version);
    const source = read(join(world.snapshotPath, 'world.json'));
    const primary = source.organizations.find(row => row.primary);
    const company = await request(base, '/api/v1/company');
    assert.deepEqual(company, { id: primary.id, name: primary.name, summary: primary.summary, synthetic: true });
    const lock = read(join(state, 'environment.lock.json'));
    assert.equal(lock.world.id, world.id); assert.equal(lock.world.version, world.version);
    assert.equal(lock.world.artifact_sha256, world.digest);
    assert.deepEqual(lock.services.map(service => service.name), ['http-targets']);
    Object.assign(details, { status: 'passed', world: `${world.id}:${world.version}`, digest: world.digest });
  } finally {
    await removeOwnedContainer(name, owner, docker);
    report.checks.push(details); save();
    console.log(`${details.status.toUpperCase()} ${details.label}`);
  }
}
async function checkCase(item, index) {
  const { world, mode, selection, noRebase } = item;
  const base = join(scratch, `case-${index}`), state = join(base, 'state'), project = join(base, 'project');
  mkdirSync(project, { recursive: true });
  const copiedPath = join(base, 'selected-build');
  cpSync(world.snapshotPath, copiedPath, { recursive: true });
  const selector = selection === 'path' ? ['--world-path', copiedPath] : ['--world', `${world.id}:${world.version}`];
  const args = ['up', ...selector, '--only', partFor(world), '--state', state, '--project-dir', project,
    ...(mode === 'direct' ? ['--direct'] : ['--image', imageId]), ...(noRebase ? ['--no-rebase'] : [])];
  const startedAt = Date.now(), task = launch(args, project);
  const details = { label: item.label, status: 'failed' };
  const tasks = [task];
  report.checks.push(details);
  try {
    await until(() => mode === 'direct' ? existsSync(join(state, 'bindings.json')) && task.output().includes('Stop with Ctrl-C') : !!task.exit(), mode === 'direct' ? task : null);
    if (mode === 'host') assert.equal(task.exit().code, 0, 'Host up failed');
    const lock = read(join(state, 'environment.lock.json'));
    assert.equal(lock.world.id, world.id); assert.equal(lock.world.version, world.version);
    assert.deepEqual(lock.services.map(service => service.name), [serviceFor(world)]);
    const active = join(state, noRebase ? 'input-world' : 'world');
    const session = inspectWorldArtifact(active, { sourceRoots: [repo] });
    assert.ok(session.valid, session.errors.join('; '));
    assert.equal(session.id, world.id); assert.equal(session.version, world.version);
    assert.equal(lock.world.artifact_sha256, session.digest);
    const source = read(join(world.snapshotPath, 'world.json')), current = read(join(active, 'world.json'));
    const anchor = Date.parse(source.clock.anchor);
    if (noRebase) {
      assert.equal(session.digest, world.digest);
      assert.equal(current.clock.anchor, source.clock.anchor);
      assert.ok(!existsSync(join(state, 'world')), '--no-rebase must not create a rebased artifact');
    } else {
      const startDay = Math.floor(startedAt / 86400000), endDay = Math.floor(Date.now() / 86400000);
      const sourceDay = Math.floor(anchor / 86400000);
      const expected = [startDay, endDay].map(day => anchor + Math.floor((day - sourceDay) / 7) * 7 * 86400000);
      assert.ok(expected.includes(Date.parse(current.clock.anchor)), 'Rebase must follow the source weekday by whole weeks');
      if (!expected.includes(anchor)) assert.notEqual(session.digest, world.digest, 'A changed anchor must change the session digest');
    }
    const financeEvidence = {};
    if (source.finance?.resolved) {
      const dayDelta = (Date.parse(current.clock.anchor) - anchor) / 86400000;
      assert.ok(Number.isInteger(dayDelta), 'Finance rebase uses whole days');
      const dateFields = new Set(['issued_on', 'due_on', 'paid_on', 'refunded_on', 'date']);
      for (const collection of ['invoices', 'payments', 'bills', 'refunds', 'ledger_entries']) {
        const before = source.finance.resolved[collection] ?? [];
        const after = current.finance.resolved[collection] ?? [];
        const rows = new Map(after.map(row => [row.id, row]));
        assert.equal(rows.size, after.length, `${collection}: duplicate session IDs`);
        assert.deepEqual([...rows.keys()].sort(), before.map(row => row.id).sort(), `${collection}: rebase must retain source IDs`);
        let dates = 0;
        for (const original of before) {
          // Authored prose keeps its existing text date rule. All record dates,
          // amounts, currencies, status and links must retain exact meaning.
          const expected = { ...original }, actual = { ...rows.get(original.id) };
          delete expected.description; delete actual.description;
          for (const field of dateFields) if (Object.hasOwn(expected, field)) {
            expected[field] = new Date(Date.parse(`${expected[field]}T00:00:00Z`) + dayDelta * 86400000).toISOString().slice(0, 10);
            dates++;
          }
          assert.deepEqual(actual, expected, `${collection}/${original.id}: finance must shift by the anchor delta only`);
        }
        financeEvidence[collection] = { records: rows.size, shifted_dates: dates };
      }
      if (!noRebase) assert.deepEqual(current.clock.rebase.finance_history, {
        origin_anchor: source.clock.rebase?.finance_history?.origin_anchor ?? source.clock.anchor,
        day_shift: (source.clock.rebase?.finance_history?.day_shift ?? 0) + dayDelta,
      }, 'Session finance history must record its original schedule and cumulative shift');
      financeEvidence.day_shift = dayDelta;
    }
    assert.deepEqual(current.people, source.people, 'Rebase must retain world identities');
    const bindings = read(join(state, mode === 'host' ? 'host-bindings.json' : 'bindings.json'));
    const measured = await measureWorld(bindings, world, source);
    if (mode === 'host') {
      const instance = read(join(state, 'instance.json'));
      assert.deepEqual(instance.requested_world, { id: world.id, version: world.version, digest: world.digest });
      const beforeMismatch = snapshot(base, SELECTION_PATHS);
      const other = worlds.find(row => row.id !== world.id || row.version !== world.version);
      const projectUrl = read(join(project, '.worldfixture/project.json')).application_url;
      assert.notEqual(projectUrl, 'http://localhost:3999');
      const refusal = await complete(['up', '--world', `${other.id}:${other.version}`, '--only', partFor(other), '--state', state, '--project-dir', project,
        '--application-url', 'http://localhost:3999', '--image', imageId], project);
      tasks.push(refusal);
      assert.notEqual(refusal.exit().code, 0, 'Mismatched world must not reuse the host');
      assert.deepEqual(snapshot(base, SELECTION_PATHS), beforeMismatch, 'Mismatched host selection changed staged data or project/instance files');
      assert.equal(read(join(state, 'instance.json')).container_id, instance.container_id);
      assert.equal(read(join(project, '.worldfixture/project.json')).application_url, projectUrl);
      const reused = await complete(args, project);
      tasks.push(reused);
      assert.equal(reused.exit().code, 0, 'Original selection must reuse the host');
      assert.equal(read(join(state, 'instance.json')).container_id, instance.container_id);
      assert.equal(read(join(state, 'environment.lock.json')).world.artifact_sha256, session.digest);
      assert.deepEqual(await measureWorld(bindings, world, source), measured);
    }
    Object.assign(details, { status: 'passed', original_digest: world.digest, session_digest: session.digest,
      anchor: current.clock.anchor, finance: financeEvidence, ...measured });
  } catch (error) {
    details.failure = safeFailure(error, tasks, state, project);
    save(); // Keep diagnostics before cleanup removes the live records.
    // CI's step log must show the redacted CLI failure, not only "Host up
    // failed". The artifact remains the complete record for later review.
    console.error(JSON.stringify(details.failure, null, 2));
    throw error;
  } finally {
    if (mode === 'direct') {
      const containers = await directContainerNames(state);
      if (!task.exit()) {
        task.child.kill('SIGINT');
        try { await until(() => !!task.exit(), null, Date.now() + 15000, true); }
        catch { task.child.kill('SIGKILL'); }
      }
      for (const name of containers) await removeExact(name, state);
    } else {
      if (!task.exit()) task.child.kill('SIGTERM');
      await stopHostInstance(state);
      // The deterministic name is unique to this script's new state directory.
      await removeExact(hostContainerName(state), state);
    }
    details.duration_ms = Date.now() - startedAt;
    save();
    console.log(`${details.status.toUpperCase()} ${item.label} ${details.duration_ms}ms`);
  }
}
try {
  retainInputs();
  await negatives();
  await rawEntrypoint();
  for (const [index, item] of cases.entries()) await checkCase(item, index);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.failure = { name: error.name, message: redact(error.message, [...knownSecrets]) };
  process.exitCode = 1;
} finally {
  report.finished_at = new Date().toISOString(); save();
  console.log(`Report: ${reportPath}`);
}
