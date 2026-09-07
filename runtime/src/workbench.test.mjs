import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import test from "node:test";
import { join } from "node:path";
import { openState } from "./state.mjs";

import {
  sanitizeNotionInspection,
  sanitizePublicBindings,
  providerBrowserUrl,
  providerOverview,
  registerOAuthRedirect,
  linearOverview,
  twilioOverview,
  selectNotionWebhookReveal,
  slackChannelTopic,
  startWorkbench,
  validWorkbenchRequest,
  workbenchWebhookSecretRevealEnabled,
} from "./workbench.mjs";

const ROOT = join(import.meta.dirname, "../..");
const CREDENTIALS = { values: { "token:slack_token": randomBytes(24).toString("hex") } };

test("Workbench rejects foreign Host and cross-origin browser writes", () => {
  assert.equal(validWorkbenchRequest({ method: "GET", headers: { host: "attacker.example" } }), false);
  assert.equal(validWorkbenchRequest({ method: "GET", headers: { host: "127.0.0.1:4715" } }), true);
  assert.equal(validWorkbenchRequest({ method: "POST", headers: {
    host: "127.0.0.1:4715", origin: "http://attacker.example", "sec-fetch-site": "cross-site",
  } }), false);
  assert.equal(validWorkbenchRequest({ method: "POST", headers: {
    host: "localhost:4715", origin: "http://localhost:4715", "sec-fetch-site": "same-origin",
  } }), true);
});

test("OAuth callback registration uses the active client and runtime credential", async () => {
  let received;
  const added = await registerOAuthRedirect({ GOOGLE_BASE_URL: "http://google.test", GOOGLE_CLIENT_ID: "local-client" },
    "runtime-secret", { provider: "google", redirect_uri: "http://127.0.0.1:5173/oauth/google/callback" },
    async (url, options) => {
      received = { url, options, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });
  assert.equal(received.url, "http://google.test/__worldfixture/oauth/redirects");
  assert.equal(received.options.headers.authorization, "Bearer runtime-secret");
  assert.deepEqual(received.body, { client_id: "local-client", redirect_uri: "http://127.0.0.1:5173/oauth/google/callback" });
  assert.equal(added.client_id, "local-client");
});

test("Gmail reads use the selected declared mailbox credential", async () => {
  const tokens = [];
  const provider = createServer((request, response) => {
    tokens.push(request.headers.authorization);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ messages: [], resultSizeEstimate: 0 }));
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  const instance = { state: { prepare: () => ({ get: () => ({ seq: 0 }) }) },
    credentials: { values: { ...CREDENTIALS.values, "token:google_token_noor-alvarez": "noor-only" } },
    applicationBindings: { GOOGLE_BASE_URL: `http://127.0.0.1:${provider.address().port}`, GOOGLE_TOKEN: "primary-only" } };
  const workbench = await startWorkbench(instance, { artifactPath: join(ROOT, "dist/business.saas-company.v2"), stateDir: ROOT });
  try {
    const result = await fetch(`${workbench.url}/api/provider/gmail?person_id=noor-alvarez`);
    assert.equal(result.status, 200);
    assert.match((await result.json()).email, /^noor/);
    assert.deepEqual(tokens, ["Bearer noor-only", "Bearer noor-only"]);
    const invalid = await fetch(`${workbench.url}/api/provider/gmail?person_id=not-a-world-person`);
    assert.equal(invalid.status, 500);
    assert.equal(tokens.length, 2);
  } finally { await workbench.close(); await new Promise(resolve => provider.close(resolve)); }
});

test("Workbench payment amounts use explicit currency minor units without a USD minimum", async () => {
  const forms = [];
  const provider = createServer(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += chunk;
    forms.push(Object.fromEntries(new URLSearchParams(raw)));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "pi_one_yen", amount: 1, currency: "jpy", status: "succeeded" }));
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  const directory = mkdtempSync(join(tmpdir(), "wf-workbench-payment-"));
  const state = openState(join(directory, "state.sqlite"));
  const workbench = await startWorkbench({ state, credentials: CREDENTIALS,
    applicationBindings: { STRIPE_BASE_URL: `http://127.0.0.1:${provider.address().port}`, STRIPE_TOKEN: "local-stripe" } },
  { artifactPath: join(ROOT, "dist/business.saas-company.v2"), stateDir: directory });
  const send = value => fetch(`${workbench.url}/api/actions/stripe-payment`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ person_id: "maya-chen", ...value }) });
  try {
    for (const value of [{ amount_cents: 1 }, { amount_cents: 0, currency: "jpy" }, { amount_cents: 1.5, currency: "usd" }, { amount_cents: Number.MAX_SAFE_INTEGER + 1, currency: "usd" }]) {
      assert.equal((await send(value)).status, 400);
    }
    assert.equal(forms.length, 0);
    const accepted = await send({ amount_cents: 1, currency: "JPY" });
    assert.equal(accepted.status, 200);
    const result = await accepted.json();
    assert.equal(result.event.provider_evidence.currency, "jpy");
    assert.equal(forms[0].amount, "1"); assert.equal(forms[0].currency, "jpy");
  } finally { await workbench.close(); state.close(); rmSync(directory, { recursive: true, force: true }); await new Promise(resolve => provider.close(resolve)); }
});

test("a reduced world does not report omitted services or projection-only Microsoft data", async () => {
  const result = await providerOverview({ MICROSOFT_BASE_URL: "http://127.0.0.1:1" }, join(ROOT, "dist/business.saas-company.v3"), {
    organizations: [], people: [], communication: {}, software: {},
  });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.slack.channels, []);
  assert.deepEqual(result.github.repositories, []);
  assert.deepEqual(result.notion.pages, []);
  assert.equal(Object.hasOwn(result, "microsoft"), false);
});

// The bug this closes: the Target screen's "Copy .env" button copies this map,
// and this map dropped every credential -- 15 of the 28 declared provider
// bindings. A reader pasted it in and every provider call answered 401, with
// nothing on the screen saying the file was half a file. The tokens are
// synthetic, regenerated per run, printed by `worldfixture env` and already on
// disk in `host-bindings.json`, so withholding them protected nothing.
test("Workbench browser bindings carry the world's own credentials", () => {
  const bindings = {
    NOTION_BASE_URL: "http://127.0.0.1:4716",
    IMAP_HOST_PORT: "127.0.0.1:1143",
    IMAP_USERNAME: "maya@example.test",
    NOTION_TOKEN: "notion-rest-secret",
    NOTION_ADMIN_TOKEN: "notion-admin-secret",
    IMAP_PASSWORD: "mail-secret",
    S3_SECRET_ACCESS_KEY: "access-key",
  };

  assert.deepEqual(sanitizePublicBindings(bindings), bindings,
    "an application cannot authenticate against a world with the addresses alone");
});

// The connector token is not world data. It is the credential that writes into
// the developer's own application, so it is the one binding the browser never
// receives, whatever else travels.
test("the connector token is the one binding the browser never receives", () => {
  const result = sanitizePublicBindings({
    SLACK_BASE_URL: "http://127.0.0.1:4711",
    SLACK_TOKEN: "xoxb-world-token",
    WORLDFIXTURE_TOKEN: "wf_local_deadbeef",
  });

  assert.deepEqual(result, { SLACK_BASE_URL: "http://127.0.0.1:4711", SLACK_TOKEN: "xoxb-world-token" });
  assert.equal(Object.hasOwn(result, "WORLDFIXTURE_TOKEN"), false);
});

test("provider links use the active browser binding and keep their resource path", () => {
  assert.equal(
    providerBrowserUrl("http://localhost:4716/notion/dff277c5163349f0864817c5e4afcfda?v=abc", "http://127.0.0.1:53480"),
    "http://127.0.0.1:53480/notion/dff277c5163349f0864817c5e4afcfda?v=abc",
  );
});

test("Workbench downloads a no-store Postman collection for the active run", async () => {
  const directory = mkdtempSync(join(tmpdir(), "wf-postman-"));
  const instance = {
    state: { prepare: () => ({ get: () => ({ seq: 0 }) }) },
    credentials: CREDENTIALS,
    applicationBindings: {
      WORKBENCH_URL: "http://127.0.0.1:58999",
      SLACK_BASE_URL: "http://127.0.0.1:58831",
      SLACK_TOKEN: "active-slack-token",
    },
    lock: { world: { artifact_sha256: "test" }, services: [] },
    serviceStates: new Map(),
  };
  const workbench = await startWorkbench(instance, {
    artifactPath: join(ROOT, "dist/business.saas-company.v3"), stateDir: directory,
  });
  try {
    const response = await fetch(`${workbench.url}/api/postman`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(response.headers.get("content-disposition"), /business\.saas-company\.v3\.postman_collection\.json/);
    const collection = await response.json();
    assert.equal(collection.variable.find(value => value.key === "WORKBENCH_URL").value, "http://127.0.0.1:58999");
    assert.equal(collection.variable.find(value => value.key === "SLACK_TOKEN").value, "active-slack-token");
    assert.match(JSON.stringify(collection), /\/slack\/api\/auth\.test/);
  } finally {
    await workbench.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Workbench adds OAuth callbacks only for the connected application origin", async () => {
  const directory = mkdtempSync(join(tmpdir(), "wf-oauth-callback-"));
  const requests = [];
  const provider = createServer(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += chunk;
    requests.push({ url: request.url, authorization: request.headers.authorization, body: JSON.parse(raw) });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  writeFileSync(join(directory, "application-connector.json"), JSON.stringify({
    url: "http://127.0.0.1:5173", transport_url: "http://127.0.0.1:5173",
  }));
  const instance = {
    state: { prepare: () => ({ get: () => ({ seq: 0 }) }) }, credentials: CREDENTIALS,
    runtimeToken: "runtime-secret", applicationBindings: {
      GOOGLE_BASE_URL: `http://127.0.0.1:${provider.address().port}`, GOOGLE_CLIENT_ID: "local-client",
    }, lock: { world: { artifact_sha256: "world-build" }, services: [] }, serviceStates: new Map(),
  };
  const workbench = await startWorkbench(instance, {
    artifactPath: join(ROOT, "dist/business.saas-company.v3"), stateDir: directory,
  });
  const add = redirect_uri => fetch(`${workbench.url}/api/oauth/redirects`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "google", redirect_uri }) });
  try {
    const foreign = await add("http://localhost:5173/oauth/google/callback");
    assert.equal(foreign.status, 400);
    assert.equal(requests.length, 0);
    const accepted = await add("http://127.0.0.1:5173/oauth/google/callback");
    assert.equal(accepted.status, 200);
    assert.equal(requests[0].authorization, "Bearer runtime-secret");
    assert.equal(requests[0].body.client_id, "local-client");
    const saved = await (await fetch(`${workbench.url}/api/oauth/redirects`)).json();
    assert.deepEqual(saved.redirects[0], {
      provider: "google", client_id: "local-client", redirect_uri: "http://127.0.0.1:5173/oauth/google/callback",
      artifact_sha256: "world-build", generation: "unmanaged",
    });
  } finally {
    await workbench.close(); await new Promise(resolve => provider.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Linear Workbench data comes from the live GraphQL API", async () => {
  const provider = createServer(async (request, response) => {
    let requestBody = "";
    for await (const chunk of request) requestBody += chunk;
    assert.equal(request.url, "/graphql");
    assert.equal(request.method, "POST");
    assert.equal(request.headers.authorization, "Bearer linear-token");
    assert.match(JSON.parse(requestBody).query, /WorldFixtureWorkbench/);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: {
      organization: { id: "org-1", name: "Example" },
      teams: { nodes: [{ id: "team-1", name: "Engineering", key: "ENG" }], pageInfo: { hasNextPage: false } },
      workflowStates: { nodes: [{ id: "state-1", name: "Under review", type: "started" }], pageInfo: { hasNextPage: false } },
      issues: { nodes: [{ id: "issue-1", identifier: "ENG-1", title: "Live issue",
        state: { id: "state-1", name: "Under review", type: "started" }, assignee: { name: "Maya", email: "maya@example.test" },
        labels: { nodes: [{ name: "release" }] } }], pageInfo: { hasNextPage: false } },
    } }));
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  try {
    const result = await linearOverview({
      LINEAR_BASE_URL: `http://127.0.0.1:${provider.address().port}`, LINEAR_TOKEN: "linear-token",
    });
    assert.equal(result.teams[0].key, "ENG");
    assert.deepEqual(result.issues[0], {
      id: "issue-1", identifier: "ENG-1", title: "Live issue", state: { id: "state-1", name: "Under review", type: "started" },
      assignee: "maya@example.test", labels: ["release"],
    });
  } finally {
    await new Promise((resolve) => provider.close(resolve));
  }
});

test("Twilio Workbench data uses Basic auth and live REST lists", async () => {
  const provider = createServer((request, response) => {
    assert.equal(request.headers.authorization, `Basic ${Buffer.from("AC123:auth-secret").toString("base64")}`);
    const bodies = {
      "/2010-04-01/Accounts/AC123.json": { sid: "AC123", friendly_name: "Example" },
      "/2010-04-01/Accounts/AC123/IncomingPhoneNumbers.json": { incoming_phone_numbers: [{ sid: "PN1" }], page: 0, next_page_uri: null },
      "/messaging/v1/Services": { services: [{ sid: "MG1" }], page: 0, next_page_uri: null },
      "/verify/v2/Services": { services: [{ sid: "VA1" }], page: 0, next_page_uri: null },
    };
    response.writeHead(bodies[new URL(request.url, "http://local.test").pathname] ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify(bodies[new URL(request.url, "http://local.test").pathname] ?? { message: "missing" }));
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  try {
    const result = await twilioOverview({ TWILIO_BASE_URL: `http://127.0.0.1:${provider.address().port}`,
      TWILIO_ACCOUNT_SID: "AC123", TWILIO_AUTH_TOKEN: "auth-secret" });
    assert.equal(result.account.sid, "AC123");
    assert.equal(result.phone_numbers[0].sid, "PN1");
    assert.equal(result.messaging_services[0].sid, "MG1");
    assert.equal(result.verify_services[0].sid, "VA1");
  } finally {
    await new Promise((resolve) => provider.close(resolve));
  }
});

test("Notion inspection state hides webhook secrets and full signatures", () => {
  const result = sanitizeNotionInspection({
    webhook_subscriptions: [{ notion_id: "subscription-1", status: "pending", verification_token: "verify-secret" }],
    webhook_verification_deliveries: [{ notion_id: "verification-1", raw_body: '{"verification_token":"verify-secret"}' }],
    webhook_deliveries: [{ notion_id: "delivery-1", signature: "sha256=1234567890abcdef1234567890abcdef", headers: { "X-Notion-Signature": "sha256=1234567890abcdef1234567890abcdef", "Content-Type": "application/json" } }],
  });
  assert.equal(result.webhook_subscriptions[0].verification_token, undefined);
  assert.equal(result.webhook_verification_deliveries, undefined);
  assert.equal(result.webhook_deliveries[0].signature, undefined);
  assert.equal(result.webhook_deliveries[0].headers["X-Notion-Signature"], undefined);
  assert.equal(result.webhook_deliveries[0].headers["Content-Type"], "application/json");
  assert.match(result.webhook_deliveries[0].signature_fingerprint, /^sha256=/);
  assert.doesNotMatch(JSON.stringify(result), /verify-secret|1234567890abcdef1234567890abcdef/);
});

test("webhook value reveal is an explicit environment switch", () => {
  assert.equal(workbenchWebhookSecretRevealEnabled(undefined), false);
  assert.equal(workbenchWebhookSecretRevealEnabled("0"), false);
  assert.equal(workbenchWebhookSecretRevealEnabled("true"), false);
  assert.equal(workbenchWebhookSecretRevealEnabled("1"), true);
});

test("webhook reveal returns only the selected verification token or captured request", () => {
  const inspection = {
    webhook_subscriptions: [
      { notion_id: "subscription-1", verification_token: "verify-secret", url: "https://example.test/notion" },
    ],
    webhook_verification_deliveries: [
      { notion_id: "verification-1", raw_body: '{"verification_token":"verify-secret"}', payload: { verification_token: "verify-secret" }, headers: { "X-Notion-Signature": "sha256=setup" }, status: "captured" },
    ],
    webhook_deliveries: [
      { notion_id: "delivery-1", raw_body: '{"type":"page.created"}', payload: { type: "page.created" }, headers: { "X-Notion-Signature": "sha256=event" }, status: "captured" },
    ],
  };

  assert.deepEqual(selectNotionWebhookReveal(inspection, { kind: "verification_token", id: "subscription-1" }), {
    kind: "verification_token", id: "subscription-1", verification_token: "verify-secret",
  });
  assert.deepEqual(selectNotionWebhookReveal(inspection, { kind: "delivery", id: "delivery-1" }), {
    kind: "delivery", id: "delivery-1", headers: { "X-Notion-Signature": "sha256=event" },
    raw_body: '{"type":"page.created"}', payload: { type: "page.created" },
  });
  assert.equal(selectNotionWebhookReveal(inspection, { kind: "delivery", id: "missing" }), null);
  assert.equal(selectNotionWebhookReveal(inspection, { kind: "unsupported", id: "delivery-1" }), null);
});

test("Workbench enforces the reveal switch and sends no-store reveal responses", async () => {
  const provider = createServer((request, response) => {
    assert.equal(request.url, "/__worldfixture/notion-admin");
    assert.equal(request.headers.authorization, "Bearer notion-token");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      webhook_subscriptions: [{ notion_id: "subscription-1", verification_token: "verify-secret" }],
    }));
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const providerUrl = `http://127.0.0.1:${provider.address().port}`;
  const state = { prepare: () => ({ get: () => ({ seq: 0 }) }) };
  const instance = { state, credentials: CREDENTIALS, applicationBindings: { NOTION_BASE_URL: providerUrl, NOTION_TOKEN: "notion-token" }, bindings: () => ({}) };
  const options = { artifactPath: join(ROOT, "dist/business.saas-company.v3"), stateDir: ROOT };
  const disabled = await startWorkbench(instance, { ...options, revealWebhookSecrets: false });
  const enabled = await startWorkbench(instance, { ...options, revealWebhookSecrets: true });
  try {
    const refused = await fetch(`${disabled.url}/api/inspect/notion/webhook-value`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "verification_token", id: "subscription-1" }),
    });
    assert.equal(refused.status, 403);
    assert.equal(refused.headers.get("cache-control"), "no-store");

    const accepted = await fetch(`${enabled.url}/api/inspect/notion/webhook-value`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "verification_token", id: "subscription-1" }),
    });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get("cache-control"), "no-store");
    assert.equal((await accepted.json()).result.verification_token, "verify-secret");
  } finally {
    await disabled.close();
    await enabled.close();
    await new Promise((resolve) => provider.close(resolve));
  }
});

test("a cleared provider topic stays empty instead of restoring the authored topic", () => {
  const declared = { name: "general", topic: "Company updates and questions for everyone" };
  assert.equal(slackChannelTopic({ name: "general", topic: { value: "" } }, declared), "");
  assert.equal(slackChannelTopic({ name: "general", topic: { value: "Release 3.2" } }, declared), "Release 3.2");
  assert.equal(slackChannelTopic({ name: "general" }, declared), declared.topic);
  assert.equal(slackChannelTopic({ name: "general", topic: { value: "" } }, undefined), "");
});

test("the Workbench overview preserves a live topic clear on its next provider read", async t => {
  let topic = "Authored topic";
  const provider = createServer((request, response) => {
    const body = request.url === "/api/conversations.list"
      ? { channels: [{ id: "C_TOPIC", name: "general", topic: { value: topic } }] }
      : request.url === "/api/conversations.history" ? { messages: [] } : { members: [] };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, response_metadata: { next_cursor: "" }, ...body }));
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => provider.close(resolve)));
  const bindings = { SLACK_BASE_URL: `http://127.0.0.1:${provider.address().port}`, SLACK_TOKEN: "topic-test-token" };
  const world = { communication: { channels: [{ id: "source-channel", name: "general", topic }] } };
  assert.equal((await providerOverview(bindings, ROOT, world)).slack.channels[0].topic, topic);
  topic = "";
  assert.equal((await providerOverview(bindings, ROOT, world)).slack.channels[0].topic, "");
});


test("the Workbench overview keeps the Slack count unknown when a live history read fails", async t => {
  const provider = createServer((request, response) => {
    if (request.url === "/api/conversations.history") {
      response.writeHead(503, { "content-type": "application/json" });
      return response.end(JSON.stringify({ error: "history unavailable" }));
    }
    const value = request.url === "/api/conversations.list"
      ? { channels: [{ id: "C_FAILED_HISTORY", name: "general" }] } : { members: [] };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, response_metadata: { next_cursor: "" }, ...value }));
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => provider.close(resolve)));
  const result = await providerOverview({ SLACK_BASE_URL: `http://127.0.0.1:${provider.address().port}`, SLACK_TOKEN: "history-test-token" }, ROOT, {});
  assert.equal(result.slack.status, "partial");
  assert.equal(result.slack.messageCount, null);
  assert.equal(result.slack.channels[0].messageCount, null);
  assert.equal(result.slack.collectionStatus.messageCount.status, "failed");
  assert.match(result.slack.error, /503/);
});

test("Slack history names its authors from the provider's own member list", async () => {
  let userListReads = 0;
  const provider = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    if (request.url === "/api/users.list") {
      userListReads += 1;
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(JSON.stringify({ ok: true, response_metadata: { next_cursor: "" }, members: [
        { id: "U6070E88FB", name: "hironakamura", real_name: "Hiro Nakamura", profile: { real_name: "Hiro Nakamura" } },
        { id: "UBOT", name: "releasebot", real_name: "", profile: { real_name: "" } },
      ] }));
    }
    assert.equal(request.url, "/api/conversations.history");
    assert.match(body, /channel=C000000001/);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, messages: [
      { type: "message", user: "U6070E88FB", text: "Writing it down.", ts: "1818688680.000056" },
      { type: "message", user: "UBOT", text: "Deployed.", ts: "1818688600.000055" },
      { type: "message", user: "UNKNOWN", text: "Who am I?", ts: "1818688500.000054" },
    ] }));
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const providerUrl = `http://127.0.0.1:${provider.address().port}`;
  const state = { prepare: () => ({ get: () => ({ seq: 0 }) }) };
  const instance = { state, credentials: CREDENTIALS, applicationBindings: { SLACK_BASE_URL: providerUrl, SLACK_TOKEN: "slack-token" }, bindings: () => ({}) };
  const workbench = await startWorkbench(instance, { artifactPath: join(ROOT, "dist/business.saas-company.v3"), stateDir: ROOT });
  try {
    const result = await (await fetch(`${workbench.url}/api/provider/slack?channel=C000000001`)).json();
    assert.equal(result.messages[0].user_name, "Hiro Nakamura");
    // A member whose display name is empty falls back to the handle rather than
    // to the empty string: this is the `||` the sweep is about.
    assert.equal(result.messages[1].user_name, "releasebot");
    // An id even Slack cannot name leaves the id on screen instead of nothing.
    assert.equal(result.messages[2].user_name, undefined);
    // An unresolved author costs exactly one re-read of the member list, not
    // one read per message: the workspace token is metered.
    assert.equal(userListReads, 2);
  } finally {
    await workbench.close();
    await new Promise((resolve) => provider.close(resolve));
  }
});

test('expanded Gmail uses the selected person and GitHub details paginate comments on the configured provider', async t => {
  const calls = [];
  const provider = createServer((request, response) => {
    calls.push({ path: request.url, token: request.headers.authorization });
    let value;
    if (request.url.includes('/gmail/')) value = { id: 'mail_1', payload: { mimeType: 'text/plain', body: { data: Buffer.from('Full email content').toString('base64url') } } };
    else if (request.url.includes('/comments?')) value = request.url.endsWith('page=1') ? Array.from({ length: 100 }, (_, id) => ({ id, body: `Comment ${id}` })) : [{ id: 100, body: 'Last comment' }];
    else value = { body: 'Full issue description' };
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value));
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${provider.address().port}`;
  const workbench = await startWorkbench({ state: { prepare: () => ({ get: () => ({ seq: 0 }) }) },
    credentials: { values: { ...CREDENTIALS.values, 'token:google_token_noor-alvarez': 'noor-only' } },
    applicationBindings: { GOOGLE_BASE_URL: base, GOOGLE_TOKEN: 'primary', GITHUB_BASE_URL: base, GITHUB_TOKEN: 'github-only' } },
    { artifactPath: join(ROOT, 'dist/business.saas-company.v2'), stateDir: ROOT });
  t.after(async () => { await workbench.close(); await new Promise(resolve => provider.close(resolve)); });
  const mail = await fetch(`${workbench.url}/api/provider/gmail-message?person_id=noor-alvarez&id=mail_1`);
  assert.equal((await mail.json()).text, 'Full email content');
  assert.deepEqual(calls[0], { path: '/gmail/v1/users/me/messages/mail_1?format=full', token: 'Bearer noor-only' });
  const issue = await fetch(`${workbench.url}/api/provider/github-issue?repository=owner/repo&number=1`);
  const body = await issue.json();
  assert.equal(body.text, 'Full issue description'); assert.equal(body.comments.length, 101);
  const count = calls.length;
  for (const query of ['repository=https://other.test/repo&number=1', 'repository=owner/repo&number=../2', 'repository=../repo&number=1']) {
    const response = await fetch(`${workbench.url}/api/provider/github-issue?${query}`); assert.equal(response.status, 400);
  }
  assert.equal(calls.length, count);
});
