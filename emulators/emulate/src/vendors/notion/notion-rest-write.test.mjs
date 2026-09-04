import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "@emulators/core";

import { plugin, seedFromConfig } from "./index.mjs";
import { createNotionDomain } from "./domain.mjs";
import { NOTION_VERSION } from "./rest.mjs";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_ID = "00000000-0000-4000-8000-000000000002";
const PAGE_ID = "10000000-0000-4000-8000-000000000001";
const PRIVATE_PAGE_ID = "10000000-0000-4000-8000-000000000002";
const EMOJI_ID = "b0000000-0000-4000-8000-000000000001";

function fixture() {
  const baseUrl = "http://notion.worldfixture.test";
  const server = createServer(plugin, {
    baseUrl,
    tokens: {
      full: { login: "maya@example.test", id: 1, scopes: ["read:content", "insert:content", "update:content"] },
      legacy: { login: "maya@example.test", id: 2, scopes: ["read:content", "write:content"] },
      read: { login: "maya@example.test", id: 3, scopes: ["read:content"] },
    },
  });
  seedFromConfig(server.store, baseUrl, {
    users: [
      { id: USER_ID, name: "Maya", email: "maya@example.test" },
      { id: OTHER_ID, name: "Theo", email: "theo@example.test" },
    ],
    custom_emojis: [{ id: EMOJI_ID, name: "northstar", url: "https://assets.example.test/northstar.png" }],
    pages: [
      { id: PAGE_ID, title: "Public parent", created_by: USER_ID, accessible_by: [USER_ID], children: [{ type: "paragraph", text: "Existing" }] },
      { id: PRIVATE_PAGE_ID, title: "Private", created_by: OTHER_ID, accessible_by: [OTHER_ID] },
    ],
  });
  return server;
}

function headers(token = "full") {
  return { Authorization: `Bearer ${token}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" };
}

async function json(response) { return response.json(); }

async function request(app, path, method, value, token = "full") {
  const response = await app.request(path, { method, headers: headers(token), ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  return { response, value: await json(response) };
}

test("database creation also creates one data source and one table view", async () => {
  const { app } = fixture();
  const created = await request(app, "/v1/databases", "POST", {
    parent: { type: "page_id", page_id: PAGE_ID },
    title: [{ type: "text", text: { content: "Projects" }, plain_text: "Projects" }],
    initial_data_source: { properties: { Name: { type: "title", title: {} }, Status: { type: "status", status: {} } } },
  });
  assert.equal(created.response.status, 200);
  assert.equal(created.value.object, "database");
  assert.equal(created.value.data_sources.length, 1);
  assert.notEqual(created.value.id, created.value.data_sources[0].id);

  const sourceId = created.value.data_sources[0].id;
  const source = await request(app, `/v1/data_sources/${sourceId}`, "GET");
  assert.equal(source.response.status, 200);
  assert.equal(source.value.parent.database_id, created.value.id);
  assert.deepEqual(Object.keys(source.value.properties), ["Name", "Status"]);

  const listed = await request(app, `/v1/views?database_id=${created.value.id}&page_size=1`, "GET");
  assert.equal(listed.response.status, 200);
  assert.equal(listed.value.results.length, 1);
  assert.deepEqual(Object.keys(listed.value.results[0]), ["object", "id"]);
  assert.equal((await request(app, `/v1/views/${listed.value.results[0].id}`, "GET")).value.type, "table");
  assert.notEqual(listed.value.results[0].id, sourceId);
});

test("data source writes, page queries, moves, and pagination share state", async () => {
  const { app } = fixture();
  const database = (await request(app, "/v1/databases", "POST", { parent: { type: "page_id", page_id: PAGE_ID }, title: [], initial_data_source: { properties: { Name: { type: "title" } } } })).value;
  const second = await request(app, "/v1/data_sources", "POST", { parent: { type: "database_id", database_id: database.id }, title: "Tasks", properties: { Name: { type: "title" }, Remove: { type: "rich_text" } } });
  assert.equal(second.response.status, 200);

  const updated = await request(app, `/v1/data_sources/${second.value.id}`, "PATCH", { properties: { Remove: null, Done: { type: "checkbox" } } });
  assert.equal(updated.response.status, 200);
  assert.equal(Object.hasOwn(updated.value.properties, "Remove"), false);
  assert.equal(updated.value.properties.Done.type, "checkbox");

  const first = await request(app, "/v1/pages", "POST", { parent: { type: "data_source_id", data_source_id: second.value.id }, properties: { Name: { type: "title", title: [{ type: "text", text: { content: "Alpha" }, plain_text: "Alpha" }] }, Done: { type: "checkbox", checkbox: true } } });
  const secondPage = await request(app, "/v1/pages", "POST", { parent: { type: "data_source_id", data_source_id: second.value.id }, title: "Beta" });
  assert.equal(first.response.status, 200);
  assert.equal(secondPage.response.status, 200);

  const query = await request(app, `/v1/data_sources/${second.value.id}/query`, "POST", { filter: { property: "Done", checkbox: { equals: true } }, page_size: 1 });
  assert.equal(query.response.status, 200);
  assert.deepEqual(query.value.results.map((page) => page.id), [first.value.id]);

  const moved = await request(app, `/v1/pages/${secondPage.value.id}/move`, "POST", { parent: { type: "page_id", page_id: PAGE_ID } });
  assert.equal(moved.response.status, 200);
  assert.equal(moved.value.parent.page_id, PAGE_ID);
});

test("REST search discovers current data sources with the 2026-03-11 result type", async () => {
  const { app } = fixture();
  await request(app, "/v1/databases", "POST", {
    parent: { type: "page_id", page_id: PAGE_ID },
    title: "Projects",
    initial_data_source: { properties: { Name: { type: "title" } } },
  });
  const response = await app.request("/v1/search", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ filter: { property: "object", value: "data_source" }, page_size: 1 }),
  });
  assert.equal(response.status, 200);
  const result = await json(response);
  assert.equal(result.type, "page_or_data_source");
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].object, "data_source");
});

test("block append position, nested ACL, update, and delete use current fields", async () => {
  const { app } = fixture();
  const current = (await request(app, `/v1/blocks/${PAGE_ID}/children`, "GET")).value.results[0];
  const append = await request(app, `/v1/blocks/${PAGE_ID}/children`, "PATCH", {
    children: [{ type: "toggle", toggle: { rich_text: [], color: "default", children: [{ type: "paragraph", paragraph: { rich_text: [], color: "default" } }] } }],
    position: { type: "start" },
  });
  assert.equal(append.response.status, 200);
  assert.equal(append.value.results[0].has_children, true);
  const ordered = (await request(app, `/v1/blocks/${PAGE_ID}/children`, "GET")).value.results;
  assert.deepEqual(ordered.map((block) => block.id), [append.value.results[0].id, current.id]);

  const changed = await request(app, `/v1/blocks/${append.value.results[0].id}`, "PATCH", { toggle: { rich_text: [{ type: "text", text: { content: "Changed" }, plain_text: "Changed" }] } });
  assert.equal(changed.value.toggle.rich_text[0].plain_text, "Changed");
  const removed = await request(app, `/v1/blocks/${append.value.results[0].id}`, "DELETE");
  assert.equal(removed.value.in_trash, true);
  assert.equal((await request(app, `/v1/blocks/${PAGE_ID}/children`, "GET")).value.results.length, 1);
});

test("block creation enforces current type and nesting contracts", async () => {
  const { app } = fixture();
  const valid = await request(app, `/v1/blocks/${PAGE_ID}/children`, "PATCH", {
    children: [
      {
        type: "column_list", column_list: { children: [
          { type: "column", column: { width_ratio: 0.4, children: [{ type: "paragraph", paragraph: { rich_text: [] } }] } },
          { type: "column", column: { width_ratio: 0.6, children: [{ type: "image", image: { type: "external", external: { url: "https://example.test/launch.png" } } }] } },
        ] },
      },
      {
        type: "table", table: { table_width: 2, has_column_header: true, has_row_header: false, children: [{ type: "table_row", table_row: { cells: [[], []] } }] },
      },
    ],
  });
  assert.equal(valid.response.status, 200, JSON.stringify(valid.value));
  assert.deepEqual(valid.value.results.map((block) => block.type), ["column_list", "table"]);

  const badColumn = await request(app, `/v1/blocks/${PAGE_ID}/children`, "PATCH", { children: [{ type: "column", column: { children: [{ type: "paragraph", paragraph: { rich_text: [] } }] } }] });
  assert.equal(badColumn.response.status, 400);
  assert.match(badColumn.value.message, /column_list/);

  const badHeading = await request(app, `/v1/blocks/${PAGE_ID}/children`, "PATCH", { children: [{ type: "heading_1", heading_1: { rich_text: [], is_toggleable: false, children: [{ type: "paragraph", paragraph: { rich_text: [] } }] } }] });
  assert.equal(badHeading.response.status, 400);
  assert.match(badHeading.value.message, /cannot contain/);

  const badTable = await request(app, `/v1/blocks/${PAGE_ID}/children`, "PATCH", { children: [{ type: "table", table: { table_width: 2, children: [{ type: "table_row", table_row: { cells: [[]] } }] } }] });
  assert.equal(badTable.response.status, 400);
  assert.match(badTable.value.message, /table_width/);

  const oldType = await request(app, `/v1/blocks/${PAGE_ID}/children`, "PATCH", { children: [{ type: "transcription", transcription: {} }] });
  assert.equal(oldType.response.status, 400);
});

test("every current creatable block type rejects an invalid required shape", async () => {
  const { app } = fixture();
  const invalid = [
    { type: "audio", audio: { type: "external", external: { url: "not a URL" } } },
    { type: "bookmark", bookmark: {} },
    { type: "breadcrumb", breadcrumb: { children: [{ type: "paragraph", paragraph: { rich_text: [] } }] } },
    { type: "bulleted_list_item", bulleted_list_item: {} },
    { type: "callout", callout: {} },
    { type: "code", code: { rich_text: [] } },
    { type: "column", column: { children: [] } },
    { type: "column_list", column_list: { children: [] } },
    { type: "divider", divider: { children: [{ type: "paragraph", paragraph: { rich_text: [] } }] } },
    { type: "embed", embed: {} },
    { type: "equation", equation: {} },
    { type: "file", file: { type: "external", external: { url: "not a URL" } } },
    { type: "heading_1", heading_1: {} },
    { type: "heading_2", heading_2: {} },
    { type: "heading_3", heading_3: {} },
    { type: "heading_4", heading_4: {} },
    { type: "image", image: { type: "external", external: { url: "not a URL" } } },
    { type: "link_to_page", link_to_page: { type: "page_id" } },
    { type: "numbered_list_item", numbered_list_item: {} },
    { type: "paragraph", paragraph: {} },
    { type: "pdf", pdf: { type: "external", external: { url: "not a URL" } } },
    { type: "quote", quote: {} },
    { type: "synced_block", synced_block: {} },
    { type: "table", table: { children: [] } },
    { type: "table_of_contents", table_of_contents: { children: [{ type: "paragraph", paragraph: { rich_text: [] } }] } },
    { type: "table_row", table_row: {} },
    { type: "tab", tab: {} },
    { type: "template", template: {} },
    { type: "to_do", to_do: {} },
    { type: "toggle", toggle: {} },
    { type: "video", video: { type: "external", external: { url: "not a URL" } } },
  ];
  for (const block of invalid) {
    const result = await request(app, `/v1/blocks/${PAGE_ID}/children`, "PATCH", { children: [block] });
    assert.equal(result.response.status, 400, `${block.type} accepted an invalid request shape`);
  }
});

test("data-source queries support typed filters, rollups, timestamps, trash, and property projection", async () => {
  const { app } = fixture();
  const database = (await request(app, "/v1/databases", "POST", {
    parent: { type: "page_id", page_id: PAGE_ID },
    initial_data_source: { properties: { Name: { type: "title" }, Score: { type: "number" } } },
  })).value;
  const sourceId = database.data_sources[0].id;
  const text = (content) => [{ type: "text", text: { content }, plain_text: content }];
  const alpha = await request(app, "/v1/pages", "POST", {
    parent: { type: "data_source_id", data_source_id: sourceId },
    properties: {
      Name: { id: "title", type: "title", title: text("Alpha launch") },
      Score: { id: "score", type: "number", number: 8 },
      Active: { id: "active", type: "checkbox", checkbox: true },
      Status: { id: "status", type: "status", status: { name: "In progress" } },
      Tags: { id: "tags", type: "multi_select", multi_select: [{ id: "red", name: "Red" }] },
      Owner: { id: "owner", type: "people", people: [{ id: USER_ID }] },
      Due: { id: "due", type: "date", date: { start: "2026-09-05" } },
      Formula: { id: "formula", type: "formula", formula: { type: "number", number: 16 } },
      FormulaCheckbox: { id: "formula_checkbox", type: "formula", formula: { type: "checkbox", checkbox: true } },
      FormulaDate: { id: "formula_date", type: "formula", formula: { type: "date", date: { start: "2026-09-03", end: null, time_zone: null } } },
      FormulaString: { id: "formula_string", type: "formula", formula: { type: "string", string: "Ready" } },
      Rollup: { id: "rollup", type: "rollup", rollup: { type: "array", array: [{ type: "number", number: 3 }, { type: "number", number: 7 }] } },
      RollupDate: { id: "rollup_date", type: "rollup", rollup: { type: "date", date: { start: "2026-09-03", end: null, time_zone: null } } },
      RollupNumber: { id: "rollup_number", type: "rollup", rollup: { type: "number", number: 7 } },
      Ticket: { id: "ticket", type: "unique_id", unique_id: { prefix: "PRJ", number: 42 } },
    },
  });
  assert.equal(alpha.response.status, 200);

  async function query(filter, suffix = "") {
    return request(app, `/v1/data_sources/${sourceId}/query${suffix}`, "POST", { filter });
  }
  assert.equal((await query({ property: "Name", title: { starts_with: "Alpha" } })).value.results.length, 1);
  assert.equal((await query({ property: "Score", number: { greater_than_or_equal_to: 8 } })).value.results.length, 1);
  assert.equal((await query({ property: "Status", status: { equals: ["Done", "In progress"] } })).value.results.length, 1);
  assert.equal((await query({ property: "Tags", multi_select: { contains: "Red" } })).value.results.length, 1);
  assert.equal((await query({ property: "Owner", people: { contains: "me" } })).value.results.length, 1);
  assert.equal((await query({ property: "Due", date: { next_week: {} } })).value.results.length, 1);
  assert.equal((await query({ property: "Formula", formula: { number: { greater_than: 15 } } })).value.results.length, 1);
  assert.equal((await query({ property: "FormulaCheckbox", formula: { checkbox: { equals: true } } })).value.results.length, 1);
  assert.equal((await query({ property: "FormulaDate", formula: { date: { on_or_before: "2026-09-03" } } })).value.results.length, 1);
  assert.equal((await query({ property: "FormulaString", formula: { string: { equals: "Ready" } } })).value.results.length, 1);
  assert.equal((await query({ property: "Rollup", rollup: { any: { number: { greater_than: 5 } } } })).value.results.length, 1);
  assert.equal((await query({ property: "Rollup", rollup: { every: { number: { greater_than: 2 } } } })).value.results.length, 1);
  assert.equal((await query({ property: "Rollup", rollup: { none: { number: { greater_than: 8 } } } })).value.results.length, 1);
  assert.equal((await query({ property: "RollupDate", rollup: { date: { equals: "2026-09-03" } } })).value.results.length, 1);
  assert.equal((await query({ property: "RollupNumber", rollup: { number: { equals: 7 } } })).value.results.length, 1);
  assert.equal((await query({ property: "Ticket", unique_id: { equals: 42 } })).value.results.length, 1);
  assert.equal((await query({ timestamp: "created_time", created_time: { on_or_after: "2026-09-03" } })).value.results.length, 1);
  assert.equal((await query({ timestamp: "created_time", created_time: { equals: "2026-09-03" } })).value.results.length, 1);
  assert.equal((await query({ timestamp: "last_edited_time", last_edited_time: { before: "2026-09-04" } })).value.results.length, 1);
  assert.equal((await query({ timestamp: "last_edited_time", last_edited_time: { after: "2026-09-02" } })).value.results.length, 1);
  assert.equal((await query({ timestamp: "last_edited_time", last_edited_time: { on_or_before: "2026-09-03" } })).value.results.length, 1);

  const compound = await query({ and: [
    { property: "FormulaCheckbox", formula: { checkbox: { equals: true } } },
    { or: [
      { property: "FormulaString", formula: { string: { equals: "Ready" } } },
      { timestamp: "created_time", created_time: { before: "2026-09-01" } },
    ] },
  ] });
  assert.equal(compound.value.results.length, 1);
  const tooMany = await query({ and: Array.from({ length: 101 }, () => ({ property: "Score", number: { equals: 8 } })) });
  assert.equal(tooMany.response.status, 400);
  const tooDeep = await query({ and: [{ or: [{ and: [{ property: "Score", number: { equals: 8 } }] }] }] });
  assert.equal(tooDeep.response.status, 400);

  const projected = await request(app, `/v1/data_sources/${sourceId}/query?filter_properties%5B%5D=title&filter_properties%5B%5D=score`, "POST", { sorts: [{ property: "Score", direction: "descending" }] });
  assert.deepEqual(Object.keys(projected.value.results[0].properties), ["Name", "Score"]);

  assert.equal((await request(app, `/v1/pages/${alpha.value.id}`, "PATCH", { in_trash: true })).response.status, 200);
  assert.equal((await request(app, `/v1/data_sources/${sourceId}/query`, "POST", {})).value.results.length, 0);
  assert.equal((await request(app, `/v1/data_sources/${sourceId}/query`, "POST", { in_trash: true })).value.results.length, 1);

  const invalid = await query({ property: "Score", number: { approximately: 8 } });
  assert.equal(invalid.response.status, 400);
});

test("data-source queries report the official incomplete state after 10,000 results", async () => {
  const baseUrl = "http://notion.worldfixture.test";
  const databaseId = "30000000-0000-4000-8000-000000000077";
  const sourceId = "40000000-0000-4000-8000-000000000077";
  const server = createServer(plugin, { baseUrl, tokens: { full: { login: "maya@example.test", id: 1, scopes: ["read:content"] } } });
  seedFromConfig(server.store, baseUrl, {
    users: [{ id: USER_ID, name: "Maya", email: "maya@example.test" }],
    databases: [{ id: databaseId, title: "Large", accessible_by: [USER_ID] }],
    data_sources: [{ id: sourceId, database_id: databaseId, name: "Large", accessible_by: [USER_ID], properties: { Name: { type: "title" } } }],
    pages: Array.from({ length: 10_001 }, (_, index) => ({
      id: `11000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      parent: { type: "data_source_id", data_source_id: sourceId }, title: `Row ${index}`, created_by: USER_ID, accessible_by: [USER_ID],
    })),
  });
  const first = await request(server.app, `/v1/data_sources/${sourceId}/query`, "POST", { page_size: 100 });
  assert.equal(first.response.status, 200);
  assert.equal(first.value.has_more, true);
  assert.deepEqual(first.value.request_status, { type: "incomplete", incomplete_reason: "query_result_limit_reached" });
});

test("wiki queries return pages and child database data sources", async () => {
  const baseUrl = "http://notion.worldfixture.test";
  const wikiDatabaseId = "30000000-0000-4000-8000-000000000088";
  const wikiSourceId = "40000000-0000-4000-8000-000000000088";
  const server = createServer(plugin, { baseUrl, tokens: { full: { login: "maya@example.test", id: 1, scopes: ["read:content", "insert:content", "update:content"] } } });
  seedFromConfig(server.store, baseUrl, {
    users: [{ id: USER_ID, name: "Maya", email: "maya@example.test" }],
    databases: [{ id: wikiDatabaseId, title: "Knowledge", accessible_by: [USER_ID] }],
    data_sources: [{ id: wikiSourceId, database_id: wikiDatabaseId, name: "Knowledge", is_wiki: true, accessible_by: [USER_ID] }],
    pages: [{ id: PAGE_ID, parent: { type: "data_source_id", data_source_id: wikiSourceId }, title: "Runbook", created_by: USER_ID, accessible_by: [USER_ID] }],
  });
  const child = await request(server.app, "/v1/databases", "POST", {
    parent: { type: "data_source_id", data_source_id: wikiSourceId }, title: "Services", initial_data_source: { properties: { Name: { type: "title" } } },
  });
  assert.equal(child.response.status, 200);
  const childSourceId = child.value.data_sources[0].id;

  const all = await request(server.app, `/v1/data_sources/${wikiSourceId}/query`, "POST", {});
  assert.deepEqual(all.value.results.map((item) => item.object), ["page", "data_source"]);
  assert.equal(all.value.results[1].id, childSourceId);
  assert.deepEqual((await request(server.app, `/v1/data_sources/${wikiSourceId}/query`, "POST", { result_type: "page" })).value.results.map((item) => item.id), [PAGE_ID]);
  assert.deepEqual((await request(server.app, `/v1/data_sources/${wikiSourceId}/query`, "POST", { result_type: "data_source" })).value.results.map((item) => item.id), [childSourceId]);
});

test("custom emojis list by exact name and expand when used as page icons", async () => {
  const { app } = fixture();
  const listed = await request(app, "/v1/custom_emojis?name=northstar&page_size=1", "GET");
  assert.equal(listed.response.status, 200);
  assert.equal(listed.value.type, "custom_emoji");
  assert.deepEqual(listed.value.results, [{ id: EMOJI_ID, name: "northstar", url: "https://assets.example.test/northstar.png" }]);
  assert.equal((await request(app, "/v1/custom_emojis?name=Northstar", "GET")).value.results.length, 0);

  const created = await request(app, "/v1/pages", "POST", {
    parent: { type: "page_id", page_id: PAGE_ID },
    title: "Emoji page",
    icon: { type: "custom_emoji", custom_emoji: { id: EMOJI_ID } },
  });
  assert.deepEqual(created.value.icon.custom_emoji, { id: EMOJI_ID, name: "northstar", url: "https://assets.example.test/northstar.png" });
});

test("data-source templates apply after the create response and pages use PATCH for trash", async () => {
  const baseUrl = "http://notion.worldfixture.test";
  const templateId = "10000000-0000-4000-8000-000000000099";
  const databaseId = "30000000-0000-4000-8000-000000000099";
  const sourceId = "40000000-0000-4000-8000-000000000099";
  const server = createServer(plugin, { baseUrl, tokens: { full: { login: "maya@example.test", id: 1, scopes: ["read:content", "insert:content", "update:content"] } } });
  seedFromConfig(server.store, baseUrl, {
    users: [{ id: USER_ID, name: "Maya", email: "maya@example.test" }],
    databases: [{ id: databaseId, title: "Incidents", accessible_by: [USER_ID] }],
    data_sources: [{
      id: sourceId, database_id: databaseId, name: "Incidents", accessible_by: [USER_ID],
      templates: [{ id: templateId, name: "Postmortem", is_default: true }],
    }],
    pages: [{
      id: templateId, parent: { type: "data_source_id", data_source_id: sourceId }, created_by: USER_ID, accessible_by: [USER_ID],
      properties: { Name: { id: "title", type: "title", title: [{ type: "text", text: { content: "Postmortem" }, plain_text: "Postmortem" }] }, Status: { id: "status", type: "status", status: { name: "Draft" } } },
      children: [{ type: "heading_2", heading_2: { rich_text: [{ type: "text", text: { content: "Impact" }, plain_text: "Impact" }], is_toggleable: false } }],
    }],
  });

  const templates = await request(server.app, `/v1/data_sources/${sourceId}/templates`, "GET");
  assert.deepEqual(templates.value.templates, [{ id: templateId, name: "Postmortem", is_default: true }]);
  const created = await request(server.app, "/v1/pages", "POST", {
    parent: { type: "data_source_id", data_source_id: sourceId },
    properties: { Name: { id: "title", type: "title", title: [{ type: "text", text: { content: "Incident 14" }, plain_text: "Incident 14" }] } },
    template: { type: "template_id", template_id: templateId, timezone: "Asia/Jerusalem" },
  });
  assert.equal(created.response.status, 200);
  assert.deepEqual(Object.keys(created.value.properties), ["Name"]);

  const afterApply = await request(server.app, `/v1/pages/${created.value.id}`, "GET");
  assert.deepEqual(Object.keys(afterApply.value.properties), ["Name", "Status"]);
  const children = await request(server.app, `/v1/blocks/${created.value.id}/children`, "GET");
  assert.equal(children.value.results[0].heading_2.rich_text[0].plain_text, "Impact");

  const trashed = await request(server.app, `/v1/pages/${created.value.id}`, "PATCH", { in_trash: true });
  assert.equal(trashed.value.in_trash, true);
  assert.equal((await request(server.app, `/v1/pages/${created.value.id}`, "PATCH", { in_trash: false })).value.in_trash, false);

  const invalid = await request(server.app, "/v1/pages", "POST", {
    parent: { type: "data_source_id", data_source_id: sourceId }, template: { type: "default" }, children: [],
  });
  assert.equal(invalid.response.status, 400);
});

test("views validate, paginate, mutate, and protect the last view", async () => {
  const { app } = fixture();
  const database = (await request(app, "/v1/databases", "POST", { parent: { type: "page_id", page_id: PAGE_ID }, initial_data_source: { properties: {} } })).value;
  const sourceId = database.data_sources[0].id;
  const created = await request(app, "/v1/views", "POST", { database_id: database.id, data_source_id: sourceId, name: "Board", type: "board" });
  assert.equal(created.response.status, 200);
  const updated = await request(app, `/v1/views/${created.value.id}`, "PATCH", { name: "Planning", quick_filters: { Status: { equals: "Open" } } });
  assert.equal(updated.value.name, "Planning");
  assert.deepEqual(updated.value.quick_filters.Status, { equals: "Open" });
  assert.equal((await request(app, `/v1/views/${created.value.id}`, "DELETE")).response.status, 200);
  const remaining = (await request(app, `/v1/views?database_id=${database.id}`, "GET")).value.results[0];
  assert.equal((await request(app, `/v1/views/${remaining.id}`, "DELETE")).response.status, 400);
});

test("views support dashboard widgets, linked databases, and tab positions", async () => {
  const { app } = fixture();
  const database = (await request(app, "/v1/databases", "POST", { parent: { type: "page_id", page_id: PAGE_ID }, initial_data_source: { properties: {} } })).value;
  const sourceId = database.data_sources[0].id;
  const dashboard = await request(app, "/v1/views", "POST", { database_id: database.id, data_source_id: sourceId, name: "Operations", type: "dashboard", position: { type: "start" } });
  assert.equal(dashboard.response.status, 200);
  const widget = await request(app, "/v1/views", "POST", {
    view_id: dashboard.value.id, data_source_id: sourceId, name: "Open items", type: "chart",
    placement: { type: "new_row", row_index: 0 }, configuration: { type: "chart", chart_type: "bar" },
  });
  assert.equal(widget.response.status, 200);
  assert.equal(widget.value.dashboard_parent_view_id, dashboard.value.id);

  const linked = await request(app, "/v1/views", "POST", {
    create_database: { parent: { type: "page_id", page_id: PAGE_ID }, title: "Linked projects" },
    data_source_id: sourceId, name: "Map", type: "map",
  });
  assert.equal(linked.response.status, 200);
  assert.notEqual(linked.value.parent.database_id, database.id);
  const linkedDatabase = await request(app, `/v1/databases/${linked.value.parent.database_id}`, "GET");
  assert.deepEqual(linkedDatabase.value.data_sources, [{ id: sourceId, name: "Untitled" }]);

  const listed = await request(app, `/v1/views?database_id=${database.id}`, "GET");
  assert.equal(listed.value.results[0].id, dashboard.value.id);
  const invalid = await request(app, "/v1/views", "POST", { database_id: database.id, view_id: dashboard.value.id, data_source_id: sourceId, name: "Bad", type: "table" });
  assert.equal(invalid.response.status, 400);
});

test("cached view queries keep stable pages and delete idempotently", async () => {
  const { app } = fixture();
  const database = (await request(app, "/v1/databases", "POST", {
    parent: { type: "page_id", page_id: PAGE_ID }, initial_data_source: { properties: { Name: { type: "title" }, Rank: { type: "number" }, Active: { type: "checkbox" } } },
  })).value;
  const sourceId = database.data_sources[0].id;
  const rows = [];
  for (const [name, rank, active] of [["One", 1, true], ["Two", 2, true], ["Three", 3, false]]) {
    rows.push((await request(app, "/v1/pages", "POST", {
      parent: { type: "data_source_id", data_source_id: sourceId },
      properties: { Name: { type: "title", title: [{ type: "text", text: { content: name }, plain_text: name }] }, Rank: { type: "number", number: rank }, Active: { type: "checkbox", checkbox: active } },
    })).value);
  }
  const view = await request(app, "/v1/views", "POST", {
    database_id: database.id, data_source_id: sourceId, name: "Active", type: "table",
    filter: { property: "Active", checkbox: { equals: true } }, sorts: [{ property: "Rank", direction: "ascending" }],
  });
  const cached = await request(app, `/v1/views/${view.value.id}/queries`, "POST", { page_size: 1 });
  assert.equal(cached.response.status, 200);
  assert.equal(cached.value.object, "view_query");
  assert.equal(cached.value.total_count, 2);
  assert.deepEqual(cached.value.results, [{ object: "page", id: rows[0].id }]);

  await request(app, `/v1/pages/${rows[1].id}`, "PATCH", { properties: { Active: { type: "checkbox", checkbox: false } } });
  const next = await request(app, `/v1/views/${view.value.id}/queries/${cached.value.id}?start_cursor=${cached.value.next_cursor}&page_size=1`, "GET");
  assert.deepEqual(next.value.results, [{ object: "page", id: rows[1].id }]);
  assert.equal(next.value.type, "page");

  const removed = await request(app, `/v1/views/${view.value.id}/queries/${cached.value.id}`, "DELETE");
  assert.deepEqual(removed.value, { object: "view_query", id: cached.value.id, deleted: true });
  assert.equal((await request(app, `/v1/views/${view.value.id}/queries/${cached.value.id}`, "DELETE")).response.status, 200);
  assert.equal((await request(app, `/v1/views/${view.value.id}/queries/${cached.value.id}`, "GET")).response.status, 404);
});

test("permissions, legacy capability compatibility, and validation hide inaccessible objects", async () => {
  const { app } = fixture();
  assert.equal((await request(app, "/v1/databases", "POST", { parent: { type: "page_id", page_id: PAGE_ID }, initial_data_source: { properties: {} } }, "read")).response.status, 403);
  assert.equal((await request(app, "/v1/pages", "POST", { parent: { type: "page_id", page_id: PAGE_ID }, title: "Legacy" }, "legacy")).response.status, 200);
  assert.equal((await request(app, `/v1/pages/${PRIVATE_PAGE_ID}`, "PATCH", { icon: { type: "emoji", emoji: "x" } })).response.status, 404);
  assert.equal((await request(app, `/v1/blocks/${PAGE_ID}/children`, "PATCH", { children: [], after: "x" })).response.status, 400);
  assert.equal((await request(app, "/v1/views", "GET")).response.status, 400);
});

test("MCP adapters use shared REST state and expose completed async tasks", () => {
  const { store, baseUrl } = fixture();
  const domain = createNotionDomain(store, baseUrl);
  const actor = domain.userByLogin("maya@example.test");
  const created = domain.mcpCreatePages({ pages: [{ title: "Draft" }], allow_async: true }, actor);
  assert.equal(created.async_task.status, "succeeded");
  assert.equal(domain.mcpGetAsyncTask({ id: created.async_task.id }, actor).result.pages.length, 1);
  assert.equal(domain.observability().asyncTasks.length, 1);
  assert.equal(domain.observability().changes.some((change) => change.topic === "page.created"), true);
});
