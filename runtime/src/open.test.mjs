// `worldfixture open`.
//
// The browser launcher is injected in every test here, so none of these opens a
// window. That is not only politeness to whoever runs the suite: a test that
// shells out to `open(1)` is testing macOS, and what needs testing is that the
// command finds the right instance, reads the URL that instance actually
// recorded, refuses to open a Workbench that is not answering, and says
// something useful when it refuses.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { OPENERS, OpenError, TESTED_PLATFORMS, openWorkbench } from "./open.mjs";

const scratch = [];
after(() => scratch.forEach((path) => rmSync(path, { recursive: true, force: true })));

function stateDir(bindings) {
  const path = mkdtempSync(join(tmpdir(), "worldfixture-open-"));
  scratch.push(path);
  if (bindings) writeFileSync(join(path, "host-bindings.json"), JSON.stringify(bindings));
  return path;
}

const live = async () => ({ container_id: "c".repeat(64), container_name: "worldfixture-test" });
const dead = async () => null;
const answering = async () => new Response(JSON.stringify({ ready: true }), { status: 200 });

function recorder() {
  const opened = [];
  const launch = async (url) => opened.push(url);
  launch.opened = opened;
  return launch;
}

test("it opens the URL this instance recorded, not a fixed port", async () => {
  // A fallback host port, which is the whole reason this command exists. 4715 is
  // the preferred Workbench port and 8080 is the HTTP target site; hard-coding
  // either would be wrong, and 8080 would open a different service entirely.
  const state = stateDir({ WORKBENCH_URL: "http://127.0.0.1:53817", SITE_BASE_URL: "http://127.0.0.1:8080" });
  const launch = recorder();
  const asked = [];

  const result = await openWorkbench({
    stateDir: state,
    platform: "darwin",
    launch,
    inspect: live,
    fetchImpl: async (url) => {
      asked.push(url);
      return answering();
    },
  });

  assert.deepEqual(launch.opened, ["http://127.0.0.1:53817"]);
  assert.equal(result.url, "http://127.0.0.1:53817");
  assert.equal(result.tested, true);
  assert.deepEqual(asked, ["http://127.0.0.1:53817/readyz"], "the Workbench is asked before a window opens");
});

test("no running instance is refused before anything is opened", async () => {
  const launch = recorder();
  const error = await openWorkbench({
    stateDir: stateDir({ WORKBENCH_URL: "http://127.0.0.1:4715" }),
    platform: "darwin",
    launch,
    inspect: dead,
    fetchImpl: async () => {
      throw new Error("the Workbench must not be asked when no instance is running");
    },
  }).catch((caught) => caught);

  assert.ok(error instanceof OpenError);
  assert.equal(error.code, "no_instance");
  assert.match(error.message, /no instance is running/);
  assert.match(error.repair, /worldfixture up/);
  assert.deepEqual(launch.opened, []);
});

test("an instance that recorded no Workbench says the Workbench is optional", async () => {
  const launch = recorder();
  const error = await openWorkbench({
    stateDir: stateDir({ SLACK_BASE_URL: "http://127.0.0.1:4703" }),
    platform: "darwin",
    launch,
    inspect: live,
    fetchImpl: async () => answering(),
  }).catch((caught) => caught);

  assert.equal(error.code, "no_workbench");
  assert.match(error.message, /recorded no Workbench address/);
  assert.match(error.repair, /worldfixture status --verbose/);
  assert.deepEqual(launch.opened, []);
});

test("a Workbench that does not answer is named, and no browser opens on a dead port", async () => {
  const launch = recorder();
  const error = await openWorkbench({
    stateDir: stateDir({ WORKBENCH_URL: "http://127.0.0.1:4715" }),
    platform: "darwin",
    launch,
    inspect: live,
    fetchImpl: async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:4715");
    },
  }).catch((caught) => caught);

  assert.equal(error.code, "workbench_unreachable");
  assert.match(error.message, /the Workbench at http:\/\/127\.0\.0\.1:4715 did not answer/);
  assert.match(error.message, /ECONNREFUSED/);
  assert.match(error.repair, /worldfixture status/);

  // The point of asking first: a browser pointed at a dead port shows the user
  // a connection error with nothing to say whose it is.
  assert.deepEqual(launch.opened, []);
});

test("a Workbench answering an error status is refused too", async () => {
  const launch = recorder();
  const error = await openWorkbench({
    stateDir: stateDir({ WORKBENCH_URL: "http://127.0.0.1:4715" }),
    platform: "darwin",
    launch,
    inspect: live,
    fetchImpl: async () => new Response("Workbench UI is not built.", { status: 503 }),
  }).catch((caught) => caught);

  assert.equal(error.code, "workbench_unreachable");
  assert.match(error.message, /answered 503/);
  assert.deepEqual(launch.opened, []);
});

test("macOS is the tested platform; the others are wired and reported as untested", async () => {
  assert.deepEqual(TESTED_PLATFORMS, ["darwin"]);
  assert.deepEqual(OPENERS.darwin("http://x"), ["open", ["http://x"]]);
  assert.deepEqual(OPENERS.linux("http://x"), ["xdg-open", ["http://x"]]);
  assert.deepEqual(OPENERS.win32("http://x"), ["cmd", ["/c", "start", "", "http://x"]]);

  const state = stateDir({ WORKBENCH_URL: "http://127.0.0.1:4715" });
  const launch = recorder();
  const result = await openWorkbench({
    stateDir: state,
    platform: "linux",
    launch,
    inspect: live,
    fetchImpl: async () => answering(),
  });

  // It still opens. It just does not claim the platform was tested.
  assert.deepEqual(launch.opened, ["http://127.0.0.1:4715"]);
  assert.equal(result.tested, false);
  assert.equal(result.platform, "linux");
});

test("a trailing slash in the recorded URL does not produce a double slash", async () => {
  const asked = [];
  await openWorkbench({
    stateDir: stateDir({ WORKBENCH_URL: "http://127.0.0.1:4715/" }),
    platform: "darwin",
    launch: recorder(),
    inspect: live,
    fetchImpl: async (url) => {
      asked.push(url);
      return answering();
    },
  });

  assert.deepEqual(asked, ["http://127.0.0.1:4715/readyz"]);
});
