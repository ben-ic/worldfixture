import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createServer } from "@emulators/core";

import { plugin, seedFromConfig } from "./index.mjs";
import { NOTION_ADMIN_VERSION } from "./admin-api.mjs";

const SPACE_ID = "60000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_USER_ID = "00000000-0000-4000-8000-000000000002";
const AGENT_ID = "aa000000-0000-4000-8000-000000000001";
const GROUP_ID = "d4000000-0000-4000-8000-000000000001";
const PAT_ID = "e1000000-0000-4000-8000-000000000001";

const scopes = [
  "legal-hold:read", "legal-hold:write", "legal-hold:write-high-impact", "legal-hold:export", "workspace:export",
  "managed-user-session:write", "mcp-client-connection:read", "mcp-client-connection:write-high-impact",
  "user:read", "permission-group:read", "permission-group:write", "personal-access-token:read",
  "personal-access-token:write-high-impact", "workflows:read", "workflows:write",
];

const officialSpecPath = process.env.NOTION_ADMIN_OPENAPI ?? new URL("../../../contracts/notion/admin-api-2026-06-01.openapi.json", import.meta.url);
const officialSpecBytes = readFileSync(officialSpecPath);
assert.equal(
  createHash("sha256").update(officialSpecBytes).digest("hex"),
  "3379d21cf33cad65a5fe9719ebfaf66cc884bf26de6745e9bd542171a419a772",
  "NOTION_ADMIN_OPENAPI must be the pinned official Admin contract.",
);
const officialSpec = JSON.parse(officialSpecBytes);
const officialOperations = new Map(Object.values(officialSpec?.paths ?? {}).flatMap((methods) => Object.values(methods).filter((operation) => operation?.operationId).map((operation) => [operation.operationId, operation])));
if (officialSpec) {
  assert.equal(officialSpec.info?.title, "Notion Admin API");
  assert.equal(officialSpec.info?.version, "1.0.0");
  assert.equal(officialOperations.size, 39);
}

function resolveSchema(schema) {
  if (!schema?.$ref) return schema;
  return schema.$ref.slice(2).split("/").reduce((value, key) => value[key], officialSpec);
}

function validateSchema(inputSchema, value, path = "response", ignoreAdditional = false) {
  const schema = resolveSchema(inputSchema);
  if (!schema) return;
  if (schema.oneOf) { const matches = schema.oneOf.filter((choice) => { try { validateSchema(choice, value, path); return true; } catch { return false; } }); assert.equal(matches.length, 1, `${path} must match exactly one schema`); return; }
  if (schema.anyOf) { assert.ok(schema.anyOf.some((choice) => { try { validateSchema(choice, value, path); return true; } catch { return false; } }), `${path} must match a schema`); return; }
  if (schema.allOf) { for (const choice of schema.allOf) validateSchema(choice, value, path, true); return; }
  if (schema.const !== undefined) assert.deepEqual(value, schema.const, `${path} const`);
  if (schema.enum) assert.ok(schema.enum.includes(value), `${path} enum: ${JSON.stringify(value)}`);
  if (schema.type === "null") assert.equal(value, null, `${path} type`);
  if (schema.type === "string") assert.equal(typeof value, "string", `${path} type`);
  if (schema.type === "number" || schema.type === "integer") assert.equal(typeof value, "number", `${path} type`);
  if (schema.type === "boolean") assert.equal(typeof value, "boolean", `${path} type`);
  if (schema.type === "array") { assert.ok(Array.isArray(value), `${path} type`); value.forEach((item, index) => validateSchema(schema.items, item, `${path}[${index}]`)); }
  if (schema.type === "object" || schema.properties || schema.required) {
    assert.ok(value && typeof value === "object" && !Array.isArray(value), `${path} type`);
    for (const key of schema.required ?? []) assert.ok(Object.hasOwn(value, key), `${path}.${key} is required`);
    for (const [key, child] of Object.entries(schema.properties ?? {})) if (Object.hasOwn(value, key)) validateSchema(child, value[key], `${path}.${key}`);
    if (!ignoreAdditional && schema.additionalProperties === false) for (const key of Object.keys(value)) assert.ok(Object.hasOwn(schema.properties ?? {}, key), `${path}.${key} is not allowed`);
  }
}

function fixture() {
  const baseUrl = "http://notion.worldfixture.test";
  const server = createServer(plugin, { baseUrl, tokens: {
    organization_token: { login: "maya@example.test", id: 1, scopes },
    ordinary_token: { login: "maya@example.test", id: 1, scopes: ["read:content"] },
  } });
  seedFromConfig(server.store, baseUrl, {
    workspace: { id: SPACE_ID, name: "Northstar" },
    users: [{ id: USER_ID, name: "Maya Chen", email: "maya@example.test" }, { id: OTHER_USER_ID, name: "Jon Bell", email: "jon@example.test" }],
    pages: [{ id: "10000000-0000-4000-8000-000000000001", title: "Northstar plan", created_by: USER_ID, accessible_by: [USER_ID] }],
    agents: [{ id: AGENT_ID, name: "Release planner", description: "Plans the Northstar release.", instructions: "Use the approved plan.", created_by: USER_ID, accessible_by: [USER_ID], editable_by: [USER_ID] }],
    admin: {
      groups: [{ id: GROUP_ID, name: "Release team", members: [{ id: "d5000000-0000-4000-8000-000000000001", user_id: USER_ID, role: "owner" }] }],
      mcp_client_connections: [{ id: "f1000000-0000-4000-8000-000000000001", client_key: "claude-desktop", client_name: "Claude Desktop", client_type: "claude", user_id: USER_ID, is_enterprise_managed: true }],
      personal_access_tokens: [{ id: PAT_ID, creator: { id: USER_ID, name: "Maya Chen", email: "maya@example.test" }, name: "Maya CLI" }],
    },
  });
  return server;
}

const headers = { Authorization: "Bearer organization_token", "Notion-Version": NOTION_ADMIN_VERSION, "Content-Type": "application/json" };

test("all 39 current Admin OpenAPI operations run through realistic world-backed lifecycles", async () => {
  const { app } = fixture();
  const operations = [];
  async function call(operation, path, method = "GET", payload) {
    const response = await app.request(`/admin${path}`, { method, headers, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    const text = await response.text();
    assert.equal(response.status, 200, `${operation}: ${response.status} ${text}`);
    operations.push(operation);
    const value = text ? JSON.parse(text) : null;
    const contract = officialOperations.get(operation);
    if (contract && payload !== undefined) validateSchema(contract.requestBody?.content?.["application/json"]?.schema, payload, `${operation} request`);
    if (contract) validateSchema(contract.responses?.["200"]?.content?.["application/json"]?.schema, value, `${operation} response`);
    return value;
  }

  const createdHold = await call("create-legal-hold", "/v1/legal_holds", "POST", { name: "Northstar preservation", start_date: 1778061600000, user_ids: [USER_ID], user_interaction_type: ["page.created", "page.edited"] });
  assert.equal(createdHold.status, "active");
  await call("list-legal-holds", "/v1/legal_holds");
  await call("get-legal-hold", `/v1/legal_holds/${createdHold.id}`);
  await call("update-legal-hold", `/v1/legal_holds/${createdHold.id}`, "PATCH", { description: "Preserve the approved release record." });
  await call("add-legal-hold-users", `/v1/legal_holds/${createdHold.id}/users`, "POST", { user_ids: [OTHER_USER_ID] });
  await call("list-legal-hold-users", `/v1/legal_holds/${createdHold.id}/users`);
  await call("remove-legal-hold-user", `/v1/legal_holds/${createdHold.id}/users/${OTHER_USER_ID}`, "DELETE");
  await call("list-legal-hold-workspaces", `/v1/legal_holds/${createdHold.id}/workspaces`);
  await call("list-legal-hold-pages", `/v1/legal_holds/${createdHold.id}/spaces/${SPACE_ID}/pages`);
  await call("export-legal-hold", `/v1/legal_holds/${createdHold.id}/export`, "POST", { requesting_user_id: USER_ID, space_id: SPACE_ID });
  await call("release-legal-hold", `/v1/legal_holds/${createdHold.id}/release`, "POST", {});

  const queuedExport = await call("enqueue-space-export", `/v1/spaces/${SPACE_ID}/exports`, "POST", { export_type: "markdown", on_behalf_of_user_email: "maya@example.test", include_comments: true });
  await call("get-space-export-status", `/v1/spaces/${SPACE_ID}/exports/${queuedExport.export_job_id}`);
  await call("revoke-user-session", "/v1/managed_users/revoke_session", "POST", { user: { type: "email", email: "maya@example.test" } });

  const mcp = await call("list-mcp-client-connections", `/v1/mcp_client_connections?workspace_id=${SPACE_ID}`);
  assert.equal(mcp.results[0].client.type, "claude");
  await call("update-mcp-client-connection-enterprise-managed-access", "/v1/mcp_client_connections/enterprise_managed_access", "PUT", { access: "denied", user_id: USER_ID, workspace_id: SPACE_ID });
  await call("revoke-mcp-client-connection", "/v1/mcp_client_connections/revoke", "POST", { client_key: "claude-desktop", user_id: USER_ID, workspace_id: SPACE_ID });

  await call("list-users", `/v1/spaces/${SPACE_ID}/users`);
  await call("list-permission-groups", `/v1/spaces/${SPACE_ID}/groups`);
  await call("retrieve-permission-group", `/v1/spaces/${SPACE_ID}/groups/${GROUP_ID}`);
  await call("update-permission-group", `/v1/spaces/${SPACE_ID}/groups/${GROUP_ID}`, "PATCH", { name: "Release owners" });
  await call("list-permission-group-members", `/v1/spaces/${SPACE_ID}/groups/${GROUP_ID}/members`);
  await call("add-permission-group-member", `/v1/spaces/${SPACE_ID}/groups/${GROUP_ID}/members`, "POST", { member: { type: "user", user_id: OTHER_USER_ID }, role: "member" });
  await call("update-permission-group-member", `/v1/spaces/${SPACE_ID}/groups/${GROUP_ID}/members/users/${OTHER_USER_ID}`, "PATCH", { role: "owner" });
  await call("remove-permission-group-member", `/v1/spaces/${SPACE_ID}/groups/${GROUP_ID}/members/users/${OTHER_USER_ID}`, "DELETE");
  const createdGroup = await call("create-permission-group", `/v1/spaces/${SPACE_ID}/groups`, "POST", { name: "Launch reviewers" });
  await call("delete-permission-group", `/v1/spaces/${SPACE_ID}/groups/${createdGroup.id}`, "DELETE");

  await call("list-personal-access-tokens", `/v1/spaces/${SPACE_ID}/personal_access_tokens?status=active`);
  await call("revoke-personal-access-token", `/v1/spaces/${SPACE_ID}/personal_access_tokens/${PAT_ID}`, "DELETE");

  const agentPage = await call("get-workflows-metadata-for-space", `/v1/spaces/${SPACE_ID}/agents`);
  assert.deepEqual(Object.keys(agentPage.results[0]).filter((key) => ["alive", "id", "space_id", "status", "type"].includes(key)).sort(), ["alive", "id", "space_id", "status", "type"]);
  await call("get-agent-credit-usage", `/v1/spaces/${SPACE_ID}/agents/${AGENT_ID}/credit_usage`);
  await call("get-agents-credit-usage", `/v1/spaces/${SPACE_ID}/agents/credit_usage`);
  await call("get-agent-permissions", `/v1/spaces/${SPACE_ID}/agents/${AGENT_ID}/permissions`);
  await call("update-agent-permissions", `/v1/spaces/${SPACE_ID}/agents/${AGENT_ID}/permissions`, "PATCH", { set: [{ principal: { type: "user", user_id: OTHER_USER_ID }, role: "edit" }] });
  await call("update-agent-credit-limit", `/v1/spaces/${SPACE_ID}/agents/${AGENT_ID}/credit_limit`, "PUT", { credit_limit: 500 });
  await call("update-agent-status", `/v1/spaces/${SPACE_ID}/agents/${AGENT_ID}/status`, "PATCH", { admin_status: "disabled" });
  await call("update-agent-creation-policy", `/v1/spaces/${SPACE_ID}/agents/creation_policy`, "PATCH", { policy: "workspace_owners_only", disable_existing_agents: false });
  await call("update-workspace-credit-limit", `/v1/spaces/${SPACE_ID}/credit_limit`, "PATCH", { default_agent_credit_limit: 1000 });
  await call("delete-agent", `/v1/spaces/${SPACE_ID}/agents/${AGENT_ID}`, "DELETE");

  assert.equal(operations.length, 39);
  assert.equal(new Set(operations).size, 39);
});

test("Admin API requires its exact version and operation-specific organization scopes", async () => {
  const { app } = fixture();
  const wrongVersion = await app.request(`/admin/v1/spaces/${SPACE_ID}/users`, { headers: { ...headers, "Notion-Version": "2026-03-11" } });
  assert.equal(wrongVersion.status, 400);
  const ordinary = await app.request(`/admin/v1/spaces/${SPACE_ID}/users`, { headers: { ...headers, Authorization: "Bearer ordinary_token" } });
  assert.equal(ordinary.status, 403);
  assert.equal((await ordinary.json()).code, "restricted_resource");
});

// Closes: `/admin/v1/legal_holds` and `/admin/v1/legal_holds/:id/users` wrote
// `size(c) ?? 100`, and `size` returns `null` to mean "page_size is invalid" --
// so the refusal became a silent hundred. Neither checked the paginator's
// `invalid` flag either, so an unknown `start_cursor` reached `.map()` on an
// undefined `results`. Measured against the running fixture before the fix:
// `?page_size=0` answered 200, and `?start_cursor=totally-bogus` answered 500
// `Cannot read properties of undefined (reading 'map')`. Every sibling admin list
// answered 400 for both.
test("the two legal-hold lists validate page_size and start_cursor like every other admin list", async () => {
  const { app } = fixture();
  const hold = await (await app.request("/admin/v1/legal_holds", {
    method: "POST", headers,
    body: JSON.stringify({ name: "Northstar preservation", start_date: 1778061600000, user_ids: [USER_ID], user_interaction_type: ["page.created"] }),
  })).json();

  for (const path of ["/admin/v1/legal_holds", `/admin/v1/legal_holds/${hold.id}/users`]) {
    for (const [query, message] of [
      ["page_size=0", "page_size must be from 1 through 100."],
      ["page_size=abc", "page_size must be from 1 through 100."],
      ["page_size=500", "page_size must be from 1 through 100."],
      ["start_cursor=totally-bogus", "start_cursor is not valid."],
    ]) {
      const response = await app.request(`${path}?${query}`, { headers });
      assert.equal(response.status, 400, `${path}?${query}`);
      assert.equal((await response.json()).message, message, `${path}?${query}`);
    }

    // A valid request still answers, and a page size the caller asks for is honoured.
    const ok = await app.request(`${path}?page_size=1`, { headers });
    assert.equal(ok.status, 200, path);
  }

  const listed = await (await app.request("/admin/v1/legal_holds?page_size=1", { headers })).json();
  assert.equal(listed.legal_holds.length, 1);
});
