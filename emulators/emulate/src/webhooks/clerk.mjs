import { randomBytes } from "node:crypto";
import { getClerkStore } from "@emulators/clerk";
import { createWebhookTransport } from "./transport.mjs";
import { svixHeaders, svixShouldRetry } from "./svix.mjs";

const KEY = "worldfixture.clerk.webhooks";
// Clerk uses the published Svix schedule: https://docs.svix.com/retries
const RETRIES = [5000, 300_000, 1_800_000, 7_200_000, 18_000_000, 36_000_000, 36_000_000];
const EVENTS = new Set(["user.created", "user.updated", "user.deleted", "organization.created",
  "organization.updated", "organization.deleted", "organizationMembership.created", "organizationMembership.updated",
  "session.created", "session.revoked", "organizationInvitation.created", "organizationInvitation.revoked"]);

export function seedClerkWebhooks(store, config) {
  const endpoints = config?.webhooks ?? [];
  if (!Array.isArray(endpoints)) throw new Error("clerk.webhooks must be an array");
  if (endpoints.length && !/^ins_\w+$/.test(config.instance_id ?? "")) throw new Error("Clerk webhooks require instance_id");
  for (const endpoint of endpoints) {
    if (!/^https?:$/.test(new URL(endpoint.url).protocol) || !/^whsec_[A-Za-z0-9+/=]+$/.test(endpoint.signing_secret ?? "")
      || !Array.isArray(endpoint.events) || !endpoint.events.length || endpoint.events.some(event => !EVENTS.has(event))) {
      throw new Error("Invalid Clerk webhook URL, signing secret, or events");
    }
  }
  store.setData(KEY, { instance_id: config?.instance_id, endpoints: structuredClone(endpoints) });
}

function eventFor(method, path) {
  if (method === "POST" && path === "/v1/users") return "user.created";
  if (method === "DELETE" && /^\/v1\/users\/[^/]+$/.test(path)) return "user.deleted";
  if ((method === "PATCH" && /^\/v1\/users\/[^/]+(?:\/metadata)?$/.test(path))
    || (method === "POST" && /^\/v1\/users\/[^/]+\/(ban|unban|lock|unlock)$/.test(path))) return "user.updated";
  if (method === "POST" && path === "/v1/organizations") return "organization.created";
  if (method === "PATCH" && /^\/v1\/organizations\/[^/]+(?:\/metadata)?$/.test(path)) return "organization.updated";
  if (method === "DELETE" && /^\/v1\/organizations\/[^/]+$/.test(path)) return "organization.deleted";
  if (method === "POST" && /^\/v1\/organizations\/[^/]+\/memberships$/.test(path)) return "organizationMembership.created";
  if (method === "PATCH" && /^\/v1\/organizations\/[^/]+\/memberships\/[^/]+(?:\/metadata)?$/.test(path)) return "organizationMembership.updated";
  if (method === "POST" && /^\/v1\/organizations\/[^/]+\/invitations$/.test(path)) return "organizationInvitation.created";
  if (method === "POST" && /^\/v1\/organizations\/[^/]+\/invitations\/[^/]+\/revoke$/.test(path)) return "organizationInvitation.revoked";
  if (method === "POST" && path === "/v1/sessions") return "session.created";
  if (method === "POST" && /^\/v1\/sessions\/[^/]+\/revoke$/.test(path)) return "session.revoked";
  return null;
}
// The pinned emulator stores Unix seconds; Clerk webhook objects use milliseconds.
const TIME_FIELDS = new Set(["created_at", "updated_at", "last_active_at", "last_sign_in_at", "expire_at", "expires_at", "abandon_at"]);
function nativeData(value, key) {
  // Metadata belongs to the application; a timestamp-like key has no Clerk type.
  if (["public_metadata", "private_metadata", "unsafe_metadata"].includes(key)) return value;
  if (TIME_FIELDS.has(key) && typeof value === "number" && value < 100_000_000_000) return value * 1000;
  if (Array.isArray(value)) return value.map(item => nativeData(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, nativeData(item, name)]));
  return value;
}

export function extendClerkWebhooksPlugin(upstream, options = {}) {
  return { ...upstream, register(app, store, webhooks, ...args) {
    const delivery = createWebhookTransport({ retryDelays: RETRIES, headers: svixHeaders, shouldRetry: svixShouldRetry,
      isActive: item => store.getData(KEY) === item.config && item.config?.endpoints.some(endpoint => endpoint.url === item.url && endpoint.enabled !== false), ...options });
    webhooks.clerkDelivery = delivery;
    app.use("*", async (c, next) => {
      const type = eventFor(c.req.method, c.req.path);
      const config = store.getData(KEY);
      if (!type || !config?.endpoints.length) return next();
      const clerk = getClerkStore(store);
      // The delete response no longer has the user's external identifier.
      const externalId = type === "user.deleted"
        ? clerk.users.findOneBy("clerk_id", c.req.path.split("/").at(-1))?.external_id : undefined;
      const json = c.json;
      let accepted;
      c.json = function(data, ...rest) {
        const response = json.call(this, data, ...rest);
        if (response.ok && data && !data.errors) accepted = nativeData(data);
        return response;
      };
      try { await next(); } finally { c.json = json; }
      if (!accepted || store.getData(KEY) !== config) return;
      // DeletedObjectJSON permits an optional string slug, not null.
      if (accepted.deleted === true && accepted.slug === null) delete accepted.slug;
      if (type === "user.deleted" && typeof externalId === "string") accepted.external_id = externalId;
      if (type.startsWith("organizationInvitation.")) {
        const invitation = clerk.invitations.findOneBy("invitation_id", accepted.id);
        if (invitation) accepted.expires_at = nativeData(invitation.expires_at, "expires_at");
      }
      if (type.startsWith("session.")) {
        // Use the public serializer, which excludes the stored password hash.
        const user = await app.request(`/v1/users/${encodeURIComponent(accepted.user_id)}`, {
          headers: { authorization: c.req.header("authorization") ?? "" },
        });
        accepted.actor = null;
        accepted.user = user.ok ? nativeData(await user.json()) : null;
      }
      if (store.getData(KEY) !== config) return;
      const rawBody = JSON.stringify({ data: accepted, object: "event", type,
        timestamp: Date.now(), instance_id: config.instance_id,
        event_attributes: { http_request: {
          client_ip: c.env?.incoming?.socket?.remoteAddress ?? "0.0.0.0",
          user_agent: c.req.header("user-agent") ?? "",
        } } });
      const id = `msg_${randomBytes(18).toString("base64url")}`;
      for (const endpoint of config.endpoints) {
        if (endpoint.enabled === false || !endpoint.events.includes(type)) continue;
        delivery.enqueue({ id, rawBody, url: endpoint.url, secret: endpoint.signing_secret, config });
      }
    });
    upstream.register(app, store, webhooks, ...args);
  } };
}
