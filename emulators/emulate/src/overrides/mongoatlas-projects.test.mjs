import assert from "node:assert/strict";
import test from "node:test";
import { Store } from "@emulators/core";
import { getMongoAtlasStore, mongoatlasPlugin, seedFromConfig } from "@emulators/mongoatlas";

import { removeInjectedAtlasDefault } from "./mongoatlas-projects.mjs";

const WORLD_PROJECTS = [{ name: "Northstar Relay", org_id: "northstar-relay" }];

function seeded() {
  const store = new Store();
  mongoatlasPlugin.seed?.(store, "http://atlas.test");
  seedFromConfig(store, "http://atlas.test", { projects: WORLD_PROJECTS });
  return store;
}

const names = (store) => getMongoAtlasStore(store).projects.all().map((project) => project.name).sort();

test("the upstream plugin injects a project the world never declared", () => {
  assert.ok(names(seeded()).includes("Project0"));
});

test("declared projects remove the upstream default", () => {
  const store = seeded();
  const { removed } = removeInjectedAtlasDefault(store, { projects: WORLD_PROJECTS });

  assert.equal(removed, 1);
  assert.deepEqual(names(store), ["Northstar Relay"]);
});

test("a fixture declaring no projects keeps the upstream default", () => {
  const store = seeded();
  assert.deepEqual(removeInjectedAtlasDefault(store, {}), { removed: 0 });
  assert.ok(names(store).includes("Project0"));
});
