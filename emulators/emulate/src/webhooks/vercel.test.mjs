import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer as httpServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { createServer } from "@emulators/core";
import { getVercelStore, seedFromConfig, vercelPlugin } from "@emulators/vercel";
import { VENDORS } from "../registry.mjs";
import { extendVercelWebhooksPlugin, seedVercelWebhooks } from "./vercel.mjs";

test("Vercel sends signed project, deployment and environment events with native identifiers", async t => {
  const received = [];
  const receiver = httpServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    received.push({ raw, headers: req.headers, method: req.method });
    res.writeHead(200).end();
  });
  receiver.listen(0, "127.0.0.1");
  await once(receiver, "listening");
  t.after(() => receiver.close());
  const lifecycle = await VENDORS.vercel.load();
  const server = createServer(lifecycle.plugin, { tokens: { token: { login: "ari", id: 1, scopes: [] } } });
  t.after(() => server.webhooks.vercelDelivery.close());
  lifecycle.seedFromConfig(server.store, "http://vercel.test", { users: [{ username: "ari", email: "ari@example.com" }] }, server.webhooks);
  const user = getVercelStore(server.store).users.all()[0];
  seedVercelWebhooks(server.store, { webhooks: [{ url: `http://127.0.0.1:${receiver.address().port}/vercel`, secret: "vercel-secret", owner_id: user.uid,
    events: ["project.created", "project.renamed", "project.removed", "project.env-variable.created", "project.env-variable.updated", "project.env-variable.deleted", "project.domain.created", "deployment.created", "deployment.ready", "deployment.canceled"] }] });
  const request = async (path, method, body) => server.app.request(path, { method,
    headers: { authorization: "Bearer token", "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const project = await (await request("/v11/projects", "POST", { name: "webhook-app" })).json();
  assert.ok(project.id, JSON.stringify(project));
  await request(`/v9/projects/${project.id}`, "PATCH", { name: "webhook-renamed" });
  const dep = await (await request("/v13/deployments", "POST", { name: "webhook-renamed", project: project.id, files: [] })).json();
  assert.ok(dep.id, JSON.stringify(dep));
  assert.equal((await request(`/v12/deployments/${dep.id}/cancel`, "PATCH")).status, 400);
  const vs = getVercelStore(server.store);
  const stored = vs.deployments.findOneBy("uid", dep.id);
  vs.deployments.update(stored.id, { readyState: "BUILDING", state: "BUILDING" });
  assert.equal((await request(`/v12/deployments/${dep.id}/cancel`, "PATCH")).status, 200);
  assert.equal((await request(`/v12/deployments/${dep.id}/cancel`, "PATCH")).status, 400);
  assert.equal((await request(`/v10/projects/${project.id}/domains`, "POST", { name: "preview.example.com", gitBranch: "review" })).status, 200);
  assert.equal((await request(`/v10/projects/${project.id}/domains`, "POST", { name: "preview.example.com", gitBranch: "review" })).status, 409);
  const envResponse = await (await request(`/v10/projects/${project.id}/env`, "POST", { key: "API_SECRET", value: "do-not-deliver", type: "encrypted", target: ["production"] })).json();
  const env = envResponse.envs[0];
  assert.ok(env.id, JSON.stringify(envResponse));
  await request(`/v9/projects/${project.id}/env/${env.id}`, "PATCH", { value: "updated-secret" });
  await request(`/v9/projects/${project.id}/env/${env.id}`, "DELETE");
  await request(`/v9/projects/${project.id}`, "DELETE");
  await server.webhooks.vercelDelivery.drain();
  const events = received.map(item => JSON.parse(item.raw));
  assert.deepEqual(events.map(event => event.type).sort(), ["project.created", "project.renamed", "deployment.created", "deployment.ready", "deployment.canceled", "project.domain.created", "project.env-variable.created", "project.env-variable.updated", "project.env-variable.deleted", "project.removed"].sort());
  assert.equal(events.find(event => event.type === "project.renamed").payload.previousName, "webhook-app");
  assert.equal(events.find(event => event.type === "deployment.created").payload.deployment.id, dep.id);
  assert.deepEqual(events.find(event => event.type === "project.domain.created").payload.domain,
    { name: "preview.example.com", classification: { target: "preview", origin: "custom" } });
  for (const type of ["deployment.created", "deployment.ready", "deployment.canceled"]) {
    const payload = events.find(event => event.type === type).payload;
    assert.equal(payload.project.id, project.id);
    assert.equal(payload.projectId, undefined);
    assert.equal(payload.target, null);
    assert.equal(payload.plan, "hobby");
    assert.ok(Array.isArray(payload.regions));
    assert.equal(payload.links.project, "https://vercel.com/ari/webhook-renamed");
    assert.equal(payload.deployment.name, "webhook-renamed");
    assert.ok(Array.isArray(type === "deployment.created" ? payload.alias : []));
  }
  for (const { raw, headers, method } of received) {
    const event = JSON.parse(raw);
    assert.equal(method, "POST");
    assert.equal(headers["content-type"], "application/json");
    assert.deepEqual(Object.keys(event).sort(), ["createdAt", "id", "payload", "region", "type"]);
    assert.ok(event.createdAt > 1e12);
    assert.equal(Number.isInteger(event.createdAt), true);
    assert.equal(typeof event.id, "string");
    assert.equal(event.region, null);
    assert.equal(event.payload.user.id, user.uid);
    assert.equal(event.payload.team.id, null);
    assert.equal(raw.includes("do-not-deliver"), false);
    assert.equal(raw.includes("updated-secret"), false);
    assert.equal(headers["x-vercel-signature"], createHmac("sha1", "vercel-secret").update(raw).digest("hex"));
    assert.equal(headers["x-github-event"], undefined);
  }
  assert.equal(new Set(events.map(event => event.id)).size, events.length);
  for (const type of ["created", "updated", "deleted"]) {
    assert.deepEqual(events.find(event => event.type === `project.env-variable.${type}`).payload,
      { team: { id: null }, user: { id: user.uid }, projectId: project.id, envVarId: env.id });
  }
});

async function fixture(t, { options = {}, respond = () => 204 } = {}) {
  const received = [];
  const receiver = httpServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    const item = { raw, headers: req.headers, path: req.url, event: JSON.parse(raw) };
    received.push(item);
    res.writeHead(respond(item), { location: "/must-not-follow" }).end();
  });
  receiver.listen(0, "127.0.0.1");
  await once(receiver, "listening");
  t.after(() => receiver.close());
  const server = createServer(extendVercelWebhooksPlugin(vercelPlugin, options), {
    tokens: { token: { login: "ari", id: 1, scopes: [] }, other: { login: "bea", id: 2, scopes: [] } },
  });
  t.after(() => server.webhooks.vercelDelivery.close());
  seedFromConfig(server.store, "http://vercel.test", {
    users: [{ username: "ari" }, { username: "bea" }], teams: [{ slug: "example-team" }],
  });
  const vs = getVercelStore(server.store);
  const user = vs.users.findOneBy("username", "ari");
  const team = vs.teams.findOneBy("slug", "example-team");
  const endpoint = (path, events, extra = {}) => ({
    url: `http://127.0.0.1:${receiver.address().port}/${path}`, secret: `${path}-secret`,
    owner_id: user.uid, events, ...extra,
  });
  const request = (path, method, body, token = "token") => server.app.request(path, {
    method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { server, vs, user, team, endpoint, request, received, delivery: server.webhooks.vercelDelivery };
}

test("Vercel upserts send updated events and batch inserts send created events", async t => {
  const { server, user, endpoint, request, received, delivery } = await fixture(t);
  const project = await (await request("/v11/projects", "POST", { name: "env-upsert" })).json();
  seedVercelWebhooks(server.store, { webhooks: [endpoint("env", ["project.env-variable.created", "project.env-variable.updated"])] });
  const row = key => ({ key, value: "private-value", type: "encrypted", target: ["production"] });
  const original = await (await request(`/v10/projects/${project.id}/env`, "POST", row("FIRST"))).json();
  const batch = await (await request(`/v10/projects/${project.id}/env?upsert=true`, "POST",
    [row("FIRST"), row("SECOND"), row("THIRD")])).json();
  assert.equal(batch.envs[0].id, original.envs[0].id);
  assert.equal((await request(`/v10/projects/${project.id}/env`, "POST", row("FIRST"))).status, 409);
  assert.equal((await request(`/v9/projects/${project.id}/env/missing`, "PATCH", { value: "x" })).status, 404);
  await delivery.drain();
  assert.deepEqual(received.map(item => [item.event.type, item.event.payload.envVarId]), [
    ["project.env-variable.created", original.envs[0].id],
    ["project.env-variable.updated", original.envs[0].id],
    ["project.env-variable.created", batch.envs[1].id],
    ["project.env-variable.created", batch.envs[2].id],
  ]);
  for (const item of received) {
    assert.deepEqual(item.event.payload, { team: { id: null }, user: { id: user.uid }, projectId: project.id, envVarId: item.event.payload.envVarId });
    assert.equal(item.raw.includes("private-value"), false);
  }
});

test("Vercel routes events by owner, actor, team ID or slug, project and event selection", async t => {
  const { server, vs, user, team, endpoint, request, received, delivery } = await fixture(t);
  const selected = await (await request(`/v11/projects?teamId=${team.uid}`, "POST", { name: "selected" })).json();
  const events = ["project.created", "project.renamed", "project.removed", "deployment.created", "deployment.ready", "project.env-variable.created", "project.domain.created"];
  seedVercelWebhooks(server.store, { webhooks: [
    endpoint("personal", events),
    endpoint("team", events, { owner_id: team.uid }),
    endpoint("selected", events, { owner_id: team.uid, project_ids: [selected.id] }),
    endpoint("wrong-project", events, { owner_id: team.uid, project_ids: ["prj_missing"] }),
    endpoint("disabled", events, { owner_id: team.uid, enabled: false }),
    endpoint("ready-only", ["deployment.ready"], { owner_id: team.uid }),
  ] });
  await request(`/v9/projects/${selected.id}?slug=${team.slug}`, "PATCH", { name: "selected-renamed" }, "other");
  await request(`/v9/projects/${selected.id}?teamId=${team.uid}`, "PATCH", { name: "selected-renamed" });
  assert.equal((await request(`/v9/projects/${selected.id}`, "PATCH", { name: "wrong-owner" })).status, 404);
  assert.equal((await request(`/v11/projects?teamId=team_missing`, "POST", { name: "bad-team" })).status, 400);
  const deployment = await (await request(`/v13/deployments?slug=${team.slug}`, "POST", {
    name: "selected-renamed", project: selected.id, target: "production", meta: { test: "kept" }, regions: ["fra1"],
  }, "other")).json();
  await request(`/v10/projects/${selected.id}/env?teamId=${team.uid}`, "POST", { key: "TEST", value: "secret", type: "encrypted", target: ["production"] });
  await request(`/v10/projects/${selected.id}/domains?slug=${team.slug}`, "POST", { name: "test.example.com" });
  await request(`/v9/projects/${selected.id}?teamId=${team.uid}`, "DELETE");
  await request("/v11/projects", "POST", { name: "personal" });
  await delivery.drain();
  assert.deepEqual(received.filter(item => item.path === "/personal").map(item => item.event.type), ["project.created"]);
  assert.deepEqual(received.filter(item => item.path === "/selected").map(item => item.event.type).sort(),
    ["deployment.created", "deployment.ready", "project.env-variable.created", "project.domain.created"].sort());
  assert.equal(received.some(item => ["/wrong-project", "/disabled"].includes(item.path)), false);
  assert.deepEqual(received.filter(item => item.path === "/ready-only").map(item => item.event.type), ["deployment.ready"]);
  const teamEvents = received.filter(item => item.path === "/team").map(item => item.event);
  assert.equal(teamEvents.filter(event => event.type === "project.renamed").length, 1);
  const created = teamEvents.find(event => event.type === "deployment.created");
  assert.equal(created.payload.user.id, vs.users.findOneBy("username", "bea").uid);
  assert.equal(created.payload.team.id, team.uid);
  assert.deepEqual(created.payload.deployment, { id: deployment.id, meta: { test: "kept" }, url: deployment.url, name: "selected-renamed" });
  assert.deepEqual(created.payload.alias, deployment.alias);
  assert.equal(created.payload.target, "production");
  assert.deepEqual(created.payload.regions, ["fra1"]);
  assert.equal(created.payload.links.project, "https://vercel.com/example-team/selected-renamed");
  assert.equal(created.payload.links.deployment, `https://vercel.com/example-team/selected-renamed/${deployment.id.replace(/^dpl_/, "")}`);
  assert.equal(teamEvents.find(event => event.type === "project.env-variable.created").payload.user.id, user.uid);
  for (const item of received) {
    assert.equal(item.headers["x-vercel-signature"], createHmac("sha1", `${item.path.slice(1)}-secret`).update(item.raw).digest("hex"));
  }
});

test("Vercel deployment creation sends project.created when it creates a project", async t => {
  const { server, endpoint, request, received, delivery } = await fixture(t);
  seedVercelWebhooks(server.store, { webhooks: [endpoint("new-project", ["project.created", "deployment.created", "deployment.ready", "deployment.error"])] });
  const first = await (await request("/v13/deployments", "POST", { name: "implicit", target: "staging" })).json();
  await request("/v13/deployments", "POST", { name: "implicit", target: "staging" });
  await delivery.drain();
  assert.equal(received.filter(item => item.event.type === "project.created").length, 1);
  assert.deepEqual(received.find(item => item.event.type === "project.created").event.payload.project, { id: first.projectId, name: "implicit" });
  assert.equal(received.filter(item => item.event.type === "deployment.created").length, 2);
  assert.equal(received.filter(item => item.event.type === "deployment.ready").length, 2);
  assert.equal(received.some(item => item.event.type === "deployment.error"), false);
  assert.equal(received.find(item => item.event.type === "deployment.created").event.payload.target, "staging");
});

test("Vercel retries non-2xx responses without redirects and keeps the signed event unchanged", async t => {
  const timers = [];
  const statuses = [302, 400, 500, 204];
  const { server, endpoint, request, received, delivery } = await fixture(t, {
    options: { setTimer: (callback, delay) => { const timer = { callback, delay }; timers.push(timer); return timer; }, clearTimer: () => {} },
    respond: () => statuses.shift() ?? 204,
  });
  seedVercelWebhooks(server.store, { webhooks: [endpoint("retry", ["project.created"])] });
  await request("/v11/projects", "POST", { name: "retry" });
  await delivery.drain();
  for (let attempt = 0; attempt < 3; attempt++) {
    assert.equal(delivery.deliveries[0].status, "retrying");
    const timer = timers.shift();
    assert.ok(timer.delay > 0);
    timer.callback();
    await delivery.drain();
  }
  assert.equal(delivery.deliveries[0].status, "succeeded");
  assert.equal(timers.length, 0);
  assert.equal(received.length, 4);
  assert.equal(new Set(received.map(item => item.raw)).size, 1);
  assert.equal(new Set(received.map(item => item.headers["x-vercel-signature"])).size, 1);
  assert.ok(received.every(item => item.path === "/retry"));
});

test("Vercel stops retries after expiry or replacement of the seed overlay", async t => {
  const timers = [];
  const { server, endpoint, request, received, delivery } = await fixture(t, {
    options: { setTimer: callback => { const timer = { callback }; timers.push(timer); return timer; }, clearTimer: () => {} },
    respond: () => 503,
  });
  const webhooks = [endpoint("expired", ["project.created"])];
  seedVercelWebhooks(server.store, { webhooks });
  await request("/v11/projects", "POST", { name: "expired" });
  await delivery.drain();
  delivery.deliveries[0].expiresAt = Date.now() - 1;
  timers.shift().callback();
  await delivery.drain();
  assert.equal(received.length, 1);
  assert.equal(delivery.deliveries[0].status, "cancelled");
  await request("/v11/projects", "POST", { name: "reset" });
  await delivery.drain();
  seedVercelWebhooks(server.store, { webhooks });
  timers.shift().callback();
  await delivery.drain();
  assert.equal(received.length, 2);
  assert.equal(delivery.deliveries[1].status, "cancelled");
});
