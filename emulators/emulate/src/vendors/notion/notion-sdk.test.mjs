import assert from "node:assert/strict";
import test from "node:test";
import { Client, APIResponseError, collectPaginatedAPI } from "@notionhq/client";
import { createServer } from "@emulators/core";

import { plugin, seedFromConfig } from "./index.mjs";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const PAGE_ID = "10000000-0000-4000-8000-000000000001";
const TEMPLATE_ID = "10000000-0000-4000-8000-000000000002";
const DATABASE_ID = "30000000-0000-4000-8000-000000000001";
const DATA_SOURCE_ID = "40000000-0000-4000-8000-000000000001";
const VIEW_ID = "50000000-0000-4000-8000-000000000001";
const EMOJI_ID = "b0000000-0000-4000-8000-000000000001";
const MEETING_NOTE_ID = "c0000000-0000-4000-8000-000000000001";

function fixture() {
  const baseUrl = "http://notion.worldfixture.test";
  const server = createServer(plugin, {
    baseUrl,
    tokens: { sdk: { login: "maya@example.test", id: 1, scopes: ["read:user", "read:content", "insert:content", "update:content", "read:comment", "insert:comment"] } },
  });
  seedFromConfig(server.store, baseUrl, {
    users: [{ id: USER_ID, name: "Maya", email: "maya@example.test" }],
    custom_emojis: [{ id: EMOJI_ID, name: "northstar", url: "https://assets.example.test/northstar.png" }],
    databases: [{ id: DATABASE_ID, title: "Projects", accessible_by: [USER_ID] }],
    data_sources: [{
      id: DATA_SOURCE_ID, database_id: DATABASE_ID, name: "Projects", accessible_by: [USER_ID],
      templates: [{ id: TEMPLATE_ID, name: "Project", is_default: true }],
      properties: { Name: { id: "title", type: "title" }, Rank: { id: "rank", type: "number" } },
    }],
    views: [{ id: VIEW_ID, database_id: DATABASE_ID, data_source_id: DATA_SOURCE_ID, name: "Ranked", type: "table", sorts: [{ property: "Rank", direction: "ascending" }], accessible_by: [USER_ID] }],
    pages: [
      { id: TEMPLATE_ID, parent: { type: "data_source_id", data_source_id: DATA_SOURCE_ID }, title: "Project", created_by: USER_ID, accessible_by: [USER_ID], children: [{ type: "heading_2", heading_2: { rich_text: [{ type: "text", text: { content: "Summary" }, plain_text: "Summary" }], is_toggleable: false } }] },
      { id: PAGE_ID, parent: { type: "data_source_id", data_source_id: DATA_SOURCE_ID }, created_by: USER_ID, accessible_by: [USER_ID], properties: { Name: { id: "title", type: "title", title: [{ type: "text", text: { content: "Alpha" }, plain_text: "Alpha" }] }, Rank: { id: "rank", type: "number", number: 1 } } },
    ],
    meeting_notes: [{
      id: MEETING_NOTE_ID, parent: { type: "page_id", page_id: PAGE_ID }, title: "Weekly sync", created_by: USER_ID,
      calendar_event: { start_time: "2026-09-03T08:00:00.000Z", end_time: "2026-09-03T08:30:00.000Z", attendees: [USER_ID] },
    }],
  });
  const notion = new Client({
    auth: "sdk",
    baseUrl,
    notionVersion: "2026-03-11",
    fetch: (url, init) => server.app.request(url, init),
  });
  return { ...server, notion };
}

test("official JavaScript SDK 5.26.0 reads current users, emojis, templates, and query projections", async () => {
  const { notion } = fixture();
  assert.deepEqual((await collectPaginatedAPI(notion.users.list, { page_size: 1 })).map((user) => user.id), [USER_ID]);
  assert.deepEqual((await notion.customEmojis.list({ name: "northstar" })).results[0], { id: EMOJI_ID, name: "northstar", url: "https://assets.example.test/northstar.png" });
  assert.deepEqual((await notion.dataSources.listTemplates({ data_source_id: DATA_SOURCE_ID })).templates, [{ id: TEMPLATE_ID, name: "Project", is_default: true }]);

  const queried = await notion.dataSources.query({
    data_source_id: DATA_SOURCE_ID,
    filter: { property: "Name", title: { equals: "Alpha" } },
    filter_properties: ["title"],
  });
  assert.deepEqual(queried.results.map((page) => page.id), [PAGE_ID]);
  assert.deepEqual(Object.keys(queried.results[0].properties), ["Name"]);

  const page = await notion.pages.retrieve({ page_id: PAGE_ID });
  assert.equal(page.url, `http://notion.worldfixture.test/notion/${PAGE_ID.replaceAll("-", "")}`);
  assert.equal(page.public_url, null);
});

test("official JavaScript SDK 5.26.0 writes pages, blocks, comments, and trash fields", async () => {
  const { notion } = fixture();
  const created = await notion.pages.create({
    parent: { type: "data_source_id", data_source_id: DATA_SOURCE_ID },
    properties: { Name: { type: "title", title: [{ type: "text", text: { content: "Beta" } }] }, Rank: { type: "number", number: 2 } },
    template: { type: "template_id", template_id: TEMPLATE_ID, timezone: "Asia/Jerusalem" },
  });
  const templateChildren = await notion.blocks.children.list({ block_id: created.id });
  assert.equal(templateChildren.results[0].type, "heading_2");

  const appended = await notion.blocks.children.append({
    block_id: created.id,
    children: [{ object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: "SDK block" } }] } }],
    position: { type: "start" },
  });
  assert.equal(appended.results[0].type, "paragraph");
  const comment = await notion.comments.create({ parent: { page_id: created.id }, rich_text: [{ type: "text", text: { content: "SDK comment" } }] });
  assert.equal((await notion.comments.list({ block_id: created.id })).results[0].id, comment.id);

  const trashed = await notion.pages.update({ page_id: created.id, in_trash: true });
  assert.equal(trashed.in_trash, true);
  assert.equal((await notion.pages.update({ page_id: created.id, in_trash: false })).in_trash, false);
  assert.equal((await notion.pages.update({ page_id: created.id, is_locked: true })).is_locked, true);
  assert.equal((await notion.pages.update({ page_id: created.id, is_locked: false })).is_locked, false);
  assert.equal((await notion.databases.update({ database_id: DATABASE_ID, is_locked: true })).is_locked, true);
  assert.equal((await notion.databases.update({ database_id: DATABASE_ID, is_locked: false })).is_locked, false);
});

test("official JavaScript SDK 5.26.0 runs the full cached view query lifecycle", async () => {
  const { notion } = fixture();
  const listed = await notion.views.list({ database_id: DATABASE_ID });
  assert.deepEqual(listed.results[0], { object: "view", id: VIEW_ID });
  assert.equal((await notion.views.retrieve({ view_id: VIEW_ID })).name, "Ranked");

  const query = await notion.views.queries.create({ view_id: VIEW_ID, page_size: 1 });
  assert.equal(query.object, "view_query");
  const page = await notion.views.queries.results({ view_id: VIEW_ID, query_id: query.id, page_size: 1 });
  assert.equal(page.type, "page");
  assert.deepEqual(await notion.views.queries.delete({ view_id: VIEW_ID, query_id: query.id }), { object: "view_query", id: query.id, deleted: true });

  await assert.rejects(
    notion.dataSources.query({ data_source_id: DATA_SOURCE_ID, result_type: "invalid" }),
    (error) => error instanceof APIResponseError && error.code === "validation_error",
  );
});

test("official JavaScript SDK 5.26.0 creates and queries attendee meeting notes", async () => {
  const { notion } = fixture();
  const queried = await notion.blocks.meetingNotes.query({
    filter: { operator: "and", filters: [{ property: "title", filter: { operator: "string_contains", value: { type: "exact", value: "Weekly" } } }] },
    sort: [{ property: "created_time", direction: "descending" }],
    limit: 10,
  });
  assert.deepEqual(queried.results.map((block) => block.id), [MEETING_NOTE_ID]);

  const source = (await notion.blocks.children.list({ block_id: TEMPLATE_ID })).results[0];
  const created = await notion.blocks.meetingNotes.create({ source: { type: "block", block_id: source.id }, title: "SDK meeting", language: "en" });
  assert.equal(created.type, "meeting_notes");
  assert.equal(created.meeting_notes.title[0].plain_text, "SDK meeting");
});
