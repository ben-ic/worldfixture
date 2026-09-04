// `worldfixture events` and `worldfixture events --follow`.
//
// The follower is driven directly where the question is about the ledger, and
// through the real binary where the question is about the process — whether
// Ctrl-C returns the terminal, and whether a follower survives the client that
// started it. The second cannot be answered without a process, and the first
// should not need one.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { drain, follow, printExisting } from "./events.mjs";
import { appendEvent, openState, resetState } from "./state.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const BIN = join(ROOT, "runtime/bin/worldfixture.mjs");

const scratch = [];
after(() => scratch.forEach((path) => rmSync(path, { recursive: true, force: true })));

function stateDir() {
  const path = mkdtempSync(join(tmpdir(), "worldfixture-events-"));
  scratch.push(path);
  return path;
}

let counter = 0;
function record(db, type, actor = "maya-chen") {
  counter += 1;
  return appendEvent(db, {
    id: `event-${counter}`,
    type,
    actor_id: actor,
    source: "slack",
    occurred_at: `2026-01-01T00:00:${String(counter).padStart(2, "0")}Z`,
    provider_evidence: { message_ts: `1700000000.${counter}` },
  });
}

function collector() {
  const chunks = [];
  const write = (text) => chunks.push(text);
  write.text = () => chunks.join("");
  return write;
}

// Poll until a predicate holds, so a test never waits a fixed interval for a
// follower whose poll period is an implementation detail.
async function until(predicate, { timeoutMs = 5_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition never held");
}

test("existing events are printed first, in ledger order", () => {
  const db = openState(":memory:");
  record(db, "slack.message.sent");
  record(db, "mail.delivered");
  record(db, "slack.message.sent");

  const write = collector();
  const result = printExisting(db, { write });

  assert.equal(result.printed, 3);
  assert.equal(result.cursor, 3);
  const seqs = write.text().match(/^\s*\d+ {2}20/gm).map((line) => Number(line.trim().split(" ")[0]));
  assert.deepEqual(seqs, [1, 2, 3], "rows are printed by seq, not by insertion race");
  db.close();
});

test("an empty ledger says so rather than printing nothing", () => {
  const db = openState(":memory:");
  const write = collector();
  assert.equal(printExisting(db, { write }).printed, 0);
  assert.match(write.text(), /No events yet/);
  db.close();
});

test("a batch larger than one page is drained in order", () => {
  const db = openState(":memory:");
  for (let index = 0; index < 7; index += 1) record(db, "slack.message.sent");

  const { rows, cursor } = drain(db, 0, { page: 2 });
  assert.equal(rows.length, 7);
  assert.deepEqual(rows.map((row) => row.seq), [...rows].sort((a, b) => a - b).map((row) => row.seq));
  assert.equal(cursor, rows.at(-1).seq);
  db.close();
});

test("a new event appended after follow started is printed, and only once", async () => {
  const db = openState(":memory:");
  record(db, "slack.message.sent");

  const write = collector();
  const controller = new AbortController();
  const following = follow(db, { write, signal: controller.signal, intervalMs: 20 });

  await until(() => write.text().includes("Following."));
  record(db, "mail.delivered");
  await until(() => write.text().includes("mail.delivered"));

  // A second poll must not reprint it: the cursor only moves forward.
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(write.text().match(/mail\.delivered/g).length, 1);

  controller.abort();
  const result = await following;
  assert.equal(result.followed, 1);
  db.close();
});

test("a reset under a follower rewinds rather than going silent", async () => {
  const db = openState(":memory:");
  record(db, "slack.message.sent");
  record(db, "mail.delivered");

  const write = collector();
  const controller = new AbortController();
  const following = follow(db, { write, signal: controller.signal, intervalMs: 20 });
  await until(() => write.text().includes("Following."));

  // Exact reset clears the ledger and restarts `seq` at 1. A follower holding
  // cursor 2 would otherwise never print another event for the rest of the run.
  resetState(db);
  await until(() => write.text().includes("was reset"));

  record(db, "slack.message.sent");
  await until(() => write.text().split("slack.message.sent").length === 3);

  controller.abort();
  await following;
  db.close();
});

test("a ledger that stops answering ends the follow with the reason", async () => {
  const db = openState(":memory:");
  record(db, "slack.message.sent");

  const write = collector();
  const controller = new AbortController();
  const following = follow(db, { write, signal: controller.signal, intervalMs: 20 });
  await until(() => write.text().includes("Following."));

  // What a container shutdown looks like from inside the follower.
  db.close();

  const result = await following;
  assert.match(write.text(), /The event ledger stopped answering/);
  assert.equal(typeof result.cursor, "number");
  controller.abort();
});

// ---- the process ---------------------------------------------------------

// What a running instance leaves in its state directory. `events` reads this to
// decide whether an instance is live, the same way `slack` and `mail` do.
function markRunning(state) {
  writeFileSync(join(state, "bindings.json"), JSON.stringify({ SLACK_BASE_URL: "http://127.0.0.1:4703" }));
}

function startFollower(state, { env = {}, stdin = "ignore" } = {}) {
  const child = spawn(process.execPath, [BIN, "events", "--follow", "--state", state], {
    cwd: ROOT,
    env: { ...process.env, WORLDFIXTURE_SINGLE_CONTAINER: "1", ...env },
    stdio: [stdin, "pipe", "pipe"],
  });

  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));

  return {
    child,
    output: () => output,
    exited: new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal }))),
  };
}

test("Ctrl-C stops the follower cleanly and returns the terminal", async () => {
  const state = stateDir();
  const db = openState(join(state, "state.sqlite"));
  record(db, "slack.message.sent");
  db.close();
  markRunning(state);

  const follower = startFollower(state);
  await until(() => follower.output().includes("Following."), { timeoutMs: 10_000 });
  assert.match(follower.output(), /slack\.message\.sent/, "existing events are printed before following");

  follower.child.kill("SIGINT");
  const { code, signal } = await follower.exited;

  // Exit 0 and no signal: the handler ran, rather than Node taking its default
  // SIGINT path. A non-zero exit here would make `worldfixture events --follow`
  // fail every shell script that ends with Ctrl-C.
  assert.equal(signal, null, `the follower died from ${signal} instead of stopping`);
  assert.equal(code, 0);
  assert.match(follower.output(), /Stopped following\./);
});

test("stdin EOF stops a follower whose client has gone away, and only when opted in", async () => {
  const state = stateDir();
  const db = openState(join(state, "state.sqlite"));
  record(db, "slack.message.sent");
  db.close();
  markRunning(state);

  // This is the rule that keeps a `docker exec` follower from outliving the
  // terminal that started it: `docker exec` forwards no signals, so the host
  // closes stdin and the container-side process treats that as the stop.
  const opted = startFollower(state, { env: { WORLDFIXTURE_STOP_ON_STDIN_EOF: "1" }, stdin: "pipe" });
  await until(() => opted.output().includes("Following."), { timeoutMs: 10_000 });
  opted.child.stdin.end();
  const stopped = await opted.exited;
  assert.equal(stopped.code, 0);
  assert.match(opted.output(), /Stopped following\./);

  // Without the flag, a closed stdin means nothing. `docker exec` WITHOUT
  // `--interactive` hands the process a closed stdin, and a follower run by hand
  // that way must not exit the moment it starts.
  const plain = startFollower(state, { stdin: "ignore" });
  await until(() => plain.output().includes("Following."), { timeoutMs: 10_000 });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(plain.child.exitCode, null, "the follower exited on a stdin it was told to ignore");
  plain.child.kill("SIGINT");
  await plain.exited;
});

test("with no instance running, events refuses instead of reading a stale ledger", async () => {
  // A stopped instance leaves state.sqlite behind. Printing it would show the
  // last run's ledger as live, and `--follow` would then wait forever for an
  // event nothing can produce. Found by running the command after `down`.
  const state = stateDir();
  const db = openState(join(state, "state.sqlite"));
  record(db, "slack.message.sent");
  db.close();
  // No bindings.json: this is what a state directory looks like after `down`.

  for (const args of [["events"], ["events", "--follow"]]) {
    const child = spawn(process.execPath, [BIN, ...args, "--state", state], {
      cwd: ROOT,
      env: { ...process.env, WORLDFIXTURE_SINGLE_CONTAINER: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    const code = await Promise.race([
      new Promise((resolve) => child.on("exit", resolve)),
      new Promise((resolve) => setTimeout(() => { child.kill("SIGKILL"); resolve("hung"); }, 5_000)),
    ]);

    assert.notEqual(code, "hung", `${args.join(" ")} never returned`);
    assert.equal(code, 1);
    assert.match(output, /No instance is running/);
    assert.match(output, /worldfixture(?:\.mjs)? up/);
    assert.equal(output.includes("slack.message.sent"), false, "a stale ledger was printed as live");
  }
});

test("without --follow the command prints the ledger and returns", async () => {
  const state = stateDir();
  const db = openState(join(state, "state.sqlite"));
  record(db, "slack.message.sent");
  db.close();
  markRunning(state);

  const child = spawn(process.execPath, [BIN, "events", "--state", state], {
    cwd: ROOT,
    env: { ...process.env, WORLDFIXTURE_SINGLE_CONTAINER: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  const code = await new Promise((resolve) => child.on("exit", resolve));

  assert.equal(code, 0);
  assert.match(output, /slack\.message\.sent/);
  assert.equal(output.includes("Following."), false);
});
