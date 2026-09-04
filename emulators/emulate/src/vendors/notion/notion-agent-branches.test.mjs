import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { APIResponseError, Client } from "@notionhq/client";
import { createServer } from "@emulators/core";

import { plugin, seedFromConfig } from "./index.mjs";
import { NOTION_VERSION } from "./rest.mjs";

const USER = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const ACTIVE = "aa000000-0000-4000-8000-000000000001";
const DISABLED = "aa000000-0000-4000-8000-000000000002";
const HIDDEN = "aa000000-0000-4000-8000-000000000003";
const DELETED = "aa000000-0000-4000-8000-000000000004";
const EVENT_SESSION = "a1000000-0000-4000-8000-000000000001";
const ACTION_SESSION = "a1000000-0000-4000-8000-000000000002";
const REJECT_SESSION = "a1000000-0000-4000-8000-000000000003";
const HIDDEN_SESSION = "a1000000-0000-4000-8000-000000000004";
const ACTION = "ac000000-0000-4000-8000-000000000001";
const SPEC_PATH = process.env.NOTION_PUBLIC_OPENAPI ?? new URL("../../../contracts/notion/public-api-2026-03-11.openapi.json", import.meta.url);

const SESSION_IDS = Object.fromEntries(["queued", "in_progress", "completed", "failed", "canceled", "terminated"].map((status, index) => [status, `a2000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`]));
const EVENT_TYPES = ["user.message", "agent.message", "agent.thinking", "agent.tool_use", "agent.tool_result", "session.status"];

function fixture() {
  const baseUrl = "http://notion.worldfixture.test";
  const server = createServer(plugin, { baseUrl, tokens: {
    maya: { login: "maya@example.test", id: 1, scopes: ["interact:agents"] },
    jon: { login: "jon@example.test", id: 2, scopes: ["interact:agents"] },
    no_agents: { login: "maya@example.test", id: 1, scopes: ["read:content"] },
  } });
  const action = { action_id: ACTION, title: "Publish the result?", options: [{ id: "approve", label: "Approve" }, { id: "reject", label: "Reject" }] };
  const sessions = [
    { id: EVENT_SESSION, agent_id: ACTIVE, title: "Event variants", status: "completed", created_at: "2026-09-03T09:00:00.000Z", updated_at: "2026-09-03T09:06:00.000Z", created_by: USER, accessible_by: [USER] },
    { id: ACTION_SESSION, agent_id: ACTIVE, title: "Approve", status: "requires_action", required_actions: [action], created_at: "2026-09-03T10:00:00.000Z", updated_at: "2026-09-03T10:00:00.000Z", created_by: USER, accessible_by: [USER] },
    { id: REJECT_SESSION, agent_id: ACTIVE, title: "Reject", status: "requires_action", required_actions: [action], created_at: "2026-09-03T10:01:00.000Z", updated_at: "2026-09-03T10:01:00.000Z", created_by: USER, accessible_by: [USER] },
    { id: HIDDEN_SESSION, agent_id: HIDDEN, title: "Hidden", status: "completed", created_at: "2026-09-03T11:00:00.000Z", updated_at: "2026-09-03T11:00:00.000Z", created_by: OTHER, accessible_by: [OTHER] },
    ...Object.entries(SESSION_IDS).map(([status, id], index) => ({ id, agent_id: ACTIVE, title: status, status, error: status === "failed" ? { code: "tool_failed", message: "The tool failed.", retryable: true } : undefined, created_at: `2026-09-04T0${index}:00:00.000Z`, updated_at: `2026-09-04T0${index}:30:00.000Z`, created_by: USER, accessible_by: [USER] })),
  ];
  const eventBase = { session_id: EVENT_SESSION, accessible_by: [USER] };
  seedFromConfig(server.store, baseUrl, {
    users: [{ id: USER, name: "Maya", email: "maya@example.test" }, { id: OTHER, name: "Jon", email: "jon@example.test" }],
    agents: [
      { id: ACTIVE, name: "Active planner", description: "Release planning", agent_type: "custom_agent", created_by: USER, created_time: "2026-09-01T09:00:00.000Z", last_run_at: "2026-09-03T09:00:00.000Z", favorited_by: [USER], model: { mode: "auto" }, connections: [{ type: "mcp_server", name: "Linear" }], version_id: "ab000000-0000-4000-8000-000000000001", accessible_by: [USER], editable_by: [USER] },
      { id: DISABLED, name: "Disabled autofill", description: "Database fill", agent_type: "autofill_custom_agent", status: "disabled", pause_reason: "disabled_from_api", created_by: OTHER, created_time: "2026-09-02T09:00:00.000Z", last_run_at: "2026-09-02T10:00:00.000Z", model: { mode: "pinned", id: "model-1" }, version_id: "ab000000-0000-4000-8000-000000000002", accessible_by: [USER, OTHER], editable_by: [OTHER] },
      { id: HIDDEN, name: "Hidden agent", created_by: OTHER, accessible_by: [OTHER], editable_by: [OTHER] },
      { id: DELETED, name: "Deleted agent", status: "deleted", created_by: USER, accessible_by: [USER], editable_by: [USER] },
    ],
    agent_sessions: sessions,
    agent_session_events: [
      { ...eventBase, id: "b1000000-0000-4000-8000-000000000001", sequence: 1, created_at: "2026-09-03T09:01:00.000Z", type: "user.message", content: [{ type: "text", text: "Plan" }], created_by: { id: USER, type: "user" }, metadata: null },
      { ...eventBase, id: "b1000000-0000-4000-8000-000000000002", sequence: 2, created_at: "2026-09-03T09:02:00.000Z", type: "agent.message", content: [{ type: "text", text: "Working" }], created_by: { id: ACTIVE, type: "bot" }, metadata: { model: "auto" } },
      { ...eventBase, id: "b1000000-0000-4000-8000-000000000003", sequence: 3, created_at: "2026-09-03T09:03:00.000Z", type: "agent.thinking", content: [{ type: "text", text: "Check data" }] },
      { ...eventBase, id: "b1000000-0000-4000-8000-000000000004", sequence: 4, created_at: "2026-09-03T09:04:00.000Z", type: "agent.tool_use", tool_name: "search" },
      { ...eventBase, id: "b1000000-0000-4000-8000-000000000005", sequence: 5, created_at: "2026-09-03T09:05:00.000Z", type: "agent.tool_result", tool_use_id: "tool-1", tool_name: "search", is_error: false },
      { ...eventBase, id: "b1000000-0000-4000-8000-000000000006", sequence: 6, created_at: "2026-09-03T09:06:00.000Z", type: "session.status", status: "failed", error: { code: "tool_failed", message: "The tool failed.", retryable: true } },
    ],
  });
  const makeClient = (auth) => new Client({ auth, baseUrl, notionVersion: NOTION_VERSION, fetch: (url, init) => server.app.request(url, init), maxRetries: 0 });
  return { ...server, maya: makeClient("maya"), jon: makeClient("jon"), limited: makeClient("no_agents") };
}

async function rejects(errorPromise, code, status) {
  await assert.rejects(errorPromise, (error) => error instanceof APIResponseError && error.code === code && error.status === status);
}

test("official public OpenAPI keeps the complete Agent and Session route inventory", { skip: !existsSync(SPEC_PATH) && "Pinned public OpenAPI is absent." }, () => {
  const spec = JSON.parse(readFileSync(SPEC_PATH, "utf8"));
  const routes = Object.entries(spec.paths).flatMap(([path, methods]) => ["get", "post", "patch", "delete"].filter((method) => methods[method] && (path.startsWith("/v1/agents") || path.startsWith("/v1/sessions"))).map((method) => `${method.toUpperCase()} ${path}`));
  assert.deepEqual(routes.sort(), [
    "DELETE /v1/agents/{agent_id}", "GET /v1/agents/{agent_id}", "GET /v1/agents/{agent_id}/insights", "GET /v1/sessions/{session_id}",
    "PATCH /v1/agents/{agent_id}/credit_limit", "PATCH /v1/agents/{agent_id}/status", "POST /v1/agents/batch", "POST /v1/agents/query",
    "POST /v1/sessions", "POST /v1/sessions/{session_id}/cancel", "POST /v1/sessions/{session_id}/events/query", "POST /v1/sessions/query",
  ].sort());
});

test("Agent query covers every SDK filter, Boolean composition, sort, and pagination branch", async (t) => {
  const cases = [
    ["query text", { query: "release" }, [ACTIVE]],
    ["id", { filter: { property: "id", id: { equals: ACTIVE } } }, [ACTIVE]],
    ["agent_type", { filter: { property: "agent_type", string: { equals: "autofill_custom_agent" } } }, [DISABLED]],
    ["created_by me", { filter: { property: "created_by", people: { contains: "me" } } }, [ACTIVE]],
    ["created_by id", { filter: { property: "created_by", people: { contains: OTHER } } }, [DISABLED]],
    ["created_time after and before", { filter: { property: "created_time", date: { after: "2026-09-01T12:00:00.000Z", before: "2026-09-03T00:00:00.000Z" } } }, [DISABLED]],
    ["favorited", { filter: { property: "favorited", checkbox: { equals: true } } }, [ACTIVE]],
    ["not favorited", { filter: { property: "favorited", checkbox: { equals: false } }, sorts: [{ property: "created_time", direction: "ascending" }] }, [DISABLED]],
    ["connection MCP server", { filter: { property: "connections", mcp_server: { contains: "Linear" } } }, [ACTIVE]],
    ["status", { filter: { property: "status", status: { in: ["disabled"] } } }, [DISABLED]],
    ["model_mode", { filter: { property: "model_mode", select: { equals: "pinned" } } }, [DISABLED]],
    ["agent_version and created_time sort", { filter: { property: "agent_version", number: { equals: 1 } }, sorts: [{ property: "created_time", direction: "ascending" }] }, [ACTIVE, DISABLED]],
    ["last_run_at after and before", { filter: { property: "last_run_at", date: { after: "2026-09-02T12:00:00.000Z", before: "2026-09-04T00:00:00.000Z" } } }, [ACTIVE]],
    ["and", { filter: { and: [{ property: "status", status: { in: ["active"] } }, { property: "created_by", people: { contains: USER } }] } }, [ACTIVE]],
    ["or and last_run_at sort", { filter: { or: [{ property: "id", id: { equals: ACTIVE } }, { property: "id", id: { equals: DISABLED } }] }, sorts: [{ property: "last_run_at", direction: "descending" }] }, [ACTIVE, DISABLED]],
    ["include_deleted", { include_deleted: true, filter: { property: "status", status: { in: ["deleted"] } } }, [DELETED]],
  ];
  for (const [name, input, expected] of cases) await t.test(name, async () => {
    const { maya } = fixture();
    assert.deepEqual((await maya.agents.query(input)).results.map((item) => item.id), expected);
  });
  await t.test("pagination cursor", async () => {
    const { maya } = fixture();
    const first = await maya.agents.query({ page_size: 1, sorts: [{ property: "created_time", direction: "ascending" }] });
    assert.equal(first.has_more, true); assert.ok(first.next_cursor);
    const second = await maya.agents.query({ page_size: 1, start_cursor: first.next_cursor, sorts: [{ property: "created_time", direction: "ascending" }] });
    assert.notEqual(second.results[0].id, first.results[0].id);
  });
});

test("Session query covers all filters, timestamps, Boolean composition, sorting, and pagination", async (t) => {
  const cases = [
    ["query text", { query: "Event" }, [EVENT_SESSION]],
    ["id", { filter: { property: "id", string: { equals: ACTION_SESSION } } }, [ACTION_SESSION]],
    ["agent_id and access", { filter: { property: "agent_id", string: { equals: ACTIVE } }, page_size: 100 }, null],
    ["status equals and created_at sort", { filter: { property: "status", status: { equals: "requires_action" } }, sorts: [{ property: "created_at", direction: "ascending" }] }, [ACTION_SESSION, REJECT_SESSION]],
    ["status in", { filter: { property: "status", status: { in: ["failed", "terminated"] } }, sorts: [{ property: "created_at", direction: "ascending" }] }, [SESSION_IDS.failed, SESSION_IDS.terminated]],
    ["created_at after and on_or_before", { filter: { property: "created_at", timestamp: { after: "2026-09-03T09:30:00.000Z", on_or_before: "2026-09-03T10:00:00.000Z" } } }, [ACTION_SESSION]],
    ["updated_at on_or_after and before", { filter: { property: "updated_at", timestamp: { on_or_after: "2026-09-04T03:30:00.000Z", before: "2026-09-04T05:00:00.000Z" } }, sorts: [{ property: "updated_at", direction: "descending" }] }, [SESSION_IDS.canceled, SESSION_IDS.failed]],
    ["and", { filter: { and: [{ property: "agent_id", string: { equals: ACTIVE } }, { property: "status", status: { equals: "queued" } }] } }, [SESSION_IDS.queued]],
    ["or", { filter: { or: [{ property: "id", string: { equals: ACTION_SESSION } }, { property: "id", string: { equals: EVENT_SESSION } }] }, sorts: [{ property: "created_at", direction: "descending" }] }, [ACTION_SESSION, EVENT_SESSION]],
  ];
  for (const [name, input, expected] of cases) await t.test(name, async () => {
    const { maya } = fixture();
    const ids = (await maya.sessions.query(input)).results.map((item) => item.id);
    if (expected) assert.deepEqual(ids, expected); else assert.equal(ids.includes(HIDDEN_SESSION), false);
  });
  await t.test("pagination cursor", async () => {
    const { maya } = fixture();
    const first = await maya.sessions.query({ page_size: 1, sorts: [{ property: "created_at", direction: "ascending" }] });
    const second = await maya.sessions.query({ page_size: 1, start_cursor: first.next_cursor, sorts: [{ property: "created_at", direction: "ascending" }] });
    assert.equal(first.has_more, true); assert.notEqual(first.results[0].id, second.results[0].id);
  });
});

test("Session event responses preserve every official SDK event variant", async () => {
  const { maya } = fixture();
  const page = await maya.sessions.queryEvents({ session_id: EVENT_SESSION, sorts: [{ property: "sequence", direction: "ascending" }] });
  assert.deepEqual(page.results.map((item) => item.type), EVENT_TYPES);
  assert.equal(page.results[2].created_at, "2026-09-03T09:03:00.000Z");
  assert.deepEqual(page.results.find((item) => item.type === "agent.thinking").content, [{ type: "text", text: "Check data" }]);
  assert.equal(page.results.find((item) => item.type === "agent.tool_use").tool_name, "search");
  assert.equal(page.results.find((item) => item.type === "agent.tool_result").is_error, false);
  assert.deepEqual(page.results.find((item) => item.type === "session.status").error, { code: "tool_failed", message: "The tool failed.", retryable: true });
});

test("Session event query implements official id and event_type filters", async (t) => {
  const cases = [
    ["id", { property: "id", string: { equals: "b1000000-0000-4000-8000-000000000003" } }, ["agent.thinking"]],
    ["event_type equals", { property: "type", event_type: { equals: "agent.tool_use" } }, ["agent.tool_use"]],
    ["event_type in", { property: "type", event_type: { in: ["agent.thinking", "agent.tool_result"] } }, ["agent.thinking", "agent.tool_result"]],
  ];
  for (const [name, filter, expected] of cases) await t.test(name, async () => {
    const { maya } = fixture();
    const page = await maya.sessions.queryEvents({ session_id: EVENT_SESSION, filter, sorts: [{ property: "sequence", direction: "ascending" }] });
    assert.deepEqual(page.results.map((item) => item.type), expected);
  });
});

test("Session event query implements official number, timestamp, Boolean, sort, and pagination branches", async (t) => {
  const cases = [
    ["sequence greater_than", { property: "sequence", number: { greater_than: 4 } }, [5, 6]],
    ["sequence greater_than_or_equal_to", { property: "sequence", number: { greater_than_or_equal_to: 5 } }, [5, 6]],
    ["sequence less_than", { property: "sequence", number: { less_than: 3 } }, [1, 2]],
    ["sequence less_than_or_equal_to", { property: "sequence", number: { less_than_or_equal_to: 2 } }, [1, 2]],
    ["created_at equals", { property: "created_at", timestamp: { equals: "2026-09-03T09:03:00.000Z" } }, [3]],
    ["created_at after and before", { property: "created_at", timestamp: { after: "2026-09-03T09:02:00.000Z", before: "2026-09-03T09:05:00.000Z" } }, [3, 4]],
    ["created_at on_or_after and on_or_before", { property: "created_at", timestamp: { on_or_after: "2026-09-03T09:03:00.000Z", on_or_before: "2026-09-03T09:04:00.000Z" } }, [3, 4]],
    ["or", { or: [{ property: "sequence", number: { less_than_or_equal_to: 1 } }, { property: "type", event_type: { equals: "session.status" } }] }, [1, 6]],
    ["and", { and: [{ property: "sequence", number: { greater_than: 1 } }, { property: "sequence", number: { less_than: 4 } }] }, [2, 3]],
  ];
  for (const [name, filter, expected] of cases) await t.test(name, async () => {
    const { maya } = fixture();
    const page = await maya.sessions.queryEvents({ session_id: EVENT_SESSION, filter, sorts: [{ property: "sequence", direction: "ascending" }] });
    assert.deepEqual(page.results.map((item) => item.sequence), expected);
  });
  await t.test("descending sort and pagination cursor", async () => {
    const { maya } = fixture();
    const first = await maya.sessions.queryEvents({ session_id: EVENT_SESSION, page_size: 2, sorts: [{ property: "sequence", direction: "descending" }] });
    const second = await maya.sessions.queryEvents({ session_id: EVENT_SESSION, page_size: 2, start_cursor: first.next_cursor, sorts: [{ property: "sequence", direction: "descending" }] });
    assert.deepEqual(first.results.map((item) => item.sequence), [6, 5]); assert.deepEqual(second.results.map((item) => item.sequence), [4, 3]);
  });
});

test("requires_action approval, rejection, and continue_from use the SDK request unions", async () => {
  const { maya } = fixture();
  assert.equal((await maya.sessions.retrieve({ session_id: ACTION_SESSION })).status, "requires_action");
  const approved = await maya.sessions.update({ session_id: ACTION_SESSION, actions: [{ action_id: ACTION, option_id: "approve" }] });
  assert.equal(approved.status, "completed"); assert.equal(Object.hasOwn(approved, "required_actions"), false);
  const rejected = await maya.sessions.update({ session_id: REJECT_SESSION, actions: [{ action_id: ACTION, option_id: "reject" }] });
  assert.equal(rejected.status, "completed");
  const continued = await maya.sessions.update({ session_id: SESSION_IDS.in_progress, continue_from: "cursor-1" });
  assert.equal(continued.id, SESSION_IDS.in_progress); assert.equal(continued.status, "in_progress");
});

test("cancel accepts nonterminal states and rejects every terminal state", async () => {
  const { maya } = fixture();
  for (const id of [SESSION_IDS.queued, SESSION_IDS.in_progress, ACTION_SESSION]) assert.equal((await maya.sessions.cancel({ session_id: id })).status, "canceled");
  for (const status of ["completed", "failed", "canceled", "terminated"]) await rejects(maya.sessions.cancel({ session_id: SESSION_IDS[status] }), "conflict_error", 409);
});

test("Agent status, credit, delete, and all batch operation variants are exact", async () => {
  const { maya } = fixture();
  assert.equal((await maya.agents.updateStatus({ agent_id: ACTIVE, status: "disabled" })).pause_reason, "disabled_from_api");
  assert.equal((await maya.agents.updateStatus({ agent_id: ACTIVE, status: "active" })).pause_reason, null);
  assert.equal((await maya.agents.updateCreditLimit({ agent_id: ACTIVE, credit_limit: 0 })).credit_limit, 0);
  assert.equal((await maya.agents.updateCreditLimit({ agent_id: ACTIVE, credit_limit: null })).credit_limit, null);
  const batch = await maya.agents.batch({ operations: [
    { action: "update_status", agent_id: ACTIVE, fields: { status: "disabled" } },
    { action: "update_credit_limit", agent_id: ACTIVE, fields: { credit_limit: 25 } },
    { action: "delete", agent_id: DELETED, fields: {} },
  ] });
  assert.equal(batch.object, "async_task");
  assert.equal((await maya.agents.delete({ agent_id: ACTIVE })).status, "deleted");
});

test("Agent and Session access boundaries hide records and enforce capability scope", async () => {
  const { maya, limited } = fixture();
  assert.equal((await maya.agents.query({ include_deleted: true })).results.some((item) => item.id === HIDDEN), false);
  assert.equal((await maya.sessions.query({})).results.some((item) => item.id === HIDDEN_SESSION), false);
  await rejects(maya.agents.retrieve({ agent_id: HIDDEN }), "object_not_found", 404);
  await rejects(maya.agents.updateStatus({ agent_id: DISABLED, status: "active" }), "object_not_found", 404);
  await rejects(maya.sessions.retrieve({ session_id: HIDDEN_SESSION }), "object_not_found", 404);
  await rejects(maya.sessions.queryEvents({ session_id: HIDDEN_SESSION }), "object_not_found", 404);
  await rejects(limited.agents.query({}), "restricted_resource", 403);
});

test("documented Agent and Session limits and invalid cursors return validation errors", async () => {
  const { maya } = fixture();
  for (const page_size of [0, 101]) {
    await rejects(maya.agents.query({ page_size }), "validation_error", 400);
    await rejects(maya.sessions.query({ page_size }), "validation_error", 400);
    await rejects(maya.sessions.queryEvents({ session_id: EVENT_SESSION, page_size }), "validation_error", 400);
  }
  await rejects(maya.agents.query({ start_cursor: "bad" }), "validation_error", 400);
  await rejects(maya.sessions.query({ start_cursor: "bad" }), "validation_error", 400);
  await rejects(maya.sessions.queryEvents({ session_id: EVENT_SESSION, start_cursor: "bad" }), "validation_error", 400);
  await rejects(maya.agents.updateCreditLimit({ agent_id: ACTIVE, credit_limit: -1 }), "validation_error", 400);
  await rejects(maya.agents.updateCreditLimit({ agent_id: ACTIVE, credit_limit: 1.5 }), "validation_error", 400);
  await rejects(maya.agents.updateStatus({ agent_id: ACTIVE, status: "deleted" }), "validation_error", 400);
  await rejects(maya.agents.batch({ operations: [] }), "validation_error", 400);
  await rejects(maya.agents.batch({ operations: Array.from({ length: 101 }, () => ({ action: "delete", agent_id: ACTIVE, fields: {} })) }), "validation_error", 400);
});
