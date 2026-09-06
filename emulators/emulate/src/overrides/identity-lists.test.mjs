import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from '@emulators/core';
import { VENDORS } from '../registry.mjs';

const users = Array.from({ length: 137 }, (_, i) => ({ email: `person-${i}@declared.test`, name: `Person ${i}` }));
const headers = { authorization: 'Bearer current-directory-token' };
async function fixture(provider) {
  const lifecycle = await VENDORS[provider].load();
  const server = createServer(lifecycle.plugin, { tokens: {
    'current-directory-token': { login: users[0].email, id: 1, scopes: ['User.ReadBasic.All'] },
    'self-only-token': { login: users[0].email, id: 1, scopes: ['User.Read'] },
  } });
  const config = provider === 'clerk'
    ? { users: users.map(user => ({ email_addresses: [user.email], first_name: user.name })), organizations: [{ name: 'Declared organization', slug: 'declared' }] }
    : { users };
  lifecycle.seedFromConfig(server.store, server.baseUrl, config, server.webhooks);
  return server;
}

test('Microsoft public directory lists all native users through paging, with the required permission', async () => {
  const f = await fixture('microsoft'), found = [];
  for (const token of [undefined, 'unknown-token']) {
    const response = await f.app.request('/v1.0/users', { headers: token ? { authorization: `Bearer ${token}` } : {} });
    assert.equal(response.status, 401);
  }
  assert.equal((await f.app.request('/v1.0/users', { headers: { authorization: 'Bearer self-only-token' } })).status, 403);
  let path = '/v1.0/users?$top=43';
  do {
    const response = await f.app.request(path, { headers });
    assert.equal(response.status, 200);
    const page = await response.json();
    assert.ok(page.value.length <= 43);
    found.push(...page.value);
    path = page['@odata.nextLink'];
  } while (path);
  assert.equal(found.length, 137);
  assert.equal(new Set(found.map(user => user.id)).size, 137);
  assert.deepEqual(found.map(user => user.mail).sort(), users.map(user => user.email).sort());
  const detail = await (await f.app.request(`/v1.0/users/${found[0].id}`, { headers })).json();
  assert.deepEqual(Object.fromEntries(Object.entries(detail).filter(([key]) => key !== '@odata.context')), found[0]);
  const selected = await (await f.app.request('/v1.0/users?$top=1&$select=id,mail', { headers })).json();
  assert.deepEqual(Object.keys(selected.value[0]).sort(), ['id', 'mail']);
  assert.match(selected['@odata.nextLink'], /%24select=id%2Cmail/);
  for (const query of ['$top=0', '$top=1000', '$skip=3', '$skiptoken=bad', '$select=password']) {
    assert.equal((await f.app.request(`/v1.0/users?${query}`, { headers })).status, 400, query);
  }
  const snapshot = JSON.parse(JSON.stringify(f.store.snapshot()));
  f.store.restore(snapshot);
  const restored = await (await f.app.request('/v1.0/users?$top=999', { headers })).json();
  assert.deepEqual(restored.value, found);
});

test('Clerk public users returns an array while preserving native auth, paging, filters and organization envelopes', async () => {
  const f = await fixture('clerk'), found = [];
  const rejected = await f.app.request('/v1/users', { headers: { authorization: 'Bearer unknown-token' } });
  assert.equal(rejected.status, 401);
  assert.ok(Array.isArray((await rejected.json()).errors));
  for (let offset = 0; offset < 150; offset += 50) {
    const response = await f.app.request(`/v1/users?limit=50&offset=${offset}`, { headers });
    assert.equal(response.status, 200);
    const page = await response.json();
    assert.ok(Array.isArray(page));
    found.push(...page);
  }
  assert.equal(found.length, 137);
  assert.equal(new Set(found.map(user => user.id)).size, 137);
  assert.deepEqual(found.flatMap(user => user.email_addresses.map(email => email.email_address)).sort(), users.map(user => user.email).sort());
  const filtered = await (await f.app.request('/v1/users?email_address=person-7%40declared.test', { headers })).json();
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].email_addresses[0].email_address, 'person-7@declared.test');
  const orgs = await (await f.app.request('/v1/organizations', { headers })).json();
  assert.equal(orgs.total_count, 1);
  assert.equal(orgs.data[0].slug, 'declared');
  const count = await (await f.app.request('/v1/users/count', { headers })).json();
  assert.equal(count.total_count, 137);
});
