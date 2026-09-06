import { createHmac, timingSafeEqual } from "node:crypto";
import { createNotionDelivery, notionDeliveryConfig, notionWebhookUrlError } from "./webhook-delivery.mjs";

const EVENT_TYPES = new Set([
  "page.created", "page.properties_updated", "page.content_updated", "page.moved", "page.deleted", "page.undeleted", "page.locked", "page.unlocked",
  "database.created", "database.content_updated", "database.schema_updated", "database.moved", "database.deleted", "database.undeleted",
  "data_source.created", "data_source.content_updated", "data_source.schema_updated", "data_source.moved", "data_source.deleted", "data_source.undeleted",
  "comment.created", "comment.updated", "comment.deleted",
  "file_upload.created", "file_upload.completed", "file_upload.expired", "file_upload.upload_failed",
  "page.transcription_block.transcript_deleted",
  "view.created", "view.updated", "view.deleted",
]);

function adminError(c, status, message) { return c.json({ object: "error", code: "validation_error", message }, status); }

export function notionWebhookSignature(rawBody, verificationToken) {
  return `sha256=${createHmac("sha256", verificationToken).update(rawBody).digest("hex")}`;
}

export function verifyNotionWebhookSignature(rawBody, signature, verificationToken) {
  if (typeof signature !== "string") return false;
  const expected = notionWebhookSignature(rawBody, verificationToken);
  const actualBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function eventForTopic(topic) {
  if (EVENT_TYPES.has(topic)) return topic;
  if (topic === "page.updated") return "page.properties_updated";
  if (topic.startsWith("page.") || topic.startsWith("block.") || topic.startsWith("meeting_note.")) return "page.content_updated";
  if (topic === "database.linked_created") return "database.created";
  if (topic.startsWith("database.")) return "database.content_updated";
  if (topic.startsWith("data_source.")) return "data_source.content_updated";
  return ["comment.created", "comment.updated", "comment.deleted"].includes(topic) ? topic : null;
}

function entityType(event) {
  if (event.startsWith("data_source.")) return "data_source";
  if (event.startsWith("database.")) return "database";
  if (event.startsWith("comment.")) return "comment";
  if (event.startsWith("file_upload.")) return "file_upload";
  if (event.startsWith("view.")) return "view";
  return "page";
}

function recordBy(store, name, indexes, id) {
  return store.collection(name, indexes).findOneBy("notion_id", id) ?? null;
}

function pageForBlock(store, id) {
  if (recordBy(store, "notion_pages", ["notion_id"], id)) return id;
  let current = recordBy(store, "notion_blocks", ["notion_id", "parent_id"], id);
  const seen = new Set();
  while (current && !seen.has(current.notion_id)) {
    seen.add(current.notion_id);
    if (recordBy(store, "notion_pages", ["notion_id"], current.parent_id)) return current.parent_id;
    current = recordBy(store, "notion_blocks", ["notion_id", "parent_id"], current.parent_id);
  }
  return null;
}

function webhookParent(store, parent) {
  const workspace = store.getData("notion_workspace") ?? {};
  if (!parent || parent.type === "workspace" || parent.workspace) return { id: workspace.id ?? "60000000-0000-4000-8000-000000000001", type: "space" };
  if (parent.page_id) return { id: parent.page_id, type: "page" };
  if (parent.block_id) return { id: parent.block_id, type: "block" };
  if (parent.database_id) return { id: parent.database_id, type: "database" };
  if (parent.data_source_id) {
    const source = recordBy(store, "notion_data_sources", ["notion_id", "database_id"], parent.data_source_id);
    return { id: source?.database_id ?? parent.data_source_id, type: "database", data_source_id: parent.data_source_id };
  }
  if (parent.agent_id) return { id: parent.agent_id, type: "agent" };
  return { id: workspace.id ?? "60000000-0000-4000-8000-000000000001", type: "space" };
}

function entityRecord(store, event, id) {
  if (event.startsWith("page.")) return recordBy(store, "notion_pages", ["notion_id"], id);
  if (event.startsWith("database.")) return recordBy(store, "notion_databases", ["notion_id"], id);
  if (event.startsWith("data_source.")) return recordBy(store, "notion_data_sources", ["notion_id", "database_id"], id);
  if (event.startsWith("view.")) return recordBy(store, "notion_views", ["notion_id", "database_id", "data_source_id"], id);
  if (event.startsWith("comment.")) return recordBy(store, "notion_comments", ["notion_id", "discussion_id", "parent_id", "created_by"], id);
  return recordBy(store, "notion_file_uploads", ["notion_id", "created_by", "status"], id);
}

function parentForRecord(store, event, record, change) {
  if (change.data?.parent) return webhookParent(store, change.data.parent);
  if (event.startsWith("data_source.")) return webhookParent(store, { database_id: record?.database_id });
  if (event.startsWith("view.")) return webhookParent(store, { database_id: record?.database_id ?? change.data?.database_id });
  return webhookParent(store, record?.parent);
}

function payloadParts(store, event, change) {
  let entityId = change.object_id;
  if (event.startsWith("page.") && change.topic.startsWith("block.")) entityId = pageForBlock(store, change.object_id) ?? change.data?.page_id ?? change.object_id;
  if (event === "page.transcription_block.transcript_deleted") entityId = change.data?.page_id ?? pageForBlock(store, change.object_id) ?? change.object_id;
  const record = entityRecord(store, event, entityId) ?? entityRecord(store, event, change.object_id);
  const entity = { id: entityId, type: entityType(event) };
  if (event.startsWith("file_upload.") && event !== "file_upload.upload_failed") return { entity };
  if (event === "file_upload.upload_failed") return { entity, data: { file_import_result: structuredClone(change.data?.file_import_result) } };
  if (event === "page.transcription_block.transcript_deleted") return { entity, data: { target: { id: change.object_id, type: "block" }, transcript_id: change.data?.transcript_id ?? null } };
  if (event.startsWith("comment.")) {
    const parent = change.data?.parent ?? record?.parent;
    const pageId = change.data?.page_id ?? (parent?.page_id || pageForBlock(store, parent?.block_id));
    return { entity, data: { parent: webhookParent(store, parent), page_id: pageId, discussion_id: change.data?.discussion_id ?? record?.discussion_id } };
  }
  const parent = parentForRecord(store, event, record, change);
  if (event.endsWith("content_updated")) {
    const updated = change.data?.updated_blocks ?? [{ id: change.object_id, type: recordBy(store, "notion_blocks", ["notion_id", "parent_id"], change.object_id) ? "block" : entityType(event) }];
    return { entity, data: { parent, updated_blocks: updated } };
  }
  if (event === "page.properties_updated") return { entity, data: { parent, updated_properties: structuredClone(change.data?.updated_properties ?? []) } };
  if (event.endsWith("schema_updated")) return { entity, data: { parent, ...(change.data?.updated_properties ? { updated_properties: structuredClone(change.data.updated_properties) } : {}) } };
  if (event === "view.created") return { entity, data: { parent, view_type: change.data?.view_type ?? record?.type } };
  if (event === "view.updated") return { entity, data: { parent, updated_fields: structuredClone(change.data?.updated_fields ?? []) } };
  return { entity, data: { parent } };
}

function nextSecret(store) {
  const value = (store.getData("notion_webhook_secret_counter") ?? 0) + 1;
  store.setData("notion_webhook_secret_counter", value);
  return `secret_worldfixture_notion_${String(value).padStart(6, "0")}`;
}

function nextUuid(store, key, prefix) {
  const value = (store.getData(key) ?? 0) + 1;
  store.setData(key, value);
  return `${prefix}-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

export function createNotionAdmin(store) {
  const subscriptions = store.collection("notion_webhook_subscriptions", ["notion_id", "status"]);
  const deliveries = store.collection("notion_webhook_deliveries", ["notion_id", "subscription_id", "event_type"]);
  const verificationDeliveries = store.collection("notion_webhook_verification_deliveries", ["notion_id", "subscription_id"]);
  const delivery = createNotionDelivery(store, subscriptions, notionWebhookSignature);
  return {
    subscriptions,
    deliveries,
    verificationDeliveries,
    waitForIdle: delivery.waitForIdle,
    close: delivery.close,
    captureVerification(subscription) {
      const payload = { verification_token: subscription.verification_token };
      const rawBody = JSON.stringify(payload);
      const signature = notionWebhookSignature(rawBody, subscription.verification_token);
      const record = verificationDeliveries.insert({
        notion_id: `verification_${verificationDeliveries.count() + 1}`,
        subscription_id: subscription.notion_id,
        url: subscription.url,
        payload,
        raw_body: rawBody,
        headers: { "X-Notion-Signature": signature },
        signature,
        status: "captured",
        live_delivery: false,
      });
      delivery.send(verificationDeliveries, record, true);
      return record;
    },
    captureChange(change) {
      const event = eventForTopic(change.topic);
      if (!event) return;
      for (const subscription of subscriptions.all().filter((item) => item.status === "active" && item.event_types.includes(event))) {
        const workspace = store.getData("notion_workspace") ?? {};
        const payload = {
          id: nextUuid(store, "notion_webhook_event_counter", "b2000000"),
          timestamp: change.occurred_at,
          workspace_id: workspace.id ?? "60000000-0000-4000-8000-000000000001",
          workspace_name: workspace.name ?? "WorldFixture",
          subscription_id: subscription.notion_id,
          integration_id: subscription.integration_id,
          authors: [{ id: change.actor_id, type: recordBy(store, "notion_users", ["notion_id", "email"], change.actor_id)?.type ?? "person" }],
          // accessible_by applies only to public integration connections. The
          // local subscription controls model internal integrations.
          attempt_number: 1,
          api_version: "2026-03-11",
          type: event,
          ...payloadParts(store, event, change),
        };
        const rawBody = JSON.stringify(payload);
        const signature = notionWebhookSignature(rawBody, subscription.verification_token);
        const record = deliveries.insert({
          notion_id: `delivery_${deliveries.count() + 1}`, subscription_id: subscription.notion_id, event_type: event,
          url: subscription.url,
          captured_at: change.occurred_at, payload, raw_body: rawBody,
          headers: { "X-Notion-Signature": signature }, signature,
          status: "captured", live_delivery: false,
        });
        delivery.send(deliveries, record);
      }
    },
  };
}

export const NOTION_WEBHOOK_EVENT_TYPES = Object.freeze([...EVENT_TYPES]);

export function registerNotionAdminRoutes(app, store, tokenMap, admin) {
  const clients = store.collection("notion_oauth_clients", ["client_id"]);
  const grants = store.collection("notion_oauth_tokens", ["token", "refresh_token"]);
  const authorized = (c) => Boolean(c.get("authUser") && !grants.findOneBy("token", c.get("authToken")));
  const publicState = () => ({
    connections: clients.all().map(({ client_secret: _secret, ...client }) => ({ ...client, has_client_secret: Boolean(_secret) })),
    tokens: grants.all().map((grant) => ({ client_id: grant.client_id, user_id: grant.user_id, active: Boolean(grant.active), scope: grant.scope, generation: grant.generation, expires_at: grant.expires_at })),
    webhook_subscriptions: admin.subscriptions.all().map((record) => ({ ...record, verification_token: record.status === "pending" ? record.verification_token : undefined })),
    webhook_verification_deliveries: admin.verificationDeliveries.all(),
    webhook_deliveries: admin.deliveries.all(),
    live_webhook_delivery: notionDeliveryConfig(store).live_delivery,
  });

  app.get("/__worldfixture/notion-admin", (c) => authorized(c) ? c.json(publicState()) : adminError(c, 401, "A REST inspection token is required."));
  app.post("/__worldfixture/notion-admin/tokens/revoke", async (c) => {
    if (!authorized(c)) return adminError(c, 401, "A REST inspection token is required.");
    const body = await c.req.json().catch(() => null);
    if (!body?.client_id || !body?.user_id) return adminError(c, 400, "client_id and user_id are required.");
    let revoked = 0;
    for (const grant of grants.all().filter((item) => item.client_id === body.client_id && item.user_id === body.user_id && item.active)) {
      grants.update(grant.id, { active: false });
      tokenMap.delete(grant.token);
      revoked += 1;
    }
    return c.json({ revoked });
  });
  app.post("/__worldfixture/notion-admin/webhooks", async (c) => {
    if (!authorized(c)) return adminError(c, 401, "A REST inspection token is required.");
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.url !== "string") return adminError(c, 400, "url is required.");
    const urlError = notionWebhookUrlError(store, body.url);
    if (urlError) return adminError(c, 400, urlError);
    if (!Array.isArray(body.event_types) || body.event_types.length === 0 || body.event_types.some((event) => !EVENT_TYPES.has(event))) return adminError(c, 400, "event_types must contain supported Notion webhook events.");
    const notionId = nextUuid(store, "notion_webhook_subscription_counter", "b1000000");
    const integrationId = nextUuid(store, "notion_webhook_integration_counter", "b3000000");
    const secret = nextSecret(store);
    const record = admin.subscriptions.insert({ notion_id: notionId, integration_id: integrationId, url: body.url, event_types: [...new Set(body.event_types)], status: "pending", verification_token: secret });
    admin.captureVerification(record);
    return c.json({ id: record.notion_id, url: record.url, event_types: record.event_types, status: record.status, verification_token: secret }, 201);
  });
  app.post("/__worldfixture/notion-admin/webhooks/:id/verify", async (c) => {
    if (!authorized(c)) return adminError(c, 401, "A REST inspection token is required.");
    const record = admin.subscriptions.findOneBy("notion_id", c.req.param("id"));
    const body = await c.req.json().catch(() => null);
    if (!record || body?.verification_token !== record.verification_token) return adminError(c, 400, "The verification token is not valid.");
    admin.subscriptions.update(record.id, { status: "active", verified_at: new Date().toISOString() });
    return c.json({ id: record.notion_id, status: "active" });
  });
  app.post("/__worldfixture/notion-admin/webhooks/:id/resend-token", (c) => {
    if (!authorized(c)) return adminError(c, 401, "A REST inspection token is required.");
    const record = admin.subscriptions.findOneBy("notion_id", c.req.param("id"));
    if (!record || record.status !== "pending") return adminError(c, 400, "A pending webhook subscription is required.");
    admin.captureVerification(record);
    return c.json({ id: record.notion_id, status: record.status });
  });
  app.patch("/__worldfixture/notion-admin/webhooks/:id", async (c) => {
    if (!authorized(c)) return adminError(c, 401, "A REST inspection token is required.");
    const record = admin.subscriptions.findOneBy("notion_id", c.req.param("id"));
    const body = await c.req.json().catch(() => null);
    if (!record || !body) return adminError(c, 404, "Webhook subscription not found.");
    if (body.url !== undefined && record.status !== "pending") return adminError(c, 400, "A verified webhook URL cannot be changed.");
    if (body.url !== undefined) {
      const urlError = notionWebhookUrlError(store, body.url);
      if (urlError) return adminError(c, 400, urlError);
    }
    if (body.event_types !== undefined && (!Array.isArray(body.event_types) || body.event_types.length === 0 || body.event_types.some((event) => !EVENT_TYPES.has(event)))) return adminError(c, 400, "event_types must contain supported Notion webhook events.");
    if (body.status !== undefined && (!["active", "paused"].includes(body.status) || !record.verified_at)) return adminError(c, 400, "Only verified subscriptions can be paused or activated.");
    const updated = admin.subscriptions.update(record.id, { url: body.url ?? record.url, event_types: body.event_types ?? record.event_types, status: body.status ?? record.status });
    if (body.url !== undefined && body.url !== record.url) admin.captureVerification(updated);
    return c.json({ id: updated.notion_id, url: updated.url, event_types: updated.event_types, status: updated.status });
  });
  app.delete("/__worldfixture/notion-admin/webhooks/:id", (c) => {
    if (!authorized(c)) return adminError(c, 401, "A REST inspection token is required.");
    const record = admin.subscriptions.findOneBy("notion_id", c.req.param("id"));
    if (record) admin.subscriptions.delete(record.id);
    return c.body(null, 204);
  });
}
