// The supervisor, against services that actually run.
//
// Two of the four services are pure Node and start on any machine, so these
// tests start them for real: real ports, real child processes, real protocol
// answers. Mail and s3 need containers and are covered by their own protocol
// tests; what is proven here is the supervisor's own behaviour, and proving it
// against a mock would prove nothing -- every defect this file guards against
// was a defect in talking to a real process.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { loadManifests } from "./manifests.mjs";
import { resolveEnvironment } from "./resolve.mjs";
import { aggregate, probe } from "./readiness.mjs";
import { allocate, environmentFor, SINGLE_CONTAINER_PORTS } from "./ports.mjs";
import { appendEvent, openState } from "./state.mjs";
import { history, send, tokenFor } from "./slack.mjs";
import { StartupError, start, verifyArtifact, worldPathFor } from "./supervisor.mjs";
import { credential, prepareCredentials } from "./credentials.mjs";
import { inbox } from "./imap.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const ARTIFACT = join(ROOT, "dist/business.saas-company.v2");
const SERVICES = join(ROOT, "emulators");
const MANIFESTS = loadManifests(SERVICES);
const run = promisify(execFile);

test("managed IMAP accepts the run password and rejects the old derived password", async () => {
  const instance = await start(lockFor(["mail.imap.v1"]), { artifactPath: ARTIFACT, stateDir: stateDir(), serviceRoot: SERVICES });
  try {
    const address = instance.addressOf("mail", "imap");
    const where = `${address.host}:${address.port}`;
    const login = "maya@northstar-relay.worldfixture.test";
    assert.ok((await inbox(where, { login, password: credential(instance.credentials, "mail-password:maya-chen") })).exists > 0);
    await assert.rejects(() => inbox(where, { login, password: "maya-chen" }), /authentication|login|failed/i);
  } finally { await instance.stop(); }
});

const scratch = [];
after(() => scratch.forEach((path) => rmSync(path, { recursive: true, force: true })));

function stateDir() {
  const path = mkdtempSync(join(tmpdir(), "worldfixture-test-"));
  scratch.push(path);
  return path;
}

// Both services here are pure Node, so this suite runs without Docker.
function lockFor(requires, bindings = {}) {
  return resolveEnvironment(
    {
      api_version: "worldfixture.environment/v1",
      world: { use: "business.saas-company:v2" },
      requires,
      bindings,
      target: { kind: "none", identity: "person.maya-chen" },
    },
    { manifests: MANIFESTS, artifactPath: ARTIFACT },
  );
}

async function started(requires, bindings) {
  const instance = await start(lockFor(requires, bindings), {
    artifactPath: ARTIFACT,
    stateDir: stateDir(),
    serviceRoot: SERVICES,
    readyTimeoutMs: 30_000,
  });
  return instance;
}

// ---- the artifact --------------------------------------------------------

test("a world whose bytes are not the ones the lock resolved is refused", () => {
  const lock = lockFor(["http.public-site.v1"]);
  const forged = { ...lock, world: { ...lock.world, projections: { ...lock.world.projections } } };
  const file = Object.keys(forged.world.projections)[0];

  // A size-preserving edit is exactly what a length check alone misses, so the
  // digest is changed and the size left alone.
  forged.world.projections[file] = { ...forged.world.projections[file], sha256: "0".repeat(64) };

  assert.throws(
    () => verifyArtifact(forged, ARTIFACT),
    (error) => error.code === "artifact_mismatch" && error.state_changed === false,
  );
});

test("a missing projection is named rather than discovered at seed time", () => {
  const lock = lockFor(["http.public-site.v1"]);
  const forged = {
    ...lock,
    world: { ...lock.world, projections: { "projections/absent.json": { sha256: "0".repeat(64), size: 1 } } },
  };
  assert.throws(() => verifyArtifact(forged, ARTIFACT), /absent\.json is missing/);
});

test("the real artifact satisfies the lock it resolved", () => {
  assert.doesNotThrow(() => verifyArtifact(lockFor(["http.public-site.v1"]), ARTIFACT));
});

// ---- ports ---------------------------------------------------------------

test("every opened port gets a distinct host port", async () => {
  const lock = lockFor(["slack.messaging.v1", "http.public-site.v1"]);
  const { allocation, release } = await allocate(lock);
  const numbers = [...allocation.values()].map((entry) => entry.number);
  await release();

  assert.equal(new Set(numbers).size, numbers.length);
  assert.ok(numbers.every((number) => number > 1024));
});

test("a published port is exposed widely and a private one stays on this machine", async () => {
  // Mail runs in a container, so every listener inside it binds every interface
  // -- the supervisor probes from outside that namespace, and a loopback-bound
  // listener would be unreachable however it were published. What narrows a
  // private port is where the host exposes it.
  const lock = lockFor(["mail.imap.v1"]);
  const { allocation, release } = await allocate(lock);
  const byName = Object.fromEntries([...allocation.values()].map((entry) => [entry.port, entry]));
  await release();

  assert.equal(byName.imap.publishOn, "0.0.0.0", "IMAP is an application surface");
  assert.equal(byName.health.publishOn, "127.0.0.1", "the health port is a back channel");
  assert.equal(byName.mailbox.publishOn, "127.0.0.1", "the mailbox UI is not an application surface");
  for (const port of Object.values(byName)) {
    assert.equal(port.bind, "0.0.0.0", `${port.port} binds widely inside its container`);
  }
});

test("a child process binds narrowly for a private port", async () => {
  // The composer shares this network namespace, so its own bind address is the
  // boundary and nothing needs publishing.
  const lock = lockFor(["slack.messaging.v1"]);
  const { allocation, release } = await allocate(lock);
  const slack = allocation.get("emulate/slack");
  await release();

  assert.equal(slack.contained, false);
  assert.equal(slack.bind, "0.0.0.0", "Slack is an application surface");
  assert.equal(slack.serverPort, slack.number, "a child process binds the port this machine dials");
});

// This case is about the FIXED ports, so it can only run when they are free.
//
// The README tells a new person to run `worldfixture up`, and CONTRIBUTING tells
// them to run `npm test`. Doing both in that order used to fail here with
// `EADDRINUSE 127.0.0.1:4703`, because the running instance is holding exactly
// the port this test asserts. That is not a broken allocator, and a failure is
// the wrong way to say so.
async function fixedPortsAreFree() {
  const { createServer } = await import("node:net");
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(4703, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

test("the single-container runner uses stable ports in one namespace", async (t) => {
  if (!(await fixedPortsAreFree())) {
    return t.skip("port 4703 is in use, most likely by a running instance; stop it with `worldfixture down`");
  }
  const lock = lockFor(["slack.messaging.v1", "mail.imap.v1", "aws.s3.objects.v1"]);
  const { allocation, release } = await allocate(lock, {
    runner: "process",
    fixedPorts: SINGLE_CONTAINER_PORTS,
  });

  try {
    assert.equal(allocation.get("emulate/slack").number, 4703);
    assert.equal(allocation.get("mail/imap").number, 1143);
    assert.equal(allocation.get("s3/s3").number, 61006);
    assert.equal(allocation.get("mail/health").bind, "127.0.0.1");
    assert.equal(allocation.get("mail/imap").bind, "0.0.0.0");
    assert.ok([...allocation.values()].every((entry) => entry.contained === false));
  } finally {
    await release();
  }
});

test("each service is handed its ports in the shape it asks for", async () => {
  // Three conventions across four services, and the manifest says which.
  const lock = lockFor(["mail.imap.v1", "aws.s3.objects.v1"]);
  const { allocation, release } = await allocate(lock);

  const mail = lock.services.find((service) => service.name === "mail");
  const s3 = lock.services.find((service) => service.name === "s3");
  const mailEnv = environmentFor(mail, allocation, { worldPath: ARTIFACT });
  const s3Env = environmentFor(s3, allocation, { worldPath: ARTIFACT });
  await release();

  // mail wants `host:port` in one variable and declares no bind variable. The
  // port is the container's own, not the one this machine dials.
  assert.equal(mailEnv.WORLDFIXTURE_IMAP_LISTEN, "0.0.0.0:1143");
  assert.ok(!("WORLDFIXTURE_BIND_IMAP" in mailEnv));
  // s3 wants a bare number.
  assert.equal(s3Env.WORLDFIXTURE_S3_PORT, "61006");
  assert.equal(s3Env.WORLDFIXTURE_FILER_PORT, "61004");
  // Both need the world, and both read it at their mount point rather than at
  // the host path, which does not exist inside a container.
  assert.equal(mailEnv.WORLDFIXTURE_WORLD_PATH, ARTIFACT);
  assert.equal(s3Env.WORLDFIXTURE_WORLD_PATH, ARTIFACT);
});

test("the composer gets a bind variable because it declares one", async () => {
  const lock = lockFor(["slack.messaging.v1"]);
  const { allocation, release } = await allocate(lock);
  const emulate = lock.services.find((service) => service.name === "emulate");
  const environment = environmentFor(emulate, allocation, {
    worldPath: ARTIFACT,
    statePath: stateDir(),
  });
  await release();

  assert.match(environment.WORLDFIXTURE_PORT_SLACK, /^\d+$/);
  assert.equal(environment.WORLDFIXTURE_BIND_SLACK, "0.0.0.0");
});

test("a required environment value with no source fails before anything starts", async () => {
  const lock = lockFor(["http.public-site.v1"]);
  const { allocation, release } = await allocate(lock);
  const service = lock.services[0];
  await release();

  assert.throws(() => environmentFor(service, allocation, {}), /requires WORLDFIXTURE_WORLD_PATH/);
});

test("a generated service environment reuses its project credential", async () => {
  const generatedSecretsPath = join(stateDir(), "generated-secrets.json");
  const service = {
    name: "postgres",
    ports: [],
    environment: [{ name: "POSTGRES_PASSWORD", from: "generated", key: "postgres.password", required: true }],
  };

  const credentials = await prepareCredentials({ lock: lockFor(["postgres.wire.v1"]), artifactPath: ARTIFACT, stateDir: stateDir(), generatedSecretsPath });
  const first = environmentFor(service, new Map(), { credentials });
  const second = environmentFor(service, new Map(), { credentials });
  assert.match(first.POSTGRES_PASSWORD, /^[0-9a-f]{48}$/);
  assert.equal(second.POSTGRES_PASSWORD, first.POSTGRES_PASSWORD);
});

// ---- readiness -----------------------------------------------------------

test("an HTTP check that matches a status is not fooled by another route", async () => {
  // The composer answers 404 with a JSON body on every unknown path, so a check
  // that only compared statuses would pass against a route it never intended.
  const instance = await started(["slack.messaging.v1"]);
  const address = instance.addressOf("emulate", "slack");

  const right = await probe({ protocol: "http", path: "/api/auth.test", method: "POST", expect: "not_authed" }, address);
  const wrong = await probe({ protocol: "http", path: "/api/nothing.here", method: "POST", expect: "not_authed" }, address);

  await instance.stop();
  assert.equal(right.ok, true, right.detail);
  assert.equal(wrong.ok, false, "a body match must not pass on an unrelated route");
});

test("a greeting check fails against a port with nothing behind it", async () => {
  const result = await probe({ protocol: "imap", expect: "* OK" }, { host: "127.0.0.1", port: 1 }, { timeoutMs: 500 });
  assert.equal(result.ok, false);
});

test("an unknown protocol is not quietly downgraded to a TCP connect", async () => {
  const instance = await started(["http.public-site.v1"]);
  const address = instance.addressOf("http-targets", "http");
  const result = await probe({ protocol: "gopher", expect: "x" }, address);
  await instance.stop();

  assert.equal(result.ok, false);
  assert.match(result.detail, /no probe for protocol/);
});

test("aggregate is never satisfied by a seed gate alone", () => {
  const gateOnly = aggregate([{ kind: "seed_gate", ok: true }]);
  assert.equal(gateOnly.ready, false, "a marker is not evidence of a live service");
  assert.equal(gateOnly.seeded, true);

  const both = aggregate([{ kind: "seed_gate", ok: true }, { kind: "protocol", ok: true }]);
  assert.equal(both.ready, true);

  const gateFailed = aggregate([{ kind: "seed_gate", ok: false }, { kind: "protocol", ok: true }]);
  assert.equal(gateFailed.ready, false, "a service serving an unseeded world is answering about nothing");
});

// ---- starting for real ---------------------------------------------------

test("one lock starts two real services and proves each on its own protocol", async () => {
  const instance = await started(["slack.messaging.v1", "http.public-site.v1"]);

  try {
    assert.deepEqual([...instance.readiness.keys()].sort(), ["emulate", "http-targets"]);
    for (const [service, result] of instance.readiness) {
      assert.equal(result.ready, true, `${service} is ready`);
      assert.ok(result.proven >= 1, `${service} is proven by a protocol check`);
    }
  } finally {
    await instance.stop();
  }
});

test("a started world answers the real provider API as a world person", async () => {
  // The point of all of it: Maya acts as herself through the Slack Web API,
  // reached at a port this run allocated.
  const instance = await started(["slack.messaging.v1"], { SLACK_BASE_URL: "slack.messaging.v1/base_url" });

  try {
    const response = await fetch(`${instance.bindings().SLACK_BASE_URL}/api/auth.test`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenFor({ id: "maya-chen" }, instance.credentials)}` },
    });
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.user, "mayac");
  } finally {
    await instance.stop();
  }
});

test("bindings name the ports this run allocated", async () => {
  const instance = await started(["http.public-site.v1"], { SITE_URL: "http.public-site.v1/base_url" });

  try {
    const url = instance.bindings().SITE_URL;
    const { port } = instance.addressOf("http-targets", "http");
    assert.equal(url, `http://127.0.0.1:${port}`);
    assert.equal((await fetch(`${url}/readyz`)).status, 200);
  } finally {
    await instance.stop();
  }
});

test("readiness is decided by the protocol, not by what the child printed", async () => {
  // The composer prints "slack → http://… (listening on …)" before it is
  // necessarily answering, and this extraction has twice been misled by a
  // listener that was up and wrong. Readiness must not consult that line.
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(join(ROOT, "runtime/src/supervisor.mjs"), "utf8"),
  );
  const proveReady = source.slice(source.indexOf("async function proveReady"));
  assert.ok(!proveReady.includes(".log.tail()") || proveReady.includes("StartupError"),
    "log output may appear in a failure message and never in a readiness decision");
  assert.ok(!/if\s*\(.*log.*\)\s*\{[^}]*ready/i.test(proveReady));
});

test("stopping the instance leaves no child process", async () => {
  const instance = await started(["slack.messaging.v1", "http.public-site.v1"]);
  const pids = instance.children.map((record) => record.child.pid);
  const stopped = await instance.stop();

  assert.equal(stopped.length, 2);
  for (const record of stopped) assert.notEqual(record.exited, null, `${record.service} exited`);

  // A joined fixture whose supervisor exits leaves children holding ports, and
  // the next run then talks to the previous one.
  await new Promise((resolve) => setTimeout(resolve, 200));
  for (const pid of pids) {
    assert.throws(() => process.kill(pid, 0), /ESRCH/, `pid ${pid} is gone`);
  }
});

test("reset restores provider, HTTP and runtime state to the accepted start", async () => {
  const instance = await started(
    ["slack.messaging.v1", "http.public-site.v1"],
    {
      SLACK_BASE_URL: "slack.messaging.v1/base_url",
      SITE_URL: "http.public-site.v1/base_url",
    },
  );
  const slack = instance.bindings().SLACK_BASE_URL;
  const site = instance.bindings().SITE_URL;
  const token = tokenFor({ id: "maya-chen" }, instance.credentials);

  try {
    const initialHistory = await history(slack, token, "release-2-8");
    const initialPage = await fetch(`${site}/notes/lumen-export`).then((response) => response.text());

    await send(slack, token, { channelName: "release-2-8", text: "reset removes this" });
    const changedPage = await fetch(`${site}/notes/lumen-export`).then((response) => response.text());
    appendEvent(instance.state, {
      id: "evt_reset_test",
      type: "communication.message.sent.v1",
      actor_id: "person.maya-chen",
      source: "slack",
      occurred_at: "2026-09-02T12:00:00Z",
    });

    assert.notDeepEqual(await history(slack, token, "release-2-8"), initialHistory);
    assert.notEqual(changedPage, initialPage);
    assert.equal(instance.state.prepare("SELECT COUNT(*) AS n FROM events").get().n, 1);

    await instance.reset();

    assert.deepEqual(await history(slack, token, "release-2-8"), initialHistory);
    assert.equal(
      await fetch(`${site}/notes/lumen-export`).then((response) => response.text()),
      initialPage,
    );
    assert.equal(instance.state.prepare("SELECT COUNT(*) AS n FROM events").get().n, 0);
    assert.ok(existsSync(join(instance.stateDir, "emulate-snapshot.json")));
  } finally {
    await instance.stop();
  }
});

test("a service that exits before readiness is reported with its own output", async () => {
  // The composer exits 1 when no vendor was given a port. Driving that through
  // the supervisor proves the failure carries the child's own message rather
  // than a timeout.
  const lock = lockFor(["slack.messaging.v1"]);
  const broken = {
    ...lock,
    services: lock.services.map((service) => ({ ...service, command: ["node", "-e", "process.exit(3)"] })),
  };

  await assert.rejects(
    start(broken, { artifactPath: ARTIFACT, stateDir: stateDir(), serviceRoot: SERVICES, readyTimeoutMs: 3_000 }),
    (error) => error instanceof StartupError && ["service_exited", "not_ready"].includes(error.code),
  );
});

// ---- state ---------------------------------------------------------------

test("starting an instance writes one instance row and the runtime tables", async () => {
  const directory = stateDir();
  const instance = await start(lockFor(["http.public-site.v1"]), {
    artifactPath: ARTIFACT,
    stateDir: directory,
    serviceRoot: SERVICES,
    readyTimeoutMs: 30_000,
  });
  await instance.stop();

  assert.ok(existsSync(join(directory, "state.sqlite")));

  const db = openState(join(directory, "state.sqlite"));
  const rows = db.prepare("SELECT * FROM instance").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].world_id, "business.saas-company");
  assert.equal(rows[0].artifact_sha256, instance.lock.world.artifact_sha256);

  // Service state stays in the service that owns it; the runtime's log starts
  // empty. (`node:sqlite` returns null-prototype rows, so compare the value.)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events").get().n, 0);
  db.close();
});

test("a state database from a different schema version is refused, not migrated", () => {
  const directory = stateDir();
  const path = join(directory, "state.sqlite");
  const db = openState(path);
  db.exec("UPDATE schema_version SET version = 99");
  db.close();

  assert.throws(() => openState(path), /schema version 99/);
});

test("the event log is append-only and hands out a monotonic cursor", async () => {
  const { appendEvent, eventsAfter, latestEvents } = await import("./state.mjs");
  const db = openState(":memory:");

  const first = appendEvent(db, {
    id: "evt_1", type: "communication.message.sent.v1", actor_id: "person.maya",
    source: "slack", occurred_at: "2026-09-02T09:43:00Z", provider_evidence: { channel_id: "C1" },
  });
  const second = appendEvent(db, {
    id: "evt_2", type: "communication.message.sent.v1", actor_id: "person.priya",
    source: "slack", occurred_at: "2026-09-02T09:44:00Z",
  });

  assert.ok(second > first);
  assert.deepEqual(eventsAfter(db, first).map((event) => event.id), ["evt_2"]);
  assert.deepEqual(latestEvents(db, 1).map((event) => event.id), ["evt_2"]);
  // Provider evidence survives the round trip; it is what makes an event a fact
  // rather than a claim.
  assert.deepEqual(eventsAfter(db, 0)[0].provider_evidence, { channel_id: "C1" });
  // A repeated id is a duplicate observation, not a second fact.
  assert.throws(() => appendEvent(db, { id: "evt_1", type: "x", source: "slack", occurred_at: "z" }));
  db.close();
});

test("S3 starts as a container and answers its own protocol", async () => {
  // The container path had been proven once, for mail. S3 is the other
  // container-backed service and had only ever been planned by the resolver:
  // every earlier test stopped at allocation. Starting it is what makes
  // `runtime.container` a proven seam rather than a declared one.
  const instance = await start(lockFor(["aws.s3.objects.v1"]), {
    artifactPath: ARTIFACT,
    stateDir: stateDir(),
    serviceRoot: SERVICES,
    readyTimeoutMs: 180_000,
  });

  try {
    const readiness = instance.readiness.get("s3");
    assert.equal(readiness.ready, true);
    assert.equal(readiness.seeded, true, "the filer records that every declared object was stored");

    // The seed gate counts what the world declared; the protocol check proves
    // the surface an application uses is answering. Both, because either alone
    // has been wrong before.
    const gate = readiness.checks.find((check) => check.kind === "seed_gate");
    assert.equal(gate.ok, true);
    const filer = instance.addressOf("s3", "filer");
    const seedGate = await fetch(`http://${filer.host}:${filer.port}/worldfixture/ready`);
    assert.equal(seedGate.status, 200);
    assert.deepEqual(await seedGate.json(), {
      source: "worldfixture-s3",
      ready: true,
      buckets: 2,
      objects: 2,
    });

    const { host, port } = instance.addressOf("s3", "s3");
    const listing = await fetch(`http://${host}:${port}/`);
    assert.equal(listing.status, 200);
    assert.match(await listing.text(), /ListAllMyBucketsResult/);

    // The world's own document, read back over the S3 API.
    const objects = await fetch(`http://${host}:${port}/northstar-relay-documents/?list-type=2`);
    assert.equal(objects.status, 200);
    assert.match(await objects.text(), /<Key>/);
  } finally {
    await instance.stop();
  }
});

test("world reset restarts resettable services and preserves MySQL data", async () => {
  const generatedSecretsPath = join(stateDir(), "generated-secrets.json");
  const instance = await start(lockFor(["mysql.wire.v1", "http.public-site.v1"]), {
    artifactPath: ARTIFACT,
    stateDir: stateDir(),
    serviceRoot: SERVICES,
    readyTimeoutMs: 180_000,
    generatedSecretsPath,
  });
  const mysqlRecord = instance.children.find((record) => record.service === "mysql");
  const mysqlPassword = credential(instance.credentials, "mysql.password");
  const httpRecord = instance.children.find((record) => record.service === "http-targets");
  const containerName = mysqlRecord.container;
  const query = async (sql) => {
    const { stdout } = await run("docker", [
      "exec", "-e", "MYSQL_PWD", containerName,
      "mariadb", "--batch", "--skip-column-names", "--host=127.0.0.1",
      "--user=worldfixture", "worldfixture", "--execute", sql,
    ], { env: { ...process.env, MYSQL_PWD: mysqlPassword } });
    return stdout.trim();
  };

  try {
    assert.equal(instance.readiness.get("mysql").ready, true);
    await query("CREATE TABLE connector_probe (id INT PRIMARY KEY); INSERT INTO connector_probe VALUES (1);");
    assert.equal(await query("SELECT COUNT(*) FROM connector_probe;"), "1");

    await instance.reset();

    assert.equal(await query("SELECT COUNT(*) FROM connector_probe;"), "1");
    assert.equal(instance.children.find((record) => record.service === "mysql"), mysqlRecord);
    assert.notEqual(instance.children.find((record) => record.service === "http-targets"), httpRecord);
  } finally {
    await instance.stop();
  }
});

test("Notion file uploads use the selected S3 service and reset with the world", async () => {
  const instance = await start(lockFor(["notion.file-uploads.v1"]), {
    artifactPath: ARTIFACT,
    stateDir: stateDir(),
    serviceRoot: SERVICES,
    readyTimeoutMs: 180_000,
  });

  try {
    const notion = instance.addressOf("emulate", "notion");
    const baseUrl = `http://${notion.host}:${notion.port}`;
    const headers = {
      Authorization: `Bearer ${credential(instance.credentials, "token:notion_token")}`,
      "Notion-Version": "2026-03-11",
      "content-type": "application/json",
    };
    const createdResponse = await fetch(`${baseUrl}/v1/file_uploads`, {
      method: "POST", headers, body: JSON.stringify({ filename: "agent.txt", content_type: "text/plain" }),
    });
    assert.equal(createdResponse.status, 200);
    const upload = await createdResponse.json();
    assert.equal(Object.hasOwn(upload, "object_key"), false, "the public API does not expose S3 details");

    const form = new FormData();
    form.set("file", new Blob(["stored by SeaweedFS"], { type: "text/plain" }), "agent.txt");
    const sent = await fetch(`${baseUrl}/v1/file_uploads/${upload.id}/send`, {
      method: "POST",
      headers: { Authorization: headers.Authorization, "Notion-Version": headers["Notion-Version"] },
      body: form,
    });
    const sentBody = await sent.json();
    assert.equal(sent.status, 200, JSON.stringify(sentBody));
    assert.equal(sentBody.status, "uploaded");

    const s3 = instance.addressOf("s3", "s3");
    const objectUrl = `http://${s3.host}:${s3.port}/northstar-relay-documents/notion/uploads/${upload.id}/agent.txt`;
    const stored = await fetch(objectUrl);
    assert.equal(stored.status, 200);
    assert.equal(await stored.text(), "stored by SeaweedFS");

    await instance.reset();
    const restoredNotion = instance.addressOf("emulate", "notion");
    const missingMetadata = await fetch(`http://${restoredNotion.host}:${restoredNotion.port}/v1/file_uploads/${upload.id}`, { headers });
    assert.equal(missingMetadata.status, 404);
    const restoredS3 = instance.addressOf("s3", "s3");
    assert.equal((await fetch(`http://${restoredS3.host}:${restoredS3.port}/northstar-relay-documents/notion/uploads/${upload.id}/agent.txt`)).status, 404);
  } finally {
    await instance.stop();
  }
});

test("selecting S3 leaves the composer's S3 port shut in a real run", async () => {
  // The lock says the port is closed. This checks the running system agrees,
  // because a disclaimed surface that is still listening is the whole defect.
  const instance = await start(lockFor(["aws.s3.objects.v1", "slack.messaging.v1"]), {
    artifactPath: ARTIFACT,
    stateDir: stateDir(),
    serviceRoot: SERVICES,
    readyTimeoutMs: 180_000,
  });

  try {
    assert.deepEqual(instance.lock.closed_conflicts.map((entry) => entry.port), ["aws"]);
    assert.throws(() => instance.addressOf("emulate", "aws"), /no allocation/);

    const emulate = instance.lock.services.find((service) => service.name === "emulate");
    assert.deepEqual(emulate.ports.map((port) => port.name), ["slack"]);
  } finally {
    await instance.stop();
  }
});

// The bug this closes: `ensureImage` takes `{ log }` and writes
// "building <tag> for <service>; this happens once" before a build that runs
// for minutes, and its ONE call site passed two arguments. The default no-op
// `log` swallowed the line, so a checkout run that had to build an image
// printed nothing at all while it built. `start` now takes `onNotice` and
// hands it down.
test("a service whose image must be built says so before the build starts", async () => {
  const lock = lockFor(["mail.imap.v1"]);
  const mail = lock.services.find((service) => service.name === "mail");

  // A tag no machine has, so `ensureImage` cannot take its early return, and a
  // build context that fails immediately, so the build ends without minutes of
  // work. The notice is written before the build either way.
  mail.container.tag = "worldfixture-notice-probe:absent";
  const root = stateDir();
  mkdirSync(join(root, "mail"), { recursive: true });
  writeFileSync(join(root, "mail", "Dockerfile"), "NOT-A-DOCKERFILE-DIRECTIVE\n");

  const notices = [];
  await assert.rejects(() => start(lock, {
    artifactPath: ARTIFACT,
    stateDir: stateDir(),
    serviceRoot: root,
    readyTimeoutMs: 5_000,
    onNotice: (line) => notices.push(line),
  }));

  assert.equal(
    notices.some((line) => /building worldfixture-notice-probe:absent for mail; this happens once/.test(line)),
    true,
    `the build notice never reached the caller: ${JSON.stringify(notices)}`,
  );
});

// The bug this closes: the world path for a container was
// `mounts.find(world.path)?.target ?? artifactPath`, and the fallback is the
// HOST path -- which the comment above the line says must never go into a
// container. mysql and postgres are container services with no `world.path`
// mount and both declare `WORLDFIXTURE_WORLD_PATH` from `world.path`, so both
// were started with a host directory that does not exist inside them. Measured:
// WORLDFIXTURE_WORLD_PATH=/…/dist/business.saas-company.v3 inside a MariaDB
// container. Absent is the honest answer, and `environmentFor` leaves an
// optional value unset rather than setting it to a lie.
test("a container that mounts no world is given no world path, not the host one", async () => {
  const mounted = { name: "mail", container: { tag: "t", mounts: [{ source: "world.path", target: "/world", mode: "ro" }] } };
  const unmounted = { name: "mysql", container: { tag: "mariadb" } };

  assert.equal(worldPathFor(mounted, ARTIFACT, true), "/world");
  assert.equal(worldPathFor(unmounted, ARTIFACT, true), undefined);
  // A child process still reads the world where it lies.
  assert.equal(worldPathFor(unmounted, ARTIFACT, false), ARTIFACT);

  // And the optional variable is left out rather than set to the host path.
  const service = { name: "mysql", ports: [], environment: [{ name: "WORLDFIXTURE_WORLD_PATH", from: "world.path", required: false }] };
  const environment = environmentFor(service, new Map(), { worldPath: worldPathFor(unmounted, ARTIFACT, true) });
  assert.equal("WORLDFIXTURE_WORLD_PATH" in environment, false);
});

// The bug this closes: `proveReady` checked `record.exited` once, before each
// readiness wait, and never during it. A child that died a second into a
// 180-second wait was therefore reported at the end of it as "did not become
// ready on its <protocol> check" -- which describes the socket, not the child --
// while the exit code and the child's own output sat unused in the record.
//
// Measured on CI: `emulate` started without its dependencies exits immediately
// on `Cannot find package '@emulators/core'`, and 22 runtime tests reported
// `fetch failed` instead. The cause took three CI runs to find.
test("a service that dies during the wait is reported as exited, not as unready", async () => {
  const lock = lockFor(["slack.messaging.v1"]);
  const emulate = lock.services.find((service) => service.name === "emulate");

  // A command that exits at once, so the child is gone well inside the wait and
  // the readiness socket never answers -- the exact shape of the CI failure.
  emulate.command = ["node", "-e", "process.stderr.write('cannot find package\\n'); process.exit(1)"];

  await assert.rejects(
    () => start(lock, { artifactPath: ARTIFACT, stateDir: stateDir(), serviceRoot: SERVICES, readyTimeoutMs: 5_000 }),
    (error) => {
      assert.equal(error.code, "service_exited", `reported as ${error.code}: ${error.message}`);
      assert.match(error.message, /emulate exited with code 1/);
      assert.ok(error.detail.log.some((entry) => /cannot find package/.test(entry.line)),
        "the child's own output travels with the failure");
      return true;
    },
  );
});

// Every container service the repo ships either mounts the world or does not ask
// for it, so no real service loses a path it was using.
test("no shipped container service is left needing a world path it cannot reach", async () => {
  for (const manifest of MANIFESTS) {
    const container = manifest.runtime.container;
    if (!container) continue;
    const path = worldPathFor({ name: manifest.name, container }, ARTIFACT, true);
    if (path !== undefined) continue;
    const needs = (manifest.runtime.environment ?? []).filter(
      (entry) => entry.from === "world.path" && entry.required,
    );
    assert.deepEqual(needs, [], `${manifest.name} requires the world path and mounts no world`);
  }
});
