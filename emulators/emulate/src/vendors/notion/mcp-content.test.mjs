import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createServer } from "@emulators/core";

import { notionMcpTools } from "./hosted-contract.mjs";
import { plugin, seedFromConfig } from "./index.mjs";
import { callTool } from "./mcp-current.mjs";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const PAGE_ID = "10000000-0000-4000-8000-000000000101";

function fixture() {
  const server = createServer(plugin, {
    baseUrl: "http://notion.worldfixture.test",
    tokens: { inspector: { login: "maya@example.test", id: 1, scopes: ["read:user", "read:content", "write:content"] } },
  });
  seedFromConfig(server.store, server.baseUrl, {
    workspace: { name: "MCP content fixture" },
    users: [{ id: USER_ID, name: "Maya Chen", email: "maya@example.test" }],
    pages: [{ id: PAGE_ID, title: "Launch plan", created_by: USER_ID, accessible_by: [USER_ID], children: [{ type: "paragraph", text: "Review the launch checklist." }] }],
  });
  return server;
}

async function json(response) { return response.json(); }

async function initialize(app) {
  const registration = await json(await app.request("/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "MCP content tests", redirect_uris: ["http://client.example.test/callback"], token_endpoint_auth_method: "none" }),
  }));
  const verifier = "worldfixture-notion-content-test-verifier-0000000000";
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const request = {
    client_id: registration.client_id,
    redirect_uri: registration.redirect_uris[0],
    state: "content-test",
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
  const headers = { Authorization: `Bearer ${token.access_token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  const response = await app.request("/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "Claude Code", version: "1" } } }),
  });
  return { ...headers, "MCP-Session-Id": response.headers.get("mcp-session-id"), "MCP-Protocol-Version": "2025-11-25" };
}

async function call(app, headers, id, name, args) {
  return json(await app.request("/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
  }));
}

test("current attachment and comment tools are advertised with correct safety hints", () => {
  const selected = Object.fromEntries(notionMcpTools
    .filter((tool) => ["notion-create-file-upload", "notion-create-attachment", "notion-download-attachment", "notion-create-comment", "notion-get-comments"].includes(tool.name))
    .map((tool) => [tool.name, tool]));
  assert.equal(Object.keys(selected).length, 5);
  assert.equal(selected["notion-create-file-upload"].annotations.readOnlyHint, false);
  assert.equal(selected["notion-create-attachment"].annotations.readOnlyHint, false);
  assert.equal(selected["notion-create-attachment"].annotations.openWorldHint, true);
  assert.equal(selected["notion-download-attachment"].annotations.readOnlyHint, true);
  assert.equal(selected["notion-create-comment"].annotations.readOnlyHint, false);
  assert.equal(selected["notion-get-comments"].annotations.readOnlyHint, true);
});

test("attachment and comment schemas reject unsafe or ambiguous input before dispatch", async () => {
  const { app } = fixture();
  const headers = await initialize(app);
  const noSource = await call(app, headers, 2, "notion-create-attachment", { filename: "notes.md" });
  assert.equal(noSource.error.code, -32602);
  assert.match(noSource.error.message, /exactly one/);
  const privateUrl = await call(app, headers, 3, "notion-create-attachment", { filename: "notes.md", source_url: "http://localhost/notes.md" });
  assert.equal(privateUrl.error.code, -32602);
  assert.match(privateUrl.error.message, /HTTPS/);
  const twoFormats = await call(app, headers, 4, "notion-create-comment", { page_id: PAGE_ID, markdown: "Review this.", rich_text: [{ text: { content: "Review this." } }] });
  assert.equal(twoFormats.error.code, -32602);
  assert.match(twoFormats.error.message, /exactly one/);
  const twoTargets = await call(app, headers, 5, "notion-create-comment", { page_id: PAGE_ID, markdown: "Review this.", discussion_id: "discussion-1", selection_with_ellipsis: "Review...checklist" });
  assert.equal(twoTargets.error.code, -32602);
  assert.match(twoTargets.error.message, /cannot be used together/);
});

test("content tools dispatch to the shared domain adapters", async () => {
  const calls = [];
  const files = new Map();
  const comments = [];
  const domain = {
    mcpCreateFileUpload(args) {
      calls.push(["mcpCreateFileUpload", args]);
      return { file_upload_id: "upload-local-1", upload_url: "http://notion.worldfixture.test/uploads/upload-local-1", upload_headers: { "X-WorldFixture-Upload": "upload-local-1" }, form_field: "file" };
    },
    mcpCreateAttachment(args) {
      calls.push(["mcpCreateAttachment", args]);
      files.set("attachment-1", args.content);
      return { file_upload_id: "attachment-1", suggested_markdown: `[launch-notes.md](attachment://attachment-1)` };
    },
    mcpDownloadAttachment(args) {
      calls.push(["mcpDownloadAttachment", args]);
      return { file_upload_id: args.file_upload_id, content: files.get(args.file_upload_id) };
    },
    mcpCreateComment(args) {
      calls.push(["mcpCreateComment", args]);
      comments.push(args);
      return { discussion_id: "discussion-1", comment: { id: "comment-1", markdown: args.markdown } };
    },
    mcpGetComments(args) {
      calls.push(["mcpGetComments", args]);
      return { discussions: [{ id: "discussion-1", comments: structuredClone(comments) }] };
    },
  };
  const actor = { notion_id: USER_ID };
  const prepared = JSON.parse((await callTool("notion-create-file-upload", { filename: "diagram.png", content_type: "image/png" }, domain, actor)).content[0].text);
  assert.equal(prepared.form_field, "file");
  const attachment = JSON.parse((await callTool("notion-create-attachment", {
    filename: "launch-notes.md",
    content_type: "text/markdown",
    content: "# Launch notes\n\nShip safely.",
  }, domain, actor)).content[0].text);
  assert.ok(attachment.file_upload_id);
  assert.match(attachment.suggested_markdown, /launch-notes\.md/);
  const downloaded = JSON.parse((await callTool("notion-download-attachment", { file_upload_id: attachment.file_upload_id }, domain, actor)).content[0].text);
  assert.equal(downloaded.content, "# Launch notes\n\nShip safely.");

  const created = JSON.parse((await callTool("notion-create-comment", { page_id: PAGE_ID, markdown: `Please review.\n${attachment.suggested_markdown}` }, domain, actor)).content[0].text);
  assert.ok(created.discussion_id ?? created.id ?? created.comment?.id);
  const listed = JSON.parse((await callTool("notion-get-comments", { page_id: PAGE_ID, include_resolved: true }, domain, actor)).content[0].text);
  assert.match(JSON.stringify(listed), /Please review/);
  assert.deepEqual(calls.map(([name]) => name), ["mcpCreateFileUpload", "mcpCreateAttachment", "mcpDownloadAttachment", "mcpCreateComment", "mcpGetComments"]);
});
