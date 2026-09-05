// Reading a world artifact: who a reference names.
//
// These run against the shipped v3 artifact rather than a fixture, because the
// defect they guard against is a property of the real cast -- 161 people, four
// of whose ids share a first segment. A hand-written world would have to be
// made to contain the collision, which proves nothing about the one that ships.

import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { findPeople, findPerson, personHandle, readWorld } from "./world.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const world = readWorld(join(ROOT, "dist/business.saas-company.v3"));

// The bug this closes: `findPerson` matched `person.id.split("-")[0]` in the
// same `.find` as the id, login, name and email, so a first segment that two
// people share resolved to whichever came earlier in `world.people`. Measured
// on this artifact: maya, ravi, idris and lena each name two people, so
// `slack send --as maya` sent as maya-chen and never said maya-osei existed.
test("a first segment two people share is reported as several, not resolved to one", () => {
  const collisions = {
    maya: ["maya-chen", "maya-osei"],
    ravi: ["ravi-kapoor", "ravi-sundaram"],
    idris: ["idris-coulibaly", "idris-salim"],
    lena: ["lena-fischer", "lena-brandt"],
  };

  for (const [segment, ids] of Object.entries(collisions)) {
    const found = findPeople(world, segment).map((person) => person.id);
    assert.deepEqual(found.sort(), [...ids].sort(), `${segment} did not name both people`);
  }
});

test("an id, a login, a name and an email each still name exactly one person", () => {
  const person = world.people.find((entry) => entry.id === "maya-chen");
  for (const reference of [person.id, person.github_login, person.name, person.email]) {
    if (!reference) continue;
    const found = findPeople(world, reference);
    assert.equal(found.length, 1, `${reference} named ${found.length} people`);
    assert.equal(found[0].id, "maya-chen");
  }
});

// An exact id has to beat a first segment. `maya-chen` is not a first segment
// of anything, but this is the ordering that keeps a future id like `maya`
// itself from being drowned by the people whose ids begin with it.
test("an exact match wins over a first-segment match", () => {
  assert.equal(findPerson(world, "maya-osei").id, "maya-osei");
  // The reference is lowercased before anything is compared, so the case a
  // person types does not decide who they act as.
  assert.equal(findPerson(world, "MAYA-OSEI").id, "maya-osei");
  assert.equal(findPeople(world, "maya-osei").length, 1);
});

// The bug this closes: `up` prints `slack send --as <handle>` for the reader to
// paste and the handle was always the bare first segment, so on this world the
// first screen offered a command that the very next step refuses as ambiguous.
test("the suggested handle is the shortest one that still names one person", () => {
  const unique = world.people.find((person) => person.id === "priya-raman") ?? world.people.find(
    (person) => findPeople(world, person.id.split("-")[0]).length === 1,
  );
  assert.equal(personHandle(world, unique), unique.id.split("-")[0]);

  for (const id of ["maya-chen", "maya-osei", "ravi-kapoor", "idris-salim", "lena-brandt"]) {
    const person = world.people.find((entry) => entry.id === id);
    assert.equal(personHandle(world, person), id, `${id} was offered under a shared first segment`);
    assert.equal(findPeople(world, personHandle(world, person)).length, 1);
  }
});
