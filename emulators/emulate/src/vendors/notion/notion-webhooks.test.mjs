import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { createServer } from "@emulators/core";

import {
  createNotionAdmin,
  NOTION_WEBHOOK_EVENT_TYPES,
  notionWebhookSignature,
  verifyNotionWebhookSignature,
} from "./admin.mjs";
import { createNotionDomain } from "./domain.mjs";
import { plugin, seedFromConfig } from "./index.mjs";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const PAGE_ID = "10000000-0000-4000-8000-000000000001";
const BLOCK_ID = "20000000-0000-4000-8000-000000000001";
const DATABASE_ID = "30000000-0000-4000-8000-000000000001";
const DATA_SOURCE_ID = "40000000-0000-4000-8000-000000000001";
const VIEW_ID = "50000000-0000-4000-8000-000000000001";
const COMMENT_ID = "80000000-0000-4000-8000-000000000001";
const DISCUSSION_ID = "81000000-0000-4000-8000-000000000001";
const FILE_UPLOAD_ID = "90000000-0000-4000-8000-000000000001";
const OPENAPI = JSON.parse(readFileSync(process.env.NOTION_PUBLIC_OPENAPI ?? new URL("../../../contracts/notion/public-api-2026-03-11.openapi.json", import.meta.url), "utf8"));

function webhookEventType(schema) {
  if (schema?.properties?.type?.const) return schema.properties.type.const;
  for (const part of schema?.allOf ?? []) {
    const resolved = part.$ref
      ? part.$ref.slice(2).split("/").reduce((value, key) => value[key], OPENAPI)
      : part;
    const type = webhookEventType(resolved);
    if (type) return type;
  }
  return null;
}

const webhookSchemas = new Map(Object.entries(OPENAPI.components.schemas)
  .filter(([name]) => name.endsWith("WebhookPayload"))
  .map(([, schema]) => [webhookEventType(schema), schema])
  .filter(([type]) => type));
const webhookAjv = new Ajv2020({ strict: false, allErrors: true });
addFormats(webhookAjv);
const webhookValidators = new Map([...webhookSchemas].map(([type, schema]) => [
  type,
  webhookAjv.compile({ ...schema, unevaluatedProperties: false, components: OPENAPI.components }),
]));

const OFFICIAL_EVENTS = [
  "comment.created", "comment.deleted", "comment.updated",
  "data_source.content_updated", "data_source.created", "data_source.deleted", "data_source.moved", "data_source.schema_updated", "data_source.undeleted",
  "database.content_updated", "database.created", "database.deleted", "database.moved", "database.schema_updated", "database.undeleted",
  "file_upload.completed", "file_upload.created", "file_upload.expired", "file_upload.upload_failed",
  "page.content_updated", "page.created", "page.deleted", "page.locked", "page.moved", "page.properties_updated", "page.transcription_block.transcript_deleted", "page.undeleted", "page.unlocked",
  "view.created", "view.deleted", "view.updated",
];

function fixture() {
  const baseUrl = "http://notion.worldfixture.test";
  const server = createServer(plugin, { baseUrl, tokens: { inspector: { login: "maya@example.test", id: 1, scopes: ["read:content", "write:content"] } } });
  seedFromConfig(server.store, baseUrl, {
    workspace: { id: "60000000-0000-4000-8000-000000000001", name: "Webhook fixture" },
    users: [{ id: USER_ID, name: "Maya", email: "maya@example.test" }],
    pages: [{ id: PAGE_ID, title: "Plan", created_by: USER_ID, accessible_by: [USER_ID], children: [{ id: BLOCK_ID, type: "paragraph", text: "Review the plan." }] }],
    databases: [{ id: DATABASE_ID, title: "Projects", created_by: USER_ID, accessible_by: [USER_ID] }],
    data_sources: [{ id: DATA_SOURCE_ID, database_id: DATABASE_ID, name: "Projects", properties: { Name: { type: "title" } }, created_by: USER_ID, accessible_by: [USER_ID] }],
    views: [{ id: VIEW_ID, database_id: DATABASE_ID, data_source_id: DATA_SOURCE_ID, name: "Projects", type: "table", accessible_by: [USER_ID] }],
    comments: [{ id: COMMENT_ID, discussion_id: DISCUSSION_ID, parent: { page_id: PAGE_ID }, created_by: USER_ID, rich_text: [{ type: "text", text: { content: "Review this." } }] }],
    file_uploads: [{ id: FILE_UPLOAD_ID, created_by: USER_ID, filename: "report.pdf", content_type: "application/pdf", status: "pending" }],
  });
  return server;
}

function changeFor(type) {
  const base = { topic: type, actor_id: USER_ID, occurred_at: "2026-09-03T09:00:00.000Z", data: {} };
  if (type.startsWith("comment.")) return { ...base, object_id: COMMENT_ID, data: { parent: { page_id: PAGE_ID }, page_id: PAGE_ID, discussion_id: DISCUSSION_ID } };
  if (type.startsWith("file_upload.")) return {
    ...base, object_id: FILE_UPLOAD_ID,
    data: type === "file_upload.upload_failed" ? { file_import_result: { type: "error", imported_time: base.occurred_at, error: { type: "upload_error", code: "object_store_write_failed", message: "The shared object store rejected the upload.", parameter: null, status_code: 503 } } } : {},
  };
  if (type.startsWith("view.")) return { ...base, object_id: VIEW_ID, data: { database_id: DATABASE_ID, view_type: "table", updated_fields: ["filter", "sorts"] } };
  if (type.startsWith("data_source.")) return { ...base, object_id: DATA_SOURCE_ID, data: { parent: { database_id: DATABASE_ID }, updated_blocks: [{ id: PAGE_ID, type: "page" }], updated_properties: [{ id: "priority", name: "Priority", action: "created" }] } };
  if (type.startsWith("database.")) return { ...base, object_id: DATABASE_ID, data: { parent: { page_id: PAGE_ID }, updated_blocks: [{ id: DATA_SOURCE_ID, type: "database" }], updated_properties: [{ id: "status", name: "Status", action: "updated" }] } };
  if (type === "page.transcription_block.transcript_deleted") return { ...base, object_id: BLOCK_ID, data: { page_id: PAGE_ID, transcript_id: "transcript-1" } };
  if (type === "page.content_updated") return { ...base, topic: "block.updated", object_id: BLOCK_ID, data: { updated_blocks: [{ id: BLOCK_ID, type: "block" }] } };
  return { ...base, object_id: PAGE_ID, data: { parent: { workspace: true, type: "workspace" }, updated_properties: ["title"] } };
}

test("the webhook inventory matches all 31 events in the cached official OpenAPI", () => {
  assert.deepEqual([...NOTION_WEBHOOK_EVENT_TYPES].sort(), [...OFFICIAL_EVENTS].sort());
  assert.deepEqual([...webhookSchemas.keys()].sort(), [...OFFICIAL_EVENTS].sort());
});

test("every official webhook event gets its exact entity kind and required event data", () => {
  const { store } = fixture();
  const admin = createNotionAdmin(store);
  admin.subscriptions.insert({
    notion_id: "b1000000-0000-4000-8000-000000000001", integration_id: "b3000000-0000-4000-8000-000000000001",
    url: "https://hooks.worldfixture.test/notion", event_types: OFFICIAL_EVENTS, status: "active", verification_token: "webhook-secret",
  });
  for (const type of OFFICIAL_EVENTS) admin.captureChange(changeFor(type));
  const deliveries = admin.deliveries.all();
  assert.deepEqual(deliveries.map((item) => item.event_type).sort(), [...OFFICIAL_EVENTS].sort());

  for (const delivery of deliveries) {
    const payload = delivery.payload;
    const prefix = payload.type.split(".")[0];
    const expectedEntity = prefix === "data_source" ? "data_source" : prefix;
    assert.equal(payload.entity.type, expectedEntity, payload.type);
    assert.equal(payload.attempt_number, 1, payload.type);
    assert.equal(payload.api_version, "2026-03-11", payload.type);
    assert.equal(delivery.live_delivery, false, payload.type);
    assert.equal(delivery.raw_body, JSON.stringify(payload), payload.type);
    assert.equal(delivery.headers["X-Notion-Signature"], notionWebhookSignature(delivery.raw_body, "webhook-secret"), payload.type);
    assert.equal(verifyNotionWebhookSignature(delivery.raw_body, delivery.headers["X-Notion-Signature"], "webhook-secret"), true, payload.type);
    assert.equal(verifyNotionWebhookSignature(`${delivery.raw_body} `, delivery.headers["X-Notion-Signature"], "webhook-secret"), false, payload.type);
    const validate = webhookValidators.get(payload.type);
    assert.ok(validate, `The official schema is missing for ${payload.type}.`);
    assert.ok(validate(payload), `${payload.type}: ${webhookAjv.errorsText(validate.errors, { separator: "\n" })}`);
    assert.equal(validate({ ...payload, worldfixture_unknown_field: true }), false, `${payload.type} must reject unknown fields.`);

    if (["file_upload.created", "file_upload.completed", "file_upload.expired"].includes(payload.type)) {
      assert.equal(Object.hasOwn(payload, "data"), false, payload.type);
    } else {
      assert.ok(payload.data, payload.type);
    }
    if (payload.type.startsWith("comment.")) {
      assert.deepEqual(payload.data.parent, { id: PAGE_ID, type: "page" });
      assert.equal(payload.data.page_id, PAGE_ID);
      assert.equal(payload.data.discussion_id, DISCUSSION_ID);
    }
    if (payload.type.endsWith("content_updated")) {
      assert.ok(payload.data.parent);
      assert.ok(payload.data.updated_blocks.length > 0);
    }
    if (payload.type === "page.content_updated") {
      assert.deepEqual(payload.entity, { id: PAGE_ID, type: "page" });
      assert.deepEqual(payload.data.updated_blocks, [{ id: BLOCK_ID, type: "block" }]);
    }
    if (payload.type === "page.properties_updated") assert.deepEqual(payload.data.updated_properties, ["title"]);
    if (payload.type === "page.transcription_block.transcript_deleted") {
      assert.deepEqual(payload.entity, { id: PAGE_ID, type: "page" });
      assert.deepEqual(payload.data.target, { id: BLOCK_ID, type: "block" });
      assert.equal(payload.data.transcript_id, "transcript-1");
    }
    if (payload.type === "view.created") assert.equal(payload.data.view_type, "table");
    if (payload.type === "view.updated") assert.deepEqual(payload.data.updated_fields, ["filter", "sorts"]);
    if (payload.type === "file_upload.upload_failed") assert.equal(payload.data.file_import_result.error.type, "upload_error");
  }
});

test("subscription creation captures the one-time verification-token request with its exact raw-body signature", async () => {
  const { app } = fixture();
  const response = await app.request("/__worldfixture/notion-admin/webhooks", {
    method: "POST",
    headers: { Authorization: "Bearer inspector", "Content-Type": "application/json" },
    body: JSON.stringify({ url: "https://hooks.worldfixture.test/notion", event_types: ["page.created"] }),
  });
  assert.equal(response.status, 201);
  const subscription = await response.json();
  const state = await (await app.request("/__worldfixture/notion-admin", { headers: { Authorization: "Bearer inspector" } })).json();
  assert.equal(state.live_webhook_delivery, false);
  assert.equal(state.webhook_verification_deliveries.length, 1);
  const delivery = state.webhook_verification_deliveries[0];
  assert.deepEqual(delivery.payload, { verification_token: subscription.verification_token });
  assert.equal(delivery.raw_body, JSON.stringify(delivery.payload));
  assert.equal(delivery.headers["X-Notion-Signature"], notionWebhookSignature(delivery.raw_body, subscription.verification_token));
  assert.equal(verifyNotionWebhookSignature(delivery.raw_body, delivery.headers["X-Notion-Signature"], subscription.verification_token), true);
  assert.equal(verifyNotionWebhookSignature(`${delivery.raw_body}\n`, delivery.headers["X-Notion-Signature"], subscription.verification_token), false);
});

test("real comment and view deletion lifecycles retain event data after the source record is removed", () => {
  const { store, baseUrl } = fixture();
  const admin = createNotionAdmin(store);
  admin.subscriptions.insert({
    notion_id: "b1000000-0000-4000-8000-000000000002", integration_id: "b3000000-0000-4000-8000-000000000002",
    url: "https://hooks.worldfixture.test/notion", event_types: ["comment.deleted", "view.deleted"], status: "active", verification_token: "delete-secret",
  });
  const actor = store.collection("notion_users", ["notion_id", "email"]).findOneBy("notion_id", USER_ID);
  const domain = createNotionDomain(store, baseUrl, { onChange: (change) => admin.captureChange(change) });

  const comment = domain.createComment({ parent: { page_id: PAGE_ID }, markdown: "Temporary comment" }, actor);
  domain.deleteComment(comment.id, actor);
  const extraView = domain.createView({ database_id: DATABASE_ID, data_source_id: DATA_SOURCE_ID, name: "Board", type: "board" }, actor);
  domain.deleteView(extraView.id, actor);

  const commentDelivery = admin.deliveries.all().find((item) => item.event_type === "comment.deleted");
  assert.deepEqual(commentDelivery.payload.data.parent, { id: PAGE_ID, type: "page" });
  assert.equal(commentDelivery.payload.data.page_id, PAGE_ID);
  assert.equal(commentDelivery.payload.data.discussion_id, comment.id);
  const viewDelivery = admin.deliveries.all().find((item) => item.event_type === "view.deleted");
  assert.deepEqual(viewDelivery.payload.data.parent, { id: DATABASE_ID, type: "database" });
});
