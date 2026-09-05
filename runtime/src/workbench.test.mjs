import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { join } from "node:path";

import {
  atlasDatabaseView,
  sanitizeNotionInspection,
  sanitizePublicBindings,
  providerBrowserUrl,
  providerOverview,
  publicTwilioProjection,
  linearOverview,
  twilioOverview,
  selectNotionWebhookReveal,
  slackChannelTopic,
  startWorkbench,
  stripePricesWithInterval,
  workbenchWebhookSecretRevealEnabled,
} from "./workbench.mjs";

const ROOT = join(import.meta.dirname, "../..");

test("a reduced world does not report omitted services as failures", async () => {
  const result = await providerOverview({}, join(ROOT, "dist/business.saas-company.v3"), {
    organizations: [], people: [], communication: {}, software: {},
  });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.slack.channels, []);
  assert.deepEqual(result.github.repositories, []);
  assert.deepEqual(result.notion.pages, []);
});

test("Workbench browser bindings contain addresses but no credentials", () => {
  assert.deepEqual(sanitizePublicBindings({
    NOTION_BASE_URL: "http://127.0.0.1:4716",
    NOTION_ADMIN_BASE_URL: "http://127.0.0.1:4716",
    IMAP_HOST_PORT: "127.0.0.1:1143",
    IMAP_USERNAME: "maya@example.test",
    SITE_BASE_URL: "http://127.0.0.1:8080",
    NOTION_TOKEN: "notion-rest-secret",
    NOTION_ADMIN_TOKEN: "notion-admin-secret",
    IMAP_PASSWORD: "mail-secret",
    AWS_ACCESS_KEY: "access-key",
  }), {
    NOTION_BASE_URL: "http://127.0.0.1:4716",
    NOTION_ADMIN_BASE_URL: "http://127.0.0.1:4716",
    IMAP_HOST_PORT: "127.0.0.1:1143",
    IMAP_USERNAME: "maya@example.test",
    SITE_BASE_URL: "http://127.0.0.1:8080",
  });
});

test("provider links use the active browser binding and keep their resource path", () => {
  assert.equal(
    providerBrowserUrl("http://localhost:4716/notion/dff277c5163349f0864817c5e4afcfda?v=abc", "http://127.0.0.1:53480"),
    "http://127.0.0.1:53480/notion/dff277c5163349f0864817c5e4afcfda?v=abc",
  );
});

test("Twilio browser data does not contain account, API key, or verification secrets", () => {
  const result = publicTwilioProjection({
    account: { sid: "AC123", friendly_name: "Test", auth_token: "account-secret" },
    api_keys: [{ sid: "SK123", secret: "api-key-secret" }],
    verify_services: [{ sid: "VA123", friendly_name: "Sign-in", code: "123456" }],
  });
  assert.deepEqual(result.account, { sid: "AC123", friendly_name: "Test" });
  assert.equal(result.api_keys, undefined);
  assert.equal(result.verify_services[0].code, undefined);
  assert.doesNotMatch(JSON.stringify(result), /secret|123456/);
});

test("Linear Workbench data comes from the live GraphQL API", async () => {
  const provider = createServer(async (request, response) => {
    let requestBody = "";
    for await (const chunk of request) requestBody += chunk;
    assert.equal(request.url, "/graphql");
    assert.equal(request.method, "POST");
    assert.equal(request.headers.authorization, "Bearer linear-token");
    assert.match(JSON.parse(requestBody).query, /issues\(first: 100\)/);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: {
      organization: { id: "org-1", name: "Example" },
      teams: { nodes: [{ id: "team-1", name: "Engineering", key: "ENG" }] },
      issues: { nodes: [{ id: "issue-1", identifier: "ENG-1", title: "Live issue",
        state: { name: "In Progress" }, assignee: { name: "Maya", email: "maya@example.test" },
        labels: { nodes: [{ name: "release" }] } }] },
    } }));
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  try {
    const result = await linearOverview({
      LINEAR_BASE_URL: `http://127.0.0.1:${provider.address().port}`, LINEAR_TOKEN: "linear-token",
    });
    assert.equal(result.teams[0].key, "ENG");
    assert.deepEqual(result.issues[0], {
      id: "issue-1", identifier: "ENG-1", title: "Live issue", state: "In Progress",
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
      "/2010-04-01/Accounts/AC123/IncomingPhoneNumbers.json": { incoming_phone_numbers: [{ sid: "PN1" }] },
      "/messaging/v1/Services": { services: [{ sid: "MG1" }] },
      "/verify/v2/Services": { services: [{ sid: "VA1" }] },
    };
    response.writeHead(bodies[request.url] ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify(bodies[request.url] ?? { message: "missing" }));
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
  const instance = { state, applicationBindings: { NOTION_BASE_URL: providerUrl, NOTION_TOKEN: "notion-token" }, bindings: () => ({}) };
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

// Closes: a channel whose topic the emulator reports as an empty string kept
// the empty string instead of falling through to the world's declared topic.
// The read was `channel.topic?.value ?? channel.topic ?? declared.topic`, and
// `??` does not fall back over "". The middle branch was unreachable as well:
// the emulator always emits `topic` as an object, so it could only ever have
// rendered the object itself.
test("a blank provider channel topic falls through to the topic the world declares", () => {
  const declared = { name: "general", topic: "Company updates and questions for everyone" };
  assert.equal(slackChannelTopic({ name: "general", topic: { value: "" } }, declared), declared.topic);
  assert.equal(slackChannelTopic({ name: "general", topic: { value: "Release 3.2" } }, declared), "Release 3.2");
  assert.equal(slackChannelTopic({ name: "general" }, declared), declared.topic);
  assert.equal(slackChannelTopic({ name: "general", topic: { value: "" } }, undefined), undefined);
});

// Closes: the product catalogue printed the literal word "recurring" in its
// INTERVAL column. `GET /v1/prices` answers `type: "recurring"` and carries no
// `recurring` object, while the same provider returns the complete price --
// `recurring: {interval: "month"}` -- inside a subscription item.
test("a listed Stripe price takes its billing interval from the provider's expanded copy", () => {
  const listed = [
    { id: "price_elmgrove", product: "prod_team", currency: "usd", unit_amount: 45700, type: "recurring" },
    { id: "price_unsubscribed", product: "prod_team", currency: "usd", unit_amount: 1000, type: "recurring" },
    { id: "price_setup", product: "prod_setup", currency: "usd", unit_amount: 500, type: "one_time" },
  ];
  const subscriptions = [
    { id: "sub_elmgrove", items: { data: [{ price: { id: "price_elmgrove", recurring: { interval: "month", interval_count: 1 } } }] } },
  ];
  const [team, unsubscribed, setup] = stripePricesWithInterval(listed, subscriptions);
  assert.equal(team.recurring.interval, "month");
  assert.equal(team.unit_amount, 45700);
  // A price the provider never expands stays blank rather than borrowing an
  // interval the API would not confirm.
  assert.equal(unsubscribed.recurring, undefined);
  assert.equal(setup.recurring, undefined);
  assert.equal(stripePricesWithInterval(undefined, undefined).length, 0);
});

// Closes: the Atlas data explorer rendered blank card titles and "No
// collections" for a database that really holds four. The databases route
// answers `{databaseName}` with no `name` and no `collections`; the collections
// live on their own route and arrive as `{collectionName, databaseName}`.
test("an Atlas database carries the name and collections the data explorer reads", () => {
  const view = atlasDatabaseView({ databaseName: "northstar" }, { name: "northstar-production" }, [
    { collectionName: "customers", databaseName: "northstar" },
    { collectionName: "invoices", databaseName: "northstar" },
  ]);
  assert.equal(view.name, "northstar");
  assert.equal(view.cluster, "northstar-production");
  assert.deepEqual(view.collections, ["customers", "invoices"]);
  // What Atlas really sent stays on the record so the drawer does not lie.
  assert.equal(view.databaseName, "northstar");
  // The React key used to degrade to "northstar-production-undefined".
  assert.equal(`${view.cluster}-${view.name}`, "northstar-production-northstar");
  assert.deepEqual(atlasDatabaseView({ databaseName: "northstar" }, { name: "c" }).collections, []);
});

// Closes: every Slack message was attributed to a raw member id. History
// carries `user` and no `user_name`, and the world's own `slack_id` values are
// in an id space the emulator never issues, so the name has to come from the
// provider's `users.list`.
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
  const instance = { state, applicationBindings: { SLACK_BASE_URL: providerUrl, SLACK_TOKEN: "slack-token" }, bindings: () => ({}) };
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
