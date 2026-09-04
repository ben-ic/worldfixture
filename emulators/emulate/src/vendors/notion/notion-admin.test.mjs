import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { Client } from "@notionhq/client";
import { createServer } from "@emulators/core";

import { plugin, seedFromConfig } from "./index.mjs";
import { NOTION_VERSION } from "./rest.mjs";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const PAGE_ID = "10000000-0000-4000-8000-000000000001";
const DATABASE_ID = "30000000-0000-4000-8000-000000000001";
const DATA_SOURCE_ID = "40000000-0000-4000-8000-000000000001";

function fixture() {
  const baseUrl = "http://notion.worldfixture.test";
  const server = createServer(plugin, { baseUrl, tokens: { inspector: { login: "maya@example.test", id: 1, scopes: ["read:user", "read:content", "insert:content", "update:content"] } } });
  seedFromConfig(server.store, baseUrl, { workspace: { id: "60000000-0000-4000-8000-000000000001", name: "Northstar" }, users: [{ id: USER_ID, name: "Maya", email: "maya@example.test" }], pages: [{ id: PAGE_ID, title: "Plan", created_by: USER_ID, accessible_by: [USER_ID] }], databases: [{ id: DATABASE_ID, title: "Projects", created_by: USER_ID, accessible_by: [USER_ID] }], data_sources: [{ id: DATA_SOURCE_ID, database_id: DATABASE_ID, name: "Projects", properties: { Name: { type: "title" } }, created_by: USER_ID, accessible_by: [USER_ID] }] });
  return server;
}

const headers = { Authorization: "Bearer inspector", "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" };

test("private webhook administration verifies subscriptions and captures signed events without external delivery", async () => {
  const { app } = fixture();
  const created = await app.request("/__worldfixture/notion-admin/webhooks", { method: "POST", headers, body: JSON.stringify({ url: "https://hooks.worldfixture.test/notion", event_types: ["page.properties_updated"] }) });
  assert.equal(created.status, 201);
  const subscription = await created.json();
  assert.equal(subscription.status, "pending");

  const verified = await app.request(`/__worldfixture/notion-admin/webhooks/${subscription.id}/verify`, { method: "POST", headers, body: JSON.stringify({ verification_token: subscription.verification_token }) });
  assert.equal(verified.status, 200);
  await app.request(`/v1/pages/${PAGE_ID}`, { method: "PATCH", headers, body: JSON.stringify({ icon: { type: "emoji", emoji: "🚀" } }) });

  const admin = await (await app.request("/__worldfixture/notion-admin", { headers })).json();
  assert.equal(admin.live_webhook_delivery, false);
  assert.equal(admin.webhook_deliveries.length, 1);
  const delivery = admin.webhook_deliveries[0];
  assert.equal(delivery.payload.type, "page.properties_updated");
  assert.equal(delivery.payload.entity.id, PAGE_ID);
  assert.equal(delivery.payload.api_version, NOTION_VERSION);
  assert.equal(delivery.payload.workspace_name, "Northstar");
  assert.match(delivery.payload.id, /^[0-9a-f-]{36}$/);
  assert.match(delivery.payload.subscription_id, /^[0-9a-f-]{36}$/);
  assert.match(delivery.payload.integration_id, /^[0-9a-f-]{36}$/);
  assert.equal(delivery.signature, `sha256=${createHmac("sha256", subscription.verification_token).update(JSON.stringify(delivery.payload)).digest("hex")}`);
});

test("current lock, trash, and data-source webhook transitions use current response fields and event names", async () => {
  const { app } = fixture();
  const eventTypes = ["page.locked", "page.unlocked", "page.deleted", "page.undeleted", "database.deleted", "database.undeleted", "data_source.schema_updated", "data_source.deleted", "data_source.undeleted"];
  const created = await app.request("/__worldfixture/notion-admin/webhooks", { method: "POST", headers, body: JSON.stringify({ url: "https://hooks.worldfixture.test/notion-current", event_types: eventTypes }) });
  const subscription = await created.json();
  await app.request(`/__worldfixture/notion-admin/webhooks/${subscription.id}/verify`, { method: "POST", headers, body: JSON.stringify({ verification_token: subscription.verification_token }) });

  for (const input of [{ is_locked: true }, { is_locked: false }, { in_trash: true }, { in_trash: false }]) {
    const response = await app.request(`/v1/pages/${PAGE_ID}`, { method: "PATCH", headers, body: JSON.stringify(input) });
    assert.equal(response.status, 200);
    assert.equal((await response.json())[Object.keys(input)[0]], Object.values(input)[0]);
  }
  for (const input of [{ in_trash: true }, { in_trash: false }]) {
    const response = await app.request(`/v1/databases/${DATABASE_ID}`, { method: "PATCH", headers, body: JSON.stringify(input) });
    assert.equal(response.status, 200);
  }
  for (const input of [{ properties: { Priority: { type: "select" } } }, { in_trash: true }, { in_trash: false }]) {
    const response = await app.request(`/v1/data_sources/${DATA_SOURCE_ID}`, { method: "PATCH", headers, body: JSON.stringify(input) });
    assert.equal(response.status, 200);
  }

  const admin = await (await app.request("/__worldfixture/notion-admin", { headers })).json();
  assert.deepEqual(admin.webhook_deliveries.map((item) => item.event_type), eventTypes);
});

test("official SDK 5.26.0 creates, introspects, refreshes, and revokes public connection tokens", async () => {
  const { app, baseUrl } = fixture();
  const registration = await (await app.request("/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "Public app", redirect_uris: ["https://client.worldfixture.test/callback"], token_endpoint_auth_method: "client_secret_basic" }) })).json();
  const authorize = new URL(`${baseUrl}/v1/oauth/authorize`);
  authorize.search = new URLSearchParams({ client_id: registration.client_id, redirect_uri: registration.redirect_uris[0], response_type: "code", owner: "user", state: "public-state" });
  assert.equal((await app.request(authorize.toString())).status, 200);
  const consent = await app.request("/v1/oauth/authorize", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: registration.client_id, redirect_uri: registration.redirect_uris[0], response_type: "code", owner: "user", state: "public-state", user_id: USER_ID, decision: "approve" }) });
  const code = new URL(consent.headers.get("location")).searchParams.get("code");

  const client = new Client({ baseUrl, notionVersion: NOTION_VERSION, fetch: (url, init) => app.request(url, init) });
  const token = await client.oauth.token({ client_id: registration.client_id, client_secret: registration.client_secret, grant_type: "authorization_code", code, redirect_uri: registration.redirect_uris[0] });
  assert.equal(token.owner.user.id, USER_ID);
  assert.equal((await client.oauth.introspect({ client_id: registration.client_id, client_secret: registration.client_secret, token: token.access_token })).active, true);

  const refreshed = await client.oauth.token({ client_id: registration.client_id, client_secret: registration.client_secret, grant_type: "refresh_token", refresh_token: token.refresh_token });
  assert.notEqual(refreshed.access_token, token.access_token);
  const authorized = new Client({ auth: refreshed.access_token, baseUrl, notionVersion: NOTION_VERSION, fetch: (url, init) => app.request(url, init) });
  assert.equal((await authorized.users.list({})).results[0].id, USER_ID);
  await client.oauth.revoke({ client_id: registration.client_id, client_secret: registration.client_secret, token: refreshed.access_token });
  assert.equal((await client.oauth.introspect({ client_id: registration.client_id, client_secret: registration.client_secret, token: refreshed.access_token })).active, false);
});
