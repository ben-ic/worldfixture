import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createServer } from "@emulators/core";

import { notionMcpTools } from "./hosted-contract.mjs";
import { plugin, seedFromConfig } from "./index.mjs";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const ROOT_ID = "10000000-0000-4000-8000-000000000101";

function fixture() {
  const server = createServer(plugin, {
    baseUrl: "http://notion.worldfixture.test",
    tokens: { inspector: { login: "maya@example.test", id: 1, scopes: ["read:user", "read:content", "write:content"] } },
  });
  seedFromConfig(server.store, server.baseUrl, {
    workspace: { name: "MCP write fixture" },
    users: [{ id: USER_ID, name: "Maya Chen", email: "maya@example.test" }],
    pages: [{ id: ROOT_ID, title: "Workspace root", created_by: USER_ID, accessible_by: [USER_ID] }],
  });
  return server;
}

async function json(response) { return response.json(); }

async function authorize(app) {
  const registration = await json(await app.request("/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "MCP write tests", redirect_uris: ["http://client.example.test/callback"], token_endpoint_auth_method: "none" }),
  }));
  const verifier = "worldfixture-notion-write-test-verifier-000000000000";
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const request = {
    client_id: registration.client_id,
    redirect_uri: registration.redirect_uris[0],
    state: "write-test",
    scope: "default",
    resource: "http://notion.worldfixture.test/mcp",
    code_challenge: challenge,
    code_challenge_method: "S256",
  };
  const consent = await app.request("/authorize", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...request, user_id: USER_ID, decision: "approve" }),
  });
  const code = new URL(consent.headers.get("location")).searchParams.get("code");
  const token = await json(await app.request("/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: registration.client_id, redirect_uri: registration.redirect_uris[0], code, code_verifier: verifier, resource: request.resource }),
  }));
  return token.access_token;
}

async function initialize(app, token) {
  const base = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  const response = await app.request("/mcp", {
    method: "POST",
    headers: base,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "Claude Code", version: "1" } } }),
  });
  assert.equal(response.status, 200);
  return { ...base, "MCP-Session-Id": response.headers.get("mcp-session-id"), "MCP-Protocol-Version": "2025-11-25" };
}

async function call(app, headers, id, name, args) {
  const response = await json(await app.request("/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
  }));
  return response.result;
}

function resultValue(result) {
  assert.equal(result?.isError, undefined, result?.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
}

function firstValueForKey(value, keys) {
  if (!value || typeof value !== "object") return null;
  for (const key of keys) if (typeof value[key] === "string") return value[key];
  for (const child of Object.values(value)) {
    const found = Array.isArray(child)
      ? child.map((item) => firstValueForKey(item, keys)).find(Boolean)
      : firstValueForKey(child, keys);
    if (found) return found;
  }
  return null;
}

test("the current write and query slice is advertised with useful annotations", () => {
  const expected = [
    "notion-create-pages", "notion-update-page", "notion-move-pages", "notion-duplicate-page",
    "notion-create-database", "notion-create-folder", "notion-update-data-source", "notion-create-view",
    "notion-update-view", "notion-query-data-sources", "notion-get-async-task",
  ];
  assert.deepEqual(notionMcpTools.map((tool) => tool.name).filter((name) => expected.includes(name)), expected.toSorted());
  assert.equal(notionMcpTools.find((tool) => tool.name === "notion-query-data-sources").annotations.readOnlyHint, true);
  assert.equal(notionMcpTools.find((tool) => tool.name === "notion-update-page").annotations.destructiveHint, true);
  assert.match(notionMcpTools.find((tool) => tool.name === "notion-create-pages").description, /Notion-flavored Markdown/);
});

test("page write tools mutate fetchable state and expose async tasks", async () => {
  const { app } = fixture();
  const headers = await initialize(app, await authorize(app));

  const created = resultValue(await call(app, headers, 2, "notion-create-pages", {
    parent: { page_id: ROOT_ID },
    pages: [{ properties: { title: "Launch brief" }, content: "Ship safely." }],
  }));
  const pageId = firstValueForKey(created, ["page_id", "id"]);
  assert.ok(pageId);

  resultValue(await call(app, headers, 3, "notion-update-page", {
    page_id: pageId,
    command: "update_properties",
    properties: { title: "Launch brief revised" },
  }));
  resultValue(await call(app, headers, 4, "notion-move-pages", { page_or_database_ids: [pageId], new_parent: { page_id: ROOT_ID } }));

  const duplicated = resultValue(await call(app, headers, 5, "notion-duplicate-page", { page_id: pageId }));
  const taskId = duplicated.async_task?.id;
  assert.ok(taskId);
  const task = resultValue(await call(app, headers, 6, "notion-get-async-task", { task_id: taskId }));
  assert.ok(["queued", "running", "retrying", "succeeded", "failed"].includes(task.status));

  const asyncUpdate = resultValue(await call(app, headers, 61, "notion-update-page", {
    page_id: pageId,
    command: "update_properties",
    properties: { title: "Async revised brief" },
    allow_async: true,
  }));
  assert.ok(asyncUpdate.async_task?.id);

  const asyncCreate = resultValue(await call(app, headers, 7, "notion-create-pages", {
    creation_mode: "draft",
    pages: [{ properties: { title: "Async draft" }, content: "Draft body" }],
    allow_async: true,
  }));
  assert.ok(asyncCreate.async_task?.id);
});

test("database, data-source, view, folder, and query tools share domain state", async () => {
  const { app, store } = fixture();
  const headers = await initialize(app, await authorize(app));

  const database = resultValue(await call(app, headers, 10, "notion-create-database", {
    parent: { page_id: ROOT_ID },
    title: "Release work",
    schema: "CREATE TABLE (\"Name\" TITLE, \"Status\" STATUS)",
  }));
  const dataSourceId = database.data_source?.id ?? firstValueForKey(database, ["data_source_id"]);
  assert.ok(dataSourceId);

  resultValue(await call(app, headers, 11, "notion-update-data-source", {
    data_source_id: dataSourceId,
    title: "Release work items",
    description: "Tracked by the MCP write test",
  }));
  const view = resultValue(await call(app, headers, 12, "notion-create-view", {
    data_source_id: dataSourceId,
    name: "Open work",
    type: "table",
    configure: "SORT \"Name\" ASC",
  }));
  const viewId = firstValueForKey(view, ["view_id", "id"]);
  assert.ok(viewId);
  resultValue(await call(app, headers, 13, "notion-update-view", { view_id: viewId, name: "Current work", configure: "" }));
  resultValue(await call(app, headers, 14, "notion-create-folder", { parent: { page_id: ROOT_ID }, title: "Project files" }));

  resultValue(await call(app, headers, 15, "notion-create-pages", {
    parent: { data_source_id: dataSourceId },
    pages: [{ properties: { title: "Ship release", Status: "Open" } }],
  }));
  const rows = resultValue(await call(app, headers, 16, "notion-query-data-sources", { data: {
    mode: "rows",
    data_source_url: `collection://${dataSourceId}`,
    limit: 50,
  } }));
  assert.ok(Array.isArray(rows.results));
  assert.equal(rows.results.length, 1);
  const sql = resultValue(await call(app, headers, 17, "notion-query-multiple-data-sources", {
    data_source_urls: [`collection://${dataSourceId}`, `collection://${dataSourceId}`],
    mode: "sql",
    query: `SELECT COUNT(*) AS count FROM "collection://${dataSourceId}"`,
  }));
  assert.deepEqual(sql.results, [{ count: 1 }]);
  assert.deepEqual(sql.data_source_ids, [dataSourceId]);
  assert.equal(sql.truncated, false);

  const observed = await json(await app.request("/__worldfixture/mcp-observability", { headers: { Authorization: "Bearer inspector" } }));
  assert.ok(Array.isArray(observed.asyncTasks));
  assert.ok(Array.isArray(observed.changes));
  assert.ok(store.collection("notion_changes", ["sequence", "object_id"]).count() > 0);
});

test("write/query validation rejects invalid combinations before domain dispatch", async () => {
  const { app } = fixture();
  const headers = await initialize(app, await authorize(app));
  const draftParent = await json(await app.request("/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 20, method: "tools/call", params: { name: "notion-create-pages", arguments: { creation_mode: "draft", parent: { page_id: ROOT_ID }, pages: [{ properties: { title: "Bad" } }] } } }),
  }));
  assert.equal(draftParent.error.code, -32602);
  assert.match(draftParent.error.message, /parent cannot be used/);

  const response = await json(await app.request("/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 21, method: "tools/call", params: { name: "notion-query-data-sources", arguments: { data: { mode: "rows" } } } }),
  }));
  assert.equal(response.error.code, -32602);
  assert.match(response.error.message, /supported shape/);
});

test("captured folder, sidebar, multiple-source, and next-step tools dispatch", async () => {
  const { app } = fixture();
  const headers = await initialize(app, await authorize(app));
  const folder = resultValue(await call(app, headers, 40, "notion-create-folder", { parent: { page_id: ROOT_ID }, title: "Evidence" }));
  const child = resultValue(await call(app, headers, 41, "notion-update-folder", { folder_id: folder.id, command: "add_subfolder", title: "Screenshots" }));
  assert.equal(child.title, "Screenshots");
  const fetched = resultValue(await call(app, headers, 42, "notion-fetch", { id: folder.id }));
  assert.match(fetched.text, new RegExp(child.id));

  const privatePages = resultValue(await call(app, headers, 43, "notion-list-private-pages", { limit: 20 }));
  assert.deepEqual(privatePages.results.map((page) => page.id), [ROOT_ID]);
  const advanced = await call(app, headers, 44, "notion-show-advanced-analysis-next-steps", {});
  assert.deepEqual(resultValue(advanced), { kind: "query_multiple_data_sources_full_version_not_displayed" });
  assert.deepEqual(advanced.structuredContent, { kind: "query_multiple_data_sources_full_version_not_displayed" });
  const nextSteps = await call(app, headers, 45, "notion-check-mcp-next-steps", {});
  assert.deepEqual(resultValue(nextSteps), { kind: "mcp_business_education_not_displayed" });
  assert.deepEqual(nextSteps.structuredContent, { kind: "mcp_business_education_not_displayed" });
});
