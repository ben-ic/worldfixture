import test from "node:test";
import assert from "node:assert/strict";
import { removeInjectedMicrosoftDefault } from "./microsoft-users.mjs";

function storeWith(users) {
  const records = new Map(users.map((user) => [user.id, user]));
  return {
    collection(name) {
      if (name !== "microsoft.users") return {};
      return {
        findOneBy(field, value) {
          return [...records.values()].find((user) => user[field] === value);
        },
        delete(id) {
          records.delete(id);
        },
        all() {
          return [...records.values()];
        },
      };
    },
    records,
  };
}

// This is a small seam test. The package's getMicrosoftStore only needs the
// store.collection contract, so the test does not boot a server.
test("declared Microsoft users remove the upstream chooser default", () => {
  const store = storeWith([
    { id: 1, email: "testuser@outlook.com" },
    { id: 2, email: "maya@northstar-relay.worldfixture.test" },
  ]);

  removeInjectedMicrosoftDefault(store, {
    users: [{ email: "maya@northstar-relay.worldfixture.test" }],
  });

  assert.deepEqual(store.records.size, 1);
  assert.equal([...store.records.values()][0].email, "maya@northstar-relay.worldfixture.test");
});

test("no declared users preserve the upstream default", () => {
  const store = storeWith([{ id: 1, email: "testuser@outlook.com" }]);

  removeInjectedMicrosoftDefault(store, {});

  assert.equal(store.records.size, 1);
});
