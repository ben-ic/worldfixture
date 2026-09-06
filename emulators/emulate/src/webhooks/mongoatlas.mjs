import { createHmac } from "node:crypto";
import { getMongoAtlasStore } from "@emulators/mongoatlas";
import { createWebhookTransport } from "./transport.mjs";

const KEY = "worldfixture.mongoatlas.webhooks";
const alerts = store => store.collection("worldfixture.mongoatlas.alerts", ["alert_id", "group_id"]);
const EVENT_STATUS = { "alert.open": "OPEN", "alert.update": "OPEN", "alert.close": "CLOSED",
  "alert.cancel": "CANCELLED", "alert.acknowledge": "OPEN", "alert.inform": "INFORMATIONAL" };
export function seedAtlasWebhooks(store, config) {
  const endpoints = config?.webhooks ?? [];
  if (!Array.isArray(endpoints)) throw new Error("mongoatlas.webhooks must be an array");
  for (const item of endpoints) {
    if (!/^https?:$/.test(new URL(item.url).protocol) || !/^[a-f0-9]{24}$/.test(item.group_id ?? "")) {
      throw new Error("Atlas webhook requires a URL and a project group_id");
    }
  }
  store.setData(KEY, structuredClone(endpoints));
}

export function extendAtlasWebhooksPlugin(upstream, options = {}) {
  return { ...upstream, register(app, store, webhooks, ...args) {
    const delivery = createWebhookTransport({ headers: item => ({ "content-type": "application/json",
      "x-mms-event": item.event, ...(item.secret ? { "x-mms-signature": createHmac("sha1", item.secret).update(item.rawBody).digest("base64") } : {}) }),
      isActive: item => store.getData(KEY) === item.config && item.config?.some(endpoint => endpoint.group_id === item.groupId && endpoint.url === item.url && endpoint.enabled !== false), ...options });
    webhooks.atlasDelivery = delivery;
    // Atlas emits monitoring alerts, not Data API CRUD webhooks. This control
    // supplies a monitoring fact without pretending to run a metrics collector.
    app.post("/__worldfixture/mongoatlas/alerts", async c => {
      if (!c.get("authUser")) return c.json({ error: "Authentication required" }, 401);
      const input = await c.req.json().catch(() => null);
      const event = input?.event, alert = input?.alert;
      if (!alert || !Object.hasOwn(EVENT_STATUS, event ?? "") || alert.status !== EVENT_STATUS[event]
        || !/^[a-f0-9]{24}$/.test(alert.id ?? "") || !/^[a-f0-9]{24}$/.test(alert.groupId ?? "")
        || !/^[A-Z][A-Z0-9_]+$/.test(alert.eventTypeName ?? "") || typeof alert.humanReadable !== "string"
        || !Number.isFinite(Date.parse(alert.created)) || !Number.isFinite(Date.parse(alert.updated))) {
        return c.json({ error: "Supply a native Atlas alert with a matching event and status" }, 400);
      }
      if (!getMongoAtlasStore(store).projects.findOneBy("group_id", alert.groupId)) return c.json({ error: "Project not found" }, 404);
      const payload = structuredClone(alert);
      // Configured severity is absent from the documented Atlas webhook body.
      delete payload.severity;
      const existing = alerts(store).findOneBy("alert_id", alert.id);
      if (existing && existing.group_id !== alert.groupId) return c.json({ error: "Alert belongs to another project" }, 409);
      if (existing) alerts(store).update(existing.id, { payload });
      else alerts(store).insert({ alert_id: alert.id, group_id: alert.groupId, payload });
      const rawBody = JSON.stringify(payload);
      for (const endpoint of store.getData(KEY) ?? []) {
        if (endpoint.enabled === false || endpoint.group_id !== alert.groupId) continue;
        delivery.enqueue({ event, rawBody, url: endpoint.url, secret: endpoint.secret, groupId: alert.groupId, config: store.getData(KEY) });
      }
      return c.json({ accepted: true, id: alert.id }, 202);
    });
    app.get("/api/atlas/v2/groups/:groupId/alerts", c => {
      if (!c.get("authUser")) return c.json({ error: "Authentication required" }, 401);
      const rows = alerts(store).findBy("group_id", c.req.param("groupId"));
      const result = rows.map(row => row.payload).filter(alert => !c.req.query("status") || alert.status === c.req.query("status"));
      return c.json({ links: [], results: result, totalCount: result.length });
    });
    app.get("/api/atlas/v2/groups/:groupId/alerts/:alertId", c => {
      if (!c.get("authUser")) return c.json({ error: "Authentication required" }, 401);
      const row = alerts(store).findOneBy("alert_id", c.req.param("alertId"));
      return row?.group_id === c.req.param("groupId") ? c.json(row.payload) : c.json({ error: 404, errorCode: "RESOURCE_NOT_FOUND", detail: "Alert not found" }, 404);
    });
    upstream.register(app, store, webhooks, ...args);
  } };
}
