import assert from "node:assert/strict";
import { test } from "node:test";

import { createWorldFixtureConnector } from "./worldfixture-connector.mjs";

const TOKEN = "test-token";
const authorization = `Bearer ${TOKEN}`;
const input = {
  api_version: "worldfixture.connector-request/v1",
  request_id: "req_test",
  idempotency_key: "seed:artifact",
  world: { artifact_sha256: "a".repeat(64) },
  packs: {
    identity: {
      organizations: [{ id: "northstar", name: "Northstar", primary: true }, { id: "lumen", name: "Lumen" }],
      people: [{ id: "maya", name: "Maya", organization_id: "northstar" }],
    },
    work: { projects: [{ id: "relay" }], tasks: [{ id: "ship" }] },
  },
  options: {},
};

test("the reference connector is absent without an explicit development token", async () => {
  const connector = createWorldFixtureConnector();
  const result = await connector.handle({ method: "GET", path: "/.well-known/worldfixture" });
  assert.equal(result.status, 404);
});

test("the reference connector protects operations and plans without mutation", async () => {
  const connector = createWorldFixtureConnector({ token: TOKEN });
  assert.equal((await connector.handle({ method: "POST", path: "/__worldfixture/plan", input })).status, 401);
  const planned = await connector.handle({ method: "POST", path: "/__worldfixture/plan", authorization, input });
  assert.equal(planned.status, 200);
  assert.deepEqual(planned.body.counts, { workspaces: 1, members: 1, accounts: 1, projects: 1, tasks: 1 });
});

test("seed and event delivery are idempotent, and app-owned reset is unavailable", async () => {
  const connector = createWorldFixtureConnector({ token: TOKEN });
  const first = await connector.handle({ method: "POST", path: "/__worldfixture/seed", authorization, input });
  const repeated = await connector.handle({ method: "POST", path: "/__worldfixture/seed", authorization, input });
  assert.equal(first.body.status, "applied");
  assert.equal(repeated.body.status, "already_applied");
  assert.equal(first.body.references.find((entry) => entry.worldfixture_ref === "person/maya").application_ref, "member_maya");

  const event = { event_id: "event-one", kind: "support.case.created.v1" };
  const delivered = await connector.handle({ method: "POST", path: "/__worldfixture/events", authorization, input: event });
  const deliveredAgain = await connector.handle({ method: "POST", path: "/__worldfixture/events", authorization, input: event });
  assert.equal(delivered.body.status, "applied");
  assert.equal(deliveredAgain.body.status, "already_applied");

  assert.equal((await connector.handle({ method: "GET", path: "/__worldfixture/status", authorization })).body.state, "changed");
  assert.equal((await connector.handle({ method: "POST", path: "/__worldfixture/reset", authorization })).status, 404);
});
