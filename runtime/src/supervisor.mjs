// The supervisor: one lock in, a running world out.
//
// It does the eight things `extraction-plan.md` asks of it, in order: read a
// validated lock, verify the artifact, create the SQLite state, start only the
// selected services, let each load its own projections, prove each one with a
// protocol-level check, report one aggregate readiness result, and terminate
// every child on shutdown.
//
// TWO RULES IT IS BUILT AROUND.
//
// A SERVICE IS NEVER READY BECAUSE IT SAID SO. Child output is captured for
// `status --verbose` and for a failure message, and it is never consulted to
// decide readiness. That is `readiness.mjs`'s job and it speaks the protocol.
// A service that prints "listening" and serves nothing has happened here twice.
//
// NOTHING SURVIVES SHUTDOWN. A joined fixture whose supervisor exits leaves
// children holding ports, and the next run then fails to bind or -- worse --
// talks to the previous run. Children are killed as a group and waited for.

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { shareHostOwnership } from './host-state-ownership.mjs';
import { forgetSlackCaches } from "./slack.mjs";
import { startClock, pauseClock } from "./clock.mjs";
import { executionPreflight } from "./execution-preflight.mjs";
import { lifecyclePath } from "./lifecycle-paths.mjs";
import { aggregate, waitFor } from "./readiness.mjs";
import { allocate, environmentFor } from "./ports.mjs";
import { openState, recordInstance, resetState } from "./state.mjs";
import { serializeLock } from "./resolve.mjs";
import { CREDENTIALS_FILE, prepareCredentials } from "./credentials.mjs";
import { resolveBindings } from "./bindings.mjs";

export class StartupError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = "StartupError";
    this.code = code;
    this.detail = detail;
    // Every failure has to say whether any state changed. A startup failure
    // that has not yet written the instance row has changed none, and saying so
    // is the difference between a retry and a support conversation.
    this.state_changed = detail.state_changed ?? false;
  }
}

// ---- the artifact --------------------------------------------------------

// The lock pins a digest for every artifact file a selected service reads. Only
// the composer verifies its own projection, so for the other three this is the
// only check that happens at all.
export function verifyArtifact(lock, artifactPath) {
  const failures = [];

  for (const [file, expected] of Object.entries(lock.world.projections)) {
    const path = join(artifactPath, file);

    if (!existsSync(path)) {
      failures.push(`${file} is missing`);
      continue;
    }

    const bytes = readFileSync(path);
    const actual = createHash("sha256").update(bytes).digest("hex");

    if (bytes.length !== expected.size) {
      failures.push(`${file} is ${bytes.length} bytes, the lock pins ${expected.size}`);
    } else if (actual !== expected.sha256) {
      // A size-preserving edit is exactly the case a length check misses.
      failures.push(`${file} has digest ${actual}, the lock pins ${expected.sha256}`);
    }
  }

  if (failures.length > 0) {
    throw new StartupError(
      "artifact_mismatch",
      `the world artifact at ${artifactPath} is not the one this lock resolved:\n  ${failures.join("\n  ")}`,
      { artifactPath, failures },
    );
  }
}

// ---- children ------------------------------------------------------------

// Everything a child said, bounded. Kept for a failure message and for
// `status --verbose`, and never read to decide whether a service is ready.
class Log {
  #lines = [];
  #limit;

  constructor(limit = 200) {
    this.#limit = limit;
  }

  append(stream, chunk) {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (line.trim() === "") continue;
      this.#lines.push({ stream, line });
      if (this.#lines.length > this.#limit) this.#lines.shift();
    }
  }

  tail(count = 20) {
    return this.#lines.slice(-count);
  }
}

// Two ways to start a service, and the manifest says which.
//
// A `command` is a child process in this image, which is the packaging the
// project is aiming at: one container, one supervisor, children inside it.
//
// A `container` is the checkout fallback for a service whose system packages
// are installed only in the all-in-one image. The runner makes the choice
// explicit: checkout runs use the service container; the image uses `command`
// and never tries to start Docker inside Docker.
function startChild(service, environment, { cwd, allocation, worldPath, runner, onExit, credentialsPath }) {
  const log = new Log();
  const useContainer = Boolean(service.container) && runner !== "process";
  const { command, args, label } = useContainer
    ? dockerInvocation(service, environment, { allocation, worldPath, credentialsPath })
    : { command: service.command?.[0], args: service.command?.slice(1), label: "process" };

  if (!command) {
    throw new StartupError(
      "no_command",
      `${service.name} declares neither runtime.command nor runtime.container, so nothing can start it`,
      { service: service.name },
    );
  }

  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...environment },
    stdio: ["ignore", "pipe", "pipe"],
    // Its own process group, so shutdown can take the whole tree. A service that
    // supervises children of its own -- mail runs four -- otherwise leaves them.
    detached: true,
  });
  child.label = label;

  child.stdout.on("data", (chunk) => log.append("stdout", chunk));
  child.stderr.on("data", (chunk) => log.append("stderr", chunk));

  const record = {
    service: service.name,
    child,
    log,
    exited: null,
    container: useContainer ? service.container.name : undefined,
    launch: { service, environment, cwd, allocation, worldPath, runner, credentialsPath, onExit },
  };

  child.on("error", (error) => {
    log.append("stderr", `Cannot start ${service.name}: ${error.message}`);
    record.exited = { code: null, signal: null, error: error.message };
    record.launch.onExit?.(record);
  });
  child.on("exit", (code, signal) => {
    record.exited = { code, signal };
    record.launch.onExit?.(record);
  });

  return record;
}

// `docker run` in the foreground, so the child process the supervisor holds is
// the container's own lifetime. `--rm` and `--init` mean a stopped run leaves
// neither a container nor a zombie, which is the same promise the process path
// makes.
export function dockerInvocation(service, environment, { allocation, worldPath, credentialsPath }) {
  const spec = service.container;
  const args = ["run", "--rm", "--init", "--name", spec.name];

  if (spec.platform) args.push("--platform", spec.platform);

  for (const port of service.ports) {
    const assigned = allocation.get(`${service.name}/${port.name}`);
    if (assigned.containerLoopback) continue;
    if (assigned.publishOn !== "127.0.0.1") throw new Error(`Host publication must use loopback: ${service.name}/${port.name}`);
    args.push("-p", `${assigned.publishOn}:${assigned.number}:${assigned.serverPort}`);
  }

  for (const mount of spec.mounts ?? []) {
    if (mount.source !== "world.path") throw new Error(`unknown mount source ${mount.source}`);
    args.push("-v", `${worldPath}:${mount.target}:${mount.mode ?? "ro"}`);
  }

  if (credentialsPath) args.push("--mount", `type=bind,source=${credentialsPath},target=/worldfixture-credentials.json,readonly`);
  for (const name of Object.keys(environment)) args.push("-e", name);

  args.push(spec.tag);
  return { command: "docker", args, label: `container ${spec.name}` };
}

// ---- the instance --------------------------------------------------------

export class Instance {
  constructor({ lock, allocation, children, state, id, stateDir, readyTimeoutMs, runtimeToken }) {
    this.lock = lock;
    this.allocation = allocation;
    this.children = children;
    this.state = state;
    this.id = id;
    this.stateDir = stateDir;
    this.readyTimeoutMs = readyTimeoutMs;
    this.runtimeToken = runtimeToken;
    // What this instance is doing right now. The Workbench opens while the world
    // is still loading, and without this it can only report what it sees: seven
    // providers refusing connections, which looks like a broken world and is
    // actually a working one mid-startup.
    this.phase = "starting";
    this.readiness = new Map();
    this.serviceStates = new Map(lock.services.map((service) => [service.name, "starting"]));
  }

  childExited(record) {
    if (record.expectedStop) return;
    this.readinessAbort?.abort(record);
    this.serviceStates.set(record.service, "failed");
    this.readiness.set(record.service, { ready: false, seeded: false, proven: 0, checks: [], reason: `Service process exited (${record.exited?.code ?? record.exited?.signal ?? "unknown"})` });
    if (this.phase !== "stopped") this.phase = "failed";
    publishProgress(this);
  }

  addressOf(service, port) {
    const assigned = this.allocation.get(`${service}/${port}`);
    if (!assigned) throw new Error(`no allocation for ${service}/${port}`);
    if (assigned.contained && assigned.containerLoopback) {
      const container = this.children.find(record => record.service === service)?.container;
      if (!container) throw new Error(`No container for private port ${service}/${port}`);
      return { host: "127.0.0.1", port: assigned.serverPort, container };
    }
    return { host: assigned.host, port: assigned.number };
  }

  // Every address this run allocated, including the private ones an application
  // never receives. `bindings()` is what a target gets; this is what the runtime
  // knows, and `status` needs it to probe a seed gate on a back channel.
  addresses() {
    const addresses = {};
    for (const [key, assigned] of this.allocation) {
      addresses[key] = {
        ...this.addressOf(assigned.service, assigned.port),
        protocol: assigned.protocol,
        published: assigned.published,
      };
    }
    return addresses;
  }

  // What `worldfixture status` reports, and what `up` prints a subset of.
  bindings() {
    const { resolved } = resolveBindings(this.lock, {
      artifactPath: this.artifactPath,
      addressOf: (service, port) => this.addressOf(service, port),
      credentials: this.credentials,
    });
    return Object.fromEntries(Object.entries(resolved).map(([name, entry]) => [name, entry.value]));
  }

  // Stop new work and terminate every child, then wait. SIGTERM to the process
  // group first; a child that ignores it gets SIGKILL rather than the run
  // hanging on shutdown.
  async stopChildren({ graceMs = 15_000, services = null } = {}) {
    const selected = services ? new Set(services) : null;
    const records = selected
      ? this.children.filter((record) => selected.has(record.service))
      : this.children;
    const running = records.filter((record) => record.exited === null);
    for (const record of records) record.expectedStop = true;

    // A container outlives the `docker run` client that started it, so killing
    // the client alone leaves the container up and its ports held. `docker stop`
    // is the only thing that reaches it.
    await Promise.all(
      running
        .filter((record) => record.container)
        .map(
          (record) =>
            new Promise((resolve) => {
              const child = spawn("docker", ["stop", "-t", "5", record.container], { stdio: "ignore" });
              child.on("error", resolve);
              child.on("exit", resolve);
            }),
        ),
    );

    for (const record of running) {
      try {
        process.kill(-record.child.pid, "SIGTERM");
      } catch {
        try {
          record.child.kill("SIGTERM");
        } catch {
          /* already gone */
        }
      }
    }

    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline && records.some((record) => record.exited === null)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    for (const record of records.filter((r) => r.exited === null)) {
      try {
        process.kill(-record.child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }

    for (const record of records) this.serviceStates.set(record.service, "stopped");
    return records.map((record) => ({ service: record.service, exited: record.exited }));
  }

  async stop({ preserveServices = [], ...options } = {}) {
    await this.timelineControl?.stop();
    if (preserveServices.length) options.services = this.children.filter(record => !preserveServices.includes(record.service)).map(record => record.service);
    const stopped = await this.stopChildren(options);
    this.state?.close();
    return stopped;
  }

  async reset() {
    if (this.timelineControl) return this.timelineControl.command({ action: 'reset' });
    return this.restoreBaseline();
  }

  // Called only inside the controller queue, or by the legacy reset path.
  async restoreBaseline() {
    forgetSlackCaches();
    const resetNames = this.lock.services
      .filter((service) => service.lifecycle?.reset)
      .map((service) => service.name);
    const preservedNames = this.lock.services
      .filter((service) => !service.lifecycle?.reset)
      .map((service) => service.name);

    // Stop the timeline before the services. An arrival in flight holds a
    // provider write, and the next tick would otherwise fire at a Slack that is
    // no longer listening -- and would then be recorded as a failed arrival in a
    // world that is only being restored.
    await this.scheduler?.suspend();

    // Stop every application surface first. If restore fails, no caller can
    // observe a mixture of old and reset services.
    const resetRecords = this.children.filter((record) => resetNames.includes(record.service));
    const preservedRecords = this.children.filter((record) => preservedNames.includes(record.service));
    await this.stopChildren({ services: resetNames });
    const launches = resetRecords.map((record) => record.launch);
    this.children.length = 0;
    this.children.push(...preservedRecords);

    try {
      for (const launch of launches) {
        const contained = Boolean(launch.service.container) && launch.runner !== "process";
        if (contained) continue;
        for (const declared of launch.service.lifecycle?.state?.clear_paths ?? []) {
          rmSync(lifecyclePath(declared, this.stateDir), { recursive: true, force: true });
        }
        for (const [index, declared] of (launch.service.lifecycle?.state?.snapshot_paths ?? []).entries()) {
          const path = lifecyclePath(declared, this.stateDir);
          const baseline = join(this.stateDir, "baselines", launch.service.name, String(index));
          if (!existsSync(baseline)) throw new Error(`${launch.service.name} has no accepted baseline for ${declared}`);
          mkdirSync(dirnameOf(path), { recursive: true });
          cpSync(baseline, path, { recursive: true, preserveTimestamps: true });
        }
      }

      // Clear runtime-owned state while every application surface is still
      // stopped. Starting services first would create a short interval in which
      // provider state was restored but the old event ledger was still visible.
      resetState(this.state);

      for (const launch of launches) {
        this.serviceStates.set(launch.service.name, "starting");
        this.children.push(startChild(launch.service, launch.environment, launch));
      }
      await proveReady(this, { readyTimeoutMs: this.readyTimeoutMs });

      // The world's start includes things that have not happened yet, so a
      // restore that left the timeline spent would not be the accepted start.
      // `resetState` cleared the clock and the schedule; this re-arms both, and
      // the world plays its arrivals again from t+0.
      this.rearmTimeline?.();
      this.scheduler?.resume();
    } catch (error) {
      await this.stopChildren({ services: resetNames });
      if (error.detail?.service) this.serviceStates.set(error.detail.service, "failed");
      rmSync(join(this.stateDir, "bindings.json"), { force: true });
      rmSync(join(this.stateDir, "addresses.json"), { force: true });
      // Left suspended on purpose: provider services are stopped, so an arrival now
      // would be recorded as failed against a world that is not running.
      throw new StartupError("reset_failed", `reset failed and provider services were stopped: ${error.message}`, {
        service: error.detail?.service,
        state_changed: true,
      });
    }

    return { services: resetNames, preserved: preservedNames };
  }
}

// ---- startup -------------------------------------------------------------

// Where a service reads the world.
//
// A container reads it at its mount point; a child process reads it where it
// lies. Handing a container the host path would name a directory that does not
// exist inside it.
//
// WHICH IS WHAT THE OLD `?? artifactPath` DID for a container that mounts no
// world. mysql and postgres are both container services with no `world.path`
// mount, and both declare `WORLDFIXTURE_WORLD_PATH` from `world.path` -- so each
// was started with the host path to dist/ set inside it, the exact thing the
// paragraph above says must not happen. Nothing in the MariaDB or Postgres
// images reads that variable, so it never showed; it would have shown the first
// time one did.
//
// `undefined` is the honest answer, and `environmentFor` already handles it:
// the variable is declared `required: false`, so it is left unset rather than
// set to a lie.
export function worldPathFor(service, artifactPath, useContainer) {
  if (!useContainer) return artifactPath;
  return (service.container.mounts ?? []).find((mount) => mount.source === "world.path")?.target;
}

export async function start(lock, {
  artifactPath,
  stateDir,
  serviceRoot,
  // THE STARTUP BUDGET, NOT A PROTOCOL TIMEOUT. Each readiness probe has its own
  // short timeout; this is how long the whole world may take to finish loading.
  //
  // Measured on 2026-09-03, native arm64: the small world reaches readiness in
  // about 30 seconds and the large one in 86-88, because Cyrus creates a mailbox
  // per person and delivers every seeded message over LMTP -- 74 messages in the
  // small world against 3,069 in the large one. At 90 seconds the large world
  // failed eight CLI tests at the 91-second mark, having very nearly finished.
  //
  // Raised to give a world that IS loading room to finish rather than reporting a
  // working service as broken. A service that is genuinely not coming up still
  // fails, because every probe underneath reports its own refusal.
  readyTimeoutMs = 300_000,
  now = () => Date.now(),
  runner = "container",
  inContainer = false,
  fixedPorts,
  runtimeToken = process.env.WORLDFIXTURE_TOKEN || randomUUID(),
  generatedSecretsPath = join(stateDir, "generated-secrets.json"),
  onSpawned,
  generation,
  preservedChildren = [],
  preservedAllocation = new Map(),
  preservedCredentials = {},
  manageSignals = true,
  // Where a startup step that takes minutes says so. `ensureImage` has written
  // its "this happens once" line since it was added, and nothing ever carried
  // it: the only call site passed two arguments, so the default no-op `log`
  // swallowed every message. A checkout run that had to build an image sat
  // silent for the whole build.
  onNotice,
  // Where this run reports what it is doing, for a caller in the same process.
  // The container route reads `progress.json` off the bind mount instead; this
  // is the same information handed straight over, so `up --direct` can say what
  // is loading rather than sitting silent for a minute and a half.
  onProgress,
}) {
  verifyArtifact(lock, artifactPath);
  const selectedWorld = JSON.parse(readFileSync(join(artifactPath, "world.json"), "utf8"));
  const execution = executionPreflight(selectedWorld, { artifactPath, capabilities: lock.capabilities,
    rules: lock.rules ?? [], applicationTarget: lock.target?.application_url, allowUnselected: Boolean(lock.execution?.timeline),
    deferApplicationConnection: lock.execution?.application_connection?.status === 'pending' });
  if (execution.errors.length) throw new StartupError("invalid_execution_contract", execution.errors.join("; "));
  // New process-run providers must discard the previous generation's seed
  // markers and storage, including approved absolute mail and S3 paths. A new
  // service container owns fresh storage; never remove its paths on the host.
  for (const service of lock.services) {
    if (!service.lifecycle?.reset || (service.container && runner !== 'process')) continue;
    for (const path of service.lifecycle?.state?.clear_paths ?? []) {
      rmSync(lifecyclePath(path, stateDir), { recursive: true, force: true });
    }
  }
  const credentials = await prepareCredentials({ lock, artifactPath, stateDir, generatedSecretsPath, generation, preservedCredentials });
  const credentialsPath = join(stateDir, CREDENTIALS_FILE);

  // This is a new instance even when it reuses a state directory. A baseline
  // never follows another run or another lock.
  rmSync(join(stateDir, "baselines"), { recursive: true, force: true });
  rmSync(join(stateDir, "emulate-snapshot.json"), { force: true });

  const id = randomUUID();
  const lockSha256 = createHash("sha256").update(serializeLock(lock)).digest("hex");
  const worldSha256 = lock.world.artifact_sha256;
  const { allocation, release } = await allocate(lock, { runner, inContainer, fixedPorts, preservedAllocation });
  const state = openState(join(stateDir, "state.sqlite"));
  // A fresh provider seed starts a fresh schedule. Connector receipts survive:
  // the application is preserved and event IDs include the world identity.
  resetState(state);
  state.exec('DELETE FROM timeline_cycle');
  const startupTime = now();
  recordInstance(state, { id, lock, lockSha256, startedAt: startupTime });
  startClock(state, { anchor: selectedWorld.clock?.anchor ?? "", now: startupTime });
  pauseClock(state, { now: startupTime });

  const children = [...preservedChildren];
  const instance = new Instance({ lock, allocation, children, state, id, stateDir, readyTimeoutMs, runtimeToken });
  // Published before anything is started, so a caller learns the full list of
  // services -- and can name every one of them -- from the first report rather
  // than watching the list grow.
  instance.onProgress = onProgress;
  publishProgress(instance);
  instance.credentials = credentials;
  instance.generation = generation;
  instance.artifactPath = artifactPath;
  const preservedNames = new Set(preservedChildren.map(record => record.service));
  for (const record of preservedChildren) record.launch.onExit = exited => instance.childExited(exited);

  // Every reservation is released together, immediately before the first spawn,
  // so no child inherits a socket the supervisor is still holding.
  await release();

  // AN INTERRUPT DURING STARTUP MUST STILL TEAR DOWN.
  //
  // `cli.mjs` arms its own SIGINT handler, but only once readiness has passed and
  // the screen is on the terminal. Everything before that -- pulling an image,
  // starting Cyrus, seeding thousands of messages -- ran with Node's default
  // SIGINT behaviour, which kills this process and leaves every service container
  // running. Measured: interrupting the CLI suite mid-startup left seven mail
  // containers up, one per test, holding their ports.
  //
  // So startup arms its own handler and hands responsibility back to the caller
  // the moment it returns. The comment in `runUntilInterrupted` describes exactly
  // this orphan; the window it warned about was still open here.
  let interrupted = null;
  const onInterrupt = (signal) => {
    interrupted = signal;
    instance.stop().then(
      () => process.exit(130),
      () => process.exit(130),
    );
  };
  if (manageSignals) { process.on("SIGINT", onInterrupt); process.on("SIGTERM", onInterrupt); }
  const disarm = () => {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onInterrupt);
  };

  try {
    for (const service of lock.services) {
      if (preservedNames.has(service.name)) continue;
      const useContainer = Boolean(service.container) && runner !== "process";
      if (useContainer) {
        // One container per service per run, named after the instance so a
        // second `up` cannot adopt or collide with the first one's containers.
        service.container.name = `worldfixture-${id.slice(0, 8)}-${service.name}`;
        await ensureImage(service, join(serviceRoot, service.name), { log: onNotice });
      }

      const worldPath = worldPathFor(service, artifactPath, useContainer);

      const environment = environmentFor(service, allocation, {
        worldPath,
        worldSha256,
        runtimeToken,
        statePath: stateDir,
        credentials,
      });
      const usesCredentials = ["emulate", "mail"].includes(service.name);
      if (usesCredentials) environment.WORLDFIXTURE_CREDENTIALS = useContainer ? "/worldfixture-credentials.json" : credentialsPath;
      children.push(
        startChild(service, environment, {
          cwd: join(serviceRoot, service.name),
          allocation,
          worldPath: artifactPath,
          runner,
          credentialsPath: usesCredentials ? credentialsPath : undefined,
          onExit: record => instance.childExited(record),
        }),
      );
    }

    // THE WORLD IS WORTH LOOKING AT BEFORE IT IS FINISHED LOADING.
    //
    // Measured on the default world, native arm64: the thirteen provider APIs
    // answer at 3.6s, the HTTP site at 3.6s, IMAP at 5.6s and S3 at 13.1s, while
    // SMTP does not bind until 64s because Cyrus seeds every mailbox first, and
    // full readiness lands at about 94s. The Workbench reads the providers and
    // needs none of what the wait is for, so gating it behind full readiness
    // cost a user eighty seconds of staring at nothing.
    //
    // `onSpawned` runs once every child exists and every port is allocated. What
    // it starts must tolerate a service that is not answering yet; the Workbench
    // does, because its provider sweep is `Promise.allSettled` and reports a
    // failure per provider.
    if (onSpawned) await onSpawned(instance);

    await proveReady(instance, { readyTimeoutMs });
    await captureBaselines(instance, runner);
  } catch (error) {
    disarm();
    await instance.stop({ preserveServices: [...preservedNames] });
    throw error;
  }

  disarm();
  if (interrupted) await instance.stop();
  return instance;
}

function dirnameOf(path) {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

// What the run is doing, written where the host can see it.
//
// WHY A FILE. The instance already knows its phase and the state of every
// service, and all of that lives in memory INSIDE the container. On the host,
// `up` printed the Workbench URL after a second and then said nothing at all
// for another ninety, because the only thing it could observe was the eventual
// appearance of `bindings.json`. Ninety seconds of silence reads as a hang, and
// the honest answer -- mail is delivering 3,069 messages over LMTP, everything
// else is already up -- was known the whole time and had nowhere to go.
//
// Written on every transition and read by whoever wants it. Best-effort: a run
// must not fail because a progress file could not be written.
export function publishProgress(instance) {
  const progress = {
    api_version: "worldfixture.progress/v1",
    phase: instance.phase,
    services: Object.fromEntries(instance.serviceStates),
    updated_at: new Date().toISOString(),
  };
  try {
    instance.onProgress?.(progress);
  } catch {
    // A run whose caller cannot render its progress still runs.
  }
  if (!instance.stateDir) return;
  try {
    writeFileSync(join(instance.stateDir, "progress.json"), `${JSON.stringify(progress)}\n`);
    shareHostOwnership(join(instance.stateDir, "progress.json"));
  } catch {
    // A run that cannot report its progress still runs.
  }
}

async function captureBaselines(instance, runner) {
  const services = instance.lock.services.filter(
    (service) =>
      service.lifecycle?.reset && !(Boolean(service.container) && runner !== "process") &&
      (service.lifecycle?.state?.snapshot_paths?.length ?? 0) > 0,
  );
  if (services.length === 0) {
    instance.phase = "ready";
    publishProgress(instance);
    return;
  }

  instance.phase = "capturing-baseline";
  publishProgress(instance);

  // Mail and SeaweedFS keep state in files that can change while they run.
  // Copying those files live can make a baseline that never existed. Stop only
  // resettable providers, copy the quiet state, then prove their baseline again.
  // Application database processes continue to own their data and credentials.
  const resettable = new Set(instance.lock.services.filter(service => service.lifecycle?.reset).map(service => service.name));
  const launches = instance.children.filter(record => resettable.has(record.service)).map(record => record.launch);
  const preserved = instance.children.filter(record => !resettable.has(record.service));
  await instance.stopChildren({ services: [...resettable] });
  instance.children.length = 0;
  instance.children.push(...preserved);

  for (const service of services) {
    for (const [index, declared] of service.lifecycle.state.snapshot_paths.entries()) {
      const path = lifecyclePath(declared, instance.stateDir);
      if (!existsSync(path)) throw new Error(`${service.name} accepted readiness without reset state ${path}`);
      const baseline = join(instance.stateDir, "baselines", service.name, String(index));
      mkdirSync(dirnameOf(baseline), { recursive: true });
      cpSync(path, baseline, { recursive: true, preserveTimestamps: true });
    }
  }

  for (const launch of launches) {
    instance.children.push(startChild(launch.service, launch.environment, launch));
  }
  await proveReady(instance, { readyTimeoutMs: instance.readyTimeoutMs });
  instance.phase = "ready";
  publishProgress(instance);
}

// Build a service's image when this machine does not have it.
//
// A missing image is the normal first-run case and takes minutes, so it says so
// rather than looking hung. An image that exists is left alone: rebuilding on
// every start would make `up` unusable and would silently change what a run is.
async function ensureImage(service, context, { log = () => {} } = {}) {
  const { tag, build, platform } = service.container;

  if (await imageExists(tag)) return;

  if (!build) {
    throw new StartupError(
      "image_missing",
      `${service.name} needs the image ${tag}, which this machine does not have and the manifest cannot build`,
      { service: service.name, tag },
    );
  }

  log(`building ${tag} for ${service.name}; this happens once`);

  const args = ["build"];
  if (platform) args.push("--platform", platform);
  args.push("-t", tag, build);

  await new Promise((resolve, reject) => {
    const child = spawn("docker", args, { cwd: context, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(
            new StartupError("image_build_failed", `building ${tag} for ${service.name} failed`, {
              service: service.name,
              tag,
              log: output.split("\n").slice(-20).map((line) => ({ stream: "docker", line })),
            }),
          ),
    );
  });
}

function imageExists(tag) {
  return new Promise((resolve) => {
    const child = spawn("docker", ["image", "inspect", tag], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

// Wait for every service to answer its own checks, then report one aggregate.
//
// Seed gates are awaited before protocol checks, because a service still loading
// its world will refuse a protocol call for a reason that is not a fault.
async function proveReady(instance, { readyTimeoutMs }) {
  const controller = new AbortController();
  instance.readinessAbort = controller;
  const failedChild = () => instance.children.find(child => child.exited !== null && !child.expectedStop);
  const failIfExited = () => {
    const child = failedChild();
    if (child) throw new StartupError('service_exited', `${child.service} exited with code ${child.exited.code} before it became ready`,
      { service: child.service, exited: child.exited, log: child.log.tail(), state_changed: true });
  };
  try {
  failIfExited();
  for (const service of instance.lock.services) {
    const record = instance.children.find((entry) => entry.service === service.name);
    const results = [];

    for (const phase of ["seed_gate", "protocol"]) {
      for (const check of service.readiness.filter((entry) => entry.kind === phase)) {
        if (record.exited !== null) {
          throw new StartupError(
            "service_exited",
            `${service.name} exited with code ${record.exited.code} before it became ready`,
            { service: service.name, exited: record.exited, log: record.log.tail(), state_changed: true },
          );
        }

        const address = instance.addressOf(service.name, check.port);
        const result = await waitFor(check, address, { timeoutMs: readyTimeoutMs, signal: controller.signal });
        failIfExited();
        results.push({ ...check, ...result, service: service.name });

        if (!result.ok) {
          instance.serviceStates.set(service.name, "failed");
          publishProgress(instance);
          // A CHILD THAT DIED DURING THE WAIT IS REPORTED AS WHAT IT IS. The
          // exit check above runs before `waitFor` and never again, so a service
          // that exited one second in was announced a full timeout later as
          // "did not become ready on its http check: fetch failed" -- a true
          // sentence about the socket, and the wrong subject. The exit code and
          // the child's own output were both already known.
          //
          // Measured: `emulate` started without its dependencies exits at once
          // on `Cannot find package '@emulators/core'`, and CI reported 22 tests
          // failing on a readiness check. Finding the real cause took three runs.
          if (record.exited !== null) {
            throw new StartupError(
              "service_exited",
              `${service.name} exited with code ${record.exited.code} before it became ready`,
              { service: service.name, exited: record.exited, log: record.log.tail(), state_changed: true },
            );
          }
          throw new StartupError(
            "not_ready",
            `${service.name} did not become ready on its ${check.protocol} check: ${result.detail}`,
            { service: service.name, check, detail: result.detail, log: record.log.tail(), state_changed: true },
          );
        }
      }
    }

    if (record.exited !== null) throw new StartupError("service_exited", `${service.name} exited before readiness was accepted`,
      { service: service.name, exited: record.exited, log: record.log.tail(), state_changed: true });
    instance.readiness.set(service.name, aggregate(results));
    instance.serviceStates.set(service.name, "running");
    publishProgress(instance);
  }

  return instance.readiness;
  } finally { if (instance.readinessAbort === controller) instance.readinessAbort = null; }
}
