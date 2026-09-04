import { registerMcpRoutes } from "./mcp-current.mjs";
import { registerRestRoutes } from "./rest.mjs";
import { seedNotion } from "./domain.mjs";
import { registerOAuthRoutes } from "./oauth.mjs";
import { createNotionAdmin, registerNotionAdminRoutes } from "./admin.mjs";
import { registerAgentRoutes, seedNotionAgents } from "./agents.mjs";
import { registerAdminApiRoutes, seedNotionAdminApi } from "./admin-api.mjs";

export const plugin = {
  name: "notion",
  register(app, store, _webhooks, baseUrl, tokenMap) {
    const admin = createNotionAdmin(store);
    const options = { onChange: (change) => admin.captureChange(change) };
    registerRestRoutes(app, store, baseUrl, options);
    registerOAuthRoutes(app, store, baseUrl, tokenMap);
    registerAgentRoutes(app, store, baseUrl);
    registerAdminApiRoutes(app, store);
    registerMcpRoutes(app, store, baseUrl, options);
    registerNotionAdminRoutes(app, store, tokenMap, admin);
  },
};

export function seedFromConfig(store, baseUrl, config) {
  seedNotion(store, baseUrl, config);
  seedNotionAgents(store, config);
  seedNotionAdminApi(store, config);
}

export function fallback(config) {
  return { login: config?.users?.[0]?.email ?? "notion@worldfixture.test", id: 1, scopes: ["read:user", "read:content", "write:content", "read:comment", "insert:comment"] };
}
