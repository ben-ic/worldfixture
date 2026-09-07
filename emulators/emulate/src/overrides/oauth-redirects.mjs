import { createHash, timingSafeEqual } from "node:crypto";

const COLLECTIONS = {
  apple: ["apple.oauth_clients", ["client_id"]],
  clerk: ["clerk.oauth_apps", ["app_id", "client_id"]],
  okta: ["okta.oauth_clients", ["auth_server_id", "client_id"]],
  google: ["google.oauth_clients", ["client_id"]],
  microsoft: ["microsoft.oauth_clients", ["client_id"]],
  github: ["github.oauth_apps", ["client_id"]],
  slack: ["slack.oauth_apps", ["client_id"]],
  linear: ["linear.oauth_apps", ["client_id", "linear_id"]],
  vercel: ["vercel.integrations", ["client_id"]],
};

const digest = value => createHash("sha256").update(String(value ?? "")).digest();
const same = (left, right) => timingSafeEqual(digest(left), digest(right));
export const MAX_MATERIALIZED_REDIRECTS = 32;

export function validRedirectUri(value) {
  if (typeof value !== "string" || value.length > 2048 || value.includes("*") || /\s/.test(value)) return false;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && Boolean(url.hostname)
      && !url.hash && !url.username && !url.password;
  } catch { return false; }
}

export function validLoopbackTemplate(value) {
  if (!validRedirectUri(value)) return false;
  const url = new URL(value);
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && url.port === "";
}

export function redirectAllowed(client, requested, runtimeRedirects = new Set()) {
  if (client.redirect_uris.includes(requested) || runtimeRedirects.has(requested) || !validRedirectUri(requested)) {
    return client.redirect_uris.includes(requested) || runtimeRedirects.has(requested);
  }
  const actual = new URL(requested);
  if (actual.protocol !== "http:" || actual.port === "") return false;
  return (client.loopback_redirect_uris ?? []).some(value => {
    if (!validLoopbackTemplate(value)) return false;
    const expected = new URL(value);
    return actual.hostname === expected.hostname && actual.pathname === expected.pathname && actual.search === expected.search;
  });
}

export function materializeNativeRedirect(store, provider, stateKey, client, redirectUri) {
  if (client.redirect_uris.includes(redirectUri)) return;
  const [name, indexes] = COLLECTIONS[provider];
  const collection = store.collection(name, indexes);
  const native = collection.findOneBy("client_id", client.client_id);
  if (!native) throw new Error("Declared OAuth client is missing from the provider store");
  const cacheKey = `${stateKey}.materializedRedirects`;
  const cache = store.getData(cacheKey) ?? new Map();
  const current = cache.get(client.client_id) ?? [];
  const redirects = [...current.filter(value => value !== redirectUri), redirectUri];
  while (redirects.length > MAX_MATERIALIZED_REDIRECTS) redirects.shift();
  cache.set(client.client_id, redirects);
  store.setData(cacheKey, cache);
  collection.update(native.id, { redirect_uris: [...new Set([...client.redirect_uris, ...redirects])] });
}

export async function oauthRedirectControl(c, { store, provider, stateKey, controlToken }) {
  if (c.req.path !== "/__worldfixture/oauth/redirects") return null;
  if (c.req.method !== "POST") return c.json({ error: "method_not_allowed" }, 405);
  const header = c.req.header("authorization");
  if (!controlToken || typeof header !== "string" || !header.startsWith("Bearer ") || !same(header.slice(7), controlToken)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  let input;
  try {
    if (!c.req.header("content-type")?.includes("application/json")) throw new Error("JSON required");
    input = await c.req.json();
  } catch { return c.json({ error: "invalid_request" }, 400); }
  if (!input || typeof input !== "object" || Array.isArray(input)
    || !validRedirectUri(input.redirect_uri) || typeof input.client_id !== "string") {
    return c.json({ error: "invalid_request" }, 400);
  }
  const policy = store.getData(stateKey);
  const client = policy?.clients?.find(row => row.client_id === input.client_id);
  if (!client) return c.json({ error: "invalid_client" }, 404);
  if (client.allow_runtime_redirects !== true) return c.json({ error: "runtime_redirects_disabled" }, 403);
  const runtimeKey = `${stateKey}.runtimeRedirects`;
  const runtime = store.getData(runtimeKey) ?? new Map();
  const redirects = runtime.get(client.client_id) ?? new Set();
  if (!redirects.has(input.redirect_uri) && redirects.size >= 32) return c.json({ error: "redirect_limit_reached" }, 409);
  redirects.add(input.redirect_uri);
  runtime.set(client.client_id, redirects);
  store.setData(runtimeKey, runtime);
  materializeNativeRedirect(store, provider, stateKey, client, input.redirect_uri);
  return c.json({ ok: true, provider, client_id: client.client_id, redirect_uri: input.redirect_uri });
}
