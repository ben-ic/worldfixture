import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { notionPage, readPages } from "./workbench-collection-reads.mjs";
import { githubOverview, notionOverview, slackOverview } from "./workbench.mjs";

function mockedFetch(t, read) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const result = await read(new URL(url), options);
    return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
  };
  t.after(() => { globalThis.fetch = original; });
}

test("pagination keeps successful rows after a later failure and rejects repeated cursors", async () => {
  const result = await readPages(async cursor => {
    if (cursor) throw new Error("HTTP 503");
    return { rows: [{ id: "first" }], next: "second" };
  });
  assert.deepEqual(result, { rows: [{ id: "first" }], status: "partial", error: "HTTP 503" });
  const repeated = await readPages(async cursor => ({ rows: [{ id: cursor ?? "first" }], next: "again" }));
  assert.equal(repeated.status, "partial");
  assert.match(repeated.error, /repeated cursor/);
  assert.equal(notionPage({ legal_holds: [], next_cursor: null }, "legal_holds", { cursorOnly: true }).next, null);
  assert.throws(() => notionPage({ results: [], has_more: true }), /without a next cursor/);
});

test("Slack follows channel and history cursors, retaining channel rows after failed history", async t => {
  const histories = [];
  mockedFetch(t, (url, options) => {
    const body = options.body;
    if (url.pathname.endsWith("users.list")) return { ok: true, members: [], response_metadata: { next_cursor: "" } };
    if (url.pathname.endsWith("conversations.list")) return { ok: true, channels: [{ id: body.get("cursor") ? "second" : "first", name: "Channel" }], response_metadata: { next_cursor: body.get("cursor") ? "" : "next-channel" } };
    const channel = body.get("channel"); histories.push([channel, body.get("cursor")]);
    if (channel === "second") throw new Error("history HTTP 503");
    return { ok: true, messages: [{ ts: body.get("cursor") ? "2" : "1" }], has_more: !body.get("cursor"), response_metadata: { next_cursor: body.get("cursor") ? "" : "next-message" } };
  });
  const result = await slackOverview({ SLACK_BASE_URL: "http://slack-reader.test", SLACK_TOKEN: "test" }, {});
  assert.equal(result.channels.length, 2);
  assert.equal(result.channels[0].messageCount, 2);
  assert.equal(result.channels[1].messageCount, null);
  assert.equal(result.messageCount, null);
  assert.equal(result.collectionStatus.channels.status, "complete");
  assert.equal(result.collectionStatus.messageCount.status, "partial");
  assert.ok(histories.some(([channel, cursor]) => channel === "first" && cursor === "next-message"));
});

test("GitHub loads issues past page 100 and preserves independent repository failures", async t => {
  mockedFetch(t, url => {
    if (url.pathname === "/user/repos") return [{ id: 1, full_name: "org/first" }, { id: 2, full_name: "org/second" }];
    if (url.pathname === "/repos/org/missing") throw new Error("repository HTTP 404");
    if (url.pathname === "/repos/org/second/issues") throw new Error("issues HTTP 503");
    assert.equal(url.searchParams.get("state"), "open");
    return url.searchParams.get("page") === "1" ? Array.from({ length: 100 }, (_, id) => ({ id, title: `Issue ${id}` })) : [{ id: 100, title: "Beyond the old cap" }];
  });
  const result = await githubOverview({ GITHUB_BASE_URL: "http://github-reader.test" }, { organizations: [{ id: "org" }], software: { repositories: [{ owner_id: "org", name: "missing" }] } });
  assert.equal(result.repositories.length, 2);
  assert.equal(result.issues.length, 101);
  assert.equal(result.collectionStatus.repositories.status, "partial");
  assert.equal(result.collectionStatus.issues.status, "partial");
  assert.match(result.collectionStatus.issues.error, /HTTP 503/);
});

test("Notion follows search and comments, preserves failed detail states, and reports optional API failures", async t => {
  const root = mkdtempSync(join(tmpdir(), "wf-notion-read-"));
  mkdirSync(join(root, "projections"));
  writeFileSync(join(root, "projections/emulator-overlay.json"), JSON.stringify({ notion: { workspace: { id: "workspace" }, databases: [{ id: "missing" }] } }));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = [];
  mockedFetch(t, (url, options) => {
    calls.push(url.pathname + url.search);
    if (url.pathname === "/v1/search") {
      const input = JSON.parse(options.body);
      return { results: [{ id: input.start_cursor ? "page-two" : "page-one", object: "page", url: "http://internal.test/page" }], has_more: !input.start_cursor, next_cursor: input.start_cursor ? null : "next-page" };
    }
    if (url.pathname === "/v1/comments") {
      if (url.searchParams.get("block_id") === "page-two") throw new Error("comments HTTP 403");
      return { results: [{ id: url.searchParams.has("start_cursor") ? "comment-two" : "comment-one" }], has_more: !url.searchParams.has("start_cursor"), next_cursor: url.searchParams.has("start_cursor") ? null : "next-comment" };
    }
    if (url.pathname === "/v1/databases/missing") throw new Error("database HTTP 404");
    if (url.pathname === "/v1/file_uploads") throw new Error("uploads HTTP 503");
    if (url.pathname === "/__worldfixture/mcp-observability") return { sessions: [], calls: [], changes: [], asyncTasks: [] };
    if (url.pathname === "/__worldfixture/notion-admin") throw new Error("admin HTTP 403");
    if (url.pathname === "/admin/v1/legal_holds") return { legal_holds: [], next_cursor: null };
    return { results: [], has_more: false, next_cursor: null };
  });
  const result = await notionOverview({ NOTION_BASE_URL: "http://notion-reader.test", NOTION_ADMIN_TOKEN: "test" }, root, "http://public.test");
  assert.equal(result.pages.length, 2);
  assert.equal(result.pages[0].url, "http://public.test/page");
  assert.equal(result.mcpUrl, "http://public.test/mcp");
  assert.equal(result.comments.length, 2);
  assert.equal(result.collectionStatus.pages.status, "complete");
  assert.equal(result.collectionStatus.comments.status, "partial");
  for (const name of ["databases", "views", "fileUploads", "connections", "connectionTokens"]) assert.equal(result.collectionStatus[name].status, "failed", name);
  assert.equal(result.collectionStatus.legalHolds.status, "complete");
  assert.ok(calls.some(path => path.includes("start_cursor=next-comment")));
});

test("GitHub repository discovery follows all pages and a successful empty issue read is complete", async t => {
  const pages = [];
  mockedFetch(t, url => {
    if (url.pathname === "/user/repos") {
      pages.push(Number(url.searchParams.get("page")));
      return pages.length === 1 ? Array.from({ length: 100 }, (_, id) => ({ id, full_name: `org/repo-${id}` })) : [{ id: 100, full_name: "org/last" }];
    }
    return [];
  });
  const result = await githubOverview({ GITHUB_BASE_URL: "http://github-pages.test" }, {});
  assert.deepEqual(pages, [1, 2]);
  assert.equal(result.repositories.length, 101);
  assert.equal(result.issues.length, 0);
  assert.equal(result.collectionStatus.repositories.status, "complete");
  assert.equal(result.collectionStatus.issues.status, "complete");
});

test("Notion paginates optional and cursor-only admin lists and rejects missing snapshot arrays", async t => {
  const root = mkdtempSync(join(tmpdir(), "wf-notion-pages-"));
  mkdirSync(join(root, "projections"));
  writeFileSync(join(root, "projections/emulator-overlay.json"), JSON.stringify({ notion: { workspace: { id: "workspace" } } }));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mockedFetch(t, url => {
    if (url.pathname === "/v1/file_uploads") return { results: [{ id: url.searchParams.has("start_cursor") ? "upload-two" : "upload-one" }], has_more: !url.searchParams.has("start_cursor"), next_cursor: url.searchParams.has("start_cursor") ? null : "next-upload" };
    if (url.pathname === "/admin/v1/legal_holds") return { legal_holds: [{ legal_hold_id: url.searchParams.has("start_cursor") ? "hold-two" : "hold-one" }], ...(url.searchParams.has("start_cursor") ? {} : { next_cursor: "next-hold" }) };
    if (url.pathname === "/__worldfixture/notion-admin") return { connections: [{ id: "valid" }], tokens: [] };
    if (url.pathname === "/__worldfixture/mcp-observability") return { sessions: [], calls: [], changes: [], asyncTasks: [] };
    return { results: [], has_more: false, next_cursor: null };
  });
  const result = await notionOverview({ NOTION_BASE_URL: "http://notion-pages.test", NOTION_ADMIN_TOKEN: "test" }, root);
  assert.equal(result.fileUploads.length, 2);
  assert.equal(result.legalHolds.length, 2);
  assert.equal(result.collectionStatus.fileUploads.status, "complete");
  assert.equal(result.collectionStatus.legalHolds.status, "complete");
  assert.equal(result.connections[0].id, "valid");
  assert.equal(result.collectionStatus.connections.status, "complete");
  // The sanitizer supplies safe empty arrays, but this does not prove API reads.
  assert.equal(result.collectionStatus.webhookSubscriptions.status, "failed");
  assert.equal(result.collectionStatus.webhookDeliveries.status, "failed");
});
