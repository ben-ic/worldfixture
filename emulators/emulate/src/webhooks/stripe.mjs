import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

export const STRIPE_WEBHOOK_API_VERSION = "2026-08-26.dahlia";
const contract = JSON.parse(readFileSync(new URL("../../contracts/stripe/webhooks-2026-08-26.contract.json", import.meta.url), "utf8"));
const eventTypes = new Set(contract.enabled_events);
const identifier = prefix => `${prefix}_${randomBytes(12).toString("hex")}`;
const seconds = () => Math.floor(Date.now() / 1000);
const endpointStore = store => store.collection("stripe.webhook_endpoints", ["stripe_id"]);
const eventStore = store => store.collection("stripe.events", ["stripe_id"]);
const bad = (c, message, status = 400) => c.json({ error: { type: "invalid_request_error", message } }, status);

function publicEndpoint(row, includeSecret = false) {
  return { id: row.stripe_id, object: "webhook_endpoint", api_version: row.api_version,
    application: null, created: row.created, description: row.description, enabled_events: row.events,
    livemode: false, metadata: row.metadata, status: row.active ? "enabled" : "disabled", url: row.url,
    ...(includeSecret ? { secret: row.secret } : {}) };
}

async function bodyOf(c) {
  const raw = await c.req.text();
  if ((c.req.header("Content-Type") ?? "").includes("application/json")) return JSON.parse(raw || "{}");
  const body = {};
  for (const [key, value] of new URLSearchParams(raw)) {
    if (/^enabled_events\[(?:\d*)\]$/.test(key)) (body.enabled_events ??= []).push(value);
    else if (/^metadata\[[^\]]+\]$/.test(key)) (body.metadata ??= {})[key.slice(9, -1)] = value;
    else body[key] = value;
  }
  return body;
}

function validateEndpoint(body, creating) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "Invalid request body";
  if (!creating && body.api_version !== undefined) return "Received unknown parameter: api_version";
  if (creating || body.url !== undefined) {
    try { const url = new URL(body.url); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return "Invalid URL"; }
    catch { return "Invalid URL"; }
  }
  if (creating || body.enabled_events !== undefined) {
    if (!Array.isArray(body.enabled_events) || body.enabled_events.length === 0
      || body.enabled_events.some(event => !eventTypes.has(event))) return "Invalid enabled_events";
  }
  if (body.api_version != null && body.api_version !== STRIPE_WEBHOOK_API_VERSION) return `Only API version ${STRIPE_WEBHOOK_API_VERSION} is supported`;
  if (body.connect === true || body.connect === "true") return "Connect webhook endpoints are not supported";
  if (body.disabled !== undefined && ![true, false, "true", "false"].includes(body.disabled)) return "Invalid boolean: disabled";
  if (body.metadata !== undefined && body.metadata !== "" && (body.metadata === null || typeof body.metadata !== "object" || Array.isArray(body.metadata)
    || Object.values(body.metadata).some(value => typeof value !== "string"))) return "Invalid metadata";
  return null;
}

function list(c, rows, path, format) {
  const limit = Number(c.req.query("limit") ?? 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return bad(c, "limit must be an integer from 1 to 100");
  const after = c.req.query("starting_after"), before = c.req.query("ending_before");
  if (after && before) return bad(c, "Supply only one cursor");
  if (after || before) {
    const index = rows.findIndex(row => row.stripe_id === (after || before));
    if (index < 0) return bad(c, `No such object: '${after || before}'`);
    rows = after ? rows.slice(index + 1) : rows.slice(0, index);
  }
  return c.json({ object: "list", data: (before ? rows.slice(-limit) : rows.slice(0, limit)).map(format), has_more: rows.length > limit, url: path });
}

function mergeMetadata(previous, changes) {
  if (changes === "") return {};
  const result = { ...previous, ...changes };
  for (const [key, value] of Object.entries(result)) if (value === "") delete result[key];
  return result;
}

function previousAttributes(previous, current) {
  const result = {};
  for (const key of new Set([...Object.keys(previous), ...Object.keys(current)])) {
    const before = previous[key], after = current[key];
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    result[key] = before && after && typeof before === "object" && typeof after === "object"
      && !Array.isArray(before) && !Array.isArray(after) ? previousAttributes(before, after) : before ?? null;
  }
  return result;
}

// Use the account's snapshot API version. This module does not convert objects
// between API versions, or create Connect and v2 thin events.
export function extendStripeWebhooksPlugin(upstream, options = {}) {
  return { ...upstream, register(app, store, webhooks, ...args) {
    const endpoints = endpointStore(store), events = eventStore(store);
    const context = new AsyncLocalStorage();
    const register = webhooks.register.bind(webhooks), dispatch = webhooks.dispatch.bind(webhooks);
    const pending = new Set(), timers = new Map(), controllers = new Set();
    const retryDelays = options.retryDelaysMs ?? [60_000, 120_000];
    let generation = 0;
    webhooks.register = subscription => {
      if (subscription.owner !== "stripe") return register(subscription);
      const row = endpoints.insert({ stripe_id: subscription.stripe_id ?? identifier("we"),
        url: subscription.url, events: [...subscription.events], active: subscription.active !== false,
        secret: subscription.secret || identifier("whsec"), api_version: subscription.api_version ?? null,
        created: seconds(), description: subscription.description ?? null, metadata: mergeMetadata({}, subscription.metadata) });
      return register({ ...subscription, id: row.id, secret: row.secret, stripe_id: row.stripe_id });
    };
    const sleep = ms => new Promise(resolve => { const timer = setTimeout(() => { timers.delete(timer); resolve(); }, ms); timer.unref?.(); timers.set(timer, resolve); });
    async function deliver(row, event, token) {
      // Serialize once. A retry retains the event ID, creation time and snapshot.
      const body = JSON.stringify(event);
      for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
        if (attempt) await sleep(retryDelays[attempt - 1]);
        const current = endpoints.get(row.id);
        if (token !== generation || !current?.active || current.stripe_id !== row.stripe_id) return;
        const started = Date.now(), timestamp = seconds();
        const signature = createHmac("sha256", current.secret).update(`${timestamp}.${body}`).digest("hex");
        const controller = new AbortController(); controllers.add(controller);
        const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000); timeout.unref?.();
        const delivery = { id: webhooks.deliveryIdCounter++, hook_id: row.id, event: event.type,
          payload: event, status_code: null, delivered_at: new Date().toISOString(), duration: null, success: false };
        try {
          const response = await fetch(current.url, { method: "POST", redirect: "manual", body,
            headers: { "Content-Type": "application/json", "Stripe-Signature": `t=${timestamp},v1=${signature}` }, signal: controller.signal });
          delivery.status_code = response.status; delivery.success = response.ok;
          await response.body?.cancel();
        } catch { /* Record network failures. The API mutation has already completed. */ }
        finally { clearTimeout(timeout); controllers.delete(controller); }
        if (token !== generation) return;
        delivery.duration = Date.now() - started;
        webhooks.deliveries.push(delivery);
        if (webhooks.deliveries.length > 1000) webhooks.deliveries.splice(0, webhooks.deliveries.length - 1000);
        if (delivery.success) {
          const stored = events.findOneBy("stripe_id", event.id);
          if (stored) events.update(stored.id, { payload: { ...stored.payload, pending_webhooks: Math.max(0, stored.payload.pending_webhooks - 1) } });
          return;
        }
      }
    }
    webhooks.dispatch = async (type, action, payload, owner, repo) => {
      if (owner !== "stripe") return dispatch(type, action, payload, owner, repo);
      const subscriptions = endpoints.all().filter(row => row.active && (row.events.includes("*") || row.events.includes(type)));
      const request = context.getStore();
      const data = structuredClone(payload.data);
      // Upstream charge events contain only five fields. Read the resource now,
      // before a later mutation can change this event's snapshot.
      const resource = { charge: "charges", payment_intent: "payment_intents", invoice: "invoices" }[data.object.object];
      if (resource && !type.endsWith(".deleted")) {
        const response = await app.request(`/v1/${resource}/${data.object.id}`, { headers: { authorization: request?.authorization ?? "" } });
        if (response.ok) data.object = await response.json();
      }
      if (data.object.object === "charge") {
        const charge = data.object;
        // Only the local successful, immediately captured charge branch exists.
        Object.assign(charge, { amount_captured: charge.paid ? charge.amount : 0,
          captured: charge.paid, disputed: false,
          billing_details: { address: null, email: null, name: null, phone: null } });
        delete charge.invoice; // Removed from Charge in the pinned API version.
      }
      if (type === "customer.deleted") delete data.object.deleted;
      if (data.object.object === "product") {
        const row = store.collection("stripe.products", ["stripe_id"]).findOneBy("stripe_id", data.object.id);
        data.object.images ??= row?.images ?? [];
        data.object.marketing_features ??= row?.marketing_features ?? [];
        data.object.updated ??= row?.updated_at ? Math.floor(new Date(row.updated_at).getTime() / 1000) : data.object.created;
      }
      if (data.object.object === "price") data.object.billing_scheme ??= "per_unit";
      if (data.object.object === "checkout.session") {
        // The local Checkout page supports cards without tax, shipping, or
        // custom controls. The default Stripe expiry is 24 hours after creation.
        data.object.automatic_tax ??= { enabled: false, liability: null, provider: null, status: null };
        data.object.custom_fields ??= [];
        data.object.custom_text ??= { after_submit: null, shipping_address: null, submit: null, terms_of_service_acceptance: null };
        data.object.expires_at ??= data.object.created + 86_400;
        data.object.payment_method_types ??= ["card"];
        data.object.shipping_options ??= [];
      }
      if (type.endsWith(".updated") && request?.previous?.id === data.object.id) {
        data.previous_attributes = previousAttributes(request.previous, data.object);
      }
      const event = { id: identifier("evt"), object: "event", api_version: STRIPE_WEBHOOK_API_VERSION,
        created: seconds(), data, livemode: false, pending_webhooks: subscriptions.length,
        request: request ? { id: request.id, idempotency_key: request.idempotencyKey } : null, type };
      events.insert({ stripe_id: event.id, payload: event });
      for (const row of subscriptions) {
        const promise = deliver(row, structuredClone(event), generation);
        pending.add(promise); promise.finally(() => pending.delete(promise));
      }
    };
    webhooks.flushStripeWebhooks = async () => { while (pending.size) await Promise.all([...pending]); };
    webhooks.closeStripeWebhooks = () => {
      generation++;
      for (const controller of controllers) controller.abort();
      for (const [timer, resolve] of timers) { clearTimeout(timer); resolve(); }
      timers.clear();
    };
    const clear = webhooks.clear.bind(webhooks);
    webhooks.clear = () => { webhooks.closeStripeWebhooks(); endpoints.clear(); events.clear(); clear(); };

    app.use("*", async (c, next) => {
      if (!c.req.path.startsWith("/v1/") || !["POST", "DELETE"].includes(c.req.method)) return next();
      const request = { id: identifier("req"), idempotencyKey: c.req.header("Idempotency-Key") ?? null,
        authorization: c.req.header("Authorization") ?? "" };
      c.header("Request-Id", request.id);
      if (/^\/v1\/(?:customers|invoices|subscriptions|invoiceitems)\/[^/]+$/.test(c.req.path)) {
        const previous = await app.request(c.req.url, { headers: { authorization: c.req.header("Authorization") ?? "" } });
        if (previous.ok) request.previous = await previous.json();
      }
      return context.run(request, async () => {
        const json = c.json;
        let response;
        c.json = function(...values) { response = json.apply(this, values); return response; };
        try { await next(); } finally { c.json = json; }
        if (!response?.ok) return;
        const extraType = c.req.method === "POST" && c.req.path === "/v1/invoiceitems" ? "invoiceitem.created"
          : c.req.method === "DELETE" && /^\/v1\/invoiceitems\//.test(c.req.path) ? "invoiceitem.deleted"
          : c.req.method === "DELETE" && /^\/v1\/invoices\//.test(c.req.path) ? "invoice.deleted" : null;
        if (extraType) await webhooks.dispatch(extraType, undefined, { data: { object: request.previous ?? await response.clone().json() } }, "stripe");
        if (c.req.method === "POST" && c.req.path === "/v1/refunds") {
          const refund = await response.clone().json();
          const chargeResponse = await app.request(`/v1/charges/${refund.charge}`, { headers: { authorization: c.req.header("Authorization") ?? "" } });
          if (chargeResponse.ok) await webhooks.dispatch("charge.refunded", undefined, { data: { object: await chargeResponse.json() } }, "stripe");
        }
      });
    });
    app.post("/v1/webhook_endpoints", async c => {
      let body; try { body = await bodyOf(c); } catch { return bad(c, "Invalid request body"); }
      const problem = validateEndpoint(body, true); if (problem) return bad(c, problem);
      const subscription = webhooks.register({ owner: "stripe", active: true, url: body.url,
        events: body.enabled_events, api_version: body.api_version, description: body.description, metadata: body.metadata });
      return c.json(publicEndpoint(endpoints.get(subscription.id), true));
    });
    app.get("/v1/webhook_endpoints", c => list(c, endpoints.all().reverse(), "/v1/webhook_endpoints", row => publicEndpoint(row)));
    app.get("/v1/webhook_endpoints/:id", c => {
      const row = endpoints.findOneBy("stripe_id", c.req.param("id"));
      return row ? c.json(publicEndpoint(row)) : bad(c, `No such webhook_endpoint: '${c.req.param("id")}'`, 404);
    });
    app.post("/v1/webhook_endpoints/:id", async c => {
      const row = endpoints.findOneBy("stripe_id", c.req.param("id"));
      if (!row) return bad(c, `No such webhook_endpoint: '${c.req.param("id")}'`, 404);
      let body; try { body = await bodyOf(c); } catch { return bad(c, "Invalid request body"); }
      const problem = validateEndpoint(body, false); if (problem) return bad(c, problem);
      const changes = {};
      for (const key of ["url", "description"]) if (body[key] !== undefined) changes[key] = body[key];
      if (body.metadata !== undefined) changes.metadata = mergeMetadata(row.metadata, body.metadata);
      if (body.enabled_events !== undefined) changes.events = body.enabled_events;
      if (body.disabled !== undefined) changes.active = body.disabled !== true && body.disabled !== "true";
      const updated = endpoints.update(row.id, changes); webhooks.updateSubscription(row.id, changes);
      return c.json(publicEndpoint(updated));
    });
    app.delete("/v1/webhook_endpoints/:id", c => {
      const row = endpoints.findOneBy("stripe_id", c.req.param("id"));
      if (!row) return bad(c, `No such webhook_endpoint: '${c.req.param("id")}'`, 404);
      endpoints.delete(row.id); webhooks.unregister(row.id);
      return c.json({ id: row.stripe_id, object: "webhook_endpoint", deleted: true });
    });
    app.get("/v1/events", c => {
      const params = new URL(c.req.url).searchParams, type = params.get("type");
      const types = [...params].filter(([key]) => /^types\[\d*\]$/.test(key)).map(([, value]) => value);
      if (type !== null && types.length) return bad(c, "Supply only one of type or types");
      if (types.length > 20) return bad(c, "Supply at most 20 event types");
      const success = params.get("delivery_success");
      if (success !== null && !["true", "false"].includes(success)) return bad(c, "Invalid boolean: delivery_success");
      const ranges = ["gt", "gte", "lt", "lte"].map(op => [op, params.get(`created[${op}]`)]).filter(([, value]) => value !== null);
      if (ranges.some(([, value]) => !/^\d+$/.test(value))) return bad(c, "Invalid created timestamp");
      const pattern = type === null ? null : new RegExp(`^${type.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
      const rows = events.all().reverse().filter(({ payload: event }) =>
        (!pattern || pattern.test(event.type)) && (!types.length || types.includes(event.type))
        && (success === null || (event.pending_webhooks === 0) === (success === "true"))
        && ranges.every(([op, value]) => ({ gt: event.created > Number(value), gte: event.created >= Number(value),
          lt: event.created < Number(value), lte: event.created <= Number(value) })[op]));
      return list(c, rows, "/v1/events", row => row.payload);
    });
    app.get("/v1/events/:id", c => {
      const row = events.findOneBy("stripe_id", c.req.param("id"));
      return row ? c.json(row.payload) : bad(c, `No such event: '${c.req.param("id")}'`, 404);
    });
    upstream.register(app, store, webhooks, ...args);
  } };
}

export function seedStripeWebhooks(_store, webhooks, config = {}) {
  for (const endpoint of config.webhooks ?? []) {
    const body = { ...endpoint, enabled_events: endpoint.enabled_events ?? endpoint.events };
    const problem = validateEndpoint(body, true); if (problem) throw new Error(`Stripe webhook: ${problem}`);
    webhooks.register({ ...endpoint, stripe_id: endpoint.id, owner: "stripe", active: endpoint.disabled !== true,
      events: body.enabled_events });
  }
}
