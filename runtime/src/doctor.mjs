// `worldfixture doctor` — the checks, apart from the printing.
//
// Every failure names the failed component, direct cause, state change, and one
// repair command. `doctor` reports and does not repair. Removing a container or
// state directory can destroy something the user still needs.
//
// EVERY CHECK IS INJECTABLE. Docker, the clock, the architecture and the
// readiness probe all arrive as parameters, so the whole report can be produced
// in a test without Docker, without an image and without a running world. The
// real bindings are supplied by `cli.mjs`.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { hostAddresses, hostBindings, hostInstance } from "./host-launcher.mjs";
import { probe } from "./readiness.mjs";

const execFileAsync = promisify(execFile);

// The installed package, not the caller's working directory.
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// The architectures the Dockerfile can build and the SeaweedFS download is
// checksum-pinned for. Anything else fails the build with exit 64, so saying so
// here is cheaper than finding out from a build log.
export const SUPPORTED_ARCHITECTURES = { arm64: "arm64", x64: "amd64" };

export const COMPOSER_READY_PATH = "/_worldfixture/ready";

const ok = (name, summary, detail) => ({ name, state: "ok", summary, detail });
const failed = (name, summary, cause, repair) => ({ name, state: "failed", summary, cause, repair });
const skipped = (name, summary, cause) => ({ name, state: "skipped", summary, cause });
const warned = (name, summary, cause, repair) => ({ name, state: "warning", summary, cause, repair });

async function docker(args, { runner, timeoutMs = 20_000 } = {}) {
  return runner(args, { timeoutMs });
}

export function realDockerRunner(args, { timeoutMs = 20_000 } = {}) {
  return execFileAsync("docker", args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
}

// ---- the checks ----------------------------------------------------------

async function checkDocker(runner) {
  try {
    const { stdout } = await docker(["version", "--format", "{{.Server.Version}}"], { runner });
    return ok("Docker", `Docker Engine ${stdout.trim()} is reachable`);
  } catch (error) {
    const missing = error.code === "ENOENT";
    return failed(
      "Docker",
      missing ? "the docker command is not installed" : "Docker is installed but its daemon did not answer",
      missing ? "`docker` is not on PATH" : firstLine(error.stderr ?? error.message),
      missing
        ? "Install Docker Desktop or OrbStack, then run `worldfixture doctor` again."
        : "Start Docker, then run `worldfixture doctor` again.",
    );
  }
}

async function checkImage(runner, image) {
  try {
    const { stdout } = await docker(
      ["image", "inspect", image, "--format", "{{.Id}} {{.Architecture}}"],
      { runner },
    );
    const [id, architecture] = stdout.trim().split(" ");
    return {
      ...ok("Image", `${image} exists`, `${id.slice(0, 19)}… built for ${architecture}`),
      imageArchitecture: architecture,
    };
  } catch (error) {
    return failed(
      "Image",
      `no local image named ${image}`,
      firstLine(error.stderr ?? error.message),
      imageRepair(image),
    );
  }
}

// The repair depends on what the caller actually has.
//
// An installed npm package ships the runtime, the schemas and the compiled
// world -- and no Dockerfile, no compiler, no emulators and no world sources.
// Telling that caller to run `docker buildx build .` names a command they cannot
// possibly run, which is the kind of advice this file exists to avoid.
export function imageRepair(image, root = PACKAGE_ROOT) {
  const platform = `linux/${SUPPORTED_ARCHITECTURES[process.arch] ?? "arm64"}`;
  if (existsSync(join(root, "Dockerfile"))) {
    return `Build it: docker buildx build --platform ${platform} --load -t ${image} .`;
  }
  return (
    `This install has no build inputs, so the image has to come from somewhere else. ` +
    `Pull or load a WorldFixture image, tag it ${image}, or point at one you already ` +
    `have with WORLDFIXTURE_IMAGE=<name>.`
  );
}

// Two questions, not one: can this machine run the image at all, and does the
// image that exists match this machine. A user on Apple Silicon with an amd64
// image gets a world that starts under emulation and then behaves oddly in ways
// that look like WorldFixture bugs.
function checkArchitecture(arch, imageArchitecture) {
  const wanted = SUPPORTED_ARCHITECTURES[arch];

  if (!wanted) {
    return failed(
      "Architecture",
      `${arch} is not a supported CPU architecture`,
      `the image builds for ${Object.values(SUPPORTED_ARCHITECTURES).join(" and ")} only; the SeaweedFS download is checksum-pinned for those two`,
      "Run WorldFixture on an arm64 or amd64 machine.",
    );
  }

  if (imageArchitecture && imageArchitecture !== wanted) {
    return warned(
      "Architecture",
      `this machine is ${wanted} and the local image is ${imageArchitecture}`,
      "the image will run under emulation, which is slow and has produced process-table differences before",
      `Rebuild for this machine: docker buildx build --platform linux/${wanted} --load -t worldfixture:local .`,
    );
  }

  return ok("Architecture", `${wanted} is supported`, imageArchitecture ? `the local image is ${imageArchitecture}` : undefined);
}

// The artifact is validated against its own manifest, byte for byte. `up`
// refuses a mismatch at resolution time; doctor's job is to say so before the
// user has spent five minutes watching a container start.
export function validateArtifact(artifactPath) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(artifactPath, "manifest.json"), "utf8"));
  } catch (error) {
    return failed(
      "World artifact",
      `no world artifact at ${artifactPath}`,
      firstLine(error.message),
      "Build it: PYTHONPATH=compiler python3 -m worldfixture_compiler build worlds/business.saas-company.v3/world.json --output dist/business.saas-company.v3",
    );
  }

  if (manifest.api_version !== "worldfixture.world-artifact/v1") {
    return failed(
      "World artifact",
      `${artifactPath} is a ${manifest.api_version} artifact`,
      "this runtime reads worldfixture.world-artifact/v1",
      "Rebuild the artifact with the compiler in this checkout.",
    );
  }

  const wrong = [];
  for (const [file, expected] of Object.entries(manifest.files ?? {})) {
    let bytes;
    try {
      bytes = readFileSync(join(artifactPath, file));
    } catch {
      wrong.push(`${file} is missing`);
      continue;
    }
    if (bytes.length !== expected.size) {
      wrong.push(`${file} is ${bytes.length} bytes, the manifest says ${expected.size}`);
      continue;
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== expected.sha256) wrong.push(`${file} hashes to ${digest.slice(0, 12)}…, the manifest says ${expected.sha256.slice(0, 12)}…`);
  }

  if (wrong.length > 0) {
    return failed(
      "World artifact",
      `${wrong.length} of ${Object.keys(manifest.files).length} artifact files do not match the manifest`,
      wrong.slice(0, 4).join("; "),
      "Rebuild the artifact: PYTHONPATH=compiler python3 -m worldfixture_compiler build worlds/business.saas-company.v3/world.json --output dist/business.saas-company.v3",
    );
  }

  const count = Object.keys(manifest.files ?? {}).length;
  return ok(
    "World artifact",
    `${manifest.world_id}:${manifest.world_version} validates`,
    `${count} files match the manifest, artifact ${manifest.artifact_sha256.slice(0, 12)}…`,
  );
}

// Writable is asked by writing. `statSync` mode bits are wrong under a Docker
// bind mount and on any filesystem with ACLs, and this directory is exactly
// where a bind mount lands.
export function checkStateDirectory(stateDir) {
  const marker = join(stateDir, `.doctor-write-check-${process.pid}`);
  try {
    writeFileSync(marker, "");
    rmSync(marker, { force: true });
  } catch (error) {
    return failed(
      "State directory",
      `${stateDir} is not writable`,
      firstLine(error.message),
      `Choose another directory with --state, or fix its permissions: chmod u+w ${stateDir}`,
    );
  }

  return ok("State directory", `${stateDir} is writable`);
}

// A recorded instance is a claim about a container. This asks Docker whether
// that container is running AND whether it is a WorldFixture container: a
// container id is reused by nothing, but a record left behind by a removed
// container can name an id Docker has since given to something else.
async function checkInstance(runner, stateDir) {
  const instance = hostInstance(stateDir);
  if (!instance) return skipped("Instance", "no instance is recorded", "run `worldfixture up` to start one");

  let state;
  let labels;
  try {
    const { stdout } = await docker(
      ["inspect", instance.container_id, "--format", "{{json .State}}\t{{json .Config.Labels}}"],
      { runner },
    );
    const [stateText, labelText] = stdout.trim().split("\t");
    state = JSON.parse(stateText);
    labels = JSON.parse(labelText) ?? {};
  } catch (error) {
    return {
      ...failed(
        "Instance",
        `the recorded container ${instance.container_id.slice(0, 12)} no longer exists`,
        firstLine(error.stderr ?? error.message),
        "Clear the record and start again: `worldfixture down` then `worldfixture up`.",
      ),
      stale: true,
    };
  }

  if (!state.Running) {
    return {
      ...failed(
        "Instance",
        `the recorded container ${instance.container_id.slice(0, 12)} is ${state.Status}`,
        state.Error || `exit code ${state.ExitCode}`,
        "Clear the record and start again: `worldfixture down` then `worldfixture up`.",
      ),
      stale: true,
    };
  }

  if (labels["org.opencontainers.image.title"] !== "WorldFixture") {
    return {
      ...failed(
        "Instance",
        `container ${instance.container_id.slice(0, 12)} is running but is not a WorldFixture container`,
        `its image title is ${JSON.stringify(labels["org.opencontainers.image.title"] ?? "unset")}`,
        "Clear the record and start again: `worldfixture down` then `worldfixture up`.",
      ),
      stale: true,
    };
  }

  return {
    ...ok(
      "Instance",
      `${instance.container_name} is running`,
      `${instance.image} (${instance.image_id.slice(0, 19)}…), started ${state.StartedAt}`,
    ),
    running: true,
    instance,
  };
}

// Which preferred host ports this instance got, and which it did not. A fallback
// is not a fault -- it is the launcher working -- but a user whose application
// is configured for 4703 needs to be told, by name, that Slack is somewhere else.
export function checkPorts(stateDir, { running }) {
  const instance = hostInstance(stateDir);
  if (!instance || !running) {
    return skipped("Ports", "no running instance to report ports for", "`worldfixture up` prints the ports it selected");
  }

  const fallbacks = instance.ports.filter((entry) => entry.hostPort !== entry.preferredPort);
  const detail = instance.ports
    .map((entry) => `${entry.name} ${entry.hostPort}${entry.hostPort === entry.preferredPort ? "" : ` (preferred ${entry.preferredPort})`}`)
    .join(", ");

  if (fallbacks.length === 0) {
    return ok("Ports", `all ${instance.ports.length} surfaces are on their preferred host ports`, detail);
  }

  return warned(
    "Ports",
    `${fallbacks.length} of ${instance.ports.length} surfaces are on fallback host ports`,
    `${fallbacks.map((entry) => `${entry.name} wanted ${entry.preferredPort} and got ${entry.hostPort}`).join("; ")} — another process held the preferred port when this instance started`,
    "Read the real addresses from `worldfixture env` rather than hard-coding a port.",
  );
}

// A record with no container behind it. `status`, `env` and the service commands
// already remove one when they meet it, so this reports the case doctor found
// and names the command that clears it.
export function checkStaleRecords(stateDir, { stale }) {
  const instance = hostInstance(stateDir);
  const bindings = hostBindings(stateDir);

  if (!instance && !bindings) return ok("Records", "no stale instance records");
  if (!stale) return ok("Records", "the instance records match a live container");

  return failed(
    "Records",
    "the instance records point at a container that is gone",
    `${join(stateDir, "instance.json")} names ${instance?.container_id?.slice(0, 12) ?? "a container"}, which Docker does not have running`,
    "Clear them: `worldfixture down`.",
  );
}

// Readiness, now, over each service's own protocol -- the same rule `status`
// follows. A published port is asked from the host; a private one is not
// reachable from here and is reported as such rather than as unhealthy.
async function checkServices(stateDir, { running, probeImpl = probe }) {
  if (!running) return [skipped("Services", "no running instance to probe", "start one with `worldfixture up`")];

  let lock;
  try {
    lock = JSON.parse(readFileSync(join(stateDir, "environment.lock.json"), "utf8"));
  } catch (error) {
    return [failed(
      "Services",
      "the instance is running but published no environment lock",
      firstLine(error.message),
      "Stop and start it again: `worldfixture down` then `worldfixture up`.",
    )];
  }

  const addresses = hostAddresses(stateDir) ?? {};
  const results = [];

  for (const service of lock.services) {
    const measured = [];
    for (const check of service.readiness) {
      const address = addresses[`${service.name}/${check.port}`];
      if (!address) continue;
      measured.push({ ...check, ...(await probeImpl(check, address)) });
    }

    const broken = measured.filter((entry) => !entry.ok);
    if (measured.length === 0) {
      results.push(skipped(`Service ${service.name}`, "publishes no port this host can probe", "its surfaces are private to the container"));
    } else if (broken.length === 0) {
      results.push(ok(`Service ${service.name}`, `ready, ${measured.length} protocol ${measured.length === 1 ? "check" : "checks"} passed`));
    } else {
      results.push(failed(
        `Service ${service.name}`,
        `${broken.length} of ${measured.length} protocol checks failed`,
        broken.map((entry) => entry.detail).join("; "),
        "Read the service output: `worldfixture status --verbose`, then `worldfixture reset` to restore the accepted start.",
      ));
    }
  }

  return results;
}

// The composer's own aggregate. This is the one thing the per-service checks
// above cannot answer: they probe the listeners the lock published, and the
// composer holds one listener per vendor with vendors on private ports. Asking
// the composer reports every vendor IT started, including the ones this host
// cannot reach, and it is the endpoint that will not silently pass on a 404.
async function checkComposer(stateDir, { running, fetchImpl = fetch }) {
  if (!running) return skipped("Composer", "no running instance to ask", "start one with `worldfixture up`");

  const bindings = hostBindings(stateDir);
  const base = bindings?.SLACK_BASE_URL ?? bindings?.GITHUB_BASE_URL ?? bindings?.GOOGLE_BASE_URL;
  if (!base) return skipped("Composer", "this instance published no composer address", "the environment started no provider vendor");

  let report;
  try {
    const response = await fetchImpl(`${base}${COMPOSER_READY_PATH}`, { signal: AbortSignal.timeout(10_000) });
    report = await response.json();
  } catch (error) {
    return failed(
      "Composer",
      `the composer did not answer ${COMPOSER_READY_PATH}`,
      firstLine(error.message),
      "Check the container is still up: `worldfixture status`.",
    );
  }

  const broken = (report.vendors ?? []).filter((entry) => !entry.ready);
  const excluded = (report.excluded ?? []).map((entry) => entry.vendor);
  const note = excluded.length > 0 ? `; ${excluded.join(", ")} excluded and never probed` : "";

  if (report.ready) {
    return ok(
      "Composer",
      `all ${report.vendors.length} started vendors are ready`,
      [`asked ${base}${COMPOSER_READY_PATH}${note}`, closedConflicts(stateDir)].filter(Boolean).join("; "),
    );
  }

  return failed(
    "Composer",
    `${broken.length} of ${report.vendors?.length ?? 0} started vendors are not ready`,
    broken.map((entry) => `${entry.vendor}: ${entry.detail}`).join("; ") || "the composer reported not ready with no failing vendor",
    "Restore the accepted start: `worldfixture reset`.",
  );
}

// A port that stays closed leaves no trace in the running system, so the lock is
// the only place the reason survives. SeaweedFS owning S3 is the one that
// matters: the composer's `aws` listener would serve writable `/s3/` routes.
function closedConflicts(stateDir) {
  try {
    const lock = JSON.parse(readFileSync(join(stateDir, "environment.lock.json"), "utf8"));
    if (!lock.closed_conflicts?.length) return null;
    return lock.closed_conflicts
      .map((entry) => `${entry.disclaimed_by}/${entry.port} stays shut because ${entry.owner} owns ${entry.profile}`)
      .join("; ");
  } catch {
    return null;
  }
}

// ---- the report ----------------------------------------------------------

export async function diagnose({
  artifactPath,
  stateDir,
  image = "worldfixture:local",
  arch = process.arch,
  dockerRunner = realDockerRunner,
  probeImpl = probe,
  fetchImpl = fetch,
} = {}) {
  const checks = [];

  const dockerCheck = await checkDocker(dockerRunner);
  checks.push(dockerCheck);

  const imageCheck = dockerCheck.state === "ok"
    ? await checkImage(dockerRunner, image)
    : skipped("Image", `cannot look for ${image}`, "Docker did not answer");
  checks.push(imageCheck);
  checks.push(checkArchitecture(arch, imageCheck.imageArchitecture));

  checks.push(validateArtifact(artifactPath));
  checks.push(checkStateDirectory(stateDir));

  const instanceCheck = dockerCheck.state === "ok"
    ? await checkInstance(dockerRunner, stateDir)
    : skipped("Instance", "cannot ask Docker about the recorded container", "Docker did not answer");
  checks.push(instanceCheck);
  checks.push(checkStaleRecords(stateDir, { stale: Boolean(instanceCheck.stale) }));
  checks.push(checkPorts(stateDir, { running: Boolean(instanceCheck.running) }));
  checks.push(...(await checkServices(stateDir, { running: Boolean(instanceCheck.running), probeImpl })));
  checks.push(await checkComposer(stateDir, { running: Boolean(instanceCheck.running), fetchImpl }));

  return {
    checks: checks.map(({ imageArchitecture, stale, running, instance, ...entry }) => entry),
    healthy: checks.every((entry) => entry.state !== "failed"),
  };
}

function firstLine(text) {
  return String(text ?? "").trim().split("\n")[0] || "no detail";
}

const MARKS = { ok: "ok  ", failed: "FAIL", warning: "warn", skipped: "--  " };

export function formatReport(report, { verbose = false } = {}) {
  const lines = [];

  for (const check of report.checks) {
    lines.push(`${MARKS[check.state]}  ${check.name.padEnd(22)}${check.summary}`);
    if (check.detail && verbose) lines.push(`        ${check.detail}`);
    if (check.state === "skipped" && check.cause && verbose) lines.push(`        ${check.cause}`);
  }

  const problems = report.checks.filter((check) => check.state === "failed" || check.state === "warning");

  for (const check of problems) {
    lines.push("");
    lines.push(`${check.name}: ${check.summary}`);
    if (check.cause) lines.push(`  Why   ${check.cause}`);
    if (check.repair) lines.push(`  Next  ${check.repair}`);
  }

  lines.push("");
  lines.push(report.healthy
    ? "No failing check. Nothing needs repair."
    : `${report.checks.filter((check) => check.state === "failed").length} checks failed. Each one names its repair above.`);

  return lines.join("\n");
}
