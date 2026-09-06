import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertCredentialRotation, assertGeneration, assertStaleResponse, assertSurfaceEvidence, prepareSwitchInputs, readSelectedProviders, runWorldSwitchTest, SWITCH_SEQUENCE } from './world-switch-test.mjs';

function snapshot() {
  const world = { id: 'test.switch', version: 'v1', people: [{ id: 'person.new', primary: true, name: 'Tavi' }], timeline: [{ id: 'arrival.new', kind: 'chat-message', after_seconds: 30, payload: { text: 'Source text' } }] };
  const identity = { id: world.id, version: world.version, digest: 'a'.repeat(64) }, lockedWorld = { id: world.id, version: world.version, artifact_sha256: identity.digest };
  return { artifact: { identity, world }, world, session: { managed: true, phase: 'ready', generation: 'current', world: lockedWorld }, active: { phase: 'ready', generation: 'current', world: lockedWorld },
    lock: { world: lockedWorld, target: { identity: 'person.new' }, bindings: { SLACK_TOKEN: { person: 'person.new' } }, execution: { timeline: { active: ['arrival.new'] } } },
    bindings: { SLACK_TOKEN: 'current-token', WORKBENCH_URL: 'http://current.test', WORLDFIXTURE_TOKEN: 'runtime-current' }, credentials: { world: { id: world.id, version: world.version }, generation: 'current' },
    clock: { mode: 'setup', clock: { elapsed_ms: 0, running: false } }, timeline: [{ id: 'arrival.new', type: 'chat-message', due_at: 30000, payload: { text: 'Source text' }, status: 'pending' }],
    overview: { generation: 'current', people: world.people, world: lockedWorld } };
}

test('current generation proof rejects stale world, actor, bindings, clock and timeline', () => {
  assertGeneration(snapshot());
  for (const mutate of [value => { value.active.generation = 'old'; }, value => { value.lock.world.artifact_sha256 = 'old'; }, value => { value.credentials.generation = 'old'; },
    value => { value.lock.bindings.SLACK_TOKEN.person = 'old-person'; }, value => { value.bindings.FOREIGN_URL = 'http://old'; }, value => { value.clock.clock.elapsed_ms = 1; },
    value => { value.timeline[0].payload.text = 'foreign'; }, value => { value.timeline[0].status = 'delivered'; }, value => { value.overview.generation = 'old'; }]) {
    const value = structuredClone(snapshot()); mutate(value); assert.throws(() => assertGeneration(value));
  }
});

test('credential rotation rejects any old secret even under another reference', () => {
  assertCredentialRotation({ values: { first: 'old' } }, { values: { first: 'new' } });
  assert.throws(() => assertCredentialRotation({ values: { first: 'old' } }, { values: { second: 'old' } }));
  assert.throws(() => assertCredentialRotation({ values: {} }, { values: {} }));
});

test('stale writes need the measured conflict code, not an arbitrary API failure', () => {
  assertStaleResponse({ status: 409, body: { code: 'stale_generation' } });
  assertStaleResponse({ status: 409, body: { code: 'application_reconnect_required' } }, 'application_reconnect_required');
  for (const result of [{ status: 500, body: { code: 'stale_generation' } }, { status: 409, body: { code: 'provider_failed' } }, { status: 200, body: {} }]) assert.throws(() => assertStaleResponse(result));
});

test('selected surfaces require their own positive measured API response', () => {
  const lock = { services: [{ name: 'emulate' }, { name: 'domain' }, { name: 'mail' }], capabilities: { 'slack.messaging.v1': { service: 'emulate', port: 'slack' } } };
  const rows = ['slack', 'domain', 'mail'].map(provider => ({ provider, status: 200 }));
  assert.deepEqual(assertSurfaceEvidence(lock, { responses: rows }), ['slack', 'domain', 'mail']);
  assert.throws(() => assertSurfaceEvidence(lock, { responses: rows.slice(1) }), /slack/);
  assert.throws(() => assertSurfaceEvidence(lock, { responses: rows.map(row => ({ ...row, status: 401 })) }));
});

test('provider aggregation retains failed content and reader scope without changing expectations', async () => {
  const source = { artifact: { world: { id: 'test.source' } }, bindings: { API_URL: 'http://measured' }, credentials: { values: {} } }, seen = [];
  const output = await readSelectedProviders({ ...source, readers: [async input => { seen.push(input); return { checks: [{ check: 'source.content', status: 'failed' }], responses: [{ provider: 'slack', status: 200 }], coverage: [{ provider: 'slack', status: 'failed' }] }; }] });
  assert.equal(seen[0].artifact, source.artifact); assert.equal(seen[0].elapsedMs, 0);
  assert.equal(output.checks[0].status, 'failed'); assert.equal(output.coverage[0].status, 'failed');
});

test('frozen preparation preserves shipped worlds and changes only alien channel name', async t => {
  const root = mkdtempSync(join(tmpdir(), 'switch-image-inputs-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = await prepareSwitchInputs({ outputPath: join(root, 'first') }), second = await prepareSwitchInputs({ outputPath: join(root, 'second') });
  assert.deepEqual(SWITCH_SEQUENCE, ['A', 'B', 'alien', 'A']);
  for (const key of ['A', 'B', 'alien']) {
    assert.equal(first[key].artifact.identity.digest, second[key].artifact.identity.digest);
    assert.deepEqual(first[key].artifact.manifest, second[key].artifact.manifest);
  }
  assert.deepEqual(first.A.evidence.changes, []); assert.deepEqual(first.B.evidence.changes, []);
  const original = JSON.parse(readFileSync(join(root, 'first/alien/original-source.json')));
  original.communication.channels[0].name = 'general'; assert.deepEqual(first.alien.artifact.world, original);
  assert.equal(first.alien.evidence.changes.length, 1);
  await assert.rejects(prepareSwitchInputs({ outputPath: join(root, 'first') }), /overwrite/);
});

test('preparation alone has no live evidence and a report cannot be overwritten', async t => {
  const root = mkdtempSync(join(tmpdir(), 'switch-image-report-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const reportPath = join(root, 'report');
  const report = await runWorldSwitchTest({ reportPath, prepareOnly: true });
  assert.equal(report.status, 'prepared'); assert.equal(report.cases.length, 0); assert.match(report.scope, /No live/);
  const before = readFileSync(join(reportPath, 'report.json'));
  await assert.rejects(runWorldSwitchTest({ reportPath, prepareOnly: true }), /overwrite/);
  assert.deepEqual(readFileSync(join(reportPath, 'report.json')), before);
  await assert.rejects(runWorldSwitchTest({ reportPath: join(root, 'mutable'), image: 'mutable-tag' }), /immutable/);
});
