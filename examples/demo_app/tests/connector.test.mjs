import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/db/store.mjs';
import { createConnector } from '../src/connector/index.mjs';

const world = { id: 'test-world', version: 'v1', artifact_sha256: 'a'.repeat(64), synthetic: true };
const request = (seed = false) => ({
  api_version: 'worldfixture.connector-request/v1', request_id: 'test-request',
  ...(seed ? { idempotency_key: 'seed:test-world' } : {}), world,
  packs: { identity: { organizations: [{ id: 'customer-a', name: 'Customer A' }], people: [{ id: 'user-a', name: 'User A', email: 'user@company.test' }] },
    work: { tasks: [{ id: 'task-a', title: 'Review request', owner_id: 'user-a' }] },
    finance: { invoices: [{ id: 'invoice-a' }] } }, options: { mode: seed ? 'apply' : 'preview' },
});
const event = () => ({ api_version: 'worldfixture.application-event/v1', delivery_id: 'delivery-1', event_id: 'event-1',
  kind: 'task.updated.v1', occurred_at: '2026-09-05T12:00:00Z', subject: { worldfixture_ref: 'task/task-a' }, data: { state: 'ready' } });
async function setup() {
  const store = await createStore({ ACCOUNT_DESK_SQLITE_PATH: ':memory:', WORLDFIXTURE_WORLD_ID: world.id, WORLDFIXTURE_WORLD_VERSION: world.version });
  const connector = createConnector({ store, token: 'test-only-token', world, enabled: true, nodeEnv: 'test' });
  const call = (path, input, method = 'POST', authorization = 'Bearer test-only-token') => connector.handle({ method, path: `/__worldfixture/${path}`, input, authorization });
  return { store, connector, call };
}

test('connector requires explicit development enablement and token', async () => {
  for (const options of [{}, { enabled: true }, { enabled: true, token: 'test', nodeEnv: 'production' }]) {
    const connector = createConnector({ store: {}, ...options });
    assert.equal((await connector.handle({ method: 'GET', path: '/.well-known/worldfixture' })).status, 404);
  }
});

test('discovery is public, other connector paths require full token', async () => {
  const { store, connector, call } = await setup();
  try {
    const discovery = await connector.handle({ method: 'GET', path: '/.well-known/worldfixture' });
    assert.equal(discovery.status, 200);
    assert.deepEqual(discovery.body.capabilities, { plan: true, seed: true, event: true, status: true, reset: false });
    assert.equal(JSON.stringify(discovery.body).includes('test-only-token'), false);
    for (const path of ['plan', 'seed', 'events', 'status', 'reset']) {
      for (const token of ['', 'Bearer test-only', 'Bearer test-only-token-extra']) assert.equal((await call(path, {}, path === 'status' ? 'GET' : 'POST', token)).status, 401);
    }
    assert.equal(await connector.handle({ method: 'GET', path: '/api/customers' }), null);
  } finally { await store.close(); }
});

test('plan is read-only and reports exact imported and skipped fields', async () => {
  const { store, call } = await setup();
  try {
    const input = request();
    input.options.scale = { complete: false, collections: [{ collection: 'people', sent: 1, available: 10 }] };
    const plan = await call('plan', input);
    assert.equal(plan.status, 200);
    assert.deepEqual(plan.body.counts, { organizations: 1, people: 1, tasks: 1 });
    assert.equal(plan.body.mappings.find((item) => item.source === 'finance.invoices').status, 'skipped');
    assert.match(plan.body.summary, /partial world slice/);
    assert.ok(plan.body.warnings.includes('people: 1 of 10 records supplied.'));
    assert.deepEqual(await store.list('mappings'), []);
    assert.deepEqual(await store.list('receipts'), []);
    assert.equal((await call('status', undefined, 'GET')).body.state, 'empty');
  } finally { await store.close(); }
});

test('seed is atomic, repeatable, and a larger seed adds references', async () => {
  const { store, call } = await setup();
  try {
    const [first, second] = await Promise.all([call('seed', request(true)), call('seed', request(true))]);
    assert.equal(first.body.status, 'applied');
    assert.equal(second.body.status, 'already_applied');
    assert.equal(first.body.references.length, 3);
    assert.equal((await store.list('receipts')).length, 1);
    assert.equal((await store.list('mappings')).filter((item) => item.importedBy).length, 3);
    const larger = request(true);
    larger.idempotency_key = 'seed:larger';
    larger.packs.identity.people.push({ id: 'user-b', name: 'User B' });
    assert.equal((await call('seed', larger)).body.status, 'applied');
    assert.equal((await store.list('mappings')).filter((item) => item.importedBy).length, 4);
    const status = await call('status', undefined, 'GET');
    assert.equal(status.body.state, 'seeded');
    assert.equal(status.body.artifact_sha256, world.artifact_sha256);
    assert.equal(JSON.stringify(status.body).includes('test-only-token'), false);
  } finally { await store.close(); }
});

test('events require mapped references and record each identity only once', async () => {
  const { store, call } = await setup();
  try {
    assert.equal((await call('events', event())).status, 422);
    assert.deepEqual(await store.list('events'), []);
    await call('seed', request(true));
    const first = await call('events', event());
    assert.equal(first.body.status, 'applied');
    const repeated = { ...event(), delivery_id: 'delivery-2' };
    assert.equal((await call('events', repeated)).body.status, 'already_applied');
    assert.equal((await store.list('events')).length, 1);
    assert.equal((await call('status', undefined, 'GET')).body.state, 'changed');
    assert.equal((await call('reset', {})).status, 409);
    assert.equal((await store.list('events')).length, 1);
  } finally { await store.close(); }
});

test('invalid and cross-world requests cannot change app state', async () => {
  const { store, call } = await setup();
  try {
    const invalid = [null, {}, { ...request(true), idempotency_key: '' },
      { ...request(true), world: { ...world, synthetic: false } },
      { ...request(true), world: { ...world, id: 'other-world' } },
      { ...request(true), world: { ...world, version: 'v2' } },
      { ...request(true), packs: { identity: { people: [{ id: '../invalid' }] } } },
      { ...request(true), packs: { identity: { people: [{ id: 'same' }, { id: 'same' }] } } },
    ];
    for (const input of invalid) assert.equal((await call('seed', input)).status, 400);
    assert.equal((await call('events', { ...event(), occurred_at: 'yesterday' })).status, 400);
    assert.equal((await call('seed', { ...request(true), padding: 'x'.repeat(8 * 1024 * 1024) })).status, 413);
    assert.equal((await call('plan', request(), 'GET')).status, 405);
    assert.deepEqual(await store.list('mappings'), []);
  } finally { await store.close(); }
});
