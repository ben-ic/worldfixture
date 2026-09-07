import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "@emulators/core";
import { VENDORS } from "./registry.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const project = `
import json, sys
from pathlib import Path
from worldfixture_compiler import load_world
from worldfixture_compiler.compiler import compile_world
world = load_world(Path(sys.argv[1]))[0]
compiled = compile_world(world)
print(json.dumps({
    "seed": compiled["projections"]["emulator-overlay"]["google"],
    "calendars": world["communication"]["calendars"],
    "events": world["communication"]["calendar_events"],
}))
`;

// Exercise the pinned upstream provider with actual compiler output. A route
// mock would miss the original summary.localeCompare failure in calendarList.
for (const world of ["business.saas-company.v2", "business.saas-company.v3", "consumer.retail-brand.v1"]) {
  test(`${world}: compiled calendars and events survive upstream public reads`, async () => {
    const fixture = JSON.parse(execFileSync(process.env.PYTHON ?? "python3", ["-c", project, join(root, "worlds", world, "world.json")], {
      env: { ...process.env, PYTHONPATH: join(root, "compiler") },
      maxBuffer: 8 * 1024 * 1024,
    }));
    // This test seeds raw compiler output without the runtime credential
    // resolver. OAuth clients need generated run secrets, but calendar reads do
    // not need an OAuth client declaration.
    delete fixture.seed.oauth_clients;
    const email = fixture.seed.users[0].email;
    const { plugin, seedFromConfig } = await VENDORS.google.load();
    const { app, store } = createServer(plugin, {
      baseUrl: "http://calendar.test",
      tokens: { "calendar-projection-test": { login: email, id: 1 } },
    });
    seedFromConfig(store, "http://calendar.test", fixture.seed);
    async function read(path) {
      const response = await app.fetch(new Request(`http://calendar.test${path}`, {
        headers: { authorization: "Bearer calendar-projection-test" },
      }));
      assert.equal(response.status, 200, `${path} must succeed`);
      return response.json();
    }
    const calendars = await read("/calendar/v3/users/me/calendarList");
    assert.equal(calendars.kind, "calendar#calendarList");
    assert.ok(calendars.items.every(item => typeof item.summary === "string"));
    for (const authored of fixture.calendars) {
      const actual = calendars.items.find(item => item.id === authored.id);
      assert.ok(actual, `Calendar ${authored.id} is visible`);
      assert.equal(actual.summary, authored.name);
      const events = await read(`/calendar/v3/calendars/${encodeURIComponent(authored.id)}/events`);
      for (const expected of fixture.events.filter(item => item.calendar_id === authored.id)) {
        const event = events.items.find(item => item.id === expected.id);
        assert.ok(event, `Event ${expected.id} is visible in its authored calendar`);
        assert.equal(event.summary, expected.summary);
        assert.equal(event.start.dateTime, expected.start);
        assert.equal(event.end.dateTime, expected.end);
        assert.deepEqual(event.attendees.map(item => item.email), expected.attendees);
      }
    }
  });
}
