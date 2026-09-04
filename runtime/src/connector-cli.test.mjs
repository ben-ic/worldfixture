import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const BIN = join(ROOT, "runtime/bin/worldfixture.mjs");

test("connector docs prints the installed versioned protocol", async () => {
  const { stdout } = await run(process.execPath, [BIN, "connector", "docs"], { cwd: ROOT });
  assert.match(stdout, /^# WorldFixture Connector v1/m);
  assert.match(stdout, /POST \/__worldfixture\/events/);
  assert.match(stdout, /^# Connector security/m);
  assert.match(stdout, /^# Connector mapping guide/m);
  assert.match(stdout, /^# Project connection/m);
});

test("connector prompt gives a coding agent the docs and conformance commands", async () => {
  const { stdout } = await run(process.execPath, [BIN, "connector", "prompt", "http://localhost:3000"], { cwd: ROOT });
  assert.match(stdout, /worldfixture connector docs/);
  assert.match(stdout, /worldfixture connector check http:\/\/localhost:3000/);
  assert.match(stdout, /\.worldfixture\/token/);
  assert.match(stdout, /Do not create a parallel domain model/);
  assert.match(stdout, /\.worldfixture\/project\.json/);
});

// The fixture answers with COMPLETE responses on purpose. `connector check` now
// validates every response against the published schema, so a stand-in that
// leaves out `accepts` or `mappings` fails the run for a reason that has nothing
// to do with what this case is about -- which is that the check finds the
// installed world artifact when it is run from somewhere else entirely.
test("connector check uses the installed world when run from an application directory", async (t) => {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/.well-known/worldfixture") {
      response.end(JSON.stringify({
        api_version: "worldfixture.connector/v1",
        application: { id: "path-test", name: "Path test" },
        capabilities: { plan: true, seed: false, event: false, status: true, reset: false },
        accepts: ["identity"],
      }));
      return;
    }
    if (request.headers.authorization !== "Bearer wf_local_test") {
      response.statusCode = 401;
      response.end(JSON.stringify({ error: "token required" }));
      return;
    }
    if (request.url === "/__worldfixture/plan") {
      response.end(JSON.stringify({
        api_version: "worldfixture.connector-plan/v1",
        summary: "ready",
        mappings: [],
        counts: {},
        warnings: [],
      }));
      return;
    }
    if (request.url === "/__worldfixture/status") {
      response.end(JSON.stringify({
        api_version: "worldfixture.connector-status/v1",
        state: "empty",
        receipts: [],
      }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const appDir = mkdtempSync(join(tmpdir(), "worldfixture-connector-cwd-"));
  const address = server.address();

  const { stdout } = await run(process.execPath, [
    BIN,
    "connector",
    "check",
    `http://127.0.0.1:${address.port}`,
    "--token",
    "wf_local_test",
  ], { cwd: appDir });

  assert.match(stdout, /Connector is ready\./);
});
