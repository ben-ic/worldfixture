import { randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair, importJWK, SignJWT } from "jose";
import { getAppleStore } from "@emulators/apple";
import { createWebhookTransport } from "./transport.mjs";

const CONFIG = "worldfixture.apple.notifications";
const SIGNING = "worldfixture.apple.notification_key";
const TYPES = new Set(["email-enabled", "email-disabled", "consent-revoked", "account-deleted"]);
const keys = new WeakMap();
async function signingKey(store) {
  const saved = store.getData(SIGNING);
  if (saved) return { privateKey: await importJWK(saved, "RS256"), jwk: saved };
  const config = store.getData(CONFIG);
  if (!keys.has(store) || keys.get(store).config !== config) keys.set(store, { config, promise: (async () => {
    const pair = await generateKeyPair("RS256", { extractable: true });
    const jwk = { ...await exportJWK(pair.privateKey), kid: randomUUID(), use: "sig", alg: "RS256" };
    if (store.getData(CONFIG) === config) store.setData(SIGNING, jwk);
    return { privateKey: pair.privateKey, jwk };
  })() });
  return keys.get(store).promise;
}
export function seedAppleWebhooks(store, config) {
  const endpoints = config?.notifications ?? [];
  if (!Array.isArray(endpoints)) throw new Error("apple.notifications must be an array");
  const clients = new Set((config?.oauth_clients ?? []).map(client => client.client_id));
  for (const endpoint of endpoints) {
    if (!/^https?:$/.test(new URL(endpoint.url).protocol) || !clients.has(endpoint.client_id)) {
      throw new Error("Apple notifications require a URL and a declared client_id");
    }
  }
  store.setData(CONFIG, structuredClone(endpoints));
}

export function extendAppleWebhooksPlugin(upstream, options = {}) {
  return { ...upstream, register(app, store, webhooks, baseUrl, tokenMap) {
    const delivery = createWebhookTransport({ headers: () => ({ "content-type": "application/json;charset=UTF-8" }),
      isActive: item => store.getData(CONFIG) === item.config && item.config?.some(endpoint => endpoint.url === item.url && endpoint.client_id === item.clientId && endpoint.enabled !== false), ...options });
    webhooks.appleDelivery = delivery;
    app.use("/auth/keys", async (c, next) => {
      const { jwk } = await signingKey(store);
      const { kty, n, e, kid, use, alg } = jwk;
      const json = c.json;
      c.json = function(value, ...rest) { return json.call(this, { ...value, keys: [...value.keys, { kty, n, e, kid, use, alg }] }, ...rest); };
      try { await next(); } finally { c.json = json; }
    });
    // Account-owner actions have no public REST mutation endpoint at Apple.
    app.post("/__worldfixture/apple/account-events", async c => {
      if (!c.get("authUser")) return c.json({ error: "Authentication required" }, 401);
      const input = await c.req.json().catch(() => null);
      if (!TYPES.has(input?.type) || typeof input?.sub !== "string" || typeof input?.client_id !== "string") return c.json({ error: "type, sub, and client_id are required" }, 400);
      const as = getAppleStore(store);
      const user = as.users.findOneBy("uid", input.sub);
      if (!user || !as.oauthClients.findOneBy("client_id", input.client_id)) return c.json({ error: "User or client not found" }, 404);
      if (input.type.startsWith("email-") && !user.private_relay_email) return c.json({ error: "The user has no private relay email" }, 400);
      const config = store.getData(CONFIG);
      const now = Math.floor(Date.now() / 1000);
      const events = { type: input.type, sub: user.uid,
        ...(input.type.startsWith("email-") ? { email: user.private_relay_email, is_private_email: "true" } : {}), event_time: now };
      const { privateKey, jwk } = await signingKey(store);
      const jti = randomUUID();
      const payload = await new SignJWT({ events }).setProtectedHeader({ alg: "RS256", kid: jwk.kid })
        .setIssuer("https://appleid.apple.com").setAudience(input.client_id).setIssuedAt(now).setJti(jti).sign(privateKey);
      if (store.getData(CONFIG) !== config || as.users.get(user.id) !== user) return c.json({ error: "Account state changed during notification creation" }, 409);
      if (input.type.startsWith("email-")) as.users.update(user.id, { email_forwarding_enabled: input.type === "email-enabled" });
      else {
        for (const name of ["apple.oauth.pendingCodes", "apple.oauth.refreshTokens"]) {
          const map = store.getData(name);
          if (map instanceof Map) for (const [key, value] of map) {
            if (value.email === user.email && (input.type === "account-deleted" || value.clientId === input.client_id)) map.delete(key);
          }
        }
        if (input.type === "account-deleted") {
          as.users.delete(user.id);
          for (const [token, subject] of tokenMap ?? []) if (subject.login === user.email) tokenMap.delete(token);
        }
      }
      const rawBody = JSON.stringify({ payload });
      for (const endpoint of store.getData(CONFIG) ?? []) {
        if (endpoint.enabled === false || endpoint.client_id !== input.client_id) continue;
        delivery.enqueue({ rawBody, url: endpoint.url, clientId: input.client_id, config });
      }
      return c.json({ accepted: true, id: jti }, 202);
    });
    upstream.register(app, store, webhooks, baseUrl, tokenMap);
  } };
}
