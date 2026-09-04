import { randomUUID } from "node:crypto";
import { createNotionDomain } from "./domain.mjs";
import { createNotionObjectStore } from "./object-store.mjs";

export const NOTION_VERSION = "2026-03-11";

function requestId() {
  return randomUUID();
}

export function notionError(c, status, code, message) {
  return c.json({ object: "error", status, code, message, request_id: requestId() }, status);
}

function actor(c, domain) {
  const auth = c.get("authUser");
  return auth ? domain.userByLogin(auth.login) : null;
}

function hasCapability(scopes, capability) {
  return scopes.includes(capability) || (capability === "insert:content" || capability === "update:content") && scopes.includes("write:content");
}

function guard(c, domain, { version = true, capability, allCapabilities } = {}) {
  const current = actor(c, domain);
  if (!current) return { response: notionError(c, 401, "unauthorized", "API token is invalid.") };
  if (domain.isMcpToken(c.get("authToken"))) {
    return { response: notionError(c, 401, "unauthorized", "This token is valid only for Notion MCP.") };
  }
  const scopes = c.get("authScopes") ?? [];
  const alternatives = Array.isArray(capability) ? capability : capability ? [capability] : [];
  if (alternatives.length && !alternatives.some((item) => hasCapability(scopes, item))) {
    return { response: notionError(c, 403, "restricted_resource", `Token does not have the ${alternatives.join(" or ")} capability.`) };
  }
  if (allCapabilities?.some((item) => !hasCapability(scopes, item))) {
    return { response: notionError(c, 403, "restricted_resource", `Token does not have all required content capabilities.`) };
  }
  if (version && c.req.header("Notion-Version") !== NOTION_VERSION) {
    return { response: notionError(c, 400, "validation_error", `Notion-Version must be ${NOTION_VERSION}.`) };
  }
  return { actor: current };
}

async function json(c) {
  if (!(c.req.header("Content-Type") ?? "").toLowerCase().startsWith("application/json")) return null;
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

function pageSize(c, body) {
  const raw = body?.page_size ?? c.req.query("page_size");
  if (raw === undefined) return 100;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= 100 ? value : null;
}

function validParent(parent, types) {
  if (!parent || typeof parent !== "object" || Array.isArray(parent)) return false;
  return types.some((type) => parent.type === type && (type === "workspace" ? parent.workspace === true : typeof parent[type] === "string"));
}

function validation(c, message) { return notionError(c, 400, "validation_error", message); }

export function registerRestRoutes(app, store, baseUrl, options = {}) {
  const objectStore = options.objectStore ?? createNotionObjectStore(process.env.WORLDFIXTURE_NOTION_OBJECT_STORE_URL);
  const domain = createNotionDomain(store, baseUrl, { objectStore, onChange: options.onChange });

  app.use("/v1/*", async (c, next) => {
    if (!["POST", "PATCH"].includes(c.req.method)) return next();
    const path = new URL(c.req.url).pathname;
    if (path === "/v1/oauth/authorize" || /^\/v1\/file_uploads\/[^/]+\/send$/.test(path)) return next();
    if (!(c.req.header("Content-Type") ?? "").toLowerCase().startsWith("application/json")) {
      return notionError(c, 400, "invalid_json", "Content-Type must be application/json.");
    }
    return next();
  });

  app.get("/v1/users", (c) => {
    const auth = guard(c, domain, { capability: "read:user" });
    if (auth.response) return auth.response;
    return c.json(domain.listUsers({ startCursor: c.req.query("start_cursor"), pageSize: c.req.query("page_size") }));
  });

  app.get("/v1/users/me", (c) => {
    const auth = guard(c, domain, { capability: "read:user" });
    if (auth.response) return auth.response;
    const { person: _person, ...current } = domain.user(auth.actor.notion_id);
    const workspace = domain.workspace();
    return c.json({ ...current, type: "bot", bot: {
      owner: { type: "workspace", workspace: true },
      workspace_id: workspace.id,
      workspace_name: workspace.name ?? auth.actor.workspace_name ?? null,
      workspace_limits: { max_file_upload_size_in_bytes: 20 * 1024 * 1024 },
    } });
  });

  app.get("/v1/users/:id", (c) => {
    const auth = guard(c, domain, { capability: "read:user" });
    if (auth.response) return auth.response;
    const result = domain.user(c.req.param("id"));
    return result ? c.json(result) : notionError(c, 404, "object_not_found", "Could not find user.");
  });

  app.get("/v1/custom_emojis", (c) => {
    const auth = guard(c, domain, { capability: "read:content" });
    if (auth.response) return auth.response;
    const size = pageSize(c);
    if (size === null) return validation(c, "page_size must be an integer from 1 through 100.");
    const result = domain.listCustomEmojis({ name: c.req.query("name"), startCursor: c.req.query("start_cursor"), pageSize: size });
    return result.invalid_cursor ? validation(c, "start_cursor is not valid.") : c.json(result);
  });

  app.post("/v1/search", async (c) => {
    const auth = guard(c, domain, { capability: "read:content" });
    if (auth.response) return auth.response;
    const body = await json(c);
    if (!body) return notionError(c, 400, "invalid_json", "The request body is not valid JSON.");
    const size = pageSize(c, body);
    if (size === null) return validation(c, "page_size must be an integer from 1 through 100.");
    if (body.filter?.property !== undefined && body.filter.property !== "object") return validation(c, "filter.property must be object.");
    if (body.filter?.value !== undefined && !["page", "data_source"].includes(body.filter.value)) return validation(c, "filter.value must be page or data_source.");
    if (body.sort?.timestamp !== undefined && body.sort.timestamp !== "last_edited_time") return validation(c, "sort.timestamp must be last_edited_time.");
    if (body.sort?.direction !== undefined && !["ascending", "descending"].includes(body.sort.direction)) return validation(c, "sort.direction must be ascending or descending.");
    const result = domain.search({ ...body, page_size: size }, auth.actor);
    return result.invalid_cursor ? validation(c, "start_cursor is not valid.") : c.json(result);
  });

  app.post("/v1/pages", async (c) => {
    const auth = guard(c, domain, { capability: "insert:content" });
    if (auth.response) return auth.response;
    const body = await json(c);
    if (!body) return notionError(c, 400, "invalid_json", "The request body is not valid JSON.");
    if (!validParent(body.parent, ["page_id", "data_source_id"])) return validation(c, "parent must identify a page or data source.");
    if (body.markdown !== undefined && (typeof body.markdown !== "string" || body.children !== undefined || body.content !== undefined)) return validation(c, "markdown must be a string and cannot be used with children or content.");
    if (body.children !== undefined && (!Array.isArray(body.children) || body.children.length > 100)) return validation(c, "children must contain no more than 100 blocks.");
    if (!domain.page(body.parent.page_id, auth.actor) && !domain.dataSource(body.parent.data_source_id, auth.actor)) return notionError(c, 404, "object_not_found", "Could not find parent.");
    const result = domain.createPage(body, auth.actor);
    if (result?.validation_error) return validation(c, result.validation_error);
    return c.json(result, 200);
  });

  app.get("/v1/pages/:id", (c) => {
    const auth = guard(c, domain, { capability: "read:content" });
    if (auth.response) return auth.response;
    const result = domain.page(c.req.param("id"), auth.actor);
    return result ? c.json(result) : notionError(c, 404, "object_not_found", "Could not find page.");
  });

  app.get("/v1/pages/:id/properties/:property_id", (c) => {
    const auth = guard(c, domain, { capability: "read:content" });
    if (auth.response) return auth.response;
    const size = pageSize(c);
    if (size === null) return validation(c, "page_size must be an integer from 1 through 100.");
    const result = domain.pageProperty(c.req.param("id"), c.req.param("property_id"), { startCursor: c.req.query("start_cursor"), pageSize: size, actor: auth.actor });
    if (result?.invalid_cursor) return validation(c, "start_cursor is not valid.");
    return result ? c.json(result) : notionError(c, 404, "object_not_found", "Could not find page property.");
  });

  app.get("/v1/pages/:id/markdown", (c) => {
    const auth = guard(c, domain, { capability: "read:content" });
    if (auth.response) return auth.response;
    const includeTranscript = c.req.query("include_transcript");
    if (includeTranscript !== undefined && !["true", "false"].includes(includeTranscript)) return validation(c, "include_transcript must be true or false.");
    const result = domain.markdownForPage(c.req.param("id"), auth.actor);
    if (!result) return notionError(c, 404, "object_not_found", "Could not find page or block.");
    const { title: _title, url: _url, text: _text, page: _page, ...response } = result;
    return c.json(response);
  });

  app.patch("/v1/pages/:id/markdown", async (c) => {
    const auth = guard(c, domain, { capability: "update:content" });
    if (auth.response) return auth.response;
    const body = await json(c);
    if (!body) return notionError(c, 400, "invalid_json", "The request body is not valid JSON.");
    const result = domain.updatePageMarkdown(c.req.param("id"), body, auth.actor);
    if (result?.validation_error) return validation(c, result.validation_error);
    if (!result) return notionError(c, 404, "object_not_found", "Could not find page.");
    return c.json(result.async_task ?? result, result.async_task ? 202 : 200);
  });

  app.patch("/v1/pages/:id", async (c) => {
    const auth = guard(c, domain, { capability: "update:content" });
    if (auth.response) return auth.response;
    const body = await json(c);
    if (!body) return notionError(c, 400, "invalid_json", "The request body is not valid JSON.");
    const result = domain.updatePage(c.req.param("id"), body, auth.actor);
    return result ? c.json(result) : notionError(c, 404, "object_not_found", "Could not find page.");
  });

  app.post("/v1/pages/:id/move", async (c) => {
    const auth = guard(c, domain, { capability: "update:content" });
    if (auth.response) return auth.response;
    const body = await json(c);
    if (!body) return notionError(c, 400, "invalid_json", "The request body is not valid JSON.");
    if (!validParent(body.parent, ["page_id", "data_source_id"])) return validation(c, "parent must identify a page or data source.");
    const result = domain.movePage(c.req.param("id"), body.parent, auth.actor);
    return result ? c.json(result) : notionError(c, 404, "object_not_found", "Could not find page or parent.");
  });

  app.post("/v1/blocks/meeting_notes", async (c) => {
    const auth = guard(c, domain, { capability: "insert:content" });
    if (auth.response) return auth.response;
    const body = await json(c);
    if (!body) return notionError(c, 400, "invalid_json", "The request body is not valid JSON.");
    const languages = new Set(["auto", "en", "zh-CN", "zh-TW", "es", "fr", "de", "ja", "ko", "pt", "ru", "th", "vi", "id", "da", "fi", "no", "nl", "it", "sv", "ar", "he", "pl"]);
    if (body.title !== undefined && typeof body.title !== "string") return validation(c, "title must be a string.");
    if (body.language !== undefined && !languages.has(body.language)) return validation(c, "language is not supported.");
    if (body.options !== undefined && (!body.options || typeof body.options !== "object" || body.options.kickoff_summary !== undefined && typeof body.options.kickoff_summary !== "boolean")) return validation(c, "options.kickoff_summary must be a boolean when supplied.");
    const fromUpload = body.source?.type === "file_upload" && typeof body.source.file_upload_id === "string" && validParent(body.parent, ["page_id"]);
    const fromBlock = body.source?.type === "block" && typeof body.source.block_id === "string" && body.parent === undefined;
    if (!fromUpload && !fromBlock) return validation(c, "Use a file_upload source with a page parent, or a block source without a parent.");
    const result = domain.createMeetingNote(body, auth.actor);
    if (result?.validation_error) return validation(c, result.validation_error);
    if (!result) return notionError(c, 404, "object_not_found", "Could not find the meeting-note source or parent.");
    const { parent: _parent, ...response } = result;
    return c.json(response);
  });

  app.post("/v1/blocks/meeting_notes/query", async (c) => {
    const auth = guard(c, domain, { capability: "read:content" });
    if (auth.response) return auth.response;
    const body = await json(c);
    if (!body) return notionError(c, 400, "invalid_json", "The request body is not valid JSON.");
    const result = domain.queryMeetingNotes(body, auth.actor);
    if (result.validation_error) return validation(c, result.validation_error);
    return c.json({ ...result, results: result.results.map(({ parent: _parent, ...item }) => item) });
  });

  app.get("/v1/blocks/:id", (c) => {
    const auth = guard(c, domain, { capability: "read:content" });
    if (auth.response) return auth.response;
    const result = domain.block(c.req.param("id"), auth.actor);
    return result ? c.json(result) : notionError(c, 404, "object_not_found", "Could not find block.");
  });

  app.get("/v1/blocks/:id/children", (c) => {
    const auth = guard(c, domain, { capability: "read:content" });
    if (auth.response) return auth.response;
    if (!domain.page(c.req.param("id"), auth.actor) && !domain.block(c.req.param("id"), auth.actor) && !domain.database(c.req.param("id"), auth.actor)) {
      return notionError(c, 404, "object_not_found", "Could not find block.");
    }
    const size = pageSize(c);
    if (size === null) return validation(c, "page_size must be an integer from 1 through 100.");
    const result = domain.children(c.req.param("id"), { startCursor: c.req.query("start_cursor"), pageSize: size, actor: auth.actor });
    return result.invalid_cursor ? validation(c, "start_cursor is not valid.") : c.json(result);
  });

  app.patch("/v1/blocks/:id/children", async (c) => {
    const auth = guard(c, domain, { capability: "insert:content" });
    if (auth.response) return auth.response;
    const body = await json(c);
    if (!body) return notionError(c, 400, "invalid_json", "The request body is not valid JSON.");
    if (!Array.isArray(body.children) || body.children.length < 1 || body.children.length > 100) return validation(c, "children must contain from 1 through 100 blocks.");
    if (body.after !== undefined || body.position && !["start", "end", "after_block"].includes(body.position.type)) return validation(c, "position is not valid for Notion-Version 2026-03-11.");
    const result = domain.appendChildren(c.req.param("id"), body, auth.actor);
    if (result?.validation_error) return validation(c, result.validation_error);
    return result ? c.json(result) : notionError(c, 404, "object_not_found", "Could not find block.");
  });

  app.patch("/v1/blocks/:id", async (c) => {
    const auth = guard(c, domain, { capability: "update:content" });
    if (auth.response) return auth.response;
    const body = await json(c);
    if (!body) return notionError(c, 400, "invalid_json", "The request body is not valid JSON.");
    const result = domain.updateBlock(c.req.param("id"), body, auth.actor);
    return result ? c.json(result) : notionError(c, 404, "object_not_found", "Could not find block.");
  });

  app.delete("/v1/blocks/:id", (c) => {
    const auth = guard(c, domain, { capability: "update:content" });
    if (auth.response) return auth.response;
    const result = domain.deleteBlock(c.req.param("id"), auth.actor);
    return result ? c.json(result) : notionError(c, 404, "object_not_found", "Could not find block.");
  });

  app.post("/v1/comments", async (c) => {
    const auth = guard(c, domain, { capability: "insert:comment" });
    if (auth.response) return auth.response;
    const body = await json(c);
    if (!body) return notionError(c, 400, "invalid_json", "The request body is not valid JSON.");
    const targets = Number(Boolean(body.parent?.page_id)) + Number(Boolean(body.parent?.block_id)) + Number(Boolean(body.discussion_id));
    const formats = Number(Array.isArray(body.rich_text)) + Number(typeof body.markdown === "string");
    if (targets !== 1 || formats !== 1 || body.rich_text?.length > 100) return validation(c, "Provide exactly one comment target and exactly one rich_text or markdown body.");
    const result = domain.createComment(body, auth.actor);
    return result ? c.json(result) : notionError(c, 404, "object_not_found", "Could not find comment target.");
  });

  app.get("/v1/comments", (c) => {
    const auth = guard(c, domain, { capability: "read:comment" });
    if (auth.response) return auth.response;
    if (!c.req.query("block_id")) return validation(c, "block_id is required.");
    const size = pageSize(c);
    if (size === null) return validation(c, "page_size must be an integer from 1 through 100.");
    const result = domain.listComments(c.req.query("block_id"), { startCursor: c.req.query("start_cursor"), pageSize: size, actor: auth.actor });
    if (result?.invalid_cursor) return validation(c, "start_cursor is not valid.");
    return result ? c.json(result) : notionError(c, 404, "object_not_found", "Could not find page or block.");
  });

  app.get("/v1/comments/:id", (c) => {
    const auth = guard(c, domain, { capability: "read:comment" });
    if (auth.response) return auth.response;
    const result = domain.comment(c.req.param("id"), auth.actor);
    return result ? c.json(result) : notionError(c, 404, "object_not_found", "Could not find comment.");
  });

  app.patch("/v1/comments/:id", async (c) => {
    const auth = guard(c, domain, { capability: "insert:comment" });
    if (auth.response) return auth.response;
    const body = await json(c);
    if (!body) return notionError(c, 400, "invalid_json", "The request body is not valid JSON.");
    const formats = Number(Array.isArray(body.rich_text)) + Number(typeof body.markdown === "string");
    if (formats !== 1 || body.rich_text?.length > 100) return validation(c, "Provide exactly one rich_text or markdown body.");
    const result = domain.updateComment(c.req.param("id"), body, auth.actor);
    return result ? c.json(result) : notionError(c, 404, "object_not_found", "Could not find comment.");
  });

  app.delete("/v1/comments/:id", (c) => {
    const auth = guard(c, domain, { capability: "insert:comment" });
    if (auth.response) return auth.response;
    const result = domain.deleteComment(c.req.param("id"), auth.actor);
    return result ? c.json(result) : notionError(c, 404, "object_not_found", "Could not find comment.");
  });

  app.post("/v1/file_uploads", async (c) => {
    const auth = guard(c, domain);
    if (auth.response) return auth.response;
    const body = await json(c);
    if (!body) return notionError(c, 400, "invalid_json", "The request body is not valid JSON.");
    const mode = body.mode ?? "single_part";
    if (!["single_part", "multi_part", "external_url"].includes(mode)) return validation(c, "mode is not valid.");
    if (typeof body.filename === "string" && Buffer.byteLength(body.filename) > 900) return validation(c, "filename must be no more than 900 bytes.");
    if (mode === "multi_part" && (typeof body.filename !== "string" || !Number.isInteger(body.number_of_parts) || body.number_of_parts < 1 || body.number_of_parts > 10000)) return validation(c, "multi_part requires filename and number_of_parts from 1 through 10000.");
    if (mode === "external_url" && (typeof body.external_url !== "string" || !body.external_url.startsWith("https://"))) return validation(c, "external_url mode requires an HTTPS external_url.");
    return c.json(domain.createFileUpload({ ...body, mode }, auth.actor));
  });

  app.get("/v1/file_uploads", (c) => {
    const auth = guard(c, domain);
    if (auth.response) return auth.response;
    const size = pageSize(c);
    const status = c.req.query("status");
    if (size === null || status && !["pending", "uploaded", "expired", "failed"].includes(status)) return validation(c, "Pagination or status is not valid.");
    const result = domain.listFileUploads({ status, startCursor: c.req.query("start_cursor"), pageSize: size, actor: auth.actor });
    return result.invalid_cursor ? validation(c, "start_cursor is not valid.") : c.json(result);
  });

  app.get("/v1/file_uploads/:id", (c) => {
    const auth = guard(c, domain);
    if (auth.response) return auth.response;
    const result = domain.fileUpload(c.req.param("id"), auth.actor);
    return result ? c.json(result) : notionError(c, 404, "object_not_found", "Could not find file upload.");
  });

  app.post("/v1/file_uploads/:id/send", async (c) => {
    const auth = guard(c, domain);
    if (auth.response) return auth.response;
    const storage = domain.fileUploadStorage(c.req.param("id"), auth.actor);
    if (!storage) return notionError(c, 404, "object_not_found", "Could not find file upload.");
    if (storage.status !== "pending" || storage.mode === "external_url") return validation(c, "This file upload cannot accept data.");
    let form;
    try { form = await c.req.raw.formData(); } catch { return validation(c, "The request must contain multipart form data."); }
    const file = form.get("file");
    if (!file || typeof file.arrayBuffer !== "function") return validation(c, "The multipart file field is required.");
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength > 20 * 1024 * 1024) return validation(c, "Each file part must be no more than 20 MiB.");
    const rawPart = form.get("part_number");
    const partNumber = storage.mode === "multi_part" ? Number(rawPart) : 1;
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > storage.number_of_parts) return validation(c, "part_number is not valid for this upload.");
    const key = storage.mode === "multi_part" ? `${storage.key}.parts/${String(partNumber).padStart(5, "0")}` : storage.key;
    try {
      await objectStore.put({ bucket: storage.bucket, key, bytes, contentType: file.type || storage.content_type, owner: auth.actor.notion_id });
      return c.json(domain.recordFileUploadPart(c.req.param("id"), { partNumber, contentLength: bytes.byteLength }, auth.actor));
    } catch (error) {
      return notionError(c, 500, error.code ?? "internal_server_error", error.message);
    }
  });

  app.post("/v1/file_uploads/:id/complete", async (c) => {
    const auth = guard(c, domain);
    if (auth.response) return auth.response;
    const storage = domain.fileUploadStorage(c.req.param("id"), auth.actor);
    if (!storage) return notionError(c, 404, "object_not_found", "Could not find file upload.");
    if (storage.mode !== "multi_part" || storage.status !== "pending") return validation(c, "This is not a pending multi-part upload.");
    if (storage.sent_parts.length !== storage.number_of_parts) return validation(c, "Send every file part before completion.");
    try {
      const parts = [];
      for (let partNumber = 1; partNumber <= storage.number_of_parts; partNumber += 1) {
        const key = `${storage.key}.parts/${String(partNumber).padStart(5, "0")}`;
        const part = await objectStore.get({ bucket: storage.bucket, key });
        if (!part) return validation(c, `File part ${partNumber} is missing.`);
        parts.push({ key, bytes: part.bytes });
      }
      const length = parts.reduce((total, part) => total + part.bytes.byteLength, 0);
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const part of parts) { bytes.set(part.bytes, offset); offset += part.bytes.byteLength; }
      await objectStore.put({ bucket: storage.bucket, key: storage.key, bytes, contentType: storage.content_type, owner: auth.actor.notion_id });
      await Promise.all(parts.map((part) => objectStore.delete({ bucket: storage.bucket, key: part.key })));
      const result = domain.completeFileUpload(c.req.param("id"), { contentLength: length }, auth.actor);
      return result?.incomplete ? validation(c, "Send every file part before completion.") : c.json(result);
    } catch (error) {
      return notionError(c, 500, error.code ?? "internal_server_error", error.message);
    }
  });

  app.post("/v1/databases", async (c) => {
    const auth = guard(c, domain, { capability: "insert:content" });
    if (auth.response) return auth.response;
    const body = await json(c);
    if (!body) return notionError(c, 400, "invalid_json", "The request body is not valid JSON.");
    if (!validParent(body.parent, ["page_id", "data_source_id"])) return validation(c, "parent must identify a page or wiki data source.");
    const result = domain.createDatabase(body, auth.actor);
    if (result?.validation_error) return validation(c, result.validation_error);
    return result ? c.json(result) : notionError(c, 404, "object_not_found", "Could not find parent.");
  });

  app.get("/v1/databases/:id", (c) => {
    const auth = guard(c, domain, { capability: "read:content" });
    if (auth.response) return auth.response;
    const result = domain.database(c.req.param("id"), auth.actor);
    return result ? c.json(result) : notionError(c, 404, "object_not_found", "Could not find database.");
  });

  app.patch("/v1/databases/:id", async (c) => {
    const auth = guard(c, domain, { capability: "update:content" });
    if (auth.response) return auth.response;
    const body = await json(c);
    if (!body) return notionError(c, 400, "invalid_json", "The request body is not valid JSON.");
    if (body.parent && !validParent(body.parent, ["page_id", "data_source_id"])) return validation(c, "parent must identify a page or wiki data source.");
    const result = domain.updateDatabase(c.req.param("id"), body, auth.actor);
    if (result?.validation_error) return validation(c, result.validation_error);
    return result ? c.json(result) : notionError(c, 404, "object_not_found", "Could not find database or parent.");
  });

  app.post("/v1/data_sources", async (c) => {
    const auth = guard(c, domain, { capability: "insert:content" });
    if (auth.response) return auth.response;
    const body = await json(c);
    if (!body) return notionError(c, 400, "invalid_json", "The request body is not valid JSON.");
    if (!validParent(body.parent, ["database_id"]) || !body.properties || typeof body.properties !== "object") return validation(c, "parent.database_id and properties are required.");
    const result = domain.createDataSource(body, auth.actor);
    return result ? c.json(result) : notionError(c, 404, "object_not_found", "Could not find database.");
  });

  app.get("/v1/data_sources/:id", (c) => {
    const auth = guard(c, domain, { capability: "read:content" });
    if (auth.response) return auth.response;
    const result = domain.dataSource(c.req.param("id"), auth.actor);
    return result ? c.json(result) : notionError(c, 404, "object_not_found", "Could not find data source.");
  });

  app.patch("/v1/data_sources/:id", async (c) => {
    const auth = guard(c, domain, { capability: "update:content" });
    if (auth.response) return auth.response;
    const body = await json(c);
    if (!body) return notionError(c, 400, "invalid_json", "The request body is not valid JSON.");
    if (body.parent && !validParent(body.parent, ["database_id"])) return validation(c, "parent.database_id is not valid.");
    const result = domain.updateDataSource(c.req.param("id"), body, auth.actor);
    return result ? c.json(result) : notionError(c, 404, "object_not_found", "Could not find data source or database.");
  });

  app.get("/v1/data_sources/:id/templates", (c) => {
    const auth = guard(c, domain, { capability: "read:content" });
    if (auth.response) return auth.response;
    const size = pageSize(c);
    if (size === null) return validation(c, "page_size must be an integer from 1 through 100.");
    const result = domain.dataSourceTemplates(c.req.param("id"), { name: c.req.query("name"), startCursor: c.req.query("start_cursor"), pageSize: size, actor: auth.actor });
    if (result?.invalid_cursor) return validation(c, "start_cursor is not valid.");
    return result ? c.json(result) : notionError(c, 404, "object_not_found", "Could not find data source.");
  });

  app.post("/v1/data_sources/:id/query", async (c) => {
    const auth = guard(c, domain, { capability: "read:content" });
    if (auth.response) return auth.response;
    const body = await json(c);
    if (!body) return notionError(c, 400, "invalid_json", "The request body is not valid JSON.");
    const size = pageSize(c, body);
    if (size === null || body.sorts && (!Array.isArray(body.sorts) || body.sorts.length > 100)) return validation(c, "Pagination or sorts are not valid.");
    const query = new URL(c.req.url).searchParams;
    const filterProperties = [...query.getAll("filter_properties[]"), ...query.getAll("filter_properties")];
    const result = domain.queryDataSource(c.req.param("id"), { ...body, page_size: size, filter_properties: filterProperties }, auth.actor);
    if (result?.invalid_cursor) return validation(c, "start_cursor is not valid.");
    if (result?.validation_error) return validation(c, result.validation_error);
    return result ? c.json(result) : notionError(c, 404, "object_not_found", "Could not find data source.");
  });

  app.post("/v1/views", async (c) => {
    const auth = guard(c, domain, { allCapabilities: ["insert:content", "update:content"] });
    if (auth.response) return auth.response;
    const body = await json(c);
    if (!body) return notionError(c, 400, "invalid_json", "The request body is not valid JSON.");
    const types = ["table", "board", "list", "calendar", "timeline", "gallery", "form", "chart", "map", "dashboard"];
    const targets = Number(typeof body.database_id === "string") + Number(typeof body.view_id === "string") + Number(Boolean(body.create_database && typeof body.create_database === "object"));
    if (targets !== 1 || !body.data_source_id || !body.name || !types.includes(body.type)) return validation(c, "Provide data_source_id, name, a supported type, and exactly one of database_id, view_id, or create_database.");
    if (body.sorts && (!Array.isArray(body.sorts) || body.sorts.length > 100)) return validation(c, "sorts must contain no more than 100 entries.");
    if (body.configuration?.type && body.configuration.type !== body.type) return validation(c, "configuration.type must match type.");
    if (body.position && !body.database_id || body.placement && !body.view_id) return validation(c, "position is only for database_id, and placement is only for view_id.");
    const result = domain.createView(body, auth.actor);
    if (result?.validation_error) return validation(c, result.validation_error);
    return result ? c.json(result) : notionError(c, 404, "object_not_found", "Could not find database or data source.");
  });

  app.get("/v1/views", (c) => {
    const auth = guard(c, domain, { capability: "read:content" });
    if (auth.response) return auth.response;
    if (!c.req.query("database_id") && !c.req.query("data_source_id")) return validation(c, "database_id or data_source_id is required.");
    const size = pageSize(c);
    if (size === null) return validation(c, "page_size must be an integer from 1 through 100.");
    const result = domain.listViews({ databaseId: c.req.query("database_id"), dataSourceId: c.req.query("data_source_id"), startCursor: c.req.query("start_cursor"), pageSize: size, actor: auth.actor });
    return result.invalid_cursor ? validation(c, "start_cursor is not valid.") : c.json(result);
  });

  app.get("/v1/views/:id", (c) => {
    const auth = guard(c, domain, { capability: "read:content" });
    if (auth.response) return auth.response;
    const result = domain.view(c.req.param("id"), auth.actor);
    return result ? c.json(result) : notionError(c, 404, "object_not_found", "Could not find view.");
  });

  app.post("/v1/views/:id/queries", async (c) => {
    const auth = guard(c, domain, { capability: "read:content" });
    if (auth.response) return auth.response;
    const body = await json(c);
    if (!body) return notionError(c, 400, "invalid_json", "The request body is not valid JSON.");
    const size = pageSize(c, body);
    if (size === null) return validation(c, "page_size must be an integer from 1 through 100.");
    const result = domain.createViewQuery(c.req.param("id"), { pageSize: size }, auth.actor);
    if (result?.validation_error) return validation(c, result.validation_error);
    return result ? c.json(result) : notionError(c, 404, "object_not_found", "Could not find view.");
  });

  app.get("/v1/views/:id/queries/:query_id", (c) => {
    const auth = guard(c, domain, { capability: "read:content" });
    if (auth.response) return auth.response;
    const size = pageSize(c);
    if (size === null) return validation(c, "page_size must be an integer from 1 through 100.");
    const result = domain.viewQueryResults(c.req.param("id"), c.req.param("query_id"), { startCursor: c.req.query("start_cursor"), pageSize: size }, auth.actor);
    if (result?.invalid_cursor) return validation(c, "start_cursor is not valid.");
    return result ? c.json(result) : notionError(c, 404, "object_not_found", "Could not find cached view query.");
  });

  app.delete("/v1/views/:id/queries/:query_id", (c) => {
    const auth = guard(c, domain, { capability: "read:content" });
    if (auth.response) return auth.response;
    const result = domain.deleteViewQuery(c.req.param("id"), c.req.param("query_id"), auth.actor);
    return result ? c.json(result) : notionError(c, 404, "object_not_found", "Could not find view.");
  });

  app.patch("/v1/views/:id", async (c) => {
    const auth = guard(c, domain, { capability: "update:content" });
    if (auth.response) return auth.response;
    const body = await json(c);
    if (!body) return notionError(c, 400, "invalid_json", "The request body is not valid JSON.");
    if (body.sorts && (!Array.isArray(body.sorts) || body.sorts.length > 100)) return validation(c, "sorts must contain no more than 100 entries.");
    const result = domain.updateView(c.req.param("id"), body, auth.actor);
    return result ? c.json(result) : notionError(c, 404, "object_not_found", "Could not find view.");
  });

  app.delete("/v1/views/:id", (c) => {
    const auth = guard(c, domain, { capability: "update:content" });
    if (auth.response) return auth.response;
    const result = domain.deleteView(c.req.param("id"), auth.actor);
    if (result?.last_view) return validation(c, "The last view in a database cannot be deleted.");
    return result ? c.json(result) : notionError(c, 404, "object_not_found", "Could not find view.");
  });

  app.get("/v1/async_tasks/:id", (c) => {
    const auth = guard(c, domain, { capability: "read:content" });
    if (auth.response) return auth.response;
    const result = domain.asyncTask(c.req.param("id"), auth.actor);
    return result ? c.json(result) : notionError(c, 404, "object_not_found", "Could not find async task.");
  });
}
