import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDomainService } from "../../emulators/domain/src/server.mjs";
import { openState } from "./state.mjs";
import { startWorkbench } from "./workbench.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

test("Workbench serves a domain-only world and records accepted CRUD events with explicit actors", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-workbench-domain-"));
  const artifactPath = join(root, "artifact");
  mkdirSync(join(artifactPath, "projections"), { recursive: true });
  const actor = { id: "person-47.uncommon", name: "Tavi" };
  const world = { id: "test.domain-only", version: "v1", people: [actor], social: { posts: [] } };
  const projection = { api_version: "worldfixture.domain/v1", world: { id: world.id, version: world.version },
    collections: { "identity.people": [actor], "social.posts": [] } };
  const files = {};
  for (const [file, value] of [["world.json", world], ["projections/domain.json", projection]]) {
    const bytes = JSON.stringify(value); writeFileSync(join(artifactPath, file), bytes);
    files[file] = { sha256: sha(bytes), size: Buffer.byteLength(bytes) };
  }
  const artifact_sha256 = sha(`${JSON.stringify(canonical(files))}\n`);
  writeFileSync(join(artifactPath, "manifest.json"), JSON.stringify({ api_version: "worldfixture.world-artifact/v1",
    world_id: world.id, world_version: world.version, files, artifact_sha256 }));
  const service = createDomainService({ worldPath: artifactPath, statePath: join(root, "domain-state"), token: "domain-test-token", expectedDigest: artifact_sha256 });
  const state = openState(join(root, "runtime.sqlite"));
  let workbench;
  try {
    await new Promise(resolve => service.server.listen(0, "127.0.0.1", resolve));
    workbench = await startWorkbench({ state, credentials: { values: {} }, lock: { world: { artifact_sha256 }, rules: [], services: [] },
      serviceStates: new Map(), readiness: new Map(),
      applicationBindings: { DOMAIN_BASE_URL: `http://127.0.0.1:${service.server.address().port}`, DOMAIN_TOKEN: "domain-test-token" } },
    { artifactPath, stateDir: root });
    const write = async input => {
      const response = await fetch(`${workbench.url}/api/actions/domain`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
      return { status: response.status, value: await response.json() };
    };
    const record = { id: "post.47-uncommon", author_id: actor.id, title: "Full record", body: "Authored text", extra: { tags: ["kept"] } };
    const action = { method: "POST", collection: "social.posts", record };
    const overview = await fetch(`${workbench.url}/api/overview`);
    assert.equal(overview.status, 200, await overview.clone().text());
    const data = await overview.json();
    assert.deepEqual(data.organizations, []);
    assert.equal(data.providers.domain.available, true);
    assert.equal(data.providers.domain.collections.find(row => row.name === "social.posts").count, 0);
    assert.equal((await write(action)).status, 400);
    assert.equal((await write({ ...action, actor_id: "absent-person" })).status, 400);
    assert.equal(state.prepare("SELECT COUNT(*) AS count FROM events").get().count, 0);
    const created = await write({ ...action, actor_id: actor.id });
    assert.equal(created.status, 200, JSON.stringify(created.value));
    assert.deepEqual(created.value.record, record);
    assert.equal(created.value.event.caused_by, created.value.command.id);
    assert.equal(created.value.event.actor_id, actor.id);
    const invalid = await write({ method: "PATCH", collection: "social.posts", recordId: record.id, actor_id: actor.id, patch: { author_id: "absent-person" } });
    assert.equal(invalid.status, 400);
    assert.match(invalid.value.error, /author_id|reference/);
    assert.equal(state.prepare("SELECT COUNT(*) AS count FROM events").get().count, 1);
    const detail = await fetch(`${workbench.url}/api/provider/domain?${new URLSearchParams({ collection: "social.posts", id: record.id })}`);
    assert.equal(detail.status, 200); assert.deepEqual((await detail.json()).record, record);
    const updated = await write({ method: "PATCH", collection: "social.posts", recordId: record.id, actor_id: actor.id, patch: { body: "Changed text" } });
    assert.equal(updated.status, 200, JSON.stringify(updated.value));
    assert.deepEqual(updated.value.record.extra, record.extra);
    assert.equal(updated.value.event.type, "domain.record.updated.v1");
    const removed = await write({ method: "DELETE", collection: "social.posts", recordId: record.id, actor_id: actor.id });
    assert.equal(removed.status, 200, JSON.stringify(removed.value));
    assert.equal(removed.value.event.type, "domain.record.deleted.v1");
    const empty = await fetch(`${workbench.url}/api/provider/domain?collection=social.posts`);
    assert.equal((await empty.json()).total_count, 0);
    assert.equal(state.prepare("SELECT COUNT(*) AS count FROM events").get().count, 3);
    assert.equal(state.prepare("SELECT COUNT(*) AS count FROM commands WHERE status = 'accepted'").get().count, 3);
  } finally { await workbench?.close(); await service.close(); state.close(); rmSync(root, { recursive: true, force: true }); }
});
