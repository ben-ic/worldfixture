// The composer's aggregate readiness endpoint.
//
// Three of these are unit tests over `readiness()` with a stub fetch, because
// what has to be pinned is the shape of the report and the AWS refusal, and
// starting fourteen listeners to assert that would test Node's scheduler. The
// fourth starts the composer for real and knocks on the endpoint through the
// same listener an application uses, because whether the wrapper actually
// reaches a vendor's fetch handler cannot be answered from a unit test.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { READY_PATH, loadVendorChecks, readiness } from "./ready.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN = join(HERE, "main.mjs");
const CWD = dirname(HERE);

const CHECKS = loadVendorChecks();

// A stub that answers each vendor with the body its manifest names, so a test
// about the report is not also a test about thirteen upstream route tables.
function answering(bodies, { status = 200 } = {}) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const port = Number(new URL(url).port);
    const body = bodies[port];
    if (body === undefined) throw new Error("connect ECONNREFUSED");
    return new Response(body, { status });
  };
  impl.calls = calls;
  return impl;
}

const bodyFor = (vendor) => `{"probe":"${CHECKS.get(vendor).expect}"}`;

test("every started vendor is reported separately and by its own measured check", async () => {
  const started = [
    { vendor: "slack", port: 4703 },
    { vendor: "github", port: 4704 },
    { vendor: "google", port: 4705 },
  ];
  const fetchImpl = answering({ 4703: bodyFor("slack"), 4704: bodyFor("github"), 4705: bodyFor("google") });

  const report = await readiness(started, { fetchImpl });

  assert.equal(report.api_version, "worldfixture.composer-ready/v1");
  assert.equal(report.ready, true);
  assert.deepEqual(report.vendors.map((entry) => entry.vendor), ["github", "google", "slack"]);
  assert.deepEqual(report.vendors.map((entry) => entry.ready), [true, true, true]);
  assert.deepEqual(report.vendors.map((entry) => entry.port), [4704, 4705, 4703]);
  assert.deepEqual(report.excluded, []);
  assert.deepEqual(report.undeclared, []);

  // Each line names the request it made, and Slack's is a POST. `auth.test`
  // answers 404 to a GET, so a report built on GET would call a working Slack
  // broken -- this is the one vendor whose method is not the default.
  const slack = report.vendors.find((entry) => entry.vendor === "slack");
  assert.equal(slack.check.method, "POST");
  assert.equal(slack.check.path, "/api/auth.test");
  assert.equal(slack.check.expect, "not_authed");
  assert.match(slack.detail, /body names "not_authed"/);

  // Every check ran against the port that vendor is listening on.
  assert.deepEqual(fetchImpl.calls.sort(), [
    "http://127.0.0.1:4703/api/auth.test",
    "http://127.0.0.1:4704/meta",
    "http://127.0.0.1:4705/.well-known/openid-configuration",
  ]);
});

test("one vendor answering the wrong body fails only that vendor and the whole report", async () => {
  const started = [
    { vendor: "slack", port: 4703 },
    { vendor: "github", port: 4704 },
  ];

  // 200 with a body that does not name what the check expects: exactly the
  // composer's 404-with-JSON case, which a status-only check would pass.
  const fetchImpl = answering({ 4703: bodyFor("slack"), 4704: '{"message":"Not Found"}' });
  const report = await readiness(started, { fetchImpl });

  assert.equal(report.ready, false);
  const github = report.vendors.find((entry) => entry.vendor === "github");
  const slack = report.vendors.find((entry) => entry.vendor === "slack");
  assert.equal(github.ready, false);
  assert.equal(slack.ready, true, "a healthy vendor is not condemned by a broken neighbour");
  assert.match(github.detail, /-> 200, body does not name "verifiable_password_authentication"/);
});

test("a vendor whose listener refuses the connection is reported with the reason", async () => {
  const fetchImpl = answering({ 4703: bodyFor("slack") });
  const report = await readiness([{ vendor: "slack", port: 4703 }, { vendor: "okta", port: 4708 }], { fetchImpl });

  assert.equal(report.ready, false);
  const okta = report.vendors.find((entry) => entry.vendor === "okta");
  assert.equal(okta.ready, false);
  assert.match(okta.detail, /ECONNREFUSED/);
});

test("AWS is reported as excluded and is never probed", async () => {
  const fetchImpl = answering({ 4703: bodyFor("slack"), 4711: "anything at all" });
  const report = await readiness([{ vendor: "slack", port: 4703 }, { vendor: "aws", port: 4711 }], { fetchImpl });

  // Excluded, with the reason, rather than silently dropped: a run that somehow
  // gave AWS a port has a resolver problem, and the report has to show it.
  assert.deepEqual(report.excluded, [{
    vendor: "aws",
    port: 4711,
    reason: "the `@emulators/aws` listener serves live, writable S3 routes that SeaweedFS owns, so it is never selected and never probed",
  }]);
  assert.equal(report.vendors.some((entry) => entry.vendor === "aws"), false);

  // The whole point: no request was made to it. A readiness check on the AWS
  // listener is the first thing that would make a second S3 owner look startable.
  assert.deepEqual(fetchImpl.calls, ["http://127.0.0.1:4703/api/auth.test"]);
  assert.equal(CHECKS.has("aws"), false, "service.json must not declare an AWS check");

  // The remaining vendor still passes, so the report is ready.
  assert.equal(report.ready, true);
});

test("a started vendor with no measured check makes the report not ready", async () => {
  const fetchImpl = answering({ 4703: bodyFor("slack") });
  const report = await readiness([{ vendor: "slack", port: 4703 }, { vendor: "unmeasured", port: 4799 }], { fetchImpl });

  assert.equal(report.ready, false);
  assert.deepEqual(report.undeclared, [
    { vendor: "unmeasured", port: 4799, reason: "no measured protocol check in service.json" },
  ]);
});

// ---- the endpoint, on a real listener ------------------------------------

const OVERLAY = {
  slack: {
    team: { name: "Northstar Relay", domain: "northstar-relay" },
    users: [{ name: "mayac", real_name: "Maya Chen", email: "maya@example.test" }],
    channels: [{ name: "general" }],
  },
  tokens: { slack_token: { login: "mayac", scopes: [] } },
};

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// Poll the vendor's own route until it answers. A deadline rather than a fixed
// wait: the gap is milliseconds on this machine and is not a constant.
async function accepting(port, { timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fetch(`http://127.0.0.1:${port}/api/auth.test`, { method: "POST" });
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

function writeWorld() {
  const world = mkdtempSync(join(tmpdir(), "worldfixture-ready-"));
  mkdirSync(join(world, "projections"), { recursive: true });
  const body = JSON.stringify(OVERLAY);
  writeFileSync(join(world, "projections", "emulator-overlay.json"), body);
  writeFileSync(
    join(world, "manifest.json"),
    JSON.stringify({
      api_version: "worldfixture.world-artifact/v1",
      files: {
        "projections/emulator-overlay.json": {
          sha256: createHash("sha256").update(body).digest("hex"),
          size: Buffer.byteLength(body),
        },
      },
    }),
  );
  return world;
}

test("the endpoint answers on a started listener and reports that listener", async (t) => {
  const port = await freePort();
  const child = spawn(process.execPath, [MAIN], {
    cwd: CWD,
    env: { ...process.env, WORLDFIXTURE_WORLD_PATH: writeWorld(), WORLDFIXTURE_PORT_SLACK: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => new Promise((resolve) => {
    child.on("exit", resolve);
    child.kill("SIGKILL");
  }));

  let output = "";
  await new Promise((resolve, reject) => {
    const onData = (chunk) => {
      output += chunk;
      if (/EADDRINUSE/.test(output)) reject(new Error(`port ${port} was in use:\n${output}`));
      if (output.includes(`listening on 127.0.0.1:${port}`)) resolve();
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => reject(new Error(`composer exited early (${code}):\n${output}`)));
    setTimeout(() => reject(new Error(`composer never listened:\n${output}`)), 15_000).unref();
  });

  // THE LOG LINE IS NOT READINESS, and this test proved it on itself. Measured
  // over five runs: the composer prints `listening on 127.0.0.1:<port>` 12-21ms
  // BEFORE the socket accepts, and a request sent the instant that line appears
  // is refused in four runs out of five. `serve()` binds asynchronously and the
  // log call does not wait for it. So the port is asked until it answers -- the
  // same rule `runtime/src/readiness.mjs` applies to every service.
  await accepting(port);

  const response = await fetch(`http://127.0.0.1:${port}${READY_PATH}`);
  const report = await response.json();

  assert.equal(response.status, 200);
  assert.equal(report.ready, true);
  assert.deepEqual(report.vendors, [{
    vendor: "slack",
    port,
    ready: true,
    check: { method: "POST", path: "/api/auth.test", expect: "not_authed" },
    detail: `http://127.0.0.1:${port}/api/auth.test -> 200, body names "not_authed"`,
  }]);

  // The wrapper did not shadow the vendor's own routes.
  const auth = await fetch(`http://127.0.0.1:${port}/api/auth.test`, { method: "POST" });
  assert.partialDeepStrictEqual(await auth.json(), { ok: false, error: "not_authed" });

  // The report is safe on a published surface: no token, seed or store content.
  const text = JSON.stringify(report);
  assert.equal(text.includes("slack_token"), false);
  assert.equal(text.includes("mayac"), false);
});
