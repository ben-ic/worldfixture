import { seedWorldGoogle } from "./world-google-seed.mjs";
import { seedWorldLinear } from "./world-linear-seed.mjs";

const PROVIDERS = new Set(["google", "linear"]);
export function usesWorldSeed(vendor, config, world) {
  if (!world || !PROVIDERS.has(vendor) || config?.worldfixture_seed_version === undefined) return false;
  if (config.worldfixture_seed_version !== 1) throw new Error(`Unsupported ${vendor} world seed version: ${config.worldfixture_seed_version}`);
  return true;
}

// Call only normal provider seed functions and public route handlers. On reset,
// the caller restores the accepted snapshot first; the helpers then verify it
// through the same APIs without applying the seed a second time.
export async function seedWorldProvider({ vendor, config, world, loaded, server, baseUrl, tokenReferences, arrivals = [], receipt }) {
  const seedFromConfig = seed => loaded.seedFromConfig(server.store, baseUrl, seed, server.webhooks);
  const fetchImpl = (url, init) => server.app.fetch(new Request(url, init));
  const token = reference => {
    const value = tokenReferences?.[reference];
    if (!value) throw new Error(`Missing ${vendor} world credential: ${reference}`);
    return value;
  };
  if (vendor === "google") {
    const tokensByPerson = Object.fromEntries(config.users.map(user =>
      [user.worldfixture_person_id, token(`google_token_${user.worldfixture_person_id}`)]));
    return seedWorldGoogle({ world, config, seedFromConfig, fetchImpl, baseUrl, tokensByPerson, receipt,
      arrivals: arrivals.filter(arrival => arrival.via === "gmail").map(arrival => ({
        worldfixture_owner_id: arrival.worldfixture_owner_id, user_email: arrival.user,
        label_ids: arrival.message?.labelIds ?? arrival.message?.label_ids ?? ["INBOX", "UNREAD"],
      })) });
  }
  if (vendor === "linear") {
    const credential = token("linear_token");
    return seedWorldLinear({ world, config, seedFromConfig, fetchImpl, baseUrl, token: credential,
      actorEmail: server.tokenMap.get(credential)?.login, receipt });
  }
  throw new Error(`No world seed implementation for ${vendor}`);
}

export const SEED_RECEIPT_PATH = "/_worldfixture/seed-receipt";
export function withSeedReceipt(handler, { receipt, tokenMap }) {
  return async request => {
    if (new URL(request.url).pathname !== SEED_RECEIPT_PATH) return handler(request);
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: { allow: "GET" } });
    const token = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
    if (!token || !tokenMap.has(token)) return Response.json({ error: "A current world token is required" }, { status: 401 });
    if (!receipt) return Response.json({ error: "This provider has no world seed receipt" }, { status: 404 });
    return Response.json(receipt, { headers: { "cache-control": "no-store" } });
  };
}
