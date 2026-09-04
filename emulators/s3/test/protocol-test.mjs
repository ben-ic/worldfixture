import assert from "node:assert/strict";
import {createHash, createHmac} from "node:crypto";
import {execFileSync, spawnSync} from "node:child_process";
import {mkdtempSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

// THIS TEST BOOTS ITS OWN SERVICE, the way emulators/http-targets does. The S3
// implementation is a binary in an image, so "boots its own" means it builds the
// artifact, starts the container, waits for it, and removes it again -- not
// `docker exec` into something somebody else started. A container this test did
// not start is the one thing it refuses to talk to.
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");

// The port range this repository is allowed to use. A port outside it is a bug in
// the caller, not something to quietly accept.
const s3Port = Number(process.env.TEST_S3_PORT ?? 4990);
const filerPort = Number(process.env.TEST_FILER_PORT ?? 4991);
for (const [name, port] of [["TEST_S3_PORT", s3Port], ["TEST_FILER_PORT", filerPort]]) {
  assert.ok(Number.isInteger(port) && port >= 4990 && port <= 4999,
    `${name} must be in 4990-4999, got ${port}`);
}
assert.notEqual(s3Port, filerPort, "the S3 and filer ports must differ");

const image = process.env.WORLDFIXTURE_S3_IMAGE ?? "worldfixture-s3:test";
const container = process.env.TEST_CONTAINER_NAME ?? `worldfixture-s3-protocol-${process.pid}`;
const s3 = `http://127.0.0.1:${s3Port}`;
const filer = `http://127.0.0.1:${filerPort}`;

const region = "eu-west-2";
const accessKeyId = process.env.AWS_ACCESS_KEY_ID ?? "worldfixture-test-key";
const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY ?? "worldfixture-test-secret";

// ---------------------------------------------------------------- SigV4

function hmac(key, value) {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

function sha256Hex(value) {
  return createHash("sha256").update(value ?? "").digest("hex");
}

/** A real AWS Signature Version 4 header, computed here rather than by an SDK. */
function sign({method, path, query = "", body = ""}) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body);
  const host = `127.0.0.1:${s3Port}`;
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [
    method,
    path,
    query,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), region), "s3"), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");
  return {
    "x-amz-date": amzDate,
    "x-amz-content-sha256": payloadHash,
    Authorization:
      `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/** Every request in the happy path is properly signed, so "it worked" is not
 *  ambiguous about which signing path was exercised. */
async function signed(method, path, {query = "", body, contentType} = {}) {
  const headers = sign({method, path, query, body: body ?? ""});
  if (contentType) headers["Content-Type"] = contentType;
  return fetch(`${s3}${path}${query ? `?${query}` : ""}`, {method, headers, body});
}

// ---------------------------------------------------------------- artifact

let artifact = process.env.WORLDFIXTURE_ARTIFACT ?? null;
let artifactIsTemporary = false;
if (!artifact) {
  artifact = mkdtempSync(join(tmpdir(), "worldfixture-s3-artifact-"));
  artifactIsTemporary = true;
  execFileSync(
    process.env.PYTHON ?? "python3",
    ["-m", "worldfixture_compiler", "build", "worlds/business.saas-company.v2/world.json", "--output", artifact],
    {cwd: root, env: {...process.env, PYTHONPATH: "compiler"}, stdio: "pipe"},
  );
}

const projection = JSON.parse(readFileSync(join(artifact, "projections", "aws.json"), "utf8"));
const buckets = projection.s3.buckets;
const objects = projection.s3.objects ?? [];
// A comparison against an empty set passes for the wrong reason. The world under
// test has to actually declare something before any assertion below means anything.
assert.ok(buckets.length > 0, "the projection declares no buckets");
assert.ok(objects.length > 0, "the projection declares no objects");
for (const object of objects) {
  assert.ok(object.content.length > 0, `object ${object.key} has empty content`);
}
const documentsBucket = buckets[0].name;
const exportsBucket = buckets[1].name;

// ---------------------------------------------------------------- lifecycle

function docker(args, {check = true} = {}) {
  const result = spawnSync("docker", args, {encoding: "utf8"});
  if (check && result.status !== 0) {
    throw new Error(`docker ${args.join(" ")} failed (${result.status})\n${result.stderr}${result.stdout}`);
  }
  return result;
}

let containerId = null;

async function nothingIsListening(url) {
  try {
    await fetch(url, {signal: AbortSignal.timeout(1500)});
    return false;
  } catch {
    return true;
  }
}

async function startContainer() {
  // A STALE LISTENER ON THE PORT LOOKS EXACTLY LIKE A HEALTHY SERVICE. Two wrong
  // conclusions in this extraction came from one, so this refuses to start at all
  // if the ports are not free, and refuses to trust readiness it did not cause.
  for (const url of [`${s3}/`, `${filer}/healthz`]) {
    assert.ok(await nothingIsListening(url), `something is already listening on ${url}`);
  }
  docker(["rm", "-f", container], {check: false});
  docker([
    "run", "-d", "--name", container, "--platform=linux/amd64",
    "-v", `${artifact}:/world:ro`,
    "-e", "WORLDFIXTURE_WORLD_PATH=/world",
    "-p", `127.0.0.1:${s3Port}:61006`,
    "-p", `127.0.0.1:${filerPort}:61004`,
    image,
  ]);
  containerId = docker(["inspect", "-f", "{{.Id}}", container]).stdout.trim();
  assert.match(containerId, /^[0-9a-f]{64}$/, "did not get a container id back");

  const deadline = Date.now() + 180_000;
  for (;;) {
    // The container has to still be the one running when readiness answers.
    const running = docker(["inspect", "-f", "{{.State.Running}}", containerId], {check: false});
    if (running.stdout.trim() !== "true") {
      throw new Error(`container exited before it was ready\n${docker(["logs", containerId], {check: false}).stderr}`);
    }
    try {
      const probe = await fetch(`${filer}/worldfixture/ready`, {signal: AbortSignal.timeout(2000)});
      if (probe.ok) {
        // Read the body, not just the status. This document exists only after the
        // seed finished, and it names the fixture and its counts, so a different
        // service answering 200 here fails loudly instead of being tested.
        const body = await probe.json();
        assert.equal(body.source, "worldfixture-s3",
          `something other than this fixture is listening on ${filerPort}: ${JSON.stringify(body)}`);
        assert.equal(body.ready, true);
        assert.equal(body.buckets, buckets.length, "readiness disagrees with the projection's bucket count");
        assert.equal(body.objects, objects.length, "readiness disagrees with the projection's object count");
        return;
      }
    } catch {
      // Not seeded yet.
    }
    if (Date.now() > deadline) {
      throw new Error(`container did not seed within 180s\n${docker(["logs", containerId], {check: false}).stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function stopContainer() {
  if (containerId) docker(["rm", "-f", containerId], {check: false});
  if (artifactIsTemporary) rmSync(artifact, {recursive: true, force: true});
}

// ---------------------------------------------------------------- checks

// Inside the try, not before it: a container that starts and never seeds is
// exactly the case worth cleaning up, and it is the case that leaks if the
// lifecycle straddles the block.
try {
  await startContainer();

  // 1. Every declared bucket exists.
  for (const bucket of buckets) {
    const head = await signed("HEAD", `/${bucket.name}`);
    assert.equal(head.status, 200, `bucket ${bucket.name} is missing`);
  }
  const missing = await signed("HEAD", "/no-such-bucket-in-this-world");
  assert.equal(missing.status, 404, "a bucket the world never declared answered as if it existed");

  // ListBuckets is scoped to the caller's identity, and this build has none, so it
  // answers with an empty bucket list even though the buckets are there and every
  // other operation on them works. Asserted rather than skipped: it is the shape
  // of the limitation, and a build that starts answering properly should say so.
  const listBuckets = await signed("GET", "/");
  assert.equal(listBuckets.status, 200);
  const bucketXml = await listBuckets.text();
  assert.ok(bucketXml.length > 0);
  assert.match(bucketXml, /<Buckets><\/Buckets>/,
    "ListBuckets returned buckets; the identity limitation this test records has changed");

  // 2. Every seeded object lists and fetches with the world's own bytes.
  const list = await signed("GET", `/${documentsBucket}`, {query: "list-type=2"});
  assert.equal(list.status, 200);
  const listing = await list.text();
  assert.ok(listing.length > 0);
  for (const object of objects) {
    assert.ok(listing.includes(`<Key>${object.key}</Key>`), `${object.key} is not listed`);
    const size = Buffer.byteLength(object.content, "utf8");
    assert.ok(listing.includes(`<Size>${size}</Size>`), `${object.key} lists the wrong size`);
  }

  for (const object of objects) {
    const got = await signed("GET", `/${object.bucket}/${object.key}`);
    assert.equal(got.status, 200, `${object.key} is not fetchable`);
    const bytes = Buffer.from(await got.arrayBuffer());
    const expected = Buffer.from(object.content, "utf8");
    assert.ok(expected.length > 0);
    assert.equal(bytes.length, expected.length, `${object.key} has the wrong length`);
    assert.ok(bytes.equals(expected), `${object.key} does not carry the world's bytes`);
    assert.equal(got.headers.get("content-type"), object.content_type);
    assert.equal(got.headers.get("etag"), `"${createHash("md5").update(expected).digest("hex")}"`);
    // The world's own timestamp, carried as user metadata. SeaweedFS stamps
    // Last-Modified from its own clock and offers no way to set it, so the
    // authored time lives here instead. See README.md.
    assert.equal(got.headers.get("x-amz-meta-last-modified"), object.last_modified);
    assert.equal(got.headers.get("x-amz-meta-owner"), object.owner);
  }

  // 3. The exports bucket is empty, because no world record declares anything in
  //    it. The work pack's `task-cancel-cleanup` says a cancelled export leaves a
  //    partial object there; the world data does not declare that object, and the
  //    compiler does not invent it. If a world record ever declares one, this
  //    assertion is the thing that has to change.
  const declaredInExports = objects.filter((object) => object.bucket === exportsBucket);
  assert.equal(declaredInExports.length, 0);
  const exportsList = await signed("GET", `/${exportsBucket}`, {query: "list-type=2"});
  assert.equal(exportsList.status, 200);
  const exportsXml = await exportsList.text();
  assert.ok(exportsXml.length > 0);
  assert.match(exportsXml, /<KeyCount>0<\/KeyCount>/, "the exports bucket is not empty");

  // 4. Put, get and delete round-trip over the real API.
  const roundTripKey = "round-trip/protocol-test.txt";
  const roundTripBody = "worldfixture protocol test\n";
  const put = await signed("PUT", `/${exportsBucket}/${roundTripKey}`, {
    body: roundTripBody,
    contentType: "text/plain",
  });
  assert.equal(put.status, 200);
  const readBack = await signed("GET", `/${exportsBucket}/${roundTripKey}`);
  assert.equal(readBack.status, 200);
  assert.equal(await readBack.text(), roundTripBody);
  assert.equal(readBack.headers.get("content-type"), "text/plain");
  const afterPut = await signed("GET", `/${exportsBucket}`, {query: "list-type=2"});
  assert.match(await afterPut.text(), /<KeyCount>1<\/KeyCount>/);
  const removed = await signed("DELETE", `/${exportsBucket}/${roundTripKey}`);
  assert.equal(removed.status, 204);
  const gone = await signed("GET", `/${exportsBucket}/${roundTripKey}`);
  assert.equal(gone.status, 404);
  const afterDelete = await signed("GET", `/${exportsBucket}`, {query: "list-type=2"});
  assert.match(await afterDelete.text(), /<KeyCount>0<\/KeyCount>/);

  // 5. WHAT THE SIGNATURE ACTUALLY BUYS, asserted rather than assumed.
  //
  //    This build runs `-s3.iam=false` with no identity file, which leaves the S3
  //    endpoint with no identity at all. A correctly signed request works, and so
  //    does every other kind. These assertions exist so the limitation is a
  //    measured, failing-if-it-changes fact instead of a sentence in a README.
  const object = objects[0];
  const url = `${s3}/${object.bucket}/${object.key}`;

  const unsigned = await fetch(url);
  assert.equal(unsigned.status, 200, "an unsigned request was refused; the auth story has changed");

  const tampered = await fetch(url, {
    headers: {
      ...sign({method: "GET", path: `/${object.bucket}/${object.key}`}),
      Authorization:
        `AWS4-HMAC-SHA256 Credential=${accessKeyId}/20260101/${region}/s3/aws4_request, ` +
        "SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=" + "f".repeat(64),
    },
  });
  assert.equal(tampered.status, 200, "a forged signature was refused; the auth story has changed");

  const presigned = await fetch(
    `${url}?X-Amz-Algorithm=AWS4-HMAC-SHA256` +
    `&X-Amz-Credential=${encodeURIComponent(`${accessKeyId}/20200101/${region}/s3/aws4_request`)}` +
    "&X-Amz-Date=20200101T000000Z&X-Amz-Expires=1&X-Amz-SignedHeaders=host&X-Amz-Signature=" + "f".repeat(64),
  );
  assert.equal(presigned.status, 200,
    "an expired, forged presigned URL was refused; the auth story has changed");

  console.log(
    `S3 protocol checks passed: ${buckets.length} buckets, ${objects.length} seeded objects, ` +
    "put/get/delete round-trip, and no signature enforcement (see README.md)",
  );
} finally {
  stopContainer();
}
