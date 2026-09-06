import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createDomainService } from "../../emulators/domain/src/server.mjs";
import { serveControl } from "./control.mjs";
import { openState } from "./state.mjs";
import { attachTimelineControl } from "./timeline-control.mjs";
import { startWorkbench } from "./workbench.mjs";

const execute = promisify(execFile);
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

test("CLI and Workbench share one clock owner and serialize real domain delivery", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-clock-interfaces-")), artifactPath = join(root, "artifact");
  mkdirSync(join(artifactPath, "projections"), { recursive: true });
  const actor = { id: "person.one", name: "Tavi" };
  const world = { id: "test.clock-interfaces", version: "v1", clock: { anchor: "2031-01-01T00:00:00Z" },
    people: [actor], social: { posts: [] }, timeline: [1, 2].map(seconds => ({ id: `arrival.${seconds}`, kind: "domain-operation", after_seconds: seconds,
      payload: { api_version: "worldfixture.runtime-operation/v1", type: "social.post.publish.v1", actor_id: actor.id,
        record: { id: `post.${seconds}`, author_id: actor.id, title: `Arrival ${seconds}`, body: "Delivered through the public API." } } })) };
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
  const service = createDomainService({ worldPath: artifactPath, statePath: join(root, "domain-state"), token: "test-domain-token", expectedDigest: artifact_sha256 });
  const state = openState(join(root, "runtime.sqlite"));
  let workbench, control, controller;
  try {
    await new Promise(resolve => service.server.listen(0, "127.0.0.1", resolve));
    const bindings = { DOMAIN_BASE_URL: `http://127.0.0.1:${service.server.address().port}`, DOMAIN_TOKEN: "test-domain-token" };
    const instance = { state, credentials: { values: {} }, lock: { world: { artifact_sha256 }, rules: [], services: [] },
      serviceStates: new Map(), readiness: new Map(), applicationBindings: bindings };
    controller = attachTimelineControl(instance, world, { bindings, rules: [], now: () => 1000 });
    await controller.initialize({ setup: true });
    control = await serveControl(instance, root);
    workbench = await startWorkbench(instance, { artifactPath, stateDir: root });
    const command = async input => {
      const response = await fetch(`${workbench.url}/api/clock`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
      return { status: response.status, data: await response.json() };
    };
    const cli = async args => JSON.parse((await execute(process.execPath,
      [new URL("../bin/worldfixture.mjs", import.meta.url).pathname, "clock", ...args, "--json", "--state", root],
      { env: { ...process.env, WORLDFIXTURE_SINGLE_CONTAINER: "1" } })).stdout);
    assert.equal((await cli([])).mode, "setup");
    assert.equal((await command({ action: "advance", duration: "1s" })).status, 409);
    assert.equal((await command({ action: "start", duration: "0s" })).status, 200);
    assert.equal((await cli(["pause"])).clock.running, false);
    const simultaneous = await Promise.all([command({ action: "advance", duration: "1s" }), cli(["advance", "1s"])]);
    assert.equal(simultaneous[0].status, 200);
    const status = await cli([]);
    assert.equal(status.clock.elapsed_ms, 2000);
    assert.equal(status.clock.running, false);
    assert.equal(status.timeline.delivered, 2);
    assert.equal(status.timeline.pending, 0);
    const read = async path => {
      const response = await fetch(bindings.DOMAIN_BASE_URL + path, { headers: { authorization: `Bearer ${bindings.DOMAIN_TOKEN}` } });
      assert.equal(response.status, 200); return response.json();
    };
    assert.deepEqual((await read("/v1/collections/social.posts")).data, world.timeline.map(row => row.payload.record));
    assert.equal((await read("/v1/events")).data.length, 2);
    const first = await (await fetch(`${workbench.url}/api/timeline?limit=1`)).json();
    assert.equal(first.data.length, 1); assert.equal(first.has_more, true);
    const second = await (await fetch(`${workbench.url}/api/timeline?limit=1&after=${first.next_cursor}`)).json();
    assert.equal(second.data.length, 1); assert.equal(second.has_more, false);
    assert.notEqual(first.data[0].id, second.data[0].id);
    assert.equal((await command({ action: "advance", duration: "-1s" })).status, 400);
    assert.equal((await command({ action: "start", duration: "0s" })).status, 409);
    assert.equal((await cli([])).clock.elapsed_ms, 2000);
    const abort = new AbortController();
    const stream = await fetch(`${workbench.url}/api/live`, { signal: abort.signal });
    const reader = stream.body.getReader();
    let received = "";
    try {
      while (!received.includes("event: clock\n")) received += new TextDecoder().decode((await reader.read()).value);
      assert.match(received, /"elapsed_ms":2000/);
      assert.match(received, /"running":false/);
    } finally { abort.abort(); await reader.cancel().catch(() => {}); }
  } finally {
    await workbench?.close(); await control?.close(); await controller?.stop(); await service.close(); state.close();
    rmSync(root, { recursive: true, force: true });
  }
});
