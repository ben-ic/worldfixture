import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "@emulators/core";
import { VENDORS } from "../registry.mjs";

async function fixture(config = { calendars: [], calendar_events: [] }) {
  const loaded = await VENDORS.google.load();
  const server = createServer(loaded.plugin, { tokens: {
    owner: { login: "owner@example.test", id: 1 }, other: { login: "other@example.test", id: 2 },
  } });
  const input = { users: [{ email: "owner@example.test" }, { email: "other@example.test" }], ...config };
  const seed = () => loaded.seedFromConfig(server.store, server.baseUrl, input);
  seed();
  async function read(path = "/calendar/v3/users/me/calendarList", { token = "owner", method = "GET", body } = {}) {
    const response = await server.app.request(path, { method, headers: {
      authorization: `Bearer ${token}`, "content-type": "application/json",
    }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  return { ...server, read, seed };
}

test("declared empty calendars stay empty across list/event/freeBusy calls and normal restore/reset", async () => {
  const server = await fixture();
  const baseline = server.store.snapshot();
  for (let pass = 0; pass < 2; pass++) {
    assert.deepEqual(await server.read(), { status: 200, body: { kind: "calendar#calendarList", items: [] } });
    assert.equal((await server.read("/calendar/v3/calendars/primary/events")).status, 404);
    assert.equal((await server.read("/calendar/v3/calendars/primary/events", { method: "POST", body: {
      summary: "Must not create a calendar", start: { date: "2026-09-06" }, end: { date: "2026-09-07" },
    } })).status, 404);
    const busy = await server.read("/calendar/v3/freeBusy", { method: "POST", body: {
      timeMin: "2026-09-06T00:00:00Z", timeMax: "2026-09-07T00:00:00Z", items: [{ id: "primary" }],
    } });
    assert.equal(busy.status, 200);
    assert.deepEqual(busy.body.calendars.primary, { errors: [{ domain: "global", reason: "notFound" }] });
    assert.deepEqual((await server.read()).body.items, []);
    assert.deepEqual(server.store.snapshot(), baseline, "Read and refused-write calls must not create provider records");
    server.store.restore(baseline);
  }
  server.store.reset();
  server.seed();
  assert.deepEqual((await server.read()).body.items, []);
});

test("calendar empty guard keeps authentication and owner checks", async () => {
  const { read } = await fixture();
  assert.equal((await read(undefined, { token: "invalid" })).status, 401);
  assert.equal((await read("/calendar/v3/calendars/primary/events", { token: "invalid" })).status, 401);
  assert.equal((await read("/calendar/v3/users/other@example.test/calendarList")).status, 404);
});

test("declared calendars and current event writes retain native records while other owners stay empty", async () => {
  const { read } = await fixture({ calendars: [{ id: "calendar-authored", user_email: "owner@example.test", summary: "Authored", primary: true }], calendar_events: [] });
  assert.deepEqual((await read()).body.items.map(row => row.id), ["calendar-authored"]);
  assert.deepEqual((await read(undefined, { token: "other" })).body.items, []);
  const created = await read("/calendar/v3/calendars/calendar-authored/events", { method: "POST", body: {
    summary: "Current event", start: { date: "2026-09-06" }, end: { date: "2026-09-07" },
  } });
  assert.equal(created.status, 200);
  assert.equal((await read("/calendar/v3/calendars/calendar-authored/events")).body.items[0].id, created.body.id);
});

test("legacy Google configuration without a calendar declaration retains native primary fallback", async () => {
  const { read } = await fixture({});
  assert.deepEqual((await read()).body.items.map(row => row.id), ["primary"]);
});
