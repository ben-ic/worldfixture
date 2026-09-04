import assert from "node:assert/strict";
import test from "node:test";

import { normalizeMcpToolsCapture, serializeMcpToolsCapture } from "./mcp-capture.mjs";

const metadata = {
  provider: "notion",
  endpoint: "https://mcp.notion.com/mcp",
  captured_at: "2026-09-03",
  client: "worldfixture-capture",
  client_version: "1",
  protocol_version: "2025-11-25",
  plan: "unknown",
};

test("hosted tools/list captures have stable tool and object ordering", () => {
  const capture = normalizeMcpToolsCapture({
    jsonrpc: "2.0", id: 7,
    result: { tools: [
      { name: "zeta", inputSchema: { required: ["value"], properties: { value: { type: "string" } }, type: "object" }, description: "Z" },
      { inputSchema: { type: "object", properties: {} }, name: "alpha", annotations: { readOnlyHint: true } },
    ] },
  }, metadata);

  assert.equal(capture.api_version, "worldfixture.mcp-tools-capture/v1");
  assert.equal(capture.tool_count, 2);
  assert.deepEqual(capture.tools.map((tool) => tool.name), ["alpha", "zeta"]);
  assert.equal(capture.captured_at, "2026-09-03T00:00:00.000Z");
  assert.doesNotMatch(JSON.stringify(capture), /"id":7/);

  const first = serializeMcpToolsCapture({ result: { tools: [...capture.tools].reverse() } }, metadata);
  const second = serializeMcpToolsCapture({ tools: capture.tools }, metadata);
  assert.equal(first, second);
});

test("capture normalization rejects incomplete or ambiguous contracts", () => {
  assert.throws(() => normalizeMcpToolsCapture({ tools: [] }, { ...metadata, endpoint: "http://mcp.example.test" }), /https/);
  assert.throws(() => normalizeMcpToolsCapture({ error: { code: -1, message: "unauthorized" } }, metadata), /unauthorized/);
  assert.throws(() => normalizeMcpToolsCapture({ tools: [{ name: "same", inputSchema: { type: "object" } }, { name: "same", inputSchema: { type: "object" } }] }, metadata), /duplicate/);
  assert.throws(() => normalizeMcpToolsCapture({ tools: [{ name: "bad", inputSchema: { type: "string" } }] }, metadata), /must be object/);
});
