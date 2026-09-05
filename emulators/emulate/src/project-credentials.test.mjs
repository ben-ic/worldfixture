import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalJWKSet, jwtVerify } from "jose";
import { credential, prepareCredentials } from "../../../runtime/src/credentials.mjs";
import { loadSeedConfig } from "./seed-config.mjs";

const ROOT = join(import.meta.dirname, "../../..");
const artifactPath = join(ROOT, "dist/business.saas-company.v2");
const overlay = JSON.parse(readFileSync(join(artifactPath, "projections/emulator-overlay.json")));
const lock = { world: { id: "business.saas-company", version: "v2" }, services: [] };
const vendors = ["slack", "github", "google", "notion", "stripe", "resend", "mongoatlas", "twilio", "microsoft", "vercel", "clerk", "okta", "linear"];

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function startComposer(t, root) {
  const ports = Object.fromEntries(await Promise.all(vendors.map(async vendor => [vendor, await freePort()])));
  const child = spawn(process.execPath, [join(import.meta.dirname, "main.mjs")], {
    cwd: join(import.meta.dirname, ".."),
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("WORLDFIXTURE_"))),
      WORLDFIXTURE_WORLD_PATH: artifactPath,
      WORLDFIXTURE_CREDENTIALS: join(root, "run/credentials.json"),
      WORLDFIXTURE_TIMELINE_OWNER: "runtime",
      ...Object.fromEntries(Object.entries(ports).map(([vendor, port]) => [`WORLDFIXTURE_PORT_${vendor.toUpperCase()}`, String(port)])),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
  });
  let output = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`composer startup timed out: ${output}`)), 20_000);
    const data = chunk => {
      output += chunk;
      if (output.includes("aggregate readiness →")) { clearTimeout(timer); resolve(); }
    };
    child.stdout.on("data", data);
    child.stderr.on("data", data);
    child.once("exit", () => { clearTimeout(timer); reject(new Error(output)); });
  });
  return (vendor, path, token, options = {}) => fetch(`http://127.0.0.1:${ports[vendor]}${path}`, {
    ...options,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers },
  });
}

test("managed provider tokens preserve identity and scopes, and reject old or other-project credentials", async t => {
  const root = mkdtempSync(join(tmpdir(), "worldfixture-provider-credentials-"));
  // Cleanup hooks run in registration order: remove files only after children exit.
  const prepare = project => prepareCredentials({ lock, artifactPath, stateDir: join(root, project, "run"), generatedSecretsPath: join(root, project, "secrets.json") });
  const credentials = await prepare("first");
  const other = await prepare("second");
  const request = await startComposer(t, join(root, "first"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const token = reference => credential(credentials, `token:${reference}`);
  const seeded = loadSeedConfig({ seedPath: join(import.meta.dirname, "../seed.yaml"), worldPath: artifactPath, credentialsPath: join(root, "first/run/credentials.json") });
  assert.deepEqual(Object.values(seeded.tokens), Object.values(overlay.tokens));
  assert.deepEqual(Object.keys(seeded.tokens), Object.keys(overlay.tokens).map(token));
  for (const [reference, user] of [["slack_token_maya-chen", "mayac"], ["slack_token_jon-bell", "jonbell"]]) {
    const body = await (await request("slack", "/api/auth.test", token(reference), { method: "POST" })).json();
    assert.equal(body.ok, true);
    assert.equal(body.user, user);
  }
  const github = await (await request("github", "/user", token("github_token"))).json();
  assert.equal(github.login, "mayac");
  const google = await (await request("google", "/oauth2/v2/userinfo", token("demo_token"))).json();
  assert.equal(google.email, "maya@northstar-relay.worldfixture.test");
  const notionOptions = { headers: { "Notion-Version": "2026-03-11" } };
  const notion = await (await request("notion", "/v1/users/me", token("notion_token_jon-bell"), notionOptions)).json();
  assert.equal(notion.id, overlay.notion.users.find(user => user.email === "jon@northstar-relay.worldfixture.test").id);
  assert.equal(notion.name, "Jon Bell");
  const adminOptions = { headers: { "Notion-Version": "2026-06-01" } };
  assert.equal((await request("notion", "/admin/v1/legal_holds", token("notion_admin_token"), adminOptions)).status, 200);
  assert.equal((await request("notion", "/admin/v1/legal_holds", token("notion_token"), adminOptions)).status, 403);
  const probes = [
    ["github", "/user", "github_token"],
    ["google", "/oauth2/v2/userinfo", "demo_token"],
    ["notion", "/v1/users/me", "notion_token", notionOptions],
    ["stripe", "/v1/customers", "stripe_token"],
    ["resend", "/domains", "resend_token"],
    ["mongoatlas", "/api/atlas/v2/groups", "mongoatlas_token"],
    ["microsoft", "/v1.0/me", "microsoft_token"],
    ["vercel", "/v2/user", "vercel_token"],
    ["clerk", "/oauth/userinfo", "clerk_token"],
    ["okta", "/api/v1/users", "okta_token"],
  ];
  for (const [vendor, path, reference, options] of probes) {
    await t.test(vendor, async () => {
      assert.equal((await request(vendor, path, token(reference), options)).status, 200);
      for (const invalid of [reference, credential(other, `token:${reference}`), "unknown-token", undefined]) {
        assert.equal((await request(vendor, path, invalid, options)).status, 401, `${vendor} accepted an invalid token`);
      }
    });
  }
  const linearOptions = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: "{ viewer { name email } }" }) };
  const linear = await (await request("linear", "/graphql", token("linear_token"), linearOptions)).json();
  assert.equal(linear.data?.viewer?.email, "maya@northstar-relay.worldfixture.test");
  for (const invalid of ["linear_token", credential(other, "token:linear_token"), "unknown-token", undefined]) {
    const body = await (await request("linear", "/graphql", invalid, linearOptions)).json();
    assert.ok(body.errors?.length, JSON.stringify(body));
    assert.ok(!body.data?.viewer);
  }
  for (const invalid of ["slack_token_maya-chen", credential(other, "token:slack_token_maya-chen"), "unknown-token", undefined]) {
    const body = await (await request("slack", "/api/auth.test", invalid, { method: "POST" })).json();
    assert.equal(body.ok, false);
    assert.equal(body.user, undefined);
  }
  const basic = (name, password) => ({ headers: { Authorization: `Basic ${Buffer.from(`${name}:${password}`).toString("base64")}` } });
  assert.equal((await request("stripe", "/v1/customers", undefined, basic(token("stripe_token"), ""))).status, 200);
  const account = overlay.twilio.account;
  const path = `/2010-04-01/Accounts/${account.sid}/Messages.json`;
  assert.equal((await request("twilio", path, undefined, basic(account.sid, credential(credentials, "twilio:account:auth_token")))).status, 200);
  assert.equal((await request("twilio", path, undefined, basic(account.sid, account.auth_token))).status, 401);
  const key = overlay.twilio.api_keys[0];
  assert.equal((await request("twilio", path, undefined, basic(key.sid, credential(credentials, `twilio:api_key:${key.sid}`)))).status, 200);
  assert.equal((await request("twilio", path, undefined, basic(key.sid, key.secret))).status, 401);
  assert.equal((await request("twilio", path, undefined, basic(account.sid, credential(other, "twilio:account:auth_token")))).status, 401);
  const clerk = await (await request("clerk", "/oauth/userinfo", token("clerk_token"))).json();
  assert.equal(clerk.email, "maya@northstar-relay.worldfixture.test");
  const verifyPassword = password => request("clerk", `/v1/users/${clerk.sub}/verify_password`, token("clerk_token"), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }),
  });
  assert.equal((await (await verifyPassword(credential(credentials, `clerk:password:${clerk.email}`))).json()).verified, true);
  assert.equal((await (await verifyPassword("worldfixture_test_password")).json()).verified, false);

  // OAuth must issue a separate access token for the selected person. It must
  // not replace that person's identity with the application's seeded token.
  const redirect_uri = "http://127.0.0.1:1/callback";
  const consent = await request("google", "/o/oauth2/v2/auth/callback", undefined, {
    method: "POST", redirect: "manual", body: new URLSearchParams({
      email: "maya@northstar-relay.worldfixture.test", client_id: "part-b-app",
      redirect_uri, scope: "openid email profile", state: "part-b-state",
    }),
  });
  const callback = new URL(consent.headers.get("location"));
  assert.equal(callback.searchParams.get("state"), "part-b-state");
  const grant = await (await request("google", "/oauth2/token", undefined, {
    method: "POST", body: new URLSearchParams({
      grant_type: "authorization_code", code: callback.searchParams.get("code"),
      client_id: "part-b-app", redirect_uri,
    }),
  })).json();
  assert.ok(grant.access_token);
  assert.ok(!Object.values(credentials.values).includes(grant.access_token));
  assert.equal((await (await request("google", "/oauth2/v2/userinfo", grant.access_token)).json()).email, "maya@northstar-relay.worldfixture.test");
  const keys = await (await request("google", "/oauth2/v3/certs")).json();
  const verified = await jwtVerify(grant.id_token, createLocalJWKSet(keys), { audience: "part-b-app", algorithms: ["RS256"] });
  assert.equal(verified.payload.email, "maya@northstar-relay.worldfixture.test");
});

test("managed seeding fails on a missing credential instead of retaining an artifact token", async t => {
  const root = mkdtempSync(join(tmpdir(), "worldfixture-missing-provider-credential-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const credentialsPath = join(root, "credentials.json");
  writeFileSync(credentialsPath, JSON.stringify({ api_version: "worldfixture.credentials/v1", values: {} }));
  assert.throws(() => loadSeedConfig({ seedPath: join(import.meta.dirname, "../seed.yaml"), worldPath: artifactPath, credentialsPath }), /no credential/);
});
