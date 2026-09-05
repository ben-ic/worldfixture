// The rest of the injected-account sweep: apple, github, linear, okta, slack and vercel.
//
// `removeInjectedGoogleDefault`, `removeInjectedMicrosoftDefault`,
// `removeInjectedClerkDefault` and `removeInjectedAtlasDefault` each fix one
// vendor's copy of the same defect -- upstream's `plugin.seed()` inserts a
// convenience account, and an application that enumerates people is then handed
// a record the world never declared. Six more vendors do it, measured against a
// running composer on `dist/business.saas-company.v3`:
//
//   apple   `testuser@icloud.com` "Test User"   -- the FIRST account offered by the
//           Sign in with Apple chooser at `/auth/authorize`, above all 99 of the
//           world's people.
//   okta    `testuser@okta.local` "Test User"   -- the first row of `/api/v1/users`,
//           and a member of the built-in Everyone group.
//   vercel  `admin@localhost` "Admin"           -- the OWNER of the world's team in
//           `/v2/teams/:id/members`, with the world's own Maya Chen demoted to MEMBER.
//   github  `admin@localhost` "Admin"           -- `site_admin: true` in `/users`.
//   slack   `admin@emulate.dev` `U000000001`    -- the first member of `users.list`.
//   linear  `admin@linear.local` "Admin User" and `dev@linear.local` "Developer"
//           -- both in the `users` query.
//
// WHY THIS RUNS BEFORE `seedFromConfig` AND THE OTHER FOUR RUN AFTER. Removing the
// account afterwards is too late to matter for three of these six, because upstream's
// own seeding reads whatever user happens to be first:
//
//   * Vercel's `seedFromConfig` takes `creatorId` from `users.all()[0]`. With the
//     injected admin still present that is the injected admin, so the world's team
//     was created by a person the world does not have, and deleting them afterwards
//     left `creatorId` pointing at nothing. Removing first makes the world's own
//     first user the OWNER, which is what the projection describes.
//
//   * Slack attributes every channel to `users.all()[0]`. Measured: all 28 of this
//     world's channels came back from `conversations.list` with
//     `creator: "U000000001"`. Removing first gives 26 of them a real creator.
//
//   * Linear does the same for issues: 404 of 404 named `admin@linear.local`.
//     Removing first leaves only upstream's own sample issue.
//
// Slack's and Linear's remaining two are upstream rows that `seed()` created
// itself, which is the second half of why the call goes here. AT THIS POINT THE
// STORE CONTAINS NOTHING BUT UPSTREAM'S OWN DEMO CONTENT -- `seedFromConfig` has
// not run -- so a cascade that deletes rows referencing the removed account cannot
// reach a row the world declared. That is what makes deleting them safe to do at
// all, and it is why `cascade` below is a plain list of foreign keys rather than a
// careful argument about parentage.
//
// The Slack cascade is also a fix in its own right and not only tidying up.
// Upstream's `seed()` inserts placeholder `#general` and `#random` channels, and
// this world DECLARES both -- so `seedFromConfig` found them already present and
// skipped them. `#general` served upstream's "General discussion" topic with ONE
// member instead of the world's "Company updates and questions for everyone" with
// 99. Removing the placeholders lets the world's own channels be built.
//
// What is deliberately NOT removed here, because none of it is an account and none
// of it dangles once the account is gone: Slack's `#general`/`#random` are rebuilt
// from the world rather than dropped; Linear keeps its `ENG` team, `Local Project`,
// `Cycle 1` and `Bug`/`Feature` labels; Okta keeps its Everyone group and sample
// app. Each is upstream demo content a world does not declare, and each is a
// separate decision.

// A vendor's users, and everything upstream's `seed()` hung off them.
//
// `key` is the identifier the vendor's other rows use to point at a user, which is
// never the collection's own numeric `id`. Getting that wrong is what
// `clerk-users.mjs` documents: deleting by the wrong identifier removes nothing and
// says it succeeded.
const INJECTED_ACCOUNTS = {
  apple: {
    key: "uid",
    match: (row) => row.email === "testuser@icloud.com",
    cascade: [],
  },

  github: {
    key: "login",
    // NOT `ghost`, which upstream also inserts. Real GitHub has a `ghost` account
    // and its API attributes deleted users to it, so a fixture that serves it is
    // reproducing GitHub rather than inventing a person. `admin` is the invention:
    // `site_admin: true`, `admin@localhost`, bio "Default admin user".
    match: (row) => row.login === "admin" && row.email === "admin@localhost",
    cascade: [],
  },

  linear: {
    key: "linear_id",
    match: (row) => row.email === "admin@linear.local" || row.email === "dev@linear.local",
    cascade: [
      // `lin_test_admin` is the reason this one matters most. Upstream's `seed()`
      // inserts it into LINEAR'S OWN token collection, not the composer's token
      // map, so it authenticated with `read, write, issues:create, comments:create,
      // admin` in every compiled world. Measured against the running fixture:
      //
      //   curl -H "Authorization: Bearer lin_test_admin" … -d '{"query":"{ viewer { email admin } }"}'
      //   {"data":{"viewer":{"name":"Admin User","email":"admin@linear.local","admin":true}}}
      //
      // `seed-config.mjs` already strips the sample seed's credentials and says it
      // covers "EVERY vendor". It cannot cover this one: it never came from the
      // seed. Leaving the token behind while removing the account it names would be
      // worse than either, so it goes with the account.
      ["linear.tokens", ["user_id"]],
      ["linear.comments", ["user_id"]],
      ["linear.issues", ["creator_id", "assignee_id"]],
    ],
  },

  okta: {
    key: "okta_id",
    match: (row) => row.login === "testuser@okta.local",
    cascade: [["okta.group_memberships", ["user_okta_id"]]],
  },

  slack: {
    key: "user_id",
    match: (row) => row.user_id === "U000000001" && row.email === "admin@emulate.dev",
    cascade: [["slack.channels", ["creator"]]],
  },

  vercel: {
    key: "uid",
    match: (row) => row.username === "admin" && row.email === "admin@localhost",
    cascade: [],
  },
};

export const INJECTED_ACCOUNT_VENDORS = Object.keys(INJECTED_ACCOUNTS);

// Called between `plugin.seed()` and `seedFromConfig` for every vendor. A vendor
// with no entry, or a fixture that declares no users of its own, is left alone:
// keeping the convenience account is the right answer for an unseeded emulator,
// which is the same rule the other four overrides apply.
export function removeInjectedAccounts(vendor, store, config) {
  const spec = INJECTED_ACCOUNTS[vendor];
  if (!spec) return { removed: 0, cascaded: 0 };
  if (!Array.isArray(config?.users) || config.users.length === 0) return { removed: 0, cascaded: 0 };

  const users = store.collection(`${vendor}.users`);
  const injected = users.all().filter(spec.match);
  if (injected.length === 0) return { removed: 0, cascaded: 0 };

  const keys = new Set(injected.map((row) => row[spec.key]));
  let cascaded = 0;

  for (const [name, fields] of spec.cascade) {
    const collection = store.collection(name);
    for (const row of collection.all().filter((row) => fields.some((field) => keys.has(row[field])))) {
      collection.delete(row.id);
      cascaded += 1;
    }
  }

  for (const row of injected) users.delete(row.id);

  return { removed: injected.length, cascaded };
}
