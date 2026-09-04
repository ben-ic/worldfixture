// `worldfixture doctor`.
//
// Docker, the readiness probe and the composer's endpoint are all injected, so
// this file can produce every failure the command reports — a missing Docker, a
// missing image, the wrong CPU, a corrupt artifact, an unwritable directory, a
// dead container, a fallback port, a broken vendor — without needing any of them
// to be true on the machine running the tests. A checker whose failure paths are
// only exercised in production is a checker whose failure paths do not work.
//
// Every finding is asserted to carry the three things a user needs in order to
// act on it: what failed, why, and the next command.

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { SUPPORTED_ARCHITECTURES, diagnose, formatReport, validateArtifact } from "./doctor.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const ARTIFACT = join(ROOT, "dist/business.saas-company.v2");

const scratch = [];
after(() => scratch.forEach((path) => {
  try { chmodSync(path, 0o755); } catch { /* already removable */ }
  rmSync(path, { recursive: true, force: true });
}));

function scratchDir(prefix = "worldfixture-doctor-") {
  const path = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(path);
  return path;
}

const find = (report, name) => report.checks.find((check) => check.name === name);

// A Docker stand-in. `answers` maps the first two argv words to stdout; anything
// else rejects the way the real command does.
function fakeDocker(answers) {
  const calls = [];
  const runner = async (args) => {
    calls.push(args);
    for (const [prefix, answer] of Object.entries(answers)) {
      if (args.join(" ").startsWith(prefix)) {
        if (answer instanceof Error) throw answer;
        return { stdout: answer, stderr: "" };
      }
    }
    const error = new Error(`no answer for ${args.join(" ")}`);
    error.stderr = `Error: No such object: ${args.at(-1)}`;
    throw error;
  };
  runner.calls = calls;
  return runner;
}

const HEALTHY_DOCKER = {
  "version": "29.4.0\n",
  "image inspect": "sha256:1111111111111111111111111111111111111111111111111111111111111111 arm64\n",
};

const neverProbed = async () => {
  throw new Error("no service should have been probed");
};
const neverFetched = async () => {
  throw new Error("no composer should have been asked");
};

test("a healthy machine with no instance reports what it checked and nothing failed", async () => {
  const report = await diagnose({
    artifactPath: ARTIFACT,
    stateDir: scratchDir(),
    arch: "arm64",
    dockerRunner: fakeDocker(HEALTHY_DOCKER),
    probeImpl: neverProbed,
    fetchImpl: neverFetched,
  });

  assert.equal(report.healthy, true);
  assert.equal(find(report, "Docker").state, "ok");
  assert.equal(find(report, "Image").state, "ok");
  assert.equal(find(report, "Architecture").state, "ok");
  assert.equal(find(report, "World artifact").state, "ok");
  assert.equal(find(report, "State directory").state, "ok");

  // With no instance recorded, the live checks say so instead of pretending.
  for (const name of ["Instance", "Ports", "Services", "Composer"]) {
    assert.equal(find(report, name).state, "skipped", name);
  }
});

test("a missing docker command names the install step, and stops asking Docker questions", async () => {
  const enoent = new Error("spawn docker ENOENT");
  enoent.code = "ENOENT";
  const runner = fakeDocker({ version: enoent });

  const report = await diagnose({
    artifactPath: ARTIFACT,
    stateDir: scratchDir(),
    arch: "arm64",
    dockerRunner: runner,
    probeImpl: neverProbed,
    fetchImpl: neverFetched,
  });

  const docker = find(report, "Docker");
  assert.equal(report.healthy, false);
  assert.equal(docker.state, "failed");
  assert.match(docker.summary, /not installed/);
  assert.match(docker.cause, /not on PATH/);
  assert.match(docker.repair, /Install Docker/);

  // One question asked, then it stopped. Asking Docker four more times to be
  // told four more times that it is not there is noise, not diagnosis.
  assert.equal(runner.calls.length, 1);
  assert.equal(find(report, "Image").state, "skipped");
  assert.equal(find(report, "Instance").state, "skipped");
});

test("a daemon that is installed but not running is a different finding", async () => {
  const refused = new Error("Cannot connect to the Docker daemon");
  refused.stderr = "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?";

  const report = await diagnose({
    artifactPath: ARTIFACT,
    stateDir: scratchDir(),
    arch: "arm64",
    dockerRunner: fakeDocker({ version: refused }),
    probeImpl: neverProbed,
    fetchImpl: neverFetched,
  });

  const docker = find(report, "Docker");
  assert.match(docker.summary, /daemon did not answer/);
  assert.match(docker.cause, /Cannot connect to the Docker daemon/);
  assert.match(docker.repair, /Start Docker/);
});

test("a missing image names the build command", async () => {
  const report = await diagnose({
    artifactPath: ARTIFACT,
    stateDir: scratchDir(),
    image: "worldfixture:local",
    arch: "arm64",
    dockerRunner: fakeDocker({ version: "29.4.0\n" }),
    probeImpl: neverProbed,
    fetchImpl: neverFetched,
  });

  const image = find(report, "Image");
  assert.equal(image.state, "failed");
  assert.match(image.summary, /no local image named worldfixture:local/);
  assert.match(image.repair, /docker buildx build .*-t worldfixture:local \./);
});

test("an unsupported CPU says which two architectures exist", async () => {
  const report = await diagnose({
    artifactPath: ARTIFACT,
    stateDir: scratchDir(),
    arch: "ppc64",
    dockerRunner: fakeDocker(HEALTHY_DOCKER),
    probeImpl: neverProbed,
    fetchImpl: neverFetched,
  });

  const architecture = find(report, "Architecture");
  assert.equal(architecture.state, "failed");
  assert.match(architecture.summary, /ppc64 is not a supported CPU architecture/);
  assert.match(architecture.cause, /arm64 and amd64/);
  assert.deepEqual(Object.values(SUPPORTED_ARCHITECTURES).sort(), ["amd64", "arm64"]);
});

test("an image built for the other architecture is a warning, not a failure", async () => {
  const report = await diagnose({
    artifactPath: ARTIFACT,
    stateDir: scratchDir(),
    arch: "arm64",
    dockerRunner: fakeDocker({
      version: "29.4.0\n",
      "image inspect": "sha256:2222222222222222222222222222222222222222222222222222222222222222 amd64\n",
    }),
    probeImpl: neverProbed,
    fetchImpl: neverFetched,
  });

  const architecture = find(report, "Architecture");
  assert.equal(architecture.state, "warning");
  assert.match(architecture.summary, /this machine is arm64 and the local image is amd64/);
  assert.match(architecture.repair, /--platform linux\/arm64/);

  // A warning is reported and does not fail the run: the image does work under
  // emulation, and refusing to start it would be a worse answer than saying so.
  assert.equal(report.healthy, true);
});

test("a corrupt artifact names the file, both digests, and the rebuild", () => {
  const artifact = scratchDir("worldfixture-artifact-");
  mkdirSync(join(artifact, "packs"), { recursive: true });
  writeFileSync(join(artifact, "packs/work.json"), "{}");
  writeFileSync(join(artifact, "manifest.json"), JSON.stringify({
    api_version: "worldfixture.world-artifact/v1",
    world_id: "business.saas-company",
    world_version: "v2",
    artifact_sha256: "0".repeat(64),
    files: { "packs/work.json": { sha256: "f".repeat(64), size: 2 } },
  }));

  const check = validateArtifact(artifact);
  assert.equal(check.state, "failed");
  assert.match(check.summary, /1 of 1 artifact files do not match/);
  assert.match(check.cause, /packs\/work\.json hashes to \w{12}…, the manifest says ffffffffffff…/);
  assert.match(check.repair, /worldfixture_compiler build/);
});

test("a missing artifact file is reported as missing rather than as a digest mismatch", () => {
  const artifact = scratchDir("worldfixture-artifact-");
  writeFileSync(join(artifact, "manifest.json"), JSON.stringify({
    api_version: "worldfixture.world-artifact/v1",
    world_id: "business.saas-company",
    world_version: "v2",
    artifact_sha256: "0".repeat(64),
    files: { "packs/work.json": { sha256: "f".repeat(64), size: 2 } },
  }));

  assert.match(validateArtifact(artifact).cause, /packs\/work\.json is missing/);
});

test("no artifact at all names the compiler command", () => {
  const check = validateArtifact(join(scratchDir(), "not-built"));
  assert.equal(check.state, "failed");
  assert.match(check.summary, /no world artifact at/);
  assert.match(check.repair, /worldfixture_compiler build/);
});

test("the real artifact validates against its own manifest", () => {
  const check = validateArtifact(ARTIFACT);
  assert.equal(check.state, "ok", check.cause);
  assert.match(check.summary, /business\.saas-company:v2 validates/);
});

test("an unwritable state directory is found by writing, not by reading mode bits", async () => {
  const state = scratchDir();
  chmodSync(state, 0o500);

  const report = await diagnose({
    artifactPath: ARTIFACT,
    stateDir: state,
    arch: "arm64",
    dockerRunner: fakeDocker(HEALTHY_DOCKER),
    probeImpl: neverProbed,
    fetchImpl: neverFetched,
  });

  const directory = find(report, "State directory");
  assert.equal(directory.state, "failed");
  assert.match(directory.summary, /is not writable/);
  assert.match(directory.repair, /--state/);
});

// ---- with a recorded instance -------------------------------------------

// Write the three files `worldfixture up` records, so the live checks have
// something to be about.
function recordInstance(state, { ports, containerId = "c".repeat(64), bindings = {}, lock } = {}) {
  writeFileSync(join(state, "instance.json"), JSON.stringify({
    api_version: "worldfixture.host-instance/v1",
    container_id: containerId,
    container_name: "worldfixture-test",
    image: "worldfixture:local",
    image_id: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    state_dir: state,
    ports: ports ?? [
      { name: "slack", containerPort: 4703, preferredPort: 4703, hostPort: 4703 },
      { name: "workbench", containerPort: 4715, preferredPort: 4715, hostPort: 4715 },
    ],
  }));
  writeFileSync(join(state, "host-bindings.json"), JSON.stringify({
    SLACK_BASE_URL: "http://127.0.0.1:4703",
    ...bindings,
  }));
  writeFileSync(join(state, "host-addresses.json"), JSON.stringify({
    "emulate/slack": { host: "127.0.0.1", port: 4703 },
  }));
  writeFileSync(join(state, "environment.lock.json"), JSON.stringify(lock ?? {
    services: [{
      name: "emulate",
      readiness: [{ port: "slack", protocol: "http", path: "/api/auth.test", expect: "not_authed", kind: "protocol" }],
    }],
  }));
}

const LIVE_STATE = '{"Running":true,"Status":"running","StartedAt":"2026-09-03T05:46:25Z"}';
const WORLDFIXTURE_LABELS = '{"org.opencontainers.image.title":"WorldFixture"}';

const runningDocker = (labels = WORLDFIXTURE_LABELS, state = LIVE_STATE) => fakeDocker({
  ...HEALTHY_DOCKER,
  inspect: `${state}\t${labels}\n`,
});

test("a live instance is probed, and the composer is asked its aggregate", async () => {
  const state = scratchDir();
  recordInstance(state);

  const asked = [];
  const report = await diagnose({
    artifactPath: ARTIFACT,
    stateDir: state,
    arch: "arm64",
    dockerRunner: runningDocker(),
    probeImpl: async () => ({ ok: true, detail: "answered" }),
    fetchImpl: async (url) => {
      asked.push(url);
      return new Response(JSON.stringify({
        ready: true,
        vendors: [{ vendor: "slack", ready: true }, { vendor: "github", ready: true }],
        excluded: [{ vendor: "aws", reason: "never probed" }],
      }));
    },
  });

  assert.equal(report.healthy, true);
  assert.equal(find(report, "Instance").state, "ok");
  assert.match(find(report, "Instance").summary, /worldfixture-test is running/);
  assert.equal(find(report, "Records").state, "ok");
  assert.equal(find(report, "Service emulate").state, "ok");

  const composer = find(report, "Composer");
  assert.equal(composer.state, "ok");
  assert.match(composer.summary, /all 2 started vendors are ready/);

  // Asked at the composer's own address and at the aggregate path, and told the
  // user that AWS was excluded rather than leaving it unmentioned.
  assert.deepEqual(asked, ["http://127.0.0.1:4703/_worldfixture/ready"]);
  assert.match(composer.detail, /aws excluded and never probed/);
});

test("a failing protocol check names the service, the detail, and the repair", async () => {
  const state = scratchDir();
  recordInstance(state);

  const report = await diagnose({
    artifactPath: ARTIFACT,
    stateDir: state,
    arch: "arm64",
    dockerRunner: runningDocker(),
    probeImpl: async () => ({ ok: false, detail: "http://127.0.0.1:4703/api/auth.test -> 404, body does not name \"not_authed\"" }),
    fetchImpl: async () => new Response(JSON.stringify({ ready: true, vendors: [], excluded: [] })),
  });

  const service = find(report, "Service emulate");
  assert.equal(report.healthy, false);
  assert.equal(service.state, "failed");
  assert.match(service.summary, /1 of 1 protocol checks failed/);
  assert.match(service.cause, /body does not name "not_authed"/);
  assert.match(service.repair, /worldfixture status --verbose/);
});

test("a broken vendor behind the composer is named by the aggregate endpoint", async () => {
  const state = scratchDir();
  recordInstance(state);

  const report = await diagnose({
    artifactPath: ARTIFACT,
    stateDir: state,
    arch: "arm64",
    dockerRunner: runningDocker(),
    probeImpl: async () => ({ ok: true, detail: "answered" }),
    fetchImpl: async () => new Response(JSON.stringify({
      ready: false,
      vendors: [
        { vendor: "slack", ready: true, detail: "ok" },
        { vendor: "okta", ready: false, detail: "http://127.0.0.1:4708/api/v1/users: connect ECONNREFUSED" },
      ],
      excluded: [],
    }), { status: 503 }),
  });

  const composer = find(report, "Composer");
  assert.equal(report.healthy, false);
  assert.match(composer.summary, /1 of 2 started vendors are not ready/);
  assert.match(composer.cause, /okta: .*ECONNREFUSED/);

  // This is what the aggregate buys: the host published no okta address in this
  // instance, so no per-service check here could have seen it.
  assert.equal(find(report, "Service emulate").state, "ok");
});

test("a recorded container that Docker no longer has is a stale record", async () => {
  const state = scratchDir();
  recordInstance(state);

  const report = await diagnose({
    artifactPath: ARTIFACT,
    stateDir: state,
    arch: "arm64",
    dockerRunner: fakeDocker(HEALTHY_DOCKER),
    probeImpl: neverProbed,
    fetchImpl: neverFetched,
  });

  const instance = find(report, "Instance");
  const records = find(report, "Records");
  assert.equal(instance.state, "failed");
  assert.match(instance.summary, /no longer exists/);
  assert.equal(records.state, "failed");
  assert.match(records.summary, /point at a container that is gone/);
  assert.match(records.repair, /worldfixture down/);

  // Nothing live was asked about a container that is not there.
  assert.equal(find(report, "Services").state, "skipped");
  assert.equal(find(report, "Composer").state, "skipped");
});

test("a container that is running but is not WorldFixture is refused by its labels", async () => {
  const state = scratchDir();
  recordInstance(state);

  const report = await diagnose({
    artifactPath: ARTIFACT,
    stateDir: state,
    arch: "arm64",
    dockerRunner: runningDocker('{"org.opencontainers.image.title":"postgres"}'),
    probeImpl: neverProbed,
    fetchImpl: neverFetched,
  });

  const instance = find(report, "Instance");
  assert.equal(instance.state, "failed");
  assert.match(instance.summary, /is not a WorldFixture container/);
  assert.match(instance.cause, /image title is "postgres"/);
});

test("a stopped container is reported with its exit code", async () => {
  const state = scratchDir();
  recordInstance(state);

  const report = await diagnose({
    artifactPath: ARTIFACT,
    stateDir: state,
    arch: "arm64",
    dockerRunner: runningDocker(WORLDFIXTURE_LABELS, '{"Running":false,"Status":"exited","ExitCode":137,"Error":""}'),
    probeImpl: neverProbed,
    fetchImpl: neverFetched,
  });

  const instance = find(report, "Instance");
  assert.match(instance.summary, /is exited/);
  assert.match(instance.cause, /exit code 137/);
});

test("fallback host ports are reported by name, as a warning rather than a fault", async () => {
  const state = scratchDir();
  recordInstance(state, {
    ports: [
      { name: "slack", containerPort: 4703, preferredPort: 4703, hostPort: 53411 },
      { name: "site", containerPort: 8080, preferredPort: 8080, hostPort: 8080 },
    ],
  });

  const report = await diagnose({
    artifactPath: ARTIFACT,
    stateDir: state,
    arch: "arm64",
    dockerRunner: runningDocker(),
    probeImpl: async () => ({ ok: true, detail: "answered" }),
    fetchImpl: async () => new Response(JSON.stringify({ ready: true, vendors: [{ vendor: "slack", ready: true }], excluded: [] })),
  });

  const ports = find(report, "Ports");
  assert.equal(ports.state, "warning");
  assert.match(ports.summary, /1 of 2 surfaces are on fallback host ports/);
  assert.match(ports.cause, /slack wanted 4703 and got 53411/);
  assert.match(ports.repair, /worldfixture env/);

  // A fallback is the launcher working. It must not make `doctor` exit non-zero
  // and tell a user their world is broken when it is running correctly.
  assert.equal(report.healthy, true);
});

test("the printed report states what failed, why, and the next command", async () => {
  const state = scratchDir();
  recordInstance(state);

  const report = await diagnose({
    artifactPath: ARTIFACT,
    stateDir: state,
    arch: "arm64",
    dockerRunner: fakeDocker(HEALTHY_DOCKER),
    probeImpl: neverProbed,
    fetchImpl: neverFetched,
  });

  const text = formatReport(report);
  assert.match(text, /^FAIL {2}Instance/m);
  assert.match(text, /^ {2}Why {3}/m);
  assert.match(text, /^ {2}Next {2}Clear them: `worldfixture down`\./m);
  assert.match(text, /checks failed\. Each one names its repair above\./);

  // A healthy report says so in one line rather than in silence.
  const healthy = await diagnose({
    artifactPath: ARTIFACT,
    stateDir: scratchDir(),
    arch: "arm64",
    dockerRunner: fakeDocker(HEALTHY_DOCKER),
    probeImpl: neverProbed,
    fetchImpl: neverFetched,
  });
  assert.match(formatReport(healthy), /No failing check\. Nothing needs repair\./);
});

test("every failing and warning finding carries a cause and a repair", async () => {
  const state = scratchDir();
  recordInstance(state, {
    ports: [{ name: "slack", containerPort: 4703, preferredPort: 4703, hostPort: 51000 }],
  });

  const reports = await Promise.all([
    diagnose({ artifactPath: ARTIFACT, stateDir: scratchDir(), arch: "ppc64", dockerRunner: fakeDocker({ version: "29.4.0\n" }), probeImpl: neverProbed, fetchImpl: neverFetched }),
    diagnose({ artifactPath: join(scratchDir(), "gone"), stateDir: state, arch: "arm64", dockerRunner: runningDocker(), probeImpl: async () => ({ ok: false, detail: "refused" }), fetchImpl: async () => { throw new Error("connect ECONNREFUSED"); } }),
  ]);

  for (const report of reports) {
    for (const check of report.checks) {
      if (check.state !== "failed" && check.state !== "warning") continue;
      assert.ok(check.cause, `${check.name} has no cause`);
      assert.ok(check.repair, `${check.name} has no repair`);
      assert.ok(check.summary, `${check.name} has no summary`);
    }
  }
});
