import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openState } from './state.mjs';
import { createSessionManager } from './session-manager.mjs';
import { startWorkbench } from './workbench.mjs';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('managed Workbench switches snapshots, rejects late reads and stale writes, and scopes connector records', { timeout: 15000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'wf-wb-session-')), entered = deferred(), release = deferred();
  let hold = false, providerName = 'first';
  const provider = createServer(async (_request, response) => {
    const name = providerName;
    if (hold) { entered.resolve(); await release.promise; }
    response.end(`<h1>${name}</h1>`);
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const providerUrl = `http://127.0.0.1:${provider.address().port}`, instances = [], commands = [];
  const lock = name => ({ world: { id: name, version: 'v1', artifact_sha256: name }, services: [], rules: [] });
  for (const name of ['first', 'second']) {
    mkdirSync(join(root, name, 'projections'), { recursive: true });
    writeFileSync(join(root, name, 'world.json'), JSON.stringify({ id: name, version: 'v1', people: [{ id: `${name}.actor`, name }, { id: `${name}.primary`, name: 'Declared primary', primary: true }], organizations: [], timeline: [] }));
    writeFileSync(join(root, name, 'projections/http-targets.json'), JSON.stringify({ api_version: 'worldfixture.http-targets/v1', pages: [{ path: '/' }] }));
  }
  const make = (name, options = {}) => {
    const stateDir = options.stateDir ?? join(root, 'initial'); mkdirSync(stateDir, { recursive: true });
    const current = { artifactPath: join(root, name), stateDir, lock: lock(name), state: openState(':memory:'), credentials: { values: {} },
      children: [], allocation: new Map(), applicationBindings: { SITE_BASE_URL: providerUrl }, serviceStates: new Map(), readiness: new Map(),
      timelineControl: { status: () => ({ mode: 'setup', clock: { started: true }, repeat: { cycle: 1 } }), stop: async () => {},
        command: async input => { commands.push({ name, ...input }); return { ok: true }; } },
      stopChildren: async () => {}, stop: async () => { if (current.state.isOpen) current.state.close(); } };
    instances.push(current); return current;
  };
  const first = make('first'); let workbench;
  // Workbench starts before the manager is attached in normal startup.
  workbench = await startWorkbench(first, { artifactPath: first.artifactPath, stateDir: root });
  const manager = createSessionManager(first, { sessionRoot: root, onChange: () => workbench.notify('generation-change'),
    prepareSelection: async input => ({ artifactPath: join(root, input.selector), world: { id: input.selector }, lock: lock(input.selector) }),
    start: async (nextLock, options) => make(nextLock.world.id, options), activate: async current => { providerName = current.lock.world.id; },
    confirmConnection: async (current, input, { generation }) => writeFileSync(join(current.stateDir, 'application-connector.json'), JSON.stringify({ generation, world: current.lock.world, confirmed: true, ...input })) });
  manager.catalogue = async () => [{ id: 'second', version: 'v1', valid: true, artifactPath: join(root, 'second') }];
  const get = async (path, generation) => fetch(workbench.url + path, { headers: generation ? { 'X-WorldFixture-Generation': generation } : {} });
  const post = async (path, value, generation) => fetch(workbench.url + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(generation ? { 'X-WorldFixture-Generation': generation } : {}) }, body: JSON.stringify(value) });
  try {
    const old = manager.generation;
    const streamAbort = new AbortController();
    const stream = await fetch(workbench.url + '/api/live', { signal: streamAbort.signal });
    const reader = stream.body.getReader();
    let received = '';
    const receiveUntil = async marker => { while (!received.includes(marker)) received += new TextDecoder().decode((await reader.read()).value); };
    await receiveUntil(old);
    assert.match(received, /event: session\n/);
    assert.equal((await (await get('/api/session')).json()).generation, old);
    assert.equal((await (await get('/api/worlds')).json()).data[0].id, 'second');
    const initial = await (await get('/api/overview')).json(); assert.equal(initial.world.id, 'first'); assert.equal(initial.people[0].id, 'first.actor'); assert.equal(initial.people.find(person => person.primary)?.id, 'first.primary');
    assert.equal((await post('/api/clock', { action: 'pause' })).status, 409); assert.equal(commands.length, 0);
    assert.equal((await post('/api/reset', {})).status, 409); assert.equal(commands.length, 0);
    assert.equal((await post('/api/clock', { action: 'pause' }, old)).status, 200); assert.equal(commands.length, 1);
    hold = true; const reading = get('/api/overview', old); await entered.promise;
    assert.equal((await post('/api/world/switch', { selector: 'second' }, old)).status, 200);
    hold = false; release.resolve();
    const late = await reading; assert.equal(late.status, 409); const rejected = await late.json(); assert.equal(rejected.code, 'stale_generation'); assert.equal(rejected.world, undefined);
    const next = manager.generation; assert.notEqual(next, old);
    await receiveUntil(next); assert.match(received, /\"phase\":\"switching\"/);
    assert.match(received, /event: clock\n/);
    streamAbort.abort(); await reader.cancel().catch(() => {});
    assert.equal((await post('/api/clock', { action: 'pause' }, old)).status, 409);
    assert.equal((await post('/api/clock', { action: 'start' }, next)).status, 409);
    const overview = await get('/api/overview', next); assert.equal(overview.headers.get('X-WorldFixture-Generation'), next);
    const active = await overview.json(); assert.equal(active.world.id, 'second'); assert.equal(active.people[0].id, 'second.actor'); assert.equal(active.people.find(person => person.primary)?.id, 'second.primary'); assert.equal(active.providers.website.preview, 'second');
    writeFileSync(join(root, 'application-connector.json'), JSON.stringify({ url: 'http://old.invalid', transport_url: 'http://old.invalid' }));
    writeFileSync(join(manager.instance.stateDir, 'application-connector.json'), JSON.stringify({ generation: old, confirmed: true, world: first.lock.world, url: 'http://old.invalid' }));
    assert.equal((await (await get('/api/connector', next)).json()).state, 'disconnected');
    assert.equal((await post('/api/world/connection', { withoutApplication: true }, next)).status, 200);
    assert.equal((await post('/api/clock', { action: 'start' }, next)).status, 200);
    assert.equal(commands.at(-1).name, 'second');
    assert.equal((await post('/api/connector/disconnect', {}, old)).status, 409);
  } finally {
    release.resolve(); await workbench.close(); await manager.stop();
    for (const current of instances) if (current.state.isOpen) current.state.close();
    await new Promise(resolve => provider.close(resolve)); rmSync(root, { recursive: true, force: true });
  }
});
