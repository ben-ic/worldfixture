import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { gatewayPathsForBindings, gatewayRoute, gatewayRoutes } from "./gateway.mjs";
import { startWorkbench } from "./workbench.mjs";

function instance(ports, addresses = {}) {
  return {
    lock: { services: [{ name: "emulate", ports: ports.map(name => ({ name, protocol: "http" })) }] },
    addressOf: (service, port) => addresses[`${service}/${port}`] ?? { host: "127.0.0.1", port: 4000 },
    state: { prepare: () => ({ get: () => ({ seq: 0 }) }) },
    credentials: { values: {} },
    applicationBindings: {},
    readiness: new Map(), serviceStates: new Map(),
  };
}

test("gateway routes come only from selected HTTP services", () => {
  const selected = instance(["slack", "google"]);
  assert.deepEqual(gatewayRoutes(selected).map(route => route.path).sort(), ["/calendar", "/drive", "/gmail", "/google", "/slack"]);
  assert.equal(gatewayRoute(selected, "/slack/api/conversations.list").route.surface, "slack");
  assert.equal(gatewayRoute(selected, "/gmail/v1/users/me/messages").route.preserve, true);
  assert.deepEqual(gatewayRoute(selected, "/stripe/v1/customers"), { state: "not-selected", path: "/stripe" });
  assert.equal(gatewayRoute(selected, "/api/overview"), null);
});

test("printed paths follow the bindings and include friendly aliases", () => {
  assert.deepEqual(gatewayPathsForBindings({ GOOGLE_BASE_URL: "http://google.test", RESEND_BASE_URL: "http://email.test" }),
    ["/calendar", "/drive", "/email", "/gmail", "/google", "/resend"]);
});

test("the Workbench gateway forwards methods, bodies, queries, and streamed responses", async t => {
  const seen = {};
  const provider = createServer(async (request, response) => {
    seen.method = request.method; seen.url = request.url; seen.body = "";
    for await (const chunk of request) seen.body += chunk;
    response.writeHead(201, { "content-type": "text/plain", "x-provider": "slack" });
    response.write("first-"); response.end("second");
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => provider.close(resolve)));
  const active = instance(["slack"], { "emulate/slack": { host: "127.0.0.1", port: provider.address().port } });
  const workbench = await startWorkbench(active, { artifactPath: process.cwd(), stateDir: process.cwd() });
  t.after(() => workbench.close());

  const response = await fetch(`${workbench.url}/slack/api/chat.postMessage?pretty=1`, { method: "POST", body: "hello" });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("x-provider"), "slack");
  assert.equal(await response.text(), "first-second");
  assert.deepEqual(seen, { method: "POST", url: "/api/chat.postMessage?pretty=1", body: "hello" });

  const missing = await fetch(`${workbench.url}/stripe/v1/customers`);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).code, "gateway_route_unavailable");
});
