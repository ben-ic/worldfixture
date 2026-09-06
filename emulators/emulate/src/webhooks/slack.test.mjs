import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer as httpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createServer, serve } from "@emulators/core";
import { slackPlugin, seedFromConfig, getSlackStore } from "@emulators/slack";
import { seedSlackWorld } from "../overrides/slack-world-seed.mjs";
import { installSlackWebhooks } from "./slack.mjs";

const secret = "fixture-slack-signing-secret";
const config = { app_id: "A0123456789", user: "alice", signing_secret: secret,
  events: ["message.channels", "reaction_added", "reaction_removed", "user_change",
    "channel_archive", "channel_unarchive", "channel_rename", "member_left_channel",
    "member_joined_channel", "file_created", "file_shared", "file_deleted", "pin_added", "pin_removed"] };

async function fixture(t, handler, options = {}) {
  const received = [];
  const receiver = httpServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    const body = JSON.parse(raw);
    received.push({ raw, body, headers: request.headers });
    assert.equal(request.method, "POST");
    assert.match(request.headers["content-type"], /^application\/json/);
    assert.equal(request.headers["x-slack-signature"], `v0=${createHmac("sha256", secret)
      .update(`v0:${request.headers["x-slack-request-timestamp"]}:${raw}`).digest("hex")}`);
    assert.equal(request.headers["x-github-event"], undefined);
    if (body.type === "url_verification") {
      if (options.badChallenge) return response.end("incorrect");
      response.statusCode = options.challengeStatus ?? 200;
      if (options.challengeFormat === "text") return response.end(body.challenge);
      if (options.challengeFormat === "form") {
        response.setHeader("content-type", "application/x-www-form-urlencoded");
        return response.end(new URLSearchParams({ challenge: body.challenge }).toString());
      }
      response.setHeader("content-type", "application/json");
      return response.end(JSON.stringify({ challenge: body.challenge }));
    }
    if (handler) return handler(request, response, body);
    response.end();
  });
  await new Promise((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  t.after(() => { receiver.closeAllConnections(); receiver.close(); });
  const server = createServer(slackPlugin, { port: 0, baseUrl: "http://localhost",
    tokens: { token: { login: "alice", scopes: [] }, bob: { login: "bob", scopes: [] } } });
  seedSlackWorld(seedFromConfig, server.store, "http://localhost", {
    team: { name: "Fixture", domain: "fixture" }, users: [{ name: "alice" }, { name: "bob" }],
    channels: [{ name: "general" }, { name: "work" }, { name: "private", is_private: true }],
  }, server.webhooks);
  const settings = { ...config, ...options.config,
    request_url: `http://127.0.0.1:${receiver.address().port}/slack/events` };
  const hooks = installSlackWebhooks({ ...server, config: settings, retryDelays: [0, 1, 1], ...options.hookOptions });
  t.after(() => hooks.close());
  if (!options.badChallenge && (!options.challengeStatus || options.challengeStatus === 200)) await hooks.ready;
  const listener = serve({ fetch: server.app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise((resolve) => listener.listening ? resolve() : listener.once("listening", resolve));
  t.after(() => { listener.closeAllConnections(); listener.close(); });
  const ss = getSlackStore(server.store);
  const channel = ss.channels.findOneBy("name", "work").channel_id;
  async function call(method, body = {}, token = "token") {
    const response = await fetch(`http://127.0.0.1:${listener.address().port}/api/${method}`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return response.json();
  }
  return { ...server, ss, hooks, received, channel, call, settings };
}

test("Slack verifies the callback URL, then sends native signed message, edit, delete, and reaction events", async (t) => {
  const f = await fixture(t);
  const sent = await f.call("chat.postMessage", { channel: f.channel, text: "hello" });
  assert.equal(sent.ok, true);
  assert.equal((await f.call("reactions.add", { channel: f.channel, timestamp: sent.ts, name: "eyes" }, "bob")).ok, true);
  assert.equal((await f.call("reactions.remove", { channel: f.channel, timestamp: sent.ts, name: "eyes" }, "bob")).ok, true);
  assert.equal((await f.call("chat.update", { channel: f.channel, ts: sent.ts, text: "changed" })).ok, true);
  assert.equal((await f.call("chat.delete", { channel: f.channel, ts: sent.ts })).ok, true);
  await f.hooks.drain();
  assert.deepEqual(Object.keys(f.received[0].body).sort(), ["challenge", "token", "type"]);
  const callbacks = f.received.slice(1).map((row) => row.body);
  assert.equal(callbacks.length, 5);
  const alice = f.ss.users.findOneBy("name", "alice").user_id;
  const bob = f.ss.users.findOneBy("name", "bob").user_id;
  const team = f.ss.teams.all()[0].team_id;
  for (const body of callbacks) {
    assert.equal(body.type, "event_callback");
    assert.equal(body.team_id, team);
    assert.equal(body.api_app_id, config.app_id);
    assert.match(body.event_id, /^Ev[A-Z0-9]+$/);
    assert.equal(body.authorizations[0].user_id, alice);
    assert.equal(body.authorizations[0].team_id, team);
    assert.equal(body.authorizations[0].is_bot, false);
    assert.match(body.event.event_ts, /^\d{10}\.\d{6}$/);
    assert.ok(Math.abs(Date.now() / 1000 - body.event_time) < 5);
    assert.equal(body.api_version, undefined);
    assert.equal(body.provider, undefined);
  }
  assert.equal(new Set(callbacks.map((row) => row.event_id)).size, 5);
  assert.deepEqual(callbacks[0].event, { ...sent.message, channel: f.channel, channel_type: "channel", event_ts: sent.ts });
  for (const event of callbacks.slice(1, 3).map((row) => row.event)) {
    assert.equal(event.user, bob);
    assert.equal(event.item_user, alice);
    assert.deepEqual(event.item, { type: "message", channel: f.channel, ts: sent.ts });
  }
  assert.equal(callbacks[3].event.subtype, "message_changed");
  assert.equal(callbacks[3].event.previous_message.text, "hello");
  assert.equal(callbacks[3].event.message.text, "changed");
  assert.equal(callbacks[3].event.message.ts, sent.ts);
  assert.equal(callbacks[4].event.subtype, "message_deleted");
  assert.equal(callbacks[4].event.deleted_ts, sent.ts);
});

test("Slack sends thread replies, pins, profile and channel lifecycle mutations", async (t) => {
  const f = await fixture(t);
  const sent = await f.call("chat.postMessage", { channel: f.channel, text: "parent" });
  const reply = await f.call("chat.postMessage", { channel: f.channel, thread_ts: sent.ts, text: "reply" });
  assert.equal(reply.ok, true);
  for (const [method, body] of [
    ["pins.add", { channel: f.channel, timestamp: sent.ts }],
    ["pins.remove", { channel: f.channel, timestamp: sent.ts }],
    ["users.profile.set", { profile: { real_name: "Alice Changed" } }],
    ["conversations.rename", { channel: f.channel, name: "renamed" }],
    ["conversations.archive", { channel: f.channel }],
    ["conversations.unarchive", { channel: f.channel }],
    ["conversations.leave", { channel: f.channel }],
    ["conversations.join", { channel: f.channel }],
  ]) assert.equal((await f.call(method, body)).ok, true, method);
  await f.hooks.drain();
  const events = f.received.slice(1).map((row) => row.body.event);
  assert.equal(events[1].thread_ts, sent.ts);
  for (const type of ["pin_added", "pin_removed", "user_change", "channel_rename", "channel_archive",
    "channel_unarchive", "member_left_channel", "member_joined_channel"]) {
    assert.ok(events.find((event) => event.type === type), type);
  }
  const changed = events.find((event) => event.type === "user_change");
  assert.equal(changed.user.real_name, "Alice Changed");
  assert.ok(changed.cache_ts < 1e11);
});

test("Slack retries identical event bytes with native retry headers and documented delays", async (t) => {
  let attempts = 0;
  const delays = [];
  const f = await fixture(t, (_request, response) => { response.statusCode = ++attempts < 4 ? 503 : 204; response.end(); }, {
    hookOptions: { retryDelays: [0, 60_000, 300_000], sleep: async (ms) => { delays.push(ms); } },
  });
  await f.call("chat.postMessage", { channel: f.channel, text: "retry me" });
  await f.hooks.drain();
  const attemptsReceived = f.received.slice(1);
  assert.equal(attemptsReceived.length, 4);
  assert.equal(new Set(attemptsReceived.map((row) => row.raw)).size, 1);
  assert.equal(attemptsReceived[0].headers["x-slack-retry-num"], undefined);
  for (let index = 1; index < 4; index++) {
    assert.equal(attemptsReceived[index].headers["x-slack-retry-num"], String(index));
    assert.equal(attemptsReceived[index].headers["x-slack-retry-reason"], "http_error");
  }
  assert.deepEqual(delays, [0, 60_000, 300_000]);
});

test("Slack accepts x-slack-no-retry and does not block API writes on the receiver", async (t) => {
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const f = await fixture(t, async (_request, response) => {
    await waiting;
    response.statusCode = 500;
    response.setHeader("x-slack-no-retry", "1");
    response.end();
  });
  t.after(() => release());
  const sent = await f.call("chat.postMessage", { channel: f.channel, text: "async" });
  assert.equal(sent.ok, true, "API response arrives before the receiver is released");
  release();
  await f.hooks.drain();
  assert.equal(f.received.length, 2);
});

test("Slack rejects a wrong URL challenge", async (t) => {
  const f = await fixture(t, undefined, { badChallenge: true });
  await assert.rejects(f.hooks.ready, /URL verification failed/);
});

test("Slack URL verification requires HTTP 200 even when the challenge is correct", async (t) => {
  const f = await fixture(t, undefined, { challengeStatus: 201 });
  await assert.rejects(f.hooks.ready, /return HTTP 200/);
});

test("Slack filters unsubscribed events, failed writes, ephemeral messages, and inaccessible private channels", async (t) => {
  const f = await fixture(t, undefined, { config: { events: ["message.groups"] } });
  const privateChannel = f.ss.channels.findOneBy("name", "private");
  const bob = f.ss.users.findOneBy("name", "bob").user_id;
  f.ss.channels.update(privateChannel.id, { members: [bob] });
  await f.call("chat.postMessage", { channel: privateChannel.channel_id, text: "private" }, "bob");
  await f.call("chat.postMessage", { channel: f.channel, text: "public" });
  assert.equal((await f.call("chat.postMessage", { channel: "CUNKNOWN", text: "failed" })).ok, false);
  await f.call("chat.postEphemeral", { channel: f.channel, user: bob, text: "ephemeral" });
  await f.call("users.setPresence", { presence: "away" });
  await f.hooks.drain();
  assert.equal(f.received.length, 1);
});

test("Slack only sends public-channel pin and member-joined events to a channel member", async (t) => {
  const f = await fixture(t, undefined, { config: { events: ["pin_added", "pin_removed", "member_joined_channel"] } });
  const alice = f.ss.users.findOneBy("name", "alice").user_id;
  const bob = f.ss.users.findOneBy("name", "bob").user_id;
  const channel = f.ss.channels.findOneBy("channel_id", f.channel);
  f.ss.channels.update(channel.id, { members: [bob] });
  const sent = await f.call("chat.postMessage", { channel: f.channel, text: "pin target" }, "bob");
  for (const method of ["pins.add", "pins.remove"]) {
    assert.equal((await f.call(method, { channel: f.channel, timestamp: sent.ts }, "bob")).ok, true);
  }
  f.ss.channels.update(channel.id, { members: [] });
  assert.equal((await f.call("conversations.join", { channel: f.channel }, "bob")).ok, true);
  await f.hooks.drain();
  assert.equal(f.received.length, 1, "non-member installation receives no callbacks");

  assert.equal((await f.call("conversations.join", { channel: f.channel })).ok, true);
  for (const method of ["pins.add", "pins.remove"]) {
    assert.equal((await f.call(method, { channel: f.channel, timestamp: sent.ts }, "bob")).ok, true);
  }
  await f.hooks.drain();
  const events = f.received.slice(1).map((row) => row.body.event);
  assert.deepEqual(events.map((event) => event.type), ["member_joined_channel", "pin_added", "pin_removed"]);
  assert.equal(events[0].user, alice);
  for (const event of events.slice(1)) {
    assert.equal(event.user, bob);
    assert.equal(event.channel_id, f.channel);
    assert.equal(event.item.message.ts, sent.ts);
    assert.equal(event.item.message.text, "pin target");
  }
  assert.equal(events[2].has_pins, false);
});

test("Slack accepts the documented plain-text and form URL challenges", async (t) => {
  for (const challengeFormat of ["text", "form"]) {
    await t.test(challengeFormat, async (t) => {
      const f = await fixture(t, undefined, { challengeFormat });
      assert.equal(f.received[0].body.type, "url_verification");
      await f.call("chat.postMessage", { channel: f.channel, text: "verified" });
      await f.hooks.drain();
      assert.equal(f.received[1].body.event.text, "verified");
    });
  }
});

test("Slack suppresses custom-field-only profile events and preserves mixed and standard changes", async (t) => {
  const f = await fixture(t, undefined, { config: { events: ["user_change"] } });
  const fields = { Xf123456789: { value: "Operations", alt: "" } };
  assert.equal((await f.call("users.profile.set", { profile: { fields } })).ok, true);
  await f.hooks.drain();
  assert.equal(f.received.length, 1);
  assert.deepEqual((await f.call("users.profile.get")).profile.fields, fields);

  const nextFields = { Xf123456789: { value: "Engineering", alt: "" } };
  assert.equal((await f.call("users.profile.set", { profile: { fields: nextFields, display_name: "Alice A" } })).ok, true);
  await f.hooks.drain();
  assert.equal(f.received.length, 2);
  assert.equal(f.received[1].body.event.user.profile.display_name, "Alice A");
  assert.deepEqual(f.received[1].body.event.user.profile.fields, nextFields);
  assert.equal((await f.call("users.profile.set", { profile: { fields } })).ok, true);
  assert.equal((await f.call("users.profile.set", { profile: { status_text: "Available" } })).ok, true);
  await f.hooks.drain();
  assert.equal(f.received.length, 3);
  assert.equal(f.received[2].body.event.user.profile.status_text, "Available");
});

test("Slack channel creation sends a member join only to subscribed channel members", async (t) => {
  const f = await fixture(t, undefined, { config: { events: ["member_joined_channel"] } });
  const alice = f.ss.users.findOneBy("name", "alice");
  for (const is_private of [false, true]) {
    const created = await f.call("conversations.create", { name: is_private ? "new-private" : "new-public", is_private });
    assert.equal(created.ok, true);
    await f.hooks.drain();
    const event = f.received.at(-1).body.event;
    assert.deepEqual(event, { type: "member_joined_channel", user: alice.user_id,
      channel: created.channel.id, channel_type: created.channel.id[0], team: alice.team_id,
      event_ts: event.event_ts });
    assert.match(event.event_ts, /^\d{10}\.\d{6}$/);
  }
  assert.equal((await f.call("conversations.create", { name: "bob-public" }, "bob")).ok, true);
  assert.equal((await f.call("conversations.create", { name: "new-public" })).ok, false);
  await f.hooks.drain();
  assert.equal(f.received.length, 3, "no callback for a non-member or a failed write");
});

test("Slack follows two POST redirects and retries a third redirect with its native reason", async (t) => {
  const f = await fixture(t, (request, response) => {
    const depth = Number(new URL(request.url, "http://receiver").searchParams.get("depth") ?? 0);
    if (request.headers["x-slack-retry-num"] && depth === 2) { response.end(); return; }
    response.statusCode = depth % 2 ? 302 : 301;
    response.setHeader("location", `/slack/events?depth=${depth + 1}`);
    response.end();
  });
  await f.call("chat.postMessage", { channel: f.channel, text: "redirect" });
  await f.hooks.drain();
  const requests = f.received.slice(1);
  assert.equal(requests.length, 6);
  assert.equal(new Set(requests.map((row) => row.raw)).size, 1);
  for (const row of requests.slice(0, 3)) assert.equal(row.headers["x-slack-retry-num"], undefined);
  for (const row of requests.slice(3)) {
    assert.equal(row.headers["x-slack-retry-num"], "1");
    assert.equal(row.headers["x-slack-retry-reason"], "too_many_redirects");
  }
});

test("Slack retries an unanswered HTTP request with http_timeout", async (t) => {
  const f = await fixture(t, (request, response) => {
    if (request.headers["x-slack-retry-num"]) response.end();
  }, { hookOptions: { timeoutMs: 100 } });
  assert.equal((await f.call("chat.postMessage", { channel: f.channel, text: "timeout" })).ok, true);
  await f.hooks.drain();
  assert.equal(f.received.length, 3);
  assert.equal(f.received[2].headers["x-slack-retry-reason"], "http_timeout");
  assert.equal(f.received[2].headers["x-slack-retry-num"], "1");
  assert.equal(f.received[1].raw, f.received[2].raw);
});

test("Slack restores verified subscription state from the provider snapshot", async (t) => {
  const f = await fixture(t);
  const snapshot = f.store.snapshot();
  f.hooks.close();
  f.store.restore(snapshot);
  const restored = installSlackWebhooks({ store: f.store, webhooks: f.webhooks, config: f.settings });
  t.after(() => restored.close());
  await restored.ready;
  await f.call("chat.postMessage", { channel: f.channel, text: "restored" });
  await restored.drain();
  assert.equal(f.received.filter((row) => row.body.type === "url_verification").length, 1);
  assert.equal(f.received[1].body.event.text, "restored");
});

test("Slack file upload, sharing, and deletion send abbreviated native file events", async (t) => {
  const f = await fixture(t);
  const allocated = await f.call("files.getUploadURLExternal", { filename: "report.txt", length: 4 });
  assert.equal(allocated.ok, true);
  // Upload sessions live in this test server; its advertised URL uses localhost without a port.
  const uploaded = await f.app.fetch(new Request(allocated.upload_url, { method: "POST", body: "test" }));
  assert.equal(uploaded.ok, true);
  assert.equal((await f.call("files.completeUploadExternal", { files: [{ id: allocated.file_id }], channel_id: f.channel })).ok, true);
  assert.equal((await f.call("files.delete", { file: allocated.file_id })).ok, true);
  await f.hooks.drain();
  const events = f.received.slice(1).map((row) => row.body.event).filter((event) => event.type.startsWith("file_"));
  assert.deepEqual(events.map((event) => event.type), ["file_created", "file_shared", "file_deleted"]);
  assert.deepEqual(events[0].file, { id: allocated.file_id });
  assert.deepEqual(events[1].file, { id: allocated.file_id });
  assert.equal(events[1].user_id, f.ss.users.findOneBy("name", "alice").user_id);
  assert.equal(events[1].channel_id, f.channel);
  assert.equal(events[2].file_id, allocated.file_id);
  assert.equal(events[2].file, undefined);
});

test("the composed Slack runtime sends an external native webhook from seed events_api configuration", async (t) => {
  const f = await fixture(t);
  const world = mkdtempSync(join(tmpdir(), "worldfixture-slack-events-"));
  t.after(() => rmSync(world, { recursive: true, force: true }));
  mkdirSync(join(world, "projections"));
  const overlay = JSON.stringify({ slack: {
    team: { name: "Fixture", domain: "fixture" }, users: [{ name: "alice" }],
    channels: [{ name: "general" }], events_api: f.settings,
  }, tokens: { token: { login: "alice", scopes: [] } } });
  writeFileSync(join(world, "projections", "emulator-overlay.json"), overlay);
  writeFileSync(join(world, "manifest.json"), JSON.stringify({ api_version: "worldfixture.world-artifact/v1", files: {
    "projections/emulator-overlay.json": { sha256: createHash("sha256").update(overlay).digest("hex"), size: Buffer.byteLength(overlay) },
  } }));
  const probe = httpServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const child = spawn(process.execPath, [new URL("../main.mjs", import.meta.url).pathname], {
    env: { ...process.env, WORLDFIXTURE_WORLD_PATH: world, WORLDFIXTURE_PORT_SLACK: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (child.exitCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await exited;
  });
  await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Composer did not start: ${output}`)), 10000);
    const consume = (chunk) => {
      output += chunk;
      if (output.includes(`listening on 0.0.0.0:${port}`) || output.includes(`listening on 127.0.0.1:${port}`)) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Composer exited ${code}: ${output}`)); });
  });
  // The composer logs its address immediately after server.listen().
  for (let tries = 0; tries < 100; tries++) {
    try { await fetch(`http://127.0.0.1:${port}/__worldfixture/ready`); break; } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  const response = await fetch(`http://127.0.0.1:${port}/api/chat.postMessage`, {
    method: "POST", headers: { authorization: "Bearer token", "content-type": "application/json" },
    body: JSON.stringify({ channel: "general", text: "from composer" }),
  });
  assert.equal((await response.json()).ok, true);
  for (let tries = 0; tries < 100 && !f.received.some((row) => row.body.event?.text === "from composer"); tries++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(f.received.find((row) => row.body.event?.text === "from composer")?.body.type, "event_callback");
});
