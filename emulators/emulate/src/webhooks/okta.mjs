import { randomBytes, randomUUID } from "node:crypto";
import { getOktaStore } from "@emulators/okta";
import { createWebhookTransport } from "./transport.mjs";

const KEY = "worldfixture.okta.eventHooks";
const ROOT = "/api/v1/eventHooks";
const MESSAGES = {
  "user.lifecycle.create": "Create Okta user", "user.account.update_profile": "Update user profile for Okta",
  "user.lifecycle.activate": "Activate Okta user", "user.lifecycle.deactivate": "Deactivate Okta user",
  "user.lifecycle.suspend": "Suspend Okta user", "user.lifecycle.unsuspend": "Unsuspend Okta user",
  "user.lifecycle.reactivate": "Reactivate Okta user", "user.lifecycle.delete.initiated": "Delete Okta user initiated",
  "group.lifecycle.create": "Create Okta group", "group.lifecycle.delete": "Delete Okta group",
  "group.profile.update": "Okta group profile updated",
  "group.user_membership.add": "Add user to group membership", "group.user_membership.remove": "Remove user from group membership",
  "application.user_membership.add": "Add user to application membership", "application.user_membership.remove": "Remove user from application membership",
};
const headersFor = hook => {
  const headers = new Headers({ accept: "application/json", "content-type": "application/json" });
  for (const { key, value } of hook.channel.config.headers ?? []) headers.set(key, value);
  const auth = hook.channel.config.authScheme;
  if (auth) headers.set(auth.key, auth.value);
  return Object.fromEntries(headers);
};
function validate(body) {
  if (!body || typeof body.name !== "string" || !body.name.trim()) throw new Error("name is required");
  if (body.events?.type !== "EVENT_TYPE" || !Array.isArray(body.events.items) || !body.events.items.length
    || body.events.items.some(type => !Object.hasOwn(MESSAGES, type))) throw new Error("events.items must contain supported event types");
  if (body.events.filter != null) throw new Error("Event hook expression filters are not supported locally");
  if (body.channel?.type !== "HTTP" || body.channel.version !== "1.0.0") throw new Error("channel must use HTTP version 1.0.0");
  const config = body.channel.config;
  const url = new URL(config?.uri);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("channel.config.uri must be an HTTP or HTTPS URL");
  if (config.headers !== undefined && (!Array.isArray(config.headers) || config.headers.some(h => typeof h.key !== "string" || typeof h.value !== "string"))) throw new Error("headers must contain key/value strings");
  if (config.authScheme && (config.authScheme.type !== "HEADER" || typeof config.authScheme.key !== "string" || typeof config.authScheme.value !== "string")) throw new Error("authScheme must use HEADER with key and value");
  headersFor(body);
}
function makeHook(body, createdBy = null) {
  validate(body);
  const now = new Date().toISOString();
  return { id: `who${randomBytes(13).toString("hex").slice(0, 17)}`, name: body.name, description: body.description ?? null,
    status: "ACTIVE", verificationStatus: "UNVERIFIED", created: now, lastUpdated: now, createdBy,
    events: { type: "EVENT_TYPE", items: [...body.events.items], filter: null },
    channel: { type: "HTTP", version: "1.0.0", config: { ...structuredClone(body.channel.config), headers: structuredClone(body.channel.config.headers ?? []), method: "POST" } } };
}
export function seedOktaWebhooks(store, config) {
  const hooks = config?.event_hooks ?? [];
  if (!Array.isArray(hooks)) throw new Error("okta.event_hooks must be an array");
  store.setData(KEY, hooks.map(body => {
    const hook = makeHook(body, body.createdBy ?? null);
    if (body.id) hook.id = body.id;
    if (body.status === "INACTIVE") hook.status = "INACTIVE";
    return hook;
  }));
}
const target = (row, type) => ({ id: row.okta_id, type, alternateId: row.login ?? row.name,
  displayName: row.display_name ?? row.label ?? row.name ?? [row.first_name, row.last_name].filter(Boolean).join(" "), detailEntry: null });
const copy = value => value ? structuredClone(value) : null;

export function extendOktaWebhooksPlugin(upstream, options = {}) {
  return { ...upstream, register(app, store, webhooks, baseUrl, tokenMap, ...args) {
    const os = getOktaStore(store);
    const hooks = () => store.getData(KEY) ?? [];
    const userByRef = ref => os.users.all().find(row => [row.okta_id, row.login, row.email].includes(ref));
    const actorFor = c => {
      const auth = c.get("authUser");
      const row = auth && userByRef(auth.login);
      return row ? target(row, "User") : { id: auth?.id == null ? null : String(auth.id), type: "User", alternateId: auth?.login ?? null, displayName: auth?.login ?? null, detailEntry: null };
    };
    const delivery = createWebhookTransport({ timeoutMs: 3000, retryDelays: [1000],
      accepted: response => [200, 204].includes(response.status), shouldRetry: (response, error) => Boolean(error) || response.status >= 500,
      headers: item => item.headers,
      isActive: item => hooks().some(hook => hook === item.hook && hook.status === "ACTIVE" && hook.verificationStatus === "VERIFIED" && hook.channel.config.uri === item.url),
      ...options });
    webhooks.oktaDelivery = delivery;
    const output = hook => {
      const result = structuredClone(hook);
      if (result.channel.config.authScheme) delete result.channel.config.authScheme.value;
      const href = `${baseUrl}${ROOT}/${hook.id}`;
      result._links = { self: { href }, verify: { href: `${href}/lifecycle/verify`, hints: { allow: ["POST"] } },
        [hook.status === "ACTIVE" ? "deactivate" : "activate"]: { href: `${href}/lifecycle/${hook.status === "ACTIVE" ? "deactivate" : "activate"}`, hints: { allow: ["POST"] } } };
      return result;
    };
    const error = (c, status, summary) => c.json({ errorCode: status === 404 ? "E0000007" : status === 401 ? "E0000004" : "E0000001",
      errorSummary: summary, errorLink: status === 404 ? "E0000007" : status === 401 ? "E0000004" : "E0000001", errorId: randomUUID(), errorCauses: [] }, status);
    app.use("*", async (c, next) => {
      if (c.req.path !== ROOT && !c.req.path.startsWith(`${ROOT}/`)) return next();
      if (!c.get("authUser")) {
        const match = /^SSWS\s+(.+)$/i.exec(c.req.header("authorization") ?? "");
        const auth = match && tokenMap?.get(match[1]);
        if (!auth) return error(c, 401, "Authentication failed");
        c.set("authUser", auth);
      }
      return next();
    });
    app.get(ROOT, c => c.json(hooks().map(output)));
    app.post(ROOT, async c => {
      try {
        const hook = makeHook(await c.req.json(), actorFor(c).id);
        store.setData(KEY, [...hooks(), hook]);
        return c.json(output(hook), 200);
      } catch (err) { return error(c, 400, err.message); }
    });
    app.get(`${ROOT}/:id`, c => {
      const hook = hooks().find(row => row.id === c.req.param("id"));
      return hook ? c.json(output(hook)) : error(c, 404, "Not found: event hook");
    });
    app.put(`${ROOT}/:id`, async c => {
      const hook = hooks().find(row => row.id === c.req.param("id"));
      if (!hook) return error(c, 404, "Not found: event hook");
      try {
        const replacement = makeHook(await c.req.json(), hook.createdBy);
        const changed = JSON.stringify(replacement.channel) !== JSON.stringify(hook.channel);
        Object.assign(hook, { name: replacement.name, description: replacement.description, events: replacement.events, channel: replacement.channel,
          lastUpdated: replacement.lastUpdated, verificationStatus: changed ? "UNVERIFIED" : hook.verificationStatus });
        return c.json(output(hook));
      } catch (err) { return error(c, 400, err.message); }
    });
    app.post(`${ROOT}/:id/lifecycle/:action`, async c => {
      const hook = hooks().find(row => row.id === c.req.param("id"));
      if (!hook) return error(c, 404, "Not found: event hook");
      const action = c.req.param("action");
      if (action === "verify") {
        if (hook.verificationStatus !== "VERIFIED") {
          const challenge = randomBytes(32).toString("base64url");
          const channel = hook.channel;
          try {
            const response = await (options.fetchImpl ?? fetch)(hook.channel.config.uri, { method: "GET", redirect: "manual",
              headers: { ...headersFor(hook), "x-okta-verification-challenge": challenge }, signal: AbortSignal.timeout(options.timeoutMs ?? 3000) });
            if (!response.ok || (await response.json()).verification !== challenge) throw new Error("Endpoint verification failed");
            if (!hooks().includes(hook) || hook.channel !== channel) throw new Error("Event hook changed during verification");
            hook.verificationStatus = "VERIFIED";
          } catch { return error(c, 400, "Event hook endpoint verification failed"); }
        }
      } else if (action === "activate") hook.status = "ACTIVE";
      else if (action === "deactivate") hook.status = "INACTIVE";
      else return error(c, 404, "Not found: event hook action");
      hook.lastUpdated = new Date().toISOString();
      return c.json(output(hook));
    });
    app.delete(`${ROOT}/:id`, c => {
      const hook = hooks().find(row => row.id === c.req.param("id"));
      if (!hook) return error(c, 404, "Not found: event hook");
      if (hook.status !== "INACTIVE") return error(c, 400, "Event hook must be INACTIVE before deletion");
      store.setData(KEY, hooks().filter(row => row !== hook));
      return c.body(null, 204);
    });
    function emit(c, eventType, targets) {
      const selected = hooks().filter(hook => hook.status === "ACTIVE" && hook.verificationStatus === "VERIFIED" && hook.events.items.includes(eventType));
      if (!selected.length) return;
      const now = new Date().toISOString(), requestId = randomUUID();
      const event = { uuid: randomUUID(), published: now, eventType, version: "0", displayMessage: MESSAGES[eventType], severity: "INFO",
        actor: actorFor(c), client: { userAgent: { rawUserAgent: c.req.header("user-agent") ?? null, os: null, browser: null }, zone: null, device: null, id: null, ipAddress: null, geographicalContext: null, ipChain: [] }, device: null, insertionTimestamp: null,
        outcome: { result: "SUCCESS", reason: null }, target: targets,
        transaction: { type: "WEB", id: requestId, detail: {} }, authenticationContext: { authenticationProvider: null, credentialProvider: null, credentialType: null, issuer: null, interface: null, authenticationStep: 0, externalSessionId: null },
        securityContext: { asNumber: null, asOrg: null, isp: null, domain: null, isProxy: null },
        debugContext: { debugData: { requestId, requestUri: c.req.path, url: c.req.path, eventHookIds: selected.map(hook => hook.id).join(",") } }, legacyEventType: null };
      for (const hook of selected) delivery.enqueue({ hook, hookId: hook.id, url: hook.channel.config.uri, headers: headersFor(hook),
        rawBody: JSON.stringify({ eventType: "com.okta.event_hook", eventTypeVersion: "1.0", cloudEventsVersion: "0.1", source: `${baseUrl}${ROOT}/${hook.id}`, eventId: randomUUID(), eventTime: now, contentType: "application/json", data: { events: [event] } }) });
    }
    app.use("*", async (c, next) => {
      if (!["POST", "PUT", "DELETE"].includes(c.req.method)) return next();
      const match = /^\/api\/v1\/(users|groups|apps)(?:\/([^/]+))?(?:\/(lifecycle|users)\/([^/]+))?$/.exec(c.req.path);
      if (!match) return next();
      const [, resource, rawRef, sub, rawAction] = match;
      const ref = rawRef && decodeURIComponent(rawRef), action = rawAction && decodeURIComponent(rawAction);
      const collection = os[resource];
      const find = id => resource === "users" ? userByRef(id) : collection.findOneBy("okta_id", id);
      const before = copy(ref && find(ref));
      const member = sub === "users" ? copy(userByRef(action)) : null;
      const memberships = resource === "groups" ? os.groupMemberships : os.appAssignments;
      const parentKey = resource === "groups" ? "group_okta_id" : "app_okta_id";
      const membershipBefore = member && before && memberships.all().some(row => row[parentKey] === before.okta_id && row.user_okta_id === member.okta_id);
      await next();
      const response = c.get("worldfixture.okta.response");
      if (!response?.ok) return;
      const result = response.headers.get("content-type")?.includes("application/json") ? await response.clone().json() : null;
      const after = copy(find(result?.id ?? ref));
      const kind = resource === "users" ? "User" : resource === "groups" ? "UserGroup" : "AppInstance";
      if (sub === "users" && member && before) {
        const exists = memberships.all().some(row => row[parentKey] === before.okta_id && row.user_okta_id === member.okta_id);
        if (Boolean(membershipBefore) !== exists) emit(c, `${resource === "groups" ? "group" : "application"}.user_membership.${exists ? "add" : "remove"}`, [target(member, "User"), target(before, kind)]);
      } else if (resource === "users") {
        if (!before && after && !ref) emit(c, "user.lifecycle.create", [target(after, kind)]);
        else if (before && !after) emit(c, "user.lifecycle.delete.initiated", [target(before, kind)]);
        else if (before && after) {
          if (before.status !== after.status) emit(c, `user.lifecycle.${sub === "lifecycle" ? action : "deactivate"}`, [target(after, kind)]);
          else if (!sub && ["POST", "PUT"].includes(c.req.method) && ["login", "email", "first_name", "last_name", "display_name", "locale", "time_zone"].some(key => before[key] !== after[key])) emit(c, "user.account.update_profile", [target(after, kind)]);
        }
      } else if (resource === "groups") {
        if (!before && after && !ref) emit(c, "group.lifecycle.create", [target(after, kind)]);
        else if (before && !after) emit(c, "group.lifecycle.delete", [target(before, kind)]);
        else if (before && after && ["name", "description", "type"].some(key => before[key] !== after[key])) emit(c, "group.profile.update", [target(after, kind)]);
      }
    });
    // The pinned core Context has no c.res. Capture the returned route Response,
    // including upstream routes that return a bare 204 Response.
    const upstreamApp = Object.create(app);
    upstreamApp.on = (method, path, ...handlers) => app.on(method, path, ...handlers.map(handler => async (c, next) => {
      const response = await handler(c, next);
      if (response instanceof Response) c.set("worldfixture.okta.response", response);
      return response;
    }));
    upstream.register(upstreamApp, store, webhooks, baseUrl, tokenMap, ...args);
  } };
}
