import { createHash, randomUUID } from "node:crypto";
import { getMicrosoftStore } from "@emulators/microsoft";
import { createWebhookTransport } from "./transport.mjs";

const CONFIG = "worldfixture.microsoft.webhook_config";
const SUBSCRIPTIONS = "worldfixture.microsoft.subscriptions";
const DELETED = "worldfixture.microsoft.deleted_users";
const TOKENS = "worldfixture.microsoft.webhook_token_clients";
const READ = ["User.Read.All", "User.ReadWrite.All", "Directory.Read.All", "Directory.ReadWrite.All"];
const WRITE = ["User.ReadWrite.All", "Directory.ReadWrite.All"];
const MIN_LIFETIME = 45 * 60_000;
const MAX_LIFETIME = 41_760 * 60_000;
const subscriptions = store => store.collection(SUBSCRIPTIONS, ["subscription_id"]);
const deletedUsers = store => store.collection(DELETED, ["oid"]);
const config = store => store.getData(CONFIG) ?? {};
const enabled = store => config(store).live_delivery === true || process.env.WORLDFIXTURE_MICROSOFT_WEBHOOK_DELIVERY === "1";
const digest = token => createHash("sha256").update(token ?? "").digest("hex");
const error = (c, status, message, code = "InvalidRequest") => c.json({ error: { code, message } }, status);
const publicSubscription = row => ({ id: row.subscription_id, resource: row.resource, applicationId: row.application_id,
  changeType: row.change_type, clientState: row.client_state, notificationUrl: row.notification_url,
  expirationDateTime: row.expiration_date_time, creatorId: row.creator_id, latestSupportedTlsVersion: "v1_2",
  notificationContentType: "application/json" });
const graphUser = row => ({ id: row.oid, displayName: row.name, givenName: row.given_name, surname: row.family_name,
  mail: row.email, userPrincipalName: row.preferred_username });
const fieldMap = { displayName: "name", givenName: "given_name", surname: "family_name", mail: "email", userPrincipalName: "preferred_username" };

export function wrapMicrosoftWebhooks(upstream, upstreamSeed, { now = Date.now, ...options } = {}) {
  return {
    plugin: { ...upstream, register(app, store, webhooks, ...args) {
      const ms = getMicrosoftStore(store);
      const active = row => row && Date.parse(row.expiration_date_time) > now();
      const transport = createWebhookTransport({ retryDelays: [1000, 2000, 4000, 8000, 16000], timeoutMs: 10_000,
        headers: () => ({ "Content-Type": "application/json" }),
        accepted: response => response.status >= 200 && response.status < 300,
        shouldRetry: () => true,
        isActive: delivery => {
          const row = subscriptions(store).findOneBy("subscription_id", delivery.subscriptionId);
          return enabled(store) && active(row) && row.generation === delivery.generation;
        }, ...options });
      webhooks.microsoftDelivery = transport;
      // Retain the OAuth application identity across token rotation.
      app.use("/oauth2/v2.0/token", async (c, next) => {
        const copy = c.req.raw.clone();
        const body = copy.headers.get("content-type")?.includes("application/json")
          ? await copy.json().catch(() => ({})) : Object.fromEntries(new URLSearchParams(await copy.text()));
        let clientId = body.client_id;
        if (!clientId && c.req.header("authorization")?.startsWith("Basic ")) {
          clientId = decodeURIComponent(Buffer.from(c.req.header("authorization").slice(6), "base64").toString().split(":")[0]);
        }
        const json = c.json;
        c.json = function (value, ...rest) {
          if (value?.access_token && clientId) store.setData(TOKENS, { ...(store.getData(TOKENS) ?? {}),
            [digest(value.access_token)]: { client_id: clientId, grant_type: body.grant_type } });
          return json.call(this, value, ...rest);
        };
        try { await next(); } finally { c.json = json; }
      });
      function actor(c, scopes) {
        const auth = c.get("authUser");
        if (!auth) return { response: error(c, 401, "Authentication required.", "InvalidAuthenticationToken") };
        if (!auth.scopes?.some(scope => scopes.includes(scope))) return { response: error(c, 403, "Insufficient privileges to complete the operation.", "Authorization_RequestDenied") };
        const identity = (store.getData(TOKENS) ?? {})[digest(c.get("authToken"))];
        const clientId = (typeof identity === "string" ? identity : identity?.client_id) ?? auth.client_id ?? "fixture";
        // An application token has no signed-in user, even when its client ID
        // happens to match a directory user's email address.
        const user = identity?.grant_type === "client_credentials" ? null : ms.users.findOneBy("email", auth.login);
        const client = ms.oauthClients.findOneBy("client_id", clientId);
        const tenantId = user?.tenant_id ?? client?.tenant_id ?? auth.tenant_id;
        if (!tenantId) return { response: error(c, 403, "The token has no local tenant.", "Authorization_RequestDenied") };
        return { tenantId, clientId, creatorId: user?.oid ?? String(auth.id), owner: `${tenantId}:${clientId}:${user?.oid ?? auth.id}` };
      }
      function expire() {
        for (const row of subscriptions(store).all()) if (!active(row)) subscriptions(store).delete(row.id);
      }
      function expiration(value) {
        const time = typeof value === "string" && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
        if (!Number.isFinite(time) || time > now() + MAX_LIFETIME) return null;
        return new Date(Math.max(time, now() + MIN_LIFETIME)).toISOString();
      }
      function validUrl(value) {
        try {
          const url = new URL(value);
          return !url.username && !url.password && !url.hash && (url.protocol === "https:" || url.protocol === "http:" && config(store).allow_insecure_http === true);
        } catch { return false; }
      }
      async function validateEndpoint(url) {
        if (!enabled(store)) return true;
        const token = `Validation: ${randomUUID()}`;
        const endpoint = new URL(url);
        endpoint.searchParams.set("validationToken", token);
        try {
          const response = await (options.fetchImpl ?? fetch)(endpoint, { method: "POST", redirect: "manual",
            headers: { "Content-Type": "text/plain; charset=utf-8" }, body: "", signal: AbortSignal.timeout(10_000) });
          const returned = await response.text();
          return response.status === 200 && /^text\/plain(?:;|$)/i.test(response.headers.get("content-type") ?? "") && returned === token;
        } catch { return false; }
      }
      function notify(user, changeType) {
        expire();
        for (const row of subscriptions(store).all()) {
          if (row.tenant_id !== user.tenant_id || !row.change_type.split(",").includes(changeType)) continue;
          const resource = `users/${user.oid}`;
          const rawBody = JSON.stringify({ value: [{ id: randomUUID(), subscriptionId: row.subscription_id,
            subscriptionExpirationDateTime: row.expiration_date_time, changeType, resource, clientState: row.client_state,
            tenantId: row.tenant_id, resourceData: { "@odata.type": "#microsoft.graph.user", "@odata.id": resource, id: user.oid } }] });
          const input = { subscriptionId: row.subscription_id, generation: row.generation, url: row.notification_url, rawBody };
          if (enabled(store)) transport.enqueue(input);
          else {
            transport.deliveries.push({ ...input, attempts: 0, status: "captured" });
            if (transport.deliveries.length > 1000) transport.deliveries.shift();
          }
        }
      }
      app.post("/v1.0/subscriptions", async c => {
        const auth = actor(c, READ); if (auth.response) return auth.response;
        const body = await c.req.json().catch(() => null);
        if (!body || !["users", "/users"].includes(body.resource)) return error(c, 400, "Only the users resource is supported.");
        if (body.includeResourceData || body.lifecycleNotificationUrl || body.notificationQueryOptions) return error(c, 400, "Rich, lifecycle, and query notifications are not supported.");
        if (body.notificationUrlAppId != null || body.encryptionCertificate != null || body.encryptionCertificateId != null ||
            body.latestSupportedTlsVersion != null && body.latestSupportedTlsVersion !== "v1_2") return error(c, 400, "Custom validation tokens, encryption, and non-default TLS versions are not supported.");
        const types = typeof body.changeType === "string" ? body.changeType.split(",").map(value => value.trim()) : [];
        if (!types.length || types.some(value => !["updated", "deleted"].includes(value)) || new Set(types).size !== types.length) return error(c, 400, "User subscriptions support updated and deleted changeType values.");
        if (body.clientState !== undefined && (typeof body.clientState !== "string" || body.clientState.length > 128)) return error(c, 400, "clientState must contain at most 128 characters.");
        const until = expiration(body.expirationDateTime);
        if (!until || !validUrl(body.notificationUrl)) return error(c, 400, "Invalid expirationDateTime or notificationUrl.");
        expire();
        const changeType = types.sort().join(",");
        const duplicate = () => subscriptions(store).all().find(row => row.owner === auth.owner && row.change_type === changeType);
        if (duplicate()) return error(c, 409, `Subscription Id ${duplicate().subscription_id} already exists for the requested combination`, "Conflict");
        if (!await validateEndpoint(body.notificationUrl)) return error(c, 400, "Notification endpoint must respond with 200, text/plain, and the validation token.", "ValidationError");
        if (duplicate()) return error(c, 409, "Subscription already exists for the requested combination.", "Conflict");
        const row = subscriptions(store).insert({ subscription_id: randomUUID(), generation: randomUUID(), owner: auth.owner,
          tenant_id: auth.tenantId, application_id: auth.clientId, creator_id: auth.creatorId, resource: "users",
          change_type: changeType, client_state: body.clientState ?? null, notification_url: body.notificationUrl, expiration_date_time: until });
        return c.json(publicSubscription(row), 201);
      });
      app.get("/v1.0/subscriptions", c => {
        const auth = actor(c, READ); if (auth.response) return auth.response;
        if (new URL(c.req.url).search) return error(c, 400, "Subscription query options are not supported.");
        expire();
        return c.json({ "@odata.context": "https://graph.microsoft.com/v1.0/$metadata#subscriptions",
          value: subscriptions(store).all().filter(row => row.owner === auth.owner)
            .map(row => ({ ...publicSubscription(row), clientState: null })) });
      });
      for (const method of ["get", "patch", "delete"]) app[method]("/v1.0/subscriptions/:id", async c => {
        const auth = actor(c, READ); if (auth.response) return auth.response;
        expire();
        const row = subscriptions(store).findOneBy("subscription_id", c.req.param("id"));
        if (!row || row.owner !== auth.owner) return error(c, 404, "Subscription not found.", "ResourceNotFound");
        if (method === "get") return c.json(publicSubscription(row));
        if (method === "delete") { subscriptions(store).delete(row.id); return c.body(null, 204); }
        const body = await c.req.json().catch(() => null);
        if (!body || !Object.keys(body).length || Object.keys(body).some(key => !["expirationDateTime", "notificationUrl"].includes(key))) return error(c, 400, "Only expirationDateTime and notificationUrl can be updated.");
        const until = body.expirationDateTime === undefined ? row.expiration_date_time : expiration(body.expirationDateTime);
        if (!until || body.notificationUrl !== undefined && !validUrl(body.notificationUrl)) return error(c, 400, "Invalid expirationDateTime or notificationUrl.");
        if (body.notificationUrl !== undefined && !await validateEndpoint(body.notificationUrl)) return error(c, 400, "Notification endpoint validation failed.", "ValidationError");
        if (!subscriptions(store).get(row.id) || !active(row)) return error(c, 404, "Subscription not found.", "ResourceNotFound");
        const updated = subscriptions(store).update(row.id, { expiration_date_time: until,
          notification_url: body.notificationUrl ?? row.notification_url,
          ...(body.notificationUrl !== undefined ? { generation: randomUUID() } : {}) });
        return c.json(publicSubscription(updated));
      });
      app.post("/v1.0/users", async c => {
        const auth = actor(c, WRITE); if (auth.response) return auth.response;
        const body = await c.req.json().catch(() => null);
        const supported = [...Object.keys(fieldMap), "accountEnabled", "mailNickname", "passwordProfile"];
        if (!body || Object.keys(body).some(key => !supported.includes(key)) ||
            ["displayName", "userPrincipalName", "mailNickname"].some(key => typeof body[key] !== "string" || !body[key]) ||
            typeof body.accountEnabled !== "boolean" || typeof body.passwordProfile?.password !== "string" || !body.passwordProfile.password) return error(c, 400, "Required user fields are missing, or a field is not supported.", "Request_BadRequest");
        if (Object.keys(fieldMap).some(key => body[key] !== undefined && typeof body[key] !== "string")) return error(c, 400, "User fields must be strings.", "Request_BadRequest");
        if (ms.users.all().some(row => row.tenant_id === auth.tenantId && row.preferred_username.toLowerCase() === body.userPrincipalName.toLowerCase())) return error(c, 400, "userPrincipalName already exists.", "Request_BadRequest");
        const user = ms.users.insert({ oid: randomUUID(), tenant_id: auth.tenantId, name: body.displayName,
          email: body.mail ?? body.userPrincipalName, preferred_username: body.userPrincipalName,
          given_name: body.givenName ?? "", family_name: body.surname ?? "", email_verified: true,
          account_enabled: body.accountEnabled, mail_nickname: body.mailNickname });
        notify(user, "updated");
        return c.json(graphUser(user), 201);
      });
      app.patch("/v1.0/users/:id", async c => {
        const auth = actor(c, WRITE); if (auth.response) return auth.response;
        const user = ms.users.all().find(row => row.tenant_id === auth.tenantId && [row.oid, row.preferred_username].includes(c.req.param("id")));
        if (!user) return error(c, 404, "User not found.", "Request_ResourceNotFound");
        const body = await c.req.json().catch(() => null);
        if (!body || !Object.keys(body).length || Object.keys(body).some(key => !fieldMap[key] || typeof body[key] !== "string")) return error(c, 400, "Only basic string user properties can be updated.", "Request_BadRequest");
        if (body.userPrincipalName && ms.users.all().some(row => row.id !== user.id && row.tenant_id === auth.tenantId && row.preferred_username.toLowerCase() === body.userPrincipalName.toLowerCase())) return error(c, 400, "userPrincipalName already exists.", "Request_BadRequest");
        const patch = Object.fromEntries(Object.entries(body).map(([key, value]) => [fieldMap[key], value]));
        const changed = Object.entries(patch).some(([key, value]) => user[key] !== value);
        const updated = ms.users.update(user.id, patch);
        if (changed) notify(updated, "updated");
        return c.body(null, 204);
      });
      app.delete("/v1.0/users/:id", c => {
        const auth = actor(c, WRITE); if (auth.response) return auth.response;
        const user = ms.users.all().find(row => row.tenant_id === auth.tenantId && [row.oid, row.preferred_username].includes(c.req.param("id")));
        if (!user) return error(c, 404, "User not found.", "Request_ResourceNotFound");
        deletedUsers(store).insert({ ...user, deleted_date_time: new Date(now()).toISOString() });
        ms.users.delete(user.id);
        notify(user, "updated");
        return c.body(null, 204);
      });
      app.delete("/v1.0/directory/deletedItems/:id", c => {
        const auth = actor(c, WRITE); if (auth.response) return auth.response;
        const user = deletedUsers(store).findOneBy("oid", c.req.param("id"));
        if (!user || user.tenant_id !== auth.tenantId) return error(c, 404, "Deleted user not found.", "Request_ResourceNotFound");
        deletedUsers(store).delete(user.id);
        notify(user, "deleted");
        return c.body(null, 204);
      });
      upstream.register(app, store, webhooks, ...args);
    } },
    seedFromConfig(store, baseUrl, input = {}, ...args) {
      store.setData(CONFIG, input.webhooks ?? {});
      upstreamSeed(store, baseUrl, input, ...args);
    },
  };
}
