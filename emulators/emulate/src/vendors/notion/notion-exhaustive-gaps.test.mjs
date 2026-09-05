import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "@emulators/core";

import { createNotionDomain } from "./domain.mjs";
import { plugin, seedFromConfig } from "./index.mjs";
import { NOTION_VERSION } from "./rest.mjs";

const USER = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const PAGE = "10000000-0000-4000-8000-000000000001";
const TEMPLATE = "10000000-0000-4000-8000-000000000002";
const DATABASE = "30000000-0000-4000-8000-000000000001";
const SOURCE = "40000000-0000-4000-8000-000000000001";
const UPLOAD = "90000000-0000-4000-8000-000000000001";

const headers = { Authorization: "Bearer full", "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" };

function fixture(overrides = {}) {
  const baseUrl = "http://notion.worldfixture.test";
  const server = createServer(plugin, { baseUrl, tokens: { full: { login: "maya@example.test", id: 1, scopes: ["read:user", "read:content", "insert:content", "update:content", "read:comment", "insert:comment"] } } });
  seedFromConfig(server.store, baseUrl, {
    workspace: { id: "60000000-0000-4000-8000-000000000001", name: "Exhaustive" },
    users: [
      { id: USER, name: "Maya Chen", email: "maya@example.test" },
      { id: OTHER, name: "Theo Bell", email: "theo@example.test" },
      { id: "00000000-0000-4000-8000-000000000003", name: "Rina Park", email: "rina@example.test" },
    ],
    teamspaces: [
      { id: "61000000-0000-4000-8000-000000000001", name: "Product", member_ids: [USER] },
      { id: "61000000-0000-4000-8000-000000000002", name: "Support", member_ids: [OTHER] },
    ],
    custom_emojis: [
      { id: "b0000000-0000-4000-8000-000000000001", name: "alpha", url: "https://assets.example.test/alpha.png" },
      { id: "b0000000-0000-4000-8000-000000000002", name: "beta", url: "https://assets.example.test/beta.png" },
      { id: "b0000000-0000-4000-8000-000000000003", name: "gamma", url: "https://assets.example.test/gamma.png" },
    ],
    databases: [{ id: DATABASE, title: "Projects", accessible_by: [USER] }],
    data_sources: [{
      id: SOURCE, database_id: DATABASE, name: "Projects", accessible_by: [USER],
      properties: { Name: { id: "title", type: "title" }, Status: { id: "status", type: "status" }, Date: { id: "date", type: "date" } },
      templates: [{ id: TEMPLATE, name: "Default project", is_default: true }],
    }],
    pages: [
      { id: PAGE, title: "Root", created_by: USER, accessible_by: [USER], children: [{ type: "paragraph", text: "Remove me" }] },
      {
        id: TEMPLATE, parent: { type: "data_source_id", data_source_id: SOURCE }, created_by: USER, accessible_by: [USER],
        properties: { Name: { id: "title", type: "title", title: [{ type: "text", text: { content: "Template" } }] }, Status: { id: "status", type: "status", status: { name: "Draft" } } },
        children: [{ type: "heading_2", heading_2: { rich_text: [{ type: "text", text: { content: "Template section" } }], is_toggleable: false } }],
      },
      { id: "10000000-0000-4000-8000-000000000010", title: "Release skill", created_by: USER, accessible_by: [USER], teamspace_id: "61000000-0000-4000-8000-000000000001", is_skill: true, skill_description: "Product release" },
      { id: "10000000-0000-4000-8000-000000000011", title: "Support skill", created_by: USER, accessible_by: [USER], teamspace_id: "61000000-0000-4000-8000-000000000002", is_skill: true, skill_description: "Support process" },
    ],
    file_uploads: [{ id: UPLOAD, created_by: USER, status: "uploaded", filename: "meeting.mp3", content_type: "audio/mpeg", content_length: 12 }],
    meeting_notes: [{
      id: "20000000-0000-4000-8000-000000000090", parent: { page_id: PAGE }, title: "Weekly review", created_by: USER,
      created_time: "2026-09-03T09:00:00.000Z", last_edited_time: "2026-09-03T09:00:00.000Z",
      calendar_event: { start_time: "2026-09-03T09:00:00.000Z", end_time: "2026-09-03T09:30:00.000Z", attendees: [USER] },
    }],
    ...overrides,
  });
  return server;
}

async function request(app, path, method = "GET", body) {
  const response = await app.request(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

test("page templates cover default, none, missing default, and erase_content", async () => {
  const { app } = fixture();
  const applied = await request(app, "/v1/pages", "POST", { parent: { type: "data_source_id", data_source_id: SOURCE }, properties: { Name: { type: "title", title: [{ type: "text", text: { content: "Applied" } }] } }, template: { type: "default" } });
  assert.equal(applied.response.status, 200);
  assert.deepEqual(Object.keys((await request(app, `/v1/pages/${applied.body.id}`)).body.properties), ["Name", "Status"]);
  assert.equal((await request(app, `/v1/blocks/${applied.body.id}/children`)).body.results[0].type, "heading_2");

  const none = await request(app, "/v1/pages", "POST", { parent: { type: "data_source_id", data_source_id: SOURCE }, title: "No template", template: { type: "none" }, children: [{ type: "paragraph", paragraph: { rich_text: [] } }] });
  assert.equal(none.response.status, 200, JSON.stringify(none.body));
  assert.equal((await request(app, `/v1/blocks/${none.body.id}/children`)).body.results.length, 1);

  const erased = await request(app, `/v1/pages/${PAGE}`, "PATCH", { erase_content: true });
  assert.equal(erased.response.status, 200);
  assert.deepEqual((await request(app, `/v1/blocks/${PAGE}/children`)).body.results, []);

  const noDefaultServer = fixture({
    data_sources: [{ id: SOURCE, database_id: DATABASE, name: "Projects", accessible_by: [USER], properties: { Name: { id: "title", type: "title" } }, templates: [] }],
  });
  const noDefault = await request(noDefaultServer.app, "/v1/pages", "POST", { parent: { type: "data_source_id", data_source_id: SOURCE }, title: "No configured default", template: { type: "default" } });
  assert.equal(noDefault.response.status, 200);
  assert.deepEqual((await request(noDefaultServer.app, `/v1/blocks/${noDefault.body.id}/children`)).body.results, []);
});

test("views cover every type, dashboard placements, and data-source pagination", async () => {
  const { app, store } = fixture();
  const configurations = {
    table: { type: "table" },
    board: { type: "board", group_by: { type: "status", property_id: "status", group_by: "group", sort: { type: "manual" } } },
    list: { type: "list" },
    calendar: { type: "calendar", date_property_id: "date" },
    timeline: { type: "timeline", date_property_id: "date" },
    gallery: { type: "gallery" },
    form: { type: "form" },
    chart: { type: "chart", chart_type: "bar" },
    map: { type: "map" },
  };
  const created = [];
  for (const type of ["table", "board", "list", "calendar", "timeline", "gallery", "form", "chart", "map", "dashboard"]) {
    const result = await request(app, "/v1/views", "POST", { database_id: DATABASE, data_source_id: SOURCE, name: type, type, ...(configurations[type] ? { configuration: configurations[type] } : {}) });
    assert.equal(result.response.status, 200, `${type}: ${JSON.stringify(result.body)}`);
    assert.equal(result.body.type, type);
    created.push(result.body);
  }

  const listed = await request(app, `/v1/views?data_source_id=${SOURCE}&page_size=1`);
  assert.equal(listed.body.results.length, 1);
  assert.equal(listed.body.has_more, true);
  const next = await request(app, `/v1/views?data_source_id=${SOURCE}&page_size=1&start_cursor=${listed.body.next_cursor}`);
  assert.equal(next.body.results.length, 1);
  assert.notEqual(next.body.results[0].id, listed.body.results[0].id);

  const dashboard = created.find((item) => item.type === "dashboard");
  for (const placement of [{ type: "new_row", row_index: 0 }, { type: "existing_row", row_index: 0 }]) {
    const widget = await request(app, "/v1/views", "POST", { view_id: dashboard.id, data_source_id: SOURCE, name: placement.type, type: "chart", configuration: configurations.chart, placement });
    assert.equal(widget.response.status, 200);
    assert.deepEqual(store.collection("notion_views", ["notion_id", "database_id", "data_source_id"]).findOneBy("notion_id", widget.body.id).placement, placement);
  }
});

test("views accept the official after_view position field", async () => {
  const { app } = fixture();
  const first = await request(app, "/v1/views", "POST", { database_id: DATABASE, data_source_id: SOURCE, name: "First", type: "table" });
  assert.equal(first.response.status, 200);
  const after = await request(app, "/v1/views", "POST", { database_id: DATABASE, data_source_id: SOURCE, name: "After first", type: "table", position: { type: "after_view", view_id: first.body.id } });
  assert.equal(after.response.status, 200, JSON.stringify(after.body));
});

test("cached view queries expose incomplete state and expire after fifteen minutes", async () => {
  const { app, store } = fixture();
  const domain = createNotionDomain(store, "http://notion.worldfixture.test");
  const actor = domain.userByLogin("maya@example.test");
  const view = domain.createView({ database_id: DATABASE, data_source_id: SOURCE, name: "Large", type: "table" }, actor);
  const pages = store.collection("notion_pages", ["notion_id"]);
  for (let index = 0; index < 10_001; index += 1) pages.insert({
    notion_id: `11000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    parent: { type: "data_source_id", data_source_id: SOURCE }, properties: {}, accessible_by: [USER], in_trash: false,
    created_time: "2026-09-03T09:00:00.000Z", last_edited_time: "2026-09-03T09:00:00.000Z", created_by: USER, last_edited_by: USER,
    cover: null, icon: null, url: `http://notion.worldfixture.test/page/${index}`, public_url: null,
  });
  const cached = await request(app, `/v1/views/${view.id}/queries`, "POST", { page_size: 1 });
  assert.equal(cached.response.status, 200);
  assert.deepEqual(cached.body.request_status, { type: "incomplete", incomplete_reason: "query_result_limit_reached" });
  store.setData("notion_clock", "2026-09-03T09:16:00.000Z");
  assert.equal((await request(app, `/v1/views/${view.id}/queries/${cached.body.id}`)).response.status, 404);
});

test("custom emoji pagination returns stable cursors and rejects an unknown cursor", async () => {
  const { app } = fixture();
  const first = await request(app, "/v1/custom_emojis?page_size=1");
  assert.equal(first.body.has_more, true);
  assert.equal(first.body.results.length, 1);
  const second = await request(app, `/v1/custom_emojis?page_size=1&start_cursor=${first.body.next_cursor}`);
  assert.equal(second.body.results.length, 1);
  assert.notEqual(second.body.results[0].id, first.body.results[0].id);
  assert.equal((await request(app, "/v1/custom_emojis?start_cursor=bad-cursor")).response.status, 400);
});

test("meeting notes cover file-upload creation, each official filter property, compound filters, sorts, and limits", async (t) => {
  const { app } = fixture();
  const created = await request(app, "/v1/blocks/meeting_notes", "POST", { source: { type: "file_upload", file_upload_id: UPLOAD }, parent: { type: "page_id", page_id: PAGE }, title: "Uploaded meeting", language: "en" });
  assert.equal(created.response.status, 200);
  assert.equal(created.body.type, "meeting_notes");

  const person = [{ type: "exact", value: { table: "notion_user", id: USER } }];
  const date = { type: "exact", value: { type: "date", start_date: "2026-09-03" } };
  const filters = [
    ["title", { property: "title", filter: { operator: "string_contains", value: { type: "exact", value: "Weekly" } } }],
    ["attendees", { property: "attendees", filter: { operator: "person_contains", value: person } }],
    ["created_time", { property: "created_time", filter: { operator: "date_is", value: date } }],
    ["created_by", { property: "created_by", filter: { operator: "person_contains", value: person } }],
    ["last_edited_time", { property: "last_edited_time", filter: { operator: "date_is_on_or_after", value: date } }],
    ["last_edited_by", { property: "last_edited_by", filter: { operator: "person_contains", value: person } }],
  ];
  for (const [name, leaf] of filters) {
    await t.test(name, async () => {
      const result = await request(app, "/v1/blocks/meeting_notes/query", "POST", { filter: { operator: "and", filters: [leaf] }, limit: 50 });
      assert.equal(result.response.status, 200, JSON.stringify(leaf));
      assert.ok(result.body.results.length >= 1, JSON.stringify(leaf));
    });
  }
  const operatorCases = [
    ["title string_is", { property: "title", filter: { operator: "string_is", value: { type: "exact", value: "Weekly review" } } }, true],
    ["title string_is_not", { property: "title", filter: { operator: "string_is_not", value: { type: "exact", value: "Other" } } }, true],
    ["title string_does_not_contain", { property: "title", filter: { operator: "string_does_not_contain", value: { type: "exact", value: "Never" } } }, true],
    ["title string_starts_with", { property: "title", filter: { operator: "string_starts_with", value: { type: "exact", value: "Weekly" } } }, true],
    ["title string_ends_with", { property: "title", filter: { operator: "string_ends_with", value: { type: "exact", value: "review" } } }, true],
    ["attendees person_does_not_contain", { property: "attendees", filter: { operator: "person_does_not_contain", value: [{ type: "exact", value: { table: "notion_user", id: OTHER } }] } }, true],
    ["attendees URI alias", { property: "notion://meeting_notes/attendees", filter: { operator: "person_contains", value: [{ type: "relative", value: "me" }] } }, true],
    ["created_time date_is_before", { property: "created_time", filter: { operator: "date_is_before", value: { type: "exact", value: { type: "date", start_date: "2026-09-04" } } } }, true],
    ["created_time date_is_after", { property: "created_time", filter: { operator: "date_is_after", value: { type: "exact", value: { type: "date", start_date: "2026-09-02" } } } }, true],
    ["created_time date_is_on_or_before", { property: "created_time", filter: { operator: "date_is_on_or_before", value: date } }, true],
    ["created_time date_is_within custom", { property: "created_time", filter: { operator: "date_is_within", value: { type: "relative", value: "custom", direction: "past", unit: "day", count: 1 } } }, true],
    ["created_time date_is_relative_to", { property: "created_time", filter: { operator: "date_is_relative_to", value: { type: "relative", value: "this_week" } } }, true],
    ["created_time is_not_empty", { property: "created_time", filter: { operator: "is_not_empty" } }, true],
    ["created_time is_empty", { property: "created_time", filter: { operator: "is_empty" } }, false],
  ];
  for (const [name, leaf, shouldMatch] of operatorCases) {
    await t.test(name, async () => {
      const result = await request(app, "/v1/blocks/meeting_notes/query", "POST", { filter: { operator: "and", filters: [leaf] }, limit: 50 });
      assert.equal(result.response.status, 200, JSON.stringify(leaf));
      assert.equal(result.body.results.some((item) => item.id === "20000000-0000-4000-8000-000000000090"), shouldMatch, JSON.stringify(leaf));
    });
  }
  const compound = await request(app, "/v1/blocks/meeting_notes/query", "POST", { filter: { operator: "and", filters: [filters[0][1], { operator: "or", filters: [filters[1][1], filters[3][1]] }] }, sort: [
    { property: "title", direction: "ascending" }, { property: "attendees", direction: "ascending" },
    { property: "created_time", direction: "descending" }, { property: "created_by", direction: "ascending" },
    { property: "last_edited_time", direction: "descending" }, { property: "last_edited_by", direction: "ascending" },
  ], limit: 1 });
  assert.equal(compound.response.status, 200);
  assert.equal(compound.body.results.length, 1);
});

test("meeting-note query enforces official filter, sort, and result limits", async (t) => {
  const { app } = fixture();
  for (const limit of [0, 51]) await t.test(`limit ${limit}`, async () => assert.equal((await request(app, "/v1/blocks/meeting_notes/query", "POST", { limit })).response.status, 400));
  const leaf = { property: "title", filter: { operator: "string_contains", value: { type: "exact", value: "Weekly" } } };
  const tooManyFilters = Array.from({ length: 101 }, () => leaf);
  await t.test("101 filters", async () => assert.equal((await request(app, "/v1/blocks/meeting_notes/query", "POST", { filter: { operator: "and", filters: tooManyFilters } })).response.status, 400));
  const tooManySorts = Array.from({ length: 101 }, () => ({ property: "title", direction: "ascending" }));
  await t.test("101 sorts", async () => assert.equal((await request(app, "/v1/blocks/meeting_notes/query", "POST", { sort: tooManySorts })).response.status, 400));
  await t.test("unknown property", async () => assert.equal((await request(app, "/v1/blocks/meeting_notes/query", "POST", { filter: { operator: "and", filters: [{ property: "unknown", filter: { operator: "string_is", value: { type: "exact", value: "x" } } }] } })).response.status, 400));
});

test("MCP identity and Skill adapters cover pagination and all available filters", () => {
  const { store, baseUrl } = fixture();
  const domain = createNotionDomain(store, baseUrl);
  const actor = domain.userByLogin("maya@example.test");

  const first = domain.mcpGetUsers({ page_size: 1 }, actor);
  assert.equal(first.users.length, 1);
  assert.equal(first.has_more, true);
  const second = domain.mcpGetUsers({ page_size: 1, start_cursor: first.next_cursor }, actor);
  assert.equal(second.users.length, 1);
  assert.notEqual(second.users[0].id, first.users[0].id);
  assert.equal(domain.mcpGetUsers({ query: "theo@example.test" }, actor).users[0].id, OTHER);
  assert.equal(domain.mcpGetUsers({ user_id: "self" }, actor).users[0].is_current_user, true);
  assert.equal(domain.mcpGetUsers({ user_id: OTHER }, actor).users[0].id, OTHER);
  assert.equal(domain.mcpGetUsers({ start_cursor: "bad-cursor" }, actor), null);

  assert.deepEqual(domain.mcpGetTeams({ query: "product" }, actor).teams.map((item) => item.membership), ["member"]);
  assert.deepEqual(domain.mcpGetTeams({ team_id: "61000000-0000-4000-8000-000000000002" }, actor).teams.map((item) => item.membership), ["not_member"]);

  const limited = domain.mcpSearchSkills({ limit: 1 }, actor);
  assert.equal(limited.skills.length, 1);
  assert.equal(limited.has_more, true);
  assert.deepEqual(domain.mcpSearchSkills({ query: "support", teamspace_id: "61000000-0000-4000-8000-000000000002", limit: 50 }, actor).skills.map((item) => item.title), ["Support skill"]);
});

// Closes: `/v1/users` was the one paginated reader that validated neither of its
// pagination parameters. `listUsers` took the RAW query string and coerced it with
// `Number(pageSize) || 100`, so `?page_size=0` and `?page_size=abc` both returned
// every user, and it had no invalid-cursor guard, so `findIndex` returning -1
// became index 0 and an unknown `?start_cursor` re-served page one. Measured
// against a running fixture: `?page_size=0` came back with all 99 users and 200,
// while `/v1/custom_emojis`, one route below it, answered 400 for both.
test("/v1/users validates page_size and start_cursor like every other list route", async () => {
  const { app } = fixture();

  for (const [query, message] of [
    ["page_size=0", "page_size must be an integer from 1 through 100."],
    ["page_size=abc", "page_size must be an integer from 1 through 100."],
    ["page_size=101", "page_size must be an integer from 1 through 100."],
    ["start_cursor=totally-bogus", "start_cursor is not valid."],
  ]) {
    const refused = await app.request(`/v1/users?${query}`, { headers });
    assert.equal(refused.status, 400, query);
    const body = await refused.json();
    assert.equal(body.code, "validation_error", query);
    assert.equal(body.message, message, query);
  }

  // The valid range still pages, and a real cursor still advances rather than
  // handing back the page it came from.
  const all = await (await app.request("/v1/users", { headers })).json();
  assert.ok(all.results.length >= 2);

  const first = await (await app.request("/v1/users?page_size=1", { headers })).json();
  assert.equal(first.results.length, 1);
  assert.equal(first.has_more, true);

  const second = await app.request(`/v1/users?page_size=1&start_cursor=${first.next_cursor}`, { headers });
  assert.equal(second.status, 200);
  assert.notEqual((await second.json()).results[0].id, first.results[0].id);
});
