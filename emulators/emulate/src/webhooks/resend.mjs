import { randomBytes, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { getResendStore } from "@emulators/resend";
import { createWebhookTransport } from "./transport.mjs";
import { svixHeaders, svixShouldRetry } from "./svix.mjs";

// https://resend.com/docs/webhooks/retries-and-replays
export const RESEND_RETRY_DELAYS = [5000, 300_000, 1_800_000, 7_200_000, 18_000_000, 36_000_000, 36_000_000];
const EVENTS = new Set(["email.sent", "email.delivered", "email.scheduled", "email.delivery_delayed",
  "email.complained", "email.bounced", "email.opened", "email.clicked", "email.received", "email.failed",
  "email.suppressed", "domain.created", "domain.updated", "domain.deleted", "contact.created", "contact.updated", "contact.deleted",
  "suppression.added", "suppression.removed"]);
const hooks = store => store.collection("worldfixture.resend.webhooks", ["webhook_id"]);
const GENERATION = "worldfixture.resend.webhook_generation";
function generation(store) {
  if (!store.getData(GENERATION)) store.setData(GENERATION, {});
  return store.getData(GENERATION);
}
const publicHook = hook => ({ id: hook.webhook_id, endpoint: hook.endpoint,
  events: hook.events, status: hook.status, created_at: hook.created_at });
function emailMessageId(store, email) {
  if (email.message_id) return email.message_id;
  const header = Object.entries(email.headers ?? {}).find(([name]) => name.toLowerCase() === "message-id")?.[1];
  const messageId = typeof header === "string" && header ? header : `<${email.uuid}@worldfixture.local>`;
  getResendStore(store).emails.update(email.id, { message_id: messageId });
  return messageId;
}
function validate(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  try { if (!["http:", "https:"].includes(new URL(input.endpoint).protocol)) return false; } catch { return false; }
  return Array.isArray(input.events) && input.events.length > 0 && input.events.every(event => EVENTS.has(event))
    && [undefined, "enabled", "disabled"].includes(input.status);
}
function insert(store, input) {
  if (!validate(input)) throw new Error("Invalid Resend webhook endpoint, events, or status");
  return hooks(store).insert({ webhook_id: input.id ?? randomUUID(), endpoint: input.endpoint,
    events: input.events, status: input.status ?? "enabled",
    signing_secret: input.signing_secret ?? `whsec_${randomBytes(32).toString("base64")}` });
}
export function seedResendWebhooks(store, config) {
  store.setData(GENERATION, {});
  for (const input of config?.webhooks ?? []) insert(store, { ...input, endpoint: input.endpoint ?? input.url });
}

export function extendResendWebhooksPlugin(upstream, options = {}) {
  return { ...upstream, register(app, store, webhooks, ...args) {
    const snapshots = new AsyncLocalStorage();
    const transport = createWebhookTransport({ retryDelays: RESEND_RETRY_DELAYS,
      headers: svixHeaders, shouldRetry: svixShouldRetry, isActive: delivery => store.getData(GENERATION) === delivery.generation && hooks(store).findOneBy("webhook_id", delivery.hookId)?.status === "enabled",
      ...options });
    webhooks.resendDelivery = transport;
    webhooks.dispatch = async (type, _action, payload, owner) => {
      if (owner !== "resend" || !EVENTS.has(type)) return;
      let data = structuredClone(payload.data);
      if (type.startsWith("email.")) {
        const email = getResendStore(store).emails.findOneBy("uuid", data.email_id);
        if (!email) return;
        data = { ...data, email_id: email.uuid, created_at: email.created_at,
          message_id: emailMessageId(store, email), from: email.from, to: email.to, subject: email.subject };
        if (email.tags?.length) data.tags = Object.fromEntries(email.tags.map(tag => [tag.name, tag.value]));
      } else if (type.startsWith("domain.")) {
        const domain = getResendStore(store).domains.findOneBy("uuid", data.id) ?? snapshots.getStore()?.domain;
        if (!domain || domain.uuid !== data.id) return;
        data = { id: domain.uuid, name: domain.name, status: domain.status, created_at: domain.created_at,
          region: domain.region, capabilities: domain.capabilities ?? { sending: "enabled", receiving: "disabled" }, records: domain.records };
      } else if (type.startsWith("contact.")) {
        const contact = getResendStore(store).contacts.findOneBy("uuid", data.id) ?? snapshots.getStore()?.contact;
        if (!contact || contact.uuid !== data.id) return;
        data = { id: contact.uuid, audience_id: contact.audience_id, segment_ids: [contact.audience_id],
          created_at: contact.created_at, updated_at: contact.updated_at, email: contact.email,
          first_name: contact.first_name, last_name: contact.last_name, unsubscribed: contact.unsubscribed };
      }
      const rawBody = JSON.stringify({ type, created_at: new Date().toISOString(), data });
      const id = `msg_${randomBytes(18).toString("base64url")}`;
      for (const hook of hooks(store).all()) {
        if (hook.status !== "enabled" || !hook.events.includes(type)) continue;
        transport.enqueue({ id, rawBody, url: hook.endpoint, secret: hook.signing_secret, hookId: hook.webhook_id, generation: generation(store) });
      }
    };
    app.use("*", async (c, next) => {
      const emailWrite = c.req.method === "POST" && ["/emails", "/emails/batch"].includes(c.req.path);
      const emailRead = c.req.method === "GET" && /^\/emails(?:\/[^/]+)?$/.test(c.req.path);
      if (!emailWrite && !emailRead) return next();
      const rs = getResendStore(store);
      const json = c.json;
      let accepted = [];
      c.json = function(data, ...rest) {
        if (emailRead) {
          const withMessageId = item => {
            const email = rs.emails.findOneBy("uuid", item.id);
            return email ? { ...item, message_id: emailMessageId(store, email) } : item;
          };
          data = Array.isArray(data.data) ? { ...data, data: data.data.map(withMessageId) } : withMessageId(data);
        }
        const response = json.call(this, data, ...rest);
        if (emailWrite && response.ok) accepted = Array.isArray(data.data) ? data.data : [data];
        return response;
      };
      try { await next(); } finally { c.json = json; }
      for (const result of accepted) {
        const email = rs.emails.findOneBy("uuid", result.id);
        if (email?.status === "scheduled") {
          await webhooks.dispatch("email.scheduled", undefined, { data: { email_id: email.uuid } }, "resend");
        }
      }
    });
    app.use("*", async (c, next) => {
      const domainId = /^\/domains\/([^/]+)(?:\/verify)?$/.exec(c.req.path)?.[1];
      const contactId = /^\/audiences\/[^/]+\/contacts\/([^/]+)$/.exec(c.req.path)?.[1];
      if (!domainId && !contactId) return next();
      const rs = getResendStore(store);
      const domain = domainId && rs.domains.findOneBy("uuid", domainId);
      const contact = contactId && rs.contacts.findOneBy("uuid", contactId);
      const json = c.json;
      let success = false;
      c.json = function(data, ...rest) {
        const response = json.call(this, data, ...rest);
        success = response.ok;
        return response;
      };
      try { await snapshots.run(structuredClone({ domain, contact }), next); } finally { c.json = json; }
      if (success && domain && c.req.method === "POST" && c.req.path.endsWith("/verify")) {
        const current = rs.domains.findOneBy("uuid", domainId);
        if (current && (domain.status !== current.status || JSON.stringify(domain.records) !== JSON.stringify(current.records))) {
          await webhooks.dispatch("domain.updated", undefined, { data: { id: domainId } }, "resend");
        }
      }
    });
    const error = (c, status, message) => c.json({ statusCode: status, name: status === 404 ? "not_found" : "validation_error", message }, status);
    const auth = async (c, next) => c.get("authUser") ? next() : c.json({ statusCode: 401, name: "validation_error", message: "API key is invalid" }, 401);
    app.use("/webhooks", auth);
    app.use("/webhooks/*", auth);
    app.post("/webhooks", async c => {
      const input = await c.req.json().catch(() => null);
      if (!input || !validate(input)) return error(c, 422, "Invalid webhook endpoint, events, or status");
      const hook = insert(store, { endpoint: input.endpoint, events: input.events, status: input.status });
      return c.json({ object: "webhook", id: hook.webhook_id, signing_secret: hook.signing_secret });
    });
    app.get("/webhooks", c => c.json({ object: "list", has_more: false, data: hooks(store).all().map(publicHook) }));
    app.get("/webhooks/:id", c => {
      const hook = hooks(store).findOneBy("webhook_id", c.req.param("id"));
      return hook ? c.json({ object: "webhook", ...publicHook(hook), signing_secret: hook.signing_secret }) : error(c, 404, "Webhook not found");
    });
    app.patch("/webhooks/:id", async c => {
      const hook = hooks(store).findOneBy("webhook_id", c.req.param("id"));
      if (!hook) return error(c, 404, "Webhook not found");
      const input = await c.req.json().catch(() => null);
      if (!input || typeof input !== "object" || Array.isArray(input) || !validate({ ...hook, ...input })) return error(c, 422, "Invalid webhook endpoint, events, or status");
      hooks(store).update(hook.id, { endpoint: input.endpoint ?? hook.endpoint, events: input.events ?? hook.events, status: input.status ?? hook.status });
      return c.json({ object: "webhook", id: hook.webhook_id });
    });
    app.delete("/webhooks/:id", c => {
      const hook = hooks(store).findOneBy("webhook_id", c.req.param("id"));
      if (!hook) return error(c, 404, "Webhook not found");
      hooks(store).delete(hook.id);
      return c.json({ object: "webhook", id: hook.webhook_id, deleted: true });
    });
    upstream.register(app, store, webhooks, ...args);
  } };
}
