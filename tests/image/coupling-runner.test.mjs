import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { containerArguments, credentialValues, mappedBindings, pauseRunClock, redact, removeOwnedContainer, responseInventory, waitForReady } from "./coupling-runner.mjs";
import { openState } from "../../runtime/src/state.mjs";
import { startClock } from "../../runtime/src/clock.mjs";

test("baseline clock helper retains an explicit absent clock and pauses a started clock", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-baseline-clock-")), path = join(root, "state.sqlite");
  const db = openState(path);
  const run = args => promisify(execFile)(process.execPath, ["--input-type=module", "-e", args.at(-1).replaceAll("/state/state.sqlite", path)]);
  try {
    assert.deepEqual(await pauseRunClock("test-owned-run", run), {started: false, running: false, elapsed_ms: 0, anchor: null});
    startClock(db, {anchor: "2031-01-01T00:00:00Z", now: Date.now() - 1000});
    const paused = await pauseRunClock("test-owned-run", run);
    assert.equal(paused.started, true); assert.equal(paused.running, false); assert.ok(paused.elapsed_ms >= 1000);
    assert.deepEqual(await pauseRunClock("test-owned-run", run), paused);
  } finally { db.close(); rmSync(root, {recursive: true, force: true}); }
});

test("report redaction removes credentials in nested records and error text", () => {
  const credentials = { GOOGLE_TOKEN: "current-secret", nested: { password: "other-secret" } };
  const value = redact({ error: "rejected current-secret; Bearer unknown-value", nested: [{ client_secret: "vendor-value" }] }, credentialValues(credentials));
  assert.equal(JSON.stringify(value).includes("current-secret"), false);
  assert.equal(JSON.stringify(value).includes("unknown-value"), false);
  assert.equal(JSON.stringify(value).includes("vendor-value"), false);
});

test("response evidence records a digest without saving response credentials", () => {
  const evidence = responseInventory([{ provider: "vendor", path: "/me", body: { token: "private-value" } }]);
  assert.equal(evidence[0].sha256.length, 64);
  assert.equal(JSON.stringify(evidence).includes("private-value"), false);
  assert.deepEqual(redact({ access_token_issued: true, access_token: "private-value" }),
    { access_token_issued: true, access_token: "[redacted]" });
});

test("credential collection preserves login and scope metadata in evidence", () => {
  const secrets = credentialValues({ tokens: { vendor_token: { login: "user", scopes: ["checks"] } }, GOOGLE_TOKEN: "run-secret" });
  assert.deepEqual(secrets.sort(), ["run-secret", "vendor_token"]);
  assert.equal(redact("users and checks", secrets), "users and checks");
});

test("container startup uses an explicit read-only artifact and isolated host ports", () => {
  const args = containerArguments({ image: "test:local", artifactPath: "/tmp/artifact", name: "test", owner: "unit", exposedPorts: ["1234/tcp"] });
  assert.ok(args.includes("127.0.0.1::1234/tcp"));
  assert.ok(args.includes("type=bind,src=/tmp/artifact,dst=/world,readonly"));
  assert.ok(args.includes("--no-rebase"));
});

test("bindings use allocated ports and cannot escape the test container", () => {
  const ports = { "1234/tcp": [{ HostIp: "127.0.0.1", HostPort: "4567" }] };
  assert.equal(mappedBindings({ API_BASE_URL: "http://127.0.0.1:1234/api" }, ports).API_BASE_URL, "http://127.0.0.1:4567/api");
  assert.throws(() => mappedBindings({ API_BASE_URL: "https://example.test:1234" }, ports), /isolated test container/);
  assert.throws(() => mappedBindings({ API_BASE_URL: "http://127.0.0.1:9999" }, ports), /no published/);
});

test("cleanup refuses a container owned by another run", async () => {
  const calls = [];
  await assert.rejects(removeOwnedContainer("other", "this-run", async (args) => {
    calls.push(args);
    return { stdout: JSON.stringify([{ Config: { Labels: { "worldfixture.coupling.owner": "other-run" } } }]) };
  }), /refusing to remove/);
  assert.equal(calls.length, 1);
});

test("cleanup accepts a confirmed absent container but preserves Docker errors", async () => {
  assert.equal(await removeOwnedContainer("absent", "owner", async () => {
    throw Object.assign(new Error("inspect failed"), { stderr: "error: no such object: absent" });
  }), false);
  assert.equal(await removeOwnedContainer("absent", "owner", async () => {
    throw Object.assign(new Error("inspect failed"), { stderr: "Error: No such object: absent" });
  }), false);
  await assert.rejects(removeOwnedContainer("absent", "owner", async () => {
    throw new Error("Docker permission denied");
  }), /permission denied/);
});

test("a failed boot is reported even if old logs contain the ready message", async () => {
  await assert.rejects(waitForReady("failed", { run: async ([operation]) => operation === "inspect"
    ? { stdout: JSON.stringify([{ State: { Running: false, ExitCode: 64 } }]) }
    : { stdout: "Stop with Ctrl-C", stderr: "" } }), /world exited 64/);
});

test("a missing image gives every discovered world a failed case", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "coupling-infrastructure-"));
  const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
  try {
    const bin = join(temporary, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "docker"), `#!${process.execPath}\nif (process.argv.includes('version')) { console.log('test'); } else { console.error('No such image: deliberately-missing'); process.exitCode=1; }\n`, { mode: 0o700 });
    const output = join(temporary, "report");
    await assert.rejects(promisify(execFile)(process.execPath,
      [join(root, "tests/image/coupling-test.mjs"), "--image", "deliberately-missing", "--report", output, "--fresh-seed", "infrastructure-test"],
      { cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, timeout: 30_000 }), (error) => error.code === 1);
    const report = JSON.parse(readFileSync(join(output, "report.json"), "utf8"));
    const built = report.cases.filter((entry) => !entry.label.startsWith("alien-"));
    assert.ok(built.length > 0, "no built world was recorded");
    for (const entry of report.cases) {
      assert.ok(entry.checks.some((check) => check.check === "world.boot" && check.status === "failed"), entry.label);
    }
    assert.ok(report.checks.some((check) => check.check === "matrix.infrastructure"));
    assert.equal(report.status, "failed");
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
