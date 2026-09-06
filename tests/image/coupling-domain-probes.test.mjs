import assert from 'node:assert/strict';
import test from 'node:test';
import {domainPages, probeDomainWorld, sourceDomainCollections} from './coupling-domain-probes.mjs';

function fixture() {
  const world = {id: 'quiet-workshop', version: 'v7', people: [{id: 'person-47.uncommon', name: 'Tavi', organization_id: null}], organizations: [],
    commerce: {products: [{id: 'product-a', name: 'One', extra: {material: 'Wool'}}], orders: [{id: 'order:/one', items: [{product_id: 'product-a', quantity: 2}], total_cents: 123}]},
    social: {posts: [{id: 'post-one', product_ids: ['product-a'], tags: [], metadata: {links: [{href: '/unusual'}]}}], reviews: []},
    finance: {anchor_invoices: [{id: 'invoice-a', amount_cents: 10}], resolved: {invoices: [{id: 'invoice-a', amount_cents: 10}, {id: 'invoice-generated', amount_cents: 20}], payments: []}}};
  const expected = sourceDomainCollections(world);
  const projected = Object.fromEntries(Object.entries(expected).map(([name, {records}]) => [name, structuredClone(records)]));
  const artifact = {world, identity: {digest: 'abc123'}, projections: {domain: {api_version: 'worldfixture.domain/v1', world: {id: world.id, version: world.version}, collections: projected}}};
  const wire = structuredClone(projected), calls = [];
  const bindings = {DOMAIN_BASE_URL: 'http://domain.test', DOMAIN_TOKEN: 'private-domain-test-value'};
  const identity = {id: world.id, version: world.version, artifact_sha256: 'abc123'};
  const response = (body, status = 200) => new Response(JSON.stringify(body), {status});
  const editable = new Set(['commerce.products', 'commerce.orders', 'social.posts', 'social.reviews']);
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url); calls.push(parsed.pathname + parsed.search);
    assert.equal(options.headers.authorization, `Bearer ${bindings.DOMAIN_TOKEN}`);
    assert.equal(options.method, 'GET');
    if (parsed.pathname === '/readyz') return response({ready: true, world: identity});
    const parts = parsed.pathname.split('/').map(decodeURIComponent), name = parts[3];
    if (parts[4]) {
      const record = wire[name]?.find(row => row.id === parts[4]);
      return record ? response({record, version: 1, world: identity}) : response({error: {code: 'not_found'}}, 404);
    }
    const rows = name ? wire[name] : Object.keys(wire).sort().map(name => ({name, count: wire[name].length, writable: editable.has(name), id_field: 'id', owner: editable.has(name) ? 'domain' : 'seed-view', write_scope: editable.has(name) ? 'domain-only' : 'read-only', provider_sync: false}));
    if (!rows) return response({error: {code: 'collection_not_found'}}, 404);
    const ordered = name ? [...rows].sort((a, b) => a.id < b.id ? -1 : 1) : rows;
    // Force multiple pages even when callers request 100.
    const offset = Number(parsed.searchParams.get('cursor') ?? 0), data = ordered.slice(offset, offset + 1), more = offset + data.length < rows.length;
    return response({data, has_more: more, next_cursor: more ? String(offset + 1) : null, total_count: rows.length, world: identity});
  };
  return {artifact, bindings, fetchImpl, wire, calls, identity, response};
}
const failures = result => result.checks.filter(row => row.status === 'failed');

test('full source records, empty and nested arrays use complete live metadata/list/detail reads', async () => {
  const input = fixture(), result = await probeDomainWorld(input);
  assert.deepEqual(failures(result), []);
  for (const path of ['people', 'identity.people', 'organizations', 'commerce.orders[].items', 'social.posts[].product_ids', 'social.posts[].tags', 'social.posts[].metadata.links', 'social.reviews', 'finance.resolved.invoices', 'finance.anchor_invoices']) assert.equal(result.coverage.find(row => row.collection === path)?.status, 'passed', path);
  assert.ok(input.calls.some(path => path.includes('cursor=1')));
  assert.ok(input.calls.some(path => path.includes('order%3A%2Fone')));
  assert.equal(JSON.stringify(result).includes(input.bindings.DOMAIN_TOKEN), false);
});

test('dropping the same record from projection and API cannot remove the source expectation', async () => {
  const input = fixture(); input.wire['commerce.orders'] = []; input.artifact.projections.domain.collections['commerce.orders'] = [];
  const result = await probeDomainWorld(input);
  assert.ok(failures(result).some(row => row.check === 'domain.projection.commerce.orders.records'));
  assert.ok(failures(result).some(row => row.check === 'domain.api.commerce.orders.records'));
  assert.equal(result.coverage.find(row => row.collection === 'commerce.orders[].items').status, 'failed');
  assert.ok(result.responses.some(row => row.status === 404));
});

test('changed nested fields and foreign records fail even with unchanged identities', async () => {
  const input = fixture(); input.wire['social.posts'][0].metadata.links[0].href = '/wrong';
  input.wire['commerce.products'].push({id: 'foreign-item', name: 'Foreign'});
  const result = await probeDomainWorld(input);
  assert.ok(failures(result).some(row => row.check === 'domain.api.social.posts.post-one.fields'));
  assert.ok(failures(result).some(row => row.check === 'domain.api.commerce.products.records'));
  assert.equal(result.coverage.find(row => row.collection === 'social.posts[].metadata.links').status, 'failed');
});

test('an unknown empty source collection cannot disappear and a projection-only collection is a reader gap', async () => {
  const input = fixture(); input.artifact.world.commerce.new_records = []; input.artifact.projections.domain.collections['mystery.objects'] = [];
  const result = await probeDomainWorld(input);
  assert.equal(result.coverage.find(row => row.collection === 'commerce.new_records').status, 'failed');
  assert.ok(failures(result).some(row => row.check === 'domain.reader.mystery.objects' && row.failure_kind === 'reader_gap'));
});

test('resolved records cannot erase conflicting or missing authored invoice fields', async () => {
  const input = fixture(); input.artifact.world.finance.anchor_invoices[0].amount_cents = 999;
  const result = await probeDomainWorld(input);
  assert.ok(failures(result).some(row => row.check === 'domain.source.finance.invoices.invoice-a.resolved-completeness'));
  assert.equal(result.coverage.find(row => row.collection === 'finance.anchor_invoices').status, 'failed');
});

test('wrong artifact provenance and measured API failure produce failed collection evidence', async () => {
  const input = fixture(); input.identity.artifact_sha256 = 'another-artifact';
  let result = await probeDomainWorld(input);
  assert.ok(failures(result).some(row => row.detail?.includes('artifact provenance')));
  assert.ok(result.coverage.every(row => row.status === 'failed'));
  const unavailable = fixture(); unavailable.fetchImpl = async () => unavailable.response({error: 'unavailable'}, 503);
  result = await probeDomainWorld(unavailable);
  assert.ok(result.responses.every(row => row.status === 503));
  assert.ok(result.coverage.every(row => row.status === 'failed'));
});

test('missing bindings fail before any request and secrets are removed from API evidence', async () => {
  const input = fixture(); input.bindings.DOMAIN_TOKEN = '';
  const result = await probeDomainWorld(input);
  assert.equal(input.calls.length, 0); assert.ok(result.coverage.every(row => row.status === 'failed'));
  const secret = fixture(); secret.wire['commerce.products'][0].authorization = secret.bindings.DOMAIN_TOKEN;
  assert.equal(JSON.stringify(await probeDomainWorld(secret)).includes(secret.bindings.DOMAIN_TOKEN), false);
});

test('pagination rejects repeated IDs, changing counts, missing cursors, and incomplete final pages', async () => {
  const page = {data: [{id: 'a'}], total_count: 2, has_more: true, next_cursor: 'one'};
  await assert.rejects(domainPages(async () => page), /repeated record/);
  await assert.rejects(domainPages(async () => ({...page, next_cursor: null})), /continuation/);
  await assert.rejects(domainPages(async () => ({...page, has_more: false, next_cursor: null})), /total_count/);
  let count = 0;
  await assert.rejects(domainPages(async () => count++ ? {...page, data: [{id: 'b'}], total_count: 3} : page), /changed/);
});
