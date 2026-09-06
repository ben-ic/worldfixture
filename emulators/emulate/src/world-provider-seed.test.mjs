import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { usesWorldSeed } from "./world-provider-seed.mjs";

const world = { id: "test.accounts", version: "v1", digest: "a".repeat(64) };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}
async function composer(root, ports) {
  const child = spawn(process.execPath, [join(import.meta.dirname, "main.mjs")], {
    cwd: join(import.meta.dirname, ".."), stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, WORLDFIXTURE_WORLD_PATH: root, WORLDFIXTURE_STATE_PATH: join(root, "state"),
      WORLDFIXTURE_SEED: join(root, "seed.yaml"), WORLDFIXTURE_CREDENTIALS: join(root, "credentials.json"), WORLDFIXTURE_TIMELINE_OWNER: "runtime",
      ...Object.fromEntries(Object.entries(ports).map(([vendor, port]) => [`WORLDFIXTURE_PORT_${vendor.toUpperCase()}`, String(port)])) },
  });
  let output = "", exit;
  child.stdout.on("data", value => { output += value; });
  child.stderr.on("data", value => { output += value; });
  child.on("exit", code => { exit = code; });
  const stop = async () => {
    if (exit !== undefined) return;
    const ended = new Promise(resolve => child.once("exit", resolve));
    child.kill("SIGKILL"); await ended;
  };
  const deadline = Date.now() + 20000;
  try {
    while (!output.includes("aggregate readiness")) {
      if (exit !== undefined || Date.now() > deadline) throw new Error(`Composer did not start: ${output}`);
      await wait(25);
    }
    while (!existsSync(join(root, "state/emulate-snapshot.json"))) {
      if (exit !== undefined || Date.now() > deadline) throw new Error(`Composer snapshot did not complete: ${output}`);
      await wait(25);
    }
    const secrets = JSON.parse(readFileSync(join(root, "credentials.json"), "utf8")).values;
    for (const [vendor, port] of Object.entries(ports)) {
      let ready = false;
      while (!ready) {
        if (exit !== undefined || Date.now() > deadline) throw new Error(`Composer ${vendor} did not answer: ${output}`);
        try {
          const response = await fetch(`http://127.0.0.1:${port}/_worldfixture/seed-receipt`, {
            headers: { authorization: `Bearer ${secrets[`token:${vendor === "google" ? "google_token_one" : "linear_token"}`]}` },
            signal: AbortSignal.timeout(1000),
          });
          ready = response.ok && (await response.json()).world.digest === world.digest;
        } catch { /* serve() returns before the socket starts accepting requests. */ }
        if (!ready) await wait(25);
      }
    }
  } catch (error) { await stop(); throw error; }
  return { stop, output: () => output };
}

test("versioned world seed is explicit and rejects unknown contract versions", () => {
  assert.equal(usesWorldSeed("google", {}, world), false);
  assert.equal(usesWorldSeed("google", { worldfixture_seed_version: 1 }, world), true);
  assert.equal(usesWorldSeed("google", { worldfixture_seed_version: 1 }, undefined), false);
  assert.throws(() => usesWorldSeed("linear", { worldfixture_seed_version: 2 }, world), /Unsupported/);
});

test("composer seeds both recipients and duplicate Linear tasks, then restores receipts and content", async t => {
  const root = mkdtempSync(join(tmpdir(), "wf-provider-seed-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "seed.yaml"), "{}\n");
  const users = ["one", "two"].map(id => ({ worldfixture_person_id: id, name: id, email: `${id}@fixture.test` }));
  const overlay = {
    google: { worldfixture_seed_version: 1, users, calendars: [], calendar_events: [], drive_items: [],
      labels: users.map(user => ({ user_email: user.email, name: "Future", id: "future-label" })),
      messages: users.map(user => ({ worldfixture_message_id: "shared", worldfixture_owner_id: user.worldfixture_person_id,
        user_email: user.email, thread_id: "shared-thread", from: "Sender <sender@fixture.test>", to: "one@fixture.test, two@fixture.test",
        subject: "Shared mail", snippet: "Body", body_text: "Body", date: "2031-01-01T00:00:00Z", label_ids: ["INBOX", "future-label"] })) },
    linear: { worldfixture_seed_version: 1, users: [{ name: "one", email: users[0].email }],
      teams: [{ name: "Work", key: "WORK" }], labels: [], issues: ["source.a", "source.b"].map(id => ({
        worldfixture_task_id: id, team: "WORK", title: "Same title", description: "Same body", state: "Todo", assignee: users[0].email, labels: [] })) },
    tokens: { google_token_one: { login: users[0].email, scopes: [] }, google_token_two: { login: users[1].email, scopes: [] },
      linear_token: { login: users[0].email, scopes: [] } },
    worldfixture: { arrivals: [] },
  };
  mkdirSync(join(root, "projections"));
  const bytes = JSON.stringify(overlay);
  writeFileSync(join(root, "projections/emulator-overlay.json"), bytes);
  writeFileSync(join(root, "manifest.json"), JSON.stringify({ api_version: "worldfixture.world-artifact/v1", world_id: world.id,
    world_version: world.version, artifact_sha256: world.digest,
    files: { "projections/emulator-overlay.json": { size: Buffer.byteLength(bytes), sha256: createHash("sha256").update(bytes).digest("hex") } } }));
  const secrets = Object.fromEntries(Object.keys(overlay.tokens).map(key => [`token:${key}`, `current-test-${key}`]));
  writeFileSync(join(root, "credentials.json"), JSON.stringify({ api_version: "worldfixture.credentials/v1", values: secrets }));
  const ports = { google: await freePort(), linear: await freePort() };
  const request = (vendor, path, reference, init = {}) => fetch(`http://127.0.0.1:${ports[vendor]}${path}`, {
    ...init, headers: { "content-type": "application/json", ...(reference ? { authorization: `Bearer ${secrets[`token:${reference}`] ?? reference}` } : {}) },
  });
  let running = await composer(root, ports);
  t.after(() => running.stop());
  const googleReceipt = await (await request("google", "/_worldfixture/seed-receipt", "google_token_one")).json();
  const linearReceipt = await (await request("linear", "/_worldfixture/seed-receipt", "linear_token")).json();
  assert.equal(googleReceipt.mailboxes.length, 2);
  assert.equal(new Set(googleReceipt.messages.map(row => row.provider_message_id)).size, 2);
  assert.equal(linearReceipt.issues.length, 2);
  assert.equal(new Set(linearReceipt.issues.map(row => row.provider_issue_id)).size, 2);
  for (const vendor of ["google", "linear"]) {
    assert.equal((await request(vendor, "/_worldfixture/seed-receipt", "upstream-sample")).status, 401);
    assert.equal((await request(vendor, "/_worldfixture/seed-receipt")).status, 401);
  }
  assert.equal((await request("google", "/gmail/v1/users/two%40fixture.test/messages", "google_token_two", {
    method: "POST", body: JSON.stringify({ from: "sender@fixture.test", to: "two@fixture.test", subject: "Temporary", body_text: "Mutation", labelIds: ["INBOX"] }),
  })).status, 200);
  await running.stop();
  running = await composer(root, ports);
  assert.deepEqual(await (await request("google", "/_worldfixture/seed-receipt", "google_token_one")).json(), googleReceipt);
  assert.deepEqual(await (await request("linear", "/_worldfixture/seed-receipt", "linear_token")).json(), linearReceipt);
  const list = await (await request("google", "/gmail/v1/users/two%40fixture.test/messages", "google_token_two")).json();
  assert.equal(list.messages.length, 1);
  const snapshot = JSON.parse(readFileSync(join(root, "state/emulate-snapshot.json"), "utf8"));
  assert.deepEqual(snapshot.vendors.google.seed_receipt, googleReceipt);
  assert.deepEqual(snapshot.vendors.linear.seed_receipt, linearReceipt);
});
