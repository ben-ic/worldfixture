import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import test from "node:test";
import { readFileSync } from "node:fs";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { createServer } from "@emulators/core";
import { githubPlugin, seedFromConfig, getGitHubStore } from "@emulators/github";
import { extendGitHubWebhooksPlugin } from "./github.mjs";

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const schemas = JSON.parse(readFileSync(new URL("./github.schemas.json", import.meta.url), "utf8"));
function openApiSchema(value) {
  if (Array.isArray(value)) return value.map(openApiSchema);
  if (!value || typeof value !== "object") return value;
  const { nullable, ...rest } = value;
  const schema = Object.fromEntries(Object.entries(rest).map(([key, item]) => [key, openApiSchema(item)]));
  return nullable ? { anyOf: [schema, { type: "null" }] } : schema;
}
ajv.addSchema(openApiSchema(schemas), "github");
function schema(name, payload) {
  const validate = ajv.getSchema(`github#/components/schemas/webhook-${name}`);
  assert.ok(validate(payload), JSON.stringify(validate.errors));
}

async function fixture(t, status = 200) {
  const received = [];
  const listener = createHttpServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    received.push({ url: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
    res.writeHead(status, { "content-type": "text/plain" }); res.end("receiver response");
  });
  listener.listen(0, "127.0.0.1"); await once(listener, "listening");
  const server = createServer(extendGitHubWebhooksPlugin(githubPlugin), {
    tokens: { current: { login: "alice", id: 1, scopes: ["repo", "admin:org", "admin:repo_hook"] } },
  });
  t.after(async () => { server.webhooks.closeGitHubWebhooks(); listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve)); });
  seedFromConfig(server.store, server.baseUrl, { users: [{ login: "alice" }], orgs: [{ login: "acme" }],
    repos: [{ owner: "alice", name: "repo" }, { owner: "acme", name: "orgrepo" }, { owner: "acme", name: "other" }] });
  const gh = getGitHubStore(server.store);
  const team = gh.teams.insert({ org_id: gh.orgs.findOneBy("login", "acme").id, name: "Admins", slug: "admins" });
  gh.teamMembers.insert({ team_id: team.id, user_id: gh.users.findOneBy("login", "alice").id, role: "maintainer" });
  async function request(path, method = "GET", body) {
    const response = await server.app.request(path, { method, headers: { authorization: "Bearer current", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const value = response.status === 204 || response.status === 202 ? null : await response.json();
    assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(value)}`);
    return { response, value };
  }
  return { ...server, gh, received, request, url: `http://127.0.0.1:${listener.address().port}` };
}

function verify(row, secret) {
  assert.equal(row.method, "POST");
  assert.match(row.headers["x-github-delivery"], /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(row.headers["x-hub-signature-256"], `sha256=${createHmac("sha256", secret).update(row.body).digest("hex")}`);
  assert.equal(row.headers["x-hub-signature"], `sha1=${createHmac("sha1", secret).update(row.body).digest("hex")}`);
  assert.match(row.headers["user-agent"], /^GitHub-Hookshot\//);
  return row.headers["content-type"].startsWith("application/json") ? JSON.parse(row.body) : JSON.parse(new URLSearchParams(row.body).get("payload"));
}

test("GitHub sends native signed JSON pings and issue events with matching delivery records", async t => {
  const { request, webhooks, received, url } = await fixture(t);
  const { value: hook } = await request("/repos/alice/repo/hooks", "POST", { events: ["issues"], config: { url: `${url}/repo`, content_type: "json", secret: "secret" } });
  await webhooks.flushGitHubWebhooks();
  assert.equal(received.length, 1);
  const ping = verify(received[0], "secret");
  schema("ping", ping);
  assert.equal(received[0].headers["x-github-event"], "ping");
  assert.equal(ping.hook_id, hook.id); assert.equal(ping.sender.login, "alice");
  assert.equal(ping.repository.full_name, "alice/repo");
  assert.equal(received[0].headers["x-github-hook-id"], String(hook.id));
  assert.equal(received[0].headers["x-github-hook-installation-target-id"], String(ping.repository.id));
  assert.equal(received[0].headers["x-github-hook-installation-target-type"], "repository");
  const { value: issue } = await request("/repos/alice/repo/issues", "POST", { title: "Zoë 東京", body: "A new issue" });
  await webhooks.flushGitHubWebhooks();
  const payload = verify(received[1], "secret");
  schema("issues-opened", payload);
  assert.equal(payload.action, "opened"); assert.deepEqual(payload.issue, issue);
  assert.equal(payload.installation, undefined);
  const list = (await request(`/repos/alice/repo/hooks/${hook.id}/deliveries`)).value;
  assert.equal(list[0].guid, received[1].headers["x-github-delivery"]);
  const detail = (await request(`/repos/alice/repo/hooks/${hook.id}/deliveries/${list[0].id}`)).value;
  assert.deepEqual(detail.request.payload, payload); assert.equal(detail.status_code, 200);
  assert.equal(detail.request.headers["X-GitHub-Delivery"], detail.guid);
  assert.equal(detail.response.payload, "receiver response");
});

test("GitHub form delivery signs the encoded bytes and targeted pings do not reach another hook", async t => {
  const { request, webhooks, received, url } = await fixture(t);
  const { value: form } = await request("/repos/alice/repo/hooks", "POST", { events: ["issues"], config: { url: `${url}/form`, content_type: "form", secret: "form-secret" } });
  await request("/repos/alice/repo/hooks", "POST", { events: ["push"], config: { url: `${url}/other`, content_type: "json" } });
  await webhooks.flushGitHubWebhooks(); received.length = 0;
  await request(`/repos/alice/repo/hooks/${form.id}/pings`, "POST");
  await webhooks.flushGitHubWebhooks(); assert.equal(received.length, 1);
  assert.equal(received[0].url, "/form"); verify(received[0], "form-secret");
  assert.match(received[0].body, /^payload=/);
  await request("/repos/alice/repo/issues", "POST", { title: "Only form" });
  await webhooks.flushGitHubWebhooks(); assert.equal(received.length, 2);
  await request(`/repos/alice/repo/hooks/${form.id}`, "PATCH", { active: false });
  await request("/repos/alice/repo/issues", "POST", { title: "No receiver" });
  await webhooks.flushGitHubWebhooks(); assert.equal(received.length, 2);
});

test("GitHub delivers repo events to org and selected App receivers without mixing installations", async t => {
  const { request, gh, webhooks, received, url } = await fixture(t);
  await request("/repos/acme/orgrepo/hooks", "POST", { events: ["issues"], config: { url: `${url}/repo`, content_type: "json", secret: "repo" } });
  await request("/orgs/acme/hooks", "POST", { events: ["issues"], config: { url: `${url}/org`, content_type: "json", secret: "org" } });
  const repo = gh.repos.findOneBy("full_name", "acme/orgrepo"), org = gh.orgs.findOneBy("login", "acme");
  for (const [appId, name, repos] of [[42, "app-a", [repo.id]], [43, "app-b", [repo.id]], [44, "unselected", []],
    [45, "suspended", [repo.id]], [46, "app-filter", [repo.id]], [47, "installation-filter", [repo.id]]]) {
    gh.apps.insert({ app_id: appId, events: appId === 46 ? ["push"] : ["issues"], webhook_url: `${url}/${name}`, webhook_secret: name });
    gh.appInstallations.insert({ installation_id: appId * 10, app_id: appId, account_id: org.id, account_type: "Organization",
      repository_selection: "selected", repository_ids: repos, events: appId === 47 ? ["push"] : ["issues"],
      suspended_at: appId === 45 ? new Date().toISOString() : null });
  }
  await webhooks.flushGitHubWebhooks(); received.length = 0;
  await request("/repos/acme/orgrepo/issues", "POST", { title: "Four receivers" });
  await webhooks.flushGitHubWebhooks();
  assert.deepEqual(received.map(row => row.url).sort(), ["/app-a", "/app-b", "/org", "/repo"]);
  for (const row of received) {
    const payload = verify(row, row.url.slice(1));
    schema("issues-opened", payload);
    assert.equal(payload.organization.login, "acme");
    assert.equal(payload.repository.owner.url.endsWith("/users/acme"), true);
    assert.equal(payload.repository.owner.followers_url.endsWith("/users/acme/followers"), true);
    if (row.url.startsWith("/app")) {
      assert.equal(payload.installation.id, row.url === "/app-a" ? 420 : 430);
      assert.equal(row.headers["x-github-hook-installation-target-type"], "integration");
    } else assert.equal(payload.installation, undefined);
  }
});

test("GitHub create and push bodies follow official schemas and push tests replay the latest local push", async t => {
  const { request, webhooks, received, url, gh } = await fixture(t);
  const { value: hook } = await request("/repos/alice/repo/hooks", "POST", { events: ["push", "create"], config: { url, secret: "push" } });
  await request("/repos/alice/repo/hooks", "POST", { events: ["issues"], config: { url: `${url}/issues` } });
  await webhooks.flushGitHubWebhooks(); received.length = 0;
  await request(`/repos/alice/repo/hooks/${hook.id}/tests`, "POST");
  await webhooks.flushGitHubWebhooks(); assert.equal(received.length, 0);
  const { value: first } = await request("/repos/alice/repo/contents/dir/file.txt", "PUT", {
    message: "Add Zoë 東京", content: Buffer.from("first").toString("base64") });
  await webhooks.flushGitHubWebhooks();
  const push = verify(received[0], "push");
  schema("push", push);
  assert.equal(push.after, first.commit.sha);
  assert.equal(push.ref, "refs/heads/main");
  assert.equal(push.pusher.name, "alice");
  assert.equal(push.head_commit.message, "Add Zoë 東京");
  assert.deepEqual(push.head_commit.added, ["dir/file.txt"]);
  assert.deepEqual(push.commits.at(-1), push.head_commit);
  await request(`/repos/alice/repo/hooks/${hook.id}/tests`, "POST");
  await webhooks.flushGitHubWebhooks();
  assert.equal(received.length, 2);
  assert.equal(received[1].body, received[0].body);
  await request("/repos/alice/repo/git/refs", "POST", { ref: "refs/heads/feature/topic", sha: first.commit.sha });
  await webhooks.flushGitHubWebhooks();
  const created = verify(received[2], "push");
  schema("create", created);
  assert.equal(created.ref, "feature/topic"); assert.equal(created.pusher_type, "user");
  const { value: next } = await request("/repos/alice/repo/contents/dir/file.txt", "PUT", {
    message: "Modify", content: Buffer.from("second").toString("base64"), sha: first.content.sha });
  await webhooks.flushGitHubWebhooks();
  const changed = verify(received[3], "push"); schema("push", changed);
  assert.deepEqual(changed.head_commit.modified, ["dir/file.txt"]);
  assert.equal(changed.before, first.commit.sha); assert.equal(changed.after, next.commit.sha);
  await request("/repos/alice/repo/git/refs/heads/feature/topic", "PATCH", { sha: next.commit.sha, force: true });
  await webhooks.flushGitHubWebhooks();
  const forced = verify(received[4], "push"); schema("push", forced);
  assert.equal(forced.forced, false); assert.equal(forced.commits.length, 1);
  assert.equal(forced.commits[0].id, next.commit.sha);
  assert.equal(gh.commits.findOneBy("sha", next.commit.sha).tree_sha, forced.head_commit.tree_id);
  await request("/repos/alice/repo/git/refs/heads/feature/topic", "PATCH", { sha: first.commit.sha, force: true });
  await webhooks.flushGitHubWebhooks();
  const rewind = verify(received[5], "push"); schema("push", rewind);
  assert.equal(rewind.forced, true); assert.equal(rewind.before, next.commit.sha);
  assert.equal(rewind.after, first.commit.sha); assert.deepEqual(rewind.commits, []);
});

test("GitHub repository and organization hooks exclude App-only check actions", async t => {
  const { request, webhooks, received, url, gh } = await fixture(t);
  const repo = gh.repos.findOneBy("full_name", "acme/orgrepo"), org = gh.orgs.findOneBy("login", "acme");
  for (const prefix of ["/repos/acme/orgrepo", "/orgs/acme"]) {
    await request(`${prefix}/hooks`, "POST", { events: ["check_suite", "check_run"], config: { url: `${url}${prefix}`, secret: "checks" } });
  }
  gh.apps.insert({ app_id: 42, events: ["check_suite", "check_run"], webhook_url: `${url}/app`, webhook_secret: "checks" });
  gh.appInstallations.insert({ installation_id: 420, app_id: 42, account_id: org.id, account_type: "Organization",
    repository_selection: "selected", repository_ids: [repo.id], events: ["check_suite", "check_run"], suspended_at: null });
  await webhooks.flushGitHubWebhooks(); received.length = 0;
  await request("/repos/acme/orgrepo/check-suites", "POST", { head_sha: "1".repeat(40) });
  await webhooks.flushGitHubWebhooks(); assert.deepEqual(received.map(row => row.url), ["/app"]);
  assert.equal(verify(received[0], "checks").action, "requested");
  received.length = 0;
  await request("/repos/acme/orgrepo/check-runs", "POST", { name: "CI", head_sha: "1".repeat(40) });
  await webhooks.flushGitHubWebhooks();
  assert.deepEqual(received.map(row => row.url).sort(), ["/app", "/orgs/acme", "/repos/acme/orgrepo"]);
});

test("GitHub records failure once and manual redelivery retains its GUID and body", async t => {
  const { request, webhooks, received, url } = await fixture(t, 503);
  const { value: hook } = await request("/repos/alice/repo/hooks", "POST", { events: ["issues"], config: { url, content_type: "json", secret: "retry" } });
  await webhooks.flushGitHubWebhooks(); assert.equal(received.length, 1);
  const record = webhooks.getDeliveries(hook.id)[0];
  assert.equal(record.success, false); assert.equal(record.status_code, 503);
  await request(`/repos/alice/repo/hooks/${hook.id}/deliveries/${record.id}/attempts`, "POST");
  await webhooks.flushGitHubWebhooks(); assert.equal(received.length, 2);
  assert.equal(received[0].body, received[1].body);
  assert.equal(received[0].headers["x-github-delivery"], received[1].headers["x-github-delivery"]);
  assert.equal(webhooks.getDeliveries(hook.id)[1].redelivery, true);
});

test("GitHub restored store hooks deliver without stale dispatcher subscriptions", async t => {
  const { request, store, webhooks, received, url } = await fixture(t);
  const { value: hook } = await request("/repos/alice/repo/hooks", "POST", { events: ["issues"], config: { url, secret: "restore" } });
  await webhooks.flushGitHubWebhooks(); received.length = 0;
  const snapshot = store.snapshot();
  await request(`/repos/alice/repo/hooks/${hook.id}`, "DELETE"); store.restore(snapshot);
  await request("/repos/alice/repo/issues", "POST", { title: "After restore" });
  await webhooks.flushGitHubWebhooks(); assert.equal(received.length, 1); verify(received[0], "restore");
});
