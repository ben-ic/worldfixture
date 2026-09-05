import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "@emulators/core";
import githubPlugin, { seedFromConfig, getGitHubStore } from "@emulators/github";
import { seedGitHubIssues } from "./github-issues.mjs";

const WORLD = {
  users: [{ login: "hanaito", name: "Hana Ito" }, { login: "samira-o", name: "Samira Okafor" }],
  orgs: [{ login: "northstar-relay", name: "Northstar Relay" }],
  repos: [{
    owner: "northstar-relay", name: "web-console", auto_init: true,
    issues: [{ number: 322, title: "Audit export labels timestamps as UTC", body: "b",
               state: "open", author: "hanaito", assignees: ["hanaito"] }],
  }],
};

function githubWith(config) {
  const { store } = createServer(githubPlugin, { port: 0, baseUrl: "http://localhost" });
  githubPlugin.seed?.(store, "http://localhost");
  seedFromConfig(store, "http://localhost", config);
  const result = seedGitHubIssues(store, config);
  return { store, result, gs: getGitHubStore(store) };
}

test("the issue the world points at by number exists", () => {
  const { result, gs } = githubWith(WORLD);
  const issue = gs.issues.all().find((i) => i.number === 322);

  assert.equal(result.issues, 1);
  assert.ok(issue, "issue 322 must exist");
  assert.equal(issue.title, "Audit export labels timestamps as UTC");
  assert.equal(issue.state, "open");
});

test("a seeded issue carries the arrays the read path maps without a guard", () => {
  // formatIssue maps label_ids and assignee_ids directly, so an issue missing
  // them breaks every issue read rather than just its own.
  const { gs } = githubWith(WORLD);
  for (const issue of gs.issues.all()) {
    assert.ok(Array.isArray(issue.label_ids), "label_ids must be an array");
    assert.ok(Array.isArray(issue.assignee_ids), "assignee_ids must be an array");
  }
});

test("the author is the world's person, not whoever seeded first", () => {
  const { gs } = githubWith(WORLD);
  const issue = gs.issues.all().find((i) => i.number === 322);
  assert.equal(gs.users.get(issue.user_id).login, "hanaito");
});

test("an issue from someone the world lacks is dropped, not misattributed", () => {
  const world = structuredClone(WORLD);
  world.repos[0].issues = [{ number: 999, title: "t", body: null, state: "open", author: "nobody", assignees: [] }];
  const { result, gs } = githubWith(world);
  assert.equal(result.issues, 0);
  assert.equal(gs.issues.all().find((i) => i.number === 999), undefined);
});

// Closes: `open_issues_count` is a stored field upstream maintains from the issue
// and pull-request ROUTES, and seeding writes the store directly, so it stayed at
// the `0` a repository is created with. Measured on a running composer:
// `GET /repos/northstar-relay/relay-core` said `open_issues_count: 0` while
// `…/issues?state=open` returned eight. It read `0` for every repository in every
// world.
test("open_issues_count matches the issues the repository actually serves", () => {
  const world = {
    ...WORLD,
    repos: [{
      owner: "northstar-relay", name: "web-console", auto_init: true,
      issues: [
        { number: 322, title: "Audit export labels", state: "open", author: "hanaito" },
        { number: 323, title: "Retry export webhooks", state: "open", author: "samira-o" },
        { number: 300, title: "Already handled", state: "closed", author: "hanaito" },
      ],
    }],
  };
  const { gs } = githubWith(world);
  const repo = gs.repos.all().find((item) => item.name === "web-console");
  const open = gs.issues.all().filter((issue) => issue.repo_id === repo.id && issue.state === "open");

  assert.equal(open.length, 2);
  assert.equal(repo.open_issues_count, 2);
});

// The count is recomputed from the rows rather than incremented, so it always
// equals what the read path will serve, and a repository the world declares no
// issues for is left at zero rather than being given somebody else's total.
test("every repository's count equals its own open rows", () => {
  const world = {
    ...WORLD,
    repos: [
      { owner: "northstar-relay", name: "web-console", auto_init: true,
        issues: [{ number: 322, title: "Audit export labels", state: "open", author: "hanaito" }] },
      { owner: "northstar-relay", name: "quiet", auto_init: true },
    ],
  };
  const { gs } = githubWith(world);

  for (const repo of gs.repos.all()) {
    const open = gs.issues.all().filter((issue) => issue.repo_id === repo.id && issue.state === "open").length;
    assert.equal(repo.open_issues_count, open, repo.name);
  }
  assert.equal(gs.repos.all().find((item) => item.name === "quiet").open_issues_count, 0);
});
