import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createServer } from "@emulators/core";
import * as apple from "@emulators/apple";
import * as clerk from "@emulators/clerk";
import * as okta from "@emulators/okta";
import { decodeJwt, exportSPKI, generateKeyPair, SignJWT } from "jose";
import { wrapDeclaredOAuth } from "./declared-oauth.mjs";

const PACKAGES = { apple, clerk, okta };
const CLIENT = "authored-application-42";
const SECRET = "synthetic-current-run-secret";
const REDIRECT = "http://localhost:3100/callback";
const EMAIL = "nora@declared.example.test";
const SCOPES = ["openid", "profile", "email"];
const keys = { apple: "oauth_clients", clerk: "oauth_applications", okta: "oauth_clients" };
function configuration(provider) {
  const users = provider === "clerk" ? [{ email_addresses: [EMAIL], username: "nora", first_name: "Nora", last_name: "Rivera" }]
    : provider === "okta" ? [{ login: EMAIL, email: EMAIL, first_name: "Nora", last_name: "Rivera" }]
      : [{ email: EMAIL, name: "Nora Rivera" }];
  return { users, [keys[provider]]: [{ client_id: CLIENT, client_secret: SECRET, name: "Declared application",
    redirect_uris: [REDIRECT], scopes: SCOPES,
    ...(provider === "clerk" ? { is_public: false } : provider === "okta" ? { auth_server_id: "authored-server", token_endpoint_auth_method: "client_secret_post" }
      : { team_id: "TEAM_AUTHORED", key_id: "KEY_AUTHORED" }) }] };
}

function fixture(provider, config = configuration(provider)) {
  const mod = PACKAGES[provider];
  const lifecycle = wrapDeclaredOAuth(provider, mod[`${provider}Plugin`], mod.seedFromConfig);
  assert.equal(lifecycle.plugin.seed, undefined);
  const server = createServer(lifecycle.plugin);
  lifecycle.seedFromConfig(server.store, server.baseUrl, config, server.webhooks);
  return { ...server, lifecycle, config, provider,
    prefix: provider === "apple" ? "/auth" : provider === "clerk" ? "/oauth" : "/oauth2/authored-server/v1" };
}

async function request(app, path, fields, headers = {}) {
  const response = await app.request(path, fields ? { method: "POST", body: new URLSearchParams(fields),
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers } } : { headers });
  const text = await response.text();
  return { status: response.status, text, headers: response.headers,
    value: response.headers.get("content-type")?.includes("application/json") ? JSON.parse(text) : null };
}

async function authorize(f, extra = {}) {
  const fields = { client_id: CLIENT, redirect_uri: REDIRECT, scope: SCOPES.join(" "), response_type: "code", ...extra };
  const page = await request(f.app, `${f.prefix}/authorize?${new URLSearchParams(fields)}`);
  assert.equal(page.status, 200, page.text.slice(0, 120));
  assert.match(page.text, new RegExp(EMAIL.replaceAll(".", "\\.")));
  const user = f.provider === "apple" ? { email: EMAIL } : { user_ref: /name="user_ref" value="([^"]+)"/.exec(page.text)?.[1] };
  assert.ok(f.provider === "apple" || user.user_ref);
  const callbackFields = { ...fields, ...user };
  const callback = await request(f.app, `${f.prefix}/authorize/callback`, callbackFields);
  assert.ok([200, 302].includes(callback.status), callback.text.slice(0, 120));
  const code = callback.headers.get("location") ? new URL(callback.headers.get("location")).searchParams.get("code")
    : /name="code" value="([^"]+)"/.exec(callback.text)?.[1];
  assert.ok(code);
  return { code, callbackFields, page };
}

async function exchange(f, code, extra = {}) {
  return request(f.app, `${f.prefix}/token`, { grant_type: "authorization_code", client_id: CLIENT,
    client_secret: SECRET, redirect_uri: REDIRECT, code, ...extra });
}

for (const provider of Object.keys(PACKAGES)) {
  test(`${provider}: declared source identity and current client complete the public code flow`, async () => {
    const f = fixture(provider);
    const { code, page } = await authorize(f);
    assert.doesNotMatch(page.text, /testuser@icloud.com|test@example.com|testuser@okta.local/);
    const token = await exchange(f, code);
    assert.equal(token.status, 200, token.text.slice(0, 120));
    assert.ok(token.value.access_token);
    const claims = decodeJwt(token.value.id_token);
    assert.equal(claims.email, EMAIL);
    assert.equal(claims.aud, CLIENT);
    assert.equal((await exchange(f, code)).status, 400);
    if (provider === "clerk") {
      const refresh = await request(f.app, `${f.prefix}/token`, { grant_type: "refresh_token", client_id: CLIENT,
        client_secret: SECRET, refresh_token: "not-supported" });
      assert.equal(refresh.value.error, "unsupported_grant_type");
      assert.equal(token.value.refresh_token, undefined);
    } else {
      const refresh = await request(f.app, `${f.prefix}/token`, { grant_type: "refresh_token", client_id: CLIENT,
        client_secret: SECRET, refresh_token: token.value.refresh_token });
      assert.equal(refresh.status, 200, refresh.text.slice(0, 120));
      assert.equal(decodeJwt(refresh.value.id_token).email, EMAIL);
      assert.equal(decodeJwt(refresh.value.id_token).aud, CLIENT);
    }
  });

  test(`${provider}: absent and empty client declarations reject sample, arbitrary, and direct callback clients`, async () => {
    const sample = provider === "clerk" ? ["clerk_emulate_client", "clerk_emulate_secret"]
      : provider === "okta" ? ["okta-test-client", "okta-test-secret"] : ["com.example.sample", "sample-secret"];
    for (const mode of ["absent", "empty"]) {
      const config = configuration(provider);
      if (mode === "absent") delete config[keys[provider]];
      else config[keys[provider]] = [];
      const f = fixture(provider, config);
      for (const [clientId, clientSecret] of [sample, ["foreign-application", "foreign-secret"]]) {
        for (const [path, fields] of [
          [`${f.prefix}/authorize?${new URLSearchParams({ client_id: clientId, redirect_uri: REDIRECT })}`, undefined],
          [`${f.prefix}/authorize/callback`, { client_id: clientId, redirect_uri: REDIRECT, email: EMAIL, user_ref: EMAIL }],
          [`${f.prefix}/token`, { client_id: clientId, client_secret: clientSecret, grant_type: "authorization_code", code: "secret-code" }],
        ]) {
          const result = await request(f.app, path, fields);
          assert.equal(result.status, 401, `${mode} ${path}`);
          assert.equal(result.value.error, "invalid_client");
          assert.ok(!result.text.includes(clientSecret));
          assert.ok(!result.text.includes("secret-code"));
        }
      }
    }
  });

  test(`${provider}: callback identity/redirect and exchange client/secret/redirect are enforced`, async () => {
    const config = configuration(provider);
    config[keys[provider]].push({ ...config[keys[provider]][0], client_id: "other-declared-client", client_secret: "other-secret" });
    const f = fixture(provider, config);
    const { code, callbackFields } = await authorize(f);
    for (const mutation of [
      { client_id: "foreign-client" }, { redirect_uri: "https://foreign.example.test/callback" },
      provider === "apple" ? { email: "foreign@example.test" } : { user_ref: "foreign-user" },
    ]) {
      assert.ok((await request(f.app, `${f.prefix}/authorize/callback`, { ...callbackFields, ...mutation })).status >= 400);
    }
    for (const mutation of [
      { client_id: "other-declared-client", client_secret: "other-secret" },
      { client_secret: "wrong-secret" }, { redirect_uri: "https://foreign.example.test/callback" },
      { redirect_uri: "" },
    ]) {
      const result = await exchange(f, code, mutation);
      assert.ok(result.status >= 400);
      assert.ok(!result.text.includes(code));
      assert.ok(!result.text.includes("wrong-secret"));
    }
    const token = await exchange(f, code);
    assert.equal(token.status, 200);
    if (token.value.refresh_token) {
      for (const mutation of [{ client_id: "other-declared-client", client_secret: "other-secret" },
        { scope: "ungranted_scope" }]) {
        const result = await request(f.app, `${f.prefix}/token`, { grant_type: "refresh_token", client_id: CLIENT,
          client_secret: SECRET, refresh_token: token.value.refresh_token, ...mutation });
        assert.ok(result.status >= 400);
        assert.ok(!result.text.includes(token.value.refresh_token));
      }
    }
  });

  test(`${provider}: reset/reseed and initial snapshot restore invalidate later codes and refresh receipts`, async () => {
    const f = fixture(provider);
    const initial = JSON.parse(JSON.stringify(f.store.snapshot()));
    const { code } = await authorize(f);
    const token = await exchange(f, code);
    const pending = await authorize(f);
    f.store.restore(initial);
    assert.equal((await exchange(f, pending.code)).value.error, "invalid_grant");
    if (token.value.refresh_token) {
      assert.equal((await request(f.app, `${f.prefix}/token`, { grant_type: "refresh_token", client_id: CLIENT,
        client_secret: SECRET, refresh_token: token.value.refresh_token })).value.error, "invalid_grant");
    }
    f.store.reset();
    f.lifecycle.seedFromConfig(f.store, f.baseUrl, f.config, f.webhooks);
    assert.equal((await exchange(f, pending.code)).value.error, "invalid_grant");
    const current = await authorize(f);
    assert.equal((await exchange(f, current.code)).status, 200);
    assert.equal((await exchange(f, current.code, { client_id: "okta-test-client", client_secret: "okta-test-secret" })).value.error, "invalid_client");
  });

  test(`${provider}: serialized snapshots preserve an issued code and its later refresh receipt`, async () => {
    const f = fixture(provider);
    const { code } = await authorize(f);
    f.store.restore(JSON.parse(JSON.stringify(f.store.snapshot())));
    const token = await exchange(f, code);
    assert.equal(token.status, 200);
    if (token.value.refresh_token) {
      f.store.restore(JSON.parse(JSON.stringify(f.store.snapshot())));
      const refreshed = await request(f.app, `${f.prefix}/token`, {
        grant_type: "refresh_token", client_id: CLIENT, client_secret: SECRET, refresh_token: token.value.refresh_token,
      });
      assert.equal(refreshed.status, 200);
      assert.ok(refreshed.value.access_token);
    }
  });
}

test("Apple form_post flow preserves source identity and registered ES256 client-secret checks", async () => {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const config = configuration("apple");
  delete config.oauth_clients[0].client_secret;
  config.oauth_clients[0].public_key = await exportSPKI(publicKey);
  const f = fixture("apple", config);
  const { code } = await authorize(f, { response_mode: "form_post" });
  const sign = async overrides => new SignJWT().setProtectedHeader({ alg: "ES256", kid: overrides?.kid ?? "KEY_AUTHORED" })
    .setIssuer(overrides?.issuer ?? "TEAM_AUTHORED").setSubject(overrides?.subject ?? CLIENT)
    .setAudience(overrides?.audience ?? "https://appleid.apple.com").setIssuedAt()
    .setExpirationTime(overrides?.expiry ?? "5m").sign(privateKey);
  for (const mutation of [{ kid: "foreign-key" }, { issuer: "foreign-team" }, { subject: "foreign-client" },
    { audience: "https://foreign.example.test" }, { expiry: "-1m" }]) {
    assert.equal((await exchange(f, code, { client_secret: await sign(mutation) })).value.error, "invalid_client");
  }
  const secret = await sign();
  const token = await exchange(f, code, { client_secret: secret });
  assert.equal(token.status, 200);
  assert.equal(decodeJwt(token.value.id_token).email, EMAIL);
  const refresh = await request(f.app, `${f.prefix}/token`, { grant_type: "refresh_token", client_id: CLIENT,
    client_secret: secret, refresh_token: token.value.refresh_token });
  assert.equal(refresh.status, 200);
});

test("Clerk and Okta public clients keep S256 PKCE flows and reject missing or incorrect proof", async () => {
  for (const provider of ["clerk", "okta"]) {
    const config = configuration(provider);
    const client = config[keys[provider]][0];
    delete client.client_secret;
    if (provider === "clerk") client.is_public = true;
    else client.token_endpoint_auth_method = "none";
    const f = fixture(provider, config);
    const missing = await request(f.app, `${f.prefix}/authorize?${new URLSearchParams({ client_id: CLIENT, redirect_uri: REDIRECT })}`);
    assert.equal(missing.status, 400);
    const verifier = "a-test-verifier-that-is-long-enough-for-the-pkce-contract";
    const code_challenge = createHash("sha256").update(verifier).digest("base64url");
    const { code } = await authorize(f, { code_challenge, code_challenge_method: "S256" });
    assert.equal((await exchange(f, code, { client_secret: "", code_verifier: "wrong" })).value.error, "invalid_grant");
    assert.equal((await exchange(f, code, { client_secret: "", code_verifier: verifier })).status, 200);
  }
});

test("invalid declarations and unresolved credential references fail before normal seeding", () => {
  for (const provider of Object.keys(PACKAGES)) {
    for (const mutate of [
      config => { config[keys[provider]].push({ ...config[keys[provider]][0] }); },
      config => { config[keys[provider]][0].redirect_uris = ["https://*.example.test/callback"]; },
      config => { delete config[keys[provider]][0].client_secret; config[keys[provider]][0].client_secret_ref = "oauth-client-secret:run"; },
      config => { config[keys[provider]][0].grant_types = ["password"]; },
    ]) {
      const mod = PACKAGES[provider];
      const lifecycle = wrapDeclaredOAuth(provider, mod[`${provider}Plugin`], mod.seedFromConfig);
      const server = createServer(lifecycle.plugin);
      const config = configuration(provider);
      mutate(config);
      const before = server.store.snapshot();
      assert.throws(() => lifecycle.seedFromConfig(server.store, server.baseUrl, config), /Declared OAuth/);
      assert.deepEqual(server.store.snapshot(), before);
    }
  }
});

test("Okta client_credentials requires a declared confidential client and its allowed scope", async () => {
  const config = configuration("okta");
  config.oauth_clients[0].scopes.push("catalog.read");
  const f = fixture("okta", config);
  const token = await request(f.app, `${f.prefix}/token`, { grant_type: "client_credentials", scope: "catalog.read" },
    { authorization: `Basic ${Buffer.from(`${CLIENT}:${SECRET}`).toString("base64")}` });
  assert.equal(token.status, 200);
  assert.equal(token.value.scope, "catalog.read");
  assert.equal(token.value.id_token, undefined);
  const defaultScope = await request(f.app, `${f.prefix}/token`, { client_id: CLIENT, client_secret: SECRET, grant_type: "client_credentials" });
  assert.equal(defaultScope.value.error, "invalid_scope");
  const publicConfig = configuration("okta");
  publicConfig.oauth_clients[0].token_endpoint_auth_method = "none";
  const publicFixture = fixture("okta", publicConfig);
  assert.equal((await request(publicFixture.app, `${publicFixture.prefix}/token`, {
    client_id: CLIENT, grant_type: "client_credentials", scope: "email",
  })).value.error, "unsupported_grant_type");
});

test("default authorization scopes cannot exceed the declared scope list", async () => {
  for (const provider of ["okta", "clerk"]) {
    const config = configuration(provider);
    config[keys[provider]][0].scopes = ["email"];
    const f = fixture(provider, config);
    const page = await request(f.app, `${f.prefix}/authorize?${new URLSearchParams({ client_id: CLIENT, redirect_uri: REDIRECT })}`);
    assert.equal(page.value.error, "invalid_scope");
  }
});
