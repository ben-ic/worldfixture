// A hosted MCP server can publish JSON Schemas that do not exist in vendor
// documentation. Keep the captured contract stable without changing schema
// meaning: object keys and tool order are canonical, but schema arrays keep
// their original order.

function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function toolsFrom(response) {
  object(response, "capture input");
  if (response.error) throw new Error(`tools/list returned an error: ${response.error.message ?? response.error.code ?? "unknown error"}`);
  const result = response.jsonrpc ? object(response.result, "tools/list result") : response.result ?? response;
  const tools = object(result, "tools/list result").tools;
  if (!Array.isArray(tools)) throw new Error("tools/list result.tools must be an array");
  return tools;
}

export function normalizeMcpToolsCapture(response, metadata = {}) {
  const requiredMetadata = ["provider", "endpoint", "captured_at", "client", "client_version", "protocol_version"];
  for (const name of requiredMetadata) {
    if (typeof metadata[name] !== "string" || metadata[name].trim() === "") throw new Error(`${name} is required`);
  }
  if (!/^https:\/\//.test(metadata.endpoint)) throw new Error("endpoint must use https");
  if (Number.isNaN(Date.parse(metadata.captured_at))) throw new Error("captured_at must be an ISO date or timestamp");

  const names = new Set();
  const tools = toolsFrom(response).map((tool, index) => {
    object(tool, `tools[${index}]`);
    if (typeof tool.name !== "string" || tool.name.trim() === "") throw new Error(`tools[${index}].name is required`);
    if (names.has(tool.name)) throw new Error(`duplicate tool name: ${tool.name}`);
    names.add(tool.name);
    object(tool.inputSchema, `${tool.name}.inputSchema`);
    if (tool.inputSchema.type !== "object") throw new Error(`${tool.name}.inputSchema.type must be object`);
    if (tool.outputSchema !== undefined) object(tool.outputSchema, `${tool.name}.outputSchema`);
    return canonical(tool);
  }).sort((left, right) => left.name.localeCompare(right.name));

  return canonical({
    api_version: "worldfixture.mcp-tools-capture/v1",
    provider: metadata.provider,
    endpoint: metadata.endpoint,
    transport: "streamable-http",
    protocol_version: metadata.protocol_version,
    captured_at: new Date(metadata.captured_at).toISOString(),
    client: { name: metadata.client, version: metadata.client_version },
    account: { plan: metadata.plan ?? "unknown" },
    tool_count: tools.length,
    tools,
  });
}

export function serializeMcpToolsCapture(response, metadata) {
  return `${JSON.stringify(normalizeMcpToolsCapture(response, metadata), null, 2)}\n`;
}
