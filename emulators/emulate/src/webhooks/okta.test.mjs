import assert from "node:assert/strict";
import { createServer as httpServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { createServer } from "@emulators/core";
import { oktaPlugin, seedFromConfig, getOktaStore } from "@emulators/okta";
import { extendOktaWebhooksPlugin, seedOktaWebhooks } from "./okta.mjs";

async function setup(t, respond = () => 204, options = {}) {
  const received = [], challenges = [];
  const receiver = httpServer(async (req, res) => {
    if (req.method === "GET") {
      challenges.push(req.headers);
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ verification: req.url === "/bad" ? "wrong" : req.headers["x-okta-verification-challenge"] }));
    }
    let raw = "";
    for await (const part of req) raw += part;
    const item = { raw, headers: req.headers, path: req.url };
    received.push(item);
    res.writeHead(respond(item, received)).end();
  });
  receiver.listen(0, "127.0.0.1");
  await once(receiver, "listening");
  t.after(() => receiver.close());
  const server = createServer(extendOktaWebhooksPlugin(oktaPlugin, options), { tokens: { token: { login: "admin@example.com", id: 1, scopes: [] } } });
  t.after(() => server.webhooks.oktaDelivery.close());
  seedFromConfig(server.store, "http://okta.test", { users: [{ login: "admin@example.com", okta_id: "00uAdminFixture", first_name: "Admin", last_name: "Fixture" }], apps: [{ name: "test-app" }] });
  const request = (path, method = "GET", body, authorization = "SSWS token") => server.app.request(path, { method,
    headers: { authorization, "content-type": "application/json", "user-agent": "okta-hook-test" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const url = `http://127.0.0.1:${receiver.address().port}`;
  const hookBody = (items, path = "/okta") => ({ name: "Local receiver", events: { type: "EVENT_TYPE", items },
    channel: { type: "HTTP", version: "1.0.0", config: { uri: `${url}${path}`, authScheme: { type: "HEADER", key: "Authorization", value: "Basic Zml4dHVyZTpzZWNyZXQ=" }, headers: [{ key: "X-Receiver", value: "stream" }] } } });
  const createHook = async (items, path) => {
    const response = await request("/api/v1/eventHooks", "POST", hookBody(items, path));
    assert.equal(response.status, 200);
    return response.json();
  };
  const verify = id => request(`/api/v1/eventHooks/${id}/lifecycle/verify`, "POST");
  const createUser = login => request("/api/v1/users?activate=false", "POST", { profile: { login, email: login, firstName: "Test", lastName: "Person" } });
  return { server, request, received, challenges, hookBody, createHook, verify, createUser };
}

test("Okta native registration verifies the receiver and delivers accepted user and group changes", async t => {
  const f = await setup(t);
  const types = ["user.lifecycle.create", "user.account.update_profile", "user.lifecycle.activate", "user.lifecycle.suspend", "user.lifecycle.unsuspend", "user.lifecycle.deactivate", "user.lifecycle.delete.initiated", "group.lifecycle.create", "group.profile.update", "group.lifecycle.delete", "group.user_membership.add", "group.user_membership.remove", "application.user_membership.add", "application.user_membership.remove"];
  const hook = await f.createHook(types);
  assert.match(hook.id, /^who[\da-f]{17}$/);
  assert.equal(hook.createdBy, "00uAdminFixture");
  assert.equal(hook.status, "ACTIVE");
  assert.equal(hook.verificationStatus, "UNVERIFIED");
  assert.equal(hook.channel.config.authScheme.value, undefined);
  await f.createUser("unverified@example.com");
  await f.server.webhooks.oktaDelivery.drain();
  assert.equal(f.received.length, 0);
  assert.equal((await f.verify(hook.id)).status, 200);
  assert.equal((await f.verify(hook.id)).status, 200);
  assert.equal(f.challenges.length, 1);
  assert.equal(f.challenges[0].authorization, "Basic Zml4dHVyZTpzZWNyZXQ=");
  const user = await (await f.createUser("new@example.com")).json();
  await f.request(`/api/v1/users/${user.id}`, "POST", { profile: { firstName: "Updated" } });
  for (const action of ["activate", "suspend", "unsuspend"]) await f.request(`/api/v1/users/${user.id}/lifecycle/${action}`, "POST");
  const group = await (await f.request("/api/v1/groups", "POST", { profile: { name: "Event consumers" } })).json();
  await f.request(`/api/v1/groups/${group.id}`, "PUT", { profile: { name: "Stream consumers" } });
  await f.request(`/api/v1/groups/${group.id}/users/${user.id}`, "PUT");
  await f.request(`/api/v1/groups/${group.id}/users/${user.id}`, "PUT");
  await f.request(`/api/v1/groups/${group.id}/users/${user.id}`, "DELETE");
  await f.request(`/api/v1/groups/${group.id}`, "DELETE");
  const application = getOktaStore(f.server.store).apps.all()[0];
  await f.request(`/api/v1/apps/${application.okta_id}/users/${user.id}`, "PUT");
  await f.request(`/api/v1/apps/${application.okta_id}/users/${user.id}`, "DELETE");
  await f.request(`/api/v1/users/${user.id}`, "DELETE");
  await f.request(`/api/v1/users/${user.id}`, "DELETE");
  await f.server.webhooks.oktaDelivery.drain();
  const envelopes = f.received.map(row => JSON.parse(row.raw));
  assert.deepEqual(envelopes.map(row => row.data.events[0].eventType).sort(), types.sort());
  for (const [index, envelope] of envelopes.entries()) {
    assert.deepEqual(Object.keys(envelope).sort(), ["cloudEventsVersion", "contentType", "data", "eventId", "eventTime", "eventType", "eventTypeVersion", "source"]);
    assert.equal(envelope.eventType, "com.okta.event_hook");
    assert.equal(envelope.cloudEventsVersion, "0.1");
    assert.equal(envelope.eventTypeVersion, "1.0");
    assert.equal(envelope.contentType, "application/json");
    assert.ok(Number.isFinite(Date.parse(envelope.eventTime)));
    assert.ok(envelope.source.endsWith(`/api/v1/eventHooks/${hook.id}`));
    assert.match(envelope.eventId, /^[\da-f-]{36}$/);
    const event = envelope.data.events[0];
    assert.equal(event.actor.id, "00uAdminFixture");
    assert.equal(event.outcome.result, "SUCCESS");
    assert.equal(event.client.userAgent.rawUserAgent, "okta-hook-test");
    assert.ok(Number.isFinite(Date.parse(event.published)));
    assert.equal(f.received[index].headers.authorization, "Basic Zml4dHVyZTpzZWNyZXQ=");
    assert.equal(f.received[index].headers["x-receiver"], "stream");
    assert.equal(f.received[index].headers.accept, "application/json");
    assert.equal(f.received[index].headers["x-okta-signature"], undefined);
    assert.equal(f.received[index].headers["x-okta-verification-challenge"], undefined);
    assert.ok(event.target.every(row => [user.id, group.id, application.okta_id].includes(row.id)));
  }
  assert.equal(new Set(envelopes.map(row => row.eventId)).size, types.length);
  assert.equal(envelopes.find(row => row.data.events[0].eventType === "group.user_membership.add").data.events[0].target[1].displayName, "Stream consumers");
});

test("Okta verifies seeded hooks, filters event types, rejects failures, and enforces hook lifecycle", async t => {
  const f = await setup(t);
  seedOktaWebhooks(f.server.store, { event_hooks: [f.hookBody(["user.lifecycle.create"])] });
  const hook = (await (await f.request("/api/v1/eventHooks")).json())[0];
  assert.equal((await f.request("/api/v1/eventHooks", "GET", null, "SSWS invalid")).status, 401);
  assert.equal((await f.request(`/api/v1/eventHooks/${hook.id}`)).status, 200);
  assert.equal((await f.request(`/api/v1/eventHooks/${hook.id}`, "DELETE")).status, 400);
  assert.equal((await f.verify(hook.id)).status, 200);
  await f.request("/api/v1/groups", "POST", { profile: { name: "Filtered" } });
  await f.request("/api/v1/users", "POST", {});
  await f.createUser("filtered@example.com");
  await f.server.webhooks.oktaDelivery.drain();
  assert.equal(f.received.length, 1);
  await f.request(`/api/v1/eventHooks/${hook.id}/lifecycle/deactivate`, "POST");
  await f.createUser("disabled@example.com");
  await f.server.webhooks.oktaDelivery.drain();
  assert.equal(f.received.length, 1);
  await f.request(`/api/v1/eventHooks/${hook.id}/lifecycle/activate`, "POST");
  await f.createUser("enabled@example.com");
  await f.server.webhooks.oktaDelivery.drain();
  assert.equal(f.received.length, 2);
  const replaced = await (await f.request(`/api/v1/eventHooks/${hook.id}`, "PUT", f.hookBody(["user.lifecycle.create"], "/bad"))).json();
  assert.equal(replaced.verificationStatus, "UNVERIFIED");
  assert.equal((await f.verify(hook.id)).status, 400);
  const filtered = f.hookBody(["user.lifecycle.create"]);
  filtered.events.filter = { type: "EXPRESSION", expression: "true" };
  assert.equal((await f.request("/api/v1/eventHooks", "POST", filtered)).status, 400);
  await f.request(`/api/v1/eventHooks/${hook.id}/lifecycle/deactivate`, "POST");
  assert.equal((await f.request(`/api/v1/eventHooks/${hook.id}`, "DELETE")).status, 204);
  assert.equal((await f.request(`/api/v1/eventHooks/${hook.id}`)).status, 404);
});

test("Okta retries a 5xx once with the same event and does not retry a 4xx", async t => {
  const timers = [];
  const f = await setup(t, item => item.path === "/server-error" ? 503 : 400, { setTimer: callback => { timers.push(callback); return callback; }, clearTimer: () => {} });
  for (const path of ["/server-error", "/client-error"]) {
    const hook = await f.createHook(["user.lifecycle.create"], path);
    await f.verify(hook.id);
  }
  await f.createUser("retry@example.com");
  await f.server.webhooks.oktaDelivery.drain();
  assert.equal(timers.length, 1);
  timers.shift()();
  await f.server.webhooks.oktaDelivery.drain();
  assert.equal(timers.length, 0);
  const retries = f.received.filter(row => row.path === "/server-error");
  assert.equal(retries.length, 2);
  assert.equal(retries[0].raw, retries[1].raw);
  assert.equal(f.received.filter(row => row.path === "/client-error").length, 1);
  assert.deepEqual(f.server.webhooks.oktaDelivery.deliveries.map(row => row.attempts).sort(), [1, 2]);
});


test("Okta cancels a scheduled retry after the hook is deactivated", async t => {
  const timers = [];
  const f = await setup(t, () => 503, { setTimer: callback => { timers.push(callback); return callback; }, clearTimer: () => {} });
  const hook = await f.createHook(["user.lifecycle.create"]);
  await f.verify(hook.id);
  await f.createUser("cancel-retry@example.com");
  await f.server.webhooks.oktaDelivery.drain();
  assert.equal(timers.length, 1);
  await f.request(`/api/v1/eventHooks/${hook.id}/lifecycle/deactivate`, "POST");
  timers.shift()();
  await f.server.webhooks.oktaDelivery.drain();
  assert.equal(f.received.length, 1);
  assert.equal(f.server.webhooks.oktaDelivery.deliveries[0].status, "cancelled");
});

test("Okta does not send an old event after reseeding reuses a verified hook ID", async t => {
  const timers = [];
  const f = await setup(t, () => 503, { setTimer: callback => { timers.push(callback); return callback; }, clearTimer: () => {} });
  const hook = await f.createHook(["user.lifecycle.create"]);
  await f.verify(hook.id);
  await f.createUser("old@example.com");
  await f.server.webhooks.oktaDelivery.drain();
  seedOktaWebhooks(f.server.store, { event_hooks: [{ ...f.hookBody(["user.lifecycle.create"]), id: hook.id }] });
  await f.verify(hook.id);
  timers.shift()();
  await f.server.webhooks.oktaDelivery.drain();
  assert.equal(f.received.length, 1);
  assert.equal(f.server.webhooks.oktaDelivery.deliveries[0].status, "cancelled");
});

test("Okta cannot verify a replacement URL with the previous URL's pending challenge", async t => {
  let release;
  const f = await setup(t, () => 204, { fetchImpl: async (_url, init) => new Promise(resolve => {
    release = () => resolve(new Response(JSON.stringify({ verification: init.headers["x-okta-verification-challenge"] }), { status: 200, headers: { "content-type": "application/json" } }));
  }) });
  const hook = await f.createHook(["user.lifecycle.create"]);
  const verification = f.verify(hook.id);
  for (let i = 0; !release && i < 100; i++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(release);
  assert.equal((await f.request(`/api/v1/eventHooks/${hook.id}`, "PUT", f.hookBody(["user.lifecycle.create"], "/replacement"))).status, 200);
  release();
  assert.equal((await verification).status, 400);
  assert.equal((await (await f.request(`/api/v1/eventHooks/${hook.id}`)).json()).verificationStatus, "UNVERIFIED");
});
