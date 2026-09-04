import assert from "node:assert/strict";
import test from "node:test";

import { createServer } from "@emulators/core";
import { plugin, seedFromConfig } from "./index.mjs";

const PAGE_ID = "dff277c5-1633-49f0-8648-17c5e4afcfda";

function fixture() {
  const server = createServer(plugin, { baseUrl: "http://localhost:4716",
    tokens: { notion_token: { login: "maya@example.test", id: 1, scopes: ["read:user", "read:content"] } } });
  seedFromConfig(server.store, server.baseUrl, {
    workspace: { id: "workspace", name: "Northstar Relay" },
    users: [{ id: "10000000-0000-4000-8000-000000000001", name: "Maya Chen", email: "maya@example.test" }],
    pages: [{ id: PAGE_ID, title: "Release plan", parent: { type: "workspace", workspace: true },
      markdown: "## Launch checklist\n- Confirm the release\n- [x] Run tests" }],
  });
  return server;
}

test("a Notion page URL opens a readable local page without API headers", async () => {
  const { app } = fixture();
  const response = await app.request(`/notion/${PAGE_ID.replaceAll("-", "")}`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^text\/html/);
  assert.match(html, /Release plan/);
  assert.match(html, /Launch checklist/);
  assert.match(html, /Confirm the release/);
  assert.match(html, /Run tests/);
});

test("an unknown Notion page URL returns a visible 404 page", async () => {
  const { app } = fixture();
  const response = await app.request("/notion/00000000000040008000000000000000");
  assert.equal(response.status, 404);
  assert.match(await response.text(), /Page not found/);
});
