import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { localUrl } from './security.mjs';

const PROVIDERS = {
  slack: { name: 'Slack', prefix: 'SLACK', authorize: '/oauth/v2/authorize', token: '/api/oauth.v2.access', profile: '/api/auth.test', profileMethod: 'POST', scope: 'channels:read,channels:history,groups:read,groups:history,im:read,im:history,mpim:read,mpim:history,users:read,chat:write' },
  github: { name: 'GitHub', prefix: 'GITHUB', authorize: '/login/oauth/authorize', token: '/login/oauth/access_token', profile: '/user', scope: 'repo read:user user:email' },
  google: { name: 'Google', prefix: 'GOOGLE', authorize: '/o/oauth2/v2/auth', token: '/oauth2/token', profile: '/oauth2/v2/userinfo', keys: '/oauth2/v3/certs', scope: 'openid email profile https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/drive', pkce: true },
  microsoft: { name: 'Microsoft', prefix: 'MICROSOFT', authorize: '/oauth2/v2.0/authorize', token: '/oauth2/v2.0/token', profile: '/v1.0/me', keys: '/discovery/v2.0/keys', scope: 'openid email profile User.Read', pkce: true },
  apple: { name: 'Apple', prefix: 'APPLE', authorize: '/auth/authorize', token: '/auth/token', keys: '/auth/keys', scope: 'name email' },
};
const random = () => randomBytes(32).toString('base64url');
const digest = (value) => createHash('sha256').update(value).digest();
const equal = (left, right) => typeof left === 'string' && typeof right === 'string' && timingSafeEqual(digest(left), digest(right));
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

function safeIdentity(profile, claims = {}) {
  return {
    id: String(profile.user_id ?? profile.id ?? claims.sub ?? ''),
    name: String(profile.name ?? profile.displayName ?? profile.user ?? profile.login ?? claims.name ?? claims.email ?? ''),
    email: String(profile.email ?? profile.mail ?? profile.userPrincipalName ?? claims.email ?? ''),
  };
}

/** Local OAuth grant demonstration. Tokens stay in this server process. */
export function createOAuth(env, { origin, fetcher = globalThis.fetch, now = () => Date.now() } = {}) {
  const pending = new Map();
  const connected = new Map();
  const enabled = env.NODE_ENV !== 'production';
  function config(id) {
    const definition = PROVIDERS[id];
    if (!definition) throw fail('This provider has no Account Desk OAuth flow.', 404);
    if (!enabled) throw fail('Account Desk local OAuth is disabled in production.', 404);
    const binding = env[`${definition.prefix}_BASE_URL`];
    if (!binding) throw fail(`${definition.name} is not selected. Start a world with this service.`, 409);
    const base = localUrl(binding);
    if (base.pathname !== '/' || base.search || base.hash) throw fail('OAuth requires a generated provider origin without a path.');
    const app = localUrl(typeof origin === 'function' ? origin() : origin);
    const clientId = env[`ACCOUNT_DESK_${definition.prefix}_CLIENT_ID`] || 'account-desk-local';
    const clientSecret = env[`ACCOUNT_DESK_${definition.prefix}_CLIENT_SECRET`];
    return { ...definition, base: base.origin, app: app.origin, clientId, clientSecret, redirectUri: `${app.origin}/oauth/${id}/callback` };
  }
  async function json(configured, path, options = {}) {
    let response;
    try {
      response = await fetcher(`${configured.base}${path}`, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000) });
    } catch { throw fail(`${configured.name} OAuth request failed. Check the local service and start sign-in again.`, 502); }
    if (!response.ok) throw fail(`${configured.name} OAuth returned HTTP ${response.status}. Start sign-in again.`, 502);
    let value;
    try { value = await response.json(); } catch { throw fail(`${configured.name} OAuth did not return JSON.`, 502); }
    if (!value || typeof value !== 'object' || value.error || value.ok === false) throw fail(`${configured.name} refused the OAuth request. Start sign-in again.`, 502);
    return value;
  }
  function session(value) {
    if (typeof value !== 'string' || value.length < 16 || value.length > 512) throw fail('A local browser session is required for OAuth.', 403);
    return digest(value).toString('hex');
  }
  function catalog() {
    return Object.entries(PROVIDERS).map(([id, definition]) => {
      let selected = false;
      let reason;
      try { config(id); selected = true; } catch (error) { reason = error.message; }
      const grant = connected.get(id);
      const expired = grant?.expiresAt !== null && grant?.expiresAt <= now();
      return { id, name: definition.name, selected, connected: Boolean(grant) && !expired,
        state: !selected ? 'unavailable' : expired ? 'expired' : grant ? 'connected' : 'not_connected',
        ...(reason ? { reason } : {}), ...(grant ? { identity: grant.identity, connectedAt: grant.connectedAt } : {}),
        pkce: definition.pkce ? 'S256' : 'Not used; no support claim',
        limits: id === 'apple'
          ? 'Local sign-in only. Apple client-secret and redirect-URI checks differ from production. No Apple product APIs.'
          : 'Local authorization-code flow. Client registration and consent enforcement are not verified against production.',
      };
    });
  }
  function start(id, { sessionId } = {}) {
    const configured = config(id);
    const browser = session(sessionId);
    for (const [key, record] of pending) if (record.expiresAt < now()) pending.delete(key);
    if (pending.size >= 100) throw fail('Too many pending sign-in requests. Try again in ten minutes.', 429);
    const state = random();
    const nonce = random();
    const verifier = configured.pkce ? random() : undefined;
    pending.set(state, { id, browser, nonce, verifier, redirectUri: configured.redirectUri, expiresAt: now() + 10 * 60 * 1000 });
    const params = new URLSearchParams({ client_id: configured.clientId, redirect_uri: configured.redirectUri,
      response_type: 'code', scope: configured.scope, state });
    if (configured.keys) params.set('nonce', nonce);
    if (configured.pkce) {
      params.set('code_challenge', digest(verifier).toString('base64url'));
      params.set('code_challenge_method', 'S256');
    }
    // Apple production requires form_post when asking for name/email scopes.
    // The local provider also supports form_post, and the server accepts it.
    if (id === 'apple') params.set('response_mode', 'form_post');
    return `${configured.base}${configured.authorize}?${params}`;
  }
  async function callback(id, input, { sessionId } = {}) {
    const configured = config(id);
    const browser = session(sessionId);
    const params = input instanceof URLSearchParams ? input : new URLSearchParams(input);
    if (params.getAll('state').length !== 1 || params.getAll('code').length > 1) throw fail('Invalid OAuth callback parameters.');
    const state = params.get('state');
    const record = pending.get(state);
    if (!record || record.id !== id || !equal(record.browser, browser) || record.expiresAt < now()) throw fail('OAuth state is invalid or expired. Start sign-in again.', 403);
    pending.delete(state); // Consume before any network request, including a denial or failure.
    if (params.has('error')) throw fail(`${configured.name} sign-in was not approved. Start sign-in again.`);
    const code = params.get('code');
    if (!code || code.length > 4096) throw fail('The OAuth callback has no valid authorization code.');
    const body = new URLSearchParams({ grant_type: 'authorization_code', code, client_id: configured.clientId, redirect_uri: record.redirectUri });
    if (configured.clientSecret) body.set('client_secret', configured.clientSecret);
    if (record.verifier) body.set('code_verifier', record.verifier);
    const grant = await json(configured, configured.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body });
    if (typeof grant.access_token !== 'string' || !grant.access_token) throw fail(`${configured.name} did not issue an access token.`, 502);
    let claims = {};
    if (configured.keys) {
      if (typeof grant.id_token !== 'string') throw fail(`${configured.name} did not issue an ID token.`, 502);
      const keys = await json(configured, configured.keys);
      if (!Array.isArray(keys.keys)) throw fail(`${configured.name} returned invalid OIDC metadata.`, 502);
      try {
        ({ payload: claims } = await jwtVerify(grant.id_token, createLocalJWKSet(keys), { algorithms: ['RS256'],
          audience: configured.clientId, currentDate: new Date(now()), requiredClaims: ['sub', 'exp', 'iat', 'nonce'] }));
        if (!equal(claims.nonce, record.nonce)) throw new Error('Invalid nonce');
        // Microsoft uses the selected world's tenant. The root discovery has a
        // default tenant, so resolve the tenant only after signature validation.
        if (id === 'microsoft' && (typeof claims.tid !== 'string' || !/^[A-Za-z0-9.-]{1,200}$/.test(claims.tid))) throw new Error('Invalid tenant');
        const discoveryPath = id === 'microsoft' ? `/${encodeURIComponent(claims.tid)}/v2.0/.well-known/openid-configuration` : '/.well-known/openid-configuration';
        const discovery = await json(configured, discoveryPath);
        if (typeof discovery.issuer !== 'string' || !equal(claims.iss, discovery.issuer)) throw new Error('Invalid issuer');
      } catch { throw fail(`${configured.name} ID token verification failed. No connection was saved.`, 502); }
    }
    const profile = configured.profile ? await json(configured, configured.profile, { method: configured.profileMethod || 'GET', headers: { Authorization: `Bearer ${grant.access_token}`, Accept: 'application/json' } }) : {};
    const identity = safeIdentity(profile, claims);
    if (!identity.id) throw fail(`${configured.name} did not confirm the selected account.`, 502);
    const expiresAt = Number(grant.expires_in) > 0 ? now() + Number(grant.expires_in) * 1000 : null;
    connected.set(id, { accessToken: grant.access_token, identity, expiresAt, connectedAt: new Date(now()).toISOString() });
    return catalog().find(item => item.id === id);
  }
  function credentials() {
    return Object.fromEntries([...connected].filter(([, grant]) => grant.expiresAt === null || grant.expiresAt > now())
      .map(([id, grant]) => [`${PROVIDERS[id].prefix}_TOKEN`, grant.accessToken]));
  }
  function disconnect(id) {
    config(id);
    connected.delete(id);
    return catalog().find(item => item.id === id);
  }
  return { catalog, start, callback, credentials, disconnect };
}
