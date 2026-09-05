// The deterministic timeline scheduler and its arrival deliveries.
//
// Providers are stubbed at the network boundary, and the clock is injected, so
// these run in milliseconds and cover the paths that only appear when something
// is wrong: a channel the world does not have, a provider that answers 500, a
// webhook with no subscriber. Whether the real Slack and the real Cyrus accept
// these writes is proved separately, against the one-container image.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { KINDS, deliverArrival } from "./arrivals.mjs";
import { advanceClock, startClock } from "./clock.mjs";
import { armTimeline, due, pending, playDue, playOne, startScheduler, timelineState } from "./scheduler.mjs";
import { forgetSlackCaches } from "./slack.mjs";
import { eventsAfter, openState, resetState } from "./state.mjs";

const T0 = 1_800_000_000_000;
const CREDENTIALS = { values: { "token:slack_token_maya-chen": randomBytes(24).toString("hex") } };

const WORLD = {
  id: "test.world",
  clock: { anchor: "2026-08-21T09:00:00Z" },
  people: [
    { id: "maya-chen", name: "Maya Chen", email: "maya@northstar.test", slack_id: "U_MAYA" },
    { id: "jon-bell", name: "Jon Bell", email: "jon@northstar.test", slack_id: "U_JON" },
    { id: "priya-raman", name: "Priya Raman", email: "priya@lumen.test" },
  ],
  communication: {
    channels: [{ id: "channel-release", name: "release-2-8", member_ids: ["maya-chen", "jon-bell"] }],
  },
  timeline: [
    { after_seconds: 60, id: "b-second", kind: "chat-message", payload: { author_id: "maya-chen", channel_id: "channel-release", text: "second" } },
    { after_seconds: 20, id: "a-first", kind: "chat-message", payload: { author_id: "maya-chen", channel_id: "channel-release", text: "first" } },
    { after_seconds: 90, id: "c-mail", kind: "incoming-email", payload: { from_id: "priya-raman", to_id: "maya-chen", subject: "Export", body_text: "still failing" } },
  ],
};

function fresh() {
  // The channel and identity caches live for the process, not the test.
  forgetSlackCaches();
  const db = openState(":memory:");
  startClock(db, { anchor: WORLD.clock.anchor, now: T0 });
  return db;
}

// A stub for every network call an arrival can make. Records what was asked.
function providers({ slackOk = true, mailOk = true, httpStatus = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    if (String(url).includes("/api/")) assert.equal(options.headers.Authorization, `Bearer ${CREDENTIALS.values["token:slack_token_maya-chen"]}`);
    calls.push({ url: String(url), method: options.method ?? "GET", body: options.body });
    if (String(url).includes("/api/chat.postMessage")) {
      return new Response(JSON.stringify(slackOk
        ? { ok: true, channel: "C_RELEASE", ts: "1788400000.000100" }
        : { ok: false, error: "channel_not_found" }), { status: 200 });
    }
    if (String(url).includes("/api/auth.test")) {
      return new Response(JSON.stringify({ ok: true, user: "mayac", user_id: "U_MAYA" }), { status: 200 });
    }
    if (String(url).includes("/api/conversations.list")) {
      return new Response(JSON.stringify({ ok: true, channels: [{ id: "C_RELEASE", name: "release-2-8" }] }), { status: 200 });
    }
    return new Response(httpStatus === 200 ? JSON.stringify({ id: "obj_1", status: "succeeded" }) : "no", { status: httpStatus });
  };
  fetchImpl.calls = calls;

  const sent = [];
  return { fetchImpl, calls, sent, mailOk };
}

test("arming puts the whole timeline in the table, in world order", () => {
  const db = fresh();
  const result = armTimeline(db, WORLD);

  assert.deepEqual(result, { armed: 3, total: 3 });
  assert.deepEqual(pending(db).map((row) => row.id), ["a-first", "b-second", "c-mail"]);
  assert.deepEqual(pending(db).map((row) => row.due_at), [20_000, 60_000, 90_000]);

  // Arming twice must not duplicate. `up` arms once, but a re-arm after reset
  // runs against a table the reset has already cleared, and a bug that left rows
  // behind would otherwise double every arrival.
  armTimeline(db, WORLD);
  assert.equal(pending(db).length, 3);
  db.close();
});

test("arming replaces the schedule, so another world's arrivals cannot survive", () => {
  const db = fresh();

  // A state directory that has already run a different world. Measured for
  // real: starting the larger world in a directory that had run the smaller one
  // armed 142 rows for a 134-event timeline, eight of them delivered arrivals
  // belonging to a world that was no longer running.
  armTimeline(db, {
    timeline: [
      { after_seconds: 20, id: "arrival-from-another-world", kind: "chat-message", payload: {} },
      { after_seconds: 540, id: "arrival-old-webhook", kind: "webhook", payload: {} },
    ],
  });
  db.prepare("UPDATE scheduled_events SET delivered_at = 1 WHERE id = ?").run("arrival-from-another-world");
  assert.equal(timelineState(db).total, 2);

  const result = armTimeline(db, WORLD);
  assert.deepEqual(result, { armed: 3, total: 3 });
  assert.deepEqual(pending(db).map((row) => row.id), ["a-first", "b-second", "c-mail"]);
  assert.equal(timelineState(db).total, 3, "a row from another world survived arming");
  assert.equal(timelineState(db).delivered, 0, "the new world started with a spent arrival");
  db.close();
});

test("a world with no timeline arms nothing and says so", () => {
  const db = fresh();
  assert.deepEqual(armTimeline(db, { id: "empty" }), { armed: 0, total: 0 });
  assert.deepEqual(timelineState(db), { total: 0, delivered: 0, pending: 0, next_due_ms: null });
  db.close();
});

test("nothing is due before its world time, and the clock decides", () => {
  const db = fresh();
  armTimeline(db, WORLD);

  assert.deepEqual(due(db, 0).map((row) => row.id), []);
  assert.deepEqual(due(db, 19_999).map((row) => row.id), []);
  assert.deepEqual(due(db, 20_000).map((row) => row.id), ["a-first"]);
  assert.deepEqual(due(db, 95_000).map((row) => row.id), ["a-first", "b-second", "c-mail"]);
  db.close();
});

test("a chat arrival goes through the Slack Web API and becomes a fact", async () => {
  const db = fresh();
  armTimeline(db, WORLD);
  const stub = providers();

  const played = await playOne(db, pending(db)[0], {
    world: WORLD, credentials: CREDENTIALS,
    bindings: { SLACK_BASE_URL: "http://slack.test" },
    rules: [],
    now: () => T0,
    fetchImpl: stub.fetchImpl,
  });

  assert.equal(played.status, "delivered");
  assert.equal(played.channel, "release-2-8");

  // Through the API, not into a store.
  assert.ok(stub.calls.some((call) => call.url.includes("/api/chat.postMessage") && call.method === "POST"));

  // And recorded with Slack's own evidence, so a reader can go and check.
  const [event] = eventsAfter(db, 0, 10);
  assert.equal(event.type, "communication.message.sent.v1");
  assert.equal(event.actor_id, "maya-chen");
  assert.equal(event.source, "slack");
  assert.equal(event.provider_evidence.message_ts, "1788400000.000100");
  assert.equal(event.provider_evidence.arrival, "a-first");
  db.close();
});

test("a run of chat arrivals costs one Slack request each after the first", async () => {
  // The token budget is real and was measured: the composer allows 5,000
  // requests per token per hour, per listener. `send` used to cost three --
  // conversations.list, chat.postMessage, auth.test -- so a hundred scheduled
  // messages spent three hundred of one person's budget on two lookups whose
  // answers never change during a run.
  forgetSlackCaches();
  const db = fresh();
  armTimeline(db, WORLD);
  const stub = providers();
  const context = {
    world: WORLD, credentials: CREDENTIALS,
    bindings: { SLACK_BASE_URL: "http://slack.test" },
    rules: [],
    now: () => T0,
    fetchImpl: stub.fetchImpl,
  };

  await playOne(db, pending(db)[0], context);
  const afterFirst = stub.calls.length;
  await playOne(db, pending(db)[0], context);
  const secondCost = stub.calls.length - afterFirst;

  assert.equal(afterFirst, 3, "the first send resolves the channel and the identity");
  assert.equal(secondCost, 1, `a later send cost ${secondCost} requests instead of one`);
  assert.deepEqual(
    stub.calls.slice(afterFirst).map((call) => call.url),
    ["http://slack.test/api/chat.postMessage"],
  );
  forgetSlackCaches();
  db.close();
});

test("a scheduled message fires the causal rules, like a typed one", async () => {
  const db = fresh();
  armTimeline(db, WORLD);
  const stub = providers();

  // The world's own notification rule, in the shape `rules.mjs` takes.
  const rules = [{
    id: "rule-slack-channel-notification",
    when: "communication.message.sent.v1",
    emit: [{
      type: "mail.notification.requested.v1",
      with: {
        author: { copy: "actor_id" },
        channel: { copy: "provider_evidence.channel_name" },
        text: { copy: "provider_evidence.text" },
        recipients: { lookup: { collection: "communication.channels", match: { field: "name", value: { copy: "provider_evidence.channel_name" } }, select: "member_ids" } },
      },
    }],
  }];

  const delivered = [];
  const played = await playOne(db, pending(db)[0], {
    world: WORLD, credentials: CREDENTIALS,
    bindings: { SLACK_BASE_URL: "http://slack.test", SMTP_HOST_PORT: "127.0.0.1:2525" },
    rules,
    now: () => T0,
    fetchImpl: stub.fetchImpl,
    // `deliver` reaches SMTP through `smtp.mjs`; intercept at that boundary.
    sendMail: async (_address, message) => delivered.push(message),
  });

  assert.equal(played.status, "delivered");

  // Jon is the other channel member; Maya wrote it, so she is not notified.
  const events = eventsAfter(db, 0, 20);
  const notifications = events.filter((event) => event.type === "mail.notification.delivered.v1");
  assert.equal(notifications.length, 1, `expected one notification, got ${events.map((e) => e.type).join(", ")}`);
  assert.equal(notifications[0].actor_id, "jon-bell");
  assert.equal(played.notified, 1);
  db.close();
});

test("a mail arrival goes over SMTP and is recorded as received", async () => {
  const db = fresh();
  armTimeline(db, WORLD);
  const sent = [];

  const row = pending(db).find((entry) => entry.id === "c-mail");
  const played = await playOne(db, row, {
    world: WORLD, credentials: CREDENTIALS,
    bindings: { SMTP_HOST_PORT: "127.0.0.1:2525" },
    now: () => T0,
    sendMail: async (address, message) => sent.push({ address, message }),
  });

  assert.equal(played.status, "delivered");
  assert.equal(played.via, "smtp");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.from, "priya@lumen.test");
  assert.equal(sent[0].message.to, "maya@northstar.test");
  assert.equal(sent[0].message.headers["X-WorldFixture-Arrival"], "c-mail");

  const [event] = eventsAfter(db, 0, 10);
  assert.equal(event.type, "mail.message.received.v1");
  assert.equal(event.provider_evidence.via, "smtp");
  db.close();
});

test("via gmail uses the emulator's own messages.insert", async () => {
  const db = fresh();
  const stub = providers();

  const played = await deliverArrival(db, {
    id: "x",
    kind: "incoming-email",
    payload: { via: "gmail", from_id: "priya-raman", to_id: "maya-chen", subject: "s", body_text: "b" },
  }, {
    world: WORLD, credentials: CREDENTIALS,
    bindings: { GOOGLE_BASE_URL: "http://google.test", GOOGLE_TOKEN: "t" },
    commandId: "cmd_1",
    now: () => T0,
    fetchImpl: stub.fetchImpl,
  });

  assert.equal(played.status, "delivered");
  assert.equal(played.via, "gmail");
  const insert = stub.calls.find((call) => call.url.includes("/gmail/v1/users/me/messages"));
  assert.ok(insert, "Gmail was not asked to insert the message");
  assert.equal(insert.method, "POST");
  db.close();
});

// ---- the honest refusals -------------------------------------------------

test("a webhook with no subscriber is skipped with the reason, not invented", async () => {
  const db = fresh();
  const stub = providers();

  const played = await deliverArrival(db, {
    id: "pay", kind: "webhook", payload: { event: "finance.invoice.paid", amount_cents: 41200 },
  }, { world: WORLD, credentials: CREDENTIALS, bindings: {}, commandId: "cmd_1", now: () => T0, fetchImpl: stub.fetchImpl });

  assert.equal(played.status, "skipped");
  assert.match(played.reason, /no webhook subscriber/);
  assert.match(played.reason, /HTTP targets serve GET only/);
  assert.deepEqual(stub.calls, [], "nothing was posted anywhere");
  db.close();
});

test("a webhook with a subscriber is posted to it", async () => {
  const db = fresh();
  const stub = providers();

  const played = await deliverArrival(db, {
    id: "pay", kind: "webhook", payload: { url: "http://app.test/hooks", event: "finance.invoice.paid" },
  }, { world: WORLD, credentials: CREDENTIALS, bindings: {}, commandId: "cmd_1", now: () => T0, fetchImpl: stub.fetchImpl });

  assert.equal(played.status, "delivered");
  assert.equal(stub.calls[0].url, "http://app.test/hooks");
  assert.equal(stub.calls[0].method, "POST");
  db.close();
});

test("an application event with no connector is skipped with the reason", async () => {
  const db = fresh();
  const played = await deliverArrival(db, {
    id: "task-done",
    kind: "application-event",
    payload: { kind: "task.completed", data: { task_id: "task-1" } },
  }, {
    world: WORLD, credentials: CREDENTIALS, bindings: {}, commandId: "cmd_1", now: () => T0,
    applicationConnector: () => null,
  });

  assert.equal(played.status, "skipped");
  assert.match(played.reason, /no application connector/);
  db.close();
});

test("an application event is delivered through the connected app", async () => {
  const db = fresh();
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/.well-known/worldfixture")) {
      return Response.json({
        api_version: "worldfixture.connector/v1",
        application: { id: "app", name: "Test app" },
        capabilities: { event: true },
        endpoints: { event: "/__worldfixture/events" },
      });
    }
    return Response.json({
      api_version: "worldfixture.connector-receipt/v1",
      status: "applied",
      request_id: "delivery-1",
    });
  };

  const played = await deliverArrival(db, {
    id: "task-done",
    kind: "application-event",
    payload: { kind: "task.completed", data: { task_id: "task-1" } },
  }, {
    world: WORLD, credentials: CREDENTIALS, bindings: {}, commandId: "cmd_1", now: () => T0, fetchImpl,
    applicationConnector: () => ({ baseUrl: "http://app.test", token: "secret" }),
  });

  assert.equal(played.status, "delivered");
  assert.equal(played.application_event, "task.completed");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, "http://app.test/__worldfixture/events");
  assert.equal(calls[1].options.headers.authorization, "Bearer secret");
  const body = JSON.parse(calls[1].options.body);
  assert.equal(body.event_id, "task-done");
  assert.equal(body.kind, "task.completed");
  assert.deepEqual(body.data, { task_id: "task-1" });
  const event = eventsAfter(db, 0, 10).find((entry) => entry.type === "application.event.delivered.v1");
  assert.equal(event.provider_evidence.arrival, "task-done");
  db.close();
});

test("a chat arrival for a channel the world does not have is skipped by name", async () => {
  const db = fresh();
  const played = await deliverArrival(db, {
    id: "x", kind: "chat-message", payload: { author_id: "maya-chen", channel_id: "channel-missing", text: "hi" },
  }, { world: WORLD, credentials: CREDENTIALS, bindings: { SLACK_BASE_URL: "http://slack.test" }, commandId: "cmd_1", now: () => T0 });

  assert.equal(played.status, "skipped");
  assert.match(played.reason, /no channel "channel-missing"/);
  db.close();
});

test("an arrival for a service this instance did not start is skipped, not failed", async () => {
  const db = fresh();
  for (const [kind, payload] of [
    ["chat-message", { author_id: "maya-chen", channel_id: "channel-release", text: "x" }],
    ["incoming-email", { from_id: "priya-raman", to_id: "maya-chen", subject: "s" }],
    ["github-comment", { owner: "o", repository: "r", issue_number: 1, body: "b" }],
    ["stripe-payment", { amount_cents: 100 }],
    ["s3-object", { bucket: "b", key: "k", body: "x" }],
  ]) {
    const played = await deliverArrival(db, { id: kind, kind, payload }, {
      world: WORLD, credentials: CREDENTIALS, bindings: {}, commandId: "cmd_1", now: () => T0,
    });
    assert.equal(played.status, "skipped", kind);
    assert.match(played.reason, /did not start/, kind);
  }
  db.close();
});

test("an unknown kind is skipped by name rather than passing unremarked", async () => {
  const db = fresh();
  const played = await deliverArrival(db, { id: "x", kind: "telepathy", payload: {} }, {
    world: WORLD, credentials: CREDENTIALS, bindings: {}, commandId: "cmd_1", now: () => T0,
  });
  assert.equal(played.status, "skipped");
  assert.match(played.reason, /cannot play a "telepathy" arrival yet/);
  assert.equal(Object.keys(KINDS).includes("telepathy"), false);
  db.close();
});

test("a provider that refuses is a failed arrival, recorded once and not retried", async () => {
  const db = fresh();
  armTimeline(db, WORLD);
  const stub = providers({ slackOk: false });

  const played = await playOne(db, pending(db)[0], {
    world: WORLD, credentials: CREDENTIALS, bindings: { SLACK_BASE_URL: "http://slack.test" }, rules: [], now: () => T0, fetchImpl: stub.fetchImpl,
  });

  assert.equal(played.status, "failed");

  // Marked delivered so the 250ms tick does not replay it for the rest of the
  // run, with the reason in the ledger where a reader can see it.
  assert.equal(pending(db).some((row) => row.id === "a-first"), false);
  const [event] = eventsAfter(db, 0, 10);
  assert.equal(event.type, "world.timeline.arrival.failed.v1");
  assert.match(event.provider_evidence.reason, /channel_not_found/);
  db.close();
});

// ---- the loop ------------------------------------------------------------

test("playDue plays everything due, in world order, and only once", async () => {
  const db = fresh();
  armTimeline(db, WORLD);
  const stub = providers();
  const sent = [];
  const context = {
    world: WORLD, credentials: CREDENTIALS,
    bindings: { SLACK_BASE_URL: "http://slack.test", SMTP_HOST_PORT: "127.0.0.1:2525" },
    rules: [],
    now: () => T0,
    fetchImpl: stub.fetchImpl,
    sendMail: async (_address, message) => sent.push(message),
  };

  assert.deepEqual(await playDue(db, context, { now: T0 }), []);

  advanceClock(db, 65_000, { now: T0 });
  const played = await playDue(db, context, { now: T0 });
  assert.deepEqual(played.map((entry) => entry.arrival), ["a-first", "b-second"]);

  // A second pass plays nothing again.
  assert.deepEqual(await playDue(db, context, { now: T0 }), []);
  assert.deepEqual(timelineState(db), { total: 3, delivered: 2, pending: 1, next_due_ms: 90_000 });
  db.close();
});

test("the loop ticks, suspends without stopping, and resumes", async () => {
  const db = fresh();
  armTimeline(db, WORLD);
  const stub = providers();
  const played = [];

  const scheduler = startScheduler(db, {
    world: WORLD, credentials: CREDENTIALS,
    bindings: { SLACK_BASE_URL: "http://slack.test", SMTP_HOST_PORT: "127.0.0.1:2525" },
    rules: [],
    now: () => T0,
    fetchImpl: stub.fetchImpl,
    sendMail: async () => {},
  }, { tickMs: 5, now: () => T0, onPlayed: (entries) => played.push(...entries) });

  advanceClock(db, 25_000, { now: T0 });
  await scheduler.tick();
  assert.deepEqual(played.map((entry) => entry.arrival), ["a-first"]);

  // Suspend is what reset uses. The scheduler must go quiet and stay alive.
  await scheduler.suspend();
  assert.equal(scheduler.suspended, true);
  advanceClock(db, 100_000, { now: T0 });
  await scheduler.tick();
  assert.equal(played.length, 1, "a suspended scheduler played an arrival");

  scheduler.resume();
  await scheduler.tick();
  assert.deepEqual(played.map((entry) => entry.arrival), ["a-first", "b-second", "c-mail"]);

  await scheduler.stop();
  await scheduler.tick();
  assert.equal(played.length, 3, "a stopped scheduler played an arrival");
  db.close();
});

test("reset clears the schedule so the world can play its timeline again", async () => {
  const db = fresh();
  armTimeline(db, WORLD);
  const stub = providers();
  const context = {
    world: WORLD, credentials: CREDENTIALS,
    bindings: { SLACK_BASE_URL: "http://slack.test", SMTP_HOST_PORT: "127.0.0.1:2525" },
    rules: [], now: () => T0, fetchImpl: stub.fetchImpl, sendMail: async () => {},
  };

  advanceClock(db, 95_000, { now: T0 });
  assert.equal((await playDue(db, context, { now: T0 })).length, 3);
  assert.equal(timelineState(db).pending, 0);

  // What `worldfixture reset` does, then what the runtime does after it.
  resetState(db);
  assert.deepEqual(timelineState(db), { total: 0, delivered: 0, pending: 0, next_due_ms: null });

  startClock(db, { anchor: WORLD.clock.anchor, now: T0 });
  armTimeline(db, WORLD);

  // The accepted start of this world includes three things that have not
  // happened yet. A reset that left them spent would not be that start.
  assert.deepEqual(timelineState(db), { total: 3, delivered: 0, pending: 3, next_due_ms: 20_000 });
  assert.deepEqual(await playDue(db, context, { now: T0 }), []);
  db.close();
});
