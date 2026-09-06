import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';

export const OAUTH_PROVIDERS = ['apple', 'clerk', 'okta', 'google', 'microsoft', 'github', 'slack', 'linear', 'vercel'];
const POLICIES = {
  apple: ['oauth_clients', '/auth/authorize', '/auth/authorize/callback', '/auth/token', 'email', 'openid email name', null, true],
  clerk: ['oauth_applications', '/oauth/authorize', '/oauth/authorize/callback', '/oauth/token', 'user_ref', 'openid email profile', '/oauth/userinfo', false],
  okta: ['oauth_clients', '/oauth2/default/v1/authorize', '/oauth2/default/v1/authorize/callback', '/oauth2/default/v1/token', 'user_ref', 'openid email profile offline_access', '/oauth2/default/v1/userinfo', true],
  google: ['oauth_clients', '/o/oauth2/v2/auth', '/o/oauth2/v2/auth/callback', '/oauth2/token', 'email', 'openid email profile', '/oauth2/v2/userinfo', true],
  microsoft: ['oauth_clients', '/oauth2/v2.0/authorize', '/oauth2/v2.0/authorize/callback', '/oauth2/v2.0/token', 'email', 'openid email profile offline_access User.Read', '/oidc/userinfo', true],
  github: ['oauth_apps', '/login/oauth/authorize', '/login/oauth/callback', '/login/oauth/access_token', 'login', 'repo user', '/user', false],
  slack: ['oauth_apps', '/oauth/v2/authorize', '/oauth/v2/authorize/callback', '/api/oauth.v2.access', 'user_id', 'chat:write channels:read', '/api/auth.test', false],
  linear: ['oauth_apps', '/oauth/authorize', '/oauth/authorize/callback', '/oauth/token', 'user_ref', 'read write', '/graphql', true],
  vercel: ['integrations', '/oauth/authorize', '/oauth/authorize/callback', '/login/oauth/token', 'username', 'user', '/login/oauth/userinfo', false],
};
const sha = value => createHash('sha256').update(value).digest('hex');
const array = value => Array.isArray(value) ? value : [];
const htmlText = value => String(value).replace(/&(?:amp|quot|apos|lt|gt|#39);/g, entity => ({ '&amp;': '&', '&quot;': '"', '&apos;': "'", '&#39;': "'", '&lt;': '<', '&gt;': '>' })[entity]);
const requireProof = (value, message) => { if (!value) throw new Error(message); };

// A test source fragment, not an overlay injected after artifact validation.
// Each resulting artifact records these application identities in world.json.
export function testOAuthDeclarations(world) {
  const suffix = sha(`${world.id}:${world.version}`).slice(0, 16);
  return Object.fromEntries(OAUTH_PROVIDERS.map(provider => [provider, [{
    client_id: `wf-coupling-${provider}-${suffix}`, name: `${world.id} ${world.version} ${provider} OAuth test`,
    redirect_uris: [`http://localhost:3123/coupling/${provider}/${suffix}`, `http://localhost:3123/coupling/${provider}/${suffix}?variant=second`],
    scopes: POLICIES[provider][5].split(' '), primary: true,
    grant_types: POLICIES[provider][7] ? ['authorization_code', 'refresh_token'] : ['authorization_code'],
    ...(provider === 'slack' ? { user_scopes: ['users:read'], bot_name: `coupling-${suffix}` } : {}),
    ...(provider === 'linear' ? { actor: 'user' } : {}),
    ...(provider === 'apple' ? { team_id: `test-${suffix}`, key_id: `key-${suffix}` } : {}),
  }]]));
}

function routes(provider, client) {
  const policy = [...POLICIES[provider]];
  if (provider === 'okta') {
    const prefix = client.auth_server_id === 'org' ? '/oauth2/v1/' : `/oauth2/${encodeURIComponent(client.auth_server_id ?? 'default')}/v1/`;
    for (const index of [1, 2, 3, 6]) policy[index] = policy[index].replace('/oauth2/default/v1/', prefix);
  }
  return policy;
}

function appleIdentity(encoded, keys, { issuer, clientId, nonce, person }) {
  const pieces = String(encoded).split('.');
  requireProof(pieces.length === 3, 'Apple returned no signed identity');
  const header = JSON.parse(Buffer.from(pieces[0], 'base64url')), claims = JSON.parse(Buffer.from(pieces[1], 'base64url'));
  const jwk = array(keys).find(key => key.kid === header.kid && key.kty === 'RSA');
  requireProof(header.alg === 'RS256' && jwk && verify('RSA-SHA256', Buffer.from(pieces.slice(0, 2).join('.')), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(pieces[2], 'base64url')), 'Apple identity signature is invalid');
  requireProof(claims.iss === issuer && array([claims.aud].flat()).includes(clientId) && claims.nonce === nonce && claims.email === person.email && claims.sub && claims.exp > Date.now() / 1000, 'Apple identity claims differ from the source user/client');
  return { email: claims.email, subject: claims.sub };
}

/** All expectations come from source clients and source people. API evidence
 * proves each declared callback/client grant; projection values supply no IDs.
 * resetImpl must call the product's normal reset API, never mutate store rows.
 */
export async function probeDeclaredOAuthWorld({ artifact, bindings, credentials, fetchImpl = fetch, resetImpl, signal }) {
  const checks = [], responses = [], coverage = [], pending = [];
  const source = artifact.world.software?.oauth_clients ?? {};
  const person = array(artifact.world.people).find(row => row.primary);
  const check = (name, passed, detail = {}) => checks.push({ check: name, status: passed ? 'passed' : 'failed', finding: 11, ...detail });
  const active = [];
  const call = async (provider, path, { fields, bearer, json, ...options } = {}) => {
    signal?.throwIfAborted();
    const base = bindings[`${provider.toUpperCase()}_BASE_URL`];
    requireProof(base, `Missing ${provider.toUpperCase()}_BASE_URL`);
    const response = await fetchImpl(`${base.replace(/\/$/, '')}${path}`, {
      redirect: 'manual', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
      ...(fields || json ? { method: 'POST', body: fields ? new URLSearchParams(fields) : JSON.stringify(json) } : {}), ...options,
      headers: { accept: 'application/json', ...(fields ? { 'content-type': 'application/x-www-form-urlencoded' } : json ? { 'content-type': 'application/json' } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...options.headers },
    });
    const text = await response.text();
    let body; try { body = JSON.parse(text); } catch { body = Object.fromEntries(new URLSearchParams(text)); }
    // Record only hashes and outcomes, never authorization codes or grants.
    responses.push({ provider, path: path.split('?')[0], status: response.status, body: { bytes: Buffer.byteLength(text), sha256: sha(text), error: body?.error ?? null, grant_issued: Boolean(body?.access_token), redirected: Boolean(response.headers.get('location')) } });
    return { status: response.status, ok: response.ok, body, text, location: response.headers.get('location') };
  };
  const denied = result => [400, 401, 403].includes(result.status) && !result.body?.access_token && !result.location;
  async function clientFlow(provider, client, redirectUri, label, { leavePending = false } = {}) {
    const [, authorizePath, callbackPath, tokenPath, identityField, defaultScope, identityPath, nativeRefresh] = routes(provider, client);
    const publicClient = provider === 'clerk' && client.is_public || provider === 'okta' && client.token_endpoint_auth_method === 'none';
    const reference = client.client_secret_ref ?? `oauth-client-secret:${provider}:${client.client_id}`;
    const secret = credentials?.values?.[reference] ?? (bindings[`${provider.toUpperCase()}_CLIENT_ID`] === client.client_id ? bindings[`${provider.toUpperCase()}_CLIENT_SECRET`] : undefined);
    requireProof(publicClient || secret, `No generated current secret for declared client ${client.client_id}`);
    if (client.public_key) throw Object.assign(new Error('Apple signing-key declaration needs a current signed client assertion; this reader has no private signing credential'), { failure_kind: 'reader_gap' });
    if (client.grant_types && !client.grant_types.includes('authorization_code')) throw Object.assign(new Error('The OAuth reader has no full application identity read for a client without an authorization_code grant'), { failure_kind: 'reader_gap' });
    const scope = client.scopes ? client.scopes.filter(value => value !== '.default').join(' ') : defaultScope;
    const state = randomUUID(), nonce = randomUUID(), verifier = randomUUID() + randomUUID();
    const fields = { client_id: client.client_id, redirect_uri: redirectUri, response_type: 'code', scope, state, nonce,
      ...(provider === 'slack' ? { user_scope: array(client.user_scopes).join(' ') } : {}),
      ...(publicClient ? { code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' } : {}) };
    const authorize = await call(provider, `${authorizePath}?${new URLSearchParams(fields)}`);
    requireProof(authorize.status === 200, `Declared client authorization returned HTTP ${authorize.status}`);
    requireProof(htmlText(authorize.text).includes(client.name), 'Authorization page omitted or changed the source application name');
    if (Array.isArray(client.scopes)) {
      const invalidScope = await call(provider, `${authorizePath}?${new URLSearchParams({ ...fields, scope: 'coupling:undeclared-scope' })}`);
      requireProof(denied(invalidScope) && invalidScope.body.error === 'invalid_scope', 'An undeclared scope was accepted');
    }
    const identityForm = [...authorize.text.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/gi)].map(match => match[0]).find(form => htmlText(form).includes(person.email));
    const identity = identityField === 'email' ? person.email
      : htmlText(new RegExp(`name="${identityField}"[^>]*value="([^"]+)"`).exec(identityForm ?? '')?.[1] ?? '');
    requireProof(identity, 'Authorization page has no public user selector for the exact source email');
    const callbackFields = { ...fields, [identityField]: identity };
    const alteredRedirect = `${redirectUri}${redirectUri.includes('?') ? '&' : '?'}undeclared=1`;
    requireProof(denied(await call(provider, callbackPath, { fields: { ...callbackFields, redirect_uri: alteredRedirect } })), 'An undeclared redirect was accepted');
    const consent = await call(provider, callbackPath, { fields: callbackFields });
    requireProof(consent.status === 302 && consent.location, `Declared callback returned HTTP ${consent.status}`);
    const callback = new URL(consent.location), code = callback.searchParams.get('code');
    requireProof(code && callback.searchParams.get('state') === state, 'Declared callback omitted its code or changed state');
    for (const key of ['code', 'state', 'user']) callback.searchParams.delete(key);
    requireProof(callback.href === new URL(redirectUri).href, 'Declared callback destination changed');
    const tokenFields = { grant_type: 'authorization_code', code, client_id: client.client_id, redirect_uri: redirectUri,
      ...(publicClient ? { code_verifier: verifier } : { client_secret: secret }) };
    if (leavePending) { pending.push({ provider, client, redirectUri, tokenPath, tokenFields }); return; }
    if (!publicClient) requireProof(denied(await call(provider, tokenPath, { fields: { ...tokenFields, client_secret: 'coupling-wrong-current-secret' } })), 'An incorrect current client secret was accepted');
    const token = await call(provider, tokenPath, { fields: tokenFields });
    requireProof(token.ok && token.body.access_token, `Declared token exchange failed: HTTP ${token.status} ${token.body.error ?? ''}`);
    let identityResult;
    if (provider === 'apple') {
      const discovery = await call(provider, '/.well-known/openid-configuration'), keys = await call(provider, '/auth/keys');
      requireProof(discovery.ok && keys.ok, 'Apple signing key/discovery API failed');
      identityResult = appleIdentity(token.body.id_token, keys.body.keys, { issuer: discovery.body.issuer, clientId: client.client_id, nonce, person });
    } else {
      const bearer = provider === 'slack' ? token.body.authed_user?.access_token : token.body.access_token;
      requireProof(bearer, 'No source-user access token was issued');
      const read = await call(provider, identityPath, { bearer, ...(provider === 'slack' ? { method: 'POST' } : {}), ...(provider === 'linear' ? { json: { query: 'query { viewer { id email } }' } } : {}) });
      requireProof(read.ok && !read.body.error && !read.body.errors && read.body.ok !== false, 'Granted source identity API failed');
      identityResult = provider === 'linear' ? read.body.data?.viewer : read.body;
      if (provider === 'slack') {
        requireProof(identityResult.user_id === identity, 'Granted user identity differs from the source person');
        const user = await call(provider, '/api/users.info', { bearer, fields: { user: identityResult.user_id } });
        requireProof(user.ok && user.body.ok && user.body.user?.profile?.email === person.email, 'Granted user identity differs from the source person');
        identityResult = { ...identityResult, email: user.body.user.profile.email };
      } else {
        requireProof(identityResult?.email === person.email, 'Granted user identity differs from the source person');
      }
    }
    check(`${label}.source-identity`, true, { expected: { source_person_id: person.id, email: person.email }, actual: identityResult });
    requireProof(denied(await call(provider, tokenPath, { fields: tokenFields })), 'A consumed authorization code was accepted again');
    const expectRefresh = (client.grant_types ?? (nativeRefresh ? ['authorization_code', 'refresh_token'] : ['authorization_code'])).includes('refresh_token');
    if (expectRefresh) {
      requireProof(token.body.refresh_token, 'Declared refresh grant was not issued');
      const refreshFields = { grant_type: 'refresh_token', client_id: client.client_id, refresh_token: token.body.refresh_token, ...(publicClient ? {} : { client_secret: secret }) };
      if (!publicClient) requireProof(denied(await call(provider, tokenPath, { fields: { ...refreshFields, client_secret: 'coupling-wrong-current-secret' } })), 'Refresh accepted an incorrect client secret');
      const refresh = await call(provider, tokenPath, { fields: refreshFields });
      requireProof(refresh.ok && refresh.body.access_token, 'Declared refresh grant failed');
      pending.push({ provider, tokenPath, refreshFields: { ...refreshFields, refresh_token: refresh.body.refresh_token ?? token.body.refresh_token } });
    }
    if (client.grant_types?.includes('client_credentials')) {
      const appFields = { grant_type: 'client_credentials', client_id: client.client_id, client_secret: secret, scope: client.scopes?.includes('.default') ? '.default' : scope || '.default' };
      requireProof(denied(await call(provider, tokenPath, { fields: { ...appFields, client_secret: 'coupling-wrong-current-secret' } })), 'Application grant accepted an incorrect client secret');
      const applicationGrant = await call(provider, tokenPath, { fields: appFields });
      requireProof(applicationGrant.ok && applicationGrant.body.access_token, 'Declared application grant failed');
      check(`${label}.client-credentials`, true);
    }
    check(`${label}.grant-lifecycle`, true, { actual: { client_id: client.client_id, redirect_uri: redirectUri, source_person_id: person.id, refresh: expectRefresh } });
  }
  for (const [provider, clients] of Object.entries(source)) {
    const start = checks.length, collection = `software.oauth_clients.${provider}`;
    if (!POLICIES[provider]) { check(`oauth.${provider}.reader`, false, { failure_kind: 'reader_gap', detail: 'No supported OAuth route contract exists for this declared provider.' }); continue; }
    const tokenPath = routes(provider, array(clients)[0] ?? {})[3];
    try {
      requireProof(Array.isArray(clients), 'Source client declaration is not an array');
      const unknown = await call(provider, tokenPath, { fields: { grant_type: 'authorization_code', client_id: `coupling-undeclared-${randomUUID()}`, client_secret: 'coupling-unknown-secret', code: 'not-issued', redirect_uri: 'http://localhost:3123/unknown' } });
      requireProof(denied(unknown) && unknown.body.error === 'invalid_client', 'Unknown client was not rejected at client authentication');
      check(`oauth.${provider}.unknown-client`, true);
      if (clients.length) requireProof(person?.email, 'Source primary person has no email');
      for (const client of clients) {
        const clientStart = checks.length;
        for (const [index, redirectUri] of array(client.redirect_uris).entries()) {
          const label = `oauth.${provider}.${client.client_id}.redirect-${index}`;
          try { await clientFlow(provider, client, redirectUri, label); }
          catch (error) { check(label, false, { detail: error.message, ...(error.failure_kind ? { failure_kind: error.failure_kind } : {}) }); }
        }
        if (!checks.slice(clientStart).some(row => row.status === 'failed')) active.push({ provider, client });
      }
    } catch (error) { check(`oauth.${provider}.reader`, false, { detail: error.message }); }
    const status = checks.slice(start).some(row => row.status === 'failed') ? 'failed' : 'passed';
    coverage.push({ collection, provider, path: tokenPath, status, detail: 'Every source client and exact callback exercised through native authorization, token and source identity APIs; unknown client rejected. Reset is reported separately.' });
    for (const field of ['redirect_uris', 'scopes', 'user_scopes', 'grant_types', 'response_types']) if (array(clients).some(client => Array.isArray(client[field]))) {
      coverage.push({ collection: `${collection}[].${field}`, provider, path: tokenPath, status, detail: 'Source OAuth policy applied to actual authorization/grant requests; no projection-only evidence.' });
    }
  }
  if (resetImpl && active.length) {
    try {
      for (const { provider, client } of active) await clientFlow(provider, client, client.redirect_uris[0], `oauth.${provider}.pending`, { leavePending: true });
      await resetImpl();
      check('oauth.normal-reset', true);
      for (const entry of pending) {
        const result = await call(entry.provider, entry.tokenPath, { fields: entry.tokenFields ?? entry.refreshFields });
        check(`oauth.${entry.provider}.reset-${entry.tokenFields ? 'code' : 'refresh'}-rejected`, denied(result) && result.body.error === 'invalid_grant');
      }
      for (const { provider, client } of active) {
        try { await clientFlow(provider, client, client.redirect_uris[0], `oauth.${provider}.${client.client_id}.after-reset`); }
        catch (error) { check(`oauth.${provider}.${client.client_id}.after-reset`, false, { detail: error.message }); }
      }
    } catch (error) { check('oauth.normal-reset', false, { detail: error.message }); }
  }
  if (resetImpl && checks.some(row => row.status === 'failed' && row.check === 'oauth.normal-reset')) {
    for (const row of coverage) row.status = 'failed';
  }
  for (const row of coverage) if (checks.some(check => check.status === 'failed' && check.check.startsWith(`oauth.${row.provider}.`))) row.status = 'failed';
  return { checks, responses, coverage };
}
