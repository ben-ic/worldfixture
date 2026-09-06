import assert from "node:assert/strict";
import {mkdtempSync, mkdirSync, copyFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {spawn} from "node:child_process";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

// THIS TEST BOOTS ITS OWN SERVER. It used to require someone else to have started
// one -- `docker exec` into a running container -- which made it a connected image
// check and nothing a checkout could run. It now starts `server.mjs` itself on a
// loopback port and stops it again, so the same file is both the image check and
// the test a developer runs. Set TEST_ORIGIN to point it at a server that is
// already running instead; that is the old behaviour, unchanged.
const here = dirname(fileURLToPath(import.meta.url));

// The port range this repository is allowed to use. A port outside it is a bug in
// the caller, not something to quietly accept.
const port = Number(process.env.TEST_PORT ?? 4971);
assert.ok(Number.isInteger(port) && port >= 4970 && port <= 4979,
  `TEST_PORT must be in 4970-4979, got ${process.env.TEST_PORT}`);

// The home page must print links a browser OUTSIDE the session can follow, so the
// checks below refuse a loopback href. The server only prints a public origin if
// it is given one, so the test gives it a synthetic, unroutable one -- the
// requests still go to loopback.
const publicOrigin = process.env.WORLDFIXTURE_HTTP_TARGETS_PUBLIC_URL ??
  process.env.TEST_ORIGIN ??
  "http://http-targets.session.worldfixture.test";

const fixtureRoot = mkdtempSync(join(tmpdir(), "worldfixture-http-protocol-"));
mkdirSync(join(fixtureRoot, "projections"));
copyFileSync(join(here, "self-test.json"), join(fixtureRoot, "projections/http-targets.json"));
let child = null;
let stderr = "";
let stdout = "";

async function startServer() {
  const environment = {...process.env};
  // A world path would replace the protocol fixture with a session projection and
  // every assertion below names the fixture's own data.
  environment.WORLDFIXTURE_WORLD_PATH = fixtureRoot;
  environment.WORLDFIXTURE_HTTP_TARGETS_LISTEN = `127.0.0.1:${port}`;
  environment.WORLDFIXTURE_HTTP_TARGETS_PUBLIC_URL = `${publicOrigin}/`;

  child = spawn(process.execPath, [join(here, "..", "server.mjs")], {
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => {stdout += chunk;});
  child.stderr.on("data", (chunk) => {stderr += chunk;});

  // A SERVER THAT NEVER GOT THE PORT LOOKS EXACTLY LIKE A SERVER THAT IS UP, if
  // something stale is already listening on it. So readiness is not "a request
  // succeeded": the child has to still be running when it does. `server.mjs`
  // installs no listen error handler, so EADDRINUSE exits it, and this races the
  // exit against the probe and reports whichever happens first.
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({code, signal})));
  const deadline = Date.now() + 10_000;
  for (;;) {
    const finished = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve(null), 100))]);
    if (finished) {
      throw new Error(
        `server exited before it was ready (code ${finished.code}, signal ${finished.signal})\n${stderr}${stdout}`,
      );
    }
    try {
      const probe = await fetch(`http://127.0.0.1:${port}/readyz`);
      if (probe.ok) {
        // Read the body, not just the status: a stale listener from another
        // fixture can answer 200 at this path with something else entirely.
        const body = await probe.json();
        assert.equal(body.ready, true, `unexpected /readyz body: ${JSON.stringify(body)}`);
        assert.equal(body.source, "verified-world",
          `something other than this protocol fixture is listening on ${port}: ${JSON.stringify(body)}`);
        assert.equal(body.world_id, "build.self-test");
        return `http://127.0.0.1:${port}`;
      }
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      throw new Error(`server did not become ready on port ${port} within 10s\n${stderr}${stdout}`);
    }
  }
}

async function stopServer() {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const stopped = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve("timeout"), 5000))]);
  if (stopped === "timeout") child.kill("SIGKILL");
}

const origin = process.env.TEST_ORIGIN ?? await startServer();

async function response(path, options) {
  return fetch(`${origin}${path}`, options);
}

try {
  let result = await response("/readyz");
  assert.equal(result.status, 200);
  assert.equal((await result.json()).ready, true);

  result = await response("/");
  assert.equal(result.status, 200);
  const home = await result.text();
  // The lead sentence is the contract of this page: a visitor lands here from
  // their own session and has to be told what they are looking at before anything
  // else. The made-up site's own copy stays, below the explanation.
  assert.match(home, /This is test data used by the app you launched\./);
  assert.match(home, /Go back to the application tab/);
  assert.match(home, /World-backed HTTP targets/);
  // EVERY LINK IS A PUBLIC SESSION URL. A browser reading this page is not in the
  // µVM, so a printed loopback address is a dead end -- the same defect the
  // app-facing bindings had, one step further downstream.
  for (const path of [
    "/health/api",
    "/health/export-worker",
    "/health/webhook-delivery",
    "/feeds/",
    "/feeds/company.xml",
    "/notes/lumen-export",
    "/openapi.json",
  ]) {
    assert.match(home, new RegExp(`href="${publicOrigin}${path.replaceAll("/", "\\/")}"`),
      `home page is missing a public link to ${path}`);
  }
  assert.doesNotMatch(home, /href="http:\/\/127\.0\.0\.1/);
  assert.doesNotMatch(home, /href="http:\/\/localhost/);

  result = await response("/feeds/");
  assert.equal(result.status, 200);
  const preview = await result.text();
  assert.match(preview, /Test story/);
  assert.match(preview, /This is the news feed the app reads/);

  result = await response("/feeds/company.xml");
  assert.equal(result.status, 200);
  assert.match(result.headers.get("content-type"), /application\/rss\+xml/);
  assert.equal(result.headers.get("access-control-allow-origin"), "*");
  const feed = await result.text();
  assert.match(feed, /<guid isPermaLink="false">test-item<\/guid>/);
  assert.match(feed, new RegExp(`${publicOrigin}/notes/lumen-export`));
  // What the scheduled arrival does at each second is test/feed-clock.test.mjs,
  // which drives the same code with a fixed clock. Asserting here that the
  // 10-second item has not arrived yet would make this file fail whenever the run
  // took longer than ten seconds, which is a clock the test does not control.

  result = await response("/notes/lumen-export");
  const firstPage = await result.text();
  assert.match(firstPage, /First observation/);
  assert.match(firstPage, /This is a page from the made-up company website/);
  result = await response("/notes/lumen-export");
  assert.match(await result.text(), /Second observation/);

  for (const wanted of [200, 200, 503, 200, 200]) {
    result = await response("/health/webhook-delivery");
    assert.equal(result.status, wanted);
  }

  result = await response("/health/export-worker");
  assert.equal(result.status, 503);
  const failedProbe = await result.text();
  assert.match(failedProbe, /Status: unavailable/);
  assert.match(failedProbe, /degraded/);

  result = await response("/metrics");
  assert.equal(result.status, 200);
  assert.match(await result.text(), /northstar_test_value 7/);

  result = await response("/openapi.json");
  assert.equal(result.status, 200);
  const openapi = await result.json();
  assert.equal(openapi.openapi, "3.0.3");
  assert.equal(openapi.servers[0].url, publicOrigin);

  result = await response("/api/v1/company");
  assert.equal((await result.json()).name, "Northstar Test");

  result = await response("/missing");
  assert.equal(result.status, 404);
  result = await response("/", {method: "POST"});
  assert.equal(result.status, 405);

  console.log("HTTP target protocol checks passed");
} finally {
  await stopServer();
  rmSync(fixtureRoot, {recursive: true, force: true});
}
