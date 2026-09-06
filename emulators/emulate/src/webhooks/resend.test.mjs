import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer as httpServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { createServer } from "@emulators/core";
import { resendPlugin } from "@emulators/resend";
import { VENDORS } from "../registry.mjs";
import { extendResendWebhooksPlugin, RESEND_RETRY_DELAYS, seedResendWebhooks } from "./resend.mjs";

async function fixture(t, { retry = false, fail = false } = {}) {
  const received = [];
  const receiver = httpServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    received.push({ raw, headers: req.headers });
    res.writeHead(fail || (retry && received.length === 1) ? 500 : 200).end();
  });
  receiver.listen(0, "127.0.0.1");
  await once(receiver, "listening");
  t.after(() => receiver.close());
  const timers = [];
  const loaded = await VENDORS.resend.load();
  const server = createServer(retry || fail ? extendResendWebhooksPlugin(resendPlugin, {
    setTimer: (fn, delay) => { timers.push({ fn, delay }); return { unref() {} }; }, clearTimer() {},
  }) : loaded.plugin, { tokens: { re_test: { login: "re_test_admin", id: 1, scopes: [] } } });
  t.after(() => server.webhooks.resendDelivery.close());
  const request = async (path, method = "GET", body) => server.app.request(path, { method,
    headers: { authorization: "Bearer re_test", "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  return { ...server, received, timers, request, url: `http://127.0.0.1:${receiver.address().port}/events` };
}

test("Resend API registration delivers native signed events to an HTTP receiver", async t => {
  const f = await fixture(t);
  const registration = await (await f.request("/webhooks", "POST", { endpoint: f.url, events: ["email.sent"] })).json();
  assert.match(registration.id, /^[0-9a-f-]{36}$/);
  const sent = await (await f.request("/emails", "POST", { from: "Sender <sender@example.com>", to: "reader@example.com", subject: "Test", tags: [{ name: "source", value: "fixture" }] })).json();
  await f.webhooks.resendDelivery.drain();
  assert.equal(f.received.length, 1);
  const { raw, headers } = f.received[0];
  const event = JSON.parse(raw);
  assert.deepEqual(Object.keys(event).sort(), ["created_at", "data", "type"]);
  assert.equal(event.type, "email.sent");
  assert.equal(event.data.email_id, sent.id);
  assert.equal(event.data.from, "Sender <sender@example.com>");
  assert.deepEqual(event.data.to, ["reader@example.com"]);
  assert.deepEqual(event.data.tags, { source: "fixture" });
  assert.ok(Number.isFinite(Date.parse(event.data.created_at)));
  const email = await (await f.request(`/emails/${sent.id}`)).json();
  assert.equal(event.data.created_at, email.created_at);
  assert.equal(event.data.message_id, email.message_id);
  assert.match(event.data.message_id, /^<[^<>\s]+@worldfixture\.local>$/);
  assert.equal(headers["x-github-event"], undefined);
  const expected = createHmac("sha256", Buffer.from(registration.signing_secret.slice(6), "base64"))
    .update(`${headers["svix-id"]}.${headers["svix-timestamp"]}.${raw}`).digest("base64");
  assert.equal(headers["svix-signature"], `v1,${expected}`);
  await f.request(`/webhooks/${registration.id}`, "PATCH", { status: "disabled" });
  await f.request("/emails", "POST", { from: "a@example.com", to: "b@example.com", subject: "Disabled" });
  await f.webhooks.resendDelivery.drain();
  assert.equal(f.received.length, 1);
  assert.equal((await f.request(`/webhooks/${registration.id}`, "DELETE")).status, 200);
  assert.equal((await f.request(`/webhooks/${registration.id}`)).status, 404);
});

test("Resend failure retries preserve the event ID and body and stop after deletion", async t => {
  const f = await fixture(t, { retry: true });
  const hook = await (await f.request("/webhooks", "POST", { endpoint: f.url, events: ["email.sent"] })).json();
  await f.request("/emails", "POST", { from: "a@example.com", to: "b@example.com", subject: "Retry" });
  await f.webhooks.resendDelivery.drain();
  assert.equal(f.timers[0].delay, RESEND_RETRY_DELAYS[0]);
  f.timers.shift().fn();
  await f.webhooks.resendDelivery.drain();
  assert.equal(f.received.length, 2);
  assert.equal(f.received[0].raw, f.received[1].raw);
  assert.equal(f.received[0].headers["svix-id"], f.received[1].headers["svix-id"]);
  assert.equal(f.webhooks.resendDelivery.deliveries[0].status, "succeeded");
  await f.request(`/webhooks/${hook.id}`, "DELETE");
  await f.request("/emails", "POST", { from: "a@example.com", to: "b@example.com", subject: "Deleted" });
  await f.webhooks.resendDelivery.drain();
  assert.equal(f.received.length, 2);
});

test("Resend webhook creation rejects invalid events and anonymous requests", async t => {
  const f = await fixture(t);
  assert.equal((await f.request("/webhooks", "POST", { endpoint: f.url, events: ["not.real"] })).status, 422);
  assert.equal((await f.app.request("/webhooks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: f.url, events: ["email.sent"] }) })).status, 401);
});

test("Resend domain and contact events include complete resource data after deletion", async t => {
  const f = await fixture(t);
  await f.request("/webhooks", "POST", { endpoint: f.url, events: ["domain.created", "domain.updated", "domain.deleted", "contact.created", "contact.deleted"] });
  const domain = await (await f.request("/domains", "POST", { name: "example.com" })).json();
  assert.equal((await f.request(`/domains/${domain.id}/verify`, "POST")).status, 200);
  assert.equal((await f.request(`/domains/${domain.id}/verify`, "POST")).status, 200);
  await f.request(`/domains/${domain.id}`, "DELETE");
  const audience = await (await f.request("/audiences", "POST", { name: "Readers" })).json();
  const contact = await (await f.request(`/audiences/${audience.id}/contacts`, "POST", { email: "reader@example.com", first_name: "Ari", last_name: "Example", unsubscribed: true })).json();
  await f.request(`/audiences/${audience.id}/contacts/${contact.id}`, "DELETE");
  await f.webhooks.resendDelivery.drain();
  const events = f.received.map(item => JSON.parse(item.raw));
  assert.equal(events.length, 5);
  const created = events.find(event => event.type === "domain.created").data;
  assert.deepEqual(created, { id: domain.id, name: domain.name, status: domain.status, created_at: domain.created_at,
    region: domain.region, capabilities: { sending: "enabled", receiving: "disabled" }, records: domain.records });
  const updated = events.find(event => event.type === "domain.updated").data;
  assert.equal(updated.status, "verified");
  assert.ok(updated.records.every(record => record.status === "verified"));
  assert.deepEqual(events.find(event => event.type === "domain.deleted").data, updated);
  const contactData = events.find(event => event.type === "contact.created").data;
  assert.equal(contactData.id, contact.id);
  assert.equal(contactData.first_name, "Ari");
  assert.equal(contactData.last_name, "Example");
  assert.equal(contactData.unsubscribed, true);
  assert.deepEqual(contactData.segment_ids, [audience.id]);
  assert.ok(Number.isFinite(Date.parse(contactData.updated_at)));
  assert.deepEqual(events.find(event => event.type === "contact.deleted").data, contactData);
});

test("Resend retries cannot cross a store reset with the same webhook ID", async t => {
  const f = await fixture(t, { fail: true });
  const hook = await (await f.request("/webhooks", "POST", { endpoint: f.url, events: ["email.sent"] })).json();
  await f.request("/emails", "POST", { from: "a@example.com", to: "b@example.com", subject: "Old event" });
  await f.webhooks.resendDelivery.drain();
  f.store.reset();
  seedResendWebhooks(f.store, { webhooks: [{ id: hook.id, endpoint: f.url, events: ["email.sent"], signing_secret: hook.signing_secret }] });
  f.timers.shift().fn();
  await f.webhooks.resendDelivery.drain();
  assert.equal(f.received.length, 1);
  assert.equal(f.webhooks.resendDelivery.deliveries[0].status, "cancelled");
});

test("Resend scheduled writes emit one event per accepted email and preserve email identity", async t => {
  const f = await fixture(t);
  await f.request("/webhooks", "POST", { endpoint: f.url, events: ["email.scheduled", "email.sent", "email.delivered"] });
  const scheduled = { from: "Sender <sender@example.com>", to: ["one@example.com", "two@example.com"],
    subject: "Later", scheduled_at: "2030-01-01T10:00:00.000Z", headers: { "Message-ID": "<accepted@example.com>" },
    tags: [{ name: "delivery", value: "later" }] };
  const single = await (await f.request("/emails", "POST", scheduled)).json();
  const batch = await (await f.request("/emails/batch", "POST", [
    { ...scheduled, headers: {} },
    { from: "a@example.com", to: "b@example.com", subject: "Now" },
  ])).json();
  assert.equal((await f.request("/emails", "POST", { ...scheduled, subject: "" })).status, 422);
  assert.equal((await f.request("/emails/batch", "POST", [scheduled, { ...scheduled, from: "" }])).status, 422);
  await f.webhooks.resendDelivery.drain();
  const events = f.received.map(item => JSON.parse(item.raw));
  assert.equal(events.length, 4);
  assert.deepEqual(events.filter(event => event.type === "email.scheduled").map(event => event.data.email_id).sort(),
    [single.id, batch.data[0].id].sort());
  const first = events.find(event => event.data.email_id === single.id);
  assert.deepEqual(first.data, { email_id: single.id, created_at: first.data.created_at,
    message_id: "<accepted@example.com>", from: scheduled.from, to: scheduled.to, subject: scheduled.subject,
    tags: { delivery: "later" } });
  const list = await (await f.request("/emails")).json();
  for (const event of events) {
    const email = await (await f.request(`/emails/${event.data.email_id}`)).json();
    assert.equal(event.data.message_id, email.message_id);
    assert.equal(event.data.message_id, list.data.find(item => item.id === email.id).message_id);
    assert.equal(event.data.created_at, email.created_at);
    assert.ok(Number.isFinite(Date.parse(event.created_at)));
    assert.equal(event.data.subject, email.subject);
    assert.deepEqual(event.data.to, email.to);
  }
  const immediate = events.filter(event => event.data.email_id === batch.data[1].id);
  assert.deepEqual(immediate.map(event => event.type).sort(), ["email.delivered", "email.sent"]);
  assert.equal(immediate[0].data.message_id, immediate[1].data.message_id);
  assert.equal((await f.request(`/emails/${single.id}/cancel`, "POST")).status, 200);
  await f.webhooks.resendDelivery.drain();
  assert.equal(f.received.length, 4);
});

test("Resend webhook API returns server-owned IDs and secrets and native list entries", async t => {
  const f = await fixture(t);
  const hook = await (await f.request("/webhooks", "POST", { id: "injected", signing_secret: "injected",
    endpoint: f.url, events: ["email.sent", "suppression.added", "suppression.removed"] })).json();
  assert.match(hook.id, /^[0-9a-f-]{36}$/);
  assert.match(hook.signing_secret, /^whsec_/);
  const detail = await (await f.request(`/webhooks/${hook.id}`)).json();
  assert.deepEqual(Object.keys(detail).sort(), ["created_at", "endpoint", "events", "id", "object", "signing_secret", "status"]);
  assert.equal(detail.object, "webhook");
  for (const invalid of [[], "invalid", { events: [] }, { status: "active" }]) {
    assert.equal((await f.request(`/webhooks/${hook.id}`, "PATCH", invalid)).status, 422);
  }
  const list = await (await f.request("/webhooks")).json();
  const { object, signing_secret, ...entry } = detail;
  assert.deepEqual(list, { object: "list", has_more: false, data: [entry] });
  await f.request("/emails", "POST", { from: "a@example.com", to: "b@example.com", subject: "Current filter" });
  await f.webhooks.resendDelivery.drain();
  assert.equal(f.received.length, 1);
  assert.equal((await f.request(`/webhooks/${hook.id}`, "PATCH", { events: ["email.delivered"] })).status, 200);
  await f.request("/emails", "POST", { from: "a@example.com", to: "b@example.com", subject: "New filter" });
  await f.webhooks.resendDelivery.drain();
  assert.deepEqual(f.received.map(item => JSON.parse(item.raw).type), ["email.sent", "email.delivered"]);
});

test("Resend exhausts the published retry schedule and cancels a retry after disable", async t => {
  const f = await fixture(t, { fail: true });
  const hook = await (await f.request("/webhooks", "POST", { endpoint: f.url, events: ["email.sent"] })).json();
  await f.request("/emails", "POST", { from: "a@example.com", to: "b@example.com", subject: "Exhaust retries" });
  await f.webhooks.resendDelivery.drain();
  for (const delay of [5000, 300_000, 1_800_000, 7_200_000, 18_000_000, 36_000_000, 36_000_000]) {
    assert.equal(f.timers.length, 1);
    const timer = f.timers.shift();
    assert.equal(timer.delay, delay);
    timer.fn();
    await f.webhooks.resendDelivery.drain();
  }
  assert.equal(f.received.length, 8);
  assert.equal(f.timers.length, 0);
  assert.equal(f.webhooks.resendDelivery.deliveries[0].status, "failed");
  assert.ok(f.received.every(item => item.raw === f.received[0].raw && item.headers["svix-id"] === f.received[0].headers["svix-id"]));
  await f.request("/emails", "POST", { from: "a@example.com", to: "b@example.com", subject: "Disable retry" });
  await f.webhooks.resendDelivery.drain();
  await f.request(`/webhooks/${hook.id}`, "PATCH", { status: "disabled" });
  f.timers.shift().fn();
  await f.webhooks.resendDelivery.drain();
  assert.equal(f.received.length, 9);
  assert.equal(f.webhooks.resendDelivery.deliveries[1].status, "cancelled");
});
