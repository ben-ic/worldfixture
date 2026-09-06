// Provider-native client config is the only authority. These wrappers run in
// the normal seed/register lifecycle; they never remove or repair store rows.
import { createHash, createPublicKey, timingSafeEqual } from "node:crypto";
import { importSPKI, jwtVerify } from "jose";
import { getClerkStore } from "@emulators/clerk";
import { getOktaStore } from "@emulators/okta";

const CLIENT_KEYS = { apple: "oauth_clients", clerk: "oauth_applications", okta: "oauth_clients" };
const stateKey = provider => `worldfixture.${provider}.declaredOAuth`;
const digest = value => createHash("sha256").update(String(value ?? "")).digest("hex");
const equal = (left, right) => timingSafeEqual(Buffer.from(digest(left)), Buffer.from(digest(right)));
const required = (condition, message) => { if (!condition) throw new Error(`Declared OAuth: ${message}`); };
const nonempty = value => typeof value === "string" && value.length > 0;
const deny = (c, error = "invalid_client", status = 401) => c.json({ error,
  error_description: error === "invalid_client" ? "Client authentication failed." : "The request is not authorized." }, status);

function routeOf(provider, path, method) {
  const prefix = provider === "apple" ? "/auth" : provider === "clerk" ? "/oauth" : null;
  if (prefix) {
    if (method === "GET" && path === `${prefix}/authorize`) return { action: "authorize", server: null };
    if (method === "POST" && path === `${prefix}/authorize/callback`) return { action: "callback", server: null };
    if (method === "POST" && path === `${prefix}/token`) return { action: "token", server: null };
    return null;
  }
  const match = /^\/oauth2\/(?:([^/]+)\/)?v1\/(authorize(?:\/callback)?|token)$/.exec(path);
  if (!match) return null;
  const action = match[2] === "authorize/callback" ? "callback" : match[2];
  if (method !== (action === "authorize" ? "GET" : "POST")) return null;
  return { action, server: match[1] ? decodeURIComponent(match[1]) : "org" };
}

function clientPolicy(provider, config) {
  const rows = config[CLIENT_KEYS[provider]] ?? [];
  required(Array.isArray(rows), "client declarations must be an array");
  const ids = new Set();
  return rows.map(row => {
    required(row && typeof row === "object" && !Array.isArray(row), "invalid client declaration");
    required(nonempty(row.client_id) && !ids.has(row.client_id), "client IDs must be nonempty and unique");
    ids.add(row.client_id);
    required(Array.isArray(row.redirect_uris) && row.redirect_uris.length > 0
      && row.redirect_uris.every(uri => {
        try { const parsed = new URL(uri); return ["http:", "https:"].includes(parsed.protocol) && !parsed.hash && !uri.includes("*"); }
        catch { return false; }
      }), "clients need explicit HTTP(S) redirect URIs without wildcards or fragments");
    const publicClient = provider === "clerk" ? row.is_public === true : provider === "okta" && row.token_endpoint_auth_method === "none";
    required(!publicClient || !row.public_key, "public clients cannot declare a signing key");
    required(publicClient || nonempty(row.client_secret) || (provider === "apple" && nonempty(row.public_key)), "a resolved client_secret or Apple public_key is required");
    required(!row.client_secret_ref || (nonempty(row.client_secret) && row.client_secret !== row.client_secret_ref), "client_secret_ref must be resolved before seed");
    required(!row.public_key_ref || (nonempty(row.public_key) && row.public_key !== row.public_key_ref), "public_key_ref must be resolved before seed");
    if (row.public_key) {
      required(provider === "apple" && nonempty(row.team_id) && nonempty(row.key_id), "Apple signing keys require team_id and key_id");
      let key;
      try { key = createPublicKey(row.public_key); } catch { required(false, "invalid Apple public key"); }
      required(key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails.namedCurve === "prime256v1", "Apple public key must use ES256");
    }
    const supported = provider === "clerk" ? ["authorization_code"] : provider === "apple"
      ? ["authorization_code", "refresh_token"] : ["authorization_code", "refresh_token", "client_credentials"];
    const grants = row.grant_types ?? supported.filter(grant => !publicClient || grant !== "client_credentials");
    required(Array.isArray(grants) && grants.every(grant => supported.includes(grant)
      && (!publicClient || grant !== "client_credentials")), "unsupported client grant type");
    required(row.scopes === undefined || (Array.isArray(row.scopes) && row.scopes.every(nonempty)), "scopes must be an array of strings");
    if (provider === "okta") required(row.auth_server_id === undefined || nonempty(row.auth_server_id), "auth_server_id must be a nonempty string");
    return { ...structuredClone(row), publicClient, grant_types: grants,
      auth_server_id: provider === "okta" ? row.auth_server_id ?? "default" : null };
  });
}

function sourceIdentity(provider, state, store, body) {
  if (provider === "apple") return state.identities.includes(body.email);
  if (provider === "okta") {
    const users = getOktaStore(store).users;
    const user = users.findOneBy("okta_id", body.user_ref) ?? users.findOneBy("login", body.user_ref);
    return Boolean(user && state.identities.includes(user.login));
  }
  const clerk = getClerkStore(store);
  const user = clerk.users.findOneBy("clerk_id", body.user_ref);
  return Boolean(user && clerk.emailAddresses.findBy("user_id", user.clerk_id)
    .some(row => state.identities.includes(row.email_address)));
}

async function fieldsOf(c) {
  if (c.req.method === "GET") return Object.fromEntries(new URL(c.req.url).searchParams);
  const request = c.req.raw.clone();
  const body = request.headers.get("content-type")?.includes("application/json")
    ? await request.json() : Object.fromEntries(new URLSearchParams(await request.text()));
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.values(body).some(value => typeof value !== "string")) throw new Error("invalid fields");
  return body;
}

function credentialsOf(c, body) {
  let clientId = body.client_id;
  let secret = body.client_secret;
  const header = c.req.header("authorization");
  if (header?.startsWith("Basic ")) {
    const value = Buffer.from(header.slice(6), "base64").toString("utf8");
    const colon = value.indexOf(":");
    if (colon < 0) throw new Error("invalid credentials");
    const basicId = decodeURIComponent(value.slice(0, colon));
    const basicSecret = decodeURIComponent(value.slice(colon + 1));
    if ((clientId && clientId !== basicId) || (secret && secret !== basicSecret)) throw new Error("conflicting credentials");
    clientId = basicId;
    secret = basicSecret;
  }
  return { clientId, secret };
}

async function authenticate(client, secret) {
  if (client.publicClient) return true;
  if (nonempty(client.client_secret) && nonempty(secret) && equal(client.client_secret, secret)) return true;
  if (!client.public_key || !nonempty(secret)) return false;
  try {
    const key = await importSPKI(client.public_key, "ES256");
    const result = await jwtVerify(secret, key, { algorithms: ["ES256"], issuer: client.team_id,
      subject: client.client_id, audience: "https://appleid.apple.com", requiredClaims: ["exp", "iat"] });
    return result.protectedHeader.kid === client.key_id && result.payload.iat <= Math.floor(Date.now() / 1000);
  } catch { return false; }
}

export function wrapDeclaredOAuth(provider, upstream, upstreamSeed) {
  required(Object.hasOwn(CLIENT_KEYS, provider), "unsupported provider");
  const plugin = { ...upstream, seed: undefined, register(app, store, ...args) {
    app.use("*", async (c, next) => {
      const route = routeOf(provider, c.req.path, c.req.method);
      if (!route) return next();
      const policy = store.getData(stateKey(provider));
      if (!policy) return deny(c);
      const state = { ...policy, codes: store.getData(`${stateKey(provider)}.codes`),
        refresh: store.getData(`${stateKey(provider)}.refresh`) };
      if (!(state.codes instanceof Map) || !(state.refresh instanceof Map)) return deny(c);
      let fields, credentials;
      try { fields = await fieldsOf(c); credentials = credentialsOf(c, fields); }
      catch { return deny(c, "invalid_request", 400); }
      const client = state.clients.find(row => row.client_id === credentials.clientId && row.auth_server_id === route.server);
      if (!client) return deny(c);
      const defaultScope = route.action === "token" ? (fields.grant_type === "client_credentials" ? ".default" : "")
        : provider === "apple" ? "" : "openid profile email";
      const scope = String(fields.scope || defaultScope).split(/\s+/).filter(Boolean);
      if (Array.isArray(client.scopes) && scope.some(item => !client.scopes.includes(item))) return deny(c, "invalid_scope", 400);
      let receipt;
      if (route.action === "authorize" || route.action === "callback") {
        if (!client.grant_types.includes("authorization_code")) return deny(c, "unauthorized_client", 400);
        if (!client.redirect_uris.includes(fields.redirect_uri)) return deny(c, "invalid_request", 400);
        if (fields.response_type && fields.response_type !== "code") return deny(c, "unsupported_response_type", 400);
        if (fields.response_mode && !["query", "form_post"].includes(fields.response_mode)) return deny(c, "invalid_request", 400);
        if (client.publicClient && (!fields.code_challenge || fields.code_challenge_method !== "S256")) return deny(c, "invalid_request", 400);
        if (route.action === "callback" && !sourceIdentity(provider, state, store, fields)) return deny(c, "invalid_request", 400);
        receipt = { client_id: client.client_id, server: route.server, redirect_uri: fields.redirect_uri,
          scope, created: Date.now(), challenge: fields.code_challenge ?? null, method: fields.code_challenge_method ?? "plain" };
      } else {
        if (!(await authenticate(client, credentials.secret))) return deny(c);
        if (!client.grant_types.includes(fields.grant_type)) return deny(c, "unsupported_grant_type", 400);
        if (fields.grant_type === "authorization_code") {
          receipt = state.codes.get(digest(fields.code));
          if (!receipt || Date.now() - receipt.created > 600000 || receipt.client_id !== client.client_id
            || receipt.server !== route.server || fields.redirect_uri !== receipt.redirect_uri) return deny(c, "invalid_grant", 400);
          if (receipt.challenge) {
            const actual = receipt.method === "S256" ? createHash("sha256").update(fields.code_verifier ?? "").digest("base64url") : fields.code_verifier;
            if (!["plain", "S256"].includes(receipt.method) || !nonempty(actual) || !equal(receipt.challenge, actual)) return deny(c, "invalid_grant", 400);
          }
        } else if (fields.grant_type === "refresh_token") {
          receipt = state.refresh.get(digest(fields.refresh_token));
          if (!receipt || receipt.client_id !== client.client_id || receipt.server !== route.server
            || scope.some(item => !receipt.scope.includes(item))) return deny(c, "invalid_grant", 400);
        }
      }
      const original = { json: c.json, redirect: c.redirect, html: c.html };
      const saveCode = code => { if (route.action === "callback" && nonempty(code)) state.codes.set(digest(code), receipt); };
      c.redirect = function(location, ...options) {
        try { saveCode(new URL(location).searchParams.get("code")); } catch { /* no code in this response */ }
        return original.redirect.call(this, location, ...options);
      };
      c.html = function(html, ...options) {
        // Upstream form_post responses contain hex authorization codes.
        const code = /name="code"[^>]*value="([a-f0-9]+)"/.exec(html)?.[1];
        saveCode(code);
        return original.html.call(this, html, ...options);
      };
      c.json = function(value, ...options) {
        if (route.action === "token" && value?.access_token) {
          if (fields.grant_type === "authorization_code") state.codes.delete(digest(fields.code));
          if (value.refresh_token && receipt) {
            if (fields.grant_type === "refresh_token" && value.refresh_token !== fields.refresh_token) state.refresh.delete(digest(fields.refresh_token));
            state.refresh.set(digest(value.refresh_token), { ...receipt,
              scope: typeof value.scope === "string" ? value.scope.split(/\s+/).filter(Boolean) : receipt.scope });
          }
        }
        return original.json.call(this, value, ...options);
      };
      try { await next(); }
      finally { c.json = original.json; c.redirect = original.redirect; c.html = original.html; }
    });
    upstream.register(app, store, ...args);
  } };
  function seedFromConfig(store, baseUrl, config = {}, ...args) {
    required(!store.getData(stateKey(provider)), "reset the provider before reseeding clients");
    const clients = clientPolicy(provider, config);
    const users = config.users ?? [];
    required(Array.isArray(users), "users must be an array");
    const identities = users.flatMap(user => provider === "clerk" ? user.email_addresses ?? [] : [provider === "okta" ? user.login : user.email]);
    required(identities.every(nonempty), "users need source email/login identities");
    const nativeConfig = structuredClone(config);
    nativeConfig[CLIENT_KEYS[provider]] = clients.map(({ publicClient, ...row }) => row);
    // Custom Okta authorization servers are protocol infrastructure. Declare
    // their IDs explicitly in client config; do not restore sample users/apps.
    if (provider === "okta") {
      nativeConfig.authorization_servers ??= [];
      for (const id of new Set(clients.map(row => row.auth_server_id).filter(id => id !== "org"))) {
        if (!nativeConfig.authorization_servers.some(row => row.id === id)) nativeConfig.authorization_servers.push({ id, name: id });
      }
    }
    upstreamSeed(store, baseUrl, nativeConfig, ...args);
    store.setData(stateKey(provider), { clients, identities });
    store.setData(`${stateKey(provider)}.codes`, new Map());
    store.setData(`${stateKey(provider)}.refresh`, new Map());
  }
  return { plugin, seedFromConfig };
}
