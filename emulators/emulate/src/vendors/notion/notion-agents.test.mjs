import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@notionhq/client";
import { createServer } from "@emulators/core";

import { plugin, seedFromConfig } from "./index.mjs";
import { NOTION_VERSION } from "./rest.mjs";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const AGENT_ID = "aa000000-0000-4000-8000-000000000001";

function fixture() {
  const baseUrl = "http://notion.worldfixture.test";
  const server = createServer(plugin, { baseUrl, tokens: { agent_token: { login: "maya@example.test", id: 1, scopes: ["interact:agents", "read:content"] } } });
  seedFromConfig(server.store, baseUrl, {
    workspace: { id: "workspace-1", name: "Northstar" },
    users: [{ id: USER_ID, name: "Maya Chen", email: "maya@example.test" }],
    agents: [{
      id: AGENT_ID, name: "Release planner", description: "Plans the Northstar release.",
      instructions: "Use the approved Northstar release plan.", created_by: USER_ID,
      accessible_by: [USER_ID], editable_by: [USER_ID], credit_limit: 200,
      default_response: "The Northstar release plan is ready for review.",
      triggers: [{ type: "scheduled", enabled: true, schedule: { frequency: "weekly", interval: 1, weekdays: ["monday"], hour: 9, minute: 0, timezone: "UTC" } }],
    }],
  });
  const notion = new Client({ auth: "agent_token", baseUrl, notionVersion: NOTION_VERSION, fetch: (url, init) => server.app.request(url, init) });
  return { ...server, notion };
}

test("official SDK 5.26.0 manages current public-beta agents with exact response fields", async () => {
  const { notion } = fixture();
  const queried = await notion.agents.query({ query: "release", filter: { and: [{ property: "status", status: { in: ["active"] } }, { property: "created_by", people: { contains: USER_ID } }] }, verbose: true });
  assert.equal(queried.object, "list");
  assert.equal(queried.type, "agent");
  assert.equal(queried.results[0].id, AGENT_ID);
  assert.equal(queried.results[0].instructions, "Use the approved Northstar release plan.");
  assert.equal(queried.results[0].agent_version.number, 1);

  const retrieved = await notion.agents.retrieve({ agent_id: AGENT_ID, verbose: true });
  assert.equal(retrieved.model.mode, "auto");
  assert.equal(retrieved.connections[0].type, "notion");

  assert.equal((await notion.agents.updateStatus({ agent_id: AGENT_ID, status: "disabled" })).pause_reason, "disabled_from_api");
  assert.equal((await notion.agents.updateStatus({ agent_id: AGENT_ID, status: "active" })).pause_reason, null);
  assert.equal((await notion.agents.updateCreditLimit({ agent_id: AGENT_ID, credit_limit: 500 })).credit_limit, 500);
  assert.equal((await notion.agents.updateCreditLimit({ agent_id: AGENT_ID, credit_limit: null })).credit_limit, null);
  assert.equal((await notion.agents.retrieveInsights({ agent_id: AGENT_ID, start_time: 0, end_time: 9999999999999 })).object, "agent_insights");

  const batch = await notion.agents.batch({ operations: [{ action: "update_status", agent_id: AGENT_ID, fields: { status: "disabled" } }, { action: "update_credit_limit", agent_id: AGENT_ID, fields: { credit_limit: 10 } }] });
  assert.equal(batch.object, "async_task");
  assert.equal(batch.operation.name, "agent_batch");
  assert.equal((await notion.agents.delete({ agent_id: AGENT_ID })).status, "deleted");
  assert.equal((await notion.agents.query({ include_deleted: true })).results[0].status, "deleted");
});

test("official SDK 5.26.0 creates, queries, streams, and reads session events", async () => {
  const { notion } = fixture();
  const created = await notion.sessions.update({ agent_id: AGENT_ID, message: "Prepare the release." });
  assert.equal(created.object, "session");
  assert.equal(created.status, "completed");

  const retrieved = await notion.sessions.retrieve({ session_id: created.id });
  assert.equal(retrieved.created_by.id, USER_ID);
  assert.equal(retrieved.message_count, 2);
  const queried = await notion.sessions.query({ filter: { property: "agent_id", string: { equals: AGENT_ID } }, sorts: [{ property: "created_at", direction: "descending" }] });
  assert.equal(queried.results[0].id, created.id);

  const eventPage = await notion.sessions.queryEvents({ session_id: created.id, filter: { property: "type", select: { in: ["user.message", "agent.message"] } }, sorts: [{ property: "sequence", direction: "ascending" }] });
  assert.deepEqual(eventPage.results.map((event) => event.type), ["user.message", "agent.message"]);
  assert.equal(eventPage.results[1].content[0].text, "The Northstar release plan is ready for review.");

  const streamed = [];
  for await (const event of notion.sessions.stream({ session_id: created.id, message: "Confirm it." })) streamed.push(event);
  assert.deepEqual(streamed.map((event) => event.type), ["session.snapshot", "event.committed", "event.committed", "event.committed", "stream.end"]);
  assert.equal(streamed.at(-1).status, "completed");
});

test("agent access, validation, and terminal-session conflicts use Notion errors", async () => {
  const { notion } = fixture();
  await assert.rejects(() => notion.agents.updateCreditLimit({ agent_id: AGENT_ID, credit_limit: -1 }), (error) => error.code === "validation_error");
  const created = await notion.sessions.update({ agent_id: AGENT_ID, message: "Prepare the release." });
  await assert.rejects(() => notion.sessions.cancel({ session_id: created.id }), (error) => error.code === "conflict_error");
  await assert.rejects(() => notion.sessions.update({ message: "Missing agent" }), (error) => error.code === "validation_error");
});
