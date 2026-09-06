import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createServer, restoreTokenMap, serializeTokenMap } from "@emulators/core";
import * as google from "@emulators/google";
import * as microsoft from "@emulators/microsoft";
import * as github from "@emulators/github";
import * as slack from "@emulators/slack";
import * as vercel from "@emulators/vercel";
import { wrapDeclaredOAuthExtra } from "./declared-oauth-extra.mjs";

const linear = await import(new URL("dist-7HIQBPU6.js", import.meta.resolve("emulate")));
const packages = { google, microsoft, github, slack, linear, vercel };
const routes = {
  google: ["oauth_clients", "/o/oauth2/v2/auth", "/o/oauth2/v2/auth/callback", "/oauth2/token", "email", "openid email profile", "/oauth2/v2/userinfo"],
  microsoft: ["oauth_clients", "/oauth2/v2.0/authorize", "/oauth2/v2.0/authorize/callback", "/oauth2/v2.0/token", "email", "openid email profile offline_access User.Read", "/oidc/userinfo"],
  github: ["oauth_apps", "/login/oauth/authorize", "/login/oauth/callback", "/login/oauth/access_token", "login", "repo user", "/user"],
  slack: ["oauth_apps", "/oauth/v2/authorize", "/oauth/v2/authorize/callback", "/api/oauth.v2.access", "user_id", "chat:write channels:read", "/api/auth.test"],
  linear: ["oauth_apps", "/oauth/authorize", "/oauth/authorize/callback", "/oauth/token", "user_ref", "read write", "/graphql"],
  vercel: ["integrations", "/oauth/authorize", "/oauth/authorize/callback", "/login/oauth/token", "username", "user", "/login/oauth/userinfo"],
};
const EMAIL = "tavi@authored.test", CLIENT = "authored-client", SECRET = "current-run-secret", REDIRECT = "http://application.test/callback";
function configuration(provider) {
  const [key, , , , , scope] = routes[provider];
  const identity = { email: EMAIL, name: "Tavi", login: "tavi", username: "tavi" };
  const config = { users: [identity], [key]: [{ client_id: CLIENT, client_secret: SECRET, name: "Authored application", redirect_uris: [REDIRECT], scopes: scope.split(" ") }] };
  if (provider === "slack") {
    config.users = [{ name: "tavi", real_name: "Tavi", email: EMAIL, profile: { email: EMAIL } }];
    config.team = { name: "Authored workspace", domain: "authored" };
    config[key][0].user_scopes = ["users:read"];
    config[key][0].bot_name = "authored-helper";
  }
  if (provider === "linear") {
    config.organization = { name: "Authored organization", url_key: "authored" };
    config.teams = [{ key: "OWN", name: "Authored team" }];
    config.strict_scopes = false;
    config[key][0].actor = "user";
  }
  return config;
}
function fixture(provider, config = configuration(provider)) {
  const mod = packages[provider];
  const lifecycle = wrapDeclaredOAuthExtra(provider, mod[`${provider}Plugin`], mod.seedFromConfig, { getStore: mod.getLinearStore });
  assert.equal(lifecycle.plugin.seed, undefined);
  const server = createServer(lifecycle.plugin);
  lifecycle.seedFromConfig(server.store, server.baseUrl, config, server.webhooks);
  return { ...server, lifecycle, config, provider, routes: routes[provider] };
}
async function request(f, path, fields, headers = {}) {
  const response = await f.app.request(path, fields ? { method: "POST", body: new URLSearchParams(fields), headers: { "content-type": "application/x-www-form-urlencoded", ...headers } } : { headers });
  const text = await response.text();
  let value; try { value = JSON.parse(text); } catch { value = Object.fromEntries(new URLSearchParams(text)); }
  return { status: response.status, text, value, headers: response.headers };
}
async function authorize(f, extra = {}) {
  const [, authorizePath, callbackPath, , identityKey, scope] = f.routes;
  const fields = { client_id: CLIENT, redirect_uri: REDIRECT, scope, response_type: "code", state: "authored-state", ...(f.provider === "slack" ? { user_scope: "users:read" } : {}), ...extra };
  const page = await request(f, `${authorizePath}?${new URLSearchParams(fields)}`);
  assert.equal(page.status, 200, page.text.slice(0, 150));
  assert.match(page.text, /Tavi|tavi/);
  const identity = new RegExp(`name="${identityKey}"[^>]*value="([^"]+)"`).exec(page.text)?.[1];
  assert.ok(identity, `provider form has ${identityKey}`);
  const callbackFields = { ...fields, [identityKey]: identity };
  const callback = await request(f, callbackPath, callbackFields);
  assert.ok([200, 302].includes(callback.status), callback.text.slice(0, 150));
  let code;
  if (callback.headers.get("location")) {
    const location = new URL(callback.headers.get("location"));
    assert.equal(location.searchParams.get("state"), "authored-state"); code = location.searchParams.get("code");
  } else code = /name="code"[^>]*value="([^"]+)"/.exec(callback.text)?.[1];
  assert.ok(code);
  return { code, callbackFields };
}
const exchange = (f, code, extra = {}, headers) => request(f, f.routes[3], { grant_type: "authorization_code", client_id: CLIENT, client_secret: SECRET, redirect_uri: REDIRECT, code, ...extra }, headers);
const rejected = result => result.status >= 400 && !result.value?.access_token;

for (const provider of Object.keys(packages)) {
  test(`${provider}: declared confidential flow uses native routes and actual source identity`, async () => {
    const f = fixture(provider), { code } = await authorize(f), token = await exchange(f, code);
    assert.equal(token.status, 200, token.text.slice(0, 100));
    assert.ok(token.value.access_token);
    const bearer = provider === "slack" ? token.value.authed_user.access_token : token.value.access_token;
    const identity = provider === "linear"
      ? await f.app.request("/graphql", { method: "POST", body: JSON.stringify({ query: "query { viewer { email } }" }), headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" } })
      : await f.app.request(f.routes[6], { ...(provider === "slack" ? { method: "POST" } : {}), headers: { authorization: `Bearer ${bearer}` } });
    assert.equal(identity.status, 200);
    const body = await identity.json();
    if (provider === "slack") { assert.equal(body.ok, true); assert.equal(body.user, "tavi"); }
    else if (provider === "linear") assert.equal(body.data.viewer.email, EMAIL);
    else if (provider === "github") assert.equal(body.login, "tavi");
    else assert.equal(body.email, EMAIL);
    assert.ok(rejected(await exchange(f, code)), "code cannot be reused");
    if (token.value.refresh_token) {
      const refreshed = await request(f, f.routes[3], { grant_type: "refresh_token", client_id: CLIENT, client_secret: SECRET, refresh_token: token.value.refresh_token });
      assert.equal(refreshed.status, 200, refreshed.text.slice(0, 100));
      assert.ok(refreshed.value.access_token);
    } else assert.ok(rejected(await request(f, f.routes[3], { grant_type: "refresh_token", client_id: CLIENT, client_secret: SECRET, refresh_token: "unsupported" })));
  });

  test(`${provider}: empty clients deny unknown and upstream sample clients`, async () => {
    const config = configuration(provider); config[routes[provider][0]] = [];
    const f = fixture(provider, config);
    for (const client_id of [CLIENT, "google-example-client", "lin_example_client_id", "sample-client"]) {
      assert.ok(rejected(await request(f, `${f.routes[1]}?${new URLSearchParams({ client_id, redirect_uri: REDIRECT })}`)));
      const result = await exchange(f, "unissued-code", { client_id });
      assert.equal(result.value.error, "invalid_client");
      assert.ok(!result.text.includes(SECRET));
    }
  });

  test(`${provider}: exact redirect, user, secret and code client binding precede native writes`, async () => {
    const config = configuration(provider); config[routes[provider][0]].push({ ...config[routes[provider][0]][0], client_id: "second-client", client_secret: "second-secret" });
    const f = fixture(provider, config), { code, callbackFields } = await authorize(f);
    for (const change of [{ client_id: "missing" }, { redirect_uri: `${REDIRECT}/other` }, { [f.routes[4]]: "unknown-user" }]) {
      assert.ok(rejected(await request(f, f.routes[2], { ...callbackFields, ...change })));
    }
    for (const change of [{ client_id: "second-client", client_secret: "second-secret" }, { client_secret: "wrong" }, { redirect_uri: "" }, { redirect_uri: `${REDIRECT}?other=1` }]) {
      const result = await exchange(f, code, change); assert.ok(rejected(result)); assert.ok(!result.text.includes(code));
    }
    const token = await exchange(f, code); assert.equal(token.status, 200);
    if (token.value.refresh_token) for (const change of [{ client_id: "second-client", client_secret: "second-secret" }, { client_secret: "wrong" }, { scope: "undeclared" }]) {
      assert.ok(rejected(await request(f, f.routes[3], { grant_type: "refresh_token", client_id: CLIENT, client_secret: SECRET, refresh_token: token.value.refresh_token, ...change })));
    }
  });

  test(`${provider}: normal reset/snapshot restore retains declarations and invalidates later grants`, async () => {
    const f = fixture(provider), initial = f.store.snapshot(), initialTokens = serializeTokenMap(f.tokenMap);
    const { code } = await authorize(f), token = await exchange(f, code), pending = await authorize(f);
    f.store.restore(initial); restoreTokenMap(f.tokenMap, initialTokens);
    assert.ok(rejected(await exchange(f, pending.code)));
    if (token.value.refresh_token) assert.ok(rejected(await request(f, f.routes[3], { grant_type: "refresh_token", client_id: CLIENT, client_secret: SECRET, refresh_token: token.value.refresh_token })));
    f.store.reset(); f.lifecycle.seedFromConfig(f.store, f.baseUrl, f.config, f.webhooks);
    assert.ok(rejected(await exchange(f, pending.code)));
    assert.equal((await exchange(f, (await authorize(f)).code)).status, 200);
  });
}

for (const provider of ["google", "microsoft", "linear", "vercel"]) test(`${provider}: PKCE requires the code's verifier and preserves a valid exchange`, async () => {
  const f = fixture(provider), verifier = "authored-verifier-long-enough-for-this-flow", challenge = createHash("sha256").update(verifier).digest("base64url");
  const { code } = await authorize(f, { code_challenge: challenge, code_challenge_method: "S256" });
  assert.ok(rejected(await exchange(f, code, { code_verifier: "wrong" })));
  assert.equal((await exchange(f, code, { code_verifier: verifier })).status, 200);
});

test("Microsoft form_post and native v1 token forwarding retain client and refresh binding", async () => {
  const f = fixture("microsoft"), { code } = await authorize(f, { response_mode: "form_post" });
  const token = await request(f, "/authored-tenant/oauth2/token", { grant_type: "authorization_code", client_id: CLIENT, client_secret: SECRET, redirect_uri: REDIRECT, code });
  assert.equal(token.status, 200);
  assert.ok(rejected(await request(f, "/authored-tenant/oauth2/token", { grant_type: "refresh_token", client_id: "missing", client_secret: SECRET, refresh_token: token.value.refresh_token })));
});

test("unsupported public clients, grants, Linear app identities, redirects and unresolved references fail before seed", () => {
  for (const provider of Object.keys(packages)) for (const mutation of [
    row => { row.client_secret = ""; }, row => { row.client_secret_ref = row.client_secret; },
    row => { row.token_endpoint_auth_method = "none"; }, row => { row.grant_types = ["password"]; },
    row => { row.redirect_uris = ["http://application.test/*"]; }, row => { row.redirect_uris = ["http://application.test/callback#fragment"]; },
  ]) {
    const config = configuration(provider); mutation(config[routes[provider][0]][0]);
    assert.throws(() => fixture(provider, config), /Declared OAuth/);
  }
  for (const extra of [{ actor: "app" }, { assignable: true }, { mentionable: true }]) {
    const config = configuration("linear"); Object.assign(config.oauth_apps[0], extra);
    assert.throws(() => fixture("linear", config), /Linear app actors/);
  }
});

for (const provider of Object.keys(packages)) test(`${provider}: JSON snapshot retains pending code and rejects later grants`, async () => {
  const f = fixture(provider), pending = await authorize(f);
  const snapshot = JSON.parse(JSON.stringify(f.store.snapshot()));
  const later = await authorize(f);
  f.store.restore(snapshot);
  assert.ok(rejected(await exchange(f, later.code)));
  const token = await exchange(f, pending.code);
  assert.equal(token.status, 200); assert.ok(token.value.access_token);
  if (token.value.refresh_token) {
    const refreshSnapshot = JSON.parse(JSON.stringify(f.store.snapshot()));
    f.store.restore(refreshSnapshot);
    const refreshed = await request(f, f.routes[3], { grant_type: "refresh_token", client_id: CLIENT, client_secret: SECRET, refresh_token: token.value.refresh_token });
    assert.equal(refreshed.status, 200); assert.ok(refreshed.value.access_token);
  }
});

for (const provider of ["microsoft", "slack", "linear"]) test(`${provider}: native Basic credentials work and conflicting body credentials fail`, async () => {
  const f = fixture(provider), { code } = await authorize(f);
  const headers = { authorization: `Basic ${Buffer.from(`${CLIENT}:${SECRET}`).toString("base64")}` };
  assert.ok(rejected(await exchange(f, code, { client_id: "other-client" }, headers)));
  const token = await request(f, f.routes[3], { grant_type: "authorization_code", redirect_uri: REDIRECT, code }, headers);
  assert.equal(token.status, 200, token.text); assert.ok(token.value.access_token);
});

test("GitHub native form token response consumes its code receipt", async () => {
  const f = fixture("github"), { code } = await authorize(f);
  const token = await exchange(f, code, {}, { accept: "application/x-www-form-urlencoded" });
  assert.equal(token.status, 200); assert.ok(token.value.access_token);
  assert.match(token.headers.get("content-type"), /application\/x-www-form-urlencoded/);
  assert.ok(rejected(await exchange(f, code)));
});

test("Microsoft native client_credentials grant requires a declared client and scope", async () => {
  const config = configuration("microsoft"); config.oauth_clients[0].scopes.push(".default");
  const f = fixture("microsoft", config);
  const fields = { grant_type: "client_credentials", client_id: CLIENT, client_secret: SECRET, scope: ".default" };
  for (const change of [{ client_id: "missing" }, { client_secret: "wrong" }, { scope: "unknown" }]) assert.ok(rejected(await request(f, f.routes[3], { ...fields, ...change })));
  const token = await request(f, f.routes[3], fields);
  assert.equal(token.status, 200, token.text); assert.ok(token.value.access_token);
});
