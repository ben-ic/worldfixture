import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { readConnectorWorld } from "./connector.mjs";
import {
  DEFAULT_SCALE,
  SCALE_PRESETS,
  ScaleError,
  describeScale,
  isFullScale,
  parseLimits,
  parseScale,
  scaleWorld,
} from "./scale.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const ARTIFACT = join(ROOT, "dist/business.saas-company.v3");

// A world small enough to reason about, carrying every shape the slicer has to
// handle: a dependency (`organization_id`), a membership list (`member_ids`), a
// list that is not a reference at all (`labels`), a nested list (`messages`),
// and a collection reachable only through a record the caps would drop.
function fixture() {
  return {
    world: { id: "test.world", version: "v1", artifact_sha256: "abc" },
    packs: {
      identity: {
        organizations: [
          { id: "acme", name: "Acme", slug: "acme" },
          { id: "outside", name: "Outside", slug: "outside" },
        ],
        people: [
          { id: "ann", name: "Ann", email: "ann@acme.test", organization_id: "acme" },
          { id: "bo", name: "Bo", email: "bo@acme.test", organization_id: "acme" },
          { id: "cy", name: "Cy", email: "cy@acme.test", organization_id: "acme" },
          { id: "dee", name: "Dee", email: "dee@outside.test", organization_id: "outside" },
        ],
      },
      work: {
        projects: [
          { id: "p1", name: "One", owner_id: "ann", member_ids: ["ann", "bo", "cy"], labels: ["red"] },
          { id: "p2", name: "Two", owner_id: "cy", member_ids: ["cy"], labels: ["blue"] },
        ],
        tasks: [
          { id: "t1", title: "A", project_id: "p1", assignee_id: "ann" },
          { id: "t2", title: "B", project_id: "p1", assignee_id: "bo" },
          { id: "t3", title: "C", project_id: "p2", assignee_id: "cy" },
        ],
      },
      communication: {
        channels: [
          {
            id: "c1",
            name: "general",
            member_ids: ["ann", "bo"],
            messages: [
              { id: "m1", author_id: "ann", text: "one" },
              { id: "m2", author_id: "bo", text: "two" },
              { id: "m3", author_id: "ann", text: "three" },
            ],
          },
        ],
      },
      support: {
        // Reachable only through dee, who is the last person in the artifact.
        cases: [{ id: "case1", title: "Outside asks", contact_id: "dee", owner_id: "ann" }],
      },
    },
  };
}

// Every identifier a sliced record refers to must also be in the slice.
//
// The default world already refers to things it does not contain: `customer_id`
// on an invoice is a short account key -- `lumen` for `lumen-labs` -- and no
// record answers to it. That is a fact about the artifact, not about slicing, so
// the real assertion is a comparison: a slice must not dangle anything the whole
// artifact did not already dangle.
function danglingReferences(packs) {
  const present = new Set();
  const records = [];
  const walk = (value) => {
    if (Array.isArray(value)) {
      for (const entry of value) if (entry && typeof entry === "object") { records.push(entry); walk(Object.values(entry)); }
      return;
    }
    if (value && typeof value === "object") walk(Object.values(value));
  };
  for (const pack of Object.values(packs)) walk(Object.values(pack));
  for (const record of records) {
    for (const field of ["id", "email", "github_login", "slack_id", "slug"]) {
      if (typeof record[field] === "string") present.add(record[field]);
    }
  }
  const dangling = [];
  for (const record of records) {
    for (const [field, value] of Object.entries(record)) {
      if (!field.endsWith("_id") && !field.endsWith("_ids")) continue;
      for (const entry of Array.isArray(value) ? value : [value]) {
        if (typeof entry !== "string") continue;
        if (entry === record.id) continue;
        if (!present.has(entry)) dangling.push(`${record.id}.${field} -> ${entry}`);
      }
    }
  }
  return dangling;
}


test("scale names and limits are read, and bad ones are refused by name", () => {
  assert.equal(parseScale(undefined), DEFAULT_SCALE);
  assert.equal(parseScale("SMOKE"), "smoke");
  assert.deepEqual(parseLimits("people=25,communication.mail=200"), {
    people: 25,
    "communication.mail": 200,
  });
  assert.deepEqual(parseLimits(""), {});
  assert.throws(() => parseScale("tiny"), (error) => error instanceof ScaleError && /smoke, sample, full/.test(error.message));
  assert.throws(() => parseLimits("people"), ScaleError);
  assert.throws(() => parseLimits("people=lots"), ScaleError);
});

test("a limit naming a collection this world does not have is refused, not ignored", () => {
  assert.throws(
    () => scaleWorld(fixture(), { limits: { widgets: 5 } }),
    (error) => error instanceof ScaleError && /widgets/.test(error.message),
  );
});

test("full scale sends the artifact through unchanged", () => {
  const source = fixture();
  const sliced = scaleWorld(source, { scale: "full" });
  assert.equal(isFullScale({ scale: "full" }), true);
  assert.equal(sliced.scale.full, true);
  assert.deepEqual(sliced.packs, source.packs);
  assert.deepEqual(describeScale(sliced.scale), []);
});

test("a limit takes the first records and keeps the slice referentially whole", () => {
  const sliced = scaleWorld(fixture(), { limits: { people: 2 } });
  assert.deepEqual(danglingReferences(sliced.packs), []);
  // Exactly the first two people, in artifact order. `dee` would rescue the only
  // support case in the world, and a number the caller typed is not overspent to
  // do it -- see the hard-cap case below.
  assert.deepEqual(sliced.packs.identity.people.map((person) => person.id), ["ann", "bo"]);
  // t3 is assigned to cy, who is gone, so it cannot be kept.
  assert.deepEqual(sliced.packs.work.tasks.map((task) => task.id), ["t1", "t2"]);
});

test("a membership list is trimmed to the people who are there, and a label list is left alone", () => {
  const sliced = scaleWorld(fixture(), { limits: { people: 2 } });
  const project = sliced.packs.work.projects.find((entry) => entry.id === "p1");
  assert.deepEqual(project.member_ids, ["ann", "bo"]);
  assert.deepEqual(project.labels, ["red"]);
});

test("a record whose whole membership list is gone is dropped rather than emptied", () => {
  const sliced = scaleWorld(fixture(), { limits: { people: 1 } });
  assert.equal(sliced.packs.work.projects.some((entry) => entry.id === "p2"), false);
  assert.deepEqual(danglingReferences(sliced.packs), []);
});

test("a nested list is capped per parent, not across the world", () => {
  const sliced = scaleWorld(fixture(), { limits: { messages: 2 } });
  assert.equal(sliced.packs.communication.channels[0].messages.length, 2);
});

test("a preset never empties a collection the world has records in", () => {
  // `case1` belongs to `dee`, the last person in the artifact, so a cap alone
  // starves support to nothing. A preset cap is this code's opinion about a
  // reasonable size, so it may be overspent to keep the collection alive.
  const sliced = scaleWorld(fixture(), { scale: "smoke" });
  for (const entry of sliced.scale.collections) {
    if (entry.total > 0) assert.ok(entry.kept > 0, `smoke emptied ${entry.collection}`);
  }
  assert.deepEqual(danglingReferences(sliced.packs), []);
});

// The bug this closes: the rescue above did not tell a preset cap from a number
// the caller typed, so `--limit people=0` sent sixteen people -- their names,
// emails, Slack ids and GitHub logins -- to somebody's application after they
// had asked for none. `--limit people=5` sent sixteen as well.
test("a limit the caller typed is never exceeded, even to rescue a collection", () => {
  for (const people of [0, 1, 2]) {
    const sliced = scaleWorld(fixture(), { limits: { people } });
    assert.equal(sliced.packs.identity.people.length, people, `--limit people=${people}`);
    assert.deepEqual(danglingReferences(sliced.packs), []);
  }

  // The collection it could not rescue stays empty, and is reported as empty
  // rather than quietly filled.
  const capped = scaleWorld(fixture(), { limits: { people: 1 } });
  const cases = capped.scale.collections.find((entry) => entry.collection === "cases");
  assert.equal(cases.kept, 0);
  assert.equal(cases.total, 1);
});

test("the same artifact and the same request produce the same slice", () => {
  const first = scaleWorld(fixture(), { scale: "smoke" });
  const second = scaleWorld(fixture(), { scale: "smoke" });
  assert.equal(JSON.stringify(first.packs), JSON.stringify(second.packs));
});

test("slicing does not change the artifact it was given", () => {
  const source = fixture();
  const before = JSON.stringify(source.packs);
  scaleWorld(source, { scale: "smoke", limits: { people: 1 } });
  assert.equal(JSON.stringify(source.packs), before);
});

test("the account of a slice is counted from the slice", () => {
  const sliced = scaleWorld(fixture(), { limits: { people: 2 } });
  const people = sliced.scale.collections.find((entry) => entry.collection === "people");
  assert.deepEqual(people, { collection: "people", total: 4, kept: 2, limit: 2 });
  assert.equal(describeScale(sliced.scale).includes("people 2 of 4"), true);

  const tasks = scaleWorld(fixture(), { limits: { tasks: 1 } }).scale.collections
    .find((entry) => entry.collection === "tasks");
  assert.deepEqual(tasks, { collection: "tasks", total: 3, kept: 1, limit: 1 });
});

// The real artifact is the only place the slicer meets a world at full size.
// It is built by `npm run build:worlds`, and a checkout that has not built it
// yet should not fail this file.
test("every preset takes a whole, smaller slice of the default world", { skip: !existsSync(ARTIFACT) }, () => {
  const source = readConnectorWorld(ARTIFACT);
  const full = JSON.stringify(source.packs).length;
  let previous = 0;

  for (const preset of ["smoke", "sample"]) {
    const sliced = scaleWorld(source, { scale: preset });
    const size = JSON.stringify(sliced.packs).length;

    const already = new Set(danglingReferences(source.packs).map((entry) => entry.split(" -> ").at(-1)));
    const introduced = danglingReferences(sliced.packs).filter(
      (entry) => !already.has(entry.split(" -> ").at(-1)),
    );
    assert.deepEqual(introduced, [], `${preset} left a dangling reference`);
    assert.ok(size < full, `${preset} did not make the world smaller`);
    assert.ok(size > previous, `${preset} is not larger than the preset below it`);
    previous = size;

    for (const entry of sliced.scale.collections) {
      assert.ok(entry.kept <= entry.total, `${preset} invented ${entry.collection}`);
      if (entry.total > 0) assert.ok(entry.kept > 0, `${preset} emptied ${entry.collection}`);
    }
  }

  assert.equal(SCALE_PRESETS.smoke.cap, 25);
});
