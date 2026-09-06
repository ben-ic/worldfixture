import assert from "node:assert/strict";
import { createServer as httpServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { createLocalJWKSet, jwtVerify } from "jose";
import { createServer } from "@emulators/core";
import { getAppleStore } from "@emulators/apple";
import { VENDORS } from "../registry.mjs";

test("Apple account notifications send verifiable native JWS payloads for all four event types", async t => {
  const received = [];
  const receiver = httpServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    received.push(JSON.parse(raw));
    res.writeHead(200).end();
  });
  receiver.listen(0, "127.0.0.1");
  await once(receiver, "listening");
  t.after(() => receiver.close());
  const lifecycle = await VENDORS.apple.load();
  const server = createServer(lifecycle.plugin, { tokens: { token: { login: "admin", id: 1, scopes: [] } } });
  t.after(() => server.webhooks.appleDelivery.close());
  lifecycle.seedFromConfig(server.store, "http://apple.test", {
    users: [{ email: "ari@example.com", is_private_email: true }],
    oauth_clients: [{ client_id: "com.fixture.app", client_secret: "test-secret", redirect_uris: ["http://app.test/callback"] }],
    notifications: [{ client_id: "com.fixture.app", url: `http://127.0.0.1:${receiver.address().port}/apple` }],
  }, server.webhooks);
  const user = getAppleStore(server.store).users.all()[0];
  const types = ["email-enabled", "email-disabled", "consent-revoked", "account-deleted"];
  for (const type of types) {
    const response = await server.app.request("/__worldfixture/apple/account-events", { method: "POST", headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ type, sub: user.uid, client_id: "com.fixture.app" }) });
    assert.equal(response.status, 202, await response.text());
  }
  await server.webhooks.appleDelivery.drain();
  assert.equal(received.length, 4);
  const jwks = await (await server.app.request("/auth/keys")).json();
  const verified = [];
  for (const body of received) {
    assert.deepEqual(Object.keys(body), ["payload"]);
    const { payload, protectedHeader } = await jwtVerify(body.payload, createLocalJWKSet(jwks), { issuer: "https://appleid.apple.com", audience: "com.fixture.app" });
    assert.equal(protectedHeader.alg, "RS256");
    assert.equal(payload.events.sub, user.uid);
    assert.ok(payload.events.event_time < 1e11);
    assert.equal(payload.events.event_time, payload.iat);
    assert.equal(typeof payload.jti, "string");
    if (payload.events.type.startsWith("email-")) {
      assert.equal(payload.events.email, user.private_relay_email);
      assert.equal(payload.events.is_private_email, "true");
    } else assert.equal(payload.events.email, undefined);
    verified.push(payload.events.type);
  }
  assert.deepEqual(verified.sort(), types.sort());
  assert.equal(getAppleStore(server.store).users.all().length, 0);
  server.store.reset();
  lifecycle.seedFromConfig(server.store, "http://apple.test", { users: [], oauth_clients: [] }, server.webhooks);
  const afterReset = await (await server.app.request("/auth/keys")).json();
  const key = server.store.getData("worldfixture.apple.notification_key");
  assert.ok(key);
  assert.ok(afterReset.keys.some(item => item.kid === key.kid));
  assert.ok(jwks.keys.every(item => item.kid !== key.kid));
});
