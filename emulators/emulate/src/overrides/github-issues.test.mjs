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
