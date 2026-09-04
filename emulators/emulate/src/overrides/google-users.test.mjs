import assert from "node:assert/strict";
import test from "node:test";
import { Store } from "@emulators/core";
import { getGoogleStore, googlePlugin, seedFromConfig } from "@emulators/google";

import { removeInjectedGoogleDefault } from "./google-users.mjs";

function storeWith(users) {
  const records = new Map(users.map((user) => [user.id, user]));
  return {
    collection(name) {
      if (name !== "google.users") return {};
      return {
        findOneBy(field, value) {
          return [...records.values()].find((user) => user[field] === value);
        },
        delete(id) {
          return records.delete(id);
        },
      };
    },
    records,
  };
}

test("declared Google users remove the upstream chooser default", () => {
  const store = storeWith([
    { id: "default", email: "testuser@gmail.com" },
    { id: "maya", email: "maya@northstar-relay.worldfixture.test" },
  ]);

  removeInjectedGoogleDefault(store, { users: [{ email: "maya@northstar-relay.worldfixture.test" }] });

  assert.deepEqual([...store.records.values()], [{ id: "maya", email: "maya@northstar-relay.worldfixture.test" }]);
});

test("an undeclared Google user list retains the upstream default", () => {
  const store = storeWith([{ id: "default", email: "testuser@gmail.com" }]);

  removeInjectedGoogleDefault(store, {});

  assert.equal(store.records.size, 1);
});

test("the upstream Google plugin shows only a declared user after removal", () => {
  const store = new Store();
  googlePlugin.seed(store, "http://google.test");
  seedFromConfig(store, "http://google.test", {
    users: [{ email: "maya@northstar-relay.worldfixture.test", name: "Maya Chen" }],
  });

  removeInjectedGoogleDefault(store, { users: [{ email: "maya@northstar-relay.worldfixture.test" }] });

  assert.deepEqual(getGoogleStore(store).users.all().map((user) => user.email), [
    "maya@northstar-relay.worldfixture.test",
  ]);
});
