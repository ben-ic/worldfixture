import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  ConnectorError,
  assertWorldMatchesInstance,
  connectorResponseErrors,
  applicationUrl,
  checkConnector,
  connectorPrompt,
  deliverConnectorEvent,
  discoverConnector,
} from "./connector.mjs";

function mockConnector({ plan: planResponse } = {}) {
  const original = globalThis.fetch;
  const token = "connector-test-token";
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    const json = (value, status = 200) => new Response(JSON.stringify(value), {
      status, headers: { "content-type": "application/json" },
    });
    if (path === "/.well-known/worldfixture") return json({
      api_version: "worldfixture.connector/v1",
      application: { id: "test-app", name: "Test App" },
      capabilities: { plan: true, seed: true, event: true, status: true, reset: true },
      accepts: ["identity", "work"],
    });
    if (options.headers.authorization !== `Bearer ${token}`) return json({ error: "token required" }, 401);
    if (path === "/__worldfixture/plan") return json(planResponse ?? {
      api_version: "worldfixture.connector-plan/v1", summary: "Will create test records", mappings: [], counts: {}, warnings: [],
    });
    if (path === "/__worldfixture/status") return json({
      api_version: "worldfixture.connector-status/v1", state: "empty", receipts: [],
    });
    return json({ error: "not found" }, 404);
  };
  return { url: "http://connector.test", token, restore: () => { globalThis.fetch = original; } };
}

function artifact() {
  const path = mkdtempSync(join(tmpdir(), "worldfixture-connector-"));
  mkdirSync(join(path, "packs"));
  writeFileSync(join(path, "manifest.json"), JSON.stringify({
    world_id: "test-world", world_version: "v1", artifact_sha256: "a".repeat(64), synthetic: true, packs: ["identity"],
  }));
  writeFileSync(join(path, "world.json"), JSON.stringify({ title: "Test world", clock: { anchor: "2027-01-01T00:00:00Z" } }));
  writeFileSync(join(path, "packs/identity.json"), JSON.stringify({ organizations: [], people: [] }));
  return { path, remove: () => rmSync(path, { recursive: true, force: true }) };
}

test("applicationUrl accepts HTTP and removes paths that cannot be a connector origin", () => {
  assert.equal(applicationUrl("http://localhost:3000/app?x=1#top").toString(), "http://localhost:3000/");
  assert.throws(() => applicationUrl("file:///tmp/app"), ConnectorError);
});

test("discovery validates and supplies the standard endpoint paths", async () => {
  const fixture = mockConnector();
  try {
    const result = await discoverConnector(fixture.url);
    assert.equal(result.application.name, "Test App");
    assert.equal(result.endpoints.seed, "/__worldfixture/seed");
  } finally {
    fixture.restore();
  }
});

test("the conformance check proves token protection, planning, and status", async () => {
  const fixture = mockConnector();
  const world = artifact();
  try {
    const result = await checkConnector(fixture.url, {
      token: fixture.token,
      artifactPath: world.path,
    });
    assert.equal(result.ready, true);
    assert.deepEqual(result.checks.map((check) => check.name), [
      "Discovery document", "Token protection", "Discovery shape", "Seed plan", "Plan shape", "Status", "Status shape",
    ]);
  } finally {
    fixture.restore();
    world.remove();
  }
});

// The bug this closes: `protocol-v1.md` described the plan response in prose that
// never named `mappings`, and the check only ever compared `api_version`. A
// connector written from the prose passed the conformance run and then took the
// Workbench down with a TypeError on `plan.mappings.map`, in the browser, a long
// way from anybody who could fix it. The check now reads the same schemas the
// document calls authoritative, and names the missing field.
test("the conformance check fails a response that does not match the published schema", async () => {
  const fixture = mockConnector({
    plan: { api_version: "worldfixture.connector-plan/v1", summary: "Will create test records", mapping: [] },
  });
  const world = artifact();
  try {
    const result = await checkConnector(fixture.url, { token: fixture.token, artifactPath: world.path });
    const shape = result.checks.find((check) => check.name === "Plan shape");

    assert.equal(result.ready, false);
    assert.equal(shape.ok, false);
    assert.match(shape.detail, /missing required property "mappings"/);
    assert.match(shape.detail, /missing required property "counts"/);
    // The operation itself still succeeded; only the shape is wrong.
    assert.equal(result.checks.find((check) => check.name === "Seed plan").ok, true);
  } finally {
    fixture.restore();
    world.remove();
  }
});

// The bug this closes: `connector-status.v1` describes its receipts with a
// reference to `connector-receipt.v1`, in another file, and the validator only
// resolved `#/`-local pointers. An empty `receipts` array never dereferences
// `items`, so a connector passed the conformance check right up to the moment it
// seeded something -- and then the check called the connector broken and
// `connector status` exited with a raw stack trace. Two applications hit it
// within an hour, both correct.
test("a status carrying receipts is checked against the receipt schema in the other file", () => {
  const receipt = {
    api_version: "worldfixture.connector-receipt/v1",
    status: "applied",
    counts: { users: 9 },
    references: [{ worldfixture_ref: "person/maya-chen", application_ref: "user_1" }],
  };

  assert.deepEqual(
    connectorResponseErrors(
      { api_version: "worldfixture.connector-status/v1", state: "seeded", receipts: [receipt] },
      "status",
    ),
    [],
  );

  const errors = connectorResponseErrors(
    { api_version: "worldfixture.connector-status/v1", state: "seeded", receipts: [{ status: "applied" }] },
    "status",
  );
  assert.match(errors.join("; "), /receipts\[0\]: missing required property "counts"/);
});

test("a fault in WorldFixture's own schema is reported, not thrown at the caller", () => {
  // A command that already succeeded must not die because the checker could not
  // run. The finding names WorldFixture rather than blaming the application.
  const errors = connectorResponseErrors({}, "status");
  assert.equal(Array.isArray(errors), true);
});

// The bug this closes: the artifact a connector is seeded from and the artifact
// the emulators serve are resolved separately and can differ -- `up` rebases the
// world onto today into the run's state directory, an older published image
// writes none, and rebuilding `dist/` moves it under a running instance. The
// application then receives a world whose people and dates are not the ones the
// Slack and mail surfaces show, and `idempotency_key` is derived from the wrong
// artifact, so two different worlds can share a key and the second seed is
// answered "already applied" and silently dropped. Every symptom of that looks
// like a bug in the connector.
test("seeding an artifact the running instance is not serving is refused by name", () => {
  const running = "a".repeat(64);
  const other = "b".repeat(64);
  const lock = { world: { artifact_sha256: running } };

  assert.doesNotThrow(() => assertWorldMatchesInstance({ world: { artifact_sha256: running } }, lock));
  // No instance running, or a lock too old to say: the check stands down rather
  // than blocking a command that would have worked.
  assert.doesNotThrow(() => assertWorldMatchesInstance({ world: { artifact_sha256: other } }, null));
  assert.doesNotThrow(() => assertWorldMatchesInstance({ world: { artifact_sha256: other } }, {}));

  assert.throws(
    () => assertWorldMatchesInstance({ world: { artifact_sha256: other } }, lock),
    (error) => error instanceof ConnectorError
      && error.code === "artifact_mismatch"
      && error.message.includes(other.slice(0, 12))
      && error.message.includes(running.slice(0, 12)),
  );
});

test("the generated agent prompt points to installed documentation and the checker", () => {
  const prompt = connectorPrompt("http://localhost:3000");
  assert.match(prompt, /worldfixture connector docs/);
  assert.match(prompt, /worldfixture connector check http:\/\/localhost:3000/);
  assert.match(prompt, /development-only/);
  assert.match(prompt, /all local service dependencies/);
  assert.match(prompt, /Keep the application's normal development command/);
  assert.match(prompt, /declare reset unavailable for every application database/);
  assert.match(prompt, /Normal world reset must preserve application database data/);
  assert.match(prompt, /ignored \.worldfixture\/token file/);
  assert.match(prompt, /do not open, read, print, copy, or expose the token value/);
  assert.match(prompt, /\.worldfixture\/project\.json/);
});

test("event delivery refuses an incomplete event before it contacts an application", async () => {
  await assert.rejects(() => deliverConnectorEvent("http://connector.test", { event_id: "one" }, { token: "test" }), /needs event_id and kind/);
});
