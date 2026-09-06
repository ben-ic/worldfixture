import assert from "node:assert/strict";
import { createServer as httpServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { createServer } from "@emulators/core";
import { googlePlugin, seedFromConfig } from "@emulators/google";
import { wrapGoogleWebhooks } from "./google.mjs";

async function fixture(t, options = {}) {
  const received = [];
  const receiver = httpServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    received.push({ raw, headers: req.headers, method: req.method });
    res.writeHead(options.status?.(received) ?? 204).end();
  });
  receiver.listen(0, "127.0.0.1");
  await once(receiver, "listening");
  t.after(() => new Promise(resolve => { receiver.close(resolve); receiver.closeAllConnections(); }));
  const timers = [];
  const wrapped = wrapGoogleWebhooks(googlePlugin, seedFromConfig, {
    setTimer: (fn, delay) => { const timer = { fn, delay, unref() {} }; timers.push(timer); return timer; },
    clearTimer() {},
  });
  const server = createServer(wrapped.plugin, { tokens: {
    owner: { login: "owner@example.test", id: 1 }, other: { login: "other@example.test", id: 2 },
  } });
  wrapped.seedFromConfig(server.store, server.baseUrl, {
    webhooks: { live_delivery: true, allow_insecure_http: true, ...options.config },
    users: [{ email: "owner@example.test" }, { email: "other@example.test" }],
    calendars: [{ id: "cal-owner", user_email: "owner@example.test", summary: "Owner", primary: true },
      { id: "cal-other", user_email: "other@example.test", summary: "Other", primary: true }],
    drive_items: [{ id: "file-owner", user_email: "owner@example.test", name: "Owner file", mime_type: "text/plain" }],
  });
  t.after(() => server.webhooks.googleDelivery.close());
  const request = (path, method = "GET", body, token = "owner") => server.app.request(path, {
    method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const body = id => ({ id, type: "web_hook", address: `http://127.0.0.1:${receiver.address().port}/events`, token: "test-token" });
  return { ...server, request, body, received, timers, delivery: server.webhooks.googleDelivery };
}

test("Google Calendar watch sends empty sync and exists POSTs for matching owner and calendar", async t => {
  const f = await fixture(t);
  const response = await f.request("/calendar/v3/calendars/primary/events/watch", "POST", f.body("calendar-channel"));
  assert.equal(response.status, 200);
  const channel = await response.json();
  assert.deepEqual(Object.keys(channel).sort(), ["kind", "id", "resourceId", "resourceUri", "token", "expiration"].sort());
  assert.equal(channel.kind, "api#channel");
  assert.equal(channel.resourceUri, "https://www.googleapis.com/calendar/v3/calendars/cal-owner/events");
  await f.delivery.drain();
  assert.equal(f.received.length, 1);
  const input = { summary: "Planning", start: { date: "2026-09-06" }, end: { date: "2026-09-07" } };
  const created = await f.request("/calendar/v3/calendars/primary/events", "POST", input);
  assert.equal(created.status, 200);
  const event = await created.json();
  await f.delivery.drain();
  assert.equal(f.received.length, 2);
  for (const [index, request] of f.received.entries()) {
    assert.equal(request.raw, "");
    assert.equal(request.method, "POST");
    assert.equal(request.headers["content-length"], "0");
    assert.equal(request.headers["user-agent"], "APIs-Google");
    assert.equal(request.headers["x-goog-channel-id"], channel.id);
    assert.equal(request.headers["x-goog-channel-token"], channel.token);
    assert.equal(request.headers["x-goog-resource-id"], channel.resourceId);
    assert.equal(request.headers["x-goog-resource-uri"], channel.resourceUri);
    assert.equal(request.headers["x-goog-channel-expiration"], new Date(Number(channel.expiration)).toUTCString());
    assert.equal(request.headers["x-goog-resource-state"], index ? "exists" : "sync");
    assert.equal(request.headers["x-goog-message-number"], index ? "3" : "1");
    assert.equal(request.headers["x-goog-changed"], undefined);
    assert.equal(request.headers.authorization, undefined);
  }
  await f.request("/calendar/v3/calendars/primary/events", "POST", input, "other");
  await f.delivery.drain();
  assert.equal(f.received.length, 2);
  await f.request(`/calendar/v3/calendars/primary/events/${event.id}`, "DELETE");
  await f.delivery.drain();
  assert.equal(f.received[2].headers["x-goog-resource-state"], "exists", "An event deletion changes the watched collection.");
  assert.equal((await f.request("/calendar/v3/channels/stop", "POST", channel, "other")).status, 404);
  assert.equal((await f.request("/calendar/v3/channels/stop", "POST", channel)).status, 204);
  await f.request("/calendar/v3/calendars/primary/events", "POST", input);
  await f.delivery.drain();
  assert.equal(f.received.length, 3);
});

test("concurrent Google writes produce one change per file and preserve owner isolation", async t => {
  const f = await fixture(t);
  const token = await (await f.request("/drive/v3/changes/startPageToken")).json();
  await f.request(`/drive/v3/changes/watch?pageToken=${token.startPageToken}`, "POST", f.body("owner-changes"));
  const writes = await Promise.all(Array.from({ length: 8 }, (_, index) => f.request("/drive/v3/files", "POST", { name: `file-${index}`, mimeType: "text/plain" }, index % 2 ? "other" : "owner")));
  for (const response of writes) assert.equal(response.status, 200);
  await f.delivery.drain();
  const changes = await (await f.request(`/drive/v3/changes?pageToken=${token.startPageToken}`)).json();
  assert.equal(changes.changes.length, 4);
  assert.equal(new Set(changes.changes.map(change => change.fileId)).size, 4);
  assert.equal(f.received.length, 5);
});

test("Google Drive files and changes watch send native headers and a consumer can read the change feed", async t => {
  const f = await fixture(t);
  const token = await (await f.request("/drive/v3/changes/startPageToken")).json();
  const fileResponse = await f.request("/drive/v3/files/file-owner/watch", "POST", { ...f.body("file-channel"), expiration: Date.now() + 7 * 86400000 });
  assert.equal(fileResponse.status, 200);
  const fileChannel = await fileResponse.json();
  assert.ok(Number(fileChannel.expiration) <= Date.now() + 86400000);
  const changeResponse = await f.request(`/drive/v3/changes/watch?pageToken=${token.startPageToken}`, "POST", f.body("change-channel"));
  assert.equal(changeResponse.status, 200);
  const changeChannel = await changeResponse.json();
  await f.delivery.drain();
  assert.equal(f.received.length, 2);
  assert.equal((await f.request("/drive/v3/files/file-owner", "PATCH", { name: "Renamed" })).status, 200);
  await f.delivery.drain();
  const updates = f.received.slice(2);
  assert.equal(updates.length, 2);
  const fileUpdate = updates.find(item => item.headers["x-goog-channel-id"] === fileChannel.id);
  assert.equal(fileUpdate.headers["x-goog-resource-state"], "update");
  assert.equal(fileUpdate.headers["x-goog-changed"], "properties");
  const changeUpdate = updates.find(item => item.headers["x-goog-channel-id"] === changeChannel.id);
  assert.equal(changeUpdate.headers["x-goog-resource-state"], "change");
  assert.equal(changeUpdate.headers["x-goog-changed"], undefined);
  for (const notification of f.received) assert.equal(notification.raw, "");
  const feed = await (await f.request(`/drive/v3/changes?pageToken=${token.startPageToken}`)).json();
  assert.equal(feed.kind, "drive#changeList");
  assert.equal(feed.changes.length, 1);
  assert.equal(feed.changes[0].changeType, "file");
  assert.equal(feed.changes[0].fileId, "file-owner");
  assert.equal(feed.changes[0].file.name, "Renamed");
  assert.equal(feed.changes[0].removed, false);
  assert.deepEqual((await (await f.request(`/drive/v3/changes?pageToken=${token.startPageToken}`, "GET", undefined, "other")).json()).changes, []);
  await f.request("/drive/v3/files/file-owner?addParents=folder-1", "PATCH", {});
  await f.delivery.drain();
  assert.equal(f.received.findLast(item => item.headers["x-goog-channel-id"] === fileChannel.id).headers["x-goog-changed"], "parents");
  await f.request("/drive/v3/files/file-owner?addParents=folder-2", "PATCH", { name: "Moved and renamed" });
  await f.delivery.drain();
  assert.deepEqual(new Set(f.received.findLast(item => item.headers["x-goog-channel-id"] === fileChannel.id).headers["x-goog-changed"].split(",")), new Set(["parents", "properties"]));
  await f.request("/drive/v3/channels/stop", "POST", fileChannel);
  await f.request("/drive/v3/channels/stop", "POST", changeChannel);
  await f.request("/drive/v3/files/file-owner", "PATCH", { name: "Stopped" });
  await f.delivery.drain();
  assert.equal(f.received.length, 8);
});

test("Google channels reject bad requests, restrict resources, and capture only when delivery is disabled", async t => {
  const f = await fixture(t, { config: { live_delivery: false, allow_insecure_http: false } });
  assert.equal((await f.request("/calendar/v3/calendars/primary/events/watch", "POST", f.body("http"))).status, 400);
  const body = { ...f.body("valid"), address: "https://hooks.worldfixture.test/google" };
  assert.equal((await f.request("/calendar/v3/calendars/cal-other/events/watch", "POST", body)).status, 404);
  assert.equal((await f.request("/drive/v3/files/file-owner/watch", "POST", body, "other")).status, 404);
  assert.equal((await f.request("/calendar/v3/calendars/primary/events/watch", "POST", body, "invalid")).status, 401);
  assert.equal((await f.request("/drive/v3/changes/watch", "POST", body)).status, 400);
  assert.equal((await f.request("/calendar/v3/calendars/primary/events/watch", "POST", { ...body, expiration: Date.now() - 1 })).status, 400);
  assert.equal((await f.request("/calendar/v3/calendars/primary/events/watch", "POST", { ...body, id: "x".repeat(65) })).status, 400);
  assert.equal((await f.request("/calendar/v3/calendars/primary/events/watch", "POST", { ...body, token: "x".repeat(257) })).status, 400);
  assert.equal((await f.request("/calendar/v3/calendars/primary/events/watch?eventTypes=invalid", "POST", body)).status, 400);
  assert.equal((await f.request("/calendar/v3/calendars/primary/events/watch", "POST", body)).status, 200);
  assert.equal((await f.request("/calendar/v3/calendars/primary/events/watch", "POST", body)).status, 400);
  await f.delivery.drain();
  assert.equal(f.received.length, 0);
  assert.equal(f.delivery.deliveries[0].status, "captured");
});

test("Google retries only temporary server failures and keeps identical empty request headers", async t => {
  const f = await fixture(t, { status: received => received.length === 1 ? 503 : 204 });
  const response = await f.request("/calendar/v3/calendars/primary/events/watch", "POST", f.body("retry"));
  const channel = await response.json();
  await f.delivery.drain();
  assert.equal(f.timers.length, 1);
  assert.equal(f.timers[0].delay, 1000);
  f.timers.shift().fn();
  await f.delivery.drain();
  assert.equal(f.received.length, 2);
  assert.equal(f.received[0].headers["x-goog-message-number"], f.received[1].headers["x-goog-message-number"]);
  assert.equal(f.delivery.deliveries[0].status, "succeeded");
  await f.request("/calendar/v3/channels/stop", "POST", channel);
  const failure = await fixture(t, { status: () => 400 });
  await failure.request("/calendar/v3/calendars/primary/events/watch", "POST", failure.body("no-retry"));
  await failure.delivery.drain();
  assert.equal(failure.timers.length, 0);
  assert.equal(failure.delivery.deliveries[0].status, "failed");
});

test("Google stops scheduled retries after channel expiration or channels.stop", async t => {
  const f = await fixture(t, { status: () => 503 });
  const response = await f.request("/drive/v3/files/file-owner/watch", "POST", f.body("cancel-retry"));
  const channel = await response.json();
  await f.delivery.drain();
  await f.request("/drive/v3/channels/stop", "POST", channel);
  f.timers.shift().fn();
  await f.delivery.drain();
  assert.equal(f.received.length, 1);
  assert.equal(f.delivery.deliveries[0].status, "cancelled");
  await f.request("/drive/v3/files/file-owner/watch", "POST", f.body("expire-retry"));
  await f.delivery.drain();
  const records = f.store.collection("worldfixture.google.channels", ["channel_id", "owner"]);
  const record = records.findOneBy("channel_id", "expire-retry");
  records.update(record.id, { expiration: Date.now() - 1 });
  f.timers.shift().fn();
  await f.delivery.drain();
  assert.equal(f.received.length, 2);
  assert.equal(f.delivery.deliveries[1].status, "cancelled");
});
