// The all-in-one image gate, through real protocols and real processes.
//
// Build `worldfixture:local` first. This test starts exactly one WorldFixture
// container, waits for the runtime's ready screen, checks every application
// surface, runs the connected Slack-to-mail flow, gives a second container the
// same network namespace, and proves shutdown removes the container and ports.

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

const run = promisify(execFile);
const image = process.env.WORLDFIXTURE_IMAGE ?? "worldfixture:local";
const container = process.env.TEST_CONTAINER_NAME ?? `worldfixture-image-protocol-${process.pid}`;
const providerPorts = [4701, 4702, 4703, 4704, 4705, 4706, 4707, 4708, 4709, 4710, 4712, 4713, 4714];
const ports = [...providerPorts, 8080, 2525, 1143, 61006];

async function docker(args, options = {}) {
  return run("docker", args, { maxBuffer: 8 * 1024 * 1024, ...options });
}

function greeting(port, expected) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    const fail = (error) => {
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(5_000, () => fail(new Error(`${port} did not greet within 5 seconds`)));
    socket.on("error", fail);
    socket.on("data", (chunk) => {
      const line = chunk.toString("utf8").split("\n")[0];
      socket.destroy();
      if (!line.startsWith(expected)) reject(new Error(`${port} greeted with ${JSON.stringify(line)}`));
      else resolve(line);
    });
  });
}

function refuses(port) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    socket.setTimeout(2_000, () => {
      socket.destroy();
      reject(new Error(`${port} did not refuse after shutdown`));
    });
    socket.on("connect", () => {
      socket.destroy();
      reject(new Error(`${port} is still open after shutdown`));
    });
    socket.on("error", (error) => {
      if (error.code === "ECONNREFUSED") resolve();
      else reject(error);
    });
  });
}

let output = "";
const child = spawn("docker", [
  "run", "--rm", "--name", container,
  ...ports.flatMap((port) => ["-p", `127.0.0.1:${port}:${port}`]),
  image,
], { stdio: ["ignore", "pipe", "pipe"] });

async function stop() {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  await docker(["stop", "-t", "20", container]).catch(() => {});
  await exited;
}

try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`image did not become ready:\n${output}`)),
      180_000,
    );
    timeout.unref();
    const inspect = (chunk) => {
      output += chunk.toString("utf8");
      if (output.includes("Stop with Ctrl-C")) {
        clearTimeout(timeout);
        resolve();
      }
    };
    // The listeners above already append output. These listeners only wake the
    // readiness promise; they do not decide readiness from a service log.
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("exit", (code) => reject(new Error(`image exited ${code}:\n${output}`)));
  });

  assert.match(output, /S3\s+http:\/\/127\.0\.0\.1:61006/);
  assert.match(output, /SMTP\s+127\.0\.0\.1:2525/);
  assert.match(output, /IMAP\s+127\.0\.0\.1:1143/);

  const slack = await fetch("http://127.0.0.1:4703/api/auth.test", { method: "POST" });
  assert.equal(slack.status, 200);
  assert.equal((await slack.json()).error, "not_authed");

  const github = await fetch("http://127.0.0.1:4704/meta");
  assert.equal(github.status, 200);

  // Each published composer listener is checked from the host. These repeat
  // the service-owned readiness checks at the product boundary and compare a
  // response body, so the composer's generic JSON 404 cannot pass the gate.
  for (const [port, path, expected] of [
    [4701, "/v1/customers", '"object":"list"'],
    [4702, "/v2/user", "not_authenticated"],
    [4705, "/.well-known/openid-configuration", "authorization_endpoint"],
    [4706, "/v1.0/me", "InvalidAuthenticationToken"],
    [4707, "/api/atlas/v2/groups", '"results"'],
    [4708, "/api/v1/users", "E0000004"],
    [4709, "/domains", '"object":"list"'],
    [4710, "/auth/keys", '"keys"'],
    [4712, "/v1/users", "UNAUTHORIZED"],
    [4713, "/graphql", "GraphQL query is required"],
    [4714, "/2010-04-01/Accounts.json", "20003"],
  ]) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    assert.match(await response.text(), new RegExp(expected), `${port}${path}`);
  }

  const site = await fetch("http://127.0.0.1:8080/readyz");
  assert.equal(site.status, 200);
  assert.deepEqual(await site.json(), {
    ready: true,
    world_id: "business.saas-company",
    world_version: "v3",
    source: "verified-world",
  });

  assert.match(await greeting(2525, "220"), /WorldFixture session mail/);
  assert.match(await greeting(1143, "* OK"), /Cyrus IMAP/);

  const seed = await docker([
    "exec", container, "curl", "-fsS", "http://127.0.0.1:61004/worldfixture/ready",
  ]);
  // Counted from the artifact rather than written down here. The seed counts are
  // a property of the world, and hard-coding them means the gate has to be
  // edited every time the world grows -- which is how a gate stops being a gate.
  const aws = JSON.parse(readFileSync(join(ROOT, "dist/business.saas-company.v3/projections/aws.json"), "utf8"));
  assert.deepEqual(JSON.parse(seed.stdout), {
    source: "worldfixture-s3",
    ready: true,
    buckets: aws.s3.buckets.length,
    objects: aws.s3.objects.length,
  });
  const list = await fetch("http://127.0.0.1:61006/");
  assert.equal(list.status, 200);
  assert.match(await list.text(), /ListAllMyBucketsResult/);

  const status = await docker([
    "exec", container, "node", "runtime/bin/worldfixture.mjs", "status", "--state", "/state", "--verbose",
  ]);
  for (const service of ["emulate", "http-targets", "mail", "s3"]) {
    assert.match(status.stdout, new RegExp(`^${service}\\s+ready`, "m"));
  }
  assert.match(status.stdout, /emulate\/aws stays shut/);

  await docker([
    "exec", container, "node", "-e",
    "fetch('http://127.0.0.1:4711/').then(()=>process.exit(1),e=>process.exit(e.cause?.code==='ECONNREFUSED'?0:2))",
  ]);

  const environment = await docker([
    "exec", container, "node", "runtime/bin/worldfixture.mjs", "env", "--state", "/state",
  ]);
  for (const name of [
    "APPLE", "CLERK", "GITHUB", "GOOGLE", "LINEAR", "MICROSOFT", "MONGOATLAS",
    "OKTA", "RESEND", "SLACK", "STRIPE", "TWILIO", "VERCEL",
  ]) {
    assert.match(environment.stdout, new RegExp(`^export ${name}_BASE_URL=`, "m"), name);
    assert.match(environment.stdout, new RegExp(`^export ${name}_TOKEN=`, "m"), name);
  }
  assert.match(environment.stdout, /^export GOOGLE_TOKEN='demo_token'$/m);
  assert.ok(!environment.stdout.includes("could not be resolved"));

  // Keep exact protocol results from the accepted start. Reset must restore
  // these bytes, not only remove the one mutation this test knows about.
  const initialSlack = await docker([
    "exec", container, "node", "runtime/bin/worldfixture.mjs", "slack", "history",
    "--as", "jon", "--channel", "release-3-2", "--state", "/state",
  ]);
  const initialInbox = await docker([
    "exec", container, "node", "runtime/bin/worldfixture.mjs", "mail", "inbox",
    "--as", "jon", "--state", "/state",
  ]);
  // The page that changes between requests is the one the world gave
  // `request_variants`. Reading it from the artifact keeps this gate working
  // when the world changes which page that is.
  const targets = JSON.parse(readFileSync(join(ROOT, "dist/business.saas-company.v3/projections/http-targets.json"), "utf8"));
  const changing = targets.pages.find((page) => page.request_variants?.length);
  assert.ok(changing, "the world declares no page with request variants");
  const changingUrl = `http://127.0.0.1:8080${changing.path}`;
  const initialPage = await fetch(changingUrl).then((response) => response.text());
  const initialJwks = await fetch("http://127.0.0.1:4705/oauth2/v3/certs").then((response) => response.text());
  const objectUrl = "http://127.0.0.1:61006/northstar-relay-documents/?list-type=2";
  const initialObjects = await fetch(objectUrl).then((response) => response.text());

  const sent = await docker([
    "exec", container, "node", "runtime/bin/worldfixture.mjs", "slack", "send",
    "--as", "maya", "--channel", "release-3-2", "--state", "/state", "Image gate passed",
  ]);
  assert.match(sent.stdout, /rule-slack-channel-notification → Local Mail to jon@/);
  const changedPage = await fetch(changingUrl).then((response) => response.text());
  assert.notEqual(changedPage, initialPage);
  const put = await fetch(
    "http://127.0.0.1:61006/northstar-relay-documents/reset-mutation.txt",
    { method: "PUT", body: "reset removes this object\n" },
  );
  assert.ok(put.ok, `S3 mutation failed with ${put.status}`);
  assert.notEqual(await fetch(objectUrl).then((response) => response.text()), initialObjects);

  const reset = await docker([
    "exec", container, "node", "runtime/bin/worldfixture.mjs", "reset", "--state", "/state",
  ], { timeout: 180_000 });
  assert.match(reset.stdout, /World restored exactly across 4 services/);

  const restoredSlack = await docker([
    "exec", container, "node", "runtime/bin/worldfixture.mjs", "slack", "history",
    "--as", "jon", "--channel", "release-3-2", "--state", "/state",
  ]);
  assert.equal(restoredSlack.stdout, initialSlack.stdout);
  const restoredInbox = await docker([
    "exec", container, "node", "runtime/bin/worldfixture.mjs", "mail", "inbox",
    "--as", "jon", "--state", "/state",
  ]);
  assert.equal(restoredInbox.stdout, initialInbox.stdout);
  assert.equal(
    await fetch(changingUrl).then((response) => response.text()),
    initialPage,
  );
  assert.equal(
    await fetch("http://127.0.0.1:4705/oauth2/v3/certs").then((response) => response.text()),
    initialJwks,
  );
  assert.equal(await fetch(objectUrl).then((response) => response.text()), initialObjects);
  const restoredSeed = await docker([
    "exec", container, "curl", "-fsS", "http://127.0.0.1:61004/worldfixture/ready",
  ]);
  // Reset restores the accepted seed, so the counts are the world's counts again
  // -- read from the artifact for the same reason as the first check.
  assert.deepEqual(JSON.parse(restoredSeed.stdout), {
    source: "worldfixture-s3",
    ready: true,
    buckets: aws.s3.buckets.length,
    objects: aws.s3.objects.length,
  });
  const restoredEvents = await docker([
    "exec", container, "node", "runtime/bin/worldfixture.mjs", "events", "--state", "/state",
  ]);
  assert.match(restoredEvents.stdout, /No events yet/);

  // The connected rule remains active after restore.
  const sentAfterReset = await docker([
    "exec", container, "node", "runtime/bin/worldfixture.mjs", "slack", "send",
    "--as", "maya", "--channel", "release-3-2", "--state", "/state", "Image gate passed after reset",
  ]);
  assert.match(sentAfterReset.stdout, /rule-slack-channel-notification → Local Mail to jon@/);
  const inboxAfterReset = await docker([
    "exec", container, "node", "runtime/bin/worldfixture.mjs", "mail", "inbox",
    "--as", "jon", "--state", "/state",
  ]);
  assert.match(inboxAfterReset.stdout, /\[#release-3-2\] Maya Chen posted/);

  const second = await docker([
    "run", "--rm", "--network", `container:${container}`, "--entrypoint", "node", image,
    "-e",
    "Promise.all([fetch('http://127.0.0.1:4703/api/auth.test',{method:'POST'}).then(r=>r.json()),fetch('http://127.0.0.1:61006/northstar-relay-documents/?list-type=2').then(r=>r.text())]).then(([slack,s3])=>{if(slack.error!=='not_authed'||!s3.includes('documents/doc-lumen-renewal.md'))process.exit(1)})",
  ]);
  assert.equal(second.stderr, "");

  const top = await docker(["top", container, "-eo", "pid,ppid,comm,args"]);
  for (const process of ["tini", "node", "master", "weed", "smtp-server.pl"]) {
    assert.match(top.stdout, new RegExp(process));
  }
  assert.ok(!top.stdout.includes("docker run"), "the supervisor started Docker inside the image");
} finally {
  await stop();
}

const left = await docker(["ps", "-a", "--filter", `name=^/${container}$`, "--format", "{{.Names}}"]).catch(
  () => ({ stdout: "" }),
);
assert.equal(left.stdout.trim(), "", "the stopped WorldFixture container remains");
await Promise.all(ports.map(refuses));

console.log("one-container image checks passed: protocols, exact reset, connected flow, and clean stop");
