// The `worldfixture` command line.
//
// One command starts a useful world. Output shows what the user received rather
// than how it was orchestrated. Each failure names the component, cause, state
// change, and one repair. Detail stays behind `status --verbose`.
//
// `up` runs a background one-container instance by default. `--direct` keeps the
// old foreground checkout run for development. Every command that reads or
// changes runtime-owned state enters the recorded container rather than opening
// its SQLite file across a bind mount.

import { spawn } from "node:child_process";
import { randomUUID } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { shareHostArtifact } from './host-state-ownership.mjs';
import { defaultEnvironment } from "./environments.mjs";
import { rebaseForSession } from "./session-world.mjs";
import { attachManagedSession, configureApplicationBindings } from './session-runtime.mjs';
import { assertSessionRecoverable, SessionError } from './session-manager.mjs';
import { activeFile, activeStateDir, readActiveGeneration, sessionPath, writeSessionJson, writeSessionFile } from './session-files.mjs';
import { importSwitchArtifact, listSwitchWorlds } from './switch-world.mjs';
import { inspectWorldArtifact, resolveWorldSelection } from "./world-catalogue.mjs";
export { rebaseForSession };

import { resolveBindings, shellQuote } from "./bindings.mjs";
import { BuildError, buildWorldSource, inspectSource, validateWorldSource } from "./build.mjs";
import { ClockError, clockState, parseDuration } from "./clock.mjs";
import { submit } from "./commands.mjs";
import {
  assertWorldMatchesInstance,
  ConnectorError,
  checkConnector,
  connectorDocumentation,
  connectorPrompt,
  connectorStatus,
  connectorWorld,
  deliverConnectorEvent,
  discoverConnector,
  planConnector,
  resetConnector,
  seedConnector,
} from "./connector.mjs";
import { writeConnectorEnvironment } from "./connector-env.mjs";
import { requestControl, requestReset, serveControl } from "./control.mjs";
import { credential, readRunCredentials } from "./credentials.mjs";
import { diagnose, formatReport } from "./doctor.mjs";
import { drain, follow, printExisting } from "./events.mjs";
import {
  ensureHostImage,
  HostLauncherError,
  hostAddresses,
  hostBindings,
  hostInstance,
  inspectHostInstance,
  launchHostInstance,
  removeHostRecord,
  resetHostInstance,
  runInHostInstance,
  stopHostInstance,
  streamInHostInstance,
  verifyRequestedWorld,
} from "./host-launcher.mjs";
import { inbox } from "./imap.mjs";
import { loadManifests } from "./manifests.mjs";
import { OpenError, openWorkbench, TESTED_PLATFORMS } from "./open.mjs";
import { SINGLE_CONTAINER_PORTS } from "./ports.mjs";
import { connectorTarget, ensureProject, readProject, readProjectToken } from "./project.mjs";
import { aggregate, probe } from "./readiness.mjs";
import { connectorEventFromWorldEvent, observedKinds, selectWorldEvent } from "./replay.mjs";
import { ResolutionError, resolveEnvironment, serializeLock } from "./resolve.mjs";
import { describeScale, parseLimits, parseScale, SCALE_PRESETS, ScaleError } from "./scale.mjs";
import { timelineState } from "./scheduler.mjs";
import { TimelineControlError, attachTimelineControl } from "./timeline-control.mjs";
import { history, slackTokenHolders, tokenFor } from "./slack.mjs";
import { openState } from "./state.mjs";
import { StartupError, start } from "./supervisor.mjs";
import { startWorkbench } from "./workbench.mjs";
import { contents, findChannel, findPeople, findPerson, insiders, personHandle, primaryOrganization, readWorld } from "./world.mjs";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// THE IMAGE THIS CLI RUNS, in one place.
//
// Read from the package rather than written here, so the published tag moves
// with the version and a registry change is one edit. `WORLDFIXTURE_IMAGE`
// overrides it, and a source checkout that has built `worldfixture:local` can
// point at that without editing anything.
function defaultImage() {
  try {
    const pkg = JSON.parse(readFileSync(resolve(PACKAGE_ROOT, "package.json"), "utf8"));
    if (pkg.worldfixture?.image) return pkg.worldfixture.image;
  } catch {
    /* a checkout without a package file falls back below */
  }
  return "worldfixture:local";
}

const USAGE = `worldfixture — a local world with real interfaces

  worldfixture up [world]        Start a world and print its bindings
  worldfixture worlds [--json]   List artifact identities and validation results
  worldfixture switch <world>    Replace provider state and select a new world
  worldfixture switch --connect <url>  Confirm this generation's application connector
  worldfixture switch --without-application  Confirm a run that needs no application
  worldfixture up --world-path <dir>   Start a world artifact you built yourself
  worldfixture new <dir>         Copy the starter world, ready to edit
  worldfixture build <source>    Prepare a versioned artifact from world JSON
  worldfixture validate <source> Check a world source without building it
  worldfixture open              Open this instance's Workbench in a browser
  worldfixture status            Show what a running instance is serving
  worldfixture env               Print application bindings for a shell
  worldfixture doctor            Check Docker, the image, files, ports and readiness
  worldfixture reset             Restore the running world to its exact start
  worldfixture clock [--json]    Read the running instance's world clock
  worldfixture clock pause      Pause world time and scheduled delivery
  worldfixture clock resume     Resume world time
  worldfixture clock advance <duration>  Apply due arrivals without waiting
  worldfixture clock start <duration>  Apply a setup position and start delivery
  worldfixture down              Stop and remove the local instance
  worldfixture people            List people and their provider identities
  worldfixture slack send --as <person> --channel <name> <text>
  worldfixture slack history --channel <name> [--as <person>]
  worldfixture mail inbox --as <person> [--folder INBOX]   Read Local Mail
  worldfixture events [--follow]   Show, or follow, the facts the runtime observed
  worldfixture connector docs      Print Connector v1 docs and the selected world payload
  worldfixture connector prompt <application-url>
  worldfixture connector check <application-url>
  worldfixture connector plan <application-url> [--scale <name>]
  worldfixture connector seed <application-url> [--scale <name>] [--limit <list>]
  worldfixture connector event <application-url> --file <event.json>
  worldfixture connector status <application-url>
  worldfixture connector reset <application-url>
  worldfixture run -- <command>   Start an application with this run's bindings

Options
  --world <id:version> Select a world by verified manifest identity
  --world-path <dir>   Select a built world artifact directory
                       Default world: business.saas-company:v3
  --output <dir>       Where build writes the artifact (default dist/<id>.<version>)
  --state <dir>        Where instance state is written (default .worldfixture/runs/local)
  --verbose            Show ports, digests and every readiness check
  --image <name>       One-container image (default ${defaultImage()})
  --app-dir <dir>      Put the connector token in the app's ignored .env.local
  --app-env <name>     Local env file inside --app-dir (default .env.local)
  --project-dir <dir>  Project directory (default current directory)
  --application-url <url>  Explicit application connector origin for required app events
  --direct             Run checkout services in the foreground (development)
  --follow             Keep printing events as they are observed (events only)
  --only <parts>       Start only these parts of the world (slack, github, site
                       for HTTP targets, mail for Local Mail, s3, providers).
                       The default starts all of them.
  --no-rebase          Start the world at its authored anchor instead of today
  --start-at <duration> Apply arrivals through this position before the run is ready
  --setup              Wait for a starting position in the Workbench before delivery
  --repeat             Loop the schedule after each completed arc; keep provider data
  --scale <name>       How much of the world to send to an application:
                       smoke (at most 25 of anything), sample (at most 250),
                       or full. The default is full.
  --limit <list>       Per-collection counts, as people=25,mail=200. A nested
                       list such as messages is counted per parent. Overrides
                       --scale for the collections it names.
`;

// ---- output --------------------------------------------------------------

const pad = (label, width = 12) => label.padEnd(width);

// Status and diagnostic output must not carry the local secret. The explicit
// `env` command exports usable credentials and writes those values directly.
//
// WHY A BACKSTOP AND NOT JUST A FIX. The token was reaching the terminal through
// `execFile`, which copies the command line it ran into the Error it throws --
// so a `docker run` that failed on a taken port printed the token in cleartext.
// That specific path is fixed at the source: `host-launcher.mjs` now hands the
// value to Docker through the child's environment and never puts it in argv.
//
// This stays because the same shape of leak can be reintroduced by any future
// call that interpolates a binding into a command, a URL or an error, and the
// cost of being wrong is a secret in somebody's scrollback and CI log. One
// shared path for status and diagnostic lines is cheaper than remembering.
const TOKEN_PATTERN = /\bwf_local_[0-9a-f]{8,}/g;
const ASSIGNED_TOKEN_PATTERN = /\b(WORLDFIXTURE_TOKEN|authorization|Bearer)([=:]\s*|\s+)(\S+)/gi;

function redactSecrets(text) {
  return String(text)
    .replace(TOKEN_PATTERN, "wf_local_<redacted>")
    .replace(ASSIGNED_TOKEN_PATTERN, (match, name, separator, value) =>
      value.startsWith("<redacted") ? match : `${name}${separator}<redacted>`);
}

function say(line = "") {
  process.stdout.write(`${redactSecrets(line)}\n`);
}

// Every failure names the component, the cause, whether state changed, and one
// repair. A stack trace is none of those things.
function fail(error) {
  const component = error.detail?.service ?? error.detail?.profile ?? "worldfixture";
  say();
  say(`${component} failed: ${error.message}`);
  say(error.state_changed ? "Some state changed; the instance was stopped." : "No world state changed.");

  const repair = {
    capability_not_available: `Run \`${invocation()} status --verbose\` to see which capabilities the services publish.`,
    capability_ambiguous: "Name one implementation under `prefer` in the environment.",
    capability_conflict: "Drop one of the two capabilities, or select a different implementation.",
    capability_not_provable: "That service has no measured readiness check yet; it cannot be started honestly.",
    artifact_mismatch: `Rebuild the world: \`${invocation()} build <source>\`.`,
    world_mismatch: "Point --world-path at the artifact this environment names.",
    not_ready: `Run \`${invocation()} doctor\` to check ports, then retry.`,
    service_exited: "Read the service output above; the child exited before it answered.",
  }[error.code];

  if (repair) {
    say();
    say("Run:");
    say(`  ${repair}`);
  }

  if (error.detail?.log?.length) {
    say();
    say(`Last output from ${component}:`);
    for (const line of error.detail.log) say(`  ${line.line}`);
  }

  process.exitCode = 1;
}

// ---- arguments -----------------------------------------------------------

export function parse(argv) {
  const flags = {};
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      positional.push(argument);
      continue;
    }
    const name = argument.slice(2);
    if (["world", "world-path"].includes(name) && Object.hasOwn(flags, name)) {
      throw new BuildError("invalid_world_selection", `--${name} was supplied more than once`);
    }
    if (["verbose", "choose", "direct", "json", "follow", "no-rebase", "setup", "repeat", "list", "print", "help", "without-application", "status"].includes(name)) flags[name] = true;
    else {
      if (index + 1 >= argv.length || argv[index + 1].startsWith("--")) {
        throw new BuildError("invalid_arguments", `--${name} needs a value`);
      }
      flags[name] = argv[++index];
    }
  }

  return { flags, positional };
}

// Paths for state-only commands do not inspect or validate an artifact. World
// lookup is lazy, and read commands use the recorded session before defaults.
export function paths(flags, { packageRoot = PACKAGE_ROOT, cwd = process.cwd() } = {}) {
  const projectDir = resolve(cwd, flags["project-dir"] ?? flags["app-dir"] ?? cwd);
  const stateDir = flags.state ? resolve(cwd, flags.state) : resolve(projectDir, ".worldfixture/runs/local");
  return {
    get builtPath() {
      if (flags["world-path"]) return resolve(cwd, flags["world-path"]);
      const projectWorld = readProject(projectDir)?.config.world;
      try {
        return resolveWorldSelection({ selector: flags.world, projectWorld, cwd: flags.world ? cwd : projectDir,
          distRoot: join(packageRoot, "dist"), sourceRoots: [join(packageRoot, "worlds")] }).artifactPath;
      } catch (error) {
        // doctor must inspect the selected damaged build and name its repair.
        if (error.artifact?.artifactPath) return error.artifact.artifactPath;
        throw error;
      }
    },
    get artifactPath() {
      if (!flags["world-path"] && !flags.world) {
        const active = readActiveGeneration(stateDir);
        if (active) return sessionPath(stateDir, active.artifactPath);
        for (const name of ["world", "input-world"]) {
          const sessionPath = join(stateDir, name);
          if (existsSync(join(sessionPath, "world.json"))) return sessionPath;
        }
      }
      return this.builtPath;
    },
    projectDir,
    generatedSecretsPath: process.env.WORLDFIXTURE_GENERATED_SECRETS_PATH
      ?? join(projectDir, ".worldfixture/generated-secrets.json"),
    stateDir,
    serviceRoot: flags["service-root"] ? resolve(cwd, flags["service-root"]) : resolve(packageRoot, "emulators"),
  };
}

// Validate all selectors before ensureProject or startup can write anything.
export function resolveUpSelection({ flags, positional }, { projectWorld,
  distRoot = join(PACKAGE_ROOT, "dist"), sourceRoots = [join(PACKAGE_ROOT, "worlds")], cwd = process.cwd(), projectDir = cwd } = {}) {
  if (positional.length > 1 || (positional.length && flags.world !== undefined)) {
    throw new BuildError("invalid_world_selection", "Supply one world selector: a name or an artifact directory path");
  }
  try {
    return resolveWorldSelection({ selector: positional[0] ?? flags.world, worldPath: flags["world-path"],
      projectWorld, distRoot, sourceRoots,
      cwd: positional.length || flags.world !== undefined || flags["world-path"] !== undefined ? cwd : projectDir });
  } catch (error) {
    throw new BuildError("invalid_world_selection", error.message, "Run `worldfixture worlds` to list available worlds.");
  }
}

function worlds({ flags, positional }) {
  if (positional.length) throw new BuildError("invalid_world_selection", "worlds does not accept positional selectors");
  const entries = listSwitchWorlds({ distRoot: join(PACKAGE_ROOT, "dist"), sourceRoots: [join(PACKAGE_ROOT, "worlds")], stateDir: paths(flags).stateDir });
  if (flags.json) return say(JSON.stringify(entries, null, 2));
  if (!entries.length) return say("No world artifacts were found. Build a world source first.");
  for (const entry of entries) {
    say(`${entry.id ?? "unknown"}:${entry.version ?? "unknown"}  ${entry.valid ? "valid" : "INVALID"}`);
    say(`  Artifact: ${entry.artifactPath}`);
    if (entry.digest) say(`  SHA-256: ${entry.digest}`);
    say(`  Source: ${entry.sourcePath ?? "no verified source is available"}`);
    for (const error of entry.errors) say(`  Error: ${error}`);
  }
}

// ---- application connector ----------------------------------------------

// The environment lock of the instance that is actually running, or null when
// none is. Read rather than assumed, so a stale or missing lock disables the
// check instead of blocking a command that would have worked.
function runningLock(stateDir) {
  try {
    return JSON.parse(readFileSync(activeFile(stateDir, 'lockPath', 'environment.lock.json'), "utf8"));
  } catch {
    return null;
  }
}

const CONNECTOR_USAGE = `An application connector fills your own application with this world.

  worldfixture connector docs                    Connector v1 docs and the selected world payload
  worldfixture connector prompt <url>            A prompt for a coding agent to implement one
  worldfixture connector discover <url>          What the application says it supports
  worldfixture connector check <url>             Conformance: discovery, auth, plan, status
  worldfixture connector plan <url>              What a seed would do, changing nothing
  worldfixture connector seed <url>              Fill the application with the world
  worldfixture connector event <url> --file <f>  Deliver one hand-written event
  worldfixture connector replay <url>            Deliver an event the world produced
     --event <id|seq|kind>                       Which one (default: the most recent)
     --list                                      The kinds this world has produced
     --print                                     Write the event instead of sending it
  worldfixture connector status <url>            What the application has accepted so far
  worldfixture connector reset <url>             Ask the application to reset, if it can

How much of the world to send, on check, plan and seed:

  --scale smoke     at most 25 of anything -- a quick check
  --scale sample    at most 250 of anything
  --scale full      the whole world (default)
  --limit people=25,messages=5    per-collection counts; a nested list such as
                                  messages is counted per parent

A slice is always whole: it never contains a record that refers to a record it
does not contain, and it never empties a collection the world has records in.

Start with:

  worldfixture connector prompt http://localhost:3000`;

function connectorToken(flags) {
  if (flags.token ?? process.env.WORLDFIXTURE_TOKEN) return flags.token ?? process.env.WORLDFIXTURE_TOKEN;
  const { stateDir } = paths(flags);
  const projectDir = flags["project-dir"] ?? flags["app-dir"] ?? process.cwd();
  return hostBindings(stateDir)?.WORLDFIXTURE_TOKEN
    ?? readBindings(stateDir)?.WORLDFIXTURE_TOKEN
    ?? readProjectToken(projectDir);
}

function printConnectorValue(value, flags) {
  if (flags.json) return say(JSON.stringify(value, null, 2));

  // `already_applied` is printed before anything else, because it changes what
  // every number below it means.
  //
  // A repeated seed used to be indistinguishable from a real one: same summary,
  // same counts, no indication that nothing happened. The receipt has carried
  // `status` all along and neither client showed it, so the only way to confirm
  // that idempotency worked was to go and count rows in the application's own
  // database. Three separate connector authors did exactly that.
  if (value.status === "already_applied") {
    say("Already applied. This request matched one this application has already accepted, so nothing changed.");
  }
  if (value.summary) say(value.summary);

  // The mappings ARE the plan. Printing the summary and counts and dropping the
  // source-to-target rows left the CLI unable to answer the one question a plan
  // exists for -- what is about to be created, and what is being left out and
  // why -- while `--json` had it all along.
  for (const mapping of value.mappings ?? []) {
    const target = mapping.target ? `-> ${mapping.target}` : "-> (nothing)";
    say(`  ${pad(mapping.status, 8)} ${pad(mapping.source, 28)} ${target}`);
    if (mapping.reason) say(`  ${pad("", 8)} ${mapping.reason}`);
  }
  if (value.mappings?.length) say();

  if (value.counts && Object.keys(value.counts).length > 0) {
    for (const [name, count] of Object.entries(value.counts)) say(`  ${pad(name, 20)} ${count}`);
  }
  for (const warning of value.warnings ?? []) say(`Warning: ${warning}`);

  // The operation worked and the response does not match the published schema.
  // Said here rather than swallowed, because the next thing that reads this
  // response is the Workbench, and it will not be as forgiving.
  const errors = value.schema_errors ?? [];
  if (errors.length > 0) {
    say();
    say("The application answered, but its response does not match the published schema:");
    for (const error of errors) say(`  ${error}`);
    say(`Run \`${invocation()} connector check <url>\` and see schemas/connector-*.v1.schema.json.`);
  }
}

// What is about to be sent, counted from what is about to be sent.
//
// A slice is a claim about somebody's data, and the only honest way to make it
// is to print the numbers rather than the preset name: "smoke" tells a reader
// nothing about whether their support cases came along.
//
// The full table is nineteen lines on the default world, which is more than
// anybody wants in front of every plan and seed, so what is printed by default
// is the total and the collections that came out SHORT of what was asked for --
// the only ones that are ever a surprise. `--verbose` prints all of them.
function printSlice(world, flags) {
  if (!world || flags.json || world.scale.full) return;

  const present = world.scale.collections.filter((entry) => entry.total > 0);
  const kept = present.reduce((total, entry) => total + entry.kept, 0);
  const available = present.reduce((total, entry) => total + entry.total, 0);
  const count = (value) => value.toLocaleString("en-US");

  // "the full slice" would be a lie the moment a --limit narrowed it, and the
  // limits are the part of the request the reader most needs read back to them.
  const limits = Object.entries(world.scale.limits).map(([name, value]) => `${name}=${value}`);
  const preset = world.scale.preset === "full" && limits.length > 0
    ? "Sending a limited slice"
    : `Sending the ${world.scale.preset} slice: ${SCALE_PRESETS[world.scale.preset].summary}`;
  say(limits.length > 0 ? `${preset} (${limits.join(", ")})` : preset);
  say(`  ${count(kept)} of ${count(available)} records, across ${present.length} collections`);

  if (flags.verbose) {
    say();
    for (const line of describeScale(world.scale)) say(`  ${line}`);
  }

  const short = present.filter((entry) => entry.kept < Math.min(entry.limit, entry.total));
  if (short.length > 0) {
    say();
    say("Short of the limit, because something they refer to was left out:");
    for (const entry of short) say(`  ${pad(entry.collection, 22)} ${count(entry.kept)} of ${count(entry.total)}`);
    say("Raise --limit on what they depend on, or use a larger --scale.");
  }
  say();
}

async function connectorCommand({ flags, positional }) {
  const [action, baseUrl] = positional;
  if (action === "docs") return say(connectorDocumentation({
    artifactPath: paths(flags).artifactPath, scale: parseScale(flags.scale), limits: parseLimits(flags.limit),
  }).trimEnd());

  // `worldfixture connector` and `connector --help` used to answer "an
  // application URL is required", which is true of the action they did not name
  // and useless as the first thing this subcommand ever says to somebody.
  if (!action || flags.help) return say(CONNECTOR_USAGE);

  if (!baseUrl) {
    say(`connector ${action} needs an application URL.`);
    say();
    say(CONNECTOR_USAGE);
    process.exitCode = 1;
    return;
  }
  if (action === "prompt") return say(connectorPrompt(baseUrl, {
    artifactPath: paths(flags).artifactPath, scale: parseScale(flags.scale), limits: parseLimits(flags.limit),
  }));

  const active = readActiveGeneration(paths(flags).stateDir);
  if (active && ['check', 'plan', 'seed', 'status', 'reset', 'event', 'replay'].includes(action)) {
    const input = { kind: 'connector', action, baseUrl, scale: parseScale(flags.scale), limits: parseLimits(flags.limit),
      eventKind: flags.event, list: flags.list === true, print: flags.print === true };
    if (action === 'event') {
      if (!flags.file) throw new ConnectorError('event_required', 'connector event requires --file <event.json>');
      input.event = JSON.parse(readFileSync(resolve(flags.file), 'utf8'));
    }
    const result = await requestManagedControl(paths(flags).stateDir, { action: 'operation', generation: active.generation, input }, { timeoutMs: 900_000 });
    return printConnectorValue(result.result, { ...flags, json: true });
  }

  const { artifactPath } = paths(flags);
  const token = connectorToken(flags);
  if (action === "discover") return printConnectorValue(await discoverConnector(baseUrl), { ...flags, json: true });

  // The slice is taken once, described, and then sent. `check` uses it too, so a
  // conformance run against a small slice checks the same bytes a seed would.
  const world = ["check", "plan", "seed"].includes(action)
    ? connectorWorld(artifactPath, { scale: parseScale(flags.scale), limits: parseLimits(flags.limit) })
    : null;
  // Refused for `seed`, which writes; reported for `check` and `plan`, which do
  // not. A mismatch still makes a plan a plan about the wrong world, so it is
  // always said out loud -- but blocking a read-only preview over it, as the
  // first version of this did, takes away the command somebody would reach for
  // to diagnose the mismatch.
  if (world) {
    try {
      assertWorldMatchesInstance(world, runningLock(paths(flags).stateDir));
    } catch (error) {
      if (action === "seed") throw error;
      say(`Warning: ${error.message}`);
      say();
    }
  }

  if (action === "check") {
    const result = await checkConnector(baseUrl, { world, token });
    if (flags.json) return say(JSON.stringify(result, null, 2));
    say("WorldFixture Connector v1");
    say();
    for (const check of result.checks) say(`${check.ok ? "PASS" : "FAIL"}  ${pad(check.name, 20)} ${check.detail}`);
    say();
    say(result.ready ? "Connector is ready." : "Connector is not ready.");
    if (!result.ready) process.exitCode = 1;
    return;
  }
  if (!token) {
    throw new ConnectorError("token_required", "connector actions require WORLDFIXTURE_TOKEN or --token");
  }
  if (action === "plan") {
    printSlice(world, flags);
    return printConnectorValue(await planConnector(baseUrl, { world, token }), flags);
  }
  if (action === "seed") {
    printSlice(world, flags);
    return printConnectorValue(await seedConnector(baseUrl, { world, token }), flags);
  }
  if (action === "status") return printConnectorValue(await connectorStatus(baseUrl, { token }), { ...flags, json: true });
  if (action === "reset") return printConnectorValue(await resetConnector(baseUrl, { token }), flags);
  if (action === "event") {
    if (!flags.file) throw new ConnectorError("event_required", "connector event requires --file <event.json>");
    const event = JSON.parse(readFileSync(resolve(flags.file), "utf8"));
    return printConnectorValue(await deliverConnectorEvent(baseUrl, event, { token }), flags);
  }

  // Something happened in the world; send it to the application.
  //
  // This is the product's headline capability and until now nothing performed
  // it. `worldfixture events` printed observations in one shape and `connector
  // event --file` demanded another, with no converter between them, so the demo
  // ended at a JSON file the user had to write by hand.
  if (action === "replay") {
    const { stateDir, artifactPath } = paths(flags);
    if (!readBindings(stateDir) && !hostBindings(stateDir)) {
      throw new ConnectorError("no_instance", "no instance is running, so there is no event to replay");
    }
    const db = openState(activeFile(stateDir, 'statePath', 'state.sqlite'));
    let observed;
    try {
      observed = drain(db, 0).rows;
    } finally {
      db.close?.();
    }

    if (flags.list) {
      const kinds = observedKinds(observed);
      if (kinds.length === 0) return say("This instance has observed no events yet.");
      say("Kinds this world has produced:");
      for (const entry of kinds) say(`  ${pad(String(entry.count), 5)} ${entry.kind}`);
      say();
      say(`Replay the most recent of one with \`${invocation()} connector replay <url> --event <kind>\`.`);
      return;
    }

    const chosen = selectWorldEvent(observed, flags.event);
    const event = connectorEventFromWorldEvent(chosen, readWorld(artifactPath));

    // `--print` writes the event instead of sending it, which is also the only
    // documented way to get a real `--file` payload to start from.
    if (flags.print) return say(JSON.stringify(event, null, 2));

    if (!flags.json) {
      say(`Delivering ${event.kind} observed at ${event.occurred_at}`);
      if (event.actor) say(`  from    ${event.actor.worldfixture_ref}`);
      if (event.subject) say(`  about   ${event.subject.worldfixture_ref}`);
      say();
    }
    return printConnectorValue(await deliverConnectorEvent(baseUrl, event, { token }), flags);
  }
  throw new ConnectorError("unknown_action", `unknown connector action ${JSON.stringify(action)}`);
}

async function runApplication(argv) {
  const separator = argv.indexOf("--");
  const optionArgs = separator === -1 ? [] : argv.slice(0, separator);
  const command = separator === -1 ? argv : argv.slice(separator + 1);
  if (command.length === 0) {
    say("run failed: a command is required after `--`.");
    say(`Run \`${invocation()} run -- npm run dev\`.`);
    process.exitCode = 1;
    return;
  }

  const parsed = parse(optionArgs);
  const current = await applicationEnvironment(parsed.flags);
  if (!current) return;
  const { values: environment, lock, unresolved } = current;
  if (unresolved.length) throw new SessionError('unresolved_bindings', unresolved.map(entry => `${entry.name}: ${entry.reason}`).join('; '));
  if (!environment.WORLDFIXTURE_TOKEN) {
    say("This instance has no application connector token. Restart it with the current WorldFixture build.");
    process.exitCode = 1;
    return;
  }
  environment.WORLDFIXTURE_WORLD_ID = lock.world.id;
  environment.WORLDFIXTURE_WORLD_VERSION = lock.world.version;

  const child = spawn(command[0], command.slice(1), { stdio: "inherit", env: { ...process.env, ...environment } });
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  if (result.signal) process.kill(process.pid, result.signal);
  if (result.code) process.exitCode = result.code;
}

// ---- up ------------------------------------------------------------------

export function validateTimelineStart(flags) {
  if (flags["start-at"] !== undefined) parseDuration(flags["start-at"]);
  if (flags.setup && flags["start-at"] !== undefined) {
    throw new BuildError("invalid_arguments", "Use --setup to choose a position in the Workbench, or --start-at to apply one at launch.");
  }
}

async function directUp({ flags }, { applicationEnvironment, project, selection } = {}) {
  const { builtPath, stateDir, serviceRoot, generatedSecretsPath: defaultGeneratedSecretsPath } = paths(flags);
  assertSessionRecoverable(stateDir);
  const generatedSecretsPath = project?.generatedSecretsPath ?? defaultGeneratedSecretsPath;
  mkdirSync(stateDir, { recursive: true });
  // Both launch modes retain the exact input, even when no source can rebase it.
  const inputPath = prepareSessionInput(builtPath, stateDir, selection);
  const session = flags["no-rebase"]
    ? { artifactPath: inputPath, rebased: false }
    : rebaseForSession(inputPath, stateDir, { quiet: true });
  if (!flags["no-rebase"] && !session.rebased) say(`World dates use the authored anchor: ${session.reason}`);
  const artifactPath = session.artifactPath;
  const world = readWorld(artifactPath);
  const inOneContainer = process.env.WORLDFIXTURE_SINGLE_CONTAINER === "1";
  // `--only slack,github` starts the parts of the world a run actually needs.
  // The default is every part, which is the zero-configuration first run.
  const only = flags.only ? String(flags.only).split(",").map((name) => name.trim()).filter(Boolean) : undefined;
  const manifests = loadManifests(serviceRoot);
  const spec = defaultEnvironment(`${world.id}:${world.version}`, {
    artifactPath, manifests,
    includeS3: inOneContainer || project?.config.services.includes("s3"),
    includeProviders: inOneContainer,
    includePostgres: project?.config.services.includes("postgres"),
    includeMySQL: project?.config.services.includes("mysql"),
    only,
    oauthClients: world.software?.oauth_clients,
    // Whose mail and Slack credentials this run binds. Read from the world that
    // is about to start, so a world other than the default one -- a shipped one
    // or one somebody compiled with `worldfixture build` -- binds its own
    // primary person instead of a person it does not contain.
    identity: world.people?.find((person) => person.primary)?.id,
  });

  if (flags["application-url"]) spec.target.application_url = connectorTarget({ application_url: flags["application-url"] }, { inContainer: inOneContainer }).transport_url;
  const lock = resolveEnvironment(spec, { manifests, artifactPath });

  // The lock and the environment are written before anything starts, so a run
  // that fails still leaves the thing that explains what it tried to do.
  mkdirSync(stateDir, { recursive: true });
  if (project) {
    const target = connectorTarget(project.config, { inContainer: inOneContainer });
    writeSessionJson(join(stateDir, "application-connector.json"), target);
  }
  writeSessionJson(`${stateDir}/environment.json`, spec);
  writeSessionFile(`${stateDir}/environment.lock.json`, serializeLock(lock));

  // THE WORKBENCH OPENS WHILE THE WORLD IS STILL LOADING.
  //
  // It used to start after `start()` returned, which meant after every service
  // was ready. Measured on the default world: the providers answer at 3.6s and
  // S3 at 13.1s, but Cyrus seeds every mailbox before SMTP binds at 64s, and full
  // readiness lands at about 94s. So the Workbench appeared at 100 seconds while
  // needing nothing that the wait was for.
  //
  // It now starts as soon as the children exist. Its provider sweep already
  // settles each provider independently and reports a per-provider error, so a
  // service that is not answering yet shows as not answering yet, and fills in.
  //
  // `workbench.json` is written here and `bindings.json` is not. That difference
  // is deliberate: the host launcher treats `bindings.json` as the marker for a
  // world that is fully ready, so writing it early would make `worldfixture up`
  // report a world that is still seeding as finished.
  let workbench;
  const openEarly = async (started) => {
    workbench = await startWorkbench(started, {
      artifactPath,
      stateDir,
      port: inOneContainer ? 4715 : 0,
      host: inOneContainer ? "0.0.0.0" : "127.0.0.1",
    });
    writeSessionJson(`${stateDir}/workbench.json`, { url: workbench.url, state: "loading" });
  };

  let instance;
  try {
    instance = await start(lock, {
      artifactPath,
      stateDir,
      serviceRoot,
      runner: inOneContainer ? "process" : "container",
      fixedPorts: inOneContainer ? SINGLE_CONTAINER_PORTS : undefined,
      runtimeToken: applicationEnvironment?.token ?? process.env.WORLDFIXTURE_TOKEN,
      generatedSecretsPath,
      onSpawned: openEarly,
      // The image build inside `start` takes minutes on a first checkout run.
      // Its "this happens once" line had no way out of the supervisor until
      // this callback existed, so the build looked like a hang.
      onNotice: (line) => say(line),
    });
  } catch (error) {
    await workbench?.close();
    rmSync(`${stateDir}/workbench.json`, { force: true });
    throw error;
  }

  writeSessionJson(`${stateDir}/workbench.json`, { url: workbench.url, state: "ready" });
  try {
    configureApplicationBindings(instance, workbench.url);
  } catch (error) {
    await workbench.close();
    await instance.stop();
    throw new StartupError("binding_unresolved", error.message);
  }

  // The concrete addresses this run allocated, so `worldfixture slack send` in
  // another terminal reaches this instance rather than asking the user to copy a
  // port. Removed on stop, so a stale file never points at a dead world.
  const bindingsPath = `${stateDir}/bindings.json`;
  // 0600, because this file carries WORLDFIXTURE_TOKEN alongside the addresses.
  //
  // `security.md` promises the token lives in `.worldfixture/token` at 0600, and
  // there was a second copy here at 0644 -- readable by every user on the
  // machine, and reached by anything as ordinary as `cat .worldfixture/runs/
  // local/*.json` to find the Workbench port. Its sibling `host-bindings.json`
  // was already written 0600; this one was missed.

  // Armed BEFORE the screen invites the user to press Ctrl-C. Registering it
  // afterwards leaves a window in which SIGINT takes Node's default path and
  // kills the supervisor without stopping its children -- which is precisely
  // the orphan this runtime promises never to leave. Found by a test that
  // interrupted as soon as the screen appeared.
  // The clock starts HERE, after readiness, and not when the process began.
  // Startup takes tens of seconds on a cold machine, and a timeline counted from
  // process start would spend its opening minute before anything was listening.
  let scheduler, control, sessionManager, positioningShutdown;
  const interruptPositioning = () => {
    if (positioningShutdown) return;
    process.exitCode = 130;
    positioningShutdown = (async () => {
      say("Stopping initial timeline delivery…");
      await instance.timelineControl?.stop();
      await workbench.close();
      await instance.stop();
      for (const file of [bindingsPath, `${stateDir}/addresses.json`, `${stateDir}/workbench.json`]) rmSync(file, { force: true });
    })();
  };
  process.on("SIGINT", interruptPositioning);
  process.on("SIGTERM", interruptPositioning);
  try {
    scheduler = await armInstanceTimeline(instance, world, {
      bindings: instance.applicationBindings, stateDir, verbose: flags.verbose,
      startAtMs: flags["start-at"] === undefined ? 0 : parseDuration(flags["start-at"]),
      repeat: flags.repeat === true, setup: flags.setup === true,
    });
    if (positioningShutdown) { await positioningShutdown; return; }
    sessionManager = attachManagedSession(instance, {
      sessionRoot: stateDir, packageRoot: PACKAGE_ROOT, serviceRoot, workbench,
      initialSpec: spec, initialSelection: selection ?? inspectWorldArtifact(builtPath),
      noRebase: flags['no-rebase'] === true,
      environmentOptions: {
        includeS3: inOneContainer || project?.config.services.includes('s3'), includeProviders: inOneContainer,
        includePostgres: project?.config.services.includes('postgres'), includeMySQL: project?.config.services.includes('mysql'), only,
      },
      startOptions: { serviceRoot, runner: inOneContainer ? 'process' : 'container',
        fixedPorts: inOneContainer ? SINGLE_CONTAINER_PORTS : undefined, runtimeToken: instance.runtimeToken },
      activateTimeline: (current, options) => armInstanceTimeline(current, readWorld(current.artifactPath), {
        bindings: current.applicationBindings, stateDir: current.stateDir, verbose: flags.verbose, ...options,
      }),
    });
    sessionManager.operation = (input, generation) => sessionManager.withGeneration(generation,
      current => executeSessionOperation(current, input), { mutation: true });
    await sessionManager.publishInitial();
    control = await serveControl(instance, stateDir);
    if (positioningShutdown) { await positioningShutdown; await control.close(); return; }
  } catch (error) {
    if (positioningShutdown) { await positioningShutdown; return; }
    await scheduler?.stop();
    await workbench.close();
    await instance.stop();
    rmSync(bindingsPath, { force: true });
    rmSync(`${stateDir}/addresses.json`, { force: true });
    rmSync(`${stateDir}/workbench.json`, { force: true });
    error.state_changed = true;
    throw error;
  } finally {
    process.off("SIGINT", interruptPositioning);
    process.off("SIGTERM", interruptPositioning);
  }
  // The host treats these bindings as the accepted-ready marker. Initial
  // positioning must finish through provider APIs before that marker is visible.
  writeSessionJson(bindingsPath, instance.applicationBindings);
  writeSessionJson(`${stateDir}/addresses.json`, instance.addresses());
  const finished = runUntilInterrupted(instance, bindingsPath, control, workbench, scheduler);

  printReady(instance, world, { verbose: flags.verbose, stateDir });
  printClock(scheduler.status());
  if (applicationEnvironment) say(`Application environment: ${applicationEnvironment.envPath}`);
  if (project && !inOneContainer) {
    say(`Project: ${project.projectDir}`);
    say(`Application: ${project.config.application_url}`);
  }
  say();
  say("Stop with Ctrl-C");
  await finished;
}

async function up(parsed) {
  validateTimelineStart(parsed.flags);
  const inOneContainer = process.env.WORLDFIXTURE_SINGLE_CONTAINER === "1";
  const projectDir = resolve(parsed.flags["project-dir"] ?? parsed.flags["app-dir"] ?? process.cwd());
  const containerProject = inOneContainer
    ? JSON.parse(process.env.WORLDFIXTURE_PROJECT_CONFIG ?? '{"api_version":"worldfixture.project/v1","application_url":"http://localhost:3000","services":[]}')
    : null;
  const existingProject = inOneContainer ? null : readProject(projectDir);
  let configuredApplication = parsed.flags["application-url"] ?? existingProject?.config.application_url;
  if (!configuredApplication) {
    try { configuredApplication = JSON.parse(readFileSync(join(paths(parsed.flags).stateDir, "application-connector.json"), "utf8")).url; } catch {}
  }
  const projectWorld = containerProject?.world ?? existingProject?.config.world;
  const selected = resolveUpSelection(parsed, { projectWorld, projectDir });
  const direct = parsed.flags.direct || inOneContainer;
  const requestedWorld = { id: selected.id, version: selected.version, digest: selected.digest };
  if (!direct) {
    // Refuse a different running world before project or application files can
    // change. The launcher repeats this check in case the instance changes.
    const running = await inspectHostInstance(paths(parsed.flags).stateDir);
    if (running) {
      verifyRequestedWorld(running, requestedWorld);
      if (parsed.flags["start-at"] !== undefined || parsed.flags.setup || parsed.flags.repeat) {
        throw new BuildError("instance_already_running", "The instance is already running. Launch options cannot change its clock. Use clock commands or stop it before a new launch.");
      }
    }
  }
  say(`Selected world: ${selected.id}:${selected.version} (${selected.selectionSource})`);
  say(`Artifact: ${selected.artifactPath}`);
  // Both launch modes receive the same exact selection. The positional value
  // is now resolved; the environment must use that artifact's actual identity.
  parsed = { flags: { ...parsed.flags, "world-path": selected.artifactPath }, positional: [] };
  delete parsed.flags.world;
  if (configuredApplication) parsed.flags["application-url"] = configuredApplication;
  const project = inOneContainer
    ? {
      config: containerProject,
      token: process.env.WORLDFIXTURE_TOKEN,
      generatedSecretsPath: process.env.WORLDFIXTURE_GENERATED_SECRETS_PATH,
    }
    : ensureProject(projectDir, {
      token: process.env.WORLDFIXTURE_TOKEN,
      applicationUrl: parsed.flags["application-url"],
    });
  const applicationEnvironment = parsed.flags["app-dir"]
    ? writeConnectorEnvironment(parsed.flags["app-dir"], {
      fileName: parsed.flags["app-env"],
      token: project.token,
    })
    : null;
  if (direct) return await directUp(parsed, { applicationEnvironment, project, selection: selected });

  const { builtPath, stateDir } = paths(parsed.flags);

  const started = Date.now();
  const progress = startupProgress({ stateDir, startedAt: started });
  const result = await launchHostInstance({
    stateDir,
    image: parsed.flags.image ?? process.env.WORLDFIXTURE_IMAGE ?? defaultImage(),
    connectorToken: project.token,
    projectConfig: project.config,
    generatedSecretsPath: project.generatedSecretsPath,
    requestedWorld,
    // The launcher checks reuse before this callback changes the input snapshot.
    prepareContainerArgs: () => prepareContainerArgs(builtPath, stateDir, parsed.flags, selected),
    // A first run on a new machine has no image. Say what is happening: this is
    // a few hundred megabytes and a silent minute reads as a hang.
    onPull: (name) => {
      say();
      say(`Fetching    ${name}`);
      say("            about 190 MB, once; later runs reuse it");
    },
    // A port Docker refuses costs a whole second launch attempt. Name the port,
    // because the user's own other container is holding it and only they can
    // say which one. This used to be routed through `onPull`, which printed
    // `Fetching    [object Object]` and a line about 190 MB.
    onPortRetry: (port) => {
      say();
      say(`Port        ${port} is already published by another container; retrying on a free one`);
    },
    // The Workbench is open well before the world has finished seeding. Say so
    // when it happens rather than at the end, so the wait is spent looking at
    // the world instead of at nothing.
    onWorkbench: (url) => {
      progress.done();
      say();
      say(`Workbench   ${url}`);
      say(`            open after ${Math.round((Date.now() - started) / 1000)}s; the world is still loading`);
    },
    onProgress: (value) => progress.update(value),
  });
  progress.done();
  if (applicationEnvironment && result.bindings.WORLDFIXTURE_TOKEN !== applicationEnvironment.token) {
    writeConnectorEnvironment(applicationEnvironment.appDir, {
      fileName: applicationEnvironment.fileName,
      token: result.bindings.WORLDFIXTURE_TOKEN,
    });
  }
  if (result.bindings.WORLDFIXTURE_TOKEN !== project.token) ensureProject(project.projectDir, {
    token: result.bindings.WORLDFIXTURE_TOKEN,
  });
  const target = connectorTarget(project.config, { inContainer: true });
  writeSessionJson(join(stateDir, "application-connector.json"), target);
  // Resolved again, and deliberately: the container rebases the world onto today
  // and writes it into the bind-mounted state directory, so the world this
  // screen describes only exists once the instance is up. Reading the path taken
  // before the launch would print the anchor the image was built at, and the
  // screen would be describing a world the instance is not serving.
  const world = readWorld(paths({ ...parsed.flags, "world-path": undefined }).artifactPath);
  printReadyBindings(world, result.bindings, stateDir);
  const currentClock = await runInHostInstance(stateDir, ["clock", "--json"]);
  if (currentClock.code === 0) printClock(JSON.parse(currentClock.stdout));
  else {
    say("The instance started, but its clock state could not be read.");
    process.exitCode = currentClock.code || 1;
  }
  say();
  say(result.reused ? "Reused the running instance." : "The instance is running in the background.");
  say(`Project: ${project.projectDir}`);
  say(`Application: ${project.config.application_url}`);
  if (project.created) say(`Project config: ${project.configPath}`);
  if (applicationEnvironment) say(`Application environment: ${applicationEnvironment.envPath}`);
  say(`Stop it with \`${invocation()} down\`.`);
}

// Start the world's own timeline, and keep it running for the life of the
// instance.
//
// `reset` clears `scheduled_events` and `clock`, so the instance is given a
// re-arm callback: after a restore the world plays its timeline again from zero,
// which is what "restored to the accepted start" has to mean for a world whose
// start includes things that have not happened yet.
async function armInstanceTimeline(instance, world, { bindings, stateDir, verbose, startAtMs, repeat, setup }) {
  for (const entry of instance.lock.execution?.timeline?.excluded ?? []) say(`Timeline ${entry.id}: not selected (${entry.reason})`);
  for (const entry of instance.lock.execution?.binding_diagnostics ?? []) say(`Binding ${entry.binding}: ${entry.status} (${entry.reason})`);
  for (const entry of instance.lock.execution?.rule_diagnostics ?? []) say(`Rule ${entry.id}: ${entry.status} (${entry.reason})`);
  const controller = attachTimelineControl(instance, world, {
    bindings, credentials: instance.credentials, rules: instance.lock.rules ?? [],
    applicationConnector: () => {
      if (Object.hasOwn(instance, 'applicationConnector')) return instance.applicationConnector;
      if (instance.lock.target?.application_url) return { baseUrl: instance.lock.target.application_url, token: instance.runtimeToken };
      try {
        const target = JSON.parse(readFileSync(join(stateDir, "application-connector.json"), "utf8"));
        return { baseUrl: target.transport_url, token: instance.runtimeToken };
      } catch { return null; }
    },
    onPlayed: (played) => {
      if (!verbose) return;
      for (const entry of played) say(`  timeline ${entry.id ?? entry.arrival} (${entry.kind}) ${entry.status}${entry.reason ? `: ${entry.reason}` : ""}`);
    },
    onError: (error) => say(`  timeline tick failed: ${error.message}`),
  });
  await controller.initialize({ startAtMs, repeat, setup });
  return controller;
}

// The ready screen, without the line that ends it.
//
// "Stop with Ctrl-C" used to be printed here, and then the caller printed three
// more lines after it -- the project, the application URL and where the
// environment file went. That is the wrong order for a reader: you do not tell
// somebody how to stop and then keep talking. It also made the screen finish in
// two chunks, so anything reading `up`'s output for the last line got a screen
// that was still being written.
function printReady(instance, world, { verbose, stateDir }) {
  printReadyBindings(world, instance.applicationBindings ?? instance.bindings(), stateDir);
  if (verbose) printVerbose(instance);
}

function printReadyBindings(world, bindings, stateDir) {
  const organization = primaryOrganization(world);
  const held = contents(world);

  say();
  say("WorldFixture is ready");
  say();
  say(`${pad("World")}${world.id}:${world.version}`);
  say(`${pad("People")}${organization ? `${held.people} at ${organization.name ?? organization.id}` : `${held.all_people} in this world`}`);
  say(
    `${pad("Content")}${held.channels} channels, ${held.slack_messages} Slack messages, ` +
      `${held.mail_messages} emails, ${held.repositories} repositories`,
  );
  // Measured, not asserted. This world's Slack history is a spine, not a month.
  say(`${pad("History")}Slack ${days(held.history.slack_days)}, Local Mail ${days(held.history.mail_days)}`);
  // The world's own "now", against the real one. `up` rebases the world onto
  // today, so these normally sit a day or two apart; started with --no-rebase it
  // shows the date the world was authored at, which is the thing that makes a
  // message you send sort below every seeded one.
  const anchor = world.clock?.anchor;
  if (anchor) {
    const day = String(anchor).slice(0, 10);
    const behind = Math.round((Date.parse(`${today()}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86_400_000);
    const drift = behind === 0 ? "today" : behind > 0 ? `${days(behind)} ago` : `${days(-behind)} from now`;
    say(`${pad("Now")}${day} in this world, ${today()} outside it (${drift})`);
  }
  say(`${pad("State")}${stateDir.replace(`${process.cwd()}/`, "")}`);
  say();

  const visibleBindings = Object.entries(bindings).filter(([name, value]) => {
    return bindingCanBePrinted(name, value);
  });
  const bindingWidth = Math.max(12, ...visibleBindings.map(([name]) => label(name).length + 2));
  for (const [name, value] of visibleBindings) say(`${pad(label(name), bindingWidth)}${value}`);

  // The world's own primary person, not the literal "maya". `actingPerson`
  // stopped assuming that name for the same reason: it is the default world's
  // person and nobody else's. In v3 it is worse than wrong, because "maya"
  // matches both maya-chen and maya-osei and the array order picked one.
  const person = world.people?.find((entry) => entry.primary) ?? insiders(world)[0];
  if (person) {
    say();
    say(person.name);
    if (person.slack_id) say(`  ${pad("Slack", 10)}${person.slack_id}`);
    if (person.email) say(`  ${pad("Email", 10)}${person.email}`);
  }

  const channel = world.communication?.channels?.at(-1);
  if (person && channel) {
    say();
    say("Try this");
    say(`  ${invocation()} slack send --as ${personHandle(world, person)} --channel ${channel.name} "Mobile tests passed"`);
  }

}

// The command the reader can actually type.
//
// THE BUG THIS CLOSES. The first screen ends with "Try this" and one command,
// and it printed a bare `worldfixture ...`. Somebody who installed the way the
// README tells them to -- `npx worldfixture up` -- has no `worldfixture` on
// their PATH, so the very first thing the product invites them to do answers
// `command not found`. A first-use conformance run hit it within a minute.
//
// Derived from how this process was actually started, because that is the only
// thing that knows the answer: a bin shim inside `node_modules` means npx or a
// local install, a checkout means neither of those will work at all.
export function invocation(argv1 = process.argv[1], root = PACKAGE_ROOT) {
  if (!argv1) return "worldfixture";
  const path = resolve(argv1);
  if (path.split(sep).includes("node_modules")) return "npx worldfixture";
  // A checkout: no shim exists anywhere, so name the file that is running.
  // Relative when that is genuinely shorter -- somebody working inside the
  // checkout -- and absolute otherwise, because `node ../../../../../..` is not
  // a command anybody would type.
  if (path.startsWith(resolve(root) + sep)) {
    const near = relative(process.cwd(), path);
    return `node ${near && !near.startsWith("..") ? near : path}`;
  }
  return "worldfixture";
}

// What the world is doing while it loads.
//
// THE SILENCE THIS CLOSES. `up` printed the Workbench URL after about a second
// and then said nothing for another ninety, because the only thing the host
// could observe was `bindings.json` eventually appearing. Ninety seconds of
// nothing reads as a hang, and the useful answer -- everything is up except
// mail, which is delivering 3,069 messages over LMTP -- was known inside the
// container the whole time.
//
// IT SAYS IT IN THE READER'S WORDS. The first version printed the runtime's own
// names and counts: "2 of 4 services ready, waiting on mail, s3". Nothing else
// on the screen mentions four services -- the ready screen lists thirteen
// provider addresses -- so the number invited the reader to work out which four,
// and `s3` and `emulate` are names for parts of this program rather than parts
// of a world. What somebody waiting wants is what is left, in words they have
// already seen, and how long it has been.
const SERVICE_NAMES = {
  emulate: "the provider APIs",
  "http-targets": "the HTTP targets",
  mail: "Local Mail",
  s3: "file storage",
  postgres: "PostgreSQL",
  mysql: "MySQL",
};

function serviceName(name) {
  return SERVICE_NAMES[name] ?? name;
}

// "a, b and c", because a comma-separated list of two reads as an error message.
function list(names) {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

export function startupProgress({ stateDir, startedAt = Date.now() } = {}) {
  const tty = process.stdout.isTTY === true;
  let printed = false;
  let last = "";
  let lastLine = "";
  let mailCount = null;

  // Why mail is the slow one, in the world's own numbers. Read once, from the
  // world this run rebased into its state directory, and skipped entirely if it
  // is not there yet -- this is a reassurance, not a requirement.
  const mailMessages = () => {
    if (mailCount !== null || !stateDir) return mailCount;
    try {
      const world = JSON.parse(readFileSync(join(stateDir, "world/world.json"), "utf8"));
      const mail = world.communication?.resolved_mail ?? world.communication?.mail ?? [];
      mailCount = Array.isArray(mail) ? mail.length : 0;
    } catch {
      mailCount = 0;
    }
    return mailCount;
  };

  return {
    update(progress) {
      const states = Object.entries(progress.services ?? {});
      if (states.length === 0) return;

      const elapsed = `${Math.round((Date.now() - startedAt) / 1000)}s`;
      const waiting = states.filter(([, state]) => state === "starting").map(([name]) => name);
      const ready = states.filter(([, state]) => state === "running").map(([name]) => serviceName(name));

      // Recording the accepted state stops every service and starts it again, so
      // a count would run backwards -- 4 of 4, then 2 of 4 -- and a number going
      // backwards reads as something breaking.
      let line;
      if (progress.phase === "capturing-baseline") {
        line = `Loading     ${elapsed}   recording the accepted state, so \`reset\` can restore it exactly`;
      } else if (waiting.length === 0) {
        line = `Loading     ${elapsed}   everything is up`;
      } else {
        const messages = waiting.includes("mail") && mailMessages() > 0
          ? ` (${mailMessages().toLocaleString("en-US")} messages, most of the wait)`
          : "";
        const left = list(waiting.map(serviceName)).replace("Local Mail", `Local Mail${messages}`);
        // "everything else", rather than naming what is ready. Naming it meant
        // agreeing a verb with a list whose head could be singular or plural --
        // "the provider APIs is ready" -- and the reader is waiting on what is
        // LEFT. What is done only has to reassure, not enumerate.
        line = `Loading     ${elapsed}   ${left}`
          + (ready.length > 0 ? "; everything else is ready" : "");
      }

      // Deduplicated on the STATE, not the rendered line. The line carries an
      // elapsed count, so comparing lines made every one unique and a piped run
      // repeated the same phase three times as the seconds ticked. A terminal
      // wants the clock to move; a log wants each distinct state once.
      const key = `${progress.phase}:${waiting.join(",")}:${ready.length}`;
      if (key === last && !tty) return;
      if (line === lastLine) return;
      last = key;
      lastLine = line;

      if (!tty) return say(line);
      if (!printed) {
        process.stdout.write("\n");
        printed = true;
      }
      process.stdout.write(`\r\u001b[2K${redactSecrets(line)}`);
    },
    done() {
      if (tty && printed) process.stdout.write("\r\u001b[2K");
    },
  };
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function days(count) {
  if (count === null) return "none";
  return count === 1 ? "1 day" : `${count} days`;
}

// A binding name is a shell variable; the first screen wants a word.
const NAMES = { github: "GitHub", s3: "S3", smtp: "SMTP", imap: "IMAP", http: "HTTP" };

function label(name) {
  const stem = name.replace(/_(BASE_URL|URL|HOST_PORT|TOKEN)$/, "").toLowerCase();
  return NAMES[stem] ?? stem.replace(/^./, (character) => character.toUpperCase());
}

export function bindingCanBePrinted(name, value) {
  if (typeof value !== "string" || /(?:^|_)(?:TOKEN|USERNAME|PASSWORD|SECRET|ACCESS_KEY)(?:_|$)/i.test(name)) return false;
  try { if (new URL(value).password) return false; } catch { /* Not a URL. */ }
  return true;
}

function printVerbose(instance) {
  say();
  say("Services");
  for (const service of instance.lock.services) {
    const readiness = instance.readiness.get(service.name);
    say(`  ${service.name} ${service.version}  ${readiness.proven} protocol checks passed`);
    for (const port of service.ports) {
      const { host, port: number } = instance.addressOf(service.name, port.name);
      say(`    ${pad(port.name, 14)}${port.protocol.padEnd(6)} ${host}:${number}${port.published ? "" : "  (private)"}`);
    }
    for (const check of readiness.checks) say(`    ${check.kind.padEnd(14)}${check.detail}`);
  }

  if (instance.lock.closed_conflicts.length > 0) {
    say();
    say("Closed conflicts");
    for (const conflict of instance.lock.closed_conflicts) {
      say(`  ${conflict.disclaimed_by}/${conflict.port} stays shut: ${conflict.owner} owns ${conflict.profile}`);
    }
  }

  const timeline = timelineState(instance.state);
  const clock = clockState(instance.state);
  if (timeline.total > 0) {
    say();
    say("Timeline");
    say(`  ${timeline.total} scheduled arrivals, ${timeline.pending} pending`);
    // `next_due_ms` IS NULL WHEN NOTHING IS PENDING, AND NULL IS NOT ZERO.
    // `?? 0` turned an empty queue into "next arrival at t+0s" on the line right
    // under "0 pending". Every shipped world drains inside ten minutes -- the
    // last arrival is t+540s in v2, t+599s in v3 and t+600s in the retail world
    // -- so any run left open past that printed a next arrival that was never
    // coming.
    const next = timeline.next_due_ms === null
      ? "no arrivals left"
      : `next arrival at t+${Math.round(timeline.next_due_ms / 1000)}s`;
    say(`  clock ${clock.running ? "running" : "stopped"}, ${next}`);
  }

  say();
  say("World");
  for (const [file, entry] of Object.entries(instance.lock.world.projections)) {
    const verified = entry.verified_by.length > 0 ? `verified by ${entry.verified_by.join(", ")}` : "read only";
    say(`  ${file}  ${entry.sha256.slice(0, 12)}…  ${verified}`);
  }
}

// `up` holds the world open. Ctrl-C stops every child and returns the terminal.
function runUntilInterrupted(instance, bindingsPath, control, workbench, scheduler) {
  return new Promise((resolve) => {
    let stopping = false;

    const stop = async () => {
      if (stopping) return;
      stopping = true;
      say();
      say("Stopping…");
      // Before the services, so no arrival is halfway through a provider write
      // when the provider goes away.
      await (instance.sessionManager?.instance.timelineControl ?? scheduler)?.stop();
      await workbench.close();
      await control.close();
      const stopped = instance.sessionManager ? await instance.sessionManager.stop() : await instance.stop();
      rmSync(bindingsPath, { force: true });
      rmSync(bindingsPath.replace("bindings.json", "addresses.json"), { force: true });
      rmSync(bindingsPath.replace("bindings.json", "workbench.json"), { force: true });
      for (const record of stopped ?? []) {
        if (record.exited === null) say(`  ${record.service} did not exit`);
      }
      say("Stopped. No process is left holding a port.");
      resolve();
    };

    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}

async function reset({ flags }) {
  const { stateDir } = paths(flags);
  if (process.env.WORLDFIXTURE_SINGLE_CONTAINER !== "1" && hostInstance(stateDir)) {
    try {
      say(await resetHostInstance(stateDir));
    } catch (error) {
      say(`Reset failed: ${error.message}`);
      process.exitCode = 1;
    }
    return;
  }
  if (!readBindings(stateDir)) {
    say(`No instance is running. Run \`${invocation()} up\` first.`);
    process.exitCode = 1;
    return;
  }

  try {
    const result = await requestReset(stateDir);
    say(`World restored exactly across ${result.services.length} services.`);
    if (result.preserved?.length) {
      say(`Preserved service data: ${result.preserved.join(", ")}.`);
    }
  } catch (error) {
    say(`Reset failed: ${error.message}`);
    say("Inspect `worldfixture switch --status` and the service logs before retrying.");
    process.exitCode = 1;
  }
}

export function clockCommandInput(positional) {
  const [action = "status", duration, ...extra] = positional;
  if (!["status", "pause", "resume", "advance", "start"].includes(action) || extra.length
      || (!["advance", "start"].includes(action) && duration !== undefined)) {
    throw new BuildError("invalid_arguments", "Use clock, clock pause, clock resume, clock advance <duration>, or clock start <duration>.");
  }
  if (["advance", "start"].includes(action)) parseDuration(duration);
  return { action, ...(["advance", "start"].includes(action) ? { duration } : {}) };
}

function printClock(result) {
  const { clock, timeline, repeat } = result;
  say(`Clock: ${result.mode === "setup" ? "setup" : clock.running ? "running" : "paused"} · t+${clock.elapsed_ms / 1000}s${clock.world_now ? ` · ${clock.world_now}` : ""}`);
  say(`Timeline: ${timeline.pending} pending · ${timeline.in_flight} in flight · ${timeline.delivered} delivered · ${timeline.failed} failed · ${timeline.skipped} skipped${timeline.uncertain ? ` · ${timeline.uncertain} uncertain` : ""}`);
  if (timeline.next_due_ms === null) say("No scheduled arrivals remain.");
  else say(`Next arrival: t+${timeline.next_due_ms / 1000}s`);
  if (result.mode === "setup") say("Choose a starting position in the Workbench. No arrivals have been applied.");
  if (repeat?.enabled) say(`Loop: pass ${repeat.cycle} · ${repeat.status}. Provider data and delivery history stay intact.`);
  if (repeat?.error) say(`Loop stopped: ${repeat.error}`);
}

async function clockCommand({ flags, positional }) {
  if (flags.help) {
    say("worldfixture clock [--json]\nworldfixture clock pause\nworldfixture clock resume\nworldfixture clock advance <duration>\nworldfixture clock start <duration>\n\nDurations: 90s, 5m, 1w. Advance keeps a paused clock paused. Start applies a setup position once.");
    return;
  }
  const input = clockCommandInput(positional);
  const result = await requestControl(paths(flags).stateDir, input);
  if (flags.json) say(JSON.stringify(result));
  else printClock(result);
}

async function down({ flags }) {
  const { stateDir } = paths(flags);
  if (!(await stopHostInstance(stateDir))) {
    say("No instance is running.");
    return;
  }
  say("Stopped. The container and all child processes are gone.");
}

// ---- the read-only commands ----------------------------------------------

async function executeSessionOperation(instance, input) {
  const world = readWorld(instance.artifactPath), bindings = instance.applicationBindings ?? instance.bindings();
  if (input.kind === 'slack-send') {
    const person = world.people?.find(row => row.id === input.personId);
    const channel = world.communication?.channels?.find(row => row.id === input.channelId);
    if (!person || !channel || typeof input.text !== 'string') throw new Error('The selected person or channel does not belong to this world.');
    const result = await submit(instance.state, { baseUrl: bindings.SLACK_BASE_URL,
      token: tokenFor(person, instance.credentials), person, channel, text: input.text },
    { world, rules: instance.lock.rules ?? [], bindings, credentials: instance.credentials, generation: instance.generation });
    return { result };
  }
  if (input.kind !== 'connector') throw new Error('Unknown session operation');
  const baseUrl = input.baseUrl, token = instance.runtimeToken;
  const selected = connectorWorld(instance.artifactPath, { scale: input.scale, limits: input.limits });
  assertWorldMatchesInstance(selected, instance.lock, { generation: instance.generation, expectedGeneration: instance.generation });
  let result;
  if (input.action === 'check') result = await checkConnector(baseUrl, { world: selected, token });
  else if (input.action === 'plan') result = await planConnector(baseUrl, { world: selected, token });
  else if (input.action === 'seed') result = await seedConnector(baseUrl, { world: selected, token });
  else if (input.action === 'status') result = await connectorStatus(baseUrl, { token });
  else if (input.action === 'reset') result = await resetConnector(baseUrl, { token });
  else if (input.action === 'event') result = await deliverConnectorEvent(baseUrl, input.event, { token });
  else if (input.action === 'replay') {
    const observed = drain(instance.state, 0).rows;
    if (input.list) result = observedKinds(observed);
    else {
      const event = connectorEventFromWorldEvent(selectWorldEvent(observed, input.eventKind), world);
      result = input.print ? event : await deliverConnectorEvent(baseUrl, event, { token });
    }
  } else throw new Error('Unknown connector operation');
  return { result };
}

async function switchCommand({ flags, positional }) {
  const { stateDir } = paths(flags);
  if (flags.help) return say('worldfixture switch <world> [--no-rebase]\nworldfixture switch --status\nworldfixture switch --connect <application-url>\nworldfixture switch --without-application\n\nSwitch restores provider state and keeps application databases. Confirm the new connection before starting its timeline.');
  if (flags.status) {
    if (positional.length || flags.connect || flags['without-application']) throw new Error('Use switch --status on its own.');
    return printConnectorValue(await requestManagedControl(stateDir, { action: 'session-status' }), { json: true });
  }
  if (flags.connect || flags['without-application']) {
    if (positional.length || flags['world-path'] || flags.world || (flags.connect && flags['without-application'])) throw new Error('Choose one connection operation.');
    return printConnectorValue(await requestManagedControl(stateDir, { action: 'confirm-connection', input: flags.connect
      ? { applicationUrl: flags.connect } : { withoutApplication: true } }, { timeoutMs: 900_000 }), { json: true });
  }
  if (positional.length > 1 || (positional.length && (flags.world || flags['world-path'])) || (flags.world && flags['world-path'])) throw new Error('Supply one world selector.');
  let selector = positional[0] ?? flags.world;
  let worldPath = flags['world-path'];
  if (!selector && !worldPath) throw new Error('Supply a world name or artifact path for the switch.');
  if (selector && (selector.includes('/') || selector.startsWith('.') || existsSync(resolve(selector)))) {
    worldPath = resolve(selector); selector = undefined;
  }
  const input = { ...(selector ? { selector } : { worldPath: resolve(worldPath) }), ...(flags['no-rebase'] ? { noRebase: true } : {}) };
  if (input.worldPath && process.env.WORLDFIXTURE_SINGLE_CONTAINER !== '1' && hostInstance(stateDir)) {
    const imported = await importSwitchArtifact(input.worldPath, { stateDir });
    input.worldPath = `/state/catalogue/${imported.digest}`;
  }
  const result = await requestManagedControl(stateDir, { action: 'switch', input }, { timeoutMs: 900_000 });
  if (flags.json) return say(JSON.stringify(result));
  say(`World switch complete. Generation ${result.generation}.`);
  say('Provider state was restored. Application databases were preserved.');
  say('Confirm the connection with `worldfixture switch --connect <url>` or `worldfixture switch --without-application`, then choose a starting position in Timeline.');
}

async function requestManagedControl(stateDir, command, options = {}) {
  if (process.env.WORLDFIXTURE_SINGLE_CONTAINER === '1' || !hostInstance(stateDir)) return requestControl(stateDir, command, options);
  const active = readActiveGeneration(stateDir, { allowTransition: true });
  const directory = join(stateDir, 'control-requests');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const name = `${randomUUID()}.json`, file = join(directory, name);
  writeFileSync(file, JSON.stringify({ ...command, generation: command.generation ?? active?.generation }), { mode: 0o600, flag: 'wx' });
  try {
    const result = await runInHostInstance(stateDir, ['control', '--file', `/state/control-requests/${name}`], { timeoutMs: options.timeoutMs ?? 120_000 });
    const value = JSON.parse(result.stdout.trim());
    if (!value.ok) throw Object.assign(new Error(value.error), value);
    return value;
  } finally { rmSync(file, { force: true }); }
}

function people({ flags }) {
  const { artifactPath } = paths(flags);
  const world = readWorld(artifactPath);

  for (const person of flags.verbose ? world.people : insiders(world)) {
    say(`${person.name}  (${person.id})`);
    say(`  ${pad("Role", 10)}${person.role}`);
    say(`  ${pad("Slack", 10)}${person.slack_id}`);
    say(`  ${pad("GitHub", 10)}${person.github_login ?? "—"}`);
    say(`  ${pad("Email", 10)}${person.email}`);
    say();
  }
}

// A service command reads the bindings a running instance wrote. It starts
// nothing: a second world started to answer a question about the first is how a
// tool ends up reporting on something nobody is using.
function readBindings(stateDir) {
  if (process.env.WORLDFIXTURE_SINGLE_CONTAINER !== "1") {
    const bindings = hostBindings(stateDir);
    if (bindings) return bindings;
  }
  try {
    return JSON.parse(readFileSync(activeFile(stateDir, 'bindingsPath', 'bindings.json'), "utf8"));
  } catch {
    return null;
  }
}

// Who a read or a send is for when `--as` was not given.
//
// IT USED TO BE THE LITERAL `maya`, who is the default world's primary person
// and nobody else's. Against any other world -- the shipped
// `consumer.retail-brand:v1`, or one somebody compiled with
// `worldfixture build` -- `slack history --channel general` answered "No person
// named undefined", naming a flag the user never typed. Every world states who
// its primary person is, so it is asked rather than assumed.
//
// A `--as` that names more than one person is REPORTED, NOT RESOLVED.
// `business.saas-company:v3` carries 161 people and four shared first segments
// -- maya, ravi, idris and lena -- so `--as maya` used to act as maya-chen and
// never mention that maya-osei was also a match. Sending a message as the wrong
// person is not a mistake the user can see afterwards, so the ambiguity is put
// in front of them instead.
function actingPerson(world, flags) {
  if (!flags.as) return { person: world.people?.find((person) => person.primary) ?? insiders(world)[0] };
  const matches = findPeople(world, flags.as);
  if (matches.length > 1) return { ambiguous: matches };
  return { person: matches[0] };
}

function sayAmbiguous(reference, matches) {
  say(`${JSON.stringify(reference)} names ${matches.length} people in this world. Say which one:`);
  for (const person of matches) say(`  ${person.id.padEnd(22)}${person.name}`);
}

async function slack({ flags, positional }) {
  const { stateDir } = paths(flags);
  const active = readActiveGeneration(stateDir);
  const artifactPath = active && !flags.world && !flags['world-path']
    ? sessionPath(stateDir, active.artifactPath) : paths(flags).artifactPath;
  if (active && (flags.world || flags['world-path'])) {
    const selected = inspectWorldArtifact(artifactPath);
    if (!selected.valid || selected.digest !== active.world.artifact_sha256) throw new SessionError('artifact_mismatch', 'The selected artifact is not the active world generation. Omit the world selector to use the running session.');
  }
  const world = readWorld(artifactPath);
  const [subcommand, ...rest] = positional;

  const bindings = readBindings(stateDir);
  if (!bindings) {
    say(`No instance is running. Start one with \`${invocation()} up\`, then run this from another terminal.`);
    process.exitCode = 1;
    return;
  }

  const base = bindings.SLACK_BASE_URL;
  if (!base) {
    say("This instance did not start Slack, so there is nothing to send through.");
    process.exitCode = 1;
    return;
  }

  const { person, ambiguous } = actingPerson(world, flags);
  if (ambiguous) {
    sayAmbiguous(flags.as, ambiguous);
    process.exitCode = 1;
    return;
  }
  if (!person) {
    say(`No person named ${JSON.stringify(flags.as)} in this world. Run \`${invocation()} people\`.`);
    process.exitCode = 1;
    return;
  }

  // Not every world person is in the workspace, and the emulator's answer for
  // one who is not is a bare 401. Say who they are instead.
  const holders = slackTokenHolders(artifactPath);
  if (!holders.has(person.id)) {
    const organization = world.organizations.find((entry) => entry.id === person.organization_id);
    say(`${person.name} has no Slack identity in this world.`);
    say(`They are at ${organization?.name ?? person.organization_id}, which is not this workspace.`);
    say();
    say("People who can act on Slack:");
    for (const id of [...holders].sort()) {
      const holder = findPerson(world, id);
      // The handle printed here is one the reader will paste after `--as`, so
      // it has to be the shortest UNAMBIGUOUS one. A bare first segment is
      // shared by two people four times over in v3.
      if (holder) say(`  ${personHandle(world, holder).padEnd(22)}${holder.name}`);
    }
    process.exitCode = 1;
    return;
  }

  const token = tokenFor(person, readRunCredentials(active ? sessionPath(stateDir, active.stateDir) : stateDir, world));

  if (subcommand === "send") {
    const channel = findChannel(world, flags.channel ?? "");
    if (!channel) {
      say(`This world has no channel named ${JSON.stringify(flags.channel)}.`);
      say(`It has ${world.communication.channels.map((entry) => entry.name).join(", ")}.`);
      process.exitCode = 1;
      return;
    }

    // Through the runtime rather than straight at the API, so the command, the
    // fact it produced and everything that fact caused are all recorded.
    const lock = runningLock(stateDir);
    const db = active ? null : openState(activeFile(stateDir, 'statePath', 'state.sqlite'));

    try {
      const result = active ? (await requestControl(stateDir, { action: 'operation', generation: active.generation,
        input: { kind: 'slack-send', personId: person.id, channelId: channel.id, text: rest.join(' ') } })).result : await submit(
        db,
        { baseUrl: base, token, person, channel, text: rest.join(" ") },
        { world, rules: lock.rules ?? [], bindings },
      );

      say(`Sent as ${result.identity.user} to #${channel.name} at ${result.event.provider_evidence.message_ts}`);

      for (const effect of result.effects) {
        say(`  Queued ${effect.type} at t+${effect.due_at / 1000}s (${effect.id}).`);
      }
    } finally {
      db?.close();
    }
    return;
  }

  if (subcommand === "history") {
    const channel = findChannel(world, flags.channel ?? "");
    const messages = await history(base, token, channel?.name ?? flags.channel);
    if (active && readActiveGeneration(stateDir).generation !== active.generation) throw new Error('The world changed during this read. Read the current generation again.');
    for (const message of messages) say(`  ${message.user ?? message.username ?? "?"}: ${message.text}`);
    return;
  }

  say(USAGE);
  process.exitCode = 1;
}

// A running instance publishes the addresses this run allocated. `status` and
// `env` read those and start nothing: a second world started to answer a
// question about the first would report on something nobody is using.
function instanceAt(stateDir) {
  const bindings = readBindings(stateDir);
  if (!bindings) return null;
  try {
    return { bindings, lock: JSON.parse(readFileSync(activeFile(stateDir, 'lockPath', 'environment.lock.json'), "utf8")) };
  } catch {
    return null;
  }
}

async function ensureRecordedInstance(stateDir) {
  if (process.env.WORLDFIXTURE_SINGLE_CONTAINER === "1" || !hostInstance(stateDir)) return true;
  if (await inspectHostInstance(stateDir)) return true;
  removeHostRecord(stateDir);
  return false;
}

// The addresses in `bindings.json` are what this run allocated, so a port is
// read back out of them rather than guessed.
function addressReader(lock, bindings, stateDir) {
  const byPort = new Map();

  // The full allocation when the instance published one, so a private port can
  // be probed too.
  try {
    const recorded = process.env.WORLDFIXTURE_SINGLE_CONTAINER === "1"
      ? JSON.parse(readFileSync(activeFile(stateDir, 'addressesPath', 'addresses.json'), "utf8"))
      : hostAddresses(stateDir) ?? JSON.parse(readFileSync(activeFile(stateDir, 'addressesPath', 'addresses.json'), "utf8"));
    for (const [key, address] of Object.entries(recorded)) {
      byPort.set(key, { host: address.host, port: address.port });
    }
  } catch {
    /* an instance that published only its bindings; recovered below */
  }

  for (const [name, source] of Object.entries(lock.bindings ?? {})) {
    const value = bindings[name];
    if (typeof value !== "string") continue;
    const match = value.match(/(?:^https?:\/\/)?([^:/]+):(\d+)/);
    if (match && !byPort.has(`${source.service}/${source.port}`)) {
      byPort.set(`${source.service}/${source.port}`, { host: match[1], port: Number(match[2]) });
    }
  }
  return (service, port) => {
    const address = byPort.get(`${service}/${port}`);
    if (!address) throw new Error(`this instance publishes no address for ${service}/${port}`);
    return address;
  };
}

async function status({ flags }) {
  const located = paths(flags);
  const { stateDir } = located;
  await ensureRecordedInstance(stateDir);
  const found = instanceAt(stateDir);

  if (!found) {
    say("No instance is running.");
    say();
    say("Run:");
    say(`  ${invocation()} up`);
    process.exitCode = 1;
    return;
  }

  const { bindings, lock } = found;
  const addressOf = addressReader(lock, bindings, stateDir);
  const world = readWorld(located.artifactPath);

  say(`${pad("World", 14)}${lock.world.id}:${lock.world.version}`);
  say(`${pad("Artifact", 14)}${lock.world.artifact_sha256.slice(0, 12)}…`);
  say(`${pad("State", 14)}${stateDir.replace(`${process.cwd()}/`, "")}`);
  say();

  // Readiness is asked again, now, over each service's own protocol. Reporting
  // what the lock declared would be reporting an intention.
  for (const service of lock.services) {
    const results = [];
    for (const check of service.readiness) {
      let address;
      try {
        address = addressOf(service.name, check.port);
      } catch {
        // A port with no binding is not published, so nothing outside the
        // instance can probe it. Say that rather than call it unhealthy.
        results.push({ ...check, ok: null, detail: "not published by this instance" });
        continue;
      }
      results.push({ ...check, ...(await probe(check, address)) });
    }

    const measurable = results.filter((entry) => entry.ok !== null);
    const healthy = aggregate(measurable).ready;
    const count = service.profiles.length;
    say(`${pad(service.name, 14)}${healthy ? "ready" : "NOT READY"}  ${count} ${count === 1 ? "capability" : "capabilities"}`);

    if (flags.verbose) {
      for (const entry of results) {
        const mark = entry.ok === null ? "-" : entry.ok ? "ok" : "FAIL";
        say(`  ${mark.padEnd(6)}${entry.kind.padEnd(11)}${entry.port.padEnd(12)}${entry.detail}`);
      }
      for (const profile of service.profiles) say(`  ${" ".repeat(6)}provides   ${profile}`);
    }
  }

  if (flags.verbose && lock.closed_conflicts.length > 0) {
    say();
    say("Closed conflicts");
    for (const conflict of lock.closed_conflicts) {
      say(`  ${conflict.disclaimed_by}/${conflict.port} stays shut: ${conflict.owner} owns ${conflict.profile}`);
    }
  }

  say();
  const held = contents(world);
  say(`${pad("People", 14)}${held.people}, ${held.slack_messages} Slack messages, ${held.mail_messages} emails`);
}

async function applicationEnvironment(flags) {
  const located = paths(flags);
  const { stateDir } = located;
  await ensureRecordedInstance(stateDir);
  const active = readActiveGeneration(stateDir);
  const found = instanceAt(stateDir);

  if (!found) {
    say(`No instance is running. Run \`${invocation()} up\` first.`);
    process.exitCode = 1;
    return;
  }

  const { bindings, lock } = found;
  const artifactPath = located.artifactPath;
  if (active && (flags.world || flags['world-path'])) {
    const selected = inspectWorldArtifact(artifactPath);
    if (!selected.valid || selected.digest !== active.world.artifact_sha256) throw new SessionError('artifact_mismatch', 'The selected artifact is not the active world generation. Omit the world selector to use the running session.');
  }
  const { resolved, unresolved } = resolveBindings(lock, {
    addressOf: addressReader(lock, bindings, stateDir),
    artifactPath,
    credentials: readRunCredentials(activeStateDir(stateDir), lock.world),
  });
  const values = Object.fromEntries(Object.entries(resolved).map(([name, entry]) => [name, entry.value]));
  for (const name of ['WORKBENCH_URL', 'WORLDFIXTURE_TOKEN']) {
    if (bindings[name] !== undefined) values[name] = bindings[name];
  }
  if (readActiveGeneration(stateDir)?.generation !== active?.generation) throw new SessionError('stale_generation', 'The active world changed while reading bindings. Read the connection settings again.');
  return { values, resolved, unresolved, lock };
}

async function env({ flags }) {
  const current = await applicationEnvironment(flags);
  if (!current) return;
  const { values, resolved, unresolved, lock } = current;
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(values)}\n`);
    return;
  }

  for (const name of Object.keys(values).sort()) {
    process.stdout.write(`export ${name}=${shellQuote(values[name])}\n`);
  }

  // Bindings without a person can explicitly request a shared service token.
  for (const [name, entry] of Object.entries(resolved)) {
    if (entry.scope === "shared") say(`# ${name} is a shared token, not ${lock.target?.identity ?? "one person"}'s`);
  }
  for (const entry of unresolved) say(`# ${entry.name} could not be resolved: ${entry.reason}`);
}

async function mail({ flags, positional }) {
  const { stateDir } = paths(flags);
  const active = readActiveGeneration(stateDir);
  const artifactPath = active && !flags.world && !flags['world-path']
    ? sessionPath(stateDir, active.artifactPath) : paths(flags).artifactPath;
  if (active && (flags.world || flags['world-path'])) {
    const selected = inspectWorldArtifact(artifactPath);
    if (!selected.valid || selected.digest !== active.world.artifact_sha256) throw new SessionError('artifact_mismatch', 'The selected artifact is not the active world generation. Omit the world selector to use the running session.');
  }
  const world = readWorld(artifactPath);
  const bindings = readBindings(stateDir);

  if (!bindings?.IMAP_HOST_PORT) {
    say(`No instance with Local Mail is running. Start one with \`${invocation()} up\`.`);
    process.exitCode = 1;
    return;
  }

  const { person, ambiguous } = actingPerson(world, flags);
  if (ambiguous) {
    sayAmbiguous(flags.as, ambiguous);
    process.exitCode = 1;
    return;
  }
  if (!person) {
    say(`No person named ${JSON.stringify(flags.as)} in this world. Run \`${invocation()} people\`.`);
    process.exitCode = 1;
    return;
  }

  if (positional[0] !== "inbox") {
    say(USAGE);
    process.exitCode = 1;
    return;
  }

  const account = accountFor(artifactPath, person);
  if (!account) {
    say(`${person.name} has no mailbox in this world.`);
    process.exitCode = 1;
    return;
  }

  // Over IMAP, as the person, with the world's own fixture credential. Nothing
  // here reads Cyrus's files.
  const result = await inbox(bindings.IMAP_HOST_PORT, {
    login: account.login,
    password: credential(readRunCredentials(active ? sessionPath(stateDir, active.stateDir) : stateDir, world), account.password_ref),
    mailbox: flags.folder ?? "INBOX",
    limit: Number(flags.limit ?? 10),
  });

  if (active && readActiveGeneration(stateDir).generation !== active.generation) throw new Error('The world changed during this read. Read the current generation again.');
  say(`${person.name} — ${result.mailbox}, ${result.exists} messages`);
  say();
  for (const message of result.messages) {
    say(`  ${(message.headers.from ?? "?").slice(0, 44).padEnd(46)}${message.headers.subject ?? ""}`);
    if (message.headers.date) say(`  ${" ".repeat(46)}${message.headers.date}`);
  }
}

function accountFor(artifactPath, person) {
  const projection = JSON.parse(readFileSync(`${artifactPath}/projections/mail.json`, "utf8"));
  return projection.users.find((user) => user.id === person.id);
}

// The observation ledger, as it stands. Completed facts and their provider
// evidence; not a copy of any service's state.
//
// This runs INSIDE the recorded container, where the SQLite file and the
// processes that write it live. `main` forwards the host call there, so a
// follower reads the same committed rows the writers produced rather than a
// bind-mounted copy of them.
async function events({ flags }) {
  const { stateDir } = paths(flags);

  // A stopped instance leaves its SQLite file behind, and reading it would print
  // the last run's ledger as though it were live -- and `--follow` would then
  // wait forever for an event that nothing can produce. Found by running the
  // command after `down`. The bindings file is the same liveness test `slack`
  // and `mail` use, and it is removed when an instance stops.
  if (!readBindings(stateDir)) {
    say("No instance is running, so there is no ledger to follow.");
    say();
    say("Run:");
    say(`  ${invocation()} up`);
    process.exitCode = 1;
    return;
  }

  const db = openState(activeFile(stateDir, 'statePath', 'state.sqlite'));
  const write = (text) => process.stdout.write(text);

  try {
    if (!flags.follow) {
      printExisting(db, { write, verbose: flags.verbose });
      return;
    }

    const controller = new AbortController();
    const stop = () => controller.abort();

    // Ctrl-C, `docker stop`, and the host client going away. The third is why
    // the host passes WORLDFIXTURE_STOP_ON_STDIN_EOF: `docker exec` does not
    // forward signals, so without it a follower would outlive its terminal.
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    if (process.env.WORLDFIXTURE_STOP_ON_STDIN_EOF === "1") {
      process.stdin.resume();
      process.stdin.on("end", stop);
      process.stdin.on("close", stop);
      process.stdin.on("error", stop);
    }

    try {
      await follow(db, { write, verbose: flags.verbose, signal: controller.signal });
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      process.stdin.pause();
    }
    write("\nStopped following.\n");
  } finally {
    db.close();
  }
}

// ---- doctor ---------------------------------------------------------------

// Diagnose, never repair. Every finding names the failed component, the direct
// cause, and one repair command; the repair is printed rather than run, because
// everything doctor could do for the user -- remove a container, delete a state
// directory -- destroys something they may still want.
async function doctor({ flags }) {
  const { artifactPath, stateDir } = paths(flags);
  mkdirSync(stateDir, { recursive: true });

  if (flags["fix-ports"]) {
    say("`doctor --fix-ports` is not implemented and is deferred.");
    say();
    say("Why   `worldfixture up` already selects a free fallback host port when a preferred");
    say("      one is busy, so there is no wedged port left for a repair command to unwedge.");
    say(`Next  Run \`${invocation()} doctor\` to see which ports this instance selected, and`);
    say(`      \`${invocation()} env\` for the addresses your application should use.`);
    process.exitCode = 1;
    return;
  }

  const report = await diagnose({
    artifactPath,
    stateDir,
    image: flags.image ?? process.env.WORLDFIXTURE_IMAGE ?? defaultImage(),
  });

  say(formatReport(report, { verbose: flags.verbose }));
  if (!report.healthy) process.exitCode = 1;
}

// ---- open -----------------------------------------------------------------

// The Workbench is optional and its host port is whatever the launcher could
// get. Both facts are why this command exists: it reads the recorded
// WORKBENCH_URL for this instance and never assumes a number.
async function openCommand({ flags }) {
  const { stateDir } = paths(flags);

  try {
    const opened = await openWorkbench({ stateDir });
    say(`Opened the Workbench at ${opened.url}`);
    if (!opened.tested) {
      say(`This platform (${opened.platform}) is wired but untested; ${TESTED_PLATFORMS.join(", ")} is tested.`);
    }
  } catch (error) {
    if (!(error instanceof OpenError)) throw error;
    say();
    say(`open failed: ${error.message}`);
    say("No world state changed.");
    if (error.repair) {
      say();
      say("Run:");
      say(`  ${error.repair}`);
    }
    process.exitCode = 1;
  }
}

// ---- build ---------------------------------------------------------------

// The image the compiler runs in is the image the world will run in.
//
// One resolution order for every command that reaches Docker, so a person who
// pins `WORLDFIXTURE_IMAGE` or passes `--image` builds with the same runtime
// they start, and an artifact can never be compiled by a version of the compiler
// that the running image does not have.
function imageFor(flags) {
  return flags.image ?? process.env.WORLDFIXTURE_IMAGE ?? defaultImage();
}

// The image has to be here before the compiler can run in it. `up` already
// fetches it with this function and prints this line; `build` says the same
// thing for the same reason, because a first `build` on a new machine is just as
// likely to be somebody's first Docker pull.
async function ensureImageFor(image) {
  try {
    await ensureHostImage(image, {
      onProgress: (name) => {
        say();
        say(`Fetching    ${name}`);
        say("            about 190 MB, once; later runs reuse it");
      },
    });
  } catch (error) {
    // Docker itself missing is answered once, at the bottom of this file, and
    // that answer is better than anything said here.
    if (error?.code === "ENOENT") throw error;
    throw new BuildError(
      "image_unavailable",
      error.message,
      error.repair ?? `Build the image locally, or name one you have with --image <name>.`,
    );
  }
}

// Hand somebody a world they can edit.
//
// WHY A COMMAND AND NOT A `cp` IN THE README. The starter world lives in the
// package, and where that is depends on how WorldFixture was installed: a
// checkout has `examples/minimal-world` beside the README, and an npm install
// has it somewhere under `node_modules` that nobody should have to name. The
// README said `cp -r examples/minimal-world ./my-world`, which worked from a
// checkout and left everybody else with nothing to copy -- and the starter
// world is the whole reason authoring your own is approachable, because the
// profile compiles seven domains that have to be declared even when empty.
async function newCommand({ flags, positional }) {
  const [target] = positional;
  if (!target || flags.help) {
    say("worldfixture new <directory>");
    say();
    say("  Copy the smallest world that runs into <directory>, ready to edit.");
    say();
    say("Then:");
    say(`  ${invocation()} validate <directory>`);
    say(`  ${invocation()} build <directory>`);
    if (!target && !flags.help) process.exitCode = 1;
    return;
  }

  const template = join(PACKAGE_ROOT, "examples/minimal-world");
  if (!existsSync(join(template, "world.json"))) {
    throw new BuildError(
      "template_missing",
      `this build has no starter world at ${template}`,
      "Reinstall WorldFixture, or copy a world from `worlds/` in a source checkout.",
    );
  }

  const destination = resolve(target);
  if (existsSync(destination)) {
    throw new BuildError(
      "destination_exists",
      `${destination} already exists`,
      "Name a directory that does not exist yet, so nothing of yours is replaced.",
    );
  }

  cpSync(template, destination, { recursive: true });
  say(`Copied the starter world to ${destination}`);
  say();
  say("It is two people, one channel, two messages, one project and one task.");
  say("Edit `fragments/core.json`, then:");
  say(`  ${invocation()} validate ${target}`);
  say(`  ${invocation()} build ${target}`);
}

const BUILD_USAGE = `worldfixture build <source> [--output <dir>]

  <source>   A directory holding world.json, or the world.json file itself
  --output   Where the artifact is written (default dist/<id>.<version>)

The artifact builder runs inside the WorldFixture image. Building a world needs
Docker and nothing else -- no Python and no checkout of this repository.`;

async function buildCommand({ flags, positional }) {
  const [source] = positional;
  if (!source || flags.help) {
    say(BUILD_USAGE);
    if (!source && !flags.help) process.exitCode = 1;
    return;
  }

  // The source is checked before the image is fetched.
  //
  // `ensureImageFor` pulls 190 MB the first time. Doing that ahead of the
  // cheapest possible check meant `worldfixture build ./typo` spent a download
  // before saying the path does not exist -- and when the image itself cannot be
  // reached, reported the registry rather than the typo. Local and free first,
  // network and slow second.
  inspectSource(source);

  const image = imageFor(flags);
  await ensureImageFor(image);
  const built = await buildWorldSource({ source, output: flags.output, image });

  say();
  say(`Built       ${built.id}@${built.version}`);
  say(`            ${built.outputDir}`);
  say();
  say("Start it:");
  say(`  ${invocation()} up --world-path ${built.outputDir}`);
}

async function validateCommand({ flags, positional }) {
  const [source] = positional;
  if (!source || flags.help) {
    say("worldfixture validate <source>");
    say();
    say("  <source>   A directory holding world.json, or the world.json file itself");
    say();
    say("Checks the world the same way `build` does, and writes nothing.");
    if (!source && !flags.help) process.exitCode = 1;
    return;
  }

  // Checked locally before the image is fetched, for the same reason `build`
  // does it: a typo should not cost a 190 MB download.
  inspectSource(source);

  const image = imageFor(flags);
  await ensureImageFor(image);
  const checked = await validateWorldSource({ source, image });
  say();
  say(`${checked.id}@${checked.version} is a valid world. Build it with \`${invocation()} build ${source}\`.`);
}

// Called only for a new launch, after the host launcher's reuse/refusal check.
function prepareSessionInput(builtPath, stateDir, expectedWorld) {
  const staged = stageWorldArtifact(builtPath, stateDir, expectedWorld);
  // A previous rebased world must not mask this run's authored input snapshot.
  rmSync(join(stateDir, "world"), { recursive: true, force: true });
  return staged;
}

export function prepareContainerArgs(builtPath, stateDir, flags = {}, expectedWorld) {
  validateTimelineStart(flags);
  prepareSessionInput(builtPath, stateDir, expectedWorld);
  const args = ["--world-path", "/state/input-world"];
  if (flags.only) args.push("--only", String(flags.only));
  if (flags["application-url"]) args.push("--application-url", String(flags["application-url"]));
  if (flags["no-rebase"]) args.push("--no-rebase");
  if (flags["start-at"] !== undefined) args.push("--start-at", String(flags["start-at"]));
  if (flags.repeat) args.push("--repeat");
  if (flags.setup) args.push("--setup");
  return args;
}

function stageWorldArtifact(builtPath, stateDir, expectedWorld = inspectWorldArtifact(builtPath)) {
  const verify = path => {
    const checked = inspectWorldArtifact(path);
    if (!checked.valid || checked.id !== expectedWorld.id || checked.version !== expectedWorld.version || checked.digest !== expectedWorld.digest) {
      throw new BuildError("artifact_changed", `World artifact changed before startup: ${checked.errors.join("; ") || "the copied identity or digest differs from the selected artifact"}`,
        "Select the world again after its build completes.");
    }
    return checked;
  };
  const source = verify(builtPath);
  const staged = join(stateDir, "input-world");
  if (existsSync(staged) && realpathSync(builtPath) === realpathSync(staged)) {
    return staged;
  }
  mkdirSync(stateDir, { recursive: true });
  const pending = mkdtempSync(join(stateDir, ".input-world-"));
  try {
    // Copy the artifact's declared files only. The current project and its
    // state can be inside the artifact directory when someone runs `up .`.
    for (const name of ["manifest.json", ...Object.keys(source.manifest.files)]) {
      const target = join(pending, name);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(builtPath, name), target);
    }
    verify(pending);
    shareHostArtifact(pending);
    rmSync(staged, { recursive: true, force: true });
    renameSync(pending, staged);
  } catch (error) {
    rmSync(pending, { recursive: true, force: true });
    throw error;
  }
  return staged;
}

// ---- dispatch ------------------------------------------------------------

export async function main(argv) {
  const [command, ...rest] = argv;
  if (command === "run") return runApplication(rest);
  try {
    const parsed = parse(rest);
    if (command === "clock" && !parsed.flags.help) clockCommandInput(parsed.positional);
    // Commands that read or change runtime-owned state execute in the recorded
    // container. SQLite locking across a Docker Desktop bind mount is not a
    // safe control contract, and reset must clear the same runtime state
    // connection that recorded the action.
    if (
      process.env.WORLDFIXTURE_SINGLE_CONTAINER !== "1" &&
      ["slack", "mail", "events", "clock"].includes(command)
    ) {
      const { stateDir } = paths(parsed.flags);
      if (hostInstance(stateDir)) {
        const forwarded = rest.filter((value, index) => value !== "--state" && rest[index - 1] !== "--state");

        // `events --follow` never returns on its own, so it is streamed rather
        // than buffered. Ctrl-C here closes the container end of the exec first
        // and the client second, which is what keeps a follower from outliving
        // the terminal that started it.
        if (command === "events" && parsed.flags.follow) {
          const controller = new AbortController();
          const interrupt = () => controller.abort();
          process.on("SIGINT", interrupt);
          process.on("SIGTERM", interrupt);
          try {
            const { code } = await streamInHostInstance(stateDir, [command, ...forwarded], {
              onOutput: (chunk, stream) => (stream === "stderr" ? process.stderr : process.stdout).write(chunk),
              signal: controller.signal,
            });
            if (code && !controller.signal.aborted) process.exitCode = code;
          } finally {
            process.off("SIGINT", interrupt);
            process.off("SIGTERM", interrupt);
          }
          return;
        }

        const result = await runInHostInstance(stateDir, [command, ...forwarded]);
        process.stdout.write(result.stdout);
        process.stderr.write(result.stderr);
        // The command's own exit status, the way the streamed path already does
        // it. A refusal that prints its reason and exits 0 is a command that
        // lied to every script calling it.
        if (result.code) process.exitCode = result.code;
        return;
      }
    }
    switch (command) {
      case "worlds":
        return worlds(parsed);
      case "up":
        return await up(parsed);
      case "people":
        return people(parsed);
      case "slack":
        return await slack(parsed);
      case "mail":
        return await mail(parsed);
      case "events":
        return await events(parsed);
      case "status":
        return await status(parsed);
      case "env":
        return await env(parsed);
      case "reset":
        return await reset(parsed);
      case "clock":
        return await clockCommand(parsed);
      case 'switch':
        return await switchCommand(parsed);
      case 'control': {
        if (!parsed.flags.file) throw new Error('Control requires a request file.');
        const command = JSON.parse(readFileSync(resolve(parsed.flags.file), 'utf8'));
        try { return say(JSON.stringify(await requestControl(paths(parsed.flags).stateDir, command, { timeoutMs: 900_000 }))); }
        catch (error) { process.exitCode = 1; return say(JSON.stringify({ ok: false, error: error.message, code: error.code, state_changed: error.state_changed, detail: error.detail })); }
      }
      case "down":
        return await down(parsed);
      case "doctor":
        return await doctor(parsed);
      case "open":
        return await openCommand(parsed);
      case "connector":
        return await connectorCommand(parsed);
      case "new":
        return await newCommand(parsed);
      case "build":
        return await buildCommand(parsed);
      case "validate":
        return await validateCommand(parsed);
      case undefined:
      case "help":
      case "--help":
        return say(USAGE);
      default:
        say(`Unknown command ${JSON.stringify(command)}.`);
        say();
        say(USAGE);
        process.exitCode = 1;
        return undefined;
    }
  } catch (error) {
    if (["clock", "switch", "control"].includes(command) || error instanceof ClockError || error instanceof TimelineControlError || error instanceof SessionError) {
      say(`${command ?? "worldfixture"} failed: ${error.message}`);
      if (error.result?.clock) printClock(error.result);
      if (error.detail?.repair) say(error.detail.repair);
      if (error.state_changed && command === "up") say("Initial positioning failed. The instance was stopped; its result remains in the run state directory.");
      process.exitCode = 1;
      return undefined;
    }
    // DOCKER IS NOT INSTALLED.
    //
    // Every command here reaches Docker eventually, and without it Node throws
    // `spawn docker ENOENT` -- a stack trace naming an internal child-process
    // frame. That is the first thing a new person would ever see from this tool,
    // and it does not name the cause or the fix.
    //
    // Caught once here rather than at each of the twenty-odd call sites, because
    // the answer is the same wherever it happens.
    if (error?.code === "ENOENT" && (error.path === "docker" || String(error.syscall ?? "").includes("docker"))) {
      say();
      say("worldfixture failed: Docker is not installed, or is not on your PATH.");
      say("No world state changed.");
      say();
      say("WorldFixture runs the world in one Docker container, so Docker has to be there first.");
      say();
      say("Install one of:");
      say("  Docker Desktop   https://docs.docker.com/get-started/get-docker/");
      say("  OrbStack         https://orbstack.dev  (macOS)");
      say();
      say(`Then run \`${invocation()} doctor\` to check the rest of the setup.`);
      process.exitCode = 1;
      return undefined;
    }
    // A SCALE THAT DOES NOT EXIST.
    //
    // `--scale tiny` and `--limit widgets=5` are typos, not failures of the
    // world, and the message says which names this build and this world do have.
    // Reported before anything is sent, so nothing has to be undone.
    // THE MOST LIKELY FIRST-USE FAILURE, and it printed a stack trace.
    //
    // `HostLauncherError` carries a `code` and a written `repair` line -- the
    // image cannot be pulled, a port is taken, a container of the same name is
    // not ours -- and nothing caught it, so all of that careful text went into a
    // Node stack trace naming `host-launcher.mjs:281`. The first thing somebody
    // sees when `npx worldfixture up` cannot reach the registry should be the
    // sentence that tells them what to do.
    if (error instanceof HostLauncherError) {
      say();
      say(`worldfixture failed: ${error.message}`);
      say("No world state changed.");
      if (error.repair) {
        say();
        say(error.repair);
      }
      process.exitCode = 1;
      return undefined;
    }
    if (error instanceof ScaleError) {
      say();
      say(`worldfixture failed: ${error.message}`);
      say("No application state changed.");
      process.exitCode = 1;
      return undefined;
    }
    // A WORLD SOURCE THAT CANNOT BE COMPILED, OR AN ARTIFACT THAT IS NOT ONE.
    //
    // The compiler prints its own refusal on the way past, so this adds the one
    // thing it cannot know: which file the CLI was looking at and what to do
    // next. Nothing here writes into the world, so the state line is always the
    // same and is still said, because a failing build should not leave anybody
    // wondering whether a half-written artifact is now on disk.
    if (error instanceof BuildError) {
      say();
      // Named for the command the user actually typed. `source_missing` is
      // raised by `build` and `validate` alike, and answering "build failed"
      // to somebody who typed `validate` names a command they did not run.
      const component = ["build", "validate", "up"].includes(command)
        ? command
        : ({ not_a_world_artifact: "up", validation_failed: "validate" }[error.code] ?? "build");
      say(`${component} failed: ${error.message}`);
      say("No world state changed.");
      if (error.repair) {
        say();
        say(error.repair);
      }
      process.exitCode = 1;
      return undefined;
    }
    if (error instanceof ConnectorError) {
      say();
      say(`connector failed: ${error.message}`);
      say("No application state changed unless the connector returned an invalid response after accepting a request.");
      process.exitCode = 1;
      return undefined;
    }
    if (error instanceof ResolutionError || error instanceof StartupError) return fail(error);
    if (error.slack || error.code === "no_such_channel") {
      say();
      say(`slack failed: ${error.message}`);
      say("No world state changed.");
      return undefined;
    }
    throw error;
  }
}
