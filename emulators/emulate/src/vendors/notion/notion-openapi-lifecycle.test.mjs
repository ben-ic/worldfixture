import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { createServer } from "@emulators/core";

import { plugin, seedFromConfig } from "./index.mjs";
import { NOTION_VERSION } from "./rest.mjs";

const USER = "00000000-0000-4000-8000-000000000001";
const PAGE = "10000000-0000-4000-8000-000000000001";
const DATABASE = "30000000-0000-4000-8000-000000000001";
const SOURCE = "40000000-0000-4000-8000-000000000001";
const VIEW = "50000000-0000-4000-8000-000000000001";
const EMOJI = "b0000000-0000-4000-8000-000000000001";
const AGENT = "aa000000-0000-4000-8000-000000000001";
const CANCEL_SESSION = "a1000000-0000-4000-8000-000000000099";
const DEFAULT_SPEC = new URL("../../../contracts/notion/public-api-2026-03-11.openapi.json", import.meta.url);
const SPEC_PATH = process.env.NOTION_PUBLIC_OPENAPI ?? DEFAULT_SPEC;

function fixture() {
  const baseUrl = "http://notion.worldfixture.test";
  const objects = new Map();
  process.env.WORLDFIXTURE_NOTION_OBJECT_STORE_URL = "http://object-store.test";
  process.env.WORLDFIXTURE_NOTION_OBJECT_STORE_ACCESS_KEY_ID = "test-access";
  process.env.WORLDFIXTURE_NOTION_OBJECT_STORE_SECRET_ACCESS_KEY = "test-secret";
  process.env.WORLDFIXTURE_NOTION_OBJECT_STORE_REGION = "us-east-1";
  globalThis.fetch = async (url, init = {}) => {
    const key = String(url);
    if (init.method === "PUT") { objects.set(key, { bytes: new Uint8Array(await new Response(init.body).arrayBuffer()), contentType: init.headers?.["content-type"] }); return new Response(null, { status: 200 }); }
    if (init.method === "DELETE") { objects.delete(key); return new Response(null, { status: 204 }); }
    const object = objects.get(key);
    return object ? new Response(object.bytes, { status: 200, headers: { "content-type": object.contentType } }) : new Response(null, { status: 404 });
  };
  const server = createServer(plugin, { baseUrl, tokens: { full: { login: "maya@example.test", id: 1, scopes: ["read:user", "read:content", "insert:content", "update:content", "read:comment", "insert:comment", "interact:agents"] } } });
  seedFromConfig(server.store, baseUrl, {
    workspace: { id: "60000000-0000-4000-8000-000000000001", name: "Northstar" },
    users: [{ id: USER, name: "Maya Chen", email: "maya@example.test" }],
    custom_emojis: [{ id: EMOJI, name: "northstar", url: "https://assets.example.test/northstar.png" }],
    databases: [{ id: DATABASE, title: "Projects", parent: { type: "workspace", workspace: true }, accessible_by: [USER] }],
    data_sources: [{ id: SOURCE, database_id: DATABASE, name: "Projects", properties: { Name: { id: "title", type: "title" }, Status: { id: "status", type: "status" } }, templates: [{ id: PAGE, name: "Project" }], accessible_by: [USER] }],
    views: [{ id: VIEW, database_id: DATABASE, data_source_id: SOURCE, name: "Projects", type: "table", configuration: { type: "table", properties: [] }, accessible_by: [USER] }],
    pages: [{ id: PAGE, parent: { type: "data_source_id", data_source_id: SOURCE }, properties: { Name: { id: "title", type: "title", title: [{ type: "text", text: { content: "Launch" } }] } }, created_by: USER, accessible_by: [USER], children: [{ type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: "Plan" } }] } }] }],
    agents: [{ id: AGENT, name: "Planner", created_by: USER, accessible_by: [USER], editable_by: [USER], default_response: "Ready." }],
    agent_sessions: [{ id: CANCEL_SESSION, agent_id: AGENT, title: "Cancel me", status: "in_progress", created_at: "2026-09-03T09:00:00.000Z", updated_at: "2026-09-03T09:00:00.000Z", created_by: USER, accessible_by: [USER] }],
  });
  return server;
}

function operationCount(spec) {
  return Object.values(spec.paths).flatMap((path) => ["get", "post", "patch", "delete"].filter((method) => path[method])).length;
}

test("all 61 official public operations return OpenAPI-valid success JSON", { skip: !existsSync(SPEC_PATH) && "Set NOTION_PUBLIC_OPENAPI to the official ntn OpenAPI file." }, async () => {
  const specBytes = readFileSync(SPEC_PATH);
  assert.equal(createHash("sha256").update(specBytes).digest("hex"), "1542bad104f5ca9f559e34400a9206fdb672a98f5a7a9e6ae01f1a3c81655888");
  const spec = JSON.parse(specBytes);
  assert.deepEqual(spec.components.parameters.notionVersion.schema.enum, ["2026-03-11"]);
  assert.equal(Object.keys(spec.components.schemas).length, 523);
  assert.equal(operationCount(spec), 61, "The pinned public contract must contain 61 operations.");
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
  addFormats(ajv);
  // The published document combines `allOf` object fragments that each set
  // `additionalProperties: false`. JSON Schema applies that keyword before the
  // sibling fragment is evaluated, so an otherwise exact Notion user fails.
  // Keep all required, enum, union, type, format, and bound validation, but
  // remove only this contradictory generated keyword from the validation copy.
  const validationComponents = structuredClone(spec.components);
  const relaxGeneratedObjects = (value, preserve = false) => {
    if (!value || typeof value !== "object") return;
    if (!preserve && value.additionalProperties === false) delete value.additionalProperties;
    for (const child of Object.values(value)) relaxGeneratedObjects(child);
  };
  for (const [name, schema] of Object.entries(validationComponents.schemas)) relaxGeneratedObjects(schema, name === "emptyObject" || name.startsWith("partial"));
  const validators = new Map();
  const seen = new Set();
  const { app, baseUrl } = fixture();
  const auth = { Authorization: "Bearer full", "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" };

  const validator = (schema, key) => {
    if (!validators.has(key)) validators.set(key, ajv.compile({ $id: `urn:notion:${encodeURIComponent(key)}`, ...schema, components: validationComponents }));
    return validators.get(key);
  };
  const resolve = (schema) => {
    const name = schema?.$ref?.match(/^#\/components\/schemas\/(.+)$/)?.[1];
    return name ? spec.components.schemas[name] : schema;
  };
  const fragments = (schema, value) => {
    const current = resolve(schema) ?? {};
    const result = [current];
    for (const item of current.allOf ?? []) result.push(...fragments(item, value));
    for (const choices of [current.oneOf, current.anyOf]) {
      if (!choices) continue;
      const matches = choices.filter((choice) => {
        const candidate = resolve(choice) ?? {};
        if ((candidate.required ?? []).some((name) => !Object.hasOwn(value ?? {}, name))) return false;
        return Object.entries(candidate.properties ?? {}).every(([name, property]) => {
          const rule = resolve(property) ?? {};
          return !Object.hasOwn(value ?? {}, name) || rule.const === undefined || value[name] === rule.const;
        });
      });
      for (const item of matches.length ? matches : choices) result.push(...fragments(item, value));
    }
    return result;
  };
  const assertExact = (value, schema, path = "data") => {
    const parts = fragments(schema, value);
    if (Array.isArray(value)) {
      const itemSchema = parts.find((part) => part.items)?.items;
      if (itemSchema) value.forEach((item, index) => assertExact(item, itemSchema, `${path}/${index}`));
      return;
    }
    if (!value || typeof value !== "object") return;
    const properties = Object.assign({}, ...parts.map((part) => part.properties ?? {}));
    if (parts.some((part) => part.additionalProperties === false)) {
      const extras = Object.keys(value).filter((name) => !Object.hasOwn(properties, name));
      assert.deepEqual(extras, [], `${path} has undocumented fields`);
    }
    for (const [name, child] of Object.entries(value)) if (properties[name]) assertExact(child, properties[name], `${path}/${name}`);
  };
  async function hit(method, template, path = template, options = {}) {
    const operation = spec.paths[template]?.[method.toLowerCase()];
    assert.ok(operation, `${method} ${template} is not in the official contract`);
    const key = `${method.toUpperCase()} ${template}`;
    assert.equal(seen.has(key), false, `${key} was called more than once`);
    const headers = { ...auth, ...(options.headers ?? {}) };
    if (options.form) delete headers["Content-Type"];
    const requestSchema = operation.requestBody?.content?.["application/json"]?.schema;
    if (options.body !== undefined && requestSchema) {
      const validateRequest = validator(requestSchema, `${key}:request`);
      assert.ok(validateRequest(options.body), `${key} request failed OpenAPI validation:\n${ajv.errorsText(validateRequest.errors, { separator: "\n" })}\n${JSON.stringify(options.body)}`);
      assertExact(options.body, requestSchema, "request");
    }
    const response = await app.request(path, { method, headers, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }), ...(options.form ? { body: options.form } : {}) });
    const text = await response.text();
    let value;
    try { value = JSON.parse(text); } catch { assert.fail(`${key} did not return JSON: ${text}`); }
    assert.ok(response.status >= 200 && response.status < 300, `${key} returned ${response.status}: ${text}`);
    const responseContract = operation.responses[String(response.status)] ?? operation.responses.default;
    const schema = responseContract?.content?.["application/json"]?.schema;
    assert.ok(schema, `${key} has no JSON schema for status ${response.status}`);
    const validate = validator(schema, `${key}:${response.status}`);
    assert.ok(validate(value), `${key} response failed OpenAPI validation:\n${ajv.errorsText(validate.errors, { separator: "\n" })}\n${text}`);
    assertExact(value, schema);
    seen.add(key);
    return value;
  }

  await hit("GET", "/v1/users");
  await hit("GET", "/v1/users/me");
  await hit("GET", "/v1/users/{user_id}", `/v1/users/${USER}`);
  await hit("GET", "/v1/custom_emojis");
  await hit("POST", "/v1/search", undefined, { body: { query: "Launch" } });

  const page = await hit("POST", "/v1/pages", undefined, { body: { parent: { type: "data_source_id", data_source_id: SOURCE }, properties: { Name: { type: "title", title: [{ type: "text", text: { content: "Lifecycle" } }] } } } });
  await hit("GET", "/v1/pages/{page_id}", `/v1/pages/${page.id}`);
  await hit("PATCH", "/v1/pages/{page_id}", `/v1/pages/${page.id}`, { body: { is_locked: true } });
  await hit("POST", "/v1/pages/{page_id}/move", `/v1/pages/${page.id}/move`, { body: { parent: { type: "page_id", page_id: PAGE } } });
  await hit("GET", "/v1/pages/{page_id}/properties/{property_id}", `/v1/pages/${PAGE}/properties/title`);
  await hit("GET", "/v1/pages/{page_id}/markdown", `/v1/pages/${PAGE}/markdown`);
  const task = await hit("PATCH", "/v1/pages/{page_id}/markdown", `/v1/pages/${PAGE}/markdown`, { body: { type: "replace_content", replace_content: { new_str: "# Launch\nUpdated" }, allow_async: true } });

  const children = await hit("GET", "/v1/blocks/{block_id}/children", `/v1/blocks/${PAGE}/children`);
  const block = children.results[0];
  await hit("GET", "/v1/blocks/{block_id}", `/v1/blocks/${block.id}`);
  await hit("PATCH", "/v1/blocks/{block_id}", `/v1/blocks/${block.id}`, { body: { paragraph: { rich_text: [{ type: "text", text: { content: "Changed" } }] } } });
  const text = (content) => [{ type: "text", text: { content } }];
  const external = (url) => ({ type: "external", external: { url }, caption: [] });
  const appended = await hit("PATCH", "/v1/blocks/{block_id}/children", `/v1/blocks/${PAGE}/children`, { body: { children: [
    { type: "audio", audio: external("https://assets.example.test/audio.mp3") },
    { type: "bookmark", bookmark: { url: "https://example.test", caption: [] } },
    { type: "breadcrumb", breadcrumb: {} },
    { type: "bulleted_list_item", bulleted_list_item: { rich_text: text("Bullet"), color: "default" } },
    { type: "callout", callout: { rich_text: text("Callout"), color: "default", icon: { type: "emoji", emoji: "📌" } } },
    { type: "code", code: { rich_text: text("const ok = true"), language: "javascript", caption: [] } },
    { type: "column_list", column_list: { children: [
      { type: "column", column: { width_ratio: 0.5, children: [{ type: "paragraph", paragraph: { rich_text: text("Left") } }] } },
      { type: "column", column: { width_ratio: 0.5, children: [{ type: "paragraph", paragraph: { rich_text: text("Right") } }] } },
    ] } },
    { type: "divider", divider: {} },
    { type: "embed", embed: { url: "https://example.test/embed", caption: [] } },
    { type: "equation", equation: { expression: "x^2" } },
    { type: "file", file: { ...external("https://assets.example.test/file.txt"), name: "file.txt" } },
    ...[1, 2, 3, 4].map((level) => ({ type: `heading_${level}`, [`heading_${level}`]: { rich_text: text(`Heading ${level}`), color: "default", is_toggleable: false } })),
    { type: "image", image: external("https://assets.example.test/image.png") },
    { type: "link_to_page", link_to_page: { type: "page_id", page_id: PAGE } },
    { type: "numbered_list_item", numbered_list_item: { rich_text: text("Number"), color: "default" } },
    { type: "paragraph", paragraph: { rich_text: text("Delete"), color: "default" } },
    { type: "pdf", pdf: external("https://assets.example.test/file.pdf") },
    { type: "quote", quote: { rich_text: text("Quote"), color: "default" } },
    { type: "synced_block", synced_block: { synced_from: null, children: [{ type: "paragraph", paragraph: { rich_text: text("Synced") } }] } },
    { type: "table", table: { table_width: 2, has_column_header: true, has_row_header: false, children: [{ type: "table_row", table_row: { cells: [text("A"), text("B")] } }] } },
    { type: "table_of_contents", table_of_contents: { color: "default" } },
    { type: "tab", tab: { children: [{ type: "paragraph", paragraph: { rich_text: text("Tab") } }] } },
    { type: "template", template: { rich_text: text("Template"), children: [{ type: "paragraph", paragraph: { rich_text: text("Template body") } }] } },
    { type: "to_do", to_do: { rich_text: text("Todo"), checked: false, color: "default" } },
    { type: "toggle", toggle: { rich_text: text("Toggle"), color: "default", children: [{ type: "paragraph", paragraph: { rich_text: text("Inside") } }] } },
    { type: "video", video: external("https://assets.example.test/video.mp4") },
  ] } });
  await hit("DELETE", "/v1/blocks/{block_id}", `/v1/blocks/${appended.results[0].id}`);
  await hit("POST", "/v1/blocks/meeting_notes", undefined, { body: { source: { type: "block", block_id: block.id }, title: "Review", language: "en" } });
  await hit("POST", "/v1/blocks/meeting_notes/query", undefined, { body: { limit: 10 } });

  const comment = await hit("POST", "/v1/comments", undefined, { body: { parent: { page_id: PAGE }, rich_text: [{ type: "text", text: { content: "Review" } }] } });
  await hit("GET", "/v1/comments", `/v1/comments?block_id=${PAGE}`);
  await hit("GET", "/v1/comments/{comment_id}", `/v1/comments/${comment.id}`);
  await hit("PATCH", "/v1/comments/{comment_id}", `/v1/comments/${comment.id}`, { body: { rich_text: [{ type: "text", text: { content: "Done" } }] } });
  await hit("DELETE", "/v1/comments/{comment_id}", `/v1/comments/${comment.id}`);

  const upload = await hit("POST", "/v1/file_uploads", undefined, { body: { mode: "multi_part", filename: "note.txt", content_type: "text/plain", number_of_parts: 1 } });
  await hit("GET", "/v1/file_uploads");
  await hit("GET", "/v1/file_uploads/{file_upload_id}", `/v1/file_uploads/${upload.id}`);
  const form = new FormData(); form.set("file", new Blob(["hello"], { type: "text/plain" }), "note.txt"); form.set("part_number", "1");
  await hit("POST", "/v1/file_uploads/{file_upload_id}/send", `/v1/file_uploads/${upload.id}/send`, { form });
  await hit("POST", "/v1/file_uploads/{file_upload_id}/complete", `/v1/file_uploads/${upload.id}/complete`, { body: {} });

  const database = await hit("POST", "/v1/databases", undefined, { body: { parent: { type: "page_id", page_id: PAGE }, title: [{ type: "text", text: { content: "Roadmap" } }], initial_data_source: { properties: { Name: { type: "title", title: {} } } } } });
  await hit("GET", "/v1/databases/{database_id}", `/v1/databases/${database.id}`);
  await hit("PATCH", "/v1/databases/{database_id}", `/v1/databases/${database.id}`, { body: { is_inline: true } });
  const source = await hit("POST", "/v1/data_sources", undefined, { body: { parent: { type: "database_id", database_id: database.id }, title: [{ type: "text", text: { content: "Tasks" } }], properties: { Name: { type: "title", title: {} } } } });
  await hit("GET", "/v1/data_sources/{data_source_id}", `/v1/data_sources/${source.id}`);
  await hit("PATCH", "/v1/data_sources/{data_source_id}", `/v1/data_sources/${source.id}`, { body: { title: [{ type: "text", text: { content: "Work" } }] } });
  await hit("POST", "/v1/data_sources/{data_source_id}/query", `/v1/data_sources/${SOURCE}/query`, { body: {} });
  await hit("GET", "/v1/data_sources/{data_source_id}/templates", `/v1/data_sources/${SOURCE}/templates`);

  const view = await hit("POST", "/v1/views", undefined, { body: { database_id: database.id, data_source_id: database.data_sources[0].id, name: "Roadmap", type: "table", configuration: { type: "table", properties: [] } } });
  await hit("GET", "/v1/views", `/v1/views?database_id=${database.id}`);
  await hit("GET", "/v1/views/{view_id}", `/v1/views/${view.id}`);
  await hit("PATCH", "/v1/views/{view_id}", `/v1/views/${view.id}`, { body: { name: "Current roadmap" } });
  const viewQuery = await hit("POST", "/v1/views/{view_id}/queries", `/v1/views/${VIEW}/queries`, { body: { page_size: 10 } });
  await hit("GET", "/v1/views/{view_id}/queries/{query_id}", `/v1/views/${VIEW}/queries/${viewQuery.id}`);
  await hit("DELETE", "/v1/views/{view_id}/queries/{query_id}", `/v1/views/${VIEW}/queries/${viewQuery.id}`);
  await hit("DELETE", "/v1/views/{view_id}", `/v1/views/${view.id}`);
  await hit("GET", "/v1/async_tasks/{task_id}", `/v1/async_tasks/${task.id}`);

  const registration = await (await app.request("/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "OpenAPI", redirect_uris: ["https://client.example.test/callback"], token_endpoint_auth_method: "client_secret_basic" }) })).json();
  const consent = await app.request("/v1/oauth/authorize", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: registration.client_id, redirect_uri: registration.redirect_uris[0], response_type: "code", owner: "user", user_id: USER, decision: "approve" }) });
  const code = new URL(consent.headers.get("location")).searchParams.get("code");
  const basic = `Basic ${Buffer.from(`${registration.client_id}:${registration.client_secret}`).toString("base64")}`;
  const token = await hit("POST", "/v1/oauth/token", undefined, { headers: { Authorization: basic }, body: { grant_type: "authorization_code", code, redirect_uri: registration.redirect_uris[0] } });
  await hit("POST", "/v1/oauth/introspect", undefined, { headers: { Authorization: basic }, body: { token: token.access_token } });
  await hit("POST", "/v1/oauth/revoke", undefined, { headers: { Authorization: basic }, body: { token: token.access_token } });

  await hit("POST", "/v1/agents/query", undefined, { body: {} });
  await hit("GET", "/v1/agents/{agent_id}", `/v1/agents/${AGENT}`);
  await hit("GET", "/v1/agents/{agent_id}/insights", `/v1/agents/${AGENT}/insights`);
  await hit("PATCH", "/v1/agents/{agent_id}/credit_limit", `/v1/agents/${AGENT}/credit_limit`, { body: { credit_limit: 100 } });
  await hit("PATCH", "/v1/agents/{agent_id}/status", `/v1/agents/${AGENT}/status`, { body: { status: "active" } });
  await hit("POST", "/v1/agents/batch", undefined, { body: { operations: [{ action: "update_credit_limit", agent_id: AGENT, fields: { credit_limit: 200 } }] } });
  const session = await hit("POST", "/v1/sessions", undefined, { body: { agent_id: AGENT, message: "Plan" } });
  await hit("POST", "/v1/sessions/query", undefined, { body: {} });
  await hit("GET", "/v1/sessions/{session_id}", `/v1/sessions/${session.id}`);
  await hit("POST", "/v1/sessions/{session_id}/events/query", `/v1/sessions/${session.id}/events/query`, { body: {} });
  await hit("POST", "/v1/sessions/{session_id}/cancel", `/v1/sessions/${CANCEL_SESSION}/cancel`, { body: {} });
  await hit("DELETE", "/v1/agents/{agent_id}", `/v1/agents/${AGENT}`);

  const official = new Set(Object.entries(spec.paths).flatMap(([path, methods]) => ["get", "post", "patch", "delete"].filter((method) => methods[method]).map((method) => `${method.toUpperCase()} ${path}`)));
  assert.deepEqual([...seen].sort(), [...official].sort());
  assert.equal(seen.size, 61);
  assert.equal(baseUrl, "http://notion.worldfixture.test");
});

test("public operations enforce their documented authentication, version, and media headers", { skip: !existsSync(SPEC_PATH) && "Set NOTION_PUBLIC_OPENAPI to the official ntn OpenAPI file." }, async () => {
  const spec = JSON.parse(readFileSync(SPEC_PATH, "utf8"));
  const operations = Object.entries(spec.paths).flatMap(([path, methods]) => ["get", "post", "patch", "delete"].filter((method) => methods[method]).map((method) => ({ path, method, operation: methods[method] })));
  assert.equal(operations.length, 61);
  for (const { path, operation } of operations) {
    const security = operation.security ?? spec.security;
    if (path.startsWith("/v1/oauth/")) assert.deepEqual(security, [{ basicAuth: [] }], `${path} must use HTTP Basic client authentication`);
    else assert.deepEqual(security, [{ bearerAuth: [] }], `${path} must use Bearer authentication`);
    const parameters = [...(spec.parameters ?? []), ...(operation.parameters ?? [])];
    assert.ok(parameters.some((parameter) => parameter.$ref === "#/components/parameters/notionVersion" || parameter.name === "Notion-Version"), `${path} must declare Notion-Version`);
  }

  const { app } = fixture();
  const decode = async (response) => ({ status: response.status, value: await response.json() });
  const noToken = await decode(await app.request("/v1/users", { headers: { "Notion-Version": NOTION_VERSION } }));
  assert.equal(noToken.status, 401); assert.equal(noToken.value.code, "unauthorized"); assert.match(noToken.value.request_id, /^[0-9a-f-]{36}$/);
  const wrongScheme = await decode(await app.request("/v1/users", { headers: { Authorization: "Basic Zm9vOmJhcg==", "Notion-Version": NOTION_VERSION } }));
  assert.equal(wrongScheme.status, 401); assert.equal(wrongScheme.value.code, "unauthorized");
  const noVersion = await decode(await app.request("/v1/users", { headers: { Authorization: "Bearer full" } }));
  assert.equal(noVersion.status, 400); assert.equal(noVersion.value.code, "validation_error");
  const oldVersion = await decode(await app.request("/v1/agents/query", { method: "POST", headers: { Authorization: "Bearer full", "Notion-Version": "2025-09-03", "Content-Type": "application/json" }, body: "{}" }));
  assert.equal(oldVersion.status, 400); assert.equal(oldVersion.value.code, "validation_error");
  const wrongJsonType = await decode(await app.request("/v1/search", { method: "POST", headers: { Authorization: "Bearer full", "Notion-Version": NOTION_VERSION, "Content-Type": "text/plain" }, body: "{}" }));
  assert.equal(wrongJsonType.status, 400); assert.equal(wrongJsonType.value.code, "invalid_json");
  const pendingUpload = await decode(await app.request("/v1/file_uploads", { method: "POST", headers: { Authorization: "Bearer full", "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" }, body: JSON.stringify({ mode: "single_part", filename: "header.txt", content_type: "text/plain" }) }));
  assert.equal(pendingUpload.status, 200);
  const badMultipart = await decode(await app.request(`/v1/file_uploads/${pendingUpload.value.id}/send`, { method: "POST", headers: { Authorization: "Bearer full", "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" }, body: "{}" }));
  assert.equal(badMultipart.status, 400); assert.equal(badMultipart.value.code, "validation_error");
  const badBasic = await decode(await app.request("/v1/oauth/introspect", { method: "POST", headers: { Authorization: "Bearer full", "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" }, body: JSON.stringify({ token: "x" }) }));
  assert.equal(badBasic.status, 401); assert.equal(badBasic.value.error, "invalid_client");
});
