import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {createDomainService} from './server.mjs';
import {loadDomainProjection, openDomainStore} from './store.mjs';

const token = 'unit-domain-service-credential';
const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const collections = () => ({
  'identity.people': [{id: 'person-47.uncommon', name: 'Tavi', organization_id: 'org-main'}],
  'identity.organizations': [{id: 'org-main', name: 'Organization'}],
  'commerce.products': [{id: 'product-a', name: 'Product', sku: 'A', price_cents: 125, currency: 'JPY', status: 'active', extra: {nested: ['retained']}}],
  'commerce.orders': [], 'social.posts': [], 'social.reviews': [], 'social.comments': [],
  'finance.customers': [{id: 'customer-a', contact_id: 'person-47.uncommon', organization_id: 'org-main'}],
  'finance.payments': [], 'finance.ledger_entries': [], 'finance.invoices': [], 'finance.bills': [], 'finance.suppliers': [], 'finance.refunds': [],
  'support.cases': [], 'work.projects': [], 'work.tasks': [], 'work.time_entries': [], 'custom.objects': [{id: 'opaque:record', fields: {nested: {reference: 'product-a'}}}],
});
function fixture(t, rows = collections(), id = 'test.world') {
  const root = mkdtempSync(join(tmpdir(), 'wf-domain-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const worldPath = join(root, 'world'), statePath = join(root, 'state');
  mkdirSync(join(worldPath, 'projections'), {recursive: true});
  const projection = {api_version: 'worldfixture.domain/v1', world: {id, version: 'v1'}, collections: rows};
  const bytes = Buffer.from(JSON.stringify(projection));
  writeFileSync(join(worldPath, 'projections/domain.json'), bytes);
  const files = {'projections/domain.json': {sha256: sha(bytes), size: bytes.length}};
  const artifact_sha256 = sha(`${JSON.stringify(canonical(files))}\n`);
  writeFileSync(join(worldPath, 'manifest.json'), JSON.stringify({api_version: 'worldfixture.world-artifact/v1', world_id: id, world_version: 'v1', files, artifact_sha256}));
  return {root, worldPath, statePath, token, expectedDigest: artifact_sha256};
}
async function api(t, input) {
  const config = input ?? fixture(t), service = createDomainService(config);
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  t.after(() => service.close());
  const origin = `http://127.0.0.1:${service.server.address().port}`;
  const read = async (path, {method = 'GET', body, credential = token} = {}) => {
    const response = await fetch(origin + path, {method, headers: {...(credential ? {authorization: `Bearer ${credential}`} : {}), ...(body === undefined ? {} : {'content-type': 'application/json'})}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
    return {status: response.status, body: await response.json()};
  };
  return {...config, service, read};
}
const actor_id = 'person-47.uncommon';
const order = (id = 'order-a') => ({id, shopper_id: actor_id, currency: 'JPY', status: 'placed', items: [{product_id: 'product-a', quantity: 2, unit_amount_cents: 125}], subtotal_cents: 250, shipping_cents: 10, discount_cents: 5, total_cents: 255, channel: 'local', external: {full: ['record', {kept: true}]}});

test('metadata and records come from persistent API data with complete deterministic pagination', async t => {
  const {read} = await api(t);
  const names = [], counts = {};
  let cursor;
  do {
    const result = await read(`/v1/collections?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    assert.equal(result.status, 200);
    names.push(...result.body.data.map(row => row.name));
    for (const row of result.body.data) counts[row.name] = row.count;
    cursor = result.body.next_cursor;
    assert.equal(Boolean(cursor), result.body.has_more);
  } while (cursor);
  assert.deepEqual(names, Object.keys(collections()).sort());
  assert.equal(counts['commerce.orders'], 0);
  const record = await read('/v1/collections/custom.objects/opaque%3Arecord');
  assert.deepEqual(record.body.record, collections()['custom.objects'][0]);
  assert.equal((await read('/v1/collections/commerce.products')).body.data[0].extra.nested[0], 'retained');
  assert.equal((await read('/v1/collections?limit=0')).status, 400);
  assert.equal((await read('/v1/collections?limit=1&limit=2')).status, 400);
  assert.equal((await read('/v1/collections?cursor=invalid')).body.error.code, 'invalid_cursor');
});

test('service auth is separate from explicit world actors and no-person worlds can read', async t => {
  const {read} = await api(t, fixture(t, {'commerce.orders': [], 'identity.people': []}));
  assert.equal((await read('/readyz', {credential: null})).status, 200);
  for (const credential of [null, 'wrong', 'sample-token']) assert.equal((await read('/v1/collections', {credential})).status, 401);
  assert.equal((await read('/v1/collections')).status, 200);
  for (const body of [{record: order()}, {actor_id, record: order()}]) assert.equal((await read('/v1/collections/commerce.orders', {method: 'POST', body})).status, 400);
  assert.equal((await read('/v1/events')).body.total_count, 0);
});

test('invalid order arithmetic, types, currencies and references never mutate records or events', async t => {
  const {read} = await api(t);
  for (const patch of [{subtotal_cents: 249}, {total_cents: 254}, {currency: 'USD'}, {currency: 123}, {shopper_id: 'absent-person'}, {items: []}, {items: [{product_id: 'product-a', quantity: true, unit_amount_cents: 125}]}, {shipping_cents: -1}, {total_cents: '255'}, {placed_on: '2026-02-30'}]) {
    const result = await read('/v1/collections/commerce.orders', {method: 'POST', body: {actor_id, record: {...order(), ...patch}}});
    assert.equal(result.status, 400, JSON.stringify(patch));
    assert.equal((await read('/v1/collections/commerce.orders')).body.total_count, 0);
    assert.equal((await read('/v1/events')).body.total_count, 0);
  }
  const valid = await read('/v1/collections/commerce.orders/validate', {method: 'POST', body: {actor_id, record: order()}});
  assert.equal(valid.body.valid, true);
  assert.equal((await read('/v1/events')).body.total_count, 0);
});

test('accepted order writes preserve full records and emit versioned provenance without finance side effects', async t => {
  const {read, expectedDigest} = await api(t);
  const accepted = await read('/v1/collections/commerce.orders', {method: 'POST', body: {actor_id, record: order()}});
  assert.equal(accepted.status, 201);
  assert.deepEqual(accepted.body.record, order());
  assert.equal(accepted.body.event.type, 'commerce.order.placed.v1');
  assert.equal(accepted.body.event.actor_id, actor_id);
  assert.equal(accepted.body.event.provenance.artifact_sha256, expectedDigest);
  assert.deepEqual(accepted.body.event.after, order());
  assert.equal(accepted.body.event.before, null);
  assert.equal((await read('/v1/collections/commerce.orders', {method: 'POST', body: {actor_id, record: order()}})).status, 409);
  for (const name of ['payments', 'invoices', 'ledger_entries']) assert.equal((await read(`/v1/collections/finance.${name}`)).body.total_count, 0);
  const changed = await read('/v1/collections/commerce.orders/order-a', {method: 'PATCH', body: {actor_id, expected_version: 1, patch: {status: 'packed'}}});
  assert.equal(changed.body.version, 2);
  assert.deepEqual(changed.body.record.external, order().external);
  assert.equal(changed.body.event.type, 'domain.record.updated.v1');
  assert.equal((await read('/v1/collections/commerce.orders/order-a', {method: 'PATCH', body: {actor_id, expected_version: 1, patch: {status: 'shipped'}}})).body.error.code, 'version_conflict');
  assert.equal((await read('/v1/collections/commerce.orders/order-a', {method: 'PATCH', body: {actor_id, patch: {id: 'other-id'}}})).body.error.code, 'immutable_id');
  const events = await read('/v1/events?limit=1');
  assert.equal(events.body.total_count, 2); assert.equal(events.body.has_more, true);
  const second = await read(`/v1/events?cursor=${events.body.next_cursor}`);
  assert.equal(second.body.data[0].seq, 2);
});

test('references restrict delete and currency changes, and read-only domains refuse all mutations', async t => {
  const {read} = await api(t);
  await read('/v1/collections/commerce.orders', {method: 'POST', body: {actor_id, record: order()}});
  assert.equal((await read('/v1/collections/commerce.products/product-a', {method: 'DELETE', body: {actor_id}})).body.error.code, 'reference_in_use');
  assert.equal((await read('/v1/collections/commerce.products/product-a', {method: 'PATCH', body: {actor_id, patch: {currency: 'USD'}}})).body.error.code, 'reference_conflict');
  for (const name of ['finance.customers', 'finance.suppliers', 'finance.bills', 'finance.payments', 'identity.people', 'custom.objects']) {
    const result = await read(`/v1/collections/${name}`, {method: 'POST', body: {actor_id, record: {id: 'new-record'}}});
    assert.equal(result.status, 403, name);
  }
  const removed = await read('/v1/collections/commerce.orders/order-a', {method: 'DELETE', body: {actor_id}});
  assert.equal(removed.body.event.type, 'domain.record.deleted.v1');
  assert.equal(removed.body.record, null);
  assert.equal((await read('/v1/collections/commerce.orders/order-a')).status, 404);
  assert.equal((await read('/v1/events')).body.total_count, 2);
});

test('social, support, and work writes validate their real relationship graph and retain unusual states', async t => {
  const {read} = await api(t);
  const records = [
    ['work.projects', {id: 'project-new', name: 'Project', owner_id: actor_id, member_ids: [actor_id]}],
    ['work.tasks', {id: 'task-new', title: 'Task', project_id: 'project-new', assignee_id: actor_id, reporter_id: actor_id, status: 'En attente de contrôle'}],
    ['work.time_entries', {id: 'time-new', task_id: 'task-new', person_id: actor_id, minutes: 25, date: '2026-09-06'}],
    ['support.cases', {id: 'case-new', title: 'Case', owner_id: actor_id, contact_id: actor_id, customer_id: 'customer-a'}],
    ['social.posts', {id: 'post-new', author_id: actor_id, title: 'Post', body: 'Text', product_ids: ['product-a']}],
    ['social.reviews', {id: 'review-new', author_id: actor_id, product_id: 'product-a', body: 'Review', rating: 5}],
    ['social.comments', {id: 'comment-new', author_id: actor_id, parent_kind: 'review', parent_id: 'review-new', body: 'Comment'}],
  ];
  for (const [name, record] of records) assert.equal((await read(`/v1/collections/${name}`, {method: 'POST', body: {actor_id, record}})).status, 201, name);
  assert.equal((await read('/v1/collections/work.projects/project-new', {method: 'DELETE', body: {actor_id}})).status, 409);
  assert.equal((await read('/v1/collections/social.comments/comment-new', {method: 'PATCH', body: {actor_id, patch: {parent_kind: 'post'}}})).status, 400);
  assert.equal((await read('/v1/collections/social.reviews/review-new', {method: 'PATCH', body: {actor_id, patch: {rating: 6}}})).status, 400);
  assert.equal((await read('/v1/events')).body.total_count, records.length);
});

test('record cursors cannot cross collections or hide concurrent writes', async t => {
  const rows = collections(); rows['commerce.orders'] = [order('order-a'), order('order-b')];
  const {read} = await api(t, fixture(t, rows));
  const first = await read('/v1/collections/commerce.orders?limit=1');
  const cursor = first.body.next_cursor;
  assert.equal((await read(`/v1/collections/commerce.products?cursor=${cursor}`)).status, 400);
  await read('/v1/collections/commerce.orders/order-a', {method: 'PATCH', body: {actor_id, patch: {status: 'packed'}}});
  assert.equal((await read(`/v1/collections/commerce.orders?cursor=${cursor}`)).body.error.code, 'stale_cursor');
});

test('normal restart preserves writes; stopped baseline restore returns exact source and clears accepted events', t => {
  const config = fixture(t); let store = openDomainStore(config);
  const baseline = join(config.root, 'baseline'); store.close(); cpSync(join(config.statePath, 'domain'), baseline, {recursive: true});
  store = openDomainStore(config);
  store.mutate('commerce.orders', 'create', {actor_id, record: order()}); store.close();
  store = openDomainStore(config); assert.deepEqual(store.detail('commerce.orders', 'order-a').record, order()); assert.equal(store.listEvents().total_count, 1); store.close();
  rmSync(join(config.statePath, 'domain'), {recursive: true}); cpSync(baseline, join(config.statePath, 'domain'), {recursive: true});
  store = openDomainStore(config);
  assert.equal(store.listRecords('commerce.orders').total_count, 0); assert.equal(store.listEvents().total_count, 0);
  assert.deepEqual(store.listRecords('commerce.products').data, collections()['commerce.products']); store.close();
});

test('artifact mismatch, malformed seed and missing paths fail before changing prior state', t => {
  const config = fixture(t); const store = openDomainStore(config); store.close();
  const database = join(config.statePath, 'domain/state.sqlite'), before = readFileSync(database);
  const other = fixture(t, collections(), 'another.world');
  assert.throws(() => openDomainStore({...other, statePath: config.statePath}), /different artifact/);
  assert.deepEqual(readFileSync(database), before);
  writeFileSync(join(other.worldPath, 'projections/domain.json'), '{}');
  assert.throws(() => loadDomainProjection(other.worldPath), /changed artifact file/);
  assert.equal(existsSync(other.statePath), false);
  assert.throws(() => loadDomainProjection(), /WORLD_PATH is required/);
  assert.throws(() => openDomainStore({...config, token: undefined}), /DOMAIN_TOKEN/);
  const accepted = openDomainStore(config);
  try {
    assert.throws(() => accepted.mutate('commerce.orders', 'create', {
      actor_id, record: {...order(), total_cents: 1},
    }), /total_cents/);
    assert.equal(accepted.listRecords('commerce.orders').total_count, 0);
    assert.equal(accepted.listEvents().total_count, 0);
  } finally { accepted.close(); }
});

test('HTTP body limits and malformed JSON leave the service ready without accepted events', async t => {
  const {service, read} = await api(t);
  const origin = `http://127.0.0.1:${service.server.address().port}`;
  for (const [body, contentType, expected] of [['{', 'application/json', 400], ['{}', 'text/plain', 415], [JSON.stringify({padding: 'x'.repeat(1024 * 1024)}), 'application/json', 413]]) {
    const response = await fetch(`${origin}/v1/collections/commerce.orders`, {method: 'POST', headers: {authorization: `Bearer ${token}`, 'content-type': contentType}, body});
    assert.equal(response.status, expected); await response.text();
    assert.equal((await read('/readyz')).body.ready, true);
    assert.equal((await read('/v1/events')).body.total_count, 0);
  }
});

test('split UTF-8 request chunks preserve the exact authored record', async t => {
  const {service, read} = await api(t);
  const {request} = await import('node:http');
  const record = {id: 'unicode-product', name: 'Lainé 🧵', price_cents: 1, currency: 'EUR', status: 'active'};
  const bytes = Buffer.from(JSON.stringify({actor_id, record}));
  const split = bytes.indexOf(Buffer.from('🧵')) + 2;
  const result = await new Promise((resolve, reject) => {
    const req = request({host: '127.0.0.1', port: service.server.address().port, path: '/v1/collections/commerce.products', method: 'POST', headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'}}, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve({status: response.statusCode, body: JSON.parse(Buffer.concat(chunks))}));
    });
    req.on('error', reject); req.write(bytes.subarray(0, split)); setTimeout(() => req.end(bytes.subarray(split)), 10);
  });
  assert.equal(result.status, 201); assert.deepEqual(result.body.record, record);
  assert.deepEqual((await read('/v1/collections/commerce.products/unicode-product')).body.record, record);
});

test('the normal executable preserves accepted records and events across a process restart', async t => {
  const {spawn} = await import('node:child_process');
  const {createServer} = await import('node:net');
  const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const config = fixture(t), origin = `http://127.0.0.1:${port}`;
  const start = async () => {
    const child = spawn(process.execPath, [new URL('./server.mjs', import.meta.url).pathname], {env: {...process.env,
      WORLDFIXTURE_WORLD_PATH: config.worldPath, WORLDFIXTURE_WORLD_SHA256: config.expectedDigest, WORLDFIXTURE_STATE_PATH: config.statePath, DOMAIN_TOKEN: token, WORLDFIXTURE_DOMAIN_LISTEN: `127.0.0.1:${port}`}, stdio: 'ignore'});
    let exited = false; const closed = new Promise(resolve => child.once('exit', () => {exited = true; resolve();}));
    const stop = async () => {if (!exited) child.kill('SIGTERM'); await closed;};
    t.after(stop);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (exited) throw new Error('Domain executable exited before readiness');
      try {if ((await fetch(`${origin}/readyz`)).ok) return stop;} catch {}
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Domain executable readiness timed out');
  };
  const stop = await start();
  const created = await fetch(`${origin}/v1/collections/commerce.orders`, {method: 'POST', headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'}, body: JSON.stringify({actor_id, record: order()})});
  assert.equal(created.status, 201); const accepted = await created.json(); await stop();
  const stopAgain = await start();
  const get = async path => (await fetch(`${origin}${path}`, {headers: {authorization: `Bearer ${token}`}})).json();
  assert.deepEqual((await get('/v1/collections/commerce.orders/order-a')).record, order());
  assert.deepEqual((await get('/v1/events')).data, [accepted.event]); await stopAgain();
});

test('malformed event fields and impossible timestamps cannot enter the accepted journal', async t => {
  const {read} = await api(t);
  for (const extra of [{event: {id: 'injected-event'}}, {event_type: 'finance.payment.created.v1'}, {expected_version: 1}, {provenance: {artifact_sha256: 'foreign'}}]) {
    const result = await read('/v1/collections/commerce.orders', {method: 'POST', body: {actor_id, record: order(), ...extra}});
    assert.equal(result.status, 400); assert.equal((await read('/v1/events')).body.total_count, 0);
  }
  for (const created_at of ['2031-02-30T12:00:00Z', '2031-02-29T12:00:00+02:00', '2031-09-06T12:00:00']) {
    const result = await read('/v1/collections/commerce.orders', {method: 'POST', body: {actor_id, record: {...order(), created_at}}});
    assert.equal(result.status, 400, created_at); assert.equal((await read('/v1/events')).body.total_count, 0);
  }
  const valid = await read('/v1/collections/commerce.orders', {method: 'POST', body: {actor_id, record: {...order(), created_at: '2032-02-29T23:00:00-05:00'}}});
  assert.equal(valid.status, 201); assert.equal(valid.body.event.seq, 1);
  assert.equal(valid.body.event.provenance.write_scope, 'domain-only'); assert.equal(valid.body.event.provenance.provider_sync, false);
});

test('standalone entrypoint rejects a missing world with exit 64 before it creates state', async t => {
  const {spawnSync} = await import('node:child_process');
  const config = fixture(t);
  const result = spawnSync(process.execPath, [new URL('./server.mjs', import.meta.url).pathname], {env: {...process.env, WORLDFIXTURE_WORLD_PATH: '', WORLDFIXTURE_STATE_PATH: config.statePath, DOMAIN_TOKEN: token}, encoding: 'utf8'});
  assert.equal(result.status, 64);
  assert.equal(result.stderr.trim(), 'worldfixture: missing world: WORLDFIXTURE_WORLD_PATH is required');
  assert.equal(existsSync(config.statePath), false);
});
