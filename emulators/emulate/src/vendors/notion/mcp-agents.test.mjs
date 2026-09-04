import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createServer } from "@emulators/core";

import { notionMcpTools } from "./hosted-contract.mjs";
import { plugin, seedFromConfig } from "./index.mjs";
import { NOTION_VERSION } from "./rest.mjs";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const AGENT_ID = "25b0d34e-a3c7-4f97-82f8-92377c9ac327";
const AGENT_TOOLS = [
  "notion-search-agents", "notion-query-sessions", "notion-search-sessions",
  "notion-spawn-session", "notion-get-session-status", "notion-wait-session", "notion-stop-session",
  "notion-send-message-to-session", "notion-list-session-events", "notion-read-session-event",
];

function fixture() {
  const server = createServer(plugin, {
    baseUrl: "http://notion.worldfixture.test",
    tokens: { inspector: { login: "maya@example.test", id: 1, scopes: ["read:user", "read:content", "interact:agents"] } },
  });
  seedFromConfig(server.store, server.baseUrl, {
    workspace: { name: "Agent MCP fixture" },
    users: [{ id: USER_ID, name: "Maya Chen", email: "maya@example.test" }],
    agents: [{
      id: AGENT_ID, name: "Release planner", description: "Prepare a safe release brief.", instructions: "Use verified release evidence.",
      created_by: USER_ID, accessible_by: [USER_ID], editable_by: [USER_ID], default_response: "The verified release brief is ready.",
    }],
  });
  return server;
}

async function json(response) { return response.json(); }

async function initialize(app) {
  const registration = await json(await app.request("/register", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Agent MCP tests", redirect_uris: ["http://client.example.test/callback"], token_endpoint_auth_method: "none" }),
  }));
  const verifier = "worldfixture-notion-agent-mcp-verifier-000000000000";
  const request = {
    client_id: registration.client_id, redirect_uri: registration.redirect_uris[0], state: "agents", scope: "default",
    resource: "http://notion.worldfixture.test/mcp", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
  };
  const consent = await app.request("/authorize", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...request, user_id: USER_ID, decision: "approve" }) });
  const code = new URL(consent.headers.get("location")).searchParams.get("code");
  const token = await json(await app.request("/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: registration.client_id, redirect_uri: registration.redirect_uris[0], code, code_verifier: verifier, resource: request.resource }),
  }));
  const headers = { Authorization: `Bearer ${token.access_token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  const initialized = await app.request("/mcp", {
    method: "POST", headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "Claude Code", version: "1" } } }),
  });
  return { ...headers, "MCP-Session-Id": initialized.headers.get("mcp-session-id"), "MCP-Protocol-Version": "2025-11-25" };
}

async function rpc(app, headers, id, method, params) {
  return json(await app.request("/mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) }));
}

async function call(app, headers, id, name, args) {
  const response = await rpc(app, headers, id, "tools/call", { name, arguments: args });
  assert.equal(response.error, undefined, response.error?.message);
  assert.equal(response.result?.isError, undefined, response.result?.content?.[0]?.text);
  return JSON.parse(response.result.content[0].text);
}

test("the current Custom Agent session tools are declared and listed", async () => {
  assert.deepEqual(notionMcpTools.filter((tool) => AGENT_TOOLS.includes(tool.name)).map((tool) => tool.name), AGENT_TOOLS.toSorted());
  const { app } = fixture();
  const headers = await initialize(app);
  const listed = await rpc(app, headers, 2, "tools/list", {});
  assert.deepEqual(listed.result.tools.filter((tool) => AGENT_TOOLS.includes(tool.name)).map((tool) => tool.name), AGENT_TOOLS.toSorted());
  assert.equal(listed.result.tools.find((tool) => tool.name === "notion-stop-session").annotations.destructiveHint, true);
});

test("Custom Agent tools use the same agents, sessions, and events as the REST surface", async () => {
  const { app, store } = fixture();
  const headers = await initialize(app);
  const currentUser = await call(app, headers, 9, "notion-get-users", { user_id: "self", page_size: 20 });
  assert.equal(currentUser.users[0].id, USER_ID);
  assert.equal(currentUser.users[0].is_current_user, true);
  const found = await call(app, headers, 11, "notion-search-agents", { scope: "workspace", query: "release", limit: 20 });
  assert.equal(found.results[0].id, AGENT_ID);

  const spawned = await call(app, headers, 12, "notion-spawn-session", { agent_url: found.results[0].url, initial_message: "Prepare the release brief." });
  const sessionId = spawned.session.id;
  const sessionUrl = spawned.session.url;
  assert.equal(spawned.session.status, "in_progress");
  assert.equal((await call(app, headers, 13, "notion-get-session-status", { session_url: sessionUrl })).session.status, "in_progress");

  const initialEvents = await call(app, headers, 14, "notion-list-session-events", { session_url: sessionUrl, count: 100 });
  assert.deepEqual(initialEvents.results.map((event) => event.type), ["user.message", "session.status"]);
  const firstEvent = await call(app, headers, 15, "notion-read-session-event", { session_url: sessionUrl, sequence: initialEvents.results[0].sequence });
  assert.equal(firstEvent.content[0].text, "Prepare the release brief.");

  const waited = await call(app, headers, 16, "notion-wait-session", { session_url: sessionUrl, seconds: 1 });
  assert.equal(waited.session.status, "completed");
  const queried = await call(app, headers, 17, "notion-query-sessions", { query: "release", sorts: [{ property: "created_at", direction: "descending" }] });
  assert.equal(queried.results[0].id, sessionId);
  const searched = await call(app, headers, 18, "notion-search-sessions", { question: "verified release brief" });
  assert.equal(searched.results[0].id, sessionId);

  const continued = await call(app, headers, 19, "notion-send-message-to-session", { session_url: sessionUrl, message: "Add the test evidence." });
  assert.equal(continued.session.status, "in_progress");
  const stopped = await call(app, headers, 20, "notion-stop-session", { session_url: sessionUrl });
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.session.status, "canceled");

  const restSession = await json(await app.request(`/v1/sessions/${sessionId}`, { headers: { Authorization: "Bearer inspector", "Notion-Version": NOTION_VERSION } }));
  assert.equal(restSession.status, "canceled");

  assert.equal(store.collection("notion_agent_sessions", ["notion_id", "agent_id", "created_by", "status"]).findOneBy("notion_id", sessionId).status, "canceled");
  assert.ok(store.collection("notion_agent_session_events", ["notion_id", "session_id", "sequence", "type"]).findBy("session_id", sessionId).length >= 6);
});

test("agent session schemas reject invalid identifiers and pagination before dispatch", async () => {
  const { app } = fixture();
  const headers = await initialize(app);
  const missingMessage = await rpc(app, headers, 30, "tools/call", { name: "notion-spawn-session", arguments: { agent_url: AGENT_ID } });
  assert.equal(missingMessage.error.code, -32602);
  assert.match(missingMessage.error.message, /initial_message is required/);
  const tooMany = await rpc(app, headers, 31, "tools/call", { name: "notion-list-session-events", arguments: { session_url: "session", count: 101 } });
  assert.equal(tooMany.error.code, -32602);
  assert.match(tooMany.error.message, /at most 100/);
});
