// The Docker host launcher for one local WorldFixture instance.
//
// The image keeps stable container ports. This file owns the changing host
// ports, the exact container identity, and the files that let later CLI calls
// address that same instance.

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

// The CLI handles host-launch failures separately so it can show a repair
// command without a stack trace.
export class HostLauncherError extends Error {
  constructor(code, message, repair) {
    super(message);
    this.name = "HostLauncherError";
    this.code = code;
    this.repair = repair;
  }
}

export const HOST_SURFACES = [
  ["stripe", 4701], ["vercel", 4702], ["slack", 4703],
  ["github", 4704], ["google", 4705], ["microsoft", 4706],
  ["mongoatlas", 4707], ["okta", 4708], ["resend", 4709],
  ["apple", 4710], ["clerk", 4712], ["linear", 4713],
  ["twilio", 4714], ["workbench", 4715], ["notion", 4716], ["site", 8080],
  ["smtp", 2525], ["imap", 1143], ["s3", 61006],
  ["postgres", 5432], ["mysql", 3306],
].map(([name, containerPort]) => ({ name, containerPort, preferredPort: containerPort }));

const FILES = {
  instance: "instance.json",
  bindings: "host-bindings.json",
  addresses: "host-addresses.json",
};

function reserve(port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      resolve({
        port: server.address().port,
        release: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

export async function selectHostPorts(surfaces = HOST_SURFACES, { avoid = new Set() } = {}) {
  const held = [];
  try {
    for (const surface of surfaces) {
      let reservation;
      try {
        if (avoid.has(surface.preferredPort)) throw Object.assign(new Error("avoided"), { code: "EADDRINUSE" });
        reservation = await reserve(surface.preferredPort);
      } catch (error) {
        if (error.code !== "EADDRINUSE" && error.code !== "EACCES") throw error;
        reservation = await reserve(0);
      }
      held.push({ ...surface, hostPort: reservation.port, release: reservation.release });
    }
    return held;
  } catch (error) {
    await Promise.all(held.map((entry) => entry.release()));
    throw error;
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function hostInstance(stateDir) {
  return readJson(join(stateDir, FILES.instance));
}

export function hostBindings(stateDir) {
  return readJson(join(stateDir, FILES.bindings));
}

export function hostAddresses(stateDir) {
  return readJson(join(stateDir, FILES.addresses));
}

export function removeHostRecord(stateDir) {
  for (const file of Object.values(FILES)) rmSync(join(stateDir, file), { force: true });
}

export function hostContainerName(stateDir) {
  const suffix = createHash("sha256").update(stateDir).digest("hex").slice(0, 10);
  return `worldfixture-${suffix}`;
}

// Docker keeps its own port ledger, and a free host socket does not mean a free
// Docker port.
//
// THE BUG THIS CLOSES. Port selection reserves a real socket on 127.0.0.1, which
// is the right check for another program holding the port -- and it is not
// enough. A container published by some other project holds the port inside
// Docker's allocator, `reserve()` succeeds anyway, and `docker run` then fails
// with `Bind for 0.0.0.0:3306 failed: port is already allocated`. Every one of
// the nineteen world surfaces falls back correctly and MySQL did not, because
// nothing had taken 3306 in the only place we looked. Somebody running Ghost --
// whose development stack publishes 3306 -- could not start a world at all, and
// what they saw was a raw Node stack trace.
//
// Docker names the port it refused, so the answer is to take it out of the pool
// and select again rather than to guess.
function refusedPort(error) {
  const match = /Bind for (?:[0-9.]+:)?(\d+) failed: port is already allocated/i.exec(
    String(error.stderr ?? error.message ?? ""),
  );
  return match ? Number(match[1]) : null;
}

function dockerNotFound(error) {
  return /no such (object|container)/i.test(String(error.stderr ?? error.message));
}

async function inspectDockerContainer(identifier, runner) {
  try {
    const { stdout } = await runner("docker", ["inspect", identifier, "--format", "{{json .}}"]);
    return JSON.parse(stdout);
  } catch (error) {
    if (dockerNotFound(error)) return null;
    throw error;
  }
}

function verifiedHostContainer(inspection, stateDir) {
  const name = String(inspection.Name ?? "").replace(/^\//, "");
  const labels = inspection.Config?.Labels ?? {};
  const stateMount = (inspection.Mounts ?? []).find((mount) => mount.Destination === "/state");

  if (name !== hostContainerName(stateDir)) {
    throw new HostLauncherError(
      "host_container_mismatch",
      `container ${name || inspection.Id?.slice(0, 12) || "unknown"} does not have the name for this state directory`,
      "Inspect the container with `docker inspect`, then use the correct --state directory.",
    );
  }
  if (labels["org.worldfixture.instance"] !== "local" || labels["org.opencontainers.image.title"] !== "WorldFixture") {
    throw new HostLauncherError(
      "host_container_conflict",
      `container ${name} uses the WorldFixture name but is not a WorldFixture local instance`,
      `Rename or remove ${name} after you inspect it.`,
    );
  }
  if (!stateMount || stateMount.Type !== "bind" || stateMount.RW !== true || resolve(stateMount.Source) !== resolve(stateDir)) {
    throw new HostLauncherError(
      "host_container_conflict",
      `container ${name} does not use ${stateDir} as its writable /state mount`,
      `Rename or remove ${name} after you inspect it.`,
    );
  }

  return {
    api_version: "worldfixture.host-instance/v1",
    container_id: inspection.Id,
    container_name: name,
    image: inspection.Config.Image,
    image_id: inspection.Image,
    state_dir: stateDir,
    ports: [],
    containerState: inspection.State,
    recovered: true,
  };
}

export async function inspectHostInstance(stateDir, { runner = run } = {}) {
  const recorded = hostInstance(stateDir);
  const identifier = recorded?.container_id ?? hostContainerName(stateDir);
  let inspection = await inspectDockerContainer(identifier, runner);

  // A stale record must not hide the running deterministic container.
  if (!inspection && recorded?.container_id) {
    inspection = await inspectDockerContainer(hostContainerName(stateDir), runner);
  }
  if (!inspection?.State?.Running) return null;

  const verified = verifiedHostContainer(inspection, stateDir);
  return recorded && inspection.Id === recorded.container_id
    ? { ...recorded, containerState: inspection.State }
    : verified;
}

export function translateBindings(bindings, byContainerPort) {
  const translated = {};
  for (const [name, value] of Object.entries(bindings)) {
    if (typeof value !== "string") {
      translated[name] = value;
      continue;
    }
    const hostPort = value.match(/^127\.0\.0\.1:(\d+)$/);
    const hostPortMapping = hostPort && byContainerPort.get(Number(hostPort[1]));
    if (hostPortMapping) {
      translated[name] = `127.0.0.1:${hostPortMapping.hostPort}`;
      continue;
    }
    try {
      const url = new URL(value);
      const mapping = url.hostname === "127.0.0.1" && byContainerPort.get(Number(url.port));
      if (mapping) {
        url.port = String(mapping.hostPort);
        translated[name] = url.toString().replace(/\/$/, value.endsWith("/") ? "/" : "");
        continue;
      }
    } catch {
      // Not a URL binding.
    }
    translated[name] = value;
  }
  return translated;
}

function translateAddresses(internalAddresses, ports) {
  const byContainerPort = new Map(ports.map((entry) => [entry.containerPort, entry]));
  const addresses = {};
  for (const [key, address] of Object.entries(internalAddresses ?? {})) {
    const mapping = byContainerPort.get(address.port);
    if (mapping) addresses[key] = { host: "127.0.0.1", port: mapping.hostPort };
  }
  return addresses;
}

// Wait for the world to finish loading, and say what is usable before it does.
//
// `bindings.json` still marks a world that is FULLY ready, so nothing that runs
// after `up` ever sees a half-seeded world. But the Workbench is listening long
// before that -- measured on the default world, about 2 seconds against 117 --
// and there is no reason to make somebody watch a blank terminal while it is
// already open. When the container publishes `workbench.json`, `onWorkbench`
// fires once with its URL.
// Can this image name be fetched from a registry?
//
// `worldfixture:local` cannot: it names something built on this machine, and a
// pull would spend a network round trip to fail. A name with a registry host or
// an organization prefix can. Getting this wrong is user-visible in both
// directions -- a pointless pull before an honest error, or an honest error
// where a pull would have worked -- so it is decided from the shape of the name.
function isPullable(image) {
  const path = String(image).split("@")[0].split(":")[0];
  if (!path.includes("/")) return false;
  return !path.startsWith("localhost/") && !path.startsWith("127.0.0.1");
}

// Fetch the image if this machine does not have it.
//
// An npm install ships the CLI and the world and no image, so a first `up` on a
// new machine has nothing to run. This is the whole difference between
// `npx worldfixture up` working and printing an instruction. npm does nothing
// special here: the CLI runs the `docker` the user already has, which `doctor`
// already checks for.
//
// Progress is reported because the image is large and a silent minute reads as
// a hang.
export async function ensureHostImage(image, { runner = run, onProgress } = {}) {
  try {
    await runner("docker", ["image", "inspect", image, "--format", "{{.Id}}"]);
    return { pulled: false };
  } catch (error) {
    if (!isPullable(image)) throw error;
  }

  onProgress?.(image);
  try {
    await runner("docker", ["pull", image], { maxBuffer: 8 * 1024 * 1024 });
  } catch (error) {
    throw new HostLauncherError(
      "image_unavailable",
      `${image} is not on this machine and could not be pulled: ` +
        String(error.stderr ?? error.message).trim().split("\n").pop(),
      "Check the name and that you can reach the registry, or point at an image you already have with WORLDFIXTURE_IMAGE=<name>.",
    );
  }
  return { pulled: true };
}

async function waitForStart(stateDir, containerId, timeoutMs, runner = run, onWorkbench, byContainerPort = new Map(), onProgress) {
  const deadline = Date.now() + timeoutMs;
  const bindingsPath = join(stateDir, "bindings.json");
  const lockPath = join(stateDir, "environment.lock.json");
  const workbenchPath = join(stateDir, "workbench.json");
  const progressPath = join(stateDir, "progress.json");
  let announced = false;
  let lastProgress = "";
  while (Date.now() < deadline) {
    if (!announced) {
      const workbench = readJson(workbenchPath);
      if (workbench?.url) {
        announced = true;
        // TRANSLATED, NOT PRINTED RAW. The container knows only its own inside
        // address; Docker maps that to whatever host port was free. Every other
        // binding goes through `translateBindings` for this reason and this one
        // did not, so the early line printed the container's port.
        //
        // It hid because 4715 is usually free, so both numbers matched. When it
        // is taken -- the fallback case this launcher exists for -- the URL named
        // a real listener belonging to ANOTHER instance, which looks like it
        // worked. Measured: a second world published its Workbench on 62391
        // while the printed line said 4715, which was the first world's.
        onWorkbench?.(translateBindings({ WORKBENCH_URL: workbench.url }, byContainerPort).WORKBENCH_URL);
      }
    }
    // The container publishes what it is doing; report it only when it changes,
    // so a caller can render one line rather than a scrolling log.
    if (onProgress) {
      const progress = readJson(progressPath);
      const seen = progress ? JSON.stringify(progress.services) + progress.phase : "";
      if (progress && seen !== lastProgress) {
        lastProgress = seen;
        onProgress(progress);
      }
    }

    if (existsSync(bindingsPath) && existsSync(lockPath)) return;
    const { stdout } = await runner("docker", ["inspect", containerId, "--format", "{{json .State}}"]);
    const state = JSON.parse(stdout);
    if (!state.Running) {
      const logs = await runner("docker", ["logs", containerId]).then((result) => result.stdout + result.stderr, () => "");
      throw new Error(`the WorldFixture container stopped during startup\n${logs.trim()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`the WorldFixture container did not become ready in ${Math.round(timeoutMs / 1000)} seconds`);
}

export async function launchHostInstance({
  stateDir,
  image = "worldfixture:local",
  timeoutMs = 300_000,
  connectorToken,
  projectConfig,
  generatedSecretsPath,
  runner = run,
  selectPorts = selectHostPorts,
  onWorkbench,
  // `onPull` is called with ONE ARGUMENT, THE IMAGE NAME, because that is what
  // its only caller prints: `cli.mjs` renders it as `Fetching <name>`. A port
  // retry is a different event with nothing to fetch, so it gets its own
  // callback. Reusing `onPull` for it printed `Fetching    [object Object]`
  // followed by "about 190 MB, once" -- reproduced against the port-retry
  // runner before this was split.
  onPull,
  onPortRetry,
  onProgress,
  containerArgs = [],
}) {
  const running = await inspectHostInstance(stateDir, { runner });
  if (running) {
    const bindings = hostBindings(stateDir);
    if (bindings && !running.recovered) return { reused: true, instance: running, bindings };
    throw new HostLauncherError(
      "host_container_unrecorded",
      `container ${running.container_name} is running, but its local instance record is missing`,
      "`worldfixture down`, then `worldfixture up`.",
    );
  }
  removeHostRecord(stateDir);

  // These files are live-instance pointers. The lock and SQLite state remain
  // for diagnosis and for the next accepted start.
  // `progress.json` is cleared with the rest: a stale one describes the last run.
  for (const file of ["bindings.json", "addresses.json", "workbench.json", "control.sock", "progress.json"]) {
    rmSync(join(stateDir, file), { force: true });
  }

  const services = new Set(projectConfig?.services ?? []);
  const surfaces = HOST_SURFACES.filter((surface) =>
    !["postgres", "mysql"].includes(surface.name) || services.has(surface.name));
  // Before any port is reserved: a pull can take minutes, and holding eighteen
  // sockets through it would block anything else that wanted them.
  await ensureHostImage(image, { runner, onProgress: onPull });

  // One attempt per port Docker refuses, plus the first. Bounded, because a
  // machine where every candidate is taken should say so rather than spin.
  const avoid = new Set();
  for (let attempt = 0; ; attempt += 1) {
  const ports = await selectPorts(surfaces, { avoid });
  let containerId;
  try {
    const { stdout: imageIdText } = await runner("docker", ["image", "inspect", image, "--format", "{{.Id}}"]);
    const imageId = imageIdText.trim();
    if (!imageId.startsWith("sha256:")) throw new Error(`Docker did not resolve ${image} to an image digest`);
    const name = hostContainerName(stateDir);
    const args = ["run", "--detach", "--rm", "--name", name,
      "--label", "org.worldfixture.instance=local",
      "--mount", `type=bind,source=${stateDir},target=/state`];
    if (generatedSecretsPath) {
      args.push("--mount", `type=bind,source=${generatedSecretsPath},target=/state/project-generated-secrets.json`);
      args.push("--env", "WORLDFIXTURE_GENERATED_SECRETS_PATH=/state/project-generated-secrets.json");
    }
    // The token is passed by NAME, and its value is handed to Docker through the
    // child's environment instead of its argument list.
    //
    // WHY. `--env WORLDFIXTURE_TOKEN=<value>` put the local secret in argv, and
    // argv is not private: every user on the machine can read it out of `ps`
    // while the command runs, and `execFile` puts the whole command line into
    // the `Error.message` it throws -- so a `docker run` that failed for any
    // reason at all printed the token in cleartext into the terminal, into
    // scrollback, and into CI logs. `security.md` promises that WorldFixture
    // never writes the token to command output. It does now.
    //
    // `--env NAME` with no `=` tells Docker to take the value from its own
    // environment, which is the one place it is not observable.
    const childEnvironment = { ...process.env };
    if (connectorToken) {
      args.push("--env", "WORLDFIXTURE_TOKEN");
      childEnvironment.WORLDFIXTURE_TOKEN = connectorToken;
    }
    if (projectConfig) args.push("--env", `WORLDFIXTURE_PROJECT_CONFIG=${JSON.stringify(projectConfig)}`);
    const notionPort = ports.find((entry) => entry.name === "notion");
    if (notionPort) {
      // Notion Page objects contain a web-application URL. The emulator listens
      // on its fixed container port, but an application uses Docker's selected
      // host port. Give the provider that advertised origin before it starts so
      // its API response is usable without a Workbench-only rewrite.
      args.push("--env", "WORLDFIXTURE_NOTION_PUBLIC_BASE_URL");
      childEnvironment.WORLDFIXTURE_NOTION_PUBLIC_BASE_URL = `http://127.0.0.1:${notionPort.hostPort}`;
    }
    for (const entry of ports) args.push("--publish", `127.0.0.1:${entry.hostPort}:${entry.containerPort}`);
    args.push(imageId);

    // Arguments for the world itself, appended after the image so Docker passes
    // them to the entry point as its command. `--only slack,github` is the
    // reason this exists: without forwarding, the flag was accepted on the host
    // and silently dropped, and the container started every part of the world
    // while the caller believed it had asked for two.
    args.push(...containerArgs);

    // Docker cannot claim a host port while the reservation owns it. Release
    // all reservations immediately before one `docker run` call.
    await Promise.all(ports.map((entry) => entry.release()));
    const { stdout } = await runner("docker", args, { maxBuffer: 1024 * 1024, env: childEnvironment });
    containerId = stdout.trim();

    // Built before the wait, because the early Workbench announcement needs it
    // to turn the container's own port into the one Docker published.
    const byContainerPort = new Map(ports.map((entry) => [entry.containerPort, entry]));
    await waitForStart(stateDir, containerId, timeoutMs, runner, onWorkbench, byContainerPort, onProgress);

    const lock = readJson(join(stateDir, "environment.lock.json"));
    const internalBindings = readJson(join(stateDir, "bindings.json"));
    if (!lock || !internalBindings) throw new Error("the container did not publish its environment lock and bindings");
    const bindings = translateBindings(internalBindings, byContainerPort);
    const internalAddresses = readJson(join(stateDir, "addresses.json"));
    const addresses = translateAddresses(internalAddresses, ports);
    const instance = {
      api_version: "worldfixture.host-instance/v1",
      container_id: containerId,
      container_name: name,
      image,
      image_id: imageId,
      state_dir: stateDir,
      ports: ports.map(({ release, ...entry }) => entry),
    };
    writeFileSync(join(stateDir, FILES.bindings), `${JSON.stringify(bindings, null, 2)}\n`, { mode: 0o600 });
    writeFileSync(join(stateDir, FILES.addresses), `${JSON.stringify(addresses, null, 2)}\n`);
    writeFileSync(join(stateDir, FILES.instance), `${JSON.stringify(instance, null, 2)}\n`);
    return { reused: false, instance, bindings };
  } catch (error) {
    await Promise.all(ports.map((entry) => entry.release().catch(() => {})));
    if (containerId) await runner("docker", ["stop", "--time", "10", containerId]).catch(() => {});
    removeHostRecord(stateDir);

    const refused = refusedPort(error);
    if (refused !== null && !avoid.has(refused) && attempt < surfaces.length) {
      avoid.add(refused);
      onPortRetry?.(refused);
      continue;
    }
    if (refused !== null) {
      throw new HostLauncherError(
        "port_unavailable",
        `Docker cannot publish port ${refused}: another container already has it`,
        "Stop whatever is publishing that port, or run `docker ps` to find it.",
      );
    }
    throw error;
  }
  }
}

export async function resetHostInstance(stateDir) {
  const instance = await inspectHostInstance(stateDir);
  if (!instance) throw new Error("No host instance is running. Run `worldfixture up` first.");
  const { stdout } = await run("docker", ["exec", instance.container_id,
    "node", "runtime/bin/worldfixture.mjs", "reset", "--state", "/state"],
  { timeout: 180_000 });
  return stdout.trim();
}

// A NON-ZERO EXIT IS THE COMMAND ANSWERING, NOT THE TRANSPORT FAILING.
//
// `run` is a promisified `execFile`, which rejects when the child exits
// non-zero. Nothing caught it, so a CLI inside the container that deliberately
// refused -- printing its reason and setting `process.exitCode = 1` -- reached
// the user as an unhandled Node error and a six-frame stack, with the written
// answer buried in `error.stdout` where nobody reads it. Measured against the
// published image:
//
//     $ worldfixture slack send --as maya --channel soc2-audit "test"
//     Error: Command failed: docker exec 5b3168...
//         at genericNodeError (node:internal/errors:999:15)
//       stdout: '"maya" names 2 people in this world. Say which one: ...'
//
// The first screen's own "Try this" line is a `slack send`, so this is where a
// new reader meets their first mistake. `streamInHostInstance` beside this
// already returns its exit code and lets the caller set `process.exitCode`;
// this is the buffered sibling agreeing with it.
//
// A spawn failure or a timeout still throws: those are the transport failing,
// and `error.code` is then a string like ENOENT or absent entirely, never the
// exit status of a command that ran.
export async function runInHostInstance(stateDir, argv, { timeoutMs = 120_000, runner = run } = {}) {
  const instance = await inspectHostInstance(stateDir, { runner });
  if (!instance) throw new Error("No host instance is running. Run `worldfixture up` first.");
  const command = ["exec", instance.container_id,
    "node", "runtime/bin/worldfixture.mjs", ...argv, "--state", "/state"];
  const options = { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 };

  try {
    const { stdout, stderr } = await runner("docker", command, options);
    return { stdout, stderr, code: 0 };
  } catch (error) {
    if (typeof error.code !== "number" || error.killed) throw error;
    return { stdout: error.stdout ?? "", stderr: error.stderr ?? "", code: error.code };
  }
}

// The same `docker exec` as above, streamed rather than buffered, for a command
// that does not end on its own.
//
// TWO THINGS MAKE THIS SAFE, and both were measured rather than assumed.
//
// `docker exec` does NOT forward signals to the process inside the container, so
// killing this client is not enough: the in-container process would keep running
// with nothing attached to it. `--interactive` is therefore not optional here —
// it gives the in-container process a stdin, and closing that stdin is the
// signal it watches for. `runtime/src/events.mjs` stops on stdin EOF for exactly
// this reason.
//
// The client is then killed as well, so the local process tree is clean whether
// or not the container is still there to receive the EOF.
export async function streamInHostInstance(stateDir, argv, { onOutput, signal, timeoutMs = 0 } = {}) {
  const instance = await inspectHostInstance(stateDir);
  if (!instance) throw new Error("No host instance is running. Run `worldfixture up` first.");

  // The EOF rule is opted into by this caller rather than inferred from stdin.
  // `docker exec` WITHOUT `--interactive` hands the process a closed stdin, so a
  // command that treated EOF as "stop" would exit instantly for anyone running
  // it by hand inside the container — which is a documented way to use this CLI.
  const child = spawn(
    "docker",
    ["exec", "--interactive", "--env", "WORLDFIXTURE_STOP_ON_STDIN_EOF=1", instance.container_id,
      "node", "runtime/bin/worldfixture.mjs", ...argv, "--state", "/state"],
    { stdio: ["pipe", "pipe", "pipe"] },
  );

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => onOutput?.(chunk, "stdout"));
  child.stderr.on("data", (chunk) => onOutput?.(chunk, "stderr"));

  const stop = () => {
    // Close the container end first. The in-container process sees EOF and
    // exits; killing the client alone would leave it running.
    child.stdin.end();
    setTimeout(() => child.kill("SIGTERM"), 250).unref();
  };

  if (signal) {
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
  }

  const timer = timeoutMs > 0 ? setTimeout(stop, timeoutMs) : null;
  timer?.unref();

  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", resolve);
  });

  if (timer) clearTimeout(timer);
  signal?.removeEventListener("abort", stop);
  return { code };
}

export async function stopHostInstance(stateDir, { runner = run } = {}) {
  const instance = await inspectHostInstance(stateDir, { runner });
  if (!instance?.container_id) return false;
  try {
    await runner("docker", ["stop", "--time", "15", instance.container_id], { timeout: 30_000 });
  } catch (error) {
    const live = await inspectHostInstance(stateDir, { runner });
    if (live) throw error;
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await runner("docker", ["inspect", instance.container_id]);
      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch {
      removeHostRecord(stateDir);
      return true;
    }
  }
  throw new Error(`container ${instance.container_id.slice(0, 12)} stopped but Docker did not remove it`);
}
