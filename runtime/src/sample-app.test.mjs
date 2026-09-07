import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { askForSampleApp, askToOpenBrowser, connectSampleApp, sampleAppAvailable, sampleAppPath } from "./sample-app.mjs";

function terminal(answer) {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  output.isTTY = true;
  setImmediate(() => input.end(`${answer}\n`));
  return { input, output };
}

test("Enter accepts browser offers and n skips them", async () => {
  assert.equal(await askForSampleApp(terminal("")), true);
  assert.equal(await askForSampleApp(terminal("n")), false);
  assert.equal(await askToOpenBrowser("Workbench", terminal("")), true);
  assert.equal(await askToOpenBrowser("Workbench", terminal("no")), false);
});

test("the sample app is offered only when every packaged runtime file exists", () => {
  const root = mkdtempSync(join(tmpdir(), "worldfixture-sample-app-"));
  try {
    assert.equal(sampleAppPath(root), join(root, "examples/demo_app"));
    assert.equal(sampleAppAvailable(root), false);
    const app = sampleAppPath(root);
    for (const file of ["package.json", "package-lock.json", "src/server/main.mjs", "dist/index.html"]) {
      mkdirSync(join(app, file, ".."), { recursive: true });
      writeFileSync(join(app, file), "{}");
    }
    assert.equal(sampleAppAvailable(root), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the sample app connector uses the current Workbench generation", async (context) => {
  let received;
  const server = createServer((request, response) => {
    if (request.url === "/api/session") {
      response.writeHead(200, { "content-type": "application/json", "x-worldfixture-generation": "generation-1" });
      response.end(JSON.stringify({ generation: "generation-1" }));
      return;
    }
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      received = { method: request.method, generation: request.headers["x-worldfixture-generation"], body: JSON.parse(Buffer.concat(chunks)) };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ connected: true }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const workbench = `http://127.0.0.1:${server.address().port}`;
  await connectSampleApp(workbench, "http://127.0.0.1:5175");
  assert.deepEqual(received, {
    method: "POST",
    generation: "generation-1",
    body: { applicationUrl: "http://127.0.0.1:5175" },
  });
});

test("the default world declares each Account Desk OAuth callback", () => {
  const artifact = JSON.parse(readFileSync(new URL("../../dist/business.saas-company.v3/world.json", import.meta.url), "utf8"));
  const clients = artifact.software.oauth_clients;
  for (const provider of ["slack", "github", "google", "microsoft", "apple"]) {
    const declared = clients[provider];
    assert.equal(declared.length, 1, `${provider} must have one default client`);
    assert.equal(declared[0].client_id, "worldfixture-local");
    assert.ok(declared[0].loopback_redirect_uris.includes(`http://127.0.0.1/oauth/${provider}/callback`));
    assert.ok(declared[0].redirect_uris.includes("https://oauth.pstmn.io/v1/browser-callback"));
  }
});
