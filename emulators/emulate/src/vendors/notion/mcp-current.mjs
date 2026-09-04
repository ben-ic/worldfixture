import { randomUUID } from "node:crypto";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { createNotionDomain } from "./domain.mjs";
import { createNotionAgentDomain } from "./agents.mjs";
import { createNotionObjectStore } from "./object-store.mjs";
import { NOTION_MCP_PROTOCOL_VERSION, notionMcpTools, toolsForClient } from "./hosted-contract.mjs";
import { notionError } from "./rest.mjs";

const MINUTE = 60_000;
const ajv = new Ajv2020({ strict: false, allErrors: false });
addFormats(ajv);
const inputValidators = new Map(notionMcpTools.map((tool) => [tool.name, ajv.compile(tool.inputSchema)]));

function rpc(id, result) { return { jsonrpc: "2.0", id, result }; }
function rpcError(id, code, message, data) { return { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } }; }
function textResult(value, isError = false) { return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }], ...(isError ? { isError: true } : {}) }; }
function toolError(code, message, details) { return textResult({ object: "error", code, message, ...(details ? { details } : {}) }, true); }

function mediaType(value) {
  return String(value ?? "").split(";", 1)[0].trim().toLowerCase();
}

function acceptedMediaTypes(value) {
  return new Set(String(value ?? "").split(",").map((entry) => mediaType(entry)).filter(Boolean));
}

function schemaError(value, schema, path) {
  if (!schema || Object.keys(schema).length === 0) return null;
  if (schema.anyOf) {
    const valid = schema.anyOf.some((candidate) => schemaError(value, candidate, path) === null);
    if (!valid) return `${path} does not match a supported shape.`;
    return null;
  }
  if (schema.type === "string" && typeof value !== "string") return `${path} must be a string.`;
  if (schema.type === "boolean" && typeof value !== "boolean") return `${path} must be a boolean.`;
  if (schema.type === "integer" && !Number.isInteger(value)) return `${path} must be an integer.`;
  if (schema.type === "object" && (!value || typeof value !== "object" || Array.isArray(value))) return `${path} must be an object.`;
  if (schema.type === "array" && !Array.isArray(value)) return `${path} must be an array.`;
  if (schema.minLength !== undefined && value.length < schema.minLength) return `${path} must not be empty.`;
  if (schema.minItems !== undefined && value.length < schema.minItems) return `${path} must contain at least ${schema.minItems} item.`;
  if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${path} must contain at most ${schema.maxItems} items.`;
  if (schema.minimum !== undefined && value < schema.minimum) return `${path} must be at least ${schema.minimum}.`;
  if (schema.maximum !== undefined && value > schema.maximum) return `${path} must be at most ${schema.maximum}.`;
  if (schema.enum && !schema.enum.includes(value)) return `${path} is not supported.`;
  if (schema.pattern && typeof value === "string" && !(new RegExp(schema.pattern)).test(value)) return `${path} has an invalid format.`;
  if (schema.type === "array" && schema.items) {
    for (let index = 0; index < value.length; index += 1) {
      const invalid = schemaError(value[index], schema.items, `${path}[${index}]`);
      if (invalid) return invalid;
    }
  }
  if (schema.type === "object") {
    for (const required of schema.required ?? []) if (!Object.hasOwn(value, required)) return `${path}.${required} is required.`;
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!Object.hasOwn(schema.properties ?? {}, key)) return `${path}.${key} is not supported.`;
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (!Object.hasOwn(value, key)) continue;
      const invalid = schemaError(value[key], child, `${path}.${key}`);
      if (invalid) return invalid;
    }
  }
  return null;
}

function validateToolInput(name, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return "Tool arguments must be an object.";
  const schema = notionMcpTools.find((tool) => tool.name === name)?.inputSchema;
  if (!schema) return "Unknown tool.";
  const structural = schemaError(args, schema, "arguments");
  if (structural) return structural.replace(/^arguments\./, "");
  const validator = inputValidators.get(name);
  if (!validator(args)) {
    const issue = validator.errors?.[0];
    const location = issue?.instancePath ? issue.instancePath.slice(1).replaceAll("/", ".") : "arguments";
    return `${location} ${issue?.message ?? "does not match the hosted schema"}.`;
  }
  if (name === "notion-fetch" && (typeof args.id !== "string" || args.id.length === 0)) return "id must be a non-empty string.";
  if (name === "notion-search") {
    if (args.query !== undefined && typeof args.query !== "string") return "query must be a string.";
    if (args.page_size !== undefined && (!Number.isInteger(args.page_size) || args.page_size < 1 || args.page_size > 50)) return "page_size must be an integer from 1 through 50.";
    if (args.max_highlight_length !== undefined && (!Number.isInteger(args.max_highlight_length) || args.max_highlight_length < 0)) return "max_highlight_length must be a non-negative integer.";
    if (args.query_type !== undefined && !["internal", "user"].includes(args.query_type)) return "query_type is not supported.";
    if (args.content_search_mode !== undefined && !["workspace_search", "ai_search"].includes(args.content_search_mode)) return "content_search_mode is not supported.";
    if (args.filters !== undefined && (!args.filters || typeof args.filters !== "object" || Array.isArray(args.filters))) return "filters must be an object.";
    if (args.query_type === "user" && args.filters !== undefined) return "filters are valid only for an internal search.";
  }
  if (name === "notion-create-attachment") {
    const sources = ["content", "source_url", "source_file_id"].filter((key) => Object.hasOwn(args, key));
    if (sources.length !== 1) return "Provide exactly one of content, source_url, or source_file_id.";
    if ((args.content !== undefined || args.source_url !== undefined) && !args.filename) return "filename is required with content or source_url.";
    if (args.source_file_id !== undefined && args.filename !== undefined) return "filename cannot be used with source_file_id.";
    if (args.source_url !== undefined) {
      try {
        if (new URL(args.source_url).protocol !== "https:") return "source_url must be a direct public HTTPS URL.";
      } catch { return "source_url must be a direct public HTTPS URL."; }
    }
    if (args.content !== undefined && Buffer.byteLength(args.content, "utf8") > 200 * 1024) return "content must be at most 200 KiB of UTF-8 text.";
  }
  if (name === "notion-create-comment") {
    const formats = ["markdown", "rich_text"].filter((key) => Object.hasOwn(args, key));
    if (formats.length !== 1) return "Provide exactly one of markdown or rich_text.";
    if (args.discussion_id !== undefined && args.selection_with_ellipsis !== undefined) return "discussion_id and selection_with_ellipsis cannot be used together.";
  }
  if (name === "notion-create-pages" && args.creation_mode === "draft" && args.parent !== undefined) return "parent cannot be used with draft creation_mode.";
  if (name === "notion-update-folder") {
    if (args.command === "add_files" && !args.file_upload_ids?.length) return "file_upload_ids is required for add_files.";
    if (args.command === "remove_files" && !args.file_urls?.length) return "file_urls is required for remove_files.";
    if (args.command === "add_subfolder" && typeof args.title !== "string") return "title is required for add_subfolder.";
  }
  return null;
}

function sessionId(value) { return String(value ?? "").split(/[/?#]/).filter(Boolean).at(-1) ?? ""; }

function domainArguments(name, args) {
  if (name === "notion-query-data-sources") {
    const data = args.data;
    return { ...data, page_size: data.page_size ?? data.limit, sorts: data.sorts ?? data.sort, in_trash: data.is_archived };
  }
  if (name === "notion-convert-page-to-skill") return { ...args, page_id: args.page_url };
  if (name === "notion-search") return { ...args, filters: { ...args.filters, last_edited_by_user_ids: args.filters?.edited_by_user_ids } };
  if (name === "notion-update-data-source") return { ...args, name: args.title, properties: args.statements };
  if (name === "notion-create-view") return { ...args, configuration: args.configure };
  if (name === "notion-update-view") return { ...args, configuration: args.configure };
  if (name === "notion-search-sessions") return { ...args, query: args.question };
  if (name === "notion-spawn-session") return { ...args, message: args.initial_message };
  if (["notion-get-session-status", "notion-wait-session", "notion-stop-session", "notion-send-message-to-session", "notion-list-session-events", "notion-read-session-event"].includes(name)) {
    return { ...args, session_id: sessionId(args.session_url), page_size: args.count };
  }
  return args;
}

function accessMap() {
  return Object.fromEntries(notionMcpTools.map((tool) => [
    tool.name.replace(/^notion-/, "").replaceAll("-", "_"),
    { status: "available" },
  ]));
}

function renderFetch(entity) {
  if (entity.type === "self") {
    const person = entity.user;
    return { self: { workspace: entity.workspace, user: { id: person.id, name: person.name, type: person.type, email: person.person?.email ?? null }, current_tool_access: accessMap() } };
  }
  if (entity.type === "page") {
    const { record, rendered, path } = entity;
    const pathText = path.map((item) => `<page url="${item.url}">${item.title}</page>`).join("\n");
    return {
      metadata: { type: "page" }, title: rendered.title, url: rendered.url,
      text: `<page url="${rendered.url}">\n<ancestor-path>${pathText}</ancestor-path>\n<properties>${JSON.stringify(rendered.page.properties)}</properties>\n<content>\n${rendered.text}\n</content>\n</page>`,
      path, page_last_edited_at: record.last_edited_time, is_archived: Boolean(record.in_trash), cover: record.cover ?? null, icon: record.icon ?? null,
      ...(record.verification ? { verification: structuredClone(record.verification) } : {}),
      truncated: false, unknown_block_count: 0, unknown_block_ids: [],
    };
  }
  if (entity.type === "database") {
    const sources = entity.data_sources.map((source) => `<data-source url="collection://${source.notion_id}">${source.name}</data-source>`).join("\n");
    return { metadata: { type: "database" }, title: entity.record.title, url: entity.record.url, text: `<database url="${entity.record.url}">\n${sources}\n</database>`, data_sources: entity.data_sources.map((source) => ({ id: source.notion_id, name: source.name, url: `collection://${source.notion_id}`, properties: source.properties, templates: source.templates ?? [] })) };
  }
  if (entity.type === "data_source") {
    const record = entity.record;
    return { metadata: { type: "data_source" }, title: record.name, url: `collection://${record.notion_id}`, text: `<data-source url="collection://${record.notion_id}">\n${JSON.stringify(record.properties)}\n</data-source>`, properties: record.properties, templates: record.templates ?? [] };
  }
  if (entity.type === "view") {
    const record = entity.record;
    return { metadata: { type: "view" }, title: record.name, url: `view://${record.notion_id}`, text: `<view url="view://${record.notion_id}">\n${JSON.stringify({ type: record.type, filter: record.filter, sorts: record.sorts, configuration: record.configuration })}\n</view>`, filter: record.filter, sorts: record.sorts, configuration: record.configuration };
  }
  if (entity.type === "folder") {
    const record = entity.record;
    const files = (record.files ?? []).map((file) => `<file url="${file.url}">${file.name}</file>`).join("\n");
    const children = (record.child_folder_ids ?? []).map((id) => `<folder url="folder://${id}" />`).join("\n");
    return { metadata: { type: "folder" }, title: record.title, url: `folder://${record.notion_id}`, text: `<folder url="folder://${record.notion_id}">\n${files}\n${children}\n</folder>` };
  }
  return { metadata: { type: "block" }, title: entity.record.type, url: `block://${entity.record.notion_id}`, text: entity.text, truncated: false, unknown_block_count: 0, unknown_block_ids: [] };
}

function consumeLimit(store, actorId, toolName) {
  const current = Date.now();
  const key = `notion_mcp_rate_${actorId}`;
  const active = (store.getData(key) ?? []).filter((entry) => current - entry.at < MINUTE);
  if (active.length >= 180 || (toolName === "notion-search" && active.filter((entry) => entry.tool === "notion-search").length >= 30)) return { limited: true, retry_after_seconds: 60 };
  active.push({ at: current, tool: toolName });
  store.setData(key, active);
  return { limited: false };
}

function recordCall(store, actor, sessionId, name, args, result) {
  const calls = store.collection("notion_mcp_calls", ["sequence", "session_id", "user_id"]);
  calls.insert({ sequence: calls.count() + 1, session_id: sessionId ?? null, user_id: actor.notion_id, tool: name, arguments: structuredClone(args), is_error: Boolean(result.isError) });
}

async function callTool(name, args, domain, actor) {
  if (name === "notion-search") return textResult(domain.mcpSearch(args, actor));
  if (name === "notion-fetch") {
    const entity = domain.fetchEntity(args.id, actor, args);
    return entity ? textResult(renderFetch(entity)) : toolError("object_not_found", "Could not find content. The content can be absent or inaccessible.");
  }
  const methods = {
    "notion-create-file-upload": "mcpCreateFileUpload",
    "notion-create-attachment": "mcpCreateAttachment",
    "notion-download-attachment": "mcpDownloadAttachment",
    "notion-create-pages": "mcpCreatePages",
    "notion-update-page": "mcpUpdatePage",
    "notion-move-pages": "mcpMovePages",
    "notion-duplicate-page": "mcpDuplicatePage",
    "notion-create-database": "mcpCreateDatabase",
    "notion-create-folder": "mcpCreateFolder",
    "notion-update-folder": "mcpUpdateFolder",
    "notion-update-data-source": "mcpUpdateDataSource",
    "notion-create-view": "mcpCreateView",
    "notion-update-view": "mcpUpdateView",
    "notion-query-data-sources": "mcpQueryDataSources",
    "notion-query-multiple-data-sources": "mcpQueryDataSources",
    "notion-query-meeting-notes": "mcpQueryMeetingNotes",
    "notion-get-teams": "mcpGetTeams",
    "notion-get-users": "mcpGetUsers",
    "notion-get-self": "mcpGetSelf",
    "notion-list-agents": "mcpListAgents",
    "notion-search-agents": "mcpSearchAgents",
    "notion-query-sessions": "mcpQuerySessions",
    "notion-search-sessions": "mcpSearchSessions",
    "notion-spawn-session": "mcpSpawnSession",
    "notion-get-session-status": "mcpGetSessionStatus",
    "notion-wait-session": "mcpWaitSession",
    "notion-stop-session": "mcpStopSession",
    "notion-send-message-to-session": "mcpSendMessageToSession",
    "notion-list-session-events": "mcpListSessionEvents",
    "notion-read-session-event": "mcpReadSessionEvent",
    "notion-search-skills": "mcpSearchSkills",
    "notion-convert-page-to-skill": "mcpConvertPageToSkill",
    "notion-create-comment": "mcpCreateComment",
    "notion-get-comments": "mcpGetComments",
    "notion-get-async-task": "mcpGetAsyncTask",
  };
  const method = methods[name];
  if (["notion-list-private-pages", "notion-list-shared-pages", "notion-list-favorite-pages", "notion-list-recent-pages"].includes(name)) {
    const section = name.match(/^notion-list-(private|shared|favorite|recent)-pages$/)?.[1];
    const result = domain.mcpListSidebarPages(args, actor, section);
    return result ? textResult(result) : toolError("invalid_cursor", "The pagination cursor is invalid.");
  }
  if (name === "notion-show-advanced-analysis-next-steps") {
    const value = { kind: "query_multiple_data_sources_full_version_not_displayed" };
    return { ...textResult(value), structuredContent: value };
  }
  if (name === "notion-check-mcp-next-steps") {
    const value = { kind: "mcp_business_education_not_displayed" };
    return { ...textResult(value), structuredContent: value };
  }
  if (method) {
    if (typeof domain[method] !== "function") return toolError("not_implemented", `${name} is not available in this provider build.`);
    try {
      const normalizedArgs = domainArguments(name, args);
      const domainArgs = name === "notion-move-pages" ? { ...normalizedArgs, page_ids: normalizedArgs.page_or_database_ids } : normalizedArgs;
      const result = await domain[method](domainArgs, actor);
      return result === null || result === undefined
        ? toolError("object_not_found", "Could not find content. The content can be absent or inaccessible.")
        : textResult(result);
    } catch (error) {
      return toolError(error?.code ?? "validation_error", error?.message ?? "The operation could not be completed.", error?.details);
    }
  }
  return toolError("invalid_tool", `Unknown tool: ${name}`);
}

export function registerMcpRoutes(app, store, baseUrl, options = {}) {
  const objectStore = options.objectStore ?? createNotionObjectStore(process.env.WORLDFIXTURE_NOTION_OBJECT_STORE_URL);
  const domain = {
    ...createNotionDomain(store, baseUrl, { objectStore, onChange: options.onChange }),
    ...createNotionAgentDomain(store, baseUrl),
  };
  const sessions = store.collection("notion_mcp_sessions", ["session_id", "user_id"]);
  const unauthorized = (c) => {
    c.header("WWW-Authenticate", `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource/mcp", scope="default"`);
    return notionError(c, 401, "unauthorized", "OAuth access token is invalid.");
  };
  const authorized = (c) => {
    const auth = c.get("authUser");
    const actor = auth ? domain.userByLogin(auth.login) : null;
    return actor && domain.isActiveMcpToken(c.get("authToken")) ? actor : null;
  };
  const sessionFor = (c, actor) => {
    const id = c.req.header("MCP-Session-Id");
    const session = id ? sessions.findOneBy("session_id", id) : null;
    return session?.user_id === actor.notion_id ? session : null;
  };

  app.get("/__worldfixture/mcp-observability", (c) => {
    if (!c.get("authUser") || domain.isMcpToken(c.get("authToken"))) return notionError(c, 401, "unauthorized", "REST token is invalid.");
    const domainState = typeof domain.observability === "function" ? domain.observability() : {};
    return c.json({ sessions: sessions.all(), calls: store.collection("notion_mcp_calls", ["sequence", "session_id", "user_id"]).all(), ...domainState });
  });

  app.get("/mcp", (c) => authorized(c) ? c.json(rpcError(null, -32000, "This server does not provide an event stream."), 405, { Allow: "POST, DELETE" }) : unauthorized(c));
  app.delete("/mcp", (c) => {
    const actor = authorized(c);
    if (!actor) return unauthorized(c);
    const session = sessionFor(c, actor);
    if (session) sessions.delete(session.id);
    return c.body(null, 204);
  });
  app.post("/mcp", async (c) => {
    const actor = authorized(c);
    if (!actor) return unauthorized(c);
    if (mediaType(c.req.header("Content-Type")) !== "application/json") {
      return c.json(rpcError(null, -32600, "Content-Type must be application/json."), 415);
    }
    const accepted = acceptedMediaTypes(c.req.header("Accept"));
    if (!accepted.has("application/json") || !accepted.has("text/event-stream")) {
      return c.json(rpcError(null, -32600, "Accept must list application/json and text/event-stream."), 406);
    }
    let body;
    try { body = await c.req.json(); } catch { return c.json(rpcError(null, -32700, "Parse error"), 400); }
    if (body.method === "initialize") {
      if (typeof body.params?.protocolVersion !== "string" || body.params.protocolVersion.length === 0) {
        return c.json(rpcError(body.id, -32602, "protocolVersion is required."));
      }
      const sessionId = randomUUID();
      sessions.insert({ session_id: sessionId, user_id: actor.notion_id, client_name: body.params?.clientInfo?.name ?? "", protocol_version: NOTION_MCP_PROTOCOL_VERSION });
      c.header("Mcp-Session-Id", sessionId);
      return c.json(rpc(body.id, { protocolVersion: NOTION_MCP_PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "WorldFixture Notion MCP", version: "0.2.0" } }));
    }
    const requestedVersion = c.req.header("MCP-Protocol-Version");
    if (requestedVersion && requestedVersion !== NOTION_MCP_PROTOCOL_VERSION) {
      return c.json(rpcError(body.id, -32600, `MCP-Protocol-Version must be ${NOTION_MCP_PROTOCOL_VERSION}.`), 400);
    }
    if (body.method?.startsWith("notifications/")) return c.body(null, 202);
    const session = sessionFor(c, actor);
    const advertised = toolsForClient(session?.client_name ?? "");
    if (body.method === "ping") return c.json(rpc(body.id, {}));
    if (body.method === "tools/list") return c.json(rpc(body.id, { tools: advertised }));
    if (body.method === "tools/call") {
      const requested = body.params?.name;
      if (!advertised.some((tool) => tool.name === requested)) return c.json(rpcError(body.id, -32602, `Unknown tool: ${requested}`));
      const canonical = requested === "search" ? "notion-search" : requested === "fetch" ? "notion-fetch" : requested;
      const args = body.params?.arguments ?? {};
      const invalid = validateToolInput(canonical, args);
      if (invalid) return c.json(rpcError(body.id, -32602, invalid));
      const rate = consumeLimit(store, actor.notion_id, canonical);
      const result = rate.limited ? toolError("rate_limited", "Rate limit exceeded.", { retry_after_seconds: rate.retry_after_seconds }) : await callTool(canonical, args, domain, actor);
      recordCall(store, actor, session?.session_id, canonical, args, result);
      return c.json(rpc(body.id, result));
    }
    return c.json(rpcError(body.id, -32601, `Method not found: ${body.method}`));
  });
}

export { NOTION_MCP_PROTOCOL_VERSION as PROTOCOL_VERSION, callTool, notionMcpTools, validateToolInput };
