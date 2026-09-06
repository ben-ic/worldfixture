import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { createOAuth } from '../src/server/oauth.mjs';

const sessionId = 'test-session-with-at-least-32-characters';
const providers = ['slack', 'github', 'google', 'microsoft', 'apple'];
const env = Object.fromEntries(providers.map((id, index) => [`${id.toUpperCase()}_BASE_URL`, `http://127.0.0.1:${19000 + index}`]));
const pair = await generateKeyPair('RS256', { extractable: true });
const key = { ...await exportJWK(pair.publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' };

async function fixture({ badNonce = false, badAudience = false, refusal = false } = {}) {
  let authorization;
  let clock = Date.now();
  const requests = [];
  const oauth = createOAuth(env, { origin: () => 'http://127.0.0.1:15175', now: () => clock, fetcher: async (url, options = {}) => {
    requests.push({ url, options });
    assert.equal(options.redirect, 'error');
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/.well-known/openid-configuration')) return Response.json({ issuer: parsed.origin });
    if (['/auth/keys', '/oauth2/v3/certs', '/discovery/v2.0/keys'].includes(parsed.pathname)) return Response.json({ keys: [key] });
    if (options.method === 'POST' && parsed.pathname !== '/api/auth.test') {
      assert.equal(options.headers.Accept, 'application/json');
      assert.equal(options.headers['Content-Type'], 'application/x-www-form-urlencoded');
      const form = options.body;
      assert.equal(form.get('client_id'), 'account-desk-local');
      assert.equal(form.get('redirect_uri'), authorization.searchParams.get('redirect_uri'));
      if (authorization.searchParams.has('code_challenge')) assert.ok(form.get('code_verifier'));
      else assert.equal(form.get('code_verifier'), null);
      if (refusal) return Response.json({ error: 'invalid_code', error_description: 'DO-NOT-LEAK-provider-secret' });
      const idToken = await new SignJWT({ sub: 'selected-person', tid: 'world-tenant', nonce: badNonce ? 'wrong-nonce' : authorization.searchParams.get('nonce'), email: 'person@demo.test' })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setIssuer(parsed.origin).setAudience(badAudience ? 'wrong-app' : 'account-desk-local')
        .setIssuedAt(Math.floor(clock / 1000)).setExpirationTime(Math.floor(clock / 1000) + 3600).sign(pair.privateKey);
      return Response.json({ access_token: 'private-test-access-token', expires_in: 3600, id_token: idToken });
    }
    assert.equal(options.headers.Authorization, 'Bearer private-test-access-token');
    return Response.json({ id: 'selected-person', name: 'Selected person', email: 'person@demo.test' });
  } });
  return { oauth, requests, start(id) { authorization = new URL(oauth.start(id, { sessionId })); return authorization; }, advance(ms) { clock += ms; } };
}

test('OAuth starts only local selected providers and binds dynamic app callback', () => {
  const oauth = createOAuth(env, { origin: 'http://127.0.0.1:25175' });
  assert.equal(oauth.catalog().length, 5);
  for (const provider of providers) {
    const url = new URL(oauth.start(provider, { sessionId }));
    assert.equal(url.origin, env[`${provider.toUpperCase()}_BASE_URL`]);
    assert.equal(url.searchParams.get('redirect_uri'), `http://127.0.0.1:25175/oauth/${provider}/callback`);
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.ok(url.searchParams.get('state').length >= 40);
    assert.equal(url.searchParams.has('code_challenge'), ['google', 'microsoft'].includes(provider));
  }
  assert.throws(() => oauth.start('google'), /browser session/);
  assert.throws(() => oauth.start('unknown', { sessionId }), /no Account Desk OAuth/);
  assert.throws(() => createOAuth({}, { origin: 'http://127.0.0.1:3000' }).start('google', { sessionId }), /not selected/);
  assert.throws(() => createOAuth({ GOOGLE_BASE_URL: 'https://accounts.google.com' }, { origin: 'http://127.0.0.1:3000' }).start('google', { sessionId }), /Only local/);
  assert.throws(() => createOAuth({ ...env, NODE_ENV: 'production' }, { origin: 'http://127.0.0.1:3000' }).start('google', { sessionId }), /disabled in production/);
});

test('all five code flows exchange server-side and expose no tokens in safe metadata', async () => {
  for (const id of providers) {
    const fixtureData = await fixture();
    const url = fixtureData.start(id);
    const result = await fixtureData.oauth.callback(id, { state: url.searchParams.get('state'), code: 'one-time-code' }, { sessionId });
    assert.equal(result.connected, true);
    assert.equal(result.identity.email, 'person@demo.test');
    assert.equal(fixtureData.oauth.credentials()[`${id.toUpperCase()}_TOKEN`], 'private-test-access-token');
    assert.equal(JSON.stringify(fixtureData.oauth.catalog()).includes('private-test-access-token'), false);
    assert.equal(JSON.stringify(result).includes('private-test-access-token'), false);
    await assert.rejects(fixtureData.oauth.callback(id, { state: url.searchParams.get('state'), code: 'one-time-code' }, { sessionId }), /invalid or expired/);
    fixtureData.oauth.disconnect(id);
    assert.deepEqual(fixtureData.oauth.credentials(), {});
  }
});

test('OAuth refuses another browser, provider mismatch, duplicate state, and expired requests', async () => {
  const item = await fixture();
  const url = item.start('google');
  const params = { state: url.searchParams.get('state'), code: 'code' };
  await assert.rejects(item.oauth.callback('google', params, { sessionId: 'another-browser-session-123456789' }), /invalid or expired/);
  await assert.rejects(item.oauth.callback('github', params, { sessionId }), /invalid or expired/);
  await assert.rejects(item.oauth.callback('google', new URLSearchParams([['state', params.state], ['state', params.state], ['code', 'code']]), { sessionId }), /Invalid OAuth callback parameters/);
  assert.equal(item.requests.length, 0);
  item.advance(10 * 60 * 1000 + 1);
  await assert.rejects(item.oauth.callback('google', params, { sessionId }), /invalid or expired/);
});

test('OIDC validates signature claims and nonce before saving a connection', async () => {
  for (const options of [{ badNonce: true }, { badAudience: true }]) {
    const item = await fixture(options);
    const url = item.start('apple');
    await assert.rejects(item.oauth.callback('apple', { state: url.searchParams.get('state'), code: 'code' }, { sessionId }), /ID token verification failed/);
    assert.deepEqual(item.oauth.credentials(), {});
  }
});

test('provider errors are sanitized, consumed once, and expired grants stop being active', async () => {
  const item = await fixture({ refusal: true });
  const url = item.start('slack');
  const params = { state: url.searchParams.get('state'), code: 'code' };
  await assert.rejects(item.oauth.callback('slack', params, { sessionId }), (error) => /refused/.test(error.message) && !error.message.includes('DO-NOT-LEAK'));
  await assert.rejects(item.oauth.callback('slack', params, { sessionId }), /invalid or expired/);
  const valid = await fixture();
  const start = valid.start('microsoft');
  await valid.oauth.callback('microsoft', { state: start.searchParams.get('state'), code: 'code' }, { sessionId });
  valid.advance(3600 * 1000 + 1);
  assert.deepEqual(valid.oauth.credentials(), {});
  assert.equal(valid.oauth.catalog().find((entry) => entry.id === 'microsoft').state, 'expired');
});

function formFrom(html) {
  const decode = text => text.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>');
  const form = html.match(/<form\b[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/i);
  assert.ok(form, 'The local provider must show a form with a world user.');
  const params = new URLSearchParams();
  for (const match of form[2].matchAll(/<input\b[^>]*name="([^"]+)"[^>]*value="([^"]*)"[^>]*>/gi)) params.set(decode(match[1]), decode(match[2]));
  return { action: decode(form[1]), params };
}

test('live local providers: consent, code exchange, and confirmed identities', { skip: process.env.ACCOUNT_DESK_OAUTH_LIVE !== '1' }, async () => {
  const oauth = createOAuth(process.env, { origin: 'http://127.0.0.1:15175' });
  for (const id of providers) {
    const authorization = new URL(oauth.start(id, { sessionId }));
    const consent = await fetch(authorization, { redirect: 'error' });
    assert.equal(consent.status, 200, `${id}: consent`);
    const form = formFrom(await consent.text());
    const action = new URL(form.action, authorization);
    assert.equal(action.origin, authorization.origin);
    const approval = await fetch(action, { method: 'POST', body: form.params, redirect: 'manual' });
    let callbackParams;
    if (approval.status === 302) {
      const callbackUrl = new URL(approval.headers.get('location'));
      assert.equal(callbackUrl.origin, 'http://127.0.0.1:15175');
      callbackParams = callbackUrl.searchParams;
    } else {
      assert.equal(approval.status, 200, `${id}: form post response`);
      const posted = formFrom(await approval.text());
      assert.equal(new URL(posted.action).origin, 'http://127.0.0.1:15175');
      callbackParams = posted.params;
    }
    const result = await oauth.callback(id, callbackParams, { sessionId });
    assert.equal(result.connected, true, `${id}: connected`);
    assert.ok(result.identity.id, `${id}: confirmed account identity`);
    assert.ok(oauth.credentials()[`${id.toUpperCase()}_TOKEN`], `${id}: private credential available`);
  }
});
