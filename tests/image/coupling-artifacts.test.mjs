import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { canonicalCollectionPath, checkVocabularyIsolation, collectionCoverage, compareIdentities,
  discoverArtifacts, exclusiveVocabulary, inventoryCollections, loadArtifact, snapshotArtifact } from "./coupling-artifacts.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "coupling-artifact-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function artifactAt(path, world = { id: "test.odd-name", version: "v13", people: [] }) {
  mkdirSync(path, { recursive: true });
  const bytes = `${JSON.stringify(world)}\n`;
  writeFileSync(join(path, "world.json"), bytes);
  const files = { "world.json": { sha256: createHash("sha256").update(bytes).digest("hex"), size: Buffer.byteLength(bytes) } };
  const manifest = { api_version: "worldfixture.world-artifact/v1", world_id: world.id, world_version: world.version, files, packs: [],
    artifact_sha256: createHash("sha256").update(`${JSON.stringify(files)}\n`).digest("hex") };
  writeFileSync(join(path, "manifest.json"), JSON.stringify(manifest));
  return manifest;
}

test("verified snapshots remain stable when a shared source artifact changes", t => {
  const root = fixture(t), source = join(root, "source"), output = join(root, "snapshot");
  artifactAt(source);
  const snapshot = snapshotArtifact(source, output);
  writeFileSync(join(source, "world.json"), '{"changed":true}\n');
  assert.ok(loadArtifact(source).checks.some(check => check.status === "failed"));
  assert.ok(loadArtifact(output).checks.every(check => check.status === "passed"));
  assert.equal(snapshot.world.id, "test.odd-name");
  assert.throws(() => snapshotArtifact(source, join(root, "bad-copy")), /integrity/);
});

test("discovers nested artifacts from manifests without directory-name assumptions", (t) => {
  const root = fixture(t);
  const first = join(root, "renamed"), second = join(root, "nested", "also-renamed");
  artifactAt(first); artifactAt(second);
  mkdirSync(join(root, "not-built"));
  assert.deepEqual(discoverArtifacts(root), [second, first].sort());
  const artifact = loadArtifact(first);
  assert.deepEqual(artifact.identity, { id: "test.odd-name", version: "v13", digest: artifact.manifest.artifact_sha256 });
  assert.ok(artifact.checks.every((row) => row.status === "passed"));
});

test("a controlled missing or changed artifact file fails digest checks", (t) => {
  const root = fixture(t); artifactAt(root);
  writeFileSync(join(root, "world.json"), '{"id":"foreign","version":"v13"}\n');
  assert.equal(loadArtifact(root).checks.find((row) => row.check === "artifact.file:world.json").status, "failed");
  assert.equal(loadArtifact(root).checks.find((row) => row.check === "artifact.world-identity").status, "failed");
  rmSync(join(root, "world.json"));
  assert.equal(loadArtifact(root).checks.find((row) => row.check === "artifact.read:world.json").status, "failed");
});

test("aggregate manifest digest and declared pack mismatch cannot pass", (t) => {
  const root = fixture(t), manifest = artifactAt(root);
  manifest.artifact_sha256 = "0".repeat(64); manifest.packs.push("unknown");
  writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest));
  const { checks } = loadArtifact(root);
  assert.equal(checks.find((row) => row.check === "artifact.digest").status, "failed");
  assert.equal(checks.find((row) => row.check === "artifact.declared-packs").status, "failed");
});

test("all checked-in artifact manifests verify", () => {
  const artifacts = discoverArtifacts(resolve("dist")).map(loadArtifact);
  assert.ok(artifacts.length > 0);
  for (const artifact of artifacts) assert.deepEqual(artifact.checks.filter((row) => row.status === "failed"), [], artifact.path);
});

test("inventory walks every record and retains empty nested and new collections", () => {
  const world = { communication: { channels: [
    { id: "one", messages: [] }, { id: "two", messages: [{ id: "msg" }], new_records: [] },
  ] }, commerce: { products: [] } };
  const rows = inventoryCollections(world);
  const messages = rows.find((row) => row.path === "communication.channels[].messages");
  assert.equal(messages.count, 1); assert.equal(messages.occurrences, 2);
  assert.deepEqual(messages.identities, [{ parent: "two", id: "msg", index: 0 }]);
  assert.ok(rows.some((row) => row.path === "commerce.products" && row.count === 0));
  assert.ok(rows.some((row) => row.path === "communication.channels[].new_records" && row.count === 0));
  const coverage = collectionCoverage(rows);
  assert.equal(coverage.find((row) => row.check.endsWith("new_records")).status, "failed");
});

test("packs and canonical world use matching source collection paths", () => {
  assert.equal(canonicalCollectionPath("identity.people"), "people");
  assert.equal(canonicalCollectionPath("finance.invoices"), "finance.resolved.invoices");
  const rows = inventoryCollections({ identity: { people: [{ id: "one" }] } });
  assert.equal(collectionCoverage(rows)[0].status, "failed", "pack alone is not evidence");
  assert.equal(collectionCoverage(rows, { evidence: [{ collection: "people", provider: "slack", path: "users.list", status: "passed" }] })[0].status, "passed");
  assert.equal(collectionCoverage(rows, { evidence: [{ collection: "people", provider: "stripe", path: "GET /customers", status: "passed" }] })[0].status, "failed");
});

test("configuration names a consumer; nested record fields require their own API evidence", () => {
  const config = collectionCoverage(inventoryCollections({ categories: [], new_metadata: [] }));
  assert.equal(config.find((row) => row.check.endsWith(":categories")).status, "passed");
  assert.match(config.find((row) => row.check.endsWith(":categories")).detail, /not live API/);
  assert.equal(config.find((row) => row.check.endsWith(":new_metadata")).status, "failed");
  const rows = inventoryCollections({ communication: { channels: [{ id: "one", member_ids: [] }] } });
  const checks = collectionCoverage(rows, { evidence: [{ collection: "communication.channels", provider: "slack", path: "conversations.list", status: "passed" }] });
  assert.equal(checks.find((row) => row.check.endsWith("member_ids")).status, "failed");
});

test("operator team and ID collections require source-backed IAM reader evidence", () => {
  const inventory = inventoryCollections({ software: { operator_teams: [], operator_ids: ["owner"], operator_limit: null } });
  const evidence = ["software.operator_teams", "software.operator_ids"].map(collection => ({ collection, provider: "aws", path: "/iam/", status: "passed" }));
  assert.equal(collectionCoverage(inventory).every(row => row.status === "failed"), true);
  assert.equal(collectionCoverage(inventory, { evidence }).every(row => row.status === "passed"), true);
  evidence[1].status = "failed";
  const failed = collectionCoverage(inventory, { evidence }).find(row => row.check.endsWith("software.operator_ids"));
  assert.equal(failed.status, "failed");
  assert.equal(failed.failure_kind, "api_failure");
});

test("identity comparisons detect missing, foreign, duplicate and absent record identities", () => {
  const expected = [{ id: "a" }, { id: "b" }];
  assert.equal(compareIdentities({ check: "records", expected, actual: [...expected].reverse() }).status, "passed");
  for (const actual of [[{ id: "a" }], [{ id: "a" }, { id: "foreign" }], [...expected, { id: "a" }], [{ id: "a" }, {}]]) {
    assert.equal(compareIdentities({ check: "records", expected, actual }).status, "failed");
  }
  assert.equal(compareIdentities({ check: "mapping", expected, actual: [{ key: "b" }, { key: "a" }], actualId: (row) => row.key }).status, "passed");
  assert.equal(compareIdentities({ check: "empty", expected: [], actual: [] }).status, "passed");
});

test("fixture markers name their existing test consumer without exempting source records", () => {
  const inventory = inventoryCollections({
    fixture: { seed: "sample", variant: "short", markers: ["x0123456789abcdef"], records: [{ id: "unread" }] },
    people: [{ id: "unread-person" }],
  });
  const checks = collectionCoverage(inventory);
  const marker = checks.find(row => row.check === "collection.coverage:fixture.markers");
  assert.equal(marker.status, "passed");
  assert.match(marker.actual, /test_coupling_fixture\.py/);
  assert.match(marker.detail, /not live API or execution evidence/);
  const row = inventory.find(row => row.path === "fixture.markers");
  assert.match(row.mapping.producer, /alien-world\.py: generate_world/);
  assert.equal(row.count, 1);
  assert.equal(row.mapping.provider, undefined);
  for (const path of ["fixture.records", "people"]) {
    assert.equal(checks.find(row => row.check === `collection.coverage:${path}`).failure_kind, "reader_gap");
  }
  const nested = collectionCoverage(inventoryCollections({ fixture: { markers: [{ records: [] }] } }));
  assert.equal(nested.find(row => row.check.endsWith("fixture.markers[].records")).failure_kind, "reader_gap");
});

test("foreign vocabulary checks detect controlled markers and exclude shared SaaS vocabulary", () => {
  const shared = { id: "shared-org", name: "Shared SaaS", domain: "shared.worldfixture.test" };
  const artifacts = [
    { world: { id: "saas", version: "v1", organizations: [shared], marker: "unique-first-marker" } },
    { world: { id: "saas", version: "v2", organizations: [shared], marker: "unique-second-marker" } },
    { world: { id: "alien", version: "v1", organizations: [{ id: "other-planet", name: "Zorblax Guild", domain: "zorblax.worldfixture.test" }], marker: "alien-marker-1234" } },
  ];
  const vocabulary = exclusiveVocabulary(artifacts);
  assert.ok(!vocabulary.get("saas:v1").includes("shared saas"));
  const probe = (responses) => checkVocabularyIsolation({ responses, foreignVocabulary: vocabulary.get("saas:v1") });
  assert.equal(probe({ name: "Shared SaaS", status: "active", protocol: "https", currency: "USD", alien_marker_1234: true }).status, "passed");
  assert.equal(probe({ body: "A controlled alien-marker-1234 record." }).status, "failed");
  assert.equal(probe({ domain: "zorblax.worldfixture.test" }).status, "failed");
  assert.equal(checkVocabularyIsolation({ responses: "Shared SaaS", foreignVocabulary: vocabulary.get("alien:v1") }).status, "failed");
});

test("foreign resource names do not match part of a different resource ID", () => {
  assert.equal(checkVocabularyIsolation({ responses: { bucket: "owned-export-queue" }, foreignVocabulary: ["export-queue"] }).status, "passed");
  assert.equal(checkVocabularyIsolation({ responses: { bucket: "export-queue" }, foreignVocabulary: ["export-queue"] }).status, "failed");
  const artifacts = [
    { world: { id: "one", version: "v1", organizations: [{ name: "Owned Guild" }] }, projections: { injected: "Other Guild" } },
    { world: { id: "two", version: "v1", organizations: [{ name: "Other Guild" }] } },
  ];
  const foreignVocabulary = exclusiveVocabulary(artifacts).get("one:v1");
  assert.equal(checkVocabularyIsolation({ responses: { name: "Other Guild" }, foreignVocabulary }).status, "failed");
});

test("a complete alternate consumer proves collection reachability without hiding provider failures", () => {
  const inventory = inventoryCollections({ communication: { mail: [] } });
  const evidence = [
    { collection: "communication.mail", provider: "google", path: "/messages", status: "failed" },
    { collection: "communication.mail", provider: "mail", path: "IMAP FETCH", status: "passed" },
  ];
  assert.equal(collectionCoverage(inventory, { evidence })[0].status, "passed");
  evidence[1].status = "failed";
  assert.equal(collectionCoverage(inventory, { evidence })[0].status, "failed");
});

test("inventory separates unknown readers, missing domain evidence and blocked boots", () => {
  const inventory = inventoryCollections({ new_domain: { records: [] }, social: { reviews: [] }, communication: { calendars: [] } });
  const result = collectionCoverage(inventory);
  assert.equal(result.find(row => row.check.endsWith("new_domain.records")).failure_kind, "reader_gap");
  assert.equal(result.find(row => row.check.endsWith("social.reviews")).failure_kind, "reader_gap");
  assert.equal(result.find(row => row.check.endsWith("communication.calendars")).failure_kind, "reader_gap");
  const blocked = collectionCoverage(inventory, { readersAttempted: false });
  assert.equal(blocked.find(row => row.check.endsWith("communication.calendars")).failure_kind, "boot_blocked");
  const failedRead = collectionCoverage(inventory, { evidence: [{ collection: "communication.calendars", provider: "google", path: null, status: "failed" }] });
  assert.equal(failedRead.find(row => row.check.endsWith("communication.calendars")).failure_kind, "api_failure");
  const partial = collectionCoverage(inventory, { evidence: [
    { collection: "communication.calendars", provider: "google", path: "/calendarList", status: "passed" },
    { collection: "communication.calendars", provider: "google", path: null, status: "failed" },
  ] });
  assert.equal(partial.find(row => row.check.endsWith("communication.calendars")).status, "failed");
});

test("domain evidence must cover complete records and each nested collection", () => {
  const rows = inventoryCollections({ work: { projects: [{ id: "project", start_on: "2026-01-01", customer_id: "customer", member_ids: ["person"] }] },
    commerce: { orders: [{ id: "order", items: [{ product_id: "product", quantity: 2 }] }] } });
  const partial = [{ collection: "work.projects", provider: "notion", path: "/v1/pages/project", status: "passed" }];
  assert.equal(collectionCoverage(rows, { evidence: partial }).find(row => row.check.endsWith(":work.projects")).failure_kind, "product_gap");
  const complete = rows.map(row => ({ collection: row.canonicalPath, provider: "domain", path: "/v1/collections", status: "passed" }));
  assert.ok(collectionCoverage(rows, { evidence: [...partial, ...complete] }).every(row => row.status === "passed"));
  complete.find(row => row.collection === "commerce.orders[].items").status = "failed";
  assert.equal(collectionCoverage(rows, { evidence: complete }).find(row => row.check.endsWith("commerce.orders[].items")).status, "failed");
});

test('declared OAuth clients and nested policy arrays require measured provider evidence', () => {
  const inventory = inventoryCollections({ software: { oauth_clients: { google: [{ client_id: 'authored', name: 'Authored client', redirect_uris: ['http://callback.test'], loopback_redirect_uris: ['http://127.0.0.1/callback'], scopes: ['email'], grant_types: ['authorization_code'] }], slack: [] } } });
  assert.ok(inventory.every(row => row.kind === 'data'));
  assert.ok(collectionCoverage(inventory).every(row => row.status === 'failed'));
  const evidence = inventory.map(row => ({ collection: row.canonicalPath, provider: row.mapping.provider, path: '/oauth/token', status: 'passed' }));
  assert.ok(collectionCoverage(inventory, { evidence }).every(row => row.status === 'passed'));
  evidence.find(row => row.collection.endsWith('[].redirect_uris')).status = 'failed';
  assert.equal(collectionCoverage(inventory, { evidence }).find(row => row.check.endsWith('[].redirect_uris')).status, 'failed');
  const loopback = evidence.find(row => row.collection.endsWith('[].loopback_redirect_uris'));
  loopback.status = 'failed';
  assert.equal(collectionCoverage(inventory, { evidence }).find(row => row.check.endsWith('[].loopback_redirect_uris')).status, 'failed');
  assert.equal(collectionCoverage(inventory, { evidence: evidence.filter(row => row !== loopback) }).find(row => row.check.endsWith('[].loopback_redirect_uris')).status, 'failed');
  assert.ok(collectionCoverage(inventory, { evidence: [{ collection: 'software.oauth_clients.google', provider: 'slack', path: '/api/oauth.v2.access', status: 'passed' }] }).every(row => row.status === 'failed'));
});
