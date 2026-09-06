import { createHmac, randomBytes } from "node:crypto";
import { getVercelStore } from "@emulators/vercel";
import { createWebhookTransport } from "./transport.mjs";

const KEY = "worldfixture.vercel.webhooks";
const EVENTS = new Set(["project.created", "project.removed", "project.renamed", "project.env-variable.created",
  "project.env-variable.updated", "project.env-variable.deleted", "project.domain.created", "deployment.created",
  "deployment.ready", "deployment.canceled", "deployment.error"]);
export function seedVercelWebhooks(store, config) {
  const endpoints = config?.webhooks ?? [];
  if (!Array.isArray(endpoints)) throw new Error("vercel.webhooks must be an array");
  for (const endpoint of endpoints) {
    if (!/^https?:$/.test(new URL(endpoint.url).protocol) || !endpoint.secret || !endpoint.owner_id
      || !Array.isArray(endpoint.events) || !endpoint.events.length || endpoint.events.some(event => !EVENTS.has(event))) {
      throw new Error("Vercel webhooks require url, secret, owner_id, and supported events");
    }
  }
  store.setData(KEY, structuredClone(endpoints));
}
export function extendVercelWebhooksPlugin(upstream, options = {}) {
  return { ...upstream, register(app, store, webhooks, ...args) {
    const vs = getVercelStore(store);
    // Vercel specifies exponential backoff up to 24 h, without fixed intervals.
    const delivery = createWebhookTransport({ timeoutMs: 30_000,
      retryDelays: [60_000, 300_000, 900_000, 3_600_000, 10_800_000, 21_600_000, 43_200_000],
      headers: item => ({ "content-type": "application/json", "x-vercel-signature": createHmac("sha1", item.secret).update(item.rawBody).digest("hex") }),
      isActive: item => Date.now() < item.expiresAt && store.getData(KEY) === item.config && item.config?.some(endpoint => endpoint.url === item.url && endpoint.owner_id === item.ownerId && endpoint.enabled !== false),
      ...options });
    webhooks.vercelDelivery = delivery;
    function emit(type, payload, ownerId, projectId) {
      const createdAt = Date.now();
      const rawBody = JSON.stringify({ id: randomBytes(20).toString("base64url"), type, createdAt, region: null, payload });
      for (const endpoint of store.getData(KEY) ?? []) {
        if (endpoint.enabled === false || endpoint.owner_id !== ownerId || !endpoint.events.includes(type)) continue;
        if (endpoint.project_ids?.length && (["project.created", "project.removed", "project.renamed"].includes(type) || !endpoint.project_ids.includes(projectId))) continue;
        delivery.enqueue({ url: endpoint.url, ownerId, rawBody, secret: endpoint.secret, config: store.getData(KEY), expiresAt: createdAt + 86_400_000 });
      }
    }
    app.use("*", async (c, next) => {
      if (!["POST", "PATCH", "DELETE"].includes(c.req.method) || !store.getData(KEY)?.length) return next();
      const config = store.getData(KEY);
      const user = vs.users.findOneBy("username", c.get("authUser")?.login);
      const team = c.req.query("teamId") ? vs.teams.findOneBy("uid", c.req.query("teamId"))
        : c.req.query("slug") ? vs.teams.findOneBy("slug", c.req.query("slug")) : null;
      const ownerId = team?.uid ?? user?.uid;
      if (!ownerId || !user) return next();
      const path = c.req.path;
      const projectMatch = /^\/v\d+\/projects\/([^/]+)(?:\/(env|domains)(?:\/([^/]+))?)?$/.exec(path);
      const projectRef = projectMatch && decodeURIComponent(projectMatch[1]);
      const oldProject = projectRef ? vs.projects.all().find(item => item.accountId === ownerId && [item.uid, item.name].includes(projectRef)) : null;
      const previous = oldProject ? structuredClone(oldProject) : null;
      const previousEnvIds = projectMatch?.[2] === "env" && previous
        ? new Set(vs.envVars.findBy("projectId", previous.uid).map(row => row.uid)) : null;
      const previousProjectIds = c.req.method === "POST" && /^\/v\d+\/deployments$/.test(path)
        ? new Set(vs.projects.all().map(project => project.uid)) : null;
      const json = c.json, body = c.body;
      let result, success = false;
      c.json = function(data, ...rest) {
        const response = json.call(this, data, ...rest);
        if (response.ok && !data?.error) { success = true; result = structuredClone(data); }
        return response;
      };
      c.body = function(data, ...rest) {
        const response = body.call(this, data, ...rest);
        if (response.ok) success = true;
        return response;
      };
      try { await next(); } finally { c.json = json; c.body = body; }
      if (!success || store.getData(KEY) !== config) return;
      const identity = { team: { id: team?.uid ?? null }, user: { id: user.uid } };
      if (c.req.method === "POST" && /^\/v\d+\/projects$/.test(path) && result?.id) {
        emit("project.created", { ...identity, project: { id: result.id, name: result.name } }, ownerId, result.id);
      } else if (projectMatch && previous) {
        const id = previous.uid;
        if (!projectMatch[2]) {
          if (c.req.method === "DELETE") emit("project.removed", { ...identity, project: { id, name: previous.name } }, ownerId, id);
          else if (c.req.method === "PATCH" && result?.name !== previous.name) emit("project.renamed", { ...identity, project: { id, name: result.name }, previousName: previous.name }, ownerId, id);
        } else if (projectMatch[2] === "env") {
          const rows = result?.envs ?? [result];
          for (const row of rows) {
            const envVarId = row?.id ?? projectMatch[3];
            const action = c.req.method === "POST" ? (previousEnvIds.has(envVarId) ? "updated" : "created")
              : { PATCH: "updated", DELETE: "deleted" }[c.req.method];
            if (envVarId) emit(`project.env-variable.${action}`, { ...identity, projectId: id, envVarId }, ownerId, id);
            previousEnvIds.add(envVarId);
          }
        } else if (projectMatch[2] === "domains" && c.req.method === "POST") {
          const origin = result.name.endsWith(".vercel.app") ? (result.redirect ? "default-redirect" : "default-stable") : "custom";
          emit("project.domain.created", { ...identity, project: { id }, domain: { name: result.name,
            classification: { target: result.gitBranch ? "preview" : "production", origin } } }, ownerId, id);
        }
      } else if (result?.id && /^\/v\d+\/deployments(?:\/[^/]+\/cancel)?$/.test(path)) {
        const dep = vs.deployments.findOneBy("uid", result.id);
        const project = dep && vs.projects.findOneBy("uid", dep.projectId);
        if (!dep || project?.accountId !== ownerId) return;
        if (previousProjectIds && !previousProjectIds.has(project.uid)) {
          emit("project.created", { ...identity, project: { id: project.uid, name: project.name } }, ownerId, project.uid);
        }
        const scopeSlug = team?.slug ?? user.username;
        const payload = { ...identity, deployment: { id: dep.uid, meta: dep.meta, url: dep.url, name: dep.name },
          links: { deployment: `https://vercel.com/${scopeSlug}/${project.name}/${dep.uid.replace(/^dpl_/, "")}`, project: `https://vercel.com/${scopeSlug}/${project.name}` },
          target: dep.target === "preview" ? null : dep.target, project: { id: project.uid }, plan: dep.plan, regions: dep.regions };
        if (c.req.method === "POST") {
          emit("deployment.created", { ...payload, alias: result.alias ?? [] }, ownerId, project.uid);
          if (dep.readyState === "READY") {
            emit("deployment.ready", payload, ownerId, project.uid);
          } else if (dep.readyState === "ERROR") emit("deployment.error", payload, ownerId, project.uid);
        } else if (dep.readyState === "CANCELED") emit("deployment.canceled", payload, ownerId, project.uid);
      }
    });
    upstream.register(app, store, webhooks, ...args);
  } };
}
