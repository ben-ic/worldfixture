import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { NOTION_MCP_CAPTURE, NOTION_MCP_PROTOCOL_VERSION, notionMcpTools, toolsForClient } from "./hosted-contract.mjs";

const captured = JSON.parse(readFileSync(new URL("../../../contracts/notion/hosted-mcp-tools-free-2026-09-03.json", import.meta.url), "utf8"));

test("the advertised Notion MCP contract exactly matches the secret-free hosted capture", () => {
  assert.equal(NOTION_MCP_PROTOCOL_VERSION, captured.protocol_version);
  assert.equal(NOTION_MCP_CAPTURE.account.plan, "free");
  assert.equal(captured.tool_count, 41);
  assert.deepEqual(notionMcpTools, captured.tools);
  assert.deepEqual(toolsForClient("Codex"), captured.tools);
  assert.equal(new Set(notionMcpTools.map((tool) => tool.name)).size, 41);
  assert.equal(notionMcpTools.some((tool) => tool.name === "notion-get-self"), false);
  assert.equal(notionMcpTools.some((tool) => tool.name === "notion-list-agents"), false);
});

test("all captured input and output schemas keep their hosted JSON Schema dialect", () => {
  for (const tool of notionMcpTools) {
    assert.equal(tool.inputSchema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(tool.inputSchema.type, "object");
    if (tool.outputSchema) assert.equal(tool.outputSchema.$schema, "https://json-schema.org/draft/2020-12/schema");
  }
});
