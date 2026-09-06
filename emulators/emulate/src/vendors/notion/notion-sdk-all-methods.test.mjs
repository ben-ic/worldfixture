import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { Client, collectPaginatedAPI } from "@notionhq/client";
import { createServer } from "@emulators/core";

import { plugin, seedFromConfig } from "./index.mjs";
import { NOTION_VERSION } from "./rest.mjs";

const require = createRequire(import.meta.url);
const SDK_VERSION = require("@notionhq/client/package.json").version;

const USER = "00000000-0000-4000-8000-000000000001";
const OTHER_USER = "00000000-0000-4000-8000-000000000002";
const PAGE = "10000000-0000-4000-8000-000000000001";
const TEMPLATE = "10000000-0000-4000-8000-000000000002";
const DATABASE = "30000000-0000-4000-8000-000000000001";
const SOURCE = "40000000-0000-4000-8000-000000000001";
const VIEW = "50000000-0000-4000-8000-000000000001";
const EMOJI = "b0000000-0000-4000-8000-000000000001";
const AGENT = "aa000000-0000-4000-8000-000000000001";
const CANCEL_SESSION = "a1000000-0000-4000-8000-000000000099";

const EXPECTED_METHODS = [
  "agents.batch", "agents.delete", "agents.query", "agents.retrieve", "agents.retrieveInsights", "agents.updateCreditLimit", "agents.updateStatus",
  "asyncTasks.retrieve",
  "blocks.children.append", "blocks.children.list", "blocks.delete", "blocks.meetingNotes.create", "blocks.meetingNotes.query", "blocks.retrieve", "blocks.update",
  "comments.create", "comments.delete", "comments.list", "comments.retrieve", "comments.update",
  "customEmojis.list",
  "dataSources.create", "dataSources.listTemplates", "dataSources.query", "dataSources.retrieve", "dataSources.update",
  "databases.create", "databases.retrieve", "databases.update",
  "fileUploads.complete", "fileUploads.create", "fileUploads.list", "fileUploads.retrieve", "fileUploads.send",
  "oauth.introspect", "oauth.revoke", "oauth.token",
  "pages.create", "pages.move", "pages.properties.retrieve", "pages.retrieve", "pages.retrieveMarkdown", "pages.update", "pages.updateMarkdown",
  "request",
  "search",
  "sessions.cancel", "sessions.query", "sessions.queryEvents", "sessions.retrieve", "sessions.stream", "sessions.update",
  "users.list", "users.me", "users.retrieve",
  "views.create", "views.delete", "views.list", "views.queries.create", "views.queries.delete", "views.queries.results", "views.retrieve", "views.update",
].sort();

function publicMethodNames(client) {
  const names = ["request"];
  const walk = (value, prefix, depth) => {
    for (const key of Object.keys(value)) {
      const child = value[key];
      const name = prefix ? `${prefix}.${key}` : key;
      if (typeof child === "function") names.push(name);
      else if (child && typeof child === "object" && depth < 2) walk(child, name, depth + 1);
    }
  };
  walk(client, "", 0);
  return names.sort();
}

function fixture() {
  const baseUrl = "http://notion.worldfixture.test";
  const objects = new Map();
  process.env.WORLDFIXTURE_NOTION_OBJECT_STORE_URL = "http://object-store.test";
  process.env.WORLDFIXTURE_NOTION_OBJECT_STORE_ACCESS_KEY_ID = "test-access";
  process.env.WORLDFIXTURE_NOTION_OBJECT_STORE_SECRET_ACCESS_KEY = "test-secret";
  process.env.WORLDFIXTURE_NOTION_OBJECT_STORE_REGION = "us-east-1";
  globalThis.fetch = async (url, init = {}) => {
    const key = String(url);
    if (init.method === "PUT") {
      objects.set(key, { bytes: new Uint8Array(await new Response(init.body).arrayBuffer()), contentType: init.headers?.["content-type"] });
      return new Response(null, { status: 200 });
    }
    if (init.method === "DELETE") { objects.delete(key); return new Response(null, { status: 204 }); }
    const object = objects.get(key);
    return object ? new Response(object.bytes, { status: 200, headers: { "content-type": object.contentType } }) : new Response(null, { status: 404 });
  };
  const server = createServer(plugin, {
    baseUrl,
    tokens: { sdk_all: { login: "maya@example.test", id: 1, scopes: ["read:user", "read:content", "insert:content", "update:content", "read:comment", "insert:comment", "interact:agents"] } },
  });
  seedFromConfig(server.store, baseUrl, {
    workspace: { id: "60000000-0000-4000-8000-000000000001", name: "Northstar" },
    users: [{ id: USER, name: "Maya", email: "maya@example.test" }, { id: OTHER_USER, name: "Jon", email: "jon@example.test" }],
    custom_emojis: [{ id: EMOJI, name: "northstar", url: "https://assets.example.test/northstar.png" }],
    databases: [{ id: DATABASE, title: "Projects", parent: { type: "workspace", workspace: true }, accessible_by: [USER] }],
    data_sources: [{ id: SOURCE, database_id: DATABASE, name: "Projects", properties: { Name: { id: "title", type: "title" }, Rank: { id: "rank", type: "number" } }, templates: [{ id: TEMPLATE, name: "Project", is_default: true }], accessible_by: [USER] }],
    views: [{ id: VIEW, database_id: DATABASE, data_source_id: SOURCE, name: "Projects", type: "table", configuration: { type: "table", properties: [] }, accessible_by: [USER] }],
    pages: [
      { id: PAGE, parent: { type: "data_source_id", data_source_id: SOURCE }, properties: { Name: { id: "title", type: "title", title: [{ type: "text", text: { content: "Launch" } }] }, Rank: { id: "rank", type: "number", number: 1 } }, created_by: USER, accessible_by: [USER], children: [{ type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: "Plan" } }] } }] },
      { id: TEMPLATE, parent: { type: "data_source_id", data_source_id: SOURCE }, title: "Project", created_by: USER, accessible_by: [USER], children: [{ type: "heading_2", heading_2: { rich_text: [{ type: "text", text: { content: "Summary" } }], is_toggleable: false } }] },
    ],
    agents: [{ id: AGENT, name: "Planner", created_by: USER, accessible_by: [USER], editable_by: [USER], default_response: "Ready." }],
    agent_sessions: [{ id: CANCEL_SESSION, agent_id: AGENT, title: "Cancel me", status: "in_progress", created_at: "2026-09-03T09:00:00.000Z", updated_at: "2026-09-03T09:00:00.000Z", created_by: USER, accessible_by: [USER] }],
  });
  const requests = [];
  const sdkFetch = (url, init = {}) => {
    requests.push({ url: String(url), method: init.method, headers: { ...init.headers }, body: init.body, multipart: init.body instanceof FormData });
    return server.app.request(url, init);
  };
  const notion = new Client({ auth: "sdk_all", baseUrl, notionVersion: NOTION_VERSION, fetch: sdkFetch });
  return { ...server, notion, requests, sdkFetch };
}

test("@notionhq/client 5.26.0 exposes the exact pinned 63-method public surface", () => {
  assert.equal(SDK_VERSION, "5.26.0");
  assert.deepEqual(publicMethodNames(new Client()), EXPECTED_METHODS);
  assert.equal(typeof Client.prototype.request, "function");
  assert.equal(EXPECTED_METHODS.length, 63);
});

test("every applicable @notionhq/client 5.26.0 method completes a real emulator lifecycle", async () => {
  const { app, baseUrl, notion, requests, sdkFetch } = fixture();
  const invoked = new Set();
  const call = async (name, operation) => {
    invoked.add(name);
    return operation();
  };

  const users = await call("users.list", () => collectPaginatedAPI(notion.users.list, { page_size: 1 }));
  assert.deepEqual(users.map((item) => item.id), [USER, OTHER_USER]);
  await call("users.retrieve", () => notion.users.retrieve({ user_id: USER }));
  await call("users.me", () => notion.users.me({}));
  await call("request", () => notion.request({ path: "users/me", method: "get" }));
  await call("customEmojis.list", () => notion.customEmojis.list({ name: "northstar" }));
  await call("search", () => notion.search({ query: "Launch", page_size: 1 }));

  await call("databases.retrieve", () => notion.databases.retrieve({ database_id: DATABASE }));
  await call("databases.update", () => notion.databases.update({ database_id: DATABASE, is_inline: true }));
  const database = await call("databases.create", () => notion.databases.create({ parent: { type: "page_id", page_id: PAGE }, title: [{ type: "text", text: { content: "Roadmap" } }], initial_data_source: { properties: { Name: { type: "title", title: {} } } } }));

  await call("dataSources.retrieve", () => notion.dataSources.retrieve({ data_source_id: SOURCE }));
  await call("dataSources.query", () => notion.dataSources.query({ data_source_id: SOURCE, page_size: 1 }));
  await call("dataSources.listTemplates", () => notion.dataSources.listTemplates({ data_source_id: SOURCE }));
  const source = await call("dataSources.create", () => notion.dataSources.create({ parent: { type: "database_id", database_id: database.id }, title: [{ type: "text", text: { content: "Tasks" } }], properties: { Name: { type: "title", title: {} } } }));
  await call("dataSources.update", () => notion.dataSources.update({ data_source_id: source.id, title: [{ type: "text", text: { content: "Work" } }] }));

  await call("pages.retrieve", () => notion.pages.retrieve({ page_id: PAGE }));
  await call("pages.properties.retrieve", () => notion.pages.properties.retrieve({ page_id: PAGE, property_id: "title", page_size: 1 }));
  await call("pages.retrieveMarkdown", () => notion.pages.retrieveMarkdown({ page_id: PAGE }));
  const createdPage = await call("pages.create", () => notion.pages.create({ parent: { type: "data_source_id", data_source_id: SOURCE }, properties: { Name: { type: "title", title: [{ type: "text", text: { content: "SDK lifecycle" } }] } } }));
  await call("pages.update", () => notion.pages.update({ page_id: createdPage.id, is_locked: true }));
  await call("pages.move", () => notion.pages.move({ page_id: createdPage.id, parent: { type: "page_id", page_id: PAGE } }));
  const task = await call("pages.updateMarkdown", () => notion.pages.updateMarkdown({ page_id: PAGE, type: "replace_content", replace_content: { new_str: "# Launch\nUpdated" }, allow_async: true }));
  await call("asyncTasks.retrieve", () => notion.asyncTasks.retrieve({ task_id: task.id }));

  const children = await call("blocks.children.list", () => notion.blocks.children.list({ block_id: PAGE, page_size: 1 }));
  await call("blocks.retrieve", () => notion.blocks.retrieve({ block_id: children.results[0].id }));
  await call("blocks.update", () => notion.blocks.update({ block_id: children.results[0].id, paragraph: { rich_text: [{ type: "text", text: { content: "Changed" } }] } }));
  const appended = await call("blocks.children.append", () => notion.blocks.children.append({ block_id: PAGE, children: [{ type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: "Delete" } }] } }] }));
  await call("blocks.delete", () => notion.blocks.delete({ block_id: appended.results[0].id }));
  await call("blocks.meetingNotes.query", () => notion.blocks.meetingNotes.query({ limit: 10 }));
  await call("blocks.meetingNotes.create", () => notion.blocks.meetingNotes.create({ source: { type: "block", block_id: children.results[0].id }, title: "SDK meeting", language: "en" }));

  const comment = await call("comments.create", () => notion.comments.create({ parent: { page_id: PAGE }, rich_text: [{ type: "text", text: { content: "Review" } }] }));
  await call("comments.list", () => notion.comments.list({ block_id: PAGE, page_size: 1 }));
  await call("comments.retrieve", () => notion.comments.retrieve({ comment_id: comment.id }));
  await call("comments.update", () => notion.comments.update({ comment_id: comment.id, rich_text: [{ type: "text", text: { content: "Done" } }] }));
  await call("comments.delete", () => notion.comments.delete({ comment_id: comment.id }));

  const upload = await call("fileUploads.create", () => notion.fileUploads.create({ mode: "multi_part", filename: "note.txt", content_type: "text/plain", number_of_parts: 1 }));
  await call("fileUploads.list", () => notion.fileUploads.list({ page_size: 1 }));
  await call("fileUploads.retrieve", () => notion.fileUploads.retrieve({ file_upload_id: upload.id }));
  await call("fileUploads.send", () => notion.fileUploads.send({ file_upload_id: upload.id, file: { data: new Blob(["hello"], { type: "text/plain" }), filename: "note.txt" }, part_number: "1" }));
  await call("fileUploads.complete", () => notion.fileUploads.complete({ file_upload_id: upload.id }));

  const view = await call("views.create", () => notion.views.create({ database_id: database.id, data_source_id: database.data_sources[0].id, name: "Roadmap", type: "table", configuration: { type: "table", properties: [] } }));
  await call("views.list", () => notion.views.list({ database_id: database.id, page_size: 1 }));
  await call("views.retrieve", () => notion.views.retrieve({ view_id: view.id }));
  await call("views.update", () => notion.views.update({ view_id: view.id, name: "Current roadmap" }));
  const viewQuery = await call("views.queries.create", () => notion.views.queries.create({ view_id: VIEW, page_size: 1 }));
  await call("views.queries.results", () => notion.views.queries.results({ view_id: VIEW, query_id: viewQuery.id, page_size: 1 }));
  await call("views.queries.delete", () => notion.views.queries.delete({ view_id: VIEW, query_id: viewQuery.id }));
  await call("views.delete", () => notion.views.delete({ view_id: view.id }));

  await call("agents.query", () => notion.agents.query({ page_size: 1 }));
  await call("agents.retrieve", () => notion.agents.retrieve({ agent_id: AGENT }));
  await call("agents.retrieveInsights", () => notion.agents.retrieveInsights({ agent_id: AGENT, start_time: 0, end_time: 9999999999999 }));
  await call("agents.updateCreditLimit", () => notion.agents.updateCreditLimit({ agent_id: AGENT, credit_limit: 100 }));
  await call("agents.updateStatus", () => notion.agents.updateStatus({ agent_id: AGENT, status: "active" }));
  await call("agents.batch", () => notion.agents.batch({ operations: [{ action: "update_credit_limit", agent_id: AGENT, fields: { credit_limit: 200 } }] }));
  const session = await call("sessions.update", () => notion.sessions.update({ agent_id: AGENT, message: "Plan" }));
  await call("sessions.retrieve", () => notion.sessions.retrieve({ session_id: session.id }));
  await call("sessions.query", () => notion.sessions.query({ page_size: 1 }));
  await call("sessions.queryEvents", () => notion.sessions.queryEvents({ session_id: session.id, page_size: 1 }));
  await call("sessions.cancel", () => notion.sessions.cancel({ session_id: CANCEL_SESSION }));
  await call("sessions.stream", async () => { const values = []; for await (const value of notion.sessions.stream({ session_id: session.id, message: "Continue" })) values.push(value); return values; });
  await call("agents.delete", () => notion.agents.delete({ agent_id: AGENT }));

  const registration = await (await app.request("/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "SDK all methods", redirect_uris: ["https://client.example.test/callback"], token_endpoint_auth_method: "client_secret_basic" }) })).json();
  const consent = await app.request("/v1/oauth/authorize", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: registration.client_id, redirect_uri: registration.redirect_uris[0], response_type: "code", owner: "user", user_id: USER, decision: "approve" }) });
  const code = new URL(consent.headers.get("location")).searchParams.get("code");
  const oauth = new Client({ baseUrl, notionVersion: NOTION_VERSION, fetch: sdkFetch });
  const token = await call("oauth.token", () => oauth.oauth.token({ client_id: registration.client_id, client_secret: registration.client_secret, grant_type: "authorization_code", code, redirect_uri: registration.redirect_uris[0] }));
  await call("oauth.introspect", () => oauth.oauth.introspect({ client_id: registration.client_id, client_secret: registration.client_secret, token: token.access_token }));
  await call("oauth.revoke", () => oauth.oauth.revoke({ client_id: registration.client_id, client_secret: registration.client_secret, token: token.access_token }));

  assert.deepEqual([...invoked].sort(), EXPECTED_METHODS);
  const userPages = requests.filter((request) => request.url.includes("/v1/users?") && request.url.includes("page_size=1"));
  assert.equal(userPages.length, 2, "collectPaginatedAPI must request both user pages");
  assert.match(userPages[1].url, /start_cursor=/, "the second SDK page must encode start_cursor in the URL query string");
  const searchRequest = requests.find((request) => request.url.endsWith("/v1/search"));
  assert.equal(searchRequest?.headers["content-type"], "application/json");
  assert.equal(JSON.parse(searchRequest.body).query, "Launch", "SDK JSON methods must encode the request body");
  const multipart = requests.find((request) => request.url.includes(`/v1/file_uploads/${upload.id}/send`));
  assert.equal(multipart?.multipart, true, "SDK File Upload send must use FormData");
  assert.equal(Object.hasOwn(multipart?.headers ?? {}, "content-type"), false, "SDK must let fetch add the multipart boundary");
  const oauthRequest = requests.find((request) => request.url.endsWith("/v1/oauth/token"));
  assert.match(oauthRequest?.headers.authorization ?? "", /^Basic /, "SDK OAuth methods must use HTTP Basic client authentication");
  assert.equal(oauthRequest?.headers["content-type"], "application/json");
});
