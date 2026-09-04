// The composer, started the way a session starts it.
//
// Everything else here is a unit test, and for good reason — but the thing this file
// checks cannot be reached from one. Whether an unknown bearer token becomes somebody
// is decided by `@emulators/core`'s auth middleware, from what `startComposed` hands
// `createServer`, and the only honest way to ask is to start the process and knock.
//
// It is also the one test that reads a world artifact end to end: manifest, digest
// check, overlay, token map, listener.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN = join(HERE, "main.mjs");
const CWD = dirname(HERE);

const OVERLAY = {
  slack: {
    team: { name: "Northstar Relay", domain: "northstar-relay" },
    users: [
      { name: "mayac", real_name: "Maya Chen", email: "maya@example.test" },
      { name: "jonbell", real_name: "Jon Bell", email: "jon@example.test" },
    ],
    channels: [{ name: "general" }],
  },
  tokens: {
    slack_token: { login: "mayac", scopes: [] },
    "slack_token_jon-bell": { login: "jonbell", scopes: [] },
  },
};

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function writeWorld() {
  const world = mkdtempSync(join(tmpdir(), "worldfixture-composer-"));
  mkdirSync(join(world, "projections"), { recursive: true });

  const body = JSON.stringify(OVERLAY);
  writeFileSync(join(world, "projections", "emulator-overlay.json"), body);
  writeFileSync(
    join(world, "manifest.json"),
    JSON.stringify({
      api_version: "worldfixture.world-artifact/v1",
      files: {
        "projections/emulator-overlay.json": {
          sha256: createHash("sha256").update(body).digest("hex"),
          size: Buffer.byteLength(body),
        },
      },
    }),
  );

  return world;
}

// Start the composer and wait for the line it prints once the listener is up. Rejects
// on an early exit or on EADDRINUSE rather than letting the test probe a stale port
// and believe whatever answers.
async function startComposer(port, world) {
  const child = spawn(process.execPath, [MAIN], {
    cwd: CWD,
    env: {
      ...process.env,
      WORLDFIXTURE_WORLD_PATH: world,
      WORLDFIXTURE_PORT_SLACK: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";

  const ready = new Promise((resolve, reject) => {
    const onData = (chunk) => {
      output += chunk;
      if (/EADDRINUSE/.test(output)) reject(new Error(`port ${port} was already in use:\n${output}`));
      if (output.includes(`listening on 127.0.0.1:${port}`)) resolve();
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => reject(new Error(`composer exited early (${code}):\n${output}`)));
    setTimeout(() => reject(new Error(`composer never listened on ${port}:\n${output}`)), 15_000).unref();
  });

  await ready;

  return {
    child,
    output: () => output,
    async authTest(headers) {
      const res = await fetch(`http://127.0.0.1:${port}/api/auth.test`, { method: "POST", headers });
      return res.json();
    },
    stop() {
      return new Promise((resolve) => {
        child.on("exit", resolve);
        child.kill("SIGKILL");
      });
    },
  };
}

test("an unknown bearer token does not become the workspace default", async (t) => {
  const port = await freePort();
  const composer = await startComposer(port, writeWorld());
  t.after(() => composer.stop());

  // The world's own tokens still resolve the people the world says they are.
  assert.partialDeepStrictEqual(await composer.authTest({ Authorization: "Bearer slack_token" }), {
    ok: true,
    user: "mayac",
  });
  assert.partialDeepStrictEqual(
    await composer.authTest({ Authorization: "Bearer slack_token_jon-bell" }),
    { ok: true, user: "jonbell" },
  );

  // A person the world does not grant a token to. This used to answer
  // `ok:true, user:"admin", user_id:"U000000001"` — the upstream default identity —
  // because `fallbackUser` resolved every unrecognized token to it.
  //
  // It now resolves to nobody, so Slack answers with its own `not_authed` — the same
  // answer it gives a caller that presented nothing. That is the whole available
  // distinction: core's middleware either sets an identity or does not, and refusing
  // to invent one is what makes the vendor say no.
  const unknown = await composer.authTest({ Authorization: "Bearer slack_token_priya-raman" });
  assert.equal(unknown.ok, false, `an unknown token authenticated: ${JSON.stringify(unknown)}`);
  assert.equal(unknown.error, "not_authed");
  assert.equal(unknown.user, undefined);
  assert.equal(unknown.user_id, undefined);

  // A request with NO Authorization header is a different case and keeps its old
  // answer: core's middleware never consulted the fallback for it either.
  assert.partialDeepStrictEqual(await composer.authTest({}), { ok: false, error: "not_authed" });
});

test("the composer refuses a world whose overlay does not match its manifest", async () => {
  const world = writeWorld();
  writeFileSync(
    join(world, "projections", "emulator-overlay.json"),
    JSON.stringify({ ...OVERLAY, tokens: { slack_token: { login: "somebody-else", scopes: [] } } }),
  );

  const port = await freePort();
  const failure = await startComposer(port, world).then(
    (composer) => composer.stop().then(() => "started anyway"),
    (err) => err.message,
  );

  assert.match(failure, /composer exited early \(1\)/);
  assert.match(failure, /does not match/);
  assert.match(failure, /manifest\.json/);
});
