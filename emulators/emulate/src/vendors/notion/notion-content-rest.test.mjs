import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "@emulators/core";

import { plugin, seedFromConfig } from "./index.mjs";
import { createNotionDomain } from "./domain.mjs";
import { NOTION_VERSION } from "./rest.mjs";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_ID = "00000000-0000-4000-8000-000000000002";
const PAGE_ID = "10000000-0000-4000-8000-000000000001";
const SEEDED_COMMENT_ID = "80000000-0000-4000-8000-000000000099";
const SEEDED_UPLOAD_ID = "90000000-0000-4000-8000-000000000099";

function fixture() {
  const server = createServer(plugin, {
    baseUrl: "http://notion.worldfixture.test",
    tokens: {
      full: { login: "maya@example.test", id: 1, scopes: ["read:content", "insert:content", "update:content", "read:comment", "insert:comment"] },
      other: { login: "theo@example.test", id: 2, scopes: ["read:content", "read:comment", "insert:comment"] },
      content: { login: "maya@example.test", id: 3, scopes: ["read:content", "update:content"] },
    },
  });
  seedFromConfig(server.store, server.baseUrl, {
    object_store: { bucket: "northstar-documents", prefix: "notion/uploads" },
    users: [
      { id: USER_ID, name: "Maya", email: "maya@example.test" },
      { id: OTHER_ID, name: "Theo", email: "theo@example.test" },
    ],
    pages: [{ id: PAGE_ID, title: "Release notes", created_by: USER_ID, accessible_by: [USER_ID, OTHER_ID], children: [{ type: "paragraph", text: "Draft proposal" }] }],
  });
  return server;
}

function headers(token = "full") {
  return { Authorization: `Bearer ${token}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" };
}

async function request(app, path, method = "GET", value, token = "full") {
  const response = await app.request(path, { method, headers: headers(token), ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  return { response, body: await response.json() };
}

test("page markdown reads and writes through the shared page and block state", async () => {
  const { app } = fixture();
  const initial = await request(app, `/v1/pages/${PAGE_ID}/markdown`);
  assert.equal(initial.response.status, 200);
  assert.equal(initial.body.object, "page_markdown");
  assert.equal(initial.body.markdown, "# Release notes\nDraft proposal");

  const updated = await request(app, `/v1/pages/${PAGE_ID}/markdown`, "PATCH", {
    type: "update_content",
    update_content: { content_updates: [{ old_str: "Draft proposal", new_str: "Approved proposal" }] },
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.markdown, "# Release notes\nApproved proposal");
  const children = await request(app, `/v1/blocks/${PAGE_ID}/children`);
  assert.equal(children.body.results[0].paragraph.rich_text[0].plain_text, "Approved proposal");

  const replaced = await request(app, `/v1/pages/${PAGE_ID}/markdown`, "PATCH", {
    type: "replace_content",
    replace_content: { new_str: "# Final notes\n## Outcome\n- [x] Ship" },
    allow_async: true,
  });
  assert.equal(replaced.response.status, 202);
  assert.equal(replaced.body.object, "async_task");
  assert.equal((await request(app, `/v1/pages/${PAGE_ID}`)).body.properties.title.title[0].plain_text, "Final notes");
});

test("page creation accepts markdown and extracts the first h1 as the title", async () => {
  const { app } = fixture();
  const created = await request(app, "/v1/pages", "POST", {
    parent: { type: "page_id", page_id: PAGE_ID },
    markdown: "# Incident review\nWhat happened\n- Follow up",
  });
  assert.equal(created.response.status, 200);
  assert.equal(created.body.properties.title.title[0].plain_text, "Incident review");
  const markdown = await request(app, `/v1/pages/${created.body.id}/markdown`);
  assert.equal(markdown.body.markdown, "# Incident review\nWhat happened\n- Follow up");
  assert.equal((await request(app, "/v1/pages", "POST", { parent: { type: "page_id", page_id: PAGE_ID }, markdown: "x", children: [] })).response.status, 400);
});

test("comments create threads, paginate, update, retrieve, and delete", async () => {
  const { app } = fixture();
  const first = await request(app, "/v1/comments", "POST", { parent: { page_id: PAGE_ID }, markdown: "Please review" });
  assert.equal(first.response.status, 200);
  assert.equal(first.body.discussion_id, first.body.id);
  assert.equal(first.body.rich_text[0].plain_text, "Please review");

  const reply = await request(app, "/v1/comments", "POST", { discussion_id: first.body.discussion_id, rich_text: [{ type: "text", text: { content: "Done" }, plain_text: "Done" }] });
  assert.equal(reply.response.status, 200);
  assert.equal(reply.body.discussion_id, first.body.discussion_id);

  const listed = await request(app, `/v1/comments?block_id=${PAGE_ID}&page_size=1`);
  assert.equal(listed.response.status, 200);
  assert.equal(listed.body.results.length, 1);
  assert.equal(listed.body.has_more, true);
  const secondPage = await request(app, `/v1/comments?block_id=${PAGE_ID}&start_cursor=${listed.body.next_cursor}`);
  assert.deepEqual(secondPage.body.results.map((comment) => comment.id), [reply.body.id]);

  const updated = await request(app, `/v1/comments/${first.body.id}`, "PATCH", { markdown: "Reviewed" });
  assert.equal(updated.body.rich_text[0].plain_text, "Reviewed");
  assert.equal((await request(app, `/v1/comments/${first.body.id}`, "PATCH", { markdown: "No" }, "other")).response.status, 404);
  assert.equal((await request(app, `/v1/comments/${first.body.id}`, "DELETE")).response.status, 200);
  assert.equal((await request(app, `/v1/comments/${first.body.id}`)).response.status, 404);
});

test("comment capabilities and body unions are enforced", async () => {
  const { app } = fixture();
  assert.equal((await request(app, `/v1/comments?block_id=${PAGE_ID}`, "GET", undefined, "content")).response.status, 403);
  assert.equal((await request(app, "/v1/comments", "POST", { parent: { page_id: PAGE_ID }, markdown: "x", rich_text: [] })).response.status, 400);
  assert.equal((await request(app, "/v1/comments", "POST", { parent: { page_id: PAGE_ID }, discussion_id: "80000000-0000-4000-8000-000000000001", markdown: "x" })).response.status, 400);
});

test("seeded comments and file uploads preserve their world owner and object location", async () => {
  const baseUrl = "http://notion.worldfixture.test";
  const { app, store } = createServer(plugin, {
    baseUrl,
    tokens: {
      full: { login: "maya@example.test", id: 1, scopes: ["read:content", "read:comment"] },
      other: { login: "theo@example.test", id: 2, scopes: ["read:content", "read:comment", "insert:comment"] },
    },
  });
  seedFromConfig(store, baseUrl, {
    object_store: { bucket: "northstar-documents", prefix: "notion/uploads" },
    users: [{ id: USER_ID, name: "Maya", email: "maya@example.test" }, { id: OTHER_ID, name: "Theo", email: "theo@example.test" }],
    pages: [{ id: PAGE_ID, title: "Release notes", created_by: USER_ID, accessible_by: [USER_ID, OTHER_ID] }],
    comments: [{ id: SEEDED_COMMENT_ID, parent: { type: "page_id", page_id: PAGE_ID }, created_by: OTHER_ID, created_time: "2026-08-20T10:00:00Z", markdown: "World review note", integration_created: false }],
    file_uploads: [{ id: SEEDED_UPLOAD_ID, created_by: USER_ID, created_time: "2026-08-20T09:00:00Z", status: "uploaded", filename: "release.md", content_type: "text/markdown", content_length: 12, object_bucket: "northstar-documents", object_key: "documents/doc-release.md" }],
  });
  const comments = await request(app, `/v1/comments?block_id=${PAGE_ID}`);
  assert.equal(comments.body.results[0].id, SEEDED_COMMENT_ID);
  assert.equal(comments.body.results[0].created_by.id, OTHER_ID);
  assert.equal((await request(app, `/v1/comments/${SEEDED_COMMENT_ID}`, "PATCH", { markdown: "changed" }, "other")).response.status, 404);

  const uploads = await request(app, "/v1/file_uploads?status=uploaded");
  assert.equal(uploads.body.results[0].id, SEEDED_UPLOAD_ID);
  const domain = createNotionDomain(store, baseUrl);
  assert.equal(domain.fileUploadStorage(SEEDED_UPLOAD_ID, domain.userByLogin("maya@example.test")).key, "documents/doc-release.md");
  assert.equal(domain.fileUpload(SEEDED_UPLOAD_ID, domain.userByLogin("theo@example.test")), null);
});

test("file upload metadata create, retrieve, filter, and paginate without a private byte store", async () => {
  const { app, store, baseUrl } = fixture();
  const first = await request(app, "/v1/file_uploads", "POST", { mode: "single_part", filename: "brief.pdf", content_type: "application/pdf" });
  assert.equal(first.response.status, 200);
  assert.equal(first.body.status, "pending");
  assert.match(first.body.upload_url, new RegExp(`/v1/file_uploads/${first.body.id}/send$`));

  const second = await request(app, "/v1/file_uploads", "POST", { mode: "multi_part", filename: "video.mp4", content_type: "video/mp4", number_of_parts: 2 });
  assert.equal(second.response.status, 200);
  assert.match(second.body.complete_url, new RegExp(`/v1/file_uploads/${second.body.id}/complete$`));
  assert.deepEqual(second.body.number_of_parts, { total: 2, sent: 0 });

  const retrieved = await request(app, `/v1/file_uploads/${first.body.id}`);
  assert.equal(retrieved.body.filename, "brief.pdf");
  assert.equal(Object.hasOwn(retrieved.body, "object_key"), false);
  const domain = createNotionDomain(store, baseUrl);
  assert.deepEqual(domain.fileUploadStorage(first.body.id, domain.userByLogin("maya@example.test")), {
    bucket: "northstar-documents", key: `notion/uploads/${first.body.id}/brief.pdf`, mode: "single_part", number_of_parts: 1, sent_parts: [],
    status: "pending", filename: "brief.pdf", content_type: "application/pdf",
  });
  const listed = await request(app, "/v1/file_uploads?status=pending&page_size=1");
  assert.equal(listed.body.type, "file_upload");
  assert.equal(listed.body.results.length, 1);
  assert.equal(listed.body.has_more, true);
  assert.equal((await request(app, "/v1/file_uploads?status=invalid")).response.status, 400);
});
