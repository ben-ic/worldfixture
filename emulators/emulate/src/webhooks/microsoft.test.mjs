import assert from "node:assert/strict";
import { createServer as httpServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { createServer } from "@emulators/core";
import { microsoftPlugin, seedFromConfig } from "@emulators/microsoft";
import { extendMicrosoftUsers } from "../overrides/identity-lists.mjs";
import { wrapMicrosoftWebhooks } from "./microsoft.mjs";

async function fixture(t, options = {}) {
  const received = [], validations = [], timers = [];
  let time = Date.now();
  const receiver = httpServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    const url = new URL(req.url, "http://localhost");
    const record = { raw, headers: req.headers, method: req.method, url };
    if (url.searchParams.has("validationToken")) {
      validations.push(record);
      res.writeHead(options.validationStatus ?? 200, { "content-type": options.validationContentType ?? "text/plain" });
      res.end(options.validationBody ? options.validationBody(url) : options.invalidValidation ? "wrong" : url.searchParams.get("validationToken"));
    } else { received.push(record); res.writeHead(options.status?.(received) ?? 202).end(); }
  });
  receiver.listen(0, "127.0.0.1");
  await once(receiver, "listening");
  t.after(() => new Promise(resolve => { receiver.close(resolve); receiver.closeAllConnections(); }));
  const wrapped = wrapMicrosoftWebhooks(extendMicrosoftUsers(microsoftPlugin), seedFromConfig, { now: () => time,
    setTimer: (fn, delay) => { const timer = { fn, delay, unref() {} }; timers.push(timer); return timer; }, clearTimer() {} });
  const server = createServer(wrapped.plugin, { tokens: {
    owner: { login: "owner@example.test", id: 1, scopes: ["User.ReadWrite.All"], client_id: "client-a" },
    other: { login: "other@example.test", id: 2, scopes: ["User.ReadWrite.All"], client_id: "client-a" },
    application: { login: "owner@example.test", id: 1, scopes: ["User.ReadWrite.All"], client_id: "client-b" },
    foreign: { login: "foreign@example.test", id: 3, scopes: ["User.ReadWrite.All"], client_id: "client-a" },
    limited: { login: "owner@example.test", id: 1, scopes: ["User.ReadBasic.All"] },
    reader: { login: "owner@example.test", id: 1, scopes: ["User.Read.All"] },
  } });
  for (const [token, actor] of server.tokenMap) actor.client_id = token === "application" ? "client-b" : "client-a";
  wrapped.seedFromConfig(server.store, server.baseUrl, { users: [
    { email: "owner@example.test", tenant_id: "tenant-a" }, { email: "other@example.test", tenant_id: "tenant-a" },
    { email: "foreign@example.test", tenant_id: "tenant-b" },
  ], oauth_clients: [
    { client_id: "oauth-app", client_secret: "oauth-secret", name: "OAuth application", tenant_id: "tenant-a", redirect_uris: ["http://localhost/callback"] },
    { client_id: "foreign@example.test", client_secret: "collision-secret", name: "Application with a user-like ID", tenant_id: "tenant-a", redirect_uris: [] },
  ], webhooks: { live_delivery: true, allow_insecure_http: true, ...options.config } });
  t.after(() => server.webhooks.microsoftDelivery.close());
  const request = (path, method = "GET", body, token = "owner") => server.app.request(path, {
    method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const subscription = (extra = {}) => ({ resource: "users", changeType: "updated,deleted", clientState: "receiver-secret",
    notificationUrl: `http://127.0.0.1:${receiver.address().port}/events?keep=yes`, expirationDateTime: new Date(time + 3600_000).toISOString(), ...extra });
  const user = { accountEnabled: true, displayName: "Ari", mailNickname: "ari", userPrincipalName: "ari@example.test", passwordProfile: { password: "not-for-notifications" } };
  return { ...server, request, subscription, user, received, validations, timers, delivery: server.webhooks.microsoftDelivery,
    advance: duration => { time += duration; } };
}

test("Microsoft validates callback and sends native user notifications after committed REST writes", async t => {
  const f = await fixture(t);
  const response = await f.request("/v1.0/subscriptions", "POST", f.subscription());
  assert.equal(response.status, 201);
  const sub = await response.json();
  assert.equal(sub.resource, "users");
  assert.equal(sub.applicationId, "client-a");
  assert.equal(sub.notificationContentType, "application/json");
  assert.equal(f.validations.length, 1);
  assert.equal(f.validations[0].method, "POST");
  assert.equal(f.validations[0].url.searchParams.get("keep"), "yes");
  assert.equal(f.validations[0].headers["content-type"], "text/plain; charset=utf-8");
  assert.equal(f.validations[0].raw, "");
  assert.deepEqual((await (await f.request("/v1.0/subscriptions")).json()).value, [{ ...sub, clientState: null }]);
  assert.deepEqual(await (await f.request(`/v1.0/subscriptions/${sub.id}`)).json(), sub);
  const created = await f.request("/v1.0/users", "POST", f.user);
  assert.equal(created.status, 201);
  const user = await created.json();
  const path = `/v1.0/users/${user.id}`;
  await f.delivery.drain();
  assert.equal((await (await f.request(path)).json()).displayName, "Ari");
  assert.equal((await f.request(path, "PATCH", { displayName: "Aria" })).status, 204);
  await f.delivery.drain();
  assert.equal((await (await f.request(path)).json()).displayName, "Aria");
  assert.equal((await (await f.request("/v1.0/users")).json()).value.find(row => row.id === user.id).displayName, "Aria");
  assert.equal((await f.request(path, "PATCH", { displayName: "Aria" })).status, 204);
  assert.equal((await f.request(path, "PATCH", { unknown: true })).status, 400);
  assert.equal((await f.request(path, "DELETE")).status, 204);
  assert.equal((await f.request(path)).status, 404);
  await f.delivery.drain();
  assert.equal((await f.request(`/v1.0/directory/deletedItems/${user.id}`, "DELETE")).status, 204);
  await f.delivery.drain();
  assert.deepEqual(f.received.map(item => JSON.parse(item.raw).value[0].changeType), ["updated", "updated", "updated", "deleted"]);
  for (const input of f.received) {
    assert.equal(input.method, "POST");
    assert.equal(input.headers["content-type"], "application/json");
    assert.equal(input.headers.authorization, undefined);
    assert.equal(input.headers["x-worldfixture-event"], undefined);
    assert.equal(input.url.searchParams.get("keep"), "yes");
    const body = JSON.parse(input.raw);
    assert.deepEqual(Object.keys(body), ["value"]);
    const event = body.value[0];
    assert.equal(event.subscriptionId, sub.id);
    assert.equal(event.subscriptionExpirationDateTime, sub.expirationDateTime);
    assert.equal(event.clientState, "receiver-secret");
    assert.equal(event.tenantId, "tenant-a");
    assert.equal(event.resource, `users/${user.id}`);
    assert.deepEqual(event.resourceData, { "@odata.type": "#microsoft.graph.user", "@odata.id": `users/${user.id}`, id: user.id });
    assert.equal(input.raw.includes("not-for-notifications"), false);
    assert.equal(event.data, undefined);
  }
});

test("Microsoft subscriptions enforce auth, ownership, tenant, change types, expiry and deletion", async t => {
  const f = await fixture(t);
  for (const token of ["missing", "limited"]) assert.equal((await f.request("/v1.0/subscriptions", "POST", f.subscription(), token)).status, token === "missing" ? 401 : 403);
  assert.equal((await f.request("/v1.0/users", "POST", f.user, "reader")).status, 403);
  const sub = await (await f.request("/v1.0/subscriptions", "POST", f.subscription({ changeType: "deleted" }))).json();
  for (const token of ["other", "application", "foreign"]) {
    assert.deepEqual((await (await f.request("/v1.0/subscriptions", "GET", undefined, token)).json()).value, []);
    for (const method of ["GET", "PATCH", "DELETE"]) assert.equal((await f.request(`/v1.0/subscriptions/${sub.id}`, method, method === "PATCH" ? { expirationDateTime: sub.expirationDateTime } : undefined, token)).status, 404);
  }
  const user = await (await f.request("/v1.0/users", "POST", f.user)).json();
  assert.equal((await f.request(`/v1.0/users/${user.id}`, "PATCH", { displayName: "Foreign" }, "foreign")).status, 404);
  await f.request(`/v1.0/users/${user.id}`, "DELETE");
  await f.delivery.drain();
  assert.equal(f.received.length, 0);
  await f.request(`/v1.0/directory/deletedItems/${user.id}`, "DELETE");
  await f.delivery.drain();
  assert.equal(f.received.length, 1);
  const foreign = await (await f.request("/v1.0/users", "POST", { ...f.user, userPrincipalName: "foreign-new@example.test" }, "foreign")).json();
  await f.request(`/v1.0/users/${foreign.id}`, "DELETE", undefined, "foreign");
  await f.request(`/v1.0/directory/deletedItems/${foreign.id}`, "DELETE", undefined, "foreign");
  await f.delivery.drain();
  assert.equal(f.received.length, 1);
  const renewal = await f.request(`/v1.0/subscriptions/${sub.id}`, "PATCH", { expirationDateTime: new Date(Date.now() + 7200_000).toISOString() });
  assert.equal(renewal.status, 200);
  assert.ok(Date.parse((await renewal.json()).expirationDateTime) > Date.parse(sub.expirationDateTime));
  assert.equal((await f.request(`/v1.0/subscriptions/${sub.id}`, "DELETE")).status, 204);
  const stopped = await (await f.request("/v1.0/users", "POST", { ...f.user, userPrincipalName: "stopped@example.test" })).json();
  await f.request(`/v1.0/users/${stopped.id}`, "DELETE");
  await f.request(`/v1.0/directory/deletedItems/${stopped.id}`, "DELETE");
  await f.delivery.drain();
  assert.equal(f.received.length, 1);
  const expiring = await (await f.request("/v1.0/subscriptions", "POST", f.subscription({ expirationDateTime: new Date(Date.now() + 1000).toISOString() }))).json();
  assert.ok(Date.parse(expiring.expirationDateTime) > Date.now() + 44 * 60_000);
  f.advance(46 * 60_000);
  await f.request("/v1.0/users", "POST", { ...f.user, userPrincipalName: "expired@example.test" });
  await f.delivery.drain();
  assert.equal(f.received.length, 1);
  assert.equal((await f.request(`/v1.0/subscriptions/${expiring.id}`)).status, 404);
});

test("Microsoft rejects invalid callback validation and unsupported subscription resources", async t => {
  const f = await fixture(t, { invalidValidation: true });
  assert.equal((await f.request("/v1.0/subscriptions", "POST", f.subscription())).status, 400);
  assert.deepEqual((await (await f.request("/v1.0/subscriptions")).json()).value, []);
  for (const change of [{ resource: "me/messages" }, { resource: "users?$filter=displayName eq 'Ari'" }, { changeType: "created" },
    { clientState: "x".repeat(129) }, { includeResourceData: true }, { expirationDateTime: "invalid" },
    { notificationUrlAppId: "custom-app" }, { encryptionCertificate: "certificate" }, { encryptionCertificateId: "certificate-id" },
    { latestSupportedTlsVersion: "v1_3" },
    { expirationDateTime: new Date(Date.now() + 30 * 86400_000).toISOString() }, { notificationUrl: "ftp://localhost/hooks" }]) {
    assert.equal((await f.request("/v1.0/subscriptions", "POST", f.subscription(change))).status, 400);
  }
  assert.equal(f.validations.length, 1);
});

test("Microsoft validation requires an exact decoded token, HTTP 200, and plain text", async t => {
  for (const options of [
    { validationStatus: 202 },
    { validationContentType: "application/json" },
    { validationContentType: "text/plain-extra" },
    { validationBody: url => encodeURIComponent(url.searchParams.get("validationToken")) },
    { validationBody: url => `${url.searchParams.get("validationToken")}\n` },
  ]) {
    const f = await fixture(t, options);
    assert.equal((await f.request("/v1.0/subscriptions", "POST", f.subscription())).status, 400);
    assert.equal(f.validations.length, 1);
    assert.deepEqual((await (await f.request("/v1.0/subscriptions")).json()).value, []);
  }
  const f = await fixture(t, { validationContentType: "text/plain; charset=utf-8" });
  assert.equal((await f.request("/v1.0/subscriptions", "POST", f.subscription())).status, 201);
});

test("Microsoft application tokens use the client tenant when client ID matches another tenant's user", async t => {
  const f = await fixture(t);
  const tokenResponse = await f.request("/oauth2/v2.0/token", "POST", { grant_type: "client_credentials",
    client_id: "foreign@example.test", client_secret: "collision-secret", scope: "User.ReadWrite.All" });
  assert.equal(tokenResponse.status, 200);
  const token = (await tokenResponse.json()).access_token;
  const response = await f.request("/v1.0/subscriptions", "POST", f.subscription(), token);
  assert.equal(response.status, 201);
  const sub = await response.json();
  assert.equal(sub.applicationId, "foreign@example.test");
  await f.request("/v1.0/users", "POST", f.user, "owner");
  await f.request("/v1.0/users", "POST", { ...f.user, userPrincipalName: "foreign-created@example.test" }, "foreign");
  await f.delivery.drain();
  assert.equal(f.received.length, 1);
  assert.equal(JSON.parse(f.received[0].raw).value[0].tenantId, "tenant-a");
  const created = await f.request("/v1.0/users", "POST", { ...f.user, userPrincipalName: "app-created@example.test" }, token);
  assert.equal(created.status, 201);
  const user = await created.json();
  assert.equal((await f.request(`/v1.0/users/${user.id}`, "PATCH", { displayName: "Same tenant" }, "owner")).status, 204);
  assert.equal((await f.request(`/v1.0/users/${user.id}`, "PATCH", { displayName: "Other tenant" }, "foreign")).status, 404);
});

test("Microsoft retries native bodies and cancels retries after subscription deletion", async t => {
  const f = await fixture(t, { status: list => list.length === 1 ? 500 : 202 });
  const sub = await (await f.request("/v1.0/subscriptions", "POST", f.subscription())).json();
  assert.equal((await f.request("/v1.0/subscriptions", "POST", f.subscription())).status, 409);
  await f.request("/v1.0/users", "POST", f.user);
  await f.delivery.drain();
  assert.equal(f.timers.length, 1);
  f.timers.shift().fn();
  await f.delivery.drain();
  assert.equal(f.received.length, 2);
  assert.equal(f.received[0].raw, f.received[1].raw);
  assert.equal(f.delivery.deliveries[0].status, "succeeded");
  assert.equal((await f.request(`/v1.0/subscriptions/${sub.id}`, "PATCH", { notificationUrl: f.subscription().notificationUrl.replace("/events", "/new-events") })).status, 200);
  assert.equal(f.validations.length, 2);
  const g = await fixture(t, { status: () => 503 });
  const stop = await (await g.request("/v1.0/subscriptions", "POST", g.subscription())).json();
  await g.request("/v1.0/users", "POST", g.user);
  await g.delivery.drain();
  await g.request(`/v1.0/subscriptions/${stop.id}`, "DELETE");
  g.timers.shift().fn();
  await g.delivery.drain();
  assert.equal(g.received.length, 1);
  assert.equal(g.delivery.deliveries[0].status, "cancelled");
});

test("Microsoft capture mode skips HTTP and restores subscriptions from a store snapshot", async t => {
  const f = await fixture(t, { config: { live_delivery: false } });
  const sub = await (await f.request("/v1.0/subscriptions", "POST", f.subscription())).json();
  assert.ok(sub.id);
  f.store.restore(JSON.parse(JSON.stringify(f.store.snapshot())));
  await f.request("/v1.0/users", "POST", f.user);
  await f.delivery.drain();
  assert.equal(f.received.length + f.validations.length, 0);
  assert.equal(f.delivery.deliveries[0].status, "captured");
  assert.equal(JSON.parse(f.delivery.deliveries[0].rawBody).value[0].subscriptionId, sub.id);
});

test("Microsoft accepts any 2xx and retries non-2xx responses only through the local retry limit", async t => {
  for (const status of [200, 204, 299, 400, 503]) {
    const f = await fixture(t, { status: () => status });
    assert.equal((await f.request("/v1.0/subscriptions", "POST", f.subscription())).status, 201);
    await f.request("/v1.0/users", "POST", f.user);
    await f.delivery.drain();
    const delays = [];
    while (f.timers.length) {
      const timer = f.timers.shift();
      delays.push(timer.delay);
      timer.fn();
      await f.delivery.drain();
    }
    const accepted = status < 300;
    assert.deepEqual(delays, accepted ? [] : [1000, 2000, 4000, 8000, 16000]);
    assert.equal(f.received.length, accepted ? 1 : 6);
    assert.equal(new Set(f.received.map(item => item.raw)).size, 1);
    assert.equal(f.delivery.deliveries[0].status, accepted ? "succeeded" : "failed");
  }
});

test("Microsoft cancels pending retries when the subscription expires or its callback changes", async t => {
  for (const change of ["expiry", "callback"]) {
    const f = await fixture(t, { status: () => 503 });
    const sub = await (await f.request("/v1.0/subscriptions", "POST", f.subscription())).json();
    await f.request("/v1.0/users", "POST", f.user);
    await f.delivery.drain();
    if (change === "expiry") f.advance(3600_001);
    else assert.equal((await f.request(`/v1.0/subscriptions/${sub.id}`, "PATCH", {
      notificationUrl: f.subscription().notificationUrl.replace("/events", "/replacement"),
    })).status, 200);
    f.timers.shift().fn();
    await f.delivery.drain();
    assert.equal(f.received.length, 1);
    assert.equal(f.delivery.deliveries[0].status, "cancelled");
  }
});


test("Microsoft keeps OAuth application subscription ownership across new access tokens", async t => {
  const f = await fixture(t);
  const token = async () => {
    const response = await f.request("/oauth2/v2.0/token", "POST", { grant_type: "client_credentials", client_id: "oauth-app",
      client_secret: "oauth-secret", scope: "User.Read.All" });
    assert.equal(response.status, 200);
    return (await response.json()).access_token;
  };
  const first = await token();
  const response = await f.request("/v1.0/subscriptions", "POST", f.subscription(), first);
  assert.equal(response.status, 201);
  const sub = await response.json();
  assert.equal(sub.applicationId, "oauth-app");
  const next = await token();
  assert.notEqual(first, next);
  assert.equal((await f.request(`/v1.0/subscriptions/${sub.id}`, "GET", undefined, next)).status, 200);
  assert.equal((await f.request(`/v1.0/subscriptions/${sub.id}`, "DELETE", undefined, next)).status, 204);
});
