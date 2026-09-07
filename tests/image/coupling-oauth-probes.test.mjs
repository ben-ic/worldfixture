import assert from 'node:assert/strict';
import test from 'node:test';
import { probeDeclaredOAuthWorld, testOAuthDeclarations, OAUTH_PROVIDERS } from './coupling-oauth-probes.mjs';
import { wrapDeclaredOAuthExtra } from '../../emulators/emulate/src/overrides/declared-oauth-extra.mjs';
import { wrapDeclaredOAuth } from '../../emulators/emulate/src/overrides/declared-oauth.mjs';

const packageUrl = path => new URL(`../../emulators/emulate/node_modules/${path}`, import.meta.url);
const { createServer } = await import(packageUrl('@emulators/core/dist/index.js'));
const sourcePerson = { id: 'tavi', name: 'Tavi', primary: true, email: 'tavi@authored.test', github_login: 'tavi' };
const sourceWorld = { id: 'test.oauth-world', version: 'v1', people: [sourcePerson] };
const keys = { apple: 'oauth_clients', clerk: 'oauth_applications', okta: 'oauth_clients', google: 'oauth_clients', microsoft: 'oauth_clients', github: 'oauth_apps', slack: 'oauth_apps', linear: 'oauth_apps', vercel: 'integrations' };
async function fixture(provider, { empty = false } = {}) {
  const mod = provider === 'linear' ? await import(packageUrl('emulate/dist/dist-7HIQBPU6.js')) : await import(packageUrl(`@emulators/${provider}/dist/index.js`));
  const row = testOAuthDeclarations(sourceWorld)[provider][0];
  const config = { users: [{ email: sourcePerson.email, name: sourcePerson.name, login: sourcePerson.github_login, username: sourcePerson.github_login, first_name: 'Tavi', last_name: '', email_addresses: [sourcePerson.email] }], [keys[provider]]: empty ? [] : [{ ...row, client_secret: 'current-source-secret' }] };
  if (provider === 'slack') { config.users[0].name = 'tavi'; config.users[0].real_name = 'Tavi'; config.team = { name: 'Authored workspace', domain: 'authored' }; }
  if (provider === 'linear') { config.organization = { name: 'Authored organization', url_key: 'authored' }; config.teams = [{ name: 'Authored team', key: 'OWN' }]; config.strict_scopes = false; }
  const lifecycle = ['apple', 'clerk', 'okta'].includes(provider) ? wrapDeclaredOAuth(provider, mod[`${provider}Plugin`], mod.seedFromConfig)
    : wrapDeclaredOAuthExtra(provider, mod[`${provider}Plugin`], mod.seedFromConfig, { getStore: mod.getLinearStore });
  const server = createServer(lifecycle.plugin);
  lifecycle.seedFromConfig(server.store, server.baseUrl, config, server.webhooks);
  const snapshot = JSON.parse(JSON.stringify(server.store.snapshot()));
  const artifact = { world: { ...sourceWorld, software: { oauth_clients: { [provider]: empty ? [] : [row] } } } };
  return { artifact, bindings: { [`${provider.toUpperCase()}_BASE_URL`]: 'http://local.test' }, credentials: { values: { [`oauth-client-secret:${provider}:${row.client_id}`]: 'current-source-secret' } },
    fetchImpl: (url, options) => server.app.request(url, options), resetImpl: async () => { server.store.restore(JSON.parse(JSON.stringify(snapshot))); }, server };
}

test('test applications are deterministic source declarations with world-specific identity and no secret', () => {
  const first = testOAuthDeclarations(sourceWorld);
  assert.deepEqual(first, testOAuthDeclarations(sourceWorld));
  assert.notDeepEqual(first, testOAuthDeclarations({ ...sourceWorld, id: 'another-world' }));
  assert.deepEqual(Object.keys(first), OAUTH_PROVIDERS);
  assert.equal(JSON.stringify(first).includes('client_secret'), false);
});

for (const provider of OAUTH_PROVIDERS) test(`${provider} actual native lifecycle proves source client, user, exact redirects and reset`, async () => {
  const f = await fixture(provider);
  const result = await probeDeclaredOAuthWorld(f);
  assert.deepEqual(result.checks.filter(row => row.status === 'failed'), []);
  assert.ok(result.checks.some(row => row.check.endsWith('reset-code-rejected')));
  assert.ok(result.coverage.every(row => row.status === 'passed'));
  assert.equal(result.coverage.find(row => row.collection.endsWith('[].loopback_redirect_uris')).status, 'passed');
  for (const template of f.artifact.world.software.oauth_clients[provider][0].loopback_redirect_uris) {
    for (const port of [43123, 43124]) {
      const uri = new URL(template);
      uri.port = String(port);
      assert.ok(result.checks.some(row => row.check.endsWith('grant-lifecycle') && row.actual.redirect_uri === uri.href));
    }
  }
  const text = JSON.stringify(result);
  assert.equal(text.includes('current-source-secret'), false);
  assert.equal(text.includes('refresh_token":"'), false);
  assert.ok(result.responses.some(row => row.body.grant_issued));
});

test('a loopback redirect rejected by the provider fails measured policy coverage', async () => {
  const f = await fixture('google');
  const result = await probeDeclaredOAuthWorld({ ...f, resetImpl: undefined, fetchImpl: (url, options) => {
    const request = new URL(url);
    const redirect = request.searchParams.get('redirect_uri');
    return request.pathname === '/o/oauth2/v2/auth' && redirect && new URL(redirect).port === '43124'
      ? Promise.resolve(Response.json({ error: 'invalid_request' }, { status: 400 })) : f.fetchImpl(url, options);
  } });
  assert.ok(result.checks.some(row => row.status === 'failed' && row.detail?.includes('authorization returned HTTP 400')));
  assert.equal(result.coverage.find(row => row.collection.endsWith('[].loopback_redirect_uris')).status, 'failed');
});

for (const provider of ['github', 'slack', 'vercel']) test(`${provider} OAuth proves a person without authored native login fields`, async () => {
  const f = await fixture(provider);
  f.artifact.world.people = [{ ...sourcePerson }];
  delete f.artifact.world.people[0].github_login;
  const result = await probeDeclaredOAuthWorld(f);
  assert.deepEqual(result.checks.filter(row => row.status === 'failed'), []);
  const path = provider === 'slack' ? '/api/users.info' : provider === 'github' ? '/user' : '/login/oauth/userinfo';
  const foreign = await probeDeclaredOAuthWorld({ ...f, resetImpl: undefined, fetchImpl: (url, options) => url.endsWith(path)
    ? Promise.resolve(Response.json(provider === 'slack' ? { ok: true, user: { profile: { email: 'foreign@other.test' } } } : { email: 'foreign@other.test' }))
    : f.fetchImpl(url, options) });
  assert.ok(foreign.checks.some(row => row.detail?.includes('identity differs')));
  assert.equal(foreign.coverage[0].status, 'failed');
});

for (const provider of OAUTH_PROVIDERS) test(`${provider} empty source client arrays need real rejection evidence`, async () => {
  const f = await fixture(provider, { empty: true });
  const result = await probeDeclaredOAuthWorld(f);
  assert.deepEqual(result.checks.filter(row => row.status === 'failed'), []);
  assert.equal(result.coverage[0].status, 'passed');
  assert.equal(result.responses.length, 1);
  const accepted = await probeDeclaredOAuthWorld({ ...f, fetchImpl: async () => Response.json({ access_token: 'foreign-grant' }) });
  assert.equal(accepted.coverage[0].status, 'failed');
});

test('missing generated secret and foreign user identity fail content coverage', async () => {
  const f = await fixture('google');
  const missing = await probeDeclaredOAuthWorld({ ...f, credentials: { values: {} } });
  assert.ok(missing.checks.some(row => row.detail?.includes('No generated current secret')));
  assert.equal(missing.coverage[0].status, 'failed');
  const foreign = await probeDeclaredOAuthWorld({ ...f, resetImpl: undefined, fetchImpl: (url, options) => url.endsWith('/userinfo') ? Promise.resolve(Response.json({ email: 'foreign@other.test' })) : f.fetchImpl(url, options) });
  assert.ok(foreign.checks.some(row => row.detail?.includes('identity differs')));
  assert.equal(foreign.coverage[0].status, 'failed');
});

test('reset that leaves a pending native code usable fails lifecycle and coverage', async () => {
  const f = await fixture('google');
  const result = await probeDeclaredOAuthWorld({ ...f, resetImpl: async () => {} });
  assert.ok(result.checks.some(row => row.check === 'oauth.google.reset-code-rejected' && row.status === 'failed'));
  assert.equal(result.coverage[0].status, 'failed');
});

test('changed declared application name fails even when a matching source user can sign in', async () => {
  const f = await fixture('google');
  f.artifact.world.software.oauth_clients.google[0].name = 'Changed source application';
  const result = await probeDeclaredOAuthWorld(f);
  assert.ok(result.checks.some(row => row.detail?.includes('application name')));
  assert.equal(result.coverage[0].status, 'failed');
});
