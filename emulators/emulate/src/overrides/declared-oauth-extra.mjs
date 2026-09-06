// Guard only routes implemented by the pinned providers. Native routes still
// create users' codes/tokens; policy receipts live in the normal Store snapshot.
import { createHash, timingSafeEqual } from "node:crypto";
import { getSlackStore } from "@emulators/slack";

const POLICIES = {
  google: { key: "oauth_clients", authorize: "/o/oauth2/v2/auth", callback: "/o/oauth2/v2/auth/callback", token: "/oauth2/token", identity: "email", grants: ["authorization_code", "refresh_token"], pkce: true },
  microsoft: { key: "oauth_clients", authorize: "/oauth2/v2.0/authorize", callback: "/oauth2/v2.0/authorize/callback", token: "/oauth2/v2.0/token", identity: "email", grants: ["authorization_code", "refresh_token", "client_credentials"], pkce: true, basic: true },
  github: { key: "oauth_apps", authorize: "/login/oauth/authorize", callback: "/login/oauth/callback", token: "/login/oauth/access_token", identity: "login", grants: ["authorization_code"] },
  slack: { key: "oauth_apps", authorize: "/oauth/v2/authorize", callback: "/oauth/v2/authorize/callback", token: "/api/oauth.v2.access", identity: "user_id", grants: ["authorization_code"], basic: true },
  linear: { key: "oauth_apps", authorize: "/oauth/authorize", callback: "/oauth/authorize/callback", token: "/oauth/token", identity: "user_ref", grants: ["authorization_code", "refresh_token"], pkce: true, basic: true },
  vercel: { key: "integrations", authorize: "/oauth/authorize", callback: "/oauth/authorize/callback", token: "/login/oauth/token", identity: "username", grants: ["authorization_code"], pkce: true },
};
const nonempty = value => typeof value === "string" && value.trim().length > 0;
const digest = value => createHash("sha256").update(String(value ?? "")).digest("hex");
const sameSecret = (left, right) => timingSafeEqual(Buffer.from(digest(left)), Buffer.from(digest(right)));
const keyOf = provider => `worldfixture.${provider}.declaredOAuthExtra`;
const requirePolicy = (value, message) => { if (!value) throw new Error(`Declared OAuth: ${message}`); };
const scopesOf = value => String(value ?? "").split(/[,\s]+/).filter(Boolean);
const deny = (c, error = "invalid_client", status = 401) => c.json({ error, error_description: "The request is not authorized." }, status);

function clientsOf(provider, policy, config) {
  const clients = config[policy.key] ?? [], ids = new Set();
  requirePolicy(Array.isArray(clients), `${provider} ${policy.key} must be an array`);
  return clients.map(client => {
    requirePolicy(client && typeof client === "object" && !Array.isArray(client), "invalid client declaration");
    requirePolicy(nonempty(client.client_id) && !ids.has(client.client_id), "client IDs must be nonempty and unique");
    ids.add(client.client_id);
    requirePolicy(nonempty(client.name), "clients need a declared name");
    requirePolicy(nonempty(client.client_secret), "a resolved confidential client_secret is required");
    requirePolicy(!client.client_secret_ref || client.client_secret !== client.client_secret_ref, "client_secret_ref must be resolved before seeding");
    requirePolicy(client.is_public !== true && (!client.token_endpoint_auth_method || ["client_secret_post", ...(policy.basic ? ["client_secret_basic"] : [])].includes(client.token_endpoint_auth_method)), "unsupported public client or token endpoint authentication method");
    requirePolicy(provider !== "linear" || (!client.actor || client.actor === "user") && !client.assignable && !client.mentionable, "Linear app actors are not supported by the declared source user contract");
    requirePolicy(Array.isArray(client.redirect_uris) && client.redirect_uris.length > 0 && new Set(client.redirect_uris).size === client.redirect_uris.length && client.redirect_uris.every(uri => {
      try { const url = new URL(uri); return typeof uri === "string" && ["http:", "https:"].includes(url.protocol) && !url.hash && !uri.includes("*"); } catch { return false; }
    }), "clients need distinct exact HTTP(S) redirect URIs without fragments or wildcards");
    const grants = client.grant_types ?? policy.grants;
    requirePolicy(Array.isArray(grants) && grants.length > 0 && grants.every(grant => policy.grants.includes(grant)) && new Set(grants).size === grants.length, `${provider} has an unsupported grant type`);
    for (const field of ["scopes", "user_scopes"]) requirePolicy(client[field] === undefined || Array.isArray(client[field]) && client[field].every(nonempty), `${field} must be an array of strings`);
    return { ...structuredClone(client), grant_types: grants };
  });
}

async function fieldsOf(c) {
  if (c.req.method === "GET") return Object.fromEntries(new URL(c.req.url).searchParams);
  const request = c.req.raw.clone();
  const fields = request.headers.get("content-type")?.includes("application/json") ? await request.json() : Object.fromEntries(new URLSearchParams(await request.text()));
  if (!fields || typeof fields !== "object" || Array.isArray(fields) || Object.values(fields).some(value => typeof value !== "string")) throw new Error("Invalid fields");
  return fields;
}
function clientAuth(c, fields, policy) {
  let id = fields.client_id, secret = fields.client_secret;
  const header = c.req.header("authorization");
  if (header?.startsWith("Basic ")) {
    if (!policy.basic) throw new Error("Basic client authentication is not supported");
    const plain = Buffer.from(header.slice(6), "base64").toString(), colon = plain.indexOf(":");
    if (colon < 0) throw new Error("Invalid Basic credentials");
    const basicId = decodeURIComponent(plain.slice(0, colon)), basicSecret = decodeURIComponent(plain.slice(colon + 1));
    if (id && id !== basicId || secret && secret !== basicSecret) throw new Error("Conflicting client credentials");
    id = basicId; secret = basicSecret;
  }
  return { id, secret };
}

export function wrapDeclaredOAuthExtra(provider, upstream, upstreamSeed, { getStore } = {}) {
  const policy = POLICIES[provider];
  requirePolicy(policy, "unsupported extra OAuth provider");
  requirePolicy(provider !== "linear" || typeof getStore === "function", "Linear needs its normal getStore accessor");
  const identityFor = (store, fields) => {
    if (provider === "linear") return getStore(store).users.findOneBy("linear_id", fields.user_ref)?.email;
    if (provider === "slack") return getSlackStore(store).users.findOneBy("user_id", fields.user_id)?.name;
    return fields[policy.identity];
  };
  const plugin = { ...upstream, seed: undefined, register(app, store, ...args) {
    app.use("*", async (c, next) => {
      const path = c.req.path;
      const action = path === policy.authorize && c.req.method === "GET" ? "authorize"
        : path === policy.callback && c.req.method === "POST" ? "callback"
          : path === policy.token && c.req.method === "POST" ? "token" : null;
      // Microsoft's existing v1 tenant token route forwards into the guarded v2
      // route. No new tenant-prefixed protocol aliases are invented here.
      if (!action) return next();
      const declaration = store.getData(keyOf(provider));
      if (!declaration) return deny(c);
      const state = { ...declaration, codes: store.getData(`${keyOf(provider)}.codes`), refresh: store.getData(`${keyOf(provider)}.refresh`) };
      if (!(state.codes instanceof Map) || !(state.refresh instanceof Map)) return deny(c);
      let fields, auth;
      try { fields = await fieldsOf(c); auth = clientAuth(c, fields, policy); }
      catch { return deny(c, "invalid_request", 400); }
      const client = state.clients.find(row => row.client_id === auth.id);
      if (!client) return deny(c);
      const scope = scopesOf(fields.scope || (provider === "linear" && action !== "token" ? "read" : action === "token" && fields.grant_type === "client_credentials" ? ".default" : ""));
      if (client.scopes && scope.some(item => !client.scopes.includes(item))) return deny(c, "invalid_scope", 400);
      if (provider === "slack" && client.user_scopes && scopesOf(fields.user_scope).some(item => !client.user_scopes.includes(item))) return deny(c, "invalid_scope", 400);
      let receipt;
      if (action !== "token") {
        if (!client.grant_types.includes("authorization_code")) return deny(c, "unauthorized_client", 400);
        if (!client.redirect_uris.includes(fields.redirect_uri)) return deny(c, "invalid_request", 400);
        if (fields.response_type && fields.response_type !== "code") return deny(c, "unsupported_response_type", 400);
        if (fields.response_mode && !(provider === "microsoft" ? ["query", "form_post"] : ["query"]).includes(fields.response_mode)) return deny(c, "invalid_request", 400);
        if (provider === "linear" && fields.actor && fields.actor !== "user") return deny(c, "unauthorized_client", 400);
        if (fields.code_challenge && (!policy.pkce || !["plain", "S256"].includes(fields.code_challenge_method || "plain"))) return deny(c, "invalid_request", 400);
        if (action === "callback" && !state.identities.includes(identityFor(store, fields))) return deny(c, "invalid_request", 400);
        receipt = { client_id: client.client_id, redirect_uri: fields.redirect_uri, scope, created: Date.now(),
          challenge: fields.code_challenge || null, method: fields.code_challenge_method || "plain" };
      } else {
        if (!nonempty(auth.secret) || !sameSecret(client.client_secret, auth.secret)) return deny(c);
        const grant = fields.grant_type || (["github", "slack", "vercel"].includes(provider) ? "authorization_code" : "");
        if (!client.grant_types.includes(grant)) return deny(c, "unsupported_grant_type", 400);
        if (grant === "authorization_code") {
          receipt = state.codes.get(digest(fields.code));
          if (!receipt || receipt.client_id !== client.client_id || Date.now() - receipt.created > 600000 || fields.redirect_uri !== receipt.redirect_uri) return deny(c, "invalid_grant", 400);
          if (receipt.challenge) {
            const verifier = receipt.method === "S256" ? createHash("sha256").update(fields.code_verifier ?? "").digest("base64url") : fields.code_verifier;
            if (!nonempty(verifier) || !sameSecret(receipt.challenge, verifier)) return deny(c, "invalid_grant", 400);
          }
        } else if (grant === "refresh_token") {
          receipt = state.refresh.get(digest(fields.refresh_token));
          if (!receipt || receipt.client_id !== client.client_id || scope.some(item => !receipt.scope.includes(item))) return deny(c, "invalid_grant", 400);
        }
      }
      if (action === "authorize") return next();
      // Core's context does not expose c.res. Observe the native response
      // methods, including GitHub's optional form-encoded token response.
      const original = { json: c.json, redirect: c.redirect, html: c.html, body: c.body };
      const saveCode = code => { if (nonempty(code)) state.codes.set(digest(code), receipt); };
      const saveToken = result => {
        if (!nonempty(result?.access_token)) return;
        if (fields.code) state.codes.delete(digest(fields.code));
        if (result.refresh_token && receipt) {
          if (fields.refresh_token && fields.refresh_token !== result.refresh_token) state.refresh.delete(digest(fields.refresh_token));
          state.refresh.set(digest(result.refresh_token), { ...receipt });
        }
      };
      c.redirect = function(location, ...options) {
        if (action === "callback") {
          try { saveCode(new URL(location).searchParams.get("code")); } catch { /* Native response is not a code redirect. */ }
        }
        return original.redirect.call(this, location, ...options);
      };
      c.html = function(html, ...options) {
        if (action === "callback" && provider === "microsoft") saveCode(/name="code"[^>]*value="([^"]+)"/.exec(String(html))?.[1]);
        return original.html.call(this, html, ...options);
      };
      c.json = function(value, ...options) {
        if (action === "token") saveToken(value);
        return original.json.call(this, value, ...options);
      };
      c.body = function(body, ...options) {
        if (action === "token" && typeof body === "string") {
          try { saveToken(JSON.parse(body)); } catch { saveToken(Object.fromEntries(new URLSearchParams(body))); }
        }
        return original.body.call(this, body, ...options);
      };
      try { await next(); } finally { Object.assign(c, original); }
    });
    upstream.register(app, store, ...args);
  } };
  function seedFromConfig(store, baseUrl, config = {}, ...args) {
    requirePolicy(!store.getData(keyOf(provider)), "reset the provider before reseeding clients");
    const clients = clientsOf(provider, policy, config), users = config.users ?? [];
    requirePolicy(Array.isArray(users), "users must be an array");
    const identityField = provider === "slack" ? "name" : provider === "linear" ? "email" : policy.identity;
    const identities = users.map(user => user?.[identityField]);
    requirePolicy(new Set(identities).size === identities.length, `${provider} source identities must be unique`);
    requirePolicy(identities.every(nonempty), `${provider} users need their declared ${identityField}`);
    upstreamSeed(store, baseUrl, { ...structuredClone(config), [policy.key]: clients }, ...args);
    store.setData(keyOf(provider), { clients, identities });
    store.setData(`${keyOf(provider)}.codes`, new Map());
    store.setData(`${keyOf(provider)}.refresh`, new Map());
  }
  return { plugin, seedFromConfig };
}
