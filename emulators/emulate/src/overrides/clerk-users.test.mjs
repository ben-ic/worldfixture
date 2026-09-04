import assert from "node:assert/strict";
import test from "node:test";
import { Store } from "@emulators/core";
import { clerkPlugin, getClerkStore, seedFromConfig } from "@emulators/clerk";

import { removeInjectedClerkDefault } from "./clerk-users.mjs";

const WORLD_USERS = [
  { email_addresses: ["maya@northstar-relay.worldfixture.test"], first_name: "Maya", last_name: "Chen" },
  { email_addresses: ["jon@northstar-relay.worldfixture.test"], first_name: "Jon", last_name: "Bell" },
];

function seeded() {
  const store = new Store();
  clerkPlugin.seed?.(store, "http://clerk.test");
  seedFromConfig(store, "http://clerk.test", { users: WORLD_USERS });
  return store;
}

function emails(store) {
  return getClerkStore(store).emailAddresses.all().map((row) => row.email_address).sort();
}

test("the upstream plugin injects an account the world never declared", () => {
  // The reason this override exists. If upstream stops doing it, this fails and
  // the override can go.
  assert.ok(emails(seeded()).includes("test@example.com"));
});

test("declared Clerk users remove the upstream default", () => {
  const store = seeded();
  const before = getClerkStore(store).users.all().length;

  const { removed } = removeInjectedClerkDefault(store, { users: WORLD_USERS });

  assert.equal(removed, 1);
  assert.deepEqual(emails(store), [
    "jon@northstar-relay.worldfixture.test",
    "maya@northstar-relay.worldfixture.test",
  ]);
  assert.equal(getClerkStore(store).users.all().length, before - 1);
});

test("the default user goes with its address, not just the address", () => {
  // Deleting the email row alone would leave a nameless user an application can
  // still enumerate.
  const store = seeded();
  removeInjectedClerkDefault(store, { users: WORLD_USERS });

  const names = getClerkStore(store).users.all().map((user) => `${user.first_name} ${user.last_name}`);
  assert.ok(!names.includes("Test User"), names.join(", "));
});

test("a fixture declaring no Clerk users keeps the upstream default", () => {
  const store = seeded();
  assert.deepEqual(removeInjectedClerkDefault(store, {}), { removed: 0 });
  assert.ok(emails(store).includes("test@example.com"));
});
