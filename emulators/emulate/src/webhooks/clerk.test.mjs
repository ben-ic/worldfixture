import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer as httpServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { createServer } from "@emulators/core";
import { VENDORS } from "../registry.mjs";

test("Clerk user and session writes send native Svix requests with millisecond timestamps", async t => {
  const received = [];
  const receiver = httpServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    received.push({ raw, headers: req.headers });
    res.writeHead(200).end();
  });
  receiver.listen(0, "127.0.0.1");
  await once(receiver, "listening");
  t.after(() => receiver.close());
  const lifecycle = await VENDORS.clerk.load();
  const server = createServer(lifecycle.plugin, { tokens: { sk_test_clerk: { login: "admin@example.com", id: 1, scopes: [] } } });
  t.after(() => server.webhooks.clerkDelivery.close());
  const secret = `whsec_${Buffer.from("clerk-test-signing-secret").toString("base64")}`;
  lifecycle.seedFromConfig(server.store, "http://clerk.test", { users: [], instance_id: "ins_test",
    webhooks: [{ url: `http://127.0.0.1:${receiver.address().port}/clerk`, signing_secret: secret,
      events: ["user.created", "user.updated", "user.deleted", "session.created", "session.revoked"] }] }, server.webhooks);
  const request = async (path, method, body) => server.app.request(path, { method,
    headers: { authorization: "Bearer sk_test_clerk", "content-type": "application/json", "user-agent": "clerk-parity-test" },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const metadata = { created_at: 123, nested: { updated_at: 456 } };
  const user = await (await request("/v1/users", "POST", { first_name: "Ari", external_id: "customer_123", email_address: ["ari@example.com"], password: "test-password", private_metadata: metadata })).json();
  assert.equal(user.object, "user");
  await request(`/v1/users/${user.id}`, "PATCH", { first_name: "Aria" });
  await request(`/v1/users/${user.id}/metadata`, "PATCH", { public_metadata: metadata });
  for (const action of ["ban", "unban", "lock", "unlock"]) {
    assert.equal((await request(`/v1/users/${user.id}/${action}`, "POST")).status, 200);
  }
  const session = await (await request("/v1/sessions", "POST", { user_id: user.id })).json();
  await request(`/v1/sessions/${session.id}/revoke`, "POST");
  await request(`/v1/users/${user.id}`, "DELETE");
  assert.equal((await request(`/v1/users/${user.id}`, "PATCH", { first_name: "Missing" })).status, 404);
  await server.webhooks.clerkDelivery.drain();
  assert.deepEqual(received.map(item => JSON.parse(item.raw).type).sort(), ["user.created", ...Array(6).fill("user.updated"), "user.deleted", "session.created", "session.revoked"].sort());
  for (const { raw, headers } of received) {
    const event = JSON.parse(raw);
    assert.equal(event.object, "event");
    assert.equal(event.instance_id, "ins_test");
    assert.ok(event.timestamp > 1e12);
    assert.deepEqual(event.event_attributes, { http_request: { client_ip: "0.0.0.0", user_agent: "clerk-parity-test" } });
    assert.match(headers["svix-id"], /^msg_\S+$/);
    assert.ok(Math.abs(Number(headers["svix-timestamp"]) - event.timestamp / 1000) < 5);
    assert.equal(raw.includes("test-password"), false);
    assert.equal(headers["x-github-event"], undefined);
    const signature = createHmac("sha256", Buffer.from(secret.slice(6), "base64"))
      .update(`${headers["svix-id"]}.${headers["svix-timestamp"]}.${raw}`).digest("base64");
    assert.equal(headers["svix-signature"], `v1,${signature}`);
    if (event.type === "user.created") {
      assert.equal(event.data.id, user.id);
      assert.equal(event.data.first_name, "Ari");
      assert.equal(event.data.email_addresses[0].email_address, "ari@example.com");
      assert.equal(event.data.created_at, user.created_at * 1000);
      assert.deepEqual(event.data.private_metadata, metadata);
    }
    if (event.type === "user.deleted") {
      assert.equal(event.data.id, user.id);
      assert.equal(event.data.deleted, true);
      assert.equal(event.data.external_id, "customer_123");
      assert.equal(event.data.slug, undefined);
      assert.equal(event.data.email_addresses, undefined);
    }
    if (event.type.startsWith("session.")) {
      assert.equal(event.data.object, "session");
      assert.equal(event.data.id, session.id);
      assert.equal(event.data.user_id, user.id);
      assert.equal(event.data.actor, null);
      assert.equal(event.data.user.id, user.id);
      assert.equal(event.data.user.object, "user");
      assert.equal(event.data.user.first_name, "Aria");
      assert.equal(event.data.user.password_hash, undefined);
      assert.deepEqual(event.data.user.public_metadata, metadata);
      assert.equal(event.data.status, event.type === "session.created" ? "active" : "revoked");
      for (const field of ["created_at", "last_active_at", "expire_at", "abandon_at"]) {
        assert.equal(event.data[field], session[field] * 1000);
      }
      assert.ok(event.data.user.last_sign_in_at > 1e12);
    }
  }
  assert.equal(new Set(received.map(item => item.headers["svix-id"])).size, received.length);
  const updates = received.map(item => JSON.parse(item.raw)).filter(event => event.type === "user.updated");
  assert.deepEqual(updates.map(event => [event.data.banned, event.data.locked]), [
    [false, false], [false, false], [true, false], [false, false], [false, true], [false, false],
  ]);
});

test("Clerk organization, membership, and invitation deliveries preserve resource fields and endpoint filters", async t => {
  const received = [];
  const receiver = httpServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    received.push({ path: req.url, event: JSON.parse(raw), id: req.headers["svix-id"] });
    res.writeHead(204).end();
  });
  receiver.listen(0, "127.0.0.1");
  await once(receiver, "listening");
  t.after(() => receiver.close());
  const lifecycle = await VENDORS.clerk.load();
  const server = createServer(lifecycle.plugin, { tokens: { sk_test_clerk: { login: "admin@example.com", id: 1, scopes: [] } } });
  t.after(() => server.webhooks.clerkDelivery.close());
  const events = ["organization.created", "organization.updated", "organization.deleted",
    "organizationMembership.created", "organizationMembership.updated", "organizationInvitation.created", "organizationInvitation.revoked"];
  const endpoint = path => ({ url: `http://127.0.0.1:${receiver.address().port}/${path}`,
    signing_secret: `whsec_${Buffer.from("clerk-org-test-secret").toString("base64")}`, events });
  lifecycle.seedFromConfig(server.store, "http://clerk.test", { users: [], instance_id: "ins_test", webhooks: [
    endpoint("all"), { ...endpoint("updated"), events: ["organization.updated"] },
    { ...endpoint("disabled"), enabled: false },
  ] }, server.webhooks);
  const request = (path, method, body) => server.app.request(path, { method,
    headers: { authorization: "Bearer sk_test_clerk", "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const user = await (await request("/v1/users", "POST", { first_name: "Ari", email_address: ["ari@example.com"] })).json();
  const org = await (await request("/v1/organizations", "POST", { name: "Demo", slug: "demo", max_allowed_memberships: 12 })).json();
  const orgPath = `/v1/organizations/${org.id}`;
  await request(orgPath, "PATCH", { name: "New Demo" });
  const metadata = { created_at: 123, nested: { expires_at: 456 } };
  await request(`${orgPath}/metadata`, "PATCH", { public_metadata: metadata });
  const member = await (await request(`${orgPath}/memberships`, "POST", { user_id: user.id, role: "org:member" })).json();
  await request(`${orgPath}/memberships/${user.id}`, "PATCH", { role: "org:admin" });
  await request(`${orgPath}/memberships/${user.id}/metadata`, "PATCH", { private_metadata: metadata });
  const invitation = await (await request(`${orgPath}/invitations`, "POST", { email_address: "guest@example.com", expires_in_days: 7 })).json();
  await request(`${orgPath}/invitations/${invitation.id}/revoke`, "POST");
  assert.equal((await request(`${orgPath}/invitations/${invitation.id}/revoke`, "POST")).status, 422);
  assert.equal((await request(`${orgPath}/memberships`, "POST", { user_id: "user_missing" })).status, 404);
  assert.equal((await server.app.request(orgPath, { method: "PATCH" })).status, 401);
  await request(orgPath, "GET");
  await request(orgPath, "DELETE");
  assert.equal((await request(orgPath, "DELETE")).status, 404);
  await server.webhooks.clerkDelivery.drain();
  const all = received.filter(item => item.path === "/all").map(item => item.event);
  assert.deepEqual(all.map(event => event.type), ["organization.created", "organization.updated", "organization.updated",
    "organizationMembership.created", "organizationMembership.updated", "organizationMembership.updated",
    "organizationInvitation.created", "organizationInvitation.revoked", "organization.deleted"]);
  assert.equal(received.some(item => item.path === "/disabled"), false);
  const updated = received.filter(item => item.path === "/updated");
  assert.equal(updated.length, 2);
  for (const item of updated) {
    assert.equal(item.event.type, "organization.updated");
    assert.deepEqual(item.event, received.find(other => other.path === "/all" && other.id === item.id)?.event);
  }
  assert.equal(all[0].data.object, "organization");
  assert.equal(all[0].data.max_allowed_memberships, 12);
  assert.equal(all[0].data.created_at, org.created_at * 1000);
  assert.equal(all[1].data.name, "New Demo");
  assert.deepEqual(all[2].data.public_metadata, metadata);
  for (const event of all.filter(event => event.type.startsWith("organizationMembership."))) {
    assert.equal(event.data.object, "organization_membership");
    assert.equal(event.data.id, member.id);
    assert.equal(event.data.organization.id, org.id);
    assert.equal(event.data.organization.object, "organization");
    assert.equal(event.data.organization.created_at, org.created_at * 1000);
    assert.equal(event.data.public_user_data.user_id, user.id);
    assert.equal(event.data.public_user_data.identifier, "ari@example.com");
    assert.ok(Array.isArray(event.data.permissions));
  }
  assert.equal(all[3].data.role, "org:member");
  assert.equal(all[4].data.role, "org:admin");
  assert.deepEqual(all[5].data.private_metadata, metadata);
  for (const event of all.filter(event => event.type.startsWith("organizationInvitation."))) {
    assert.equal(event.data.object, "organization_invitation");
    assert.equal(event.data.id, invitation.id);
    assert.equal(event.data.organization_id, org.id);
    assert.equal(event.data.expires_at, (invitation.created_at + 7 * 86400) * 1000);
  }
  assert.equal(all[6].data.status, "pending");
  assert.equal(all[7].data.status, "revoked");
  assert.equal(all[8].data.id, org.id);
  assert.equal(all[8].data.deleted, true);
  assert.equal(all[8].data.slug, undefined);
  assert.equal(all[8].data.name, undefined);
});
