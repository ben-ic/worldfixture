// `worldfixture up`, driven the way a person drives it.
//
// The release gate this file guards is that a new user can start the default
// world and complete the suggested Slack action without reading any
// architecture documentation. Nothing short of driving it end to end proves
// that, so the test runs the real binary, reads the real first screen, runs the
// command that screen printed, and checks the message arrived by asking the
// Slack Web API for it.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const BIN = join(ROOT, "runtime/bin/worldfixture.mjs");

const scratch = [];
after(() => scratch.forEach((path) => rmSync(path, { recursive: true, force: true })));

function stateDir() {
  const path = mkdtempSync(join(tmpdir(), "worldfixture-cli-"));
  scratch.push(path);
  return path;
}

// A command that refuses is a normal outcome with a non-zero exit, and its
// message is the thing under test, so the output is returned either way.
async function cli(args, options = {}) {
  // Every command that reads the world reads the same world these tests start.
  // Without this a `slack send` would resolve its channel against the default
  // world while the running instance served another one.
  const withWorld = args.includes("--world-path") ? args : [...args, "--world-path", TEST_WORLD];
  try {
    return await run(process.execPath, [BIN, ...withWorld], { cwd: ROOT, ...options });
  } catch (error) {
    if (error.stdout === undefined) throw error;
    return { stdout: error.stdout, stderr: error.stderr, code: error.code };
  }
}

// Every `up` this file starts, so a failing test cannot leave a world running.
//
// An earlier version abandoned its child when readiness timed out, and a run
// under load left twelve orphaned services reparented to init. A harness for a
// runtime that promises to leave nothing behind must leave nothing behind.
const running = new Set();

after(async () => {
  await Promise.all([...running].map((instance) => instance.stop().catch(() => {})));
});

// The world these tests start.
//
// NOT THE DEFAULT WORLD, deliberately. This file tests what the CLI prints and
// does; it does not test how fast Cyrus can seed. `--direct` runs mail as a
// service container, and the published mail image is `linux/amd64`, so on an
// arm64 machine it runs under Rosetta. Measured: the default world's 3,069
// seeded messages exceed a 300-second startup budget by that route, while the
// native one-container image loads the same world in 86-88 seconds. Every test
// in this file timed out, and the large world was never what any of them was
// about.
//
// `tests/image/protocol-test.mjs` covers the default world on the real image.
const TEST_WORLD = join(ROOT, "dist/business.saas-company.v2");

// Start `up`, wait for the screen it prints, hand back a stop function.
// The default environment now includes mail, whose image is built on first use.
async function up(state, { args = [], timeoutMs = 300_000 } = {}) {
  const child = spawn(process.execPath, [BIN, "up", "--direct", "--state", state, "--world-path", TEST_WORLD, ...args], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";

  const instance = {
    output: () => output,
    stop: async () => {
      running.delete(instance);
      if (child.exitCode !== null) return output;
      child.kill("SIGINT");
      await new Promise((resolve) => child.on("exit", resolve));
      return output;
    },
  };
  running.add(instance);

  try {
    await new Promise((resolve, reject) => {
      child.stdout.on("data", (chunk) => {
        output += chunk.toString("utf8");
        if (output.includes("Stop with Ctrl-C")) resolve();
      });
      child.stderr.on("data", (chunk) => (output += chunk.toString("utf8")));
      child.on("exit", (code) => reject(new Error(`up exited ${code}:\n${output}`)));
      setTimeout(() => reject(new Error(`up never became ready:\n${output}`)), timeoutMs).unref();
    });
  } catch (error) {
    await instance.stop();
    throw error;
  }

  return instance;
}

test("up prints what the user received, and no internal orchestration", async () => {
  const state = stateDir();
  const app = stateDir();
  const instance = await up(state, { args: ["--app-dir", app] });
  const screen = instance.output();

  assert.match(screen, /WorldFixture is ready/);
  assert.match(screen, /World\s+business\.saas-company:v2/);
  assert.match(screen, /People\s+10 at Northstar Relay/);
  assert.match(screen, /Slack\s+http:\/\/127\.0\.0\.1:\d+/);
  assert.match(screen, /Maya Chen/);

  // Detail belongs behind --verbose. A first screen carrying digests, every
  // port and every readiness line is not showing what the user received.
  assert.ok(!screen.includes("sha256"), "no digests on the first screen");
  assert.ok(!/protocol checks passed/.test(screen), "no readiness detail on the first screen");
  assert.ok(!/\(private\)/.test(screen), "no private back channels on the first screen");
  const runCredentials = JSON.parse(readFileSync(join(state, "credentials.json"), "utf8"));
  assert.ok(!Object.values(runCredentials.values).some(value => screen.includes(value)), "credentials stay in env and the workbench");
  assert.ok(!/Imap_(?:password|username)/.test(screen), "mail credentials stay in env and the workbench");
  assert.match(screen, new RegExp(`Application environment: ${app.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\.env\\.local`));
  const token = readFileSync(join(app, ".env.local"), "utf8").match(/^WORLDFIXTURE_TOKEN=(.+)$/m)?.[1];
  const bindings = JSON.parse(readFileSync(join(state, "bindings.json"), "utf8"));
  assert.equal(token, bindings.WORLDFIXTURE_TOKEN, "the application and runtime received different connector tokens");
  assert.match(readFileSync(join(app, ".gitignore"), "utf8"), /^\/\.env\.local$/m);
  assert.ok(!/Smtp_(?:password|username)/.test(screen), "mail credentials stay in env and the workbench");
  await instance.stop();
});

test("the history it prints is measured, not the documented 30 days", async () => {
  // This world carries eight Slack messages across a day and a year of mail.
  // "History 30 days" would be wrong about both.
  //
  // The mail figure is a wide range rather than a number because `up` rebases
  // the world onto the day it is started, and the ledger it generates is
  // quantised to calendar months while the hand-written mail is not. The span
  // therefore moves with the day of the month this is run on -- by up to a month
  // in either direction -- and a narrow window here is a test that passes in
  // September and fails in October for nobody's reason. It has already done
  // that: the window was 370 to 420 and the world measured 366.
  //
  // What the test is for is that the figure was MEASURED from this world rather
  // than asserted from the design document, and "about a year, not thirty days"
  // is the whole of that claim.
  const state = stateDir();
  const instance = await up(state);
  const screen = instance.output();
  await instance.stop();

  const mailDays = Number(screen.match(/History\s+Slack 1 day, Local Mail (\d+) days/)?.[1]);
  assert.ok(mailDays > 300 && mailDays < 500, `mail history reads ${mailDays} days, and this world holds about a year`);
  assert.match(screen, /8 Slack messages/);
});

test("the world it starts is anchored on the day it is started, not the day it was authored", async () => {
  // The bug this closes: a world frozen at its authored anchor stamps its whole
  // history a year away from the real clock, while a message the user sends is
  // stamped now. The sent message then sorts outside every view that shows the
  // history, and the provider looks like it stopped refreshing.
  const state = stateDir();
  const instance = await up(state);
  const screen = instance.output();
  await instance.stop();

  const [, worldDay, realDay] = screen.match(/Now\s+(\d{4}-\d{2}-\d{2}) in this world, (\d{4}-\d{2}-\d{2}) outside it/) ?? [];
  assert.ok(worldDay, `the first screen does not say when this world is:\n${screen}`);
  assert.equal(realDay, new Date().toISOString().slice(0, 10));
  const apart = (Date.parse(`${realDay}T00:00:00Z`) - Date.parse(`${worldDay}T00:00:00Z`)) / 86_400_000;
  assert.ok(apart >= 0 && apart < 14, `the world sits ${apart} days from today, so it was not rebased onto this session`);
});

test("verbose carries the ports, the checks and the closed conflicts", async () => {
  const state = stateDir();
  const instance = await up(state, { args: ["--verbose"] });
  const output = await instance.stop();

  assert.match(output, /protocol checks passed/);
  assert.match(output, /body names "not_authed"/);
  assert.match(output, /projections\/emulator-overlay\.json/);
  assert.match(output, /verified by emulate/);
});

test("the suggested action works, and the message is really there", async () => {
  const state = stateDir();
  const instance = await up(state);

  try {
    // Exactly the command the screen printed. The prefix depends on how this
    // CLI was invoked -- `npx worldfixture`, `worldfixture`, or the file itself
    // from a checkout -- so the assertion is on the action, not the shape.
    const suggested = instance.output().match(/worldfixture(?:\.mjs)? (slack send [^\n]+)/);
    assert.ok(suggested, "the first screen suggests a Slack action");

    const { stdout } = await cli(["slack", "send", "--as", "maya", "--channel", "release-2-8",
      "--state", state, "Mobile tests passed"]);
    assert.match(stdout, /Sent as mayac to #release-2-8/);

    // Read it back through the API, as a different person, which is the half
    // that proves it reached the service rather than a local buffer.
    const read = await cli(["slack", "history", "--channel", "release-2-8", "--as", "jon", "--state", state]);
    assert.match(read.stdout, /Mobile tests passed/);
  } finally {
    await instance.stop();
  }
});

test("reset restores the running world through the supervisor control socket", async () => {
  const state = stateDir();
  const instance = await up(state);

  try {
    await cli([
      "slack", "send", "--as", "maya", "--channel", "release-2-8",
      "--state", state, "CLI reset removes this",
    ]);
    const changed = await cli([
      "slack", "history", "--channel", "release-2-8", "--as", "jon", "--state", state,
    ]);
    assert.match(changed.stdout, /CLI reset removes this/);

    const result = await cli(["reset", "--state", state], { timeout: 180_000 });
    assert.match(result.stdout, /World restored exactly across 3 services/);

    const restored = await cli([
      "slack", "history", "--channel", "release-2-8", "--as", "jon", "--state", state,
    ]);
    assert.doesNotMatch(restored.stdout, /CLI reset removes this/);
    const events = await cli(["events", "--state", state]);
    assert.match(events.stdout, /No events yet/);
  } finally {
    await instance.stop();
  }
});

test("stopping removes the bindings file so nothing points at a dead world", async () => {
  const state = stateDir();
  const instance = await up(state);
  assert.ok(existsSync(join(state, "bindings.json")));
  assert.ok(existsSync(join(state, "addresses.json")));

  await instance.stop();
  assert.ok(!existsSync(join(state, "bindings.json")));
  assert.ok(!existsSync(join(state, "addresses.json")));

  // The lock stays: it is what explains what the run tried to do.
  assert.ok(existsSync(join(state, "environment.lock.json")));
  assert.ok(existsSync(join(state, "environment.json")));
});

test("a service command with no instance says so instead of starting one", async () => {
  const state = stateDir();
  const { stdout } = await cli(["slack", "send", "--as", "maya", "--channel", "general", "--state", state, "hi"]);
  assert.match(stdout, /No instance is running/);
});

test("a person who is not in the workspace is explained, not 401'd", async () => {
  // Priya is at Lumen Labs. She has mail in this world and no Slack token, which
  // is the right fidelity: a customer is not a member of the supplier's Slack.
  const state = stateDir();
  const instance = await up(state);

  try {
    const { stdout } = await cli(["slack", "history", "--channel", "general", "--as", "priya", "--state", state]);
    assert.match(stdout, /Priya Raman has no Slack identity/);
    assert.match(stdout, /Lumen Labs/);
    assert.match(stdout, /^ {2}maya\s+Maya Chen$/m);
  } finally {
    await instance.stop();
  }
});

test("people lists the world's own people and their provider identities", async () => {
  const { stdout } = await cli(["people"]);
  assert.match(stdout, /Maya Chen {2}\(maya-chen\)/);
  assert.match(stdout, /Slack {5}U000000001/);
  assert.match(stdout, /GitHub {4}mayac/);
  // Ten insiders by default; the six external people are real records and are
  // not who "People" means on a first screen.
  assert.equal(stdout.match(/^\S.*\(\S+\)$/gm).length, 10);
});

test("up writes the environment and the lock before anything starts", async () => {
  const state = stateDir();
  const instance = await up(state);
  await instance.stop();

  const lock = JSON.parse(readFileSync(join(state, "environment.lock.json"), "utf8"));
  assert.equal(lock.api_version, "worldfixture.environment-lock/v1");
  assert.deepEqual(lock.services.map((service) => service.name).sort(), ["emulate", "http-targets", "mail"]);
  // Slack and GitHub are both the composer, so it appears once however many
  // capabilities it provides.
  assert.deepEqual(
    lock.services.find((service) => service.name === "emulate").ports.map((port) => port.name).sort(),
    ["github", "slack"],
  );
});

// ---- the connected flow --------------------------------------------------

test("Maya sends on Slack and a channel member reads the result over IMAP", async () => {
  // The first release proof, end to end and through real protocols at every
  // step: the Slack Web API accepts the message, the runtime records the fact
  // with the provider's own evidence, the causal rule fires on a fact the
  // runtime originated, the notification is delivered over SMTP, and a second
  // person reads it over IMAP.
  const state = stateDir();
  const instance = await up(state);

  try {
    const sent = await cli(["slack", "send", "--as", "maya", "--channel", "release-2-8",
      "--state", state, "Mobile tests passed"]);

    assert.match(sent.stdout, /Sent as mayac to #release-2-8/);
    // Notified from the world's own channel membership, and never the author.
    assert.match(sent.stdout, /rule-slack-channel-notification → Local Mail to jon@/);
    assert.ok(!/mail to maya@/.test(sent.stdout), "the author is not notified of their own message");

    const read = await cli(["mail", "inbox", "--as", "jon", "--state", state]);
    assert.match(read.stdout, /\[#release-2-8\] Maya Chen posted/);

    // And it really is in Slack, read back by a third person through the API.
    const history = await cli(["slack", "history", "--channel", "release-2-8", "--as", "elena", "--state", state]);
    assert.match(history.stdout, /Mobile tests passed/);
  } finally {
    await instance.stop();
  }
});

test("the ledger records the fact and everything it caused", async () => {
  const state = stateDir();
  const instance = await up(state);

  try {
    await cli(["slack", "send", "--as", "maya", "--channel", "general", "--state", state, "Morning"]);
    const { stdout } = await cli(["events", "--state", state]);

    assert.match(stdout, /communication\.message\.sent\.v1/);
    assert.match(stdout, /maya-chen via slack, caused by cmd_/);
    assert.match(stdout, /mail\.notification\.delivered\.v1/);
    // Every delivery names the fact that caused it, which is what makes the
    // ledger a causal record rather than a list.
    const caused = stdout.match(/caused by evt_[0-9a-f]+/g) ?? [];
    assert.ok(caused.length >= 1);
    assert.equal(new Set(caused).size, 1, "every notification is caused by the one message");
  } finally {
    await instance.stop();
  }
});

test("a person reads their own authored mail over IMAP", async () => {
  // Priya is at Lumen Labs and has no Slack token. Her surface is mail, and the
  // world's own messages are there with the world's own dates.
  const state = stateDir();
  const instance = await up(state);

  try {
    const { stdout } = await cli(["mail", "inbox", "--as", "priya", "--limit", "20", "--state", state]);
    assert.match(stdout, /Priya Raman — INBOX, 15 messages/);
    assert.match(stdout, /Export is still timing out/);
    // RFC 2047 encoded words are decoded, as any mail client does; this world's
    // invoice subjects use an em dash and are all encoded on the wire.
    assert.match(stdout, /Invoice \d+ — Lumen Labs/);
    assert.ok(!/=\?UTF-8\?/.test(stdout), "no encoded words reach the reader");
  } finally {
    await instance.stop();
  }
});

test("the checkout development path starts five surfaces from one command", async () => {
  const state = stateDir();
  const instance = await up(state);
  const screen = await instance.stop();

  for (const surface of ["Slack", "GitHub", "Site", "IMAP", "SMTP"]) {
    assert.match(screen, new RegExp(`^${surface}\\s+\\S+`, "m"), surface);
  }
});

test("status probes every running service and reports the world", async () => {
  const state = stateDir();
  const instance = await up(state);

  try {
    const { stdout } = await cli(["status", "--state", state, "--verbose"]);

    assert.match(stdout, /World\s+business\.saas-company:v2/);
    assert.match(stdout, /emulate\s+ready\s+2 capabilities/);
    assert.match(stdout, /http-targets\s+ready\s+1 capability/);
    assert.match(stdout, /mail\s+ready\s+2 capabilities/);
    assert.match(stdout, /ok\s+seed_gate\s+health/);
    assert.match(stdout, /ok\s+protocol\s+smtp/);
    assert.match(stdout, /ok\s+protocol\s+imap/);
    assert.match(stdout, /People\s+10, 8 Slack messages, 74 emails/);
  } finally {
    await instance.stop();
  }
});

test("env prints shell-safe bindings for the running instance", async () => {
  const state = stateDir();
  const instance = await up(state);

  try {
    const { stdout } = await cli(["env", "--state", state]);

    assert.match(stdout, /^export SLACK_BASE_URL='http:\/\/127\.0\.0\.1:\d+'$/m);
    assert.match(stdout, /^export GITHUB_BASE_URL='http:\/\/127\.0\.0\.1:\d+'$/m);
    assert.match(stdout, /^export IMAP_HOST_PORT='127\.0\.0\.1:\d+'$/m);
    assert.match(stdout, /^export IMAP_USERNAME='maya@northstar-relay\.worldfixture\.test'$/m);
    const { stdout: json } = await cli(["env", "--state", state, "--json"]);
    const bindings = JSON.parse(json);
    const slack = await fetch(`${bindings.SLACK_BASE_URL}/api/auth.test`, { method: "POST", headers: { Authorization: `Bearer ${bindings.SLACK_TOKEN}` } }).then(response => response.json());
    assert.equal(slack.ok, true);
    assert.equal(slack.user, "mayac");
    const github = await fetch(`${bindings.GITHUB_BASE_URL}/user`, { headers: { Authorization: `Bearer ${bindings.GITHUB_TOKEN}` } }).then(response => response.json());
    assert.equal(github.login, "mayac");
    assert.notEqual(bindings.IMAP_PASSWORD, "maya-chen");
    const { stdout: secondTerminal } = await cli(["env", "--state", state, "--json"], { cwd: stateDir() });
    assert.deepEqual(JSON.parse(secondTerminal), bindings);
    assert.match(stdout, /^export SMTP_HOST_PORT='127\.0\.0\.1:\d+'$/m);
    assert.match(stdout, /# GITHUB_TOKEN is a shared token, not maya-chen's/);
    assert.ok(!stdout.includes("could not be resolved"));
  } finally {
    await instance.stop();
  }
});
