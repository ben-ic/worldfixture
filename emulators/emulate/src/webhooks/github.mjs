import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, randomUUID } from "node:crypto";
import { getGitHubStore } from "@emulators/github";

const nodeId = (type, id) => Buffer.from(`0:${type}${id}`).toString("base64").replace(/=+$/, "");
const includes = (events, event) => Array.isArray(events) && (events.includes("*") || events.includes(event));
const zeroSha = "0".repeat(40);

function repositoryOwner(owner, baseUrl) {
  if (owner?.type !== "Organization") return owner;
  const url = `${baseUrl}/users/${owner.login}`;
  return { login: owner.login, id: owner.id, node_id: owner.node_id, avatar_url: owner.avatar_url,
    gravatar_id: "", url, html_url: `${baseUrl}/${owner.login}`, followers_url: `${url}/followers`,
    following_url: `${url}/following{/other_user}`, gists_url: `${url}/gists{/gist_id}`,
    starred_url: `${url}/starred{/owner}{/repo}`, subscriptions_url: `${url}/subscriptions`,
    organizations_url: `${url}/orgs`, repos_url: `${url}/repos`, events_url: `${url}/events{/privacy}`,
    received_events_url: `${url}/received_events`, type: "Organization", site_admin: false, user_view_type: "public" };
}

function pushPayload(payload, gh, repo, baseUrl, forced) {
  const commits = gh.commits.findBy("repo_id", repo.id);
  const bySha = new Map(commits.map(row => [row.sha, row]));
  function ancestors(sha, found = new Set()) {
    if (found.has(sha) || !bySha.has(sha)) return found;
    found.add(sha);
    for (const parent of bySha.get(sha).parent_shas ?? []) ancestors(parent, found);
    return found;
  }
  function files(treeSha, prefix = "", seen = new Set()) {
    const result = new Map();
    if (seen.has(treeSha)) return result;
    seen = new Set(seen).add(treeSha);
    const tree = gh.trees.findBy("repo_id", repo.id).find(row => row.sha === treeSha);
    for (const entry of tree?.tree ?? []) {
      const path = `${prefix}${entry.path}`;
      if (entry.type === "tree") for (const [name, value] of files(entry.sha, `${path}/`, seen)) result.set(name, value);
      else result.set(path, `${entry.mode}:${entry.sha}`);
    }
    return result;
  }
  function formatCommit(row) {
    const before = files(bySha.get(row.parent_shas?.[0])?.tree_sha), after = files(row.tree_sha);
    return { id: row.sha, tree_id: row.tree_sha, distinct: true, message: row.message,
      timestamp: row.committer_date, url: `${baseUrl}/${repo.full_name}/commit/${row.sha}`,
      author: { name: row.author_name, email: row.author_email },
      committer: { name: row.committer_name, email: row.committer_email },
      added: [...after.keys()].filter(path => !before.has(path)),
      removed: [...before.keys()].filter(path => !after.has(path)),
      modified: [...after.keys()].filter(path => before.has(path) && before.get(path) !== after.get(path)) };
  }
  const previous = ancestors(payload.before), current = ancestors(payload.after);
  const pushed = [...current].reverse().filter(sha => !previous.has(sha));
  const actor = gh.users.get(payload.sender?.id);
  return { ...payload, created: payload.before === zeroSha, deleted: payload.after === zeroSha,
    forced: Boolean(forced && payload.before !== zeroSha && !current.has(payload.before)), base_ref: null,
    compare: `${baseUrl}/${repo.full_name}/compare/${payload.before}...${payload.after}`,
    commits: pushed.slice(0, 2048).map(sha => formatCommit(bySha.get(sha))),
    head_commit: bySha.has(payload.after) ? formatCommit(bySha.get(payload.after)) : null,
    pusher: { name: payload.sender?.login ?? actor?.login ?? "ghost", email: actor?.email ?? null } };
}

function organization(row, baseUrl) {
  const url = `${baseUrl}/orgs/${row.login}`;
  return { login: row.login, id: row.id, node_id: row.node_id ?? nodeId("Organization", row.id),
    url, repos_url: `${url}/repos`, events_url: `${url}/events`, hooks_url: `${url}/hooks`,
    issues_url: `${url}/issues`, members_url: `${url}/members{/member}`,
    public_members_url: `${url}/public_members{/member}`, avatar_url: row.avatar_url ?? `${baseUrl}/avatars/o/${row.login}`, description: row.description ?? null };
}

function nativeHeaders(delivery, secret) {
  const headers = { "Content-Type": delivery.contentType, "User-Agent": "GitHub-Hookshot/worldfixture",
    "X-GitHub-Event": delivery.event, "X-GitHub-Delivery": delivery.guid,
    "X-GitHub-Hook-ID": String(delivery.hook_id),
    "X-GitHub-Hook-Installation-Target-ID": String(delivery.targetId),
    "X-GitHub-Hook-Installation-Target-Type": delivery.targetType };
  if (secret) {
    headers["X-Hub-Signature"] = `sha1=${createHmac("sha1", secret).update(delivery.rawBody).digest("hex")}`;
    headers["X-Hub-Signature-256"] = `sha256=${createHmac("sha256", secret).update(delivery.rawBody).digest("hex")}`;
  }
  return headers;
}

function publicDelivery(row, detail = false) {
  const value = { id: row.id, guid: row.guid, delivered_at: row.delivered_at, redelivery: row.redelivery,
    duration: row.duration == null ? null : row.duration / 1000, status: row.success ? "OK" : "Failed",
    status_code: row.status_code, event: row.event, action: row.action ?? null,
    installation_id: row.payload.installation?.id ?? null, repository_id: row.payload.repository?.id ?? null,
    url: row.url, throttled_at: null };
  if (detail) {
    value.request = { headers: row.requestHeaders, payload: row.payload };
    value.response = { headers: row.responseHeaders ?? {}, payload: row.responseBody ?? "" };
  }
  return value;
}

export function extendGitHubWebhooksPlugin(upstream, options = {}) {
  return { ...upstream, register(app, store, webhooks, baseUrl, ...args) {
    const gh = getGitHubStore(store), requestContext = new AsyncLocalStorage();
    const records = store.collection("github.webhook_deliveries");
    const pushes = store.collection("github.webhook_pushes");
    const pending = new Set(), controllers = new Set();
    let generation = 0;

    function sourceFor(delivery) {
      if (delivery.appId != null) {
        const integration = gh.apps.all().find(row => row.app_id === delivery.appId);
        const installation = gh.appInstallations.all().find(row => row.installation_id === delivery.payload.installation?.id);
        if (!integration?.webhook_url || !installation || installation.suspended_at) return null;
        return { url: integration.webhook_url, secret: integration.webhook_secret };
      }
      const hook = gh.webhooks.get(delivery.hook_id);
      return hook?.active ? hook.config : null;
    }

    async function send(delivery, token) {
      const config = sourceFor(delivery);
      if (!config || token !== generation) return;
      const controller = new AbortController(); controllers.add(controller);
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000); timeout.unref?.();
      const started = Date.now();
      delivery.url = config.url;
      delivery.requestHeaders = nativeHeaders(delivery, config.secret);
      try {
        const response = await fetch(config.url, { method: "POST", redirect: "manual", body: delivery.rawBody,
          headers: delivery.requestHeaders, signal: controller.signal });
        delivery.status_code = response.status; delivery.success = response.ok;
        delivery.responseHeaders = Object.fromEntries(response.headers);
        // Retain a bounded response body for the native delivery detail endpoint.
        const chunks = []; let size = 0;
        const reader = response.body?.getReader();
        if (reader) {
          while (size < 64 * 1024) {
            const { done, value } = await reader.read(); if (done) break;
            const part = value.subarray(0, 64 * 1024 - size); chunks.push(part); size += part.length;
          }
          await reader.cancel();
        }
        delivery.responseBody = Buffer.concat(chunks).toString("utf8");
      } catch { delivery.success = false; /* GitHub does not automatically retry failed deliveries. */ }
      finally { clearTimeout(timeout); controllers.delete(controller); }
      if (token !== generation) return;
      delivery.duration = Date.now() - started;
      const saved = records.get(delivery.id);
      if (saved) records.update(delivery.id, delivery);
      if (delivery.appId == null && gh.webhooks.get(delivery.hook_id)) {
        gh.webhooks.update(delivery.hook_id, { last_response: { code: delivery.status_code,
          status: delivery.success ? "active" : "failed", message: delivery.success ? "OK" : "Delivery failed" } });
      }
    }

    function enqueue(input) {
      const payload = structuredClone(input.payload);
      const rawJson = JSON.stringify(payload);
      const form = input.contentType === "application/x-www-form-urlencoded";
      const delivery = records.insert({ ...input, payload, rawBody: form ? new URLSearchParams({ payload: rawJson }).toString() : rawJson,
        guid: input.guid ?? randomUUID(), redelivery: input.redelivery ?? false,
        delivered_at: new Date().toISOString(), duration: null, status_code: null, success: false });
      const work = send(delivery, generation); pending.add(work); work.finally(() => pending.delete(work));
      return delivery;
    }

    webhooks.flushGitHubWebhooks = async () => { while (pending.size) await Promise.all([...pending]); };
    webhooks.closeGitHubWebhooks = () => { generation++; for (const controller of controllers) controller.abort(); };
    const clear = webhooks.clear.bind(webhooks);
    webhooks.clear = () => { webhooks.closeGitHubWebhooks(); records.clear(); pushes.clear(); clear(); };
    webhooks.getDeliveries = hookId => records.all().filter(row => row.appId == null && (hookId === undefined || row.hook_id === hookId));

    app.use("*", async (c, next) => {
      const target = c.req.path.match(/\/hooks\/(\d+)\/(?:pings|tests)$/);
      const hookCreation = c.req.method === "POST" && /^(?:\/repos\/[^/]+\/[^/]+|\/orgs\/[^/]+)\/hooks$/.test(c.req.path);
      const hookUpdate = c.req.method === "PATCH" && /\/hooks\/\d+$/.test(c.req.path);
      if (hookCreation || hookUpdate) {
        let body;
        try { body = await c.req.raw.clone().json(); } catch { return c.json({ message: "Invalid JSON" }, 400); }
        if (body.config?.content_type !== undefined && !["json", "form"].includes(body.config.content_type)) return c.json({ message: "Invalid content_type" }, 422);
        if (body.config?.url !== undefined) {
          try { if (!["http:", "https:"].includes(new URL(body.config.url).protocol)) throw new Error(); }
          catch { return c.json({ message: "Invalid webhook URL" }, 422); }
        }
      }
      const json = c.json;
      let created;
      c.json = function(value, ...rest) {
        if (hookCreation && value?.id && !value.message) created = structuredClone(value);
        if (c.req.method === "GET" && /\/hooks\/\d+\/deliveries(?:\/\d+)?$/.test(c.req.path)) {
          const transform = item => { const row = records.get(item?.id); return row ? publicDelivery(row, !Array.isArray(value)) : item; };
          value = Array.isArray(value) ? value.map(transform) : transform(value);
        }
        return json.call(this, value, ...rest);
      };
      let forced;
      if (c.req.method === "PATCH" && /\/git\/refs\//.test(c.req.path)) {
        try { forced = (await c.req.raw.clone().json()).force === true; } catch { /* The route reports invalid JSON. */ }
      }
      const context = { targetHookId: target ? Number(target[1]) : null, testPush: Boolean(target && c.req.path.endsWith("/tests")),
        forced, headers: { authorization: c.req.header("Authorization") ?? "" } };
      try {
        await requestContext.run(context, async () => {
          await next();
          if (created?.active) {
            const hook = gh.webhooks.get(created.id);
            const repo = gh.repos.get(hook.repo_id), org = gh.orgs.get(hook.org_id);
            const owner = repo ? repo.full_name.split("/")[0] : org.login;
            context.targetHookId = created.id;
            await webhooks.dispatch("ping", undefined, { zen: "Keep it logically awesome.", hook_id: hook.id, hook: created }, owner, repo?.name);
          }
        });
      } finally { c.json = json; }
    });

    // Add authenticated manual delivery attempts. Reuse the native hook read for
    // repository or organization access checks before reading delivery records.
    for (const prefix of ["/repos/:owner/:repo", "/orgs/:org"]) {
      app.post(`${prefix}/hooks/:hook_id/deliveries/:delivery_id/attempts`, async c => {
        const hookPath = c.req.path.split("/deliveries/")[0];
        const authorized = await app.request(hookPath, { headers: { authorization: c.req.header("Authorization") ?? "" } });
        if (!authorized.ok) return authorized;
        const row = records.get(Number(c.req.param("delivery_id")));
        if (!row || row.appId != null || row.hook_id !== Number(c.req.param("hook_id"))) return c.json({ message: "Not Found" }, 404);
        const { id, created_at, updated_at, requestHeaders, responseHeaders, responseBody, ...copy } = row;
        enqueue({ ...copy, redelivery: true });
        return c.body(null, 202);
      });
    }
    for (const suffix of ["", "/:delivery_id"]) app.get(`/orgs/:org/hooks/:hook_id/deliveries${suffix}`, async c => {
      const hookPath = c.req.path.split("/deliveries")[0];
      const authorized = await app.request(hookPath, { headers: { authorization: c.req.header("Authorization") ?? "" } });
      if (!authorized.ok) return authorized;
      const rows = records.all().filter(row => row.appId == null && row.hook_id === Number(c.req.param("hook_id")));
      if (suffix) {
        const row = rows.find(item => item.id === Number(c.req.param("delivery_id")));
        return row ? c.json(publicDelivery(row, true)) : c.json({ message: "Not Found" }, 404);
      }
      return c.json(rows.reverse().map(row => publicDelivery(row)));
    });

    upstream.register(app, store, webhooks, baseUrl, ...args);
    // The pinned plugin installs a second, private App HTTP path. Replace that
    // dispatch function after registration to avoid duplicate or malformed sends.
    webhooks.dispatch = async (event, action, original, owner, repoName) => {
      const repo = repoName ? gh.repos.findOneBy("full_name", `${owner}/${repoName}`) : null;
      const org = gh.orgs.findOneBy("login", owner);
      const context = requestContext.getStore();
      let payload = structuredClone(original);
      if (payload.repository?.owner) payload.repository.owner = repositoryOwner(payload.repository.owner, baseUrl);
      if (event === "create") {
        payload.ref = payload.ref?.replace(/^refs\/(?:heads|tags)\//, "");
        payload.description = repo?.description ?? null;
        payload.pusher_type = "user";
      }
      if (event === "push" && repo) {
        if (context?.testPush) {
          const latest = pushes.all().find(row => row.repo_id === repo.id);
          if (!latest) return;
          payload = structuredClone(latest.payload);
        } else {
          payload = pushPayload(payload, gh, repo, baseUrl, context?.forced);
          const latest = pushes.all().find(row => row.repo_id === repo.id);
          if (latest) pushes.update(latest.id, { payload });
          else pushes.insert({ repo_id: repo.id, payload });
        }
      }
      if (org && !payload.organization) payload.organization = organization(org, baseUrl);
      if (event === "ping") {
        const paths = { sender: "/user", ...(repo ? { repository: `/repos/${owner}/${repoName}` } : {}) };
        for (const [key, path] of Object.entries(paths)) {
          const response = await app.request(path, { headers: context?.headers });
          if (response.ok) {
            const resource = await response.json();
            payload[key] = key === "sender" ? Object.fromEntries(Object.entries(resource).filter(([name]) =>
              ["login", "id", "node_id", "avatar_url", "gravatar_id", "url", "html_url", "followers_url", "following_url", "gists_url", "starred_url", "subscriptions_url", "organizations_url", "repos_url", "events_url", "received_events_url", "type", "site_admin", "user_view_type"].includes(name))) : resource;
          }
        }
      }
      const targetId = context?.targetHookId ?? (event === "ping" ? payload.hook_id : null);
      for (const hook of gh.webhooks.all()) {
        if (!hook.active || (targetId != null && hook.id !== targetId)) continue;
        if (hook.repo_id != null ? hook.repo_id !== repo?.id : hook.org_id !== org?.id) continue;
        if (event !== "ping" && !includes(hook.events, event)) continue;
        if (event === "check_run" && !["created", "completed"].includes(action)) continue;
        if (event === "check_suite" && action !== "completed") continue;
        enqueue({ hook_id: hook.id, event, action, payload, url: hook.config.url,
          contentType: hook.config.content_type === "form" ? "application/x-www-form-urlencoded" : "application/json",
          targetType: hook.repo_id != null ? "repository" : "organization", targetId: hook.repo_id ?? hook.org_id });
      }
      if (targetId != null || event === "ping") return;
      const account = repo ? { id: repo.owner_id, type: repo.owner_type }
        : org ? { id: org.id, type: "Organization" } : { id: gh.users.findOneBy("login", owner)?.id, type: "User" };
      for (const installation of gh.appInstallations.all()) {
        if (installation.suspended_at || installation.account_id !== account.id || installation.account_type !== account.type) continue;
        if (repo && installation.repository_selection === "selected" && !installation.repository_ids.includes(repo.id)) continue;
        const integration = gh.apps.all().find(row => row.app_id === installation.app_id);
        if (!integration?.webhook_url || !includes(integration.events, event) || !includes(installation.events, event)) continue;
        const appPayload = { ...payload, installation: { id: installation.installation_id, node_id: nodeId("Installation", installation.installation_id) } };
        enqueue({ hook_id: integration.id, appId: integration.app_id, event, action, payload: appPayload,
          url: integration.webhook_url, contentType: "application/json", targetType: "integration", targetId: integration.app_id });
      }
    };
  } };
}
