import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { openState } from './state.mjs';
import { attachTimelineControl } from './timeline-control.mjs';
import { createSessionManager, assertSessionRecoverable } from './session-manager.mjs';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'worldfixture-session-')), starts = [], order = [];
  const app = { name: 'appdb', lifecycle: { reset: false }, ports: [{ name: 'http', protocol: 'http', published: true }], environment: [{ from: 'generated', key: 'appdb.password' }] };
  const provider = { name: 'domain', lifecycle: { reset: true }, ports: [{ name: 'http', protocol: 'http', published: true }], environment: [{ from: 'generated', key: 'domain.token' }] };
  const lock = name => ({ world: { id: name, version: 'v1', artifact_sha256: name.repeat(64).slice(0, 64) }, services: [structuredClone(provider), structuredClone(app)] });
  const instances = [];
  function make(name, options = {}) {
    const stateDir = options.stateDir ?? join(root, name); mkdirSync(stateDir, { recursive: true });
    const current = { lock: options.lock ?? lock(name), stateDir, artifactPath: join(root, `artifact-${name}`), state: openState(':memory:'),
      allocation: options.preservedAllocation?.size ? new Map([...options.preservedAllocation, ['domain/http', { number: 4717, protocol: 'http', published: true }]])
        : new Map([['domain/http', { number: 4717, protocol: 'http', published: true }], ['appdb/http', { number: 5432, protocol: 'http', published: true }]]),
      credentials: { values: { 'appdb.password': options.preservedCredentials?.['appdb.password'] ?? 'database-stable', 'domain.token': options.generation ?? 'initial-token' } },
      children: [{ service: 'domain', exited: null, launch: {} }, ...(options.preservedChildren ?? [{ service: 'appdb', exited: null, launch: {} }])],
      timelineControl: { async stop() { order.push(`settled:${name}`); }, async command(input) { return input; } },
      async stopChildren({ services } = {}) { for (const row of this.children) if (!services || services.includes(row.service)) { row.exited = { code: 0 }; order.push(`stopped:${row.service}`); } },
      async stop({ preserveServices = [] } = {}) { await this.stopChildren({ services: this.children.filter(row => !preserveServices.includes(row.service)).map(row => row.service) }); if (this.state.isOpen) this.state.close(); },
    };
    instances.push(current); return current;
  }
  const first = make('a');
  const options = { sessionRoot: root, prepareSelection: async (input, { generation }) => ({ lock: lock(input.world), artifactPath: join(root, `artifact-${input.world}`), world: { id: input.world }, selection: { id: input.world }, stateDir: join(root, generation) }),
    start: async (next, opts) => { order.push(`started:${next.world.id}`); starts.push(opts); return make(next.world.id, { ...opts, lock: next }); },
    activate: async current => { order.push(`activated:${current.lock.world.id}`); }, publish: async current => { order.push(`published:${current.lock.world.id}`); },
    confirmConnection: async () => {}, ...overrides };
  const manager = createSessionManager(first, options);
  t.after(async () => { await manager.stop(); for (const current of instances) if (current.state.isOpen) current.state.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, first, manager, starts, order, make, options, lock };
}
test('switch replaces the generation, retains application process credentials, and gates delivery', async t => {
  const { manager, first, starts, root } = fixture(t); await manager.publishInitial();
  first.state.prepare("INSERT INTO connector_receipts VALUES('wf:a:v1:event','http://app','{}','fingerprint','accepted','{}')").run();
  const original = manager.generation, retainedChild = first.children[1];
  assert.throws(() => manager.withGeneration(undefined, () => {}, { mutation: true }), error => error.code === 'stale_generation');
  await manager.switchWorld({ world: 'b' }, original);
  assert.notEqual(manager.generation, original); assert.equal(manager.instance.lock.world.id, 'b');
  assert.equal(manager.instance.children[1], retainedChild); assert.equal(retainedChild.exited, null);
  assert.equal(starts[0].preservedCredentials['appdb.password'], 'database-stable');
  assert.notEqual(manager.instance.credentials.values['domain.token'], first.credentials.values['domain.token']);
  assert.equal(manager.instance.state.prepare('SELECT COUNT(*) AS n FROM connector_receipts').get().n, 1);
  await assert.rejects(manager.clockCommand({ action: 'advance', duration: '1s' }, manager.generation), error => error.code === 'application_reconnect_required');
  await manager.confirmConnection({ withoutApplication: true }, manager.generation);
  assert.equal(manager.status().reconnect_required, false); await manager.clockCommand({ action: 'start' }, manager.generation);
  const active = JSON.parse(readFileSync(join(root, 'active-generation.json'))); assert.equal(active.generation, manager.generation); assert.equal(active.world.id, 'b');
});
test('new mutations reject synchronously and accepted old writes settle before providers stop', async t => {
  const pending = deferred(), { manager, order } = fixture(t);
  const writing = manager.withGeneration(manager.generation, async () => { await pending.promise; order.push('write-settled'); }, { mutation: true });
  const writeResult = writing.catch(error => error);
  const switching = manager.switchWorld({ world: 'b' }, manager.generation);
  assert.throws(() => manager.withGeneration(manager.generation, () => {}, { mutation: true }), error => error.code === 'session_transition');
  await new Promise(resolve => setImmediate(resolve)); assert.ok(!order.includes('stopped:domain'));
  pending.resolve(); await switching; assert.equal((await writeResult).code, 'stale_generation');
  assert.ok(order.indexOf('write-settled') < order.indexOf('stopped:domain'));
});
test('a late old-world read is rejected even when the new world uses the same ports', async t => {
  const pending = deferred(), { manager } = fixture(t);
  const reading = manager.withGeneration(undefined, () => pending.promise); const readResult = reading.catch(error => error);
  await manager.switchWorld({ world: 'b' }, manager.generation); pending.resolve({ provider: 'old-world' });
  assert.equal((await readResult).code, 'stale_generation');
});
test('invalid preparation leaves old providers and generation unchanged', async t => {
  const { manager, first, order } = fixture(t, { prepareSelection: async () => { throw new Error('Invalid artifact digest'); } });
  const generation = manager.generation;
  await assert.rejects(manager.switchWorld({}, generation), /Invalid artifact digest/);
  assert.equal(manager.generation, generation); assert.equal(manager.instance, first); assert.equal(manager.status().phase, 'ready'); assert.deepEqual(order, []);
});

test('an old read error becomes a stale-generation response after switch', async t => {
  const pending = deferred(), { manager } = fixture(t);
  const reading = manager.withGeneration(undefined, async current => { await pending.promise; return current.state.prepare('SELECT 1').get(); }).catch(error => error);
  await manager.switchWorld({ world: 'b' }, manager.generation); pending.resolve();
  assert.equal((await reading).code, 'stale_generation');
  await assert.rejects(manager.withGeneration(undefined, () => { throw new Error('Current failure'); }), /Current failure/);
});
test('startup failure restores the old baseline with a new generation and explicit loss notice', async t => {
  let calls = 0;
  const value = fixture(t, { startOptions: { inContainer: true }, start: async (lock, options) => { assert.equal(options.inContainer, true); if (++calls === 1) throw new Error('Seed rejected'); return value.make(lock.world.id, { ...options, lock }); } });
  const original = value.manager.generation;
  await assert.rejects(value.manager.switchWorld({ world: 'b' }, original), error => error.code === 'switch_failed_rolled_back' && error.detail.manual_provider_changes_lost);
  assert.equal(value.manager.instance.lock.world.id, 'a'); assert.notEqual(value.manager.generation, original); assert.equal(value.manager.status().reconnect_required, true);
  assert.doesNotThrow(() => assertSessionRecoverable(value.root));
});
test('failed rollback persists a stopped recovery requirement without stopping the application', async t => {
  const { manager, first, root } = fixture(t, { start: async () => { throw new Error('Listener failed'); } });
  await assert.rejects(manager.switchWorld({ world: 'b' }, manager.generation), error => error.code === 'switch_recovery_required');
  assert.equal(manager.status().phase, 'stopped'); assert.equal(first.children[1].exited, null);
  assert.throws(() => assertSessionRecoverable(root), error => error.code === 'session_recovery_required');
});
test('an interrupted journal refuses startup before mixed state can be published', t => {
  const { root } = fixture(t);
  writeFileSync(join(root, 'session-transition.json'), JSON.stringify({ api_version: 'worldfixture.session-transition/v1', phase: 'starting', recovery_required: true }));
  assert.throws(() => assertSessionRecoverable(root), error => error.code === 'session_recovery_required' && error.detail.journal.endsWith('session-transition.json'));
});


test('late connection confirmation cannot clear the new generation reconnect gate', async t => {
  const pending = deferred(), entered = deferred();
  const { manager, root } = fixture(t, { confirmConnection: async () => { entered.resolve(); await pending.promise; } });
  const confirming = manager.confirmConnection({}, manager.generation).catch(error => error); await entered.promise;
  const switching = manager.switchWorld({ world: 'b' }, manager.generation);
  pending.resolve(); assert.equal((await confirming).code, 'stale_generation'); await switching;
  assert.equal(manager.status().reconnect_required, true);
  const active = JSON.parse(readFileSync(join(root, 'active-generation.json')));
  assert.equal(active.generation, manager.generation); assert.equal(active.reconnect_required, true);
});

test('switch waits for an in-flight HTTP arrival and never claims the next due row', async t => {
  const entered = deferred(), release = deferred(), received = []; let outcomes;
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const { actor_id, record } = JSON.parse(body); received.push(record.id); entered.resolve(); await release.promise;
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ ok: true, record,
      event: { id: 'provider-accepted', seq: 1, type: 'domain.record.created.v1', world: { id: 'a', version: 'v1' }, collection: 'social.posts', record_id: record.id, actor_id, before: null, after: record } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { release.resolve(); await new Promise(resolve => server.close(resolve)); });
  let value;
  value = fixture(t, { start: async (lock, options) => {
    outcomes = value.first.state.prepare('SELECT id,status,event_id FROM scheduled_events ORDER BY seq').all();
    return value.make(lock.world.id, { ...options, lock });
  } });
  const world = { id: 'a', version: 'v1', clock: { anchor: '2030-01-01T00:00:00Z' }, people: [{ id: 'actor' }], timeline: ['first', 'next'].map(id => ({
    id, after_seconds: 0, kind: 'domain-operation', payload: { api_version: 'worldfixture.runtime-operation/v1', type: 'social.post.publish.v1', actor_id: 'actor',
      record: { id, author_id: 'actor', title: id, body: id } } })) };
  delete value.first.timelineControl;
  const controller = attachTimelineControl(value.first, world, { bindings: { DOMAIN_BASE_URL: `http://127.0.0.1:${server.address().port}`, DOMAIN_TOKEN: 'test-token' }, rules: [], tickMs: 3600000 });
  await controller.initialize({ setup: true });
  const positioning = value.manager.clockCommand({ action: 'start', duration: '0s' }, value.manager.generation).catch(error => error);
  await entered.promise; assert.equal(controller.status().timeline.in_flight, 1);
  const switching = value.manager.switchWorld({ world: 'b' }, value.manager.generation);
  await new Promise(resolve => setImmediate(resolve)); assert.ok(!value.order.includes('stopped:domain')); assert.deepEqual(received, ['first']);
  release.resolve(); await switching;
  assert.equal((await positioning).code, 'stale_generation');
  assert.deepEqual(received, ['first']); assert.deepEqual(outcomes.map(row => row.status), ['delivered', 'pending']);
  assert.ok(outcomes[0].event_id); assert.equal(outcomes[1].event_id, null); assert.equal(value.manager.status().reconnect_required, true);
});
