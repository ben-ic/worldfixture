import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createServer } from "@emulators/core";

import { plugin, seedFromConfig } from "./index.mjs";
import { notionMcpTools, toolsForClient } from "./hosted-contract.mjs";
import { NOTION_VERSION } from "./rest.mjs";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_USER_ID = "00000000-0000-4000-8000-000000000002";
const PAGE_ID = "10000000-0000-4000-8000-000000000001";
const PRIVATE_PAGE_ID = "10000000-0000-4000-8000-000000000002";
const DATABASE_ID = "30000000-0000-4000-8000-000000000001";
const DATA_SOURCE_ID = "40000000-0000-4000-8000-000000000001";
const VIEW_ID = "50000000-0000-4000-8000-000000000001";
const MEETING_NOTE_ID = "c0000000-0000-4000-8000-000000000001";

function fixture() {
  const server = createServer(plugin, {
    baseUrl: "http://notion.worldfixture.test",
    tokens: { notion_rest_token: { login: "maya@northstar-relay.worldfixture.test", id: 1, scopes: ["read:user", "read:content", "write:content"] } },
  });
  seedFromConfig(server.store, server.baseUrl, {
    workspace: { name: "Northstar Relay" },
    users: [
      { id: USER_ID, name: "Maya Chen", email: "maya@northstar-relay.worldfixture.test" },
      { id: OTHER_USER_ID, name: "Theo Martins", email: "theo@northstar-relay.worldfixture.test" },
    ],
    teamspaces: [
      { id: "60000000-0000-4000-8000-000000000001", name: "Product", member_ids: [USER_ID] },
      { id: "60000000-0000-4000-8000-000000000002", name: "Engineering", member_ids: [OTHER_USER_ID] },
    ],
    databases: [{ id: DATABASE_ID, title: "Projects", accessible_by: [USER_ID, OTHER_USER_ID] }],
    data_sources: [{ id: DATA_SOURCE_ID, database_id: DATABASE_ID, name: "Projects", properties: { Name: { type: "title" }, Status: { type: "status" } }, templates: [{ id: "template-1", name: "Project" }], accessible_by: [USER_ID, OTHER_USER_ID] }],
    views: [{ id: VIEW_ID, database_id: DATABASE_ID, data_source_id: DATA_SOURCE_ID, name: "Active projects", type: "table", sorts: [{ property: "Target", direction: "ascending" }], accessible_by: [USER_ID, OTHER_USER_ID] }],
    pages: [
      { id: PAGE_ID, title: "Release 2.8 plan", created_by: USER_ID, accessible_by: [USER_ID, OTHER_USER_ID], teamspace_id: "60000000-0000-4000-8000-000000000001", verification: { state: "verified", expires_at: null }, children: [{ type: "paragraph", text: "Track the release risks and owners." }] },
      { id: PRIVATE_PAGE_ID, title: "Theo private notes", created_by: OTHER_USER_ID, accessible_by: [OTHER_USER_ID], children: [{ type: "paragraph", text: "Private onboarding draft." }] },
    ],
    meeting_notes: [{ id: MEETING_NOTE_ID, parent: { type: "page_id", page_id: PAGE_ID }, title: "Release review", created_by: USER_ID, calendar_event: { start_time: "2026-09-03T08:00:00Z", end_time: "2026-09-03T08:30:00Z", attendees: [USER_ID] } }],
  });
  return server;
}

function restHeaders(token = "notion_rest_token") {
  return { Authorization: `Bearer ${token}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" };
}

async function body(response) {
  return response.json();
}

test("current REST reads use the seeded Notion workspace", async () => {
  const { app } = fixture();

  const users = await app.request("/v1/users", { headers: restHeaders() });
  assert.equal(users.status, 200);
  assert.deepEqual((await body(users)).results.map((user) => user.name), ["Maya Chen", "Theo Martins"]);

  const search = await app.request("/v1/search", {
    method: "POST",
    headers: restHeaders(),
    body: JSON.stringify({ query: "release" }),
  });
  assert.equal(search.status, 200);
  const result = await body(search);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].properties.title.title[0].plain_text, "Release 2.8 plan");

  const page = await app.request(`/v1/pages/${result.results[0].id}`, { headers: restHeaders() });
  assert.equal(page.status, 200);
  assert.equal((await body(page)).id, result.results[0].id);

  const children = await app.request(`/v1/blocks/${result.results[0].id}/children`, { headers: restHeaders() });
  assert.equal(children.status, 200);
  assert.equal((await body(children)).results[0].paragraph.rich_text[0].plain_text, "Track the release risks and owners.");
});

test("REST rejects missing versions and unknown tokens with Notion errors", async () => {
  const { app } = fixture();
  const missingVersion = await app.request("/v1/users", { headers: { Authorization: "Bearer notion_rest_token" } });
  assert.equal(missingVersion.status, 400);
  assert.equal((await body(missingVersion)).code, "validation_error");

  const unknown = await app.request("/v1/users", { headers: restHeaders("unknown") });
  assert.equal(unknown.status, 401);
  assert.equal((await body(unknown)).code, "unauthorized");
});

async function authorizeMcp(app, userId = USER_ID) {
  const registration = await app.request("/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_name: "Contract client", redirect_uris: ["http://client.worldfixture.test/callback"], token_endpoint_auth_method: "none" }),
  });
  assert.equal(registration.status, 201);
  const client = await body(registration);
  const verifier = "worldfixture-notion-pkce-verifier-000000000000000000";
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const request = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: client.redirect_uris[0],
    state: "state-123",
    scope: "default",
    resource: "http://notion.worldfixture.test/mcp",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const consentPage = await app.request(`/authorize?${request}`);
  assert.equal(consentPage.status, 200);
  assert.match(await consentPage.text(), /select name="user_id"/);

  const form = new URLSearchParams({
    ...Object.fromEntries(request),
    user_id: userId,
    decision: "approve",
  });
  const consent = await app.request("/authorize", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  assert.equal(consent.status, 302);
  const callback = new URL(consent.headers.get("location"));
  assert.equal(callback.searchParams.get("state"), "state-123");

  const token = await app.request("/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.client_id,
      redirect_uri: client.redirect_uris[0],
      code: callback.searchParams.get("code"),
      code_verifier: verifier,
      resource: "http://notion.worldfixture.test/mcp",
    }),
  });
  assert.equal(token.status, 200);
  return { ...(await body(token)), client_id: client.client_id };
}

test("OAuth discovery, PKCE, refresh, and MCP token audience work", async () => {
  const { app } = fixture();
  for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp", "/mcp/.well-known/oauth-protected-resource"]) {
    const response = await app.request(path);
    assert.equal(response.status, 200, path);
    const protectedResource = await body(response);
    assert.equal(protectedResource.resource, "http://notion.worldfixture.test/mcp");
    assert.deepEqual(protectedResource.authorization_servers, ["http://notion.worldfixture.test"]);
    assert.deepEqual(protectedResource.scopes_supported, ["default"]);
  }
  const authorizationServer = await body(await app.request("/.well-known/oauth-authorization-server"));
  assert.equal(authorizationServer.token_endpoint, "http://notion.worldfixture.test/token");
  assert.deepEqual(authorizationServer.code_challenge_methods_supported, ["S256"]);
  assert.equal(Object.hasOwn(authorizationServer, "client_id_metadata_document_supported"), false);
  const mcpMetadata = await body(await app.request("/.well-known/mcp.json"));
  assert.equal(mcpMetadata.endpoint, "http://notion.worldfixture.test/mcp");
  assert.equal(Object.hasOwn(mcpMetadata, "transport"), false);

  const token = await authorizeMcp(app);
  assert.equal(token.token_type, "Bearer");
  assert.equal(typeof token.access_token, "string");
  assert.equal(typeof token.refresh_token, "string");
  assert.equal(token.expires_in, 8 * 60 * 60);
  assert.equal(token.scope, "default");
  assert.equal(token.user_id, USER_ID);
  assert.equal(token.workspace_id, "worldfixture-notion-workspace");
  assert.equal(token.email_domain, "northstar-relay.worldfixture.test");

  const rest = await app.request("/v1/users/me", { headers: restHeaders(token.access_token) });
  assert.equal(rest.status, 401);
  assert.match((await body(rest)).message, /only for Notion MCP/);

  const refreshed = await app.request("/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token.refresh_token, client_id: token.client_id, resource: "http://notion.worldfixture.test/mcp" }),
  });
  assert.equal(refreshed.status, 200);
  const rotated = await body(refreshed);
  assert.equal(rotated.token_type, "Bearer");
  assert.equal(rotated.expires_in, 8 * 60 * 60);
  assert.equal(rotated.scope, "default");
  assert.equal(typeof rotated.access_token, "string");
  assert.notEqual(rotated.refresh_token, token.refresh_token);
  assert.equal(Object.hasOwn(rotated, "user_id"), false);
  assert.equal(Object.hasOwn(rotated, "workspace_id"), false);
  assert.equal(Object.hasOwn(rotated, "email_domain"), false);

  const reusedRefresh = await app.request("/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token.refresh_token, client_id: token.client_id, resource: "http://notion.worldfixture.test/mcp" }),
  });
  assert.equal(reusedRefresh.status, 400);
  assert.equal((await body(reusedRefresh)).error, "invalid_grant");

  const oldToken = await app.request("/mcp", {
    method: "POST",
    headers: { Authorization: `Bearer ${token.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  });
  assert.equal(oldToken.status, 401);

  const revoked = await app.request("/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: rotated.access_token }),
  });
  assert.equal(revoked.status, 200);
  const revokedMcp = await app.request("/mcp", {
    method: "POST",
    headers: { Authorization: `Bearer ${rotated.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  });
  assert.equal(revokedMcp.status, 401);

  return rotated.access_token;
});

async function initializeMcp(app, accessToken, clientName = "Claude Code") {
  const headers = { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  const response = await app.request("/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: clientName, version: "1" } } }),
  });
  assert.equal(response.status, 200);
  assert.equal((await body(response.clone())).result.protocolVersion, "2025-11-25");
  return { ...headers, "MCP-Session-Id": response.headers.get("mcp-session-id"), "MCP-Protocol-Version": "2025-11-25" };
}

async function mcpCall(app, headers, id, name, args) {
  return body(await app.request("/mcp", {
    method: "POST", headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
  }));
}

test("MCP advertises and runs the current read tools for Claude", async () => {
  const { app } = fixture();
  const token = await authorizeMcp(app);
  const headers = await initializeMcp(app, token.access_token);

  const list = await app.request("/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  });
  const listed = (await body(list)).result.tools;
  assert.deepEqual(listed.map((tool) => tool.name), notionMcpTools.map((tool) => tool.name));
  assert.equal(listed.every((tool) => tool.inputSchema.type === "object"), true);

  const self = JSON.parse((await mcpCall(app, headers, 3, "notion-fetch", { id: "self" })).result.content[0].text).self;
  assert.equal(self.workspace.name, "Northstar Relay");
  assert.equal(self.user.id, USER_ID);
  assert.deepEqual(
    self.current_tool_access,
    Object.fromEntries(notionMcpTools.map((tool) => [tool.name.replace(/^notion-/, "").replaceAll("-", "_"), { status: "available" }])),
  );

  const search = JSON.parse((await mcpCall(app, headers, 4, "notion-search", { query: "risks", content_search_mode: "workspace_search", page_size: 50 })).result.content[0].text);
  assert.equal(search.type, "workspace_search");
  assert.deepEqual(search.results.map((result) => result.id), [PAGE_ID]);
  assert.equal(search.results[0].verification.state, "verified");

  const fetched = JSON.parse((await mcpCall(app, headers, 5, "notion-fetch", { id: `https://www.notion.so/Release-${PAGE_ID.replaceAll("-", "")}` })).result.content[0].text);
  assert.equal(fetched.metadata.type, "page");
  assert.match(fetched.text, /Track the release risks/);
  assert.equal(fetched.is_archived, false);

  const database = JSON.parse((await mcpCall(app, headers, 6, "notion-fetch", { id: DATABASE_ID })).result.content[0].text);
  assert.equal(database.metadata.type, "database");
  assert.equal(database.data_sources[0].url, `collection://${DATA_SOURCE_ID}`);
  const dataSource = JSON.parse((await mcpCall(app, headers, 7, "notion-fetch", { id: `collection://${DATA_SOURCE_ID}` })).result.content[0].text);
  assert.equal(dataSource.templates[0].name, "Project");
  const view = JSON.parse((await mcpCall(app, headers, 8, "notion-fetch", { id: `view://${VIEW_ID}` })).result.content[0].text);
  assert.equal(view.metadata.type, "view");

  const meetingNotes = JSON.parse((await mcpCall(app, headers, 9, "notion-query-meeting-notes", { limit: 10 })).result.content[0].text);
  assert.deepEqual(meetingNotes.results.map((block) => block.id), [MEETING_NOTE_ID]);

  const teams = JSON.parse((await mcpCall(app, headers, 10, "notion-get-teams", { query: "Product" })).result.content[0].text);
  assert.deepEqual(teams.teams.map((team) => [team.name, team.membership]), [["Product", "member"]]);
  const users = JSON.parse((await mcpCall(app, headers, 11, "notion-get-users", { query: "Theo" })).result.content[0].text);
  assert.deepEqual(users.users.map((user) => user.id), [OTHER_USER_ID]);
  const converted = JSON.parse((await mcpCall(app, headers, 13, "notion-convert-page-to-skill", { page_url: PAGE_ID })).result.content[0].text);
  assert.equal(converted.skill.page_id, PAGE_ID);
  const skills = JSON.parse((await mcpCall(app, headers, 14, "notion-search-skills", { query: "release" })).result.content[0].text);
  assert.deepEqual(skills.skills.map((skill) => skill.page_id), [PAGE_ID]);

  const invalid = await mcpCall(app, headers, 15, "notion-search", { query: "release", page_size: 51 });
  assert.equal(invalid.error.code, -32602);

  const unauthenticatedDelete = await app.request("/mcp", { method: "DELETE" });
  assert.equal(unauthenticatedDelete.status, 401);
  assert.match(unauthenticatedDelete.headers.get("www-authenticate"), /oauth-protected-resource/);
});

test("MCP keeps the captured hosted names for OpenAI clients and enforces content access", async () => {
  const { app } = fixture();
  const maya = await authorizeMcp(app);
  const mayaHeaders = await initializeMcp(app, maya.access_token, "Codex");
  const list = await body(await app.request("/mcp", { method: "POST", headers: mayaHeaders, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) }));
  assert.deepEqual(list.result.tools.map((tool) => tool.name), toolsForClient("Codex").map((tool) => tool.name));

  const hiddenSearch = JSON.parse((await mcpCall(app, mayaHeaders, 3, "notion-search", { query: "private" })).result.content[0].text);
  assert.deepEqual(hiddenSearch.results, []);
  const hiddenFetch = await mcpCall(app, mayaHeaders, 4, "notion-fetch", { id: PRIVATE_PAGE_ID });
  assert.equal(hiddenFetch.result.isError, true);
  assert.equal(JSON.parse(hiddenFetch.result.content[0].text).code, "object_not_found");

  const theo = await authorizeMcp(app, OTHER_USER_ID);
  const theoHeaders = await initializeMcp(app, theo.access_token);
  const visible = JSON.parse((await mcpCall(app, theoHeaders, 5, "notion-search", { query: "private" })).result.content[0].text);
  assert.deepEqual(visible.results.map((result) => result.id), [PRIVATE_PAGE_ID]);
});

test("MCP validates Streamable HTTP media types and bearer discovery", async () => {
  const { app } = fixture();
  const unauthenticated = await app.request("/mcp", { method: "POST" });
  assert.equal(unauthenticated.status, 401);
  assert.equal(
    unauthenticated.headers.get("www-authenticate"),
    'Bearer resource_metadata="http://notion.worldfixture.test/.well-known/oauth-protected-resource/mcp", scope="default"',
  );

  const token = await authorizeMcp(app);
  const authorization = { Authorization: `Bearer ${token.access_token}` };
  const invalidContentType = await app.request("/mcp", {
    method: "POST",
    headers: { ...authorization, "Content-Type": "text/plain", Accept: "application/json, text/event-stream" },
    body: "{}",
  });
  assert.equal(invalidContentType.status, 415);

  const invalidAccept = await app.request("/mcp", {
    method: "POST",
    headers: { ...authorization, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  });
  assert.equal(invalidAccept.status, 406);
});

test("MCP negotiates versions and treats session IDs as optional opaque hints", async () => {
  const { app } = fixture();
  const token = await authorizeMcp(app);
  const baseHeaders = { Authorization: `Bearer ${token.access_token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  const initialized = await app.request("/mcp", {
    method: "POST",
    headers: baseHeaders,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "old", version: "1" } } }),
  });
  assert.equal(initialized.status, 200);
  assert.equal((await body(initialized.clone())).result.protocolVersion, "2025-11-25");
  assert.match(initialized.headers.get("mcp-session-id"), /^[0-9a-f-]{36}$/);

  for (const sessionId of [null, "unknown-opaque-session-id"]) {
    const response = await app.request("/mcp", {
      method: "POST",
      headers: { ...baseHeaders, "MCP-Protocol-Version": "2025-11-25", ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    assert.equal(response.status, 200);
    assert.equal(Array.isArray((await body(response)).result.tools), true);
  }

  const unsupported = await app.request("/mcp", {
    method: "POST",
    headers: { ...baseHeaders, "MCP-Protocol-Version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" }),
  });
  assert.equal(unsupported.status, 400);

  for (const sessionId of [null, "unknown-opaque-session-id"]) {
    const response = await app.request("/mcp", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token.access_token}`, ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}) },
    });
    assert.equal(response.status, 204);
  }
});

test("MCP OAuth requires PKCE S256 and form token exchange", async () => {
  const { app } = fixture();
  const registration = await body(await app.request("/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_name: "Protocol checks", redirect_uris: ["http://client.worldfixture.test/callback"], token_endpoint_auth_method: "none" }),
  }));
  assert.equal(typeof registration.client_id, "string");

  const rejectedPkce = await app.request(`/authorize?${new URLSearchParams({
    client_id: registration.client_id,
    redirect_uri: registration.redirect_uris[0],
    resource: "http://notion.worldfixture.test/mcp",
    code_challenge: "plain-verifier",
    code_challenge_method: "plain",
  })}`);
  assert.equal(rejectedPkce.status, 400);
  assert.equal((await body(rejectedPkce)).error, "invalid_request");

  const rejectedMediaType = await app.request("/token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ grant_type: "authorization_code" }),
  });
  assert.equal(rejectedMediaType.status, 415);
  assert.equal((await body(rejectedMediaType)).error, "invalid_request");
});

test("MCP enforces the documented search rate limit and records calls", async () => {
  const { app, store } = fixture();
  const token = await authorizeMcp(app);
  const headers = await initializeMcp(app, token.access_token);
  store.setData(`notion_mcp_rate_${USER_ID}`, Array.from({ length: 30 }, () => ({ at: Date.now(), tool: "notion-search" })));
  const limited = await mcpCall(app, headers, 2, "notion-search", { query: "release" });
  assert.equal(limited.result.isError, true);
  assert.equal(JSON.parse(limited.result.content[0].text).code, "rate_limited");

  const observed = await body(await app.request("/__worldfixture/mcp-observability", { headers: { Authorization: "Bearer notion_rest_token" } }));
  assert.equal(observed.sessions.length, 1);
  assert.equal(observed.calls.length, 1);
  assert.equal(observed.calls[0].is_error, true);
});

test("REST applies capabilities and current response fields", async () => {
  const { app } = fixture();
  const user = await app.request(`/v1/users/${USER_ID}`, { headers: restHeaders() });
  assert.equal(user.status, 200);
  assert.equal((await body(user)).id, USER_ID);

  const search = await app.request("/v1/search", { method: "POST", headers: restHeaders(), body: JSON.stringify({ query: "release" }) });
  const pageId = (await body(search)).results[0].id;
  const page = await body(await app.request(`/v1/pages/${pageId}`, { headers: restHeaders() }));
  assert.equal(Object.hasOwn(page, "archived"), false);
  const block = await body(await app.request(`/v1/blocks/${pageId}/children`, { headers: restHeaders() }));
  assert.equal(Object.hasOwn(block.results[0], "archived"), false);

  const limited = createServer(plugin, {
    baseUrl: "http://notion.worldfixture.test",
    tokens: { limited: { login: "maya@northstar-relay.worldfixture.test", id: 1, scopes: ["read:content"] } },
  });
  seedFromConfig(limited.store, limited.baseUrl, {
    workspace: { name: "Northstar Relay" },
    users: [{ id: USER_ID, name: "Maya Chen", email: "maya@northstar-relay.worldfixture.test" }],
  });
  const denied = await limited.app.request("/v1/users", { headers: restHeaders("limited") });
  assert.equal(denied.status, 403);
  assert.equal((await body(denied)).code, "restricted_resource");
});

test("expired MCP access tokens remain outside the REST token audience", async () => {
  const { app, store } = fixture();
  const token = await authorizeMcp(app);
  const grants = store.collection("notion_oauth_tokens", ["token", "refresh_token"]);
  const grant = grants.findOneBy("token", token.access_token);
  grants.update(grant.id, { expires_at: 1 });

  const rest = await app.request("/v1/users/me", { headers: restHeaders(token.access_token) });
  assert.equal(rest.status, 401);
  assert.match((await body(rest)).message, /only for Notion MCP/);
});

test("OAuth rejects unsupported client authentication methods", async () => {
  const { app } = fixture();
  const registration = await app.request("/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["http://client.worldfixture.test/callback"], token_endpoint_auth_method: "private_key_jwt" }),
  });
  assert.equal(registration.status, 400);
  assert.equal((await body(registration)).error, "invalid_client_metadata");
});
