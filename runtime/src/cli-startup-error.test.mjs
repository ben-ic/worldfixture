import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const ROOT = join(import.meta.dirname, "../..");

test("the container records an up error that happens before services start", t => {
  const root = mkdtempSync(join(tmpdir(), "wf-early-startup-error-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = join(root, "run");
  const result = spawnSync(process.execPath, [
    join(ROOT, "runtime/bin/worldfixture.mjs"), "up", "--direct", "--state", state,
    "--world-path", join(ROOT, "dist/business.saas-company.v3"), "--only", "not-a-world-part", "--no-rebase",
  ], {
    encoding: "utf8",
    env: { ...process.env, WORLDFIXTURE_SINGLE_CONTAINER: "1",
      WORLDFIXTURE_PROJECT_CONFIG: JSON.stringify({ api_version: "worldfixture.project/v1", application_url: "http://host.docker.internal:3000", services: [] }) },
  });

  assert.notEqual(result.status, 0);
  const recorded = JSON.parse(readFileSync(join(state, "startup-error.json"), "utf8"));
  assert.equal(recorded.api_version, "worldfixture.startup-error/v1");
  assert.match(recorded.message, /unknown world part not-a-world-part/);
});
