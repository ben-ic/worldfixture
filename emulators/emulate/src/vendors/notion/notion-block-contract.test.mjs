import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { createServer } from "@emulators/core";

import { plugin, seedFromConfig } from "./index.mjs";
import { NOTION_VERSION } from "./rest.mjs";

const SPEC_PATH = process.env.NOTION_PUBLIC_OPENAPI ?? new URL("../../../contracts/notion/public-api-2026-03-11.openapi.json", import.meta.url);
const spec = JSON.parse(readFileSync(SPEC_PATH, "utf8"));
const USER = "00000000-0000-4000-8000-000000000001";
const PAGE = "10000000-0000-4000-8000-000000000001";
const DATABASE = "30000000-0000-4000-8000-000000000001";
const COMMENT = "80000000-0000-4000-8000-000000000001";
const UPLOAD = "90000000-0000-4000-8000-000000000001";
const headers = { Authorization: "Bearer full", "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" };
const richText = [{ type: "text", text: { content: "Contract text" } }];
const paragraph = { type: "paragraph", paragraph: { rich_text: [] } };

function resolve(schema) {
  if (!schema?.$ref) return schema;
  return schema.$ref.slice(2).split("/").reduce((value, key) => value[key], spec);
}

function branchType(schema) {
  const value = resolve(schema);
  return value?.properties?.type?.const;
}

function collectTypeConstants(schema, found = new Set()) {
  const value = resolve(schema);
  if (!value || typeof value !== "object") return found;
  if (value.properties?.type?.const) found.add(value.properties.type.const);
  for (const key of ["oneOf", "anyOf", "allOf"]) for (const child of value[key] ?? []) collectTypeConstants(child, found);
  return found;
}

const requestBranches = spec.components.schemas.blockObjectRequest.anyOf;
const requestTypes = requestBranches.map(branchType);
const responseRefs = spec.components.schemas.blockObjectResponse.anyOf.map((branch) => branch.$ref);
const responseSchemas = responseRefs.map((ref) => resolve({ $ref: ref }));
const responseTypes = responseSchemas.map(branchType);
const updateTypes = [...collectTypeConstants(spec.paths["/v1/blocks/{block_id}"].patch.requestBody.content["application/json"].schema)].filter((type) => type !== undefined);

const media = (name = undefined) => ({ type: "external", external: { url: "https://assets.example.test/file.bin" }, caption: [], ...(name ? { name } : {}) });
const fixtures = {
  embed: { type: "embed", embed: { url: "https://example.test/embed", caption: [] } },
  bookmark: { type: "bookmark", bookmark: { url: "https://example.test/bookmark", caption: [] } },
  image: { type: "image", image: media() },
  video: { type: "video", video: media() },
  pdf: { type: "pdf", pdf: media() },
  file: { type: "file", file: media("contract.txt") },
  audio: { type: "audio", audio: media() },
  code: { type: "code", code: { rich_text: richText, language: "plain text", caption: [] } },
  equation: { type: "equation", equation: { expression: "1 + 1" } },
  divider: { type: "divider", divider: {} },
  breadcrumb: { type: "breadcrumb", breadcrumb: {} },
  tab: { type: "tab", tab: { children: [paragraph] } },
  table_of_contents: { type: "table_of_contents", table_of_contents: { color: "default" } },
  link_to_page: { type: "link_to_page", link_to_page: { type: "page_id", page_id: PAGE } },
  table_row: { type: "table_row", table_row: { cells: [[], []] } },
  table: { type: "table", table: { table_width: 2, has_column_header: true, has_row_header: false, children: [{ type: "table_row", table_row: { cells: [[], []] } }] } },
  column_list: { type: "column_list", column_list: { children: [
    { type: "column", column: { width_ratio: 0.5, children: [paragraph] } },
    { type: "column", column: { width_ratio: 0.5, children: [paragraph] } },
  ] } },
  column: { type: "column", column: { width_ratio: 0.5, children: [paragraph] } },
  heading_1: { type: "heading_1", heading_1: { rich_text: richText, color: "default", is_toggleable: false } },
  heading_2: { type: "heading_2", heading_2: { rich_text: richText, color: "default", is_toggleable: false } },
  heading_3: { type: "heading_3", heading_3: { rich_text: richText, color: "default", is_toggleable: false } },
  heading_4: { type: "heading_4", heading_4: { rich_text: richText, color: "default", is_toggleable: false } },
  paragraph: { type: "paragraph", paragraph: { rich_text: richText, color: "default" } },
  bulleted_list_item: { type: "bulleted_list_item", bulleted_list_item: { rich_text: richText, color: "default" } },
  numbered_list_item: { type: "numbered_list_item", numbered_list_item: { rich_text: richText, color: "default" } },
  quote: { type: "quote", quote: { rich_text: richText, color: "default" } },
  to_do: { type: "to_do", to_do: { rich_text: richText, color: "default", checked: false } },
  toggle: { type: "toggle", toggle: { rich_text: richText, color: "default" } },
  template: { type: "template", template: { rich_text: richText, children: [paragraph] } },
  callout: { type: "callout", callout: { rich_text: richText, color: "default", icon: { type: "emoji", emoji: "📌" } } },
  synced_block: { type: "synced_block", synced_block: { synced_from: null, children: [paragraph] } },
};

function fixture() {
  const baseUrl = "http://notion.worldfixture.test";
  const server = createServer(plugin, { baseUrl, tokens: { full: { login: "maya@example.test", id: 1, scopes: ["read:content", "insert:content", "update:content"] } } });
  seedFromConfig(server.store, baseUrl, {
    workspace: { id: "60000000-0000-4000-8000-000000000001", name: "Block contract" },
    users: [{ id: USER, name: "Maya", email: "maya@example.test" }],
    pages: [{ id: PAGE, title: "Blocks", created_by: USER, accessible_by: [USER] }],
    databases: [{ id: DATABASE, title: "Data", created_by: USER, accessible_by: [USER] }],
    comments: [{ id: COMMENT, parent: { page_id: PAGE }, created_by: USER, markdown: "Comment" }],
    file_uploads: [{ id: UPLOAD, created_by: USER, status: "uploaded", filename: "file.bin", content_type: "application/octet-stream" }],
  });
  return server;
}

async function request(app, path, method = "GET", body) {
  const response = await app.request(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

function sample(inputSchema, seen = new Set()) {
  const schema = resolve(inputSchema);
  if (!schema) return null;
  if (schema.const !== undefined) return structuredClone(schema.const);
  if (schema.examples?.length) return structuredClone(schema.examples[0]);
  if (schema.enum?.length) return structuredClone(schema.enum[0]);
  if (schema.oneOf?.length) return sample(schema.oneOf[0], seen);
  if (schema.anyOf?.length) return sample(schema.anyOf[0], seen);
  if (schema.allOf?.length) return Object.assign({}, ...schema.allOf.map((part) => sample(part, seen)).filter((value) => value && typeof value === "object" && !Array.isArray(value)));
  const type = Array.isArray(schema.type) ? schema.type.find((item) => item !== "null") ?? schema.type[0] : schema.type;
  if (type === "null") return null;
  if (type === "boolean") return false;
  if (type === "integer") return Math.max(0, schema.minimum ?? 0);
  if (type === "number") return schema.exclusiveMinimum !== undefined ? schema.exclusiveMinimum + 0.1 : schema.minimum ?? 0;
  if (type === "string") {
    if (schema.format === "uuid") return USER;
    if (schema.format === "date-time") return "2026-09-03T09:00:00.000Z";
    if (schema.format === "date") return "2026-09-03";
    if (schema.format === "uri" || schema.format === "url") return "https://example.test/value";
    return "value";
  }
  if (type === "array") return Array.from({ length: schema.minItems ?? 0 }, () => sample(schema.items, seen));
  if (type === "object" || schema.properties) {
    const result = {};
    for (const key of schema.required ?? []) result[key] = sample(schema.properties?.[key], seen);
    return result;
  }
  return null;
}

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const requestValidators = new Map(requestBranches.map((schema) => [branchType(schema), ajv.compile({ ...resolve(schema), components: spec.components })]));
const updateValidator = ajv.compile({
  ...spec.paths["/v1/blocks/{block_id}"].patch.requestBody.content["application/json"].schema,
  components: spec.components,
});
const responseValidators = new Map(responseSchemas.map((schema) => [branchType(schema), ajv.compile({ ...schema, components: spec.components })]));

function officialUpdateBody(type) {
  const value = structuredClone(fixtures[type][type]);
  delete value.children;
  if (["audio", "file", "image", "pdf", "video"].includes(type)) delete value.type;
  if (type === "table") delete value.table_width;
  const body = { type, [type]: value };
  assert.ok(updateValidator(body), `${type} update: ${ajv.errorsText(updateValidator.errors, { separator: "\n" })}`);
  return body;
}

test("block request and response inventories equal the pinned official schema", () => {
  assert.equal(new Set(requestTypes).size, 31);
  assert.equal(new Set(responseTypes).size, 36);
  assert.deepEqual(Object.keys(fixtures).sort(), [...requestTypes].sort());
  assert.deepEqual([...responseTypes].sort(), [
    ...requestTypes,
    "child_page", "child_database", "meeting_notes", "link_preview", "unsupported",
  ].sort());
  for (const type of requestTypes) {
    const validate = requestValidators.get(type);
    assert.ok(validate(fixtures[type]), `${type}: ${ajv.errorsText(validate.errors, { separator: "\n" })}`);
  }
});

test("every official block request branch appends, reads, and converts to its response form", async (t) => {
  for (const type of requestTypes) {
    await t.test(type, async () => {
      if (["column", "table_row"].includes(type)) return;
      const { app } = fixture();
      const appended = await request(app, `/v1/blocks/${PAGE}/children`, "PATCH", { children: [fixtures[type]] });
      assert.equal(appended.response.status, 200, JSON.stringify(appended.body));
      const created = appended.body.results[0];
      assert.equal(created.type, type);
      assert.equal(Object.hasOwn(created[type] ?? {}, "children"), false, `${type}.children is request-only`);
      const read = await request(app, `/v1/blocks/${created.id}`);
      assert.equal(read.response.status, 200);
      assert.equal(read.body.type, type);
      if (Array.isArray(fixtures[type][type]?.rich_text) && fixtures[type][type].rich_text.length) {
        assert.equal(read.body[type].rich_text[0].plain_text, "Contract text");
        assert.ok(read.body[type].rich_text[0].annotations);
      }
      if (["bookmark", "embed", "audio", "file", "image", "pdf", "video"].includes(type)) assert.deepEqual(read.body[type].caption, []);
      if (updateTypes.includes(type)) {
        const updated = await request(app, `/v1/blocks/${created.id}`, "PATCH", officialUpdateBody(type));
        assert.equal(updated.response.status, 200, JSON.stringify(updated.body));
        assert.equal(updated.body.type, type);
      }
    });
  }
});

test("column and table-row request branches work only in their official parents", async () => {
  const { app } = fixture();
  const columns = await request(app, `/v1/blocks/${PAGE}/children`, "PATCH", { children: [fixtures.column_list] });
  assert.equal(columns.response.status, 200);
  const columnChildren = await request(app, `/v1/blocks/${columns.body.results[0].id}/children`);
  assert.deepEqual(columnChildren.body.results.map((item) => item.type), ["column", "column"]);
  const updatedColumn = await request(app, `/v1/blocks/${columnChildren.body.results[0].id}`, "PATCH", officialUpdateBody("column"));
  assert.equal(updatedColumn.response.status, 200);
  assert.equal(updatedColumn.body.type, "column");
  const table = await request(app, `/v1/blocks/${PAGE}/children`, "PATCH", { children: [fixtures.table] });
  assert.equal(table.response.status, 200);
  const tableChildren = await request(app, `/v1/blocks/${table.body.results[0].id}/children`);
  assert.deepEqual(tableChildren.body.results.map((item) => item.type), ["table_row"]);
  const updatedRow = await request(app, `/v1/blocks/${tableChildren.body.results[0].id}`, "PATCH", officialUpdateBody("table_row"));
  assert.equal(updatedRow.response.status, 200);
  assert.equal(updatedRow.body.type, "table_row");
  assert.equal((await request(app, `/v1/blocks/${PAGE}/children`, "PATCH", { children: [fixtures.column] })).response.status, 400);
  assert.equal((await request(app, `/v1/blocks/${PAGE}/children`, "PATCH", { children: [fixtures.table_row] })).response.status, 400);
});

test("every returned block branch validates against its exact official response schema", async (t) => {
  const { app, store } = fixture();
  const blocks = store.collection("notion_blocks", ["notion_id", "parent_id"]);
  for (let index = 0; index < responseSchemas.length; index += 1) {
    const schema = responseSchemas[index];
    const type = responseTypes[index];
    await t.test(type, async () => {
      const id = `21000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
      const example = sample(schema.properties[type]);
      blocks.insert({
        notion_id: id, parent_id: PAGE, parent: { type: "page_id", page_id: PAGE }, type, value: example,
        created_time: "2026-09-03T09:00:00.000Z", last_edited_time: "2026-09-03T09:00:00.000Z",
        created_by: USER, last_edited_by: USER, has_children: false, in_trash: false, position: index,
      });
      const read = await request(app, `/v1/blocks/${id}`);
      assert.equal(read.response.status, 200);
      const validate = responseValidators.get(type);
      assert.ok(validate(read.body), `${type}: ${ajv.errorsText(validate.errors, { separator: "\n" })}`);
    });
  }
});

test("block defaults and invalid combinations follow current request constraints", async (t) => {
  const cases = [
    ["101 children", { children: Array.from({ length: 101 }, () => paragraph) }],
    ["101 rich text", { children: [{ type: "paragraph", paragraph: { rich_text: Array.from({ length: 101 }, () => richText[0]) } }] }],
    ["101 captions", { children: [{ type: "image", image: { ...media(), caption: Array.from({ length: 101 }, () => richText[0]) } }] }],
    ["media external plus upload", { children: [{ type: "image", image: { type: "external", external: { url: "https://example.test/a" }, file_upload: { id: UPLOAD } } }] }],
    ["embed URL plus upload", { children: [{ type: "embed", embed: { url: "https://example.test/a", file_upload: { id: UPLOAD } } }] }],
    ["third nesting level", { children: [{ type: "toggle", toggle: { rich_text: [], children: [{ type: "toggle", toggle: { rich_text: [], children: [{ type: "toggle", toggle: { rich_text: [], children: [paragraph] } }] } }] } }] }],
    ["heading children without toggle", { children: [{ type: "heading_1", heading_1: { rich_text: [], is_toggleable: false, children: [paragraph] } }] }],
    ["tab non-paragraph child", { children: [{ type: "tab", tab: { children: [{ type: "quote", quote: { rich_text: [] } }] } }] }],
    ["column ratios do not sum to one", { children: [{ type: "column_list", column_list: { children: [
      { type: "column", column: { width_ratio: 0.2, children: [paragraph] } },
      { type: "column", column: { width_ratio: 0.2, children: [paragraph] } },
    ] } }] }],
    ["table row width mismatch", { children: [{ type: "table", table: { table_width: 2, children: [{ type: "table_row", table_row: { cells: [[]] } }] } }] }],
  ];
  for (const [name, body] of cases) await t.test(name, async () => {
    const { app } = fixture();
    const result = await request(app, `/v1/blocks/${PAGE}/children`, "PATCH", body);
    assert.equal(result.response.status, 400, JSON.stringify(result.body));
  });

  const { app } = fixture();
  const defaults = await request(app, `/v1/blocks/${PAGE}/children`, "PATCH", { children: [
    { type: "paragraph", paragraph: { rich_text: [] } }, { type: "heading_1", heading_1: { rich_text: [] } },
    { type: "to_do", to_do: { rich_text: [] } }, { type: "code", code: { rich_text: [], language: "plain text" } },
    { type: "table_of_contents", table_of_contents: {} },
  ] });
  assert.equal(defaults.response.status, 200);
  assert.deepEqual(defaults.body.results[0].paragraph, { rich_text: [], color: "default", icon: null });
  assert.deepEqual(defaults.body.results[1].heading_1, { rich_text: [], color: "default", is_toggleable: false });
  assert.deepEqual(defaults.body.results[2].to_do, { rich_text: [], color: "default", checked: false });
  assert.deepEqual(defaults.body.results[3].code, { rich_text: [], caption: [], language: "plain text" });
  assert.deepEqual(defaults.body.results[4].table_of_contents, { color: "default" });
});
