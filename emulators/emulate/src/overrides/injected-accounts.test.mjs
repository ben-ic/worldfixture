import assert from "node:assert/strict";
import test from "node:test";
import { Store } from "@emulators/core";

import { VENDORS } from "../registry.mjs";
import { INJECTED_ACCOUNT_VENDORS, removeInjectedAccounts } from "./injected-accounts.mjs";

// One declared person per vendor, in that vendor's own seed shape, taken from a
// compiled world's `projections/emulator-overlay.json` rather than invented.
const WORLD = {
  apple: { users: [{ email: "maya@northstar-relay.worldfixture.test", name: "Maya Chen", given_name: "Maya", family_name: "Chen" }] },
  github: { users: [{ login: "mayachen", name: "Maya Chen", email: "maya@northstar-relay.worldfixture.test" }] },
  linear: {
    users: [{ email: "maya@northstar-relay.worldfixture.test", name: "Maya Chen", admin: true }],
    teams: [{ key: "NSTAR", name: "Northstar" }],
  },
  okta: { users: [{ login: "maya@northstar-relay.worldfixture.test", email: "maya@northstar-relay.worldfixture.test", first_name: "Maya", last_name: "Chen" }] },
  slack: {
    users: [{ name: "mayachen", real_name: "Maya Chen", email: "maya@northstar-relay.worldfixture.test" }],
    channels: [{ name: "general", topic: "Company updates and questions for everyone", members: ["mayachen"] }],
  },
  vercel: {
    users: [{ username: "mayachen", email: "maya@northstar-relay.worldfixture.test", name: "Maya Chen" }],
    teams: [{ slug: "northstar-relay", name: "Northstar Relay" }],
  },
};

// The injected account each vendor's own `plugin.seed()` inserts, by the field an
// application would see it through.
const INJECTED = {
  apple: ["email", "testuser@icloud.com"],
  github: ["login", "admin"],
  linear: ["email", "admin@linear.local"],
  okta: ["login", "testuser@okta.local"],
  slack: ["user_id", "U000000001"],
  vercel: ["username", "admin"],
};

async function seeded(vendor, config) {
  const loaded = await VENDORS[vendor].load();
  const store = new Store();
  const baseUrl = `http://${vendor}.test`;
  loaded.plugin.seed?.(store, baseUrl);
  const swept = config ? removeInjectedAccounts(vendor, store, config) : { removed: 0, cascaded: 0 };
  if (config) loaded.seedFromConfig(store, baseUrl, config);
  return { store, swept };
}

const rows = (store, name) => store.collection(name).all();
const has = (store, vendor) => {
  const [field, value] = INJECTED[vendor];
  return rows(store, `${vendor}.users`).some((row) => row[field] === value);
};

test("the table covers exactly the vendors this override claims", () => {
  assert.deepEqual(INJECTED_ACCOUNT_VENDORS.sort(), ["apple", "github", "linear", "okta", "slack", "vercel"]);
});

// The reason this override exists. If upstream stops injecting these, this fails
// and the entry can go -- the same guard `clerk-users.test.mjs` keeps.
for (const vendor of Object.keys(INJECTED)) {
  test(`the upstream ${vendor} plugin injects an account the world never declared`, async () => {
    const { store } = await seeded(vendor, null);
    assert.ok(has(store, vendor), `${vendor} no longer injects ${INJECTED[vendor][1]}`);
  });

  // Closes: apple, github, linear, okta, slack and vercel each served an
  // `admin`/`testuser` account in a world that declares its own people. Measured
  // on a running composer: Apple offered "Test User" as the FIRST account in the
  // sign-in chooser, GitHub's `/users` led with a `site_admin` called `admin`, and
  // Slack's `users.list` led with `admin@emulate.dev`.
  test(`declared ${vendor} users remove the injected account`, async () => {
    const { store, swept } = await seeded(vendor, WORLD[vendor]);
    assert.ok(swept.removed >= 1);
    assert.ok(!has(store, vendor));
    assert.ok(rows(store, `${vendor}.users`).length >= 1, "the world's own people are still there");
  });

  test(`a fixture declaring no ${vendor} users keeps the convenience account`, async () => {
    const { store, swept } = await seeded(vendor, {});
    assert.deepEqual(swept, { removed: 0, cascaded: 0 });
    assert.ok(has(store, vendor));
  });
}

// Closes: the removal used to be possible only AFTER `seedFromConfig`, and Vercel
// takes a team's `creatorId` from `users.all()[0]`. With the injected admin still
// present the world's team was created and OWNED by `admin@localhost`, and the
// world's own person was demoted to MEMBER. Measured against a running fixture on
// `/v2/teams/:id/members` before this was written.
test("a Vercel team is owned by the world's person, not by the injected admin", async () => {
  const { store } = await seeded("vercel", WORLD.vercel);
  const users = rows(store, "vercel.users");
  const team = rows(store, "vercel.teams")[0];
  const members = rows(store, "vercel.team_members");

  assert.equal(users.length, 1);
  assert.equal(team.creatorId, users[0].uid);
  assert.deepEqual(members.map((m) => [m.userId, m.role]), [[users[0].uid, "OWNER"]]);
});

// Closes: upstream's `seed()` inserts placeholder `#general` and `#random`
// channels owned by the injected admin, and a world that DECLARES `#general` had
// its own version skipped as already present. The channel served upstream's
// "General discussion" topic with one member instead of the world's topic with all
// of them, and every channel came back with `creator: "U000000001"`.
test("Slack channels are the world's, with a creator the world declared", async () => {
  const { store } = await seeded("slack", WORLD.slack);
  const live = new Set(rows(store, "slack.users").map((row) => row.user_id));
  const channels = rows(store, "slack.channels");
  const general = channels.find((row) => row.name === "general");

  assert.equal(channels.length, 1);
  assert.equal(general.topic.value, "Company updates and questions for everyone");
  assert.ok(live.has(general.creator), "channel creator is a user the world declared");
  assert.deepEqual(channels.filter((row) => !live.has(row.creator)), []);
});

// Closes: `lin_test_admin` is inserted into LINEAR'S OWN token collection by
// upstream's `seed()`, not into the composer's token map, so `seed-config.mjs`'s
// credential stripping never saw it. Measured: it answered `viewer` as
// `admin@linear.local` with `admin: true` and full write scopes.
test("removing the Linear account revokes the admin token that names it", async () => {
  const { store, swept } = await seeded("linear", WORLD.linear);

  assert.equal(swept.removed, 2);
  assert.deepEqual(rows(store, "linear.tokens").map((row) => row.token), []);

  // And the sample issue and comment that referenced only those two accounts.
  const live = new Set(rows(store, "linear.users").map((row) => row.linear_id));
  assert.ok(!rows(store, "linear.issues").some((row) => row.identifier === "ENG-1"));
  assert.deepEqual(rows(store, "linear.issues").filter((row) => !live.has(row.creator_id)), []);
  assert.deepEqual(rows(store, "linear.comments").filter((row) => !live.has(row.user_id)), []);
});

// Closes: Okta's `seed()` also puts its `testuser` in the built-in Everyone group,
// so deleting the account alone left a membership row naming nobody.
test("removing the Okta account takes its group membership with it", async () => {
  const { store, swept } = await seeded("okta", WORLD.okta);
  const live = new Set(rows(store, "okta.users").map((row) => row.okta_id));

  assert.equal(swept.cascaded, 1);
  assert.deepEqual(rows(store, "okta.group_memberships").filter((row) => !live.has(row.user_okta_id)), []);
});

// GitHub's `ghost` is not an invention: real GitHub has that account and
// attributes deleted users to it. Only `admin` goes.
test("GitHub keeps ghost and loses admin", async () => {
  const { store } = await seeded("github", WORLD.github);
  const logins = rows(store, "github.users").map((row) => row.login);
  assert.ok(logins.includes("ghost"));
  assert.ok(!logins.includes("admin"));
});

test("a vendor this override says nothing about is left alone", async () => {
  const store = new Store();
  assert.deepEqual(removeInjectedAccounts("resend", store, { users: [{ email: "a@b.test" }] }), { removed: 0, cascaded: 0 });
});
