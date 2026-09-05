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

import { execFileSync, spawn } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { defaultEnvironment } from "./environments.mjs";
import { loadManifests } from "./manifests.mjs";
import { ResolutionError, resolveEnvironment, serializeLock } from "./resolve.mjs";
import { StartupError, start } from "./supervisor.mjs";
import { contents, findChannel, findPeople, findPerson, insiders, personHandle, primaryOrganization, readWorld } from "./world.mjs";
import { history, slackTokenHolders, tokenFor } from "./slack.mjs";
import { submit } from "./commands.mjs";
import { inbox } from "./imap.mjs";
import { openState } from "./state.mjs";
import { resolveBindings, shellQuote } from "./bindings.mjs";
import { aggregate, probe } from "./readiness.mjs";
import { SINGLE_CONTAINER_PORTS } from "./ports.mjs";
import { requestReset, serveControl } from "./control.mjs";
import { startWorkbench } from "./workbench.mjs";
import { diagnose, formatReport } from "./doctor.mjs";
import { OpenError, TESTED_PLATFORMS, openWorkbench } from "./open.mjs";
import { drain, follow, printExisting } from "./events.mjs";
import { connectorEventFromWorldEvent, observedKinds, selectWorldEvent } from "./replay.mjs";
import { clockState, startClock } from "./clock.mjs";
import { armTimeline, startScheduler, timelineState } from "./scheduler.mjs";
import {
  ConnectorError,
  checkConnector,
  connectorDocumentation,
  connectorPrompt,
  connectorStatus,
  deliverConnectorEvent,
  discoverConnector,
  planConnector,
  resetConnector,
  seedConnector,
  connectorWorld,
  assertWorldMatchesInstance,
} from "./connector.mjs";
import { SCALE_PRESETS, ScaleError, describeScale, parseLimits, parseScale } from "./scale.mjs";
import { BuildError, buildWorldSource, inspectSource, validateWorldSource } from "./build.mjs";
import { writeConnectorEnvironment } from "./connector-env.mjs";
import { connectorTarget, ensureProject, readProjectToken } from "./project.mjs";
import {
  ensureHostImage,
  hostAddresses,
  HostLauncherError,
  hostBindings,
  hostInstance,
  inspectHostInstance,
  launchHostInstance,
  removeHostRecord,
  resetHostInstance,
  runInHostInstance,
  stopHostInstance,
  streamInHostInstance,
} from "./host-launcher.mjs";

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
  worldfixture up --world-path <dir>   Start a world artifact you built yourself
  worldfixture new <dir>         Copy the starter world, ready to edit
  worldfixture build <source>    Compile a world source into an artifact
  worldfixture validate <source> Check a world source without building it
  worldfixture open              Open this instance's Workbench in a browser
  worldfixture status            Show what a running instance is serving
  worldfixture env               Print application bindings for a shell
  worldfixture doctor            Check Docker, the image, files, ports and readiness
  worldfixture reset             Restore the running world to its exact start
  worldfixture down              Stop and remove the local instance
  worldfixture people            List people and their provider identities
  worldfixture slack send --as <person> --channel <name> <text>
  worldfixture slack history --channel <name> [--as <person>]
  worldfixture mail inbox --as <person> [--folder INBOX]
  worldfixture events [--follow]   Show, or follow, the facts the runtime observed
  worldfixture connector docs      Print the installed Connector v1 documentation
  worldfixture connector prompt <application-url>
  worldfixture connector check <application-url>
  worldfixture connector plan <application-url> [--scale <name>]
  worldfixture connector seed <application-url> [--scale <name>] [--limit <list>]
  worldfixture connector event <application-url> --file <event.json>
  worldfixture connector status <application-url>
  worldfixture connector reset <application-url>
  worldfixture run -- <command>   Start an application with this run's bindings

Options
  --world-path <dir>   A built world artifact (default dist/business.saas-company.v3)
  --output <dir>       Where build writes the artifact (default dist/<id>.<version>)
  --state <dir>        Where instance state is written (default .worldfixture/runs/local)
  --verbose            Show ports, digests and every readiness check
  --image <name>       One-container image (default worldfixture:local)
  --app-dir <dir>      Put the connector token in the app's ignored .env.local
  --app-env <name>     Local env file inside --app-dir (default .env.local)
  --project-dir <dir>  Project directory (default current directory)
  --application-url <url>  Local application origin (default http://localhost:3000)
  --direct             Run checkout services in the foreground (development)
  --follow             Keep printing events as they are observed (events only)
  --only <parts>       Start only these parts of the world (slack, github, site,
                       mail, s3, providers). The default starts all of them.
  --no-rebase          Start the world at its authored anchor instead of today
  --scale <name>       How much of the world to send to an application:
                       smoke (at most 25 of anything), sample (at most 250),
                       or full. The default is full.
  --limit <list>       Per-collection counts, as people=25,mail=200. A nested
                       list such as messages is counted per parent. Overrides
                       --scale for the collections it names.
`;

// ---- output --------------------------------------------------------------

const pad = (label, width = 12) => label.padEnd(width);

// Nothing this command prints carries the local secret.
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
// chokepoint that every line passes through is cheaper than remembering.
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

function parse(argv) {
  const flags = {};
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      positional.push(argument);
      continue;
    }
    const name = argument.slice(2);
    if (["verbose", "choose", "direct", "json", "follow", "no-rebase", "list", "print", "help"].includes(name)) flags[name] = true;
    else flags[name] = argv[++index];
  }

  return { flags, positional };
}

function paths(flags) {
  const projectDir = resolve(flags["project-dir"] ?? flags["app-dir"] ?? process.cwd());
  const stateDir = flags.state ? resolve(flags.state) : resolve(projectDir, ".worldfixture/runs/local");
  const builtPath = flags["world-path"]
    ? resolve(flags["world-path"])
    : resolve(PACKAGE_ROOT, "dist/business.saas-company.v3");
  // `up` rebases the world onto today and writes the result into the run's own
  // state directory. Every other command has to read that same world, or it
  // reports dates the running instance does not have.
  //
  // AN EXPLICIT `--world-path` WINS. It used to lose: the session world was
  // preferred unconditionally, so a command that named a world read a different
  // one whenever an instance happened to be running in that directory, and said
  // nothing about it. `worldfixture people --world-path <v2>` printed the 99
  // people of the running v3 world, and the CLI could report one artifact while
  // operating on another. Naming a world has to mean it.
  const sessionPath = join(stateDir, "world");
  const useSession = !flags["world-path"] && existsSync(join(sessionPath, "world.json"));
  return {
    artifactPath: useSession ? sessionPath : builtPath,
    builtPath,
    stateDir,
    serviceRoot: flags["service-root"] ? resolve(flags["service-root"]) : resolve(PACKAGE_ROOT, "emulators"),
  };
}

// ---- application connector ----------------------------------------------

// The environment lock of the instance that is actually running, or null when
// none is. Read rather than assumed, so a stale or missing lock disables the
// check instead of blocking a command that would have worked.
function runningLock(stateDir) {
  try {
    return JSON.parse(readFileSync(join(stateDir, "environment.lock.json"), "utf8"));
  } catch {
    return null;
  }
}

const CONNECTOR_USAGE = `An application connector fills your own application with this world.

  worldfixture connector docs                    The installed Connector v1 documentation
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
  if (action === "docs") return say(connectorDocumentation().trimEnd());

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
  if (action === "prompt") return say(connectorPrompt(baseUrl));

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
    const db = openState(`${stateDir}/state.sqlite`);
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
  const { artifactPath, stateDir } = paths(parsed.flags);
  await ensureRecordedInstance(stateDir);
  const found = instanceAt(stateDir);
  if (!found) {
    say(`No instance is running. Run \`${invocation()} up\` first.`);
    process.exitCode = 1;
    return;
  }

  const { resolved } = resolveBindings(found.lock, {
    addressOf: addressReader(found.lock, found.bindings, stateDir),
    artifactPath,
  });
  const environment = Object.fromEntries(Object.entries(resolved).map(([name, entry]) => [name, entry.value]));
  if (!found.bindings.WORLDFIXTURE_TOKEN) {
    say("This instance has no application connector token. Restart it with the current WorldFixture build.");
    process.exitCode = 1;
    return;
  }
  environment.WORLDFIXTURE_TOKEN = found.bindings.WORLDFIXTURE_TOKEN;
  environment.WORLDFIXTURE_WORLD_ID = found.lock.world.id;
  environment.WORLDFIXTURE_WORLD_VERSION = found.lock.world.version;

  const child = spawn(command[0], command.slice(1), { stdio: "inherit", env: { ...process.env, ...environment } });
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  if (result.signal) process.kill(process.pid, result.signal);
  if (result.code) process.exitCode = result.code;
}

// ---- up ------------------------------------------------------------------

// Rebase the world onto this session's own time.
//
// A world is authored at a fixed anchor -- the current default world was written
// at 2026-08-28 -- and every date in it is relative to that. Started as built, it
// is frozen there and drifts further from the person looking at it every day.
// `clock.rebase.relative_paths` and `build_rebased_world` exist precisely so the
// anchor can follow the session, and until now nothing on the running path
// called them.
//
// It matters for more than tidiness. A message somebody sends is stamped by the
// provider with the real clock, so in a world frozen a year away it sorts below
// every seeded message and disappears from the view. That reads as "the UI does
// not refresh" when the refresh is working perfectly.
//
// Rebasing needs the world SOURCE and the compiler, which the image has and an
// npm install does not. When they are absent this returns the artifact it was
// given and says so, rather than failing to start.
export function rebaseForSession(artifactPath, stateDir, { quiet = false } = {}) {
  const name = basename(artifactPath);
  const source = resolve(PACKAGE_ROOT, "worlds", name, "world.json");
  if (!existsSync(source)) return { artifactPath, rebased: false, reason: "this install ships no world source" };

  const output = join(stateDir, "world");
  const script =
    "from datetime import datetime, timezone; from pathlib import Path; " +
    "from worldfixture_compiler.compiler import build_rebased_world; " +
    `build_rebased_world(Path(${JSON.stringify(source)}), datetime.now(timezone.utc), Path(${JSON.stringify(output)}))`;

  try {
    rmSync(output, { recursive: true, force: true });
    execFileSync("python3", ["-c", script], {
      cwd: PACKAGE_ROOT,
      env: { ...process.env, PYTHONPATH: resolve(PACKAGE_ROOT, "compiler") },
      stdio: "pipe",
      timeout: 120_000,
    });
  } catch (error) {
    // A world that cannot be rebased still starts, at its authored anchor. It is
    // a worse experience, not a broken one, and refusing to start over it would
    // be the wrong trade.
    const detail = String(error.stderr ?? error.message).trim().split("\n").pop();
    if (!quiet) say(`  the world could not be rebased onto today, so it starts at its authored anchor: ${detail}`);
    return { artifactPath, rebased: false, reason: detail };
  }
  return { artifactPath: output, rebased: true };
}

async function directUp({ flags, positional }, { applicationEnvironment, project } = {}) {
  const { builtPath, stateDir, serviceRoot } = paths(flags);
  mkdirSync(stateDir, { recursive: true });
  const session = flags["no-rebase"]
    ? { artifactPath: builtPath, rebased: false }
    : rebaseForSession(builtPath, stateDir);
  const artifactPath = session.artifactPath;
  const world = readWorld(artifactPath);
  const inOneContainer = process.env.WORLDFIXTURE_SINGLE_CONTAINER === "1";
  // `--only slack,github` starts the parts of the world a run actually needs.
  // The default is every part, which is the zero-configuration first run.
  const only = flags.only ? String(flags.only).split(",").map((name) => name.trim()).filter(Boolean) : undefined;
  const spec = defaultEnvironment(positional[0] ?? `${world.id}:${world.version}`, {
    includeS3: inOneContainer || project?.config.services.includes("s3"),
    includeProviders: inOneContainer,
    includePostgres: project?.config.services.includes("postgres"),
    includeMySQL: project?.config.services.includes("mysql"),
    only,
    // Whose mail and Slack credentials this run binds. Read from the world that
    // is about to start, so a world other than the default one -- a shipped one
    // or one somebody compiled with `worldfixture build` -- binds its own
    // primary person instead of a person it does not contain.
    identity: world.people?.find((person) => person.primary)?.id,
  });

  const lock = resolveEnvironment(spec, { manifests: loadManifests(serviceRoot), artifactPath });

  // The lock and the environment are written before anything starts, so a run
  // that fails still leaves the thing that explains what it tried to do.
  mkdirSync(stateDir, { recursive: true });
  if (project) {
    const target = connectorTarget(project.config, { inContainer: inOneContainer });
    writeFileSync(join(stateDir, "application-connector.json"), `${JSON.stringify(target, null, 2)}\n`, { mode: 0o600 });
  }
  writeFileSync(`${stateDir}/environment.json`, `${JSON.stringify(spec, null, 2)}\n`);
  writeFileSync(`${stateDir}/environment.lock.json`, serializeLock(lock));

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
    writeFileSync(
      `${stateDir}/workbench.json`,
      `${JSON.stringify({ url: workbench.url, state: "loading" }, null, 2)}\n`,
    );
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

  writeFileSync(
    `${stateDir}/workbench.json`,
    `${JSON.stringify({ url: workbench.url, state: "ready" }, null, 2)}\n`,
  );
  const application = resolveBindings(lock, {
    addressOf: (service, port) => instance.addressOf(service, port),
    artifactPath,
  });
  if (application.unresolved.length > 0) {
    await workbench.close();
    await instance.stop();
    throw new StartupError(
      "binding_unresolved",
      application.unresolved.map((entry) => `${entry.name}: ${entry.reason}`).join("; "),
    );
  }
  instance.applicationBindings = Object.fromEntries(
    Object.entries(application.resolved).map(([name, entry]) => [name, entry.value]),
  );
  instance.applicationBindings.WORKBENCH_URL = workbench.url;
  // The target application uses the same local secret for its connector. `up`
  // can create it or reuse the value in the application's ignored env file.
  instance.applicationBindings.WORLDFIXTURE_TOKEN = instance.runtimeToken;

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
  writeFileSync(bindingsPath, `${JSON.stringify(instance.applicationBindings, null, 2)}\n`, { mode: 0o600 });
  chmodSync(bindingsPath, 0o600);
  writeFileSync(`${stateDir}/addresses.json`, `${JSON.stringify(instance.addresses(), null, 2)}\n`);

  // Armed BEFORE the screen invites the user to press Ctrl-C. Registering it
  // afterwards leaves a window in which SIGINT takes Node's default path and
  // kills the supervisor without stopping its children -- which is precisely
  // the orphan this runtime promises never to leave. Found by a test that
  // interrupted as soon as the screen appeared.
  // The clock starts HERE, after readiness, and not when the process began.
  // Startup takes tens of seconds on a cold machine, and a timeline counted from
  // process start would spend its opening minute before anything was listening.
  const scheduler = armInstanceTimeline(instance, world, {
    bindings: instance.applicationBindings,
    stateDir,
    verbose: flags.verbose,
  });

  let control;
  try {
    control = await serveControl(instance, stateDir);
  } catch (error) {
    await scheduler.stop();
    await workbench.close();
    await instance.stop();
    rmSync(bindingsPath, { force: true });
    rmSync(`${stateDir}/addresses.json`, { force: true });
    throw error;
  }
  const finished = runUntilInterrupted(instance, bindingsPath, control, workbench, scheduler);

  printReady(instance, world, { verbose: flags.verbose, stateDir });
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
  // `worldfixture up ./dist/demo.my-world.v1` is what somebody types straight
  // after `worldfixture build`, and the positional argument otherwise names an
  // environment rather than a path. A directory holding a world.json is not
  // ambiguous, so it is read as `--world-path` and dropped from the positional
  // list, where `directUp` would have passed it on as an environment name.
  const positionalWorld = parsed.positional[0]
    && existsSync(join(resolve(parsed.positional[0]), "world.json"))
    ? parsed.positional[0]
    : null;
  if (positionalWorld) {
    parsed = {
      flags: { ...parsed.flags, "world-path": positionalWorld },
      positional: parsed.positional.slice(1),
    };
  }

  const inOneContainer = process.env.WORLDFIXTURE_SINGLE_CONTAINER === "1";
  const projectDir = parsed.flags["project-dir"] ?? parsed.flags["app-dir"] ?? process.cwd();
  const project = inOneContainer
    ? {
      config: JSON.parse(process.env.WORLDFIXTURE_PROJECT_CONFIG ?? '{"api_version":"worldfixture.project/v1","application_url":"http://localhost:3000","services":[]}'),
      token: process.env.WORLDFIXTURE_TOKEN,
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
  const direct = parsed.flags.direct || inOneContainer;
  if (direct) return await directUp(parsed, { applicationEnvironment, project });

  const { builtPath, stateDir } = paths(parsed.flags);
  mkdirSync(stateDir, { recursive: true });

  // The world inside the container has to be told which parts to start, and
  // where its world is. `--world-path` names a directory on the host, which the
  // container cannot see, so the artifact is staged into the one directory it
  // can and the container is pointed at that copy.
  const containerArgs = parsed.flags.only ? ["--only", String(parsed.flags.only)] : [];
  if (parsed.flags["world-path"]) containerArgs.push("--world-path", stageWorldArtifact(builtPath, stateDir));

  const started = Date.now();
  const progress = startupProgress({ stateDir, startedAt: started });
  const result = await launchHostInstance({
    stateDir,
    image: parsed.flags.image ?? process.env.WORLDFIXTURE_IMAGE ?? defaultImage(),
    connectorToken: project.token,
    projectConfig: project.config,
    containerArgs,
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
  writeFileSync(join(stateDir, "application-connector.json"), `${JSON.stringify(target, null, 2)}\n`, { mode: 0o600 });
  // Resolved again, and deliberately: the container rebases the world onto today
  // and writes it into the bind-mounted state directory, so the world this
  // screen describes only exists once the instance is up. Reading the path taken
  // before the launch would print the anchor the image was built at, and the
  // screen would be describing a world the instance is not serving.
  const world = readWorld(paths(parsed.flags).artifactPath);
  printReadyBindings(world, result.bindings, stateDir);
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
function armInstanceTimeline(instance, world, { bindings, stateDir, verbose }) {
  const arm = () => {
    // The world's own time origin, which the compiler rebases every relative
    // date against. It is what "now" means inside this world.
    startClock(instance.state, { anchor: world.clock?.anchor ?? "" });
    return armTimeline(instance.state, world);
  };

  const armed = arm();
  instance.rearmTimeline = arm;

  const scheduler = startScheduler(instance.state, {
    world,
    bindings,
    rules: instance.lock.rules ?? [],
    now: () => Date.now(),
    applicationConnector: () => {
      try {
        const target = JSON.parse(readFileSync(join(stateDir, "application-connector.json"), "utf8"));
        return { baseUrl: target.transport_url, token: instance.runtimeToken };
      } catch {
        return null;
      }
    },
  }, {
    onPlayed: (played) => {
      if (!verbose) return;
      for (const entry of played) {
        say(`  timeline ${entry.arrival} (${entry.kind}) ${entry.status}${entry.reason ? `: ${entry.reason}` : ""}`);
      }
    },
    onError: (error) => say(`  timeline tick failed: ${error.message}`),
  });

  instance.scheduler = scheduler;
  return { ...scheduler, armed };
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
  say(`${pad("People")}${held.people} at ${organization.name}`);
  say(
    `${pad("Content")}${held.channels} channels, ${held.slack_messages} Slack messages, ` +
      `${held.mail_messages} emails, ${held.repositories} repositories`,
  );
  // Measured, not asserted. This world's Slack history is a spine, not a month.
  say(`${pad("History")}Slack ${days(held.history.slack_days)}, mail ${days(held.history.mail_days)}`);
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
    const isCredential = name.endsWith("_TOKEN") || name.endsWith("_USERNAME") || name.endsWith("_PASSWORD");
    return typeof value === "string" && !isCredential;
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
    say(`  ${pad("Slack", 10)}${person.slack_id}`);
    say(`  ${pad("Email", 10)}${person.email}`);
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
  "http-targets": "the public site",
  mail: "mail",
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
        const left = list(waiting.map(serviceName)).replace("mail", `mail${messages}`);
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
      await scheduler?.stop();
      await workbench.close();
      await control.close();
      const stopped = await instance.stop();
      rmSync(bindingsPath, { force: true });
      rmSync(bindingsPath.replace("bindings.json", "addresses.json"), { force: true });
      rmSync(bindingsPath.replace("bindings.json", "workbench.json"), { force: true });
      for (const record of stopped) {
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
    say("No partly reset world is running; all application services were stopped.");
    process.exitCode = 1;
  }
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
    return JSON.parse(readFileSync(`${stateDir}/bindings.json`, "utf8"));
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
  const { artifactPath, stateDir } = paths(flags);
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

  const token = tokenFor(person);

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
    const lock = JSON.parse(readFileSync(`${stateDir}/environment.lock.json`, "utf8"));
    const db = openState(`${stateDir}/state.sqlite`);

    try {
      const result = await submit(
        db,
        { baseUrl: base, token, person, channel, text: rest.join(" ") },
        { world, rules: lock.rules ?? [], bindings },
      );

      say(`Sent as ${result.identity.user} to #${channel.name} at ${result.event.provider_evidence.message_ts}`);

      for (const effect of result.effects) {
        if (effect.skipped) {
          say(`  ${effect.emission.rule}: ${effect.skipped}`);
          continue;
        }
        for (const person of effect.delivered) {
          say(`  ${effect.emission.rule} → mail to ${person.email}`);
        }
      }
    } finally {
      db.close();
    }
    return;
  }

  if (subcommand === "history") {
    const channel = findChannel(world, flags.channel ?? "");
    const messages = await history(base, token, channel?.name ?? flags.channel);
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
    return { bindings, lock: JSON.parse(readFileSync(`${stateDir}/environment.lock.json`, "utf8")) };
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
      ? JSON.parse(readFileSync(`${stateDir}/addresses.json`, "utf8"))
      : hostAddresses(stateDir) ?? JSON.parse(readFileSync(`${stateDir}/addresses.json`, "utf8"));
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
  const { artifactPath, stateDir } = paths(flags);
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
  const world = readWorld(artifactPath);

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

async function env({ flags }) {
  const { artifactPath, stateDir } = paths(flags);
  await ensureRecordedInstance(stateDir);
  const found = instanceAt(stateDir);

  if (!found) {
    say(`No instance is running. Run \`${invocation()} up\` first.`);
    process.exitCode = 1;
    return;
  }

  const { bindings, lock } = found;
  const { resolved, unresolved } = resolveBindings(lock, {
    addressOf: addressReader(lock, bindings, stateDir),
    artifactPath,
  });
  if (flags.json) {
    say(JSON.stringify(Object.fromEntries(Object.entries(resolved).map(([name, entry]) => [name, entry.value]))));
    return;
  }

  for (const name of Object.keys(resolved).sort()) {
    say(`export ${name}=${shellQuote(resolved[name].value)}`);
  }

  // A credential that fell back to a workspace-wide token no longer says who is
  // acting, so the fallback is announced rather than passed off as the person's.
  for (const [name, entry] of Object.entries(resolved)) {
    if (entry.scope === "shared") say(`# ${name} is a shared token, not ${lock.target?.identity ?? "one person"}'s`);
  }
  for (const entry of unresolved) say(`# ${entry.name} could not be resolved: ${entry.reason}`);
}

async function mail({ flags, positional }) {
  const { artifactPath, stateDir } = paths(flags);
  const world = readWorld(artifactPath);
  const bindings = readBindings(stateDir);

  if (!bindings?.IMAP_HOST_PORT) {
    say(`No instance with mail is running. Start one with \`${invocation()} up\`.`);
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
    password: derivePassword(account.password_ref),
    mailbox: flags.folder ?? "INBOX",
    limit: Number(flags.limit ?? 10),
  });

  say(`${person.name} — ${result.mailbox}, ${result.exists} messages`);
  say();
  for (const message of result.messages) {
    say(`  ${(message.headers.from ?? "?").slice(0, 44).padEnd(46)}${message.headers.subject ?? ""}`);
    if (message.headers.date) say(`  ${" ".repeat(46)}${message.headers.date}`);
  }
}

// The projection carries `password_ref` and never a secret. With no environment
// table to resolve it against, the service derives the password from the
// reference itself, and a client has to derive it the same way. Kept beside the
// only caller and mirroring `world-mail.pl`'s `password_resolver`, prefix strip
// and character class exactly; a first run needs no setup, and this is a local
// fixture convention for a synthetic world, not a secret store.
function derivePassword(reference) {
  return reference.replace(/^mail-password:/, "").replace(/[^A-Za-z0-9._-]/g, "-");
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

  const db = openState(`${stateDir}/state.sqlite`);
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

The compiler runs inside the WorldFixture image, so building a world needs
Docker and nothing else -- no Python, and no checkout of this repository.`;

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

// A world artifact on the host is not visible to the container.
//
// The container sees exactly one host directory: the state directory, bound at
// /state. So an artifact named by `--world-path` is copied there and the
// container is told to start `/state/world`, which is also where the recorded
// world for this run belongs -- `paths()` already reads that location, so
// `status`, `people` and `slack` on the host describe the world the instance is
// actually serving rather than the default one.
//
// The world starts at its authored anchor rather than today. Rebasing needs the
// world SOURCE and this stages an artifact, so there is nothing to rebase from;
// `rebaseForSession` sees no matching source in the image and returns the
// artifact unchanged.
function stageWorldArtifact(builtPath, stateDir) {
  if (!existsSync(join(builtPath, "world.json")) || !existsSync(join(builtPath, "manifest.json"))) {
    throw new BuildError(
      "not_a_world_artifact",
      `${builtPath} is not a built world artifact: it has no world.json and manifest.json`,
      `Compile the source first: \`worldfixture build <source> --output ${builtPath}\`.`,
    );
  }

  const staged = join(stateDir, "world");
  if (resolve(builtPath) === staged) return "/state/world";
  rmSync(staged, { recursive: true, force: true });
  cpSync(builtPath, staged, { recursive: true });
  return "/state/world";
}

// ---- dispatch ------------------------------------------------------------

export async function main(argv) {
  const [command, ...rest] = argv;
  if (command === "run") return runApplication(rest);
  const parsed = parse(rest);

  try {
    // Commands that read or change runtime-owned state execute in the recorded
    // container. SQLite locking across a Docker Desktop bind mount is not a
    // safe control contract, and reset must clear the same runtime state
    // connection that recorded the action.
    if (
      process.env.WORLDFIXTURE_SINGLE_CONTAINER !== "1" &&
      ["slack", "mail", "events"].includes(command)
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
        return;
      }
    }
    switch (command) {
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
