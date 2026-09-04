import { readFileSync } from "node:fs";

export const NOTION_MCP_SNAPSHOT = "2026-09-03";
export const NOTION_MCP_PROTOCOL_VERSION = "2025-11-25";

const contractUrl = new URL("../../../contracts/notion/hosted-mcp-tools-free-2026-09-03.json", import.meta.url);
const capturedContract = JSON.parse(readFileSync(contractUrl, "utf8"));

if (capturedContract.provider !== "notion"
  || capturedContract.transport !== "streamable-http"
  || capturedContract.protocol_version !== NOTION_MCP_PROTOCOL_VERSION
  || capturedContract.tool_count !== capturedContract.tools?.length) {
  throw new Error("The captured Notion MCP tools contract is invalid.");
}

export const notionMcpTools = capturedContract.tools;

export function toolsForClient() {
  return structuredClone(notionMcpTools);
}

export const NOTION_MCP_CAPTURE = Object.freeze({
  provider: capturedContract.provider,
  endpoint: capturedContract.endpoint,
  captured_at: capturedContract.captured_at,
  client: structuredClone(capturedContract.client),
  account: structuredClone(capturedContract.account),
});
