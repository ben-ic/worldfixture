import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readConnectorEnvironment, writeConnectorEnvironment } from "./connector-env.mjs";

test("connector environment preserves variables, keeps the file out of Git and images, and reuses its token", () => {
  const appDir = mkdtempSync(join(tmpdir(), "worldfixture-app-"));
  writeFileSync(join(appDir, ".env.local"), "DATABASE_URL=postgres://local\n");
  writeFileSync(join(appDir, ".gitignore"), "node_modules/\n");
  writeFileSync(join(appDir, ".dockerignore"), "vendor/\n");

  const first = writeConnectorEnvironment(appDir, { token: "wf_local_test" });
  assert.equal(first.envPath, join(appDir, ".env.local"));
  assert.equal(readConnectorEnvironment(appDir).token, "wf_local_test");
  assert.match(readFileSync(first.envPath, "utf8"), /^DATABASE_URL=postgres:\/\/local/m);
  assert.match(readFileSync(join(appDir, ".gitignore"), "utf8"), /^\/\.env\.local$/m);
  assert.match(readFileSync(join(appDir, ".dockerignore"), "utf8"), /^\/\.env\.local$/m);
  assert.equal(statSync(first.envPath).mode & 0o777, 0o600);

  const second = writeConnectorEnvironment(appDir);
  assert.equal(second.token, "wf_local_test");
  assert.equal(readFileSync(first.envPath, "utf8").match(/WORLDFIXTURE_TOKEN=/g).length, 1);
});

test("connector environment refuses a shared or escaping environment file", () => {
  const appDir = mkdtempSync(join(tmpdir(), "worldfixture-app-"));
  assert.throws(() => writeConnectorEnvironment(appDir, { fileName: ".env" }), /\.env\.\*\.local/);
  assert.throws(() => writeConnectorEnvironment(appDir, { fileName: "../.env.local" }), /must be/);
});

test("connector environment needs an existing application directory", () => {
  const parent = mkdtempSync(join(tmpdir(), "worldfixture-app-"));
  const missing = join(parent, "missing");
  assert.throws(() => writeConnectorEnvironment(missing), /ENOENT/);
  mkdirSync(missing);
  assert.doesNotThrow(() => writeConnectorEnvironment(missing));
});
